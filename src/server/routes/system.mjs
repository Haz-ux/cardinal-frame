import express from 'express';
import { existsSync, watch } from 'fs';
import { execSync } from 'child_process';

/**
 * System routes: health checks, device state, file watchers.
 * Dependencies: db, stmts, wss, logger, authMiddleware, requireRole, apiLimiter, audit, randomUUID,
 *   deviceStateCache (getter), activeWatchers (Map)
 */
export default function systemRoutes(ctx) {
  const { db, stmts, wss, logger, authMiddleware, requireRole, apiLimiter, audit, randomUUID } = ctx;
  const router = express.Router();

  // ─── Health ───────────────────────────────────────────────────
  router.get('/health', (_req, res) => {
    const dbStats = db.pragma('journal_mode')[0];
    const tableCount = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get().c;
    const dbSize = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get().size;

    res.json({
      status: 'ok',
      mode: 'AI-Powered',
      db: {
        type: 'SQLite',
        journal_mode: dbStats,
        tables: tableCount,
        size_mb: Math.round((dbSize / 1024 / 1024) * 100) / 100,
      },
      ws: {
        connected_clients: wss.clients.size,
      },
      uptime: Math.round(process.uptime()),
      memory: {
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Detailed Health (memory monitoring) ──────────────────────
  router.get('/health/detailed', authMiddleware, requireRole('admin'), (_req, res) => {
    const mem = process.memoryUsage();
    const dbSize = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get().size;
    res.json({
      status: 'ok',
      uptime_seconds: Math.round(process.uptime()),
      process: {
        pid: process.pid,
        platform: process.platform,
        node_version: process.version,
      },
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
        external_mb: Math.round(mem.external / 1024 / 1024 * 100) / 100,
        array_buffers_mb: Math.round(mem.arrayBuffers / 1024 / 1024 * 100) / 100,
        heap_limit_mb: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
        heap_usage_pct: Math.round((mem.heapUsed / mem.heapTotal) * 100 * 100) / 100,
      },
      db: {
        type: 'SQLite',
        journal_mode: db.pragma('journal_mode')[0],
        tables: db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get().c,
        size_mb: Math.round((dbSize / 1024 / 1024) * 100) / 100,
        read_count: db.prepare("PRAGMA stats").get()?.read || 0,
        write_count: db.prepare("PRAGMA stats").get()?.write || 0,
      },
      ws: {
        connected_clients: wss.clients.size,
      },
      event_loop: {
        max_heap_mb: Math.round(require('v8').getHeapStatistics().total_physical_size / 1024 / 1024 * 100) / 100,
        used_heap_mb: Math.round(require('v8').getHeapStatistics().used_heap_size / 1024 / 1024 * 100) / 100,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // ─── Device State ────────────────────────────────────────────
  router.get('/device-state', (_req, res) => {
    res.json(ctx.deviceStateCache);
  });

  // ─── File Watchers ────────────────────────────────────────────
  const activeWatchers = new Map();
  function startFileWatcher(watcher) {
    if (activeWatchers.has(watcher.id)) return;
    try {
      if (!existsSync(watcher.path)) return;
      const w = watch(watcher.path, { recursive: !!watcher.recursive }, (eventType, filename) => {
        const event = { type: 'file_event', path: watcher.path, filename, eventType, watcher_id: watcher.id, ts: Date.now() };
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify(event)); });
        stmts.fileWatchers.updateEnabled.run(watcher.enabled, new Date().toISOString(), watcher.id);
        audit('file_event', 'watcher', watcher.id, null, { path: watcher.path, filename, eventType });
      });
      activeWatchers.set(watcher.id, w);
    } catch (e) { logger.error(`Watcher ${watcher.id} failed:`, e.message); }
  }
  setTimeout(() => { try { stmts.fileWatchers.getAll.all().filter(w => w.enabled).forEach(startFileWatcher); } catch {} }, 2000);

  router.get('/watchers', authMiddleware, (_req, res) => {
    try { res.json(stmts.fileWatchers.getAll.all()); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/watchers', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { path: watchPath, recursive = false, trigger_skill = null, enabled = true } = req.body;
      if (!watchPath) return res.status(400).json({ error: 'path required' });
      const fs = await import('fs');
      if (!fs.existsSync(watchPath)) return res.status(400).json({ error: 'Path does not exist' });
      const id = randomUUID();
      stmts.fileWatchers.insert.run(id, watchPath, recursive ? 1 : 0, trigger_skill, enabled ? 1 : 0);
      const w = { id, path: watchPath, recursive: !!recursive, trigger_skill, enabled: !!enabled };
      if (enabled) startFileWatcher(w);
      res.status(201).json(w);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/watchers/:id', authMiddleware, requireRole('admin'), (req, res) => {
    try {
      const i = activeWatchers.get(req.params.id);
      if (i) { i.close(); activeWatchers.delete(req.params.id); }
      stmts.fileWatchers.delete.run(req.params.id);
      res.json({ deleted: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
