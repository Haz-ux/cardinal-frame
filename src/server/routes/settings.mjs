import express from 'express';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

/**
 * Settings routes: env vars (CRUD + test), dev settings (CRUD + restart).
 * Dependencies: db, wss, server, logger, fireHook, authMiddleware, requireRole, apiLimiter, broadcast, PORT
 * Exports: encryptSecret, decryptSecret, decryptValue, xorCipher, xorDecipher, getDevSetting, getDevSettings
 */

// ─── AES-256-GCM encryption for stored secrets ─────────────────────────
// Key derivation: SHA-256 of ENCRYPT_SECRET env var → 32-byte key.
// If ENCRYPT_SECRET is unset, generate a random key (secrets won't survive restart).
const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET || null;
const KEY_HEX = ENCRYPT_SECRET
  ? createHash('sha256').update(ENCRYPT_SECRET).digest('hex')
  : randomBytes(32).toString('hex');

export function encryptSecret(plaintext) {
  const key = Buffer.from(KEY_HEX, 'hex');
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map(b => b.toString('base64')).join(':');
}

export function decryptSecret(packed) {
  try {
    const [ivB64, tagB64, encB64] = packed.split(':');
    if (!ivB64 || !tagB64 || !encB64) return packed;
    const key = Buffer.from(KEY_HEX, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch { return packed; }
}

// ─── Legacy XOR (backward compat with existing DB rows) ───────────────
export function xorCipher(text) {
  const buf = Buffer.from(text, 'utf8');
  const key = Buffer.from(ENCRYPT_SECRET || 'cf-default-secret-v1', 'utf8');
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
  return buf.toString('base64');
}

export function xorDecipher(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const key = Buffer.from(ENCRYPT_SECRET || 'cf-default-secret-v1', 'utf8');
    for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
    return buf.toString('utf8');
  } catch { return b64; }
}

// ─── Smart decrypt — AES-GCM first, XOR fallback ──────────────────────
export function decryptValue(val, isEncrypted) {
  if (!isEncrypted) return val;
  if (val.includes(':')) return decryptSecret(val);
  return xorDecipher(val);
}

// ─── Decrypt a provider row's api_key in place (if it is encrypted) ──
// Idempotent: after decrypting, flips `encrypted` to 0 so a second pass is
// a no-op. Providers written by the API are encrypted at rest (encrypted=1);
// legacy plaintext rows (encrypted=0) pass through untouched.
export function decryptProvider(provider) {
  if (!provider || provider.encrypted !== 1 || !provider.api_key) return provider;
  const dec = decryptValue(provider.api_key, 1);
  if (dec && dec !== provider.api_key) provider.api_key = dec;
  provider.encrypted = 0;
  return provider;
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
        value: r.encrypted ? decryptValue(r.value, r.encrypted) : r.value,
        encrypted: Boolean(r.encrypted),
      }));
      res.json(masked);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  router.post('/settings/env', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const { key, value, encrypted = 0, category = 'general' } = req.body;
      if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
      const storedVal = encrypted ? encryptSecret(String(value)) : String(value);
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
      const val = row.encrypted ? decryptValue(row.value, row.encrypted) : row.value;
      if (!val) return res.json({ success: false, message: 'No value set' });

      // Map env key → provider test config
      const PROVIDER_TEST = {
        OPENAI_API_KEY:     { url: 'https://api.openai.com/v1/models',            headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        ANTHROPIC_API_KEY:  { url: 'https://api.anthropic.com/v1/models',          headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
        GOOGLE_API_KEY:     { url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: (k) => ({}) , qs: (url, k) => `${url}?key=${encodeURIComponent(k)}` },
        NVIDIA_API_KEY:     { url: 'https://integrate.api.nvidia.com/v1/models',   headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        OPENROUTER_API_KEY: { url: 'https://openrouter.ai/api/v1/models',         headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        GROQ_API_KEY:       { url: 'https://api.groq.com/openai/v1/models',       headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        TOGETHER_API_KEY:   { url: 'https://api.together.xyz/v1/models',          headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        DEEPSEEK_API_KEY:   { url: 'https://api.deepseek.com/v1/models',          headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        MISTRAL_API_KEY:    { url: 'https://api.mistral.ai/v1/models',            headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        XAI_API_KEY:        { url: 'https://api.x.ai/v1/models',                  headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        PERPLEXITY_API_KEY: { url: 'https://api.perplexity.ai/models',            headers: (k) => ({ Authorization: `Bearer ${k}` }) },
        COHERE_API_KEY:     { url: 'https://api.cohere.ai/v1/models',             headers: (k) => ({ Authorization: `Bearer ${k}` }) },
      };

      const testConfig = PROVIDER_TEST[key.toUpperCase()];
      if (testConfig) {
        try {
          const testUrl = testConfig.qs ? testConfig.qs(testConfig.url, val) : testConfig.url;
          const r = await fetch(testUrl, { headers: { 'Content-Type': 'application/json', ...testConfig.headers(val) }, signal: AbortSignal.timeout(10000) });
          const label = key.replace('_API_KEY', '').replace('_', ' ');
          if (r.ok) return res.json({ success: true, message: `${label} API key valid` });
          if (r.status === 401) return res.json({ success: false, message: `${label} API key rejected (401)` });
          return res.json({ success: false, message: `${label} API returned ${r.status}` });
        } catch (e) { return res.json({ success: false, message: e.message }); }
      }

      // Non-LLM keys: basic validation
      if (val.length > 5) return res.json({ success: true, message: 'Value looks valid (non-trivial length)' });
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
        return res.status(400).json({ error: 'Server port is fixed to 8080 — set PORT env var instead' });
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

      res.json({ success: true, updated });
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
