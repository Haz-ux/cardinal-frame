import express from 'express';

/**
 * User management routes: user list, role changes, profile, context explorer.
 * Dependencies: db, stmts, authMiddleware, requireRole, apiLimiter, broadcast
 */
export default function usersRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter } = ctx;
  const router = express.Router();

  // ─── User Management (admin only) ──────────────────────────────
  router.get('/users', authMiddleware, requireRole('admin'), apiLimiter, (_req, res) => {
    res.json(stmts.users.getAll.all());
  });

  router.patch('/users/:id/role', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { role } = req.body;
    if (!['admin', 'user', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role. Use: admin, user, viewer' });
    stmts.users.updateRole.run(role, req.params.id);
    res.json({ id: req.params.id, role });
  });

  // ─── User Profile (compiled preferences) ─────────────────────
  router.get('/profile', authMiddleware, (req, res) => {
    try {
      const user = stmts.users.getByUsername.get(req.user.username);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const prefs = [];
      try { const meta = JSON.parse(user.metadata || '{}'); for (const [k,v] of Object.entries(meta)) { prefs.push({ key: k, value: v, locked: false }); } } catch {}
      prefs.unshift({ key: 'role', value: user.role, locked: true });
      prefs.unshift({ key: 'username', value: user.username, locked: true });
      res.json({ username: user.username, role: user.role, preferences: prefs, created: user.created_at });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/profile/:key', authMiddleware, (req, res) => {
    try {
      const user = stmts.users.getByUsername.get(req.user.username);
      const meta = JSON.parse(user.metadata || '{}');
      const { value, action } = req.body;
      if (action === 'dismiss') { delete meta[req.params.key]; }
      else { meta[req.params.key] = value; }
      db.prepare('UPDATE users SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), user.id);
      res.json({ key: req.params.key, value: action === 'dismiss' ? null : value });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
