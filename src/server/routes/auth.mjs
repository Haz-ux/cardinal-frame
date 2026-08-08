import express from 'express';
import { randomUUID, randomBytes, createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { validateBody, schemas } from '../validate.mjs';

/**
 * Auth routes: register, login, me, password reset, token refresh, logout
 * Dependencies: db, stmts, JWT_SECRET, JWT_EXPIRES, JWT_REFRESH_EXPIRES, logger, audit, authMiddleware, authLimiter
 */
export default function authRoutes(ctx) {
  const { stmts, JWT_SECRET, JWT_EXPIRES, JWT_REFRESH_EXPIRES, logger, audit, authMiddleware, authLimiter } = ctx;
  const router = express.Router();

  // Cache-control headers for all auth routes
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  const resetTokens = new Map();

  // ─── Refresh token helpers ─────────────────────────────────────────
  // Refresh tokens are opaque random strings. Only their SHA-256 hash is
  // persisted, so a DB leak does not expose usable tokens.
  function hashRefreshToken(token) {
    return createHash('sha256').update(token).digest('hex');
  }

  function msFromExpires(exp) {
    const match = String(exp).trim().match(/^(\d+)\s*(ms|s|m|h|d|w)?$/i);
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const n = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase();
    const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit] || 1000;
    return n * mult;
  }

  function issueRefreshToken(userId) {
    const token = randomBytes(64).toString('hex');
    const tokenHash = hashRefreshToken(token);
    const expiresAt = new Date(Date.now() + msFromExpires(JWT_REFRESH_EXPIRES)).toISOString();
    stmts.refreshTokens.insert.run(randomUUID(), userId, tokenHash, expiresAt);
    return token;
  }

  function issueTokens(user) {
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
    const refreshToken = issueRefreshToken(user.id);
    return {
      token,
      refreshToken,
      user: { id: user.id, username: user.username, role: user.role },
    };
  }

  router.post('/register', authLimiter, validateBody(schemas.register), async (req, res) => {
    const { username, password } = req.body;

    const existing = stmts.users.getByUsername.get(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const id = randomUUID();
    const hash = bcrypt.hashSync(password, 10);
    stmts.users.insert.run(id, username, hash, 'user');

    logger.info(`User registered: ${username}`);
    audit('register', 'user', id, id, { username });
    res.status(201).json(issueTokens({ id, username, role: 'user' }));
  });

  router.post('/login', authLimiter, validateBody(schemas.login), (req, res) => {
    const { username, password } = req.body;

    const user = stmts.users.getByUsername.get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    logger.info(`User logged in: ${username}`);
    res.json(issueTokens(user));
  });

  router.get('/me', authMiddleware, (req, res) => {
    const user = stmts.users.getById.get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });

  // Rotate a refresh token and return a fresh access + refresh pair.
  router.post('/refresh', authLimiter, validateBody(schemas.refresh), (req, res) => {
    try {
      const { refreshToken } = req.body;
      const row = stmts.refreshTokens.getByHash.get(hashRefreshToken(refreshToken));
      if (!row) return res.status(401).json({ error: 'Invalid refresh token' });
      if (row.revoked_at) return res.status(401).json({ error: 'Refresh token has been revoked' });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(401).json({ error: 'Refresh token expired' });
      }

      const user = stmts.users.getById.get(row.user_id);
      if (!user) return res.status(401).json({ error: 'User no longer exists' });

      // Rotation: revoke the used token and issue a new pair.
      stmts.refreshTokens.revoke.run(row.id);
      stmts.refreshTokens.deleteExpired.run();
      const issued = issueTokens(user);
      logger.info(`Token refreshed for: ${user.username}`);
      audit('token_refresh', 'user', user.id, user.id, {});
      res.json(issued);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Revoke a refresh token (server-side logout).
  router.post('/logout', authLimiter, validateBody(schemas.logout), (req, res) => {
    try {
      const { refreshToken } = req.body;
      const row = stmts.refreshTokens.getByHash.get(hashRefreshToken(refreshToken));
      if (row && !row.revoked_at) {
        stmts.refreshTokens.revoke.run(row.id);
        logger.info(`User logged out: ${row.user_id}`);
        audit('logout', 'user', row.user_id, row.user_id, {});
      }
      stmts.refreshTokens.deleteExpired.run();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/reset-request', authLimiter, (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const user = stmts.users.getByUsername.get(username);
    if (!user) return res.status(200).json({ message: 'If the account exists, a reset token has been printed to the server terminal.' });

    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const expires = Date.now() + 10 * 60 * 1000;
    resetTokens.set(token, { userId: user.id, username: user.username, expires });

    console.log('\n' + '='.repeat(60));
    console.log(`  PASSWORD RESET REQUEST`);
    console.log(`  User: ${user.username}`);
    console.log(`  Token: ${token}`);
    console.log(`  Expires: 10 minutes`);
    console.log('='.repeat(60) + '\n');

    logger.info(`Password reset token generated for: ${username}`);
    res.json({ message: 'Reset token printed to server terminal. Check the server logs.' });
  });

  router.post('/reset-confirm', authLimiter, validateBody(schemas.resetConfirm), (req, res) => {
    const { token, password } = req.body;

    const entry = resetTokens.get(token);
    if (!entry) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (Date.now() > entry.expires) {
      resetTokens.delete(token);
      return res.status(400).json({ error: 'Reset token expired. Request a new one.' });
    }

    const hash = bcrypt.hashSync(password, 10);
    stmts.users.updatePassword.run(hash, entry.userId);
    resetTokens.delete(token);

    const role = stmts.users.getById.get(entry.userId).role;
    logger.info(`Password reset completed for: ${entry.username}`);
    audit('password_reset', 'user', entry.userId, entry.userId, { username: entry.username });

    res.json(issueTokens({ id: entry.userId, username: entry.username, role }));
  });

  return router;
}
