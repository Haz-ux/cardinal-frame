import express from 'express';

/**
 * Settings routes: env vars (CRUD + test), dev settings (CRUD + restart).
 * Dependencies: db, wss, server, logger, fireHook, authMiddleware, requireRole, apiLimiter, broadcast, PORT
 * Exports: xorCipher, xorDecipher, getDevSetting, getDevSettings
 */
const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET || 'cf-default-secret-v1';

export function xorCipher(text) {
  const buf = Buffer.from(text, 'utf8');
  const key = Buffer.from(ENCRYPT_SECRET, 'utf8');
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
  return buf.toString('base64');
}

export function xorDecipher(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const key = Buffer.from(ENCRYPT_SECRET, 'utf8');
    for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
    return buf.toString('utf8');
  } catch { return b64; }
}

export function getDevSetting(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM dev_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch { return fallback; }
}

export function getDevSettings(db) {
  const defaults = {
    port: String(process.env.PORT || '8080'),
    logLevel: process.env.LOG_LEVEL || 'info',
    debugMode: 'false',
    sandboxTimeout: '30',
    maxConcurrentAgents: '5',
    wsHeartbeatMs: '30000',
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
  };
  try {
    const rows = db.prepare('SELECT key, value FROM dev_settings').all();
    for (const r of rows) defaults[r.key] = r.value;
  } catch {}
  return defaults;
}

export default function settingsRoutes(ctx) {
  const { db, wss, server, logger, fireHook, authMiddleware, requireRole, apiLimiter, PORT } = ctx;
  const router = express.Router();

  // ─── Env Vars ─────────────────────────────────────────────────
  router.get('/settings/env', authMiddleware, requireRole('admin'), (_req, res) => {
    try {
      const rows = db.prepare('SELECT key, value, encrypted, category, created_at, updated_at FROM env_vars ORDER BY category, key').all();
      const masked = rows.map(r => ({
        ...r,
        value: r.encrypted ? xorDecipher(r.value) : r.value,
        encrypted: Boolean(r.encrypted),
      }));
      res.json(masked);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/settings/env', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const { key, value, encrypted = 0, category = 'general' } = req.body;
      if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
      const storedVal = encrypted ? xorCipher(String(value)) : String(value);
      db.prepare(`INSERT INTO env_vars (key, value, encrypted, category, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=excluded.encrypted, category=excluded.category, updated_at=datetime('now')`)
        .run(key, storedVal, encrypted ? 1 : 0, category);
      process.env[key] = String(value);
      res.json({ success: true, key });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/settings/env/:key', authMiddleware, requireRole('admin'), (req, res) => {
    try {
      const { key } = req.params;
      const info = db.prepare('DELETE FROM env_vars WHERE key = ?').run(key);
      if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
      delete process.env[key];
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/settings/env/:key/test', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { key } = req.params;
      const row = db.prepare('SELECT value, encrypted, category FROM env_vars WHERE key = ?').get(key);
      if (!row) return res.status(404).json({ success: false, message: 'Variable not found' });
      const val = row.encrypted ? xorDecipher(row.value) : row.value;
      if (key.toLowerCase().includes('openai') || row.category === 'llm') {
        try {
          const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${val}` }, signal: AbortSignal.timeout(8000) });
          if (r.ok) return res.json({ success: true, message: 'OpenAI API key valid' });
          return res.json({ success: false, message: `API returned ${r.status}` });
        } catch (e) { return res.json({ success: false, message: e.message }); }
      }
      if (val && val.length > 5) return res.json({ success: true, message: 'Value looks valid (non-trivial length)' });
      return res.json({ success: false, message: 'Value too short to be a valid key' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ─── Dev Settings ─────────────────────────────────────────────
  router.get('/settings/dev', authMiddleware, requireRole('admin'), (_req, res) => {
    try {
      const rows = db.prepare('SELECT key, value, updated_at FROM dev_settings ORDER BY key').all();
      const settings = {};
      for (const r of rows) settings[r.key] = r.value;
      const result = {
        port: settings.port || String(process.env.PORT || '8080'),
        logLevel: settings.logLevel || process.env.LOG_LEVEL || 'info',
        debugMode: settings.debugMode === 'true',
        sandboxTimeout: settings.sandboxTimeout || '30',
        maxConcurrentAgents: settings.maxConcurrentAgents || '5',
        wsHeartbeatMs: settings.wsHeartbeatMs || '30000',
        embeddingModel: settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2',
        ...settings,
      };
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.put('/settings/dev', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Object required' });

      if (updates.port !== undefined) {
        const port = parseInt(updates.port, 10);
        if (isNaN(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Port must be 1-65535' });
        updates.port = String(port);
      }
      if (updates.logLevel && !['error', 'warn', 'info', 'debug'].includes(updates.logLevel)) {
        return res.status(400).json({ error: 'Log level must be: error, warn, info, or debug' });
      }
      if (updates.sandboxTimeout !== undefined) {
        const t = parseInt(updates.sandboxTimeout, 10);
        if (isNaN(t) || t < 1 || t > 300) return res.status(400).json({ error: 'Sandbox timeout must be 1-300s' });
        updates.sandboxTimeout = String(t);
      }
      if (updates.maxConcurrentAgents !== undefined) {
        const n = parseInt(updates.maxConcurrentAgents, 10);
        if (isNaN(n) || n < 1 || n > 100) return res.status(400).json({ error: 'Max concurrent agents must be 1-100' });
        updates.maxConcurrentAgents = String(n);
      }

      const upsert = db.prepare(`INSERT INTO dev_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`);

      const updated = [];
      for (const [key, value] of Object.entries(updates)) {
        upsert.run(key, String(value));
        updated.push(key);
      }

      if (updates.debugMode !== undefined) {
        process.env.LOG_LEVEL = updates.debugMode === 'true' ? 'debug' : (updates.logLevel || process.env.LOG_LEVEL || 'info');
      }
      if (updates.logLevel) process.env.LOG_LEVEL = updates.logLevel;
      if (updates.embeddingModel) process.env.CF_EMBEDDING_MODEL = updates.embeddingModel;

      res.json({ success: true, updated, note: updates.port ? 'Restart server to apply new port' : undefined });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/settings/dev/restart', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    res.json({ success: true, message: 'Server restarting...' });
    setTimeout(() => {
      logger.info('Restart requested via dev settings — initiating graceful shutdown...');
      fireHook('onServerStop', { signal: 'restart', port: PORT });
      wss.clients.forEach(c => c.close(1001, 'Server restarting'));
      server.close(() => {
        try { db.close(); } catch {}
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 3000);
    }, 500);
  });

  return router;
}
