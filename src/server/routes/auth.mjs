import express from 'express';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { validateBody, schemas } from '../validate.mjs';

/**
 * Auth routes: register, login, me, password reset
 * Dependencies: db, stmts, JWT_SECRET, JWT_EXPIRES, logger, audit, authMiddleware, authLimiter
 */
export default function authRoutes(ctx) {
  const { stmts, JWT_SECRET, JWT_EXPIRES, logger, audit, authMiddleware, authLimiter } = ctx;
  const router = express.Router();

  // Cache-control headers for all auth routes
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  const resetTokens = new Map();

  router.post('/register', authLimiter, validateBody(schemas.register), async (req, res) => {
    const { username, password } = req.body;

    const existing = stmts.users.getByUsername.get(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const id = randomUUID();
    const hash = bcrypt.hashSync(password, 10);
    stmts.users.insert.run(id, username, hash, 'user');

    const token = jwt.sign({ id, username, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    logger.info(`User registered: ${username}`);
    audit('register', 'user', id, id, { username });
    res.status(201).json({ token, user: { id, username, role: 'user' } });
  });

  router.post('/login', authLimiter, validateBody(schemas.login), (req, res) => {
    const { username, password } = req.body;

    const user = stmts.users.getByUsername.get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    logger.info(`User logged in: ${username}`);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });

  router.get('/me', authMiddleware, (req, res) => {
    const user = stmts.users.getById.get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
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
    const jwtToken = jwt.sign({ id: entry.userId, username: entry.username, role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    logger.info(`Password reset completed for: ${entry.username}`);
    audit('password_reset', 'user', entry.userId, entry.userId, { username: entry.username });

    res.json({ token: jwtToken, user: { id: entry.userId, username: entry.username, role } });
  });

  return router;
}
