/**
 * Cardinal Frame — Observability & Request Tracing
 *
 * Lightweight request tracing: per-request timing, structured logging,
 * SQLite-persisted traces. No external deps (no OTel/Jaeger) — keeps
 * runtime lean on edge hardware while providing trace IDs, span
 * durations, and error capture.
 *
 * Dependencies: db, logger
 */

import express from 'express';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS request_traces (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER,
    duration_ms INTEGER,
    user_id TEXT,
    error TEXT,
    ts TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_traces_ts ON request_traces(ts);
  CREATE INDEX IF NOT EXISTS idx_traces_path ON request_traces(path);
`;

export function initTracing(db) {
  db.exec(SCHEMA);
  return {
    insert: db.prepare(
      'INSERT INTO request_traces (id, method, path, status, duration_ms, user_id, error) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    getByPath: db.prepare(
      `SELECT path, COUNT(*) as count, ROUND(AVG(duration_ms),1) as avg_ms, MAX(duration_ms) as max_ms
       FROM request_traces WHERE ts > datetime('now', ?) GROUP BY path ORDER BY count DESC LIMIT 50`
    ),
    getSlowest: db.prepare(
      'SELECT * FROM request_traces WHERE duration_ms > ? ORDER BY duration_ms DESC LIMIT 50'
    ),
    getErrors: db.prepare(
      'SELECT * FROM request_traces WHERE status >= 400 ORDER BY ts DESC LIMIT 50'
    ),
    getSummary: db.prepare(
      `SELECT COUNT(*) as total, ROUND(AVG(duration_ms),1) as avg_ms, MAX(duration_ms) as max_ms,
       SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors
       FROM request_traces WHERE ts > datetime('now', ?)`
    ),
    cleanup: db.prepare(
      `DELETE FROM request_traces WHERE ts < datetime('now', '-7 days')`
    ),
  };
}

/**
 * Express middleware: attach hr timer, log on finish, persist to SQLite.
 * Skips SSE and WebSocket to avoid noise.
 */
export function traceMiddleware(stmts, logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const ct = res.getHeader?.('Content-Type');
      if (req.headers.upgrade === 'websocket' || (typeof ct === 'string' && ct.includes('text/event-stream'))) return;

      const traceId = req.id || 'unknown';
      const path = (req.route?.path || req.path || req.url || '').slice(0, 255);
      const status = res.statusCode;
      const userId = req.user?.id || null;

      logger.info('request', { traceId, method: req.method, path, status, durationMs, userId });

      try {
        stmts.traces.insert.run(traceId, req.method, path, status, durationMs, userId, status >= 400 ? `HTTP ${status}` : null);
      } catch { /* non-critical */ }
    });

    next();
  };
}

/**
 * REST endpoints for querying traces.
 */
export default function tracesRoutes(ctx) {
  const { stmts, authMiddleware, requireRole } = ctx;
  const router = express.Router();

  // All trace endpoints require admin — scoped to /traces path
  // (router.use(authMiddleware) without a path would run for ALL requests
  //  reaching this router, causing 401 on unmatched paths before the 404 catch-all)
  router.use('/traces', authMiddleware, requireRole('admin'));

  // GET /api/traces/summary?period=-24 hours
  router.get('/traces/summary', (req, res) => {
    const period = req.query.period || '-24 hours';
    res.json(stmts.traces.getSummary.all(period));
  });

  // GET /api/traces/slowest?threshold=500
  router.get('/traces/slowest', (req, res) => {
    const threshold = parseInt(req.query.threshold) || 500;
    res.json(stmts.traces.getSlowest.all(threshold));
  });

  // GET /api/traces/errors
  router.get('/traces/errors', (_req, res) => {
    res.json(stmts.traces.getErrors.all());
  });

  // GET /api/traces/paths?period=-24 hours — aggregate by endpoint
  router.get('/traces/paths', (req, res) => {
    const period = req.query.period || '-24 hours';
    res.json(stmts.traces.getByPath.all(period));
  });

  return router;
}
