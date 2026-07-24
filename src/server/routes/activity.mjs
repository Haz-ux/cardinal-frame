import express from 'express';
import { randomUUID } from 'crypto';

/**
 * Activity Feed — recent system events for live overlay
 *
 * Maintains an in-memory ring buffer of recent broadcast events
 * plus a DB-backed persistent log for historical queries.
 *
 * Dependencies: db, optionalAuth, apiLimiter
 *
 * Endpoints:
 *   GET /api/activity      — recent events (query: limit, type, since)
 *   GET /api/activity/stats — event counts by type
 */
export default function activityRoutes(ctx) {
  const { db, optionalAuth, apiLimiter } = ctx;
  const router = express.Router();

  // ─── Schema ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT,
      ts TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(type);
  `);

  const stmts = {
    insert: db.prepare('INSERT INTO activity_log (id, type, payload) VALUES (?, ?, ?)'),
    getRecent: db.prepare('SELECT * FROM activity_log ORDER BY ts DESC LIMIT ?'),
    getByType: db.prepare('SELECT * FROM activity_log WHERE type = ? ORDER BY ts DESC LIMIT ?'),
    getSince: db.prepare('SELECT * FROM activity_log WHERE ts > ? ORDER BY ts DESC LIMIT ?'),
    getStats: db.prepare(`
      SELECT type, COUNT(*) as count
      FROM activity_log
      WHERE ts > datetime('now', '-1 hour')
      GROUP BY type ORDER BY count DESC
    `),
    cleanup: db.prepare("DELETE FROM activity_log WHERE ts < datetime('now', '-24 hours')"),
  };

  // ─── In-memory ring buffer for fast polling ────────────────────────
  const RING_SIZE = 200;
  const ring = [];
  let ringSeq = 0;

  // ─── Event capture hook ────────────────────────────────────────────
  // Called by the broadcast function to log events
  function logActivity(type, payload) {
    const id = randomUUID();
    const payloadStr = JSON.stringify(payload || {});

    // In-memory ring (non-blocking)
    ring.push({ id, type, payload: payload || {}, seq: ++ringSeq, ts: new Date().toISOString() });
    if (ring.length > RING_SIZE) ring.shift();

    // DB log (best-effort, non-blocking)
    try {
      stmts.insert.run(id, type, payloadStr);
    } catch { /* ignore DB errors in activity logging */ }
  }

  // Expose the hook so server.mjs can wire it into broadcast()
  ctx.logActivity = logActivity;

  // Periodic cleanup (every 5 min)
  setInterval(() => {
    try { stmts.cleanup.run(); } catch {}
  }, 5 * 60 * 1000).unref();

  // ─── Routes ────────────────────────────────────────────────────────

  router.get('/activity', optionalAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const type = req.query.type;
    const since = req.query.since;

    // Use in-memory ring for fast path (no type filter, no since filter)
    if (!type && !since) {
      return res.json(ring.slice(-limit).reverse());
    }

    let rows;
    if (type && since) {
      rows = stmts.getSince.all(since, limit).filter(r => r.type === type);
    } else if (type) {
      rows = stmts.getByType.all(type, limit);
    } else {
      rows = stmts.getSince.all(since, limit);
    }

    res.json(rows.map(r => ({
      ...r,
      payload: JSON.parse(r.payload || '{}'),
    })));
  });

  router.get('/activity/stats', optionalAuth, (_req, res) => {
    res.json(stmts.getStats.all());
  });

  return router;
}
