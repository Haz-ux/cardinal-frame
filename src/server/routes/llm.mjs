import express from 'express';
import { randomUUID } from 'crypto';
import { PROVIDER_TYPES, buildProviderAuth, detectOllama } from './llm-helpers.mjs';

/**
 * LLM routes: provider CRUD, model CRUD, Ollama detection, seed defaults.
 * Dependencies: db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter, audit, logger, PORT
 * Exports: initOllama(db, stmts, logger) — call on boot for auto-detection
 */
let ollamaCache = { connected: false, lastCheck: 0 };

export function initOllama(db, stmts, logger) {
  detectOllama().then(status => {
    ollamaCache = { ...status, lastCheck: Date.now() };
    if (status.connected) {
      logger.info(`🦙 Ollama detected — v${status.version}, ${status.modelCount} models`);
      const existing = db.prepare("SELECT id FROM llm_providers WHERE type = 'ollama'").get();
      if (!existing) {
        const id = randomUUID();
        db.prepare('INSERT INTO llm_providers (id, name, type, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, 'Ollama (Local)', 'ollama', '', 'http://localhost:11434', 1);
        logger.info('🦙 Auto-registered Ollama as provider');
      }
      if (status.models?.length) {
        const provider = db.prepare("SELECT id FROM llm_providers WHERE type = 'ollama'").get();
        if (provider) {
          for (const modelName of status.models) {
            const existingModel = db.prepare('SELECT id FROM llm_models WHERE provider_id = ? AND model_id = ?').get(provider.id, modelName);
            if (!existingModel) {
              const mid = randomUUID();
              db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name, enabled) VALUES (?, ?, ?, ?, ?)')
                .run(mid, provider.id, modelName, modelName.replace(':latest', ''), 1);
            }
          }
          logger.info(`🦙 Auto-detected ${status.models.length} Ollama models`);
        }
      }
    } else {
      logger.info('🦙 Ollama not detected on localhost:11434');
    }
  });
}

export default function llmRoutes(ctx) {
  const { db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter, audit, logger, PORT } = ctx;
  const router = express.Router();

  // ─── Ollama Status & Detection ─────────────────────────────
  router.get('/ollama/status', optionalAuth, async (_req, res) => {
    if (Date.now() - ollamaCache.lastCheck > 30000) {
      const status = await detectOllama();
      ollamaCache = { ...status, lastCheck: Date.now() };
    }
    res.json(ollamaCache);
  });

  router.post('/ollama/detect', authMiddleware, requireRole('admin'), apiLimiter, async (_req, res) => {
    const status = await detectOllama();
    ollamaCache = { ...status, lastCheck: Date.now() };

    if (status.connected) {
      let provider = db.prepare("SELECT id FROM llm_providers WHERE type = 'ollama'").get();
      if (!provider) {
        const id = randomUUID();
        db.prepare('INSERT INTO llm_providers (id, name, type, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, 'Ollama (Local)', 'ollama', '', 'http://localhost:11434', 1);
        provider = { id };
      }
      let added = 0;
      for (const modelName of (status.models || [])) {
        const existingModel = db.prepare('SELECT id FROM llm_models WHERE provider_id = ? AND model_id = ?').get(provider.id, modelName);
        if (!existingModel) {
          const mid = randomUUID();
          db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name, enabled) VALUES (?, ?, ?, ?, ?)')
            .run(mid, provider.id, modelName, modelName.replace(':latest', ''), 1);
          added++;
        }
      }
      res.json({ success: true, message: `Ollama v${status.version} — ${status.modelCount} models (${added} new)`, ...status });
    } else {
      res.json({ success: false, message: 'Ollama not running on localhost:11434', connected: false });
    }
  });

  // ─── Provider CRUD ───────────────────────────────────────────
  router.post('/llm/providers', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    const { name, type, api_key, base_url, enabled } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name and type required' });
    if (!PROVIDER_TYPES[type] && !base_url) return res.status(400).json({ error: `Unknown provider type: ${type}. Provide base_url or use: ${Object.keys(PROVIDER_TYPES).join(', ')}` });
    const existing = stmts.providers.getByName.get(name);
    if (existing) return res.status(409).json({ error: 'Provider already exists' });
    const id = randomUUID();
    const url = base_url || PROVIDER_TYPES[type]?.baseUrl || '';
    stmts.providers.insert.run(id, name, type, api_key || '', url, enabled !== false ? 1 : 0);
    audit('create', 'llm_provider', id, req.user.id, { name, type });
    logger.info(`LLM provider added: ${name} (${type})`);
    res.status(201).json({ id, name, type, base_url: url, enabled: enabled !== false });
  });

  router.get('/llm/providers', optionalAuth, (_req, res) => {
    const providers = stmts.providers.getAll.all();
    const masked = providers.map(p => ({ ...p, api_key: p.api_key ? `${p.api_key.slice(0, 6)}…${p.api_key.slice(-4)}` : '', has_key: !!p.api_key }));
    res.json(masked);
  });

  router.get('/llm/providers/:id', optionalAuth, (req, res) => {
    const provider = stmts.providers.getById.get(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    provider.api_key = provider.api_key ? `${provider.api_key.slice(0, 6)}…${provider.api_key.slice(-4)}` : '';
    provider.has_key = !!stmts.providers.getById.get(req.params.id).api_key;
    res.json(provider);
  });

  router.put('/llm/providers/:id', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const provider = stmts.providers.getById.get(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    const { api_key, base_url, enabled } = req.body;
    if (api_key !== undefined) stmts.providers.updateApiKey.run(api_key, provider.id);
    if (base_url !== undefined) db.prepare('UPDATE llm_providers SET base_url = ? WHERE id = ?').run(base_url, provider.id);
    if (enabled !== undefined) stmts.providers.updateEnabled.run(enabled ? 1 : 0, provider.id);
    audit('update', 'llm_provider', provider.id, req.user.id, { updated: Object.keys(req.body).join(',') });
    res.json({ ok: true });
  });

  router.delete('/llm/providers/:id', authMiddleware, requireRole('admin'), (req, res) => {
    const provider = stmts.providers.getById.get(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    stmts.models.deleteByProvider.run(provider.id);
    stmts.providers.delete.run(provider.id);
    audit('delete', 'llm_provider', provider.id, req.user.id, { name: provider.name });
    logger.info(`LLM provider removed: ${provider.name}`);
    res.json({ ok: true });
  });

  // ─── Auto-detect models from a provider ──────────────────────
  router.post('/llm/providers/:id/detect', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    const provider = stmts.providers.getById.get(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    const isOllama = provider.type === 'ollama';
    if (!provider.api_key && !isOllama) return res.status(400).json({ error: 'No API key configured for this provider' });

    const baseUrl = provider.base_url || PROVIDER_TYPES[provider.type]?.baseUrl || '';
    const modelsUrl = provider.base_url
      ? `${provider.base_url}${PROVIDER_TYPES[provider.type]?.modelsUrl || '/models'}`
      : `${baseUrl}${PROVIDER_TYPES[provider.type]?.modelsUrl || '/models'}`;

    let detected = [];
    try {
      if (provider.type === 'anthropic') {
        const anthropicModels = [
          { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', context_window: 200000 },
          { id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4', context_window: 200000 },
          { id: 'claude-3.7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet', context_window: 200000 },
          { id: 'claude-3.5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet (v2)', context_window: 200000 },
          { id: 'claude-3.5-haiku-20241022', display_name: 'Claude 3.5 Haiku', context_window: 200000 },
          { id: 'claude-3-opus-20240229', display_name: 'Claude 3 Opus', context_window: 200000 },
          { id: 'claude-3-sonnet-20240229', display_name: 'Claude 3 Sonnet', context_window: 200000 },
          { id: 'claude-3-haiku-20240307', display_name: 'Claude 3 Haiku', context_window: 200000 },
        ];
        detected = anthropicModels;
      } else {
        const { headers: fetchHeaders, url: fetchUrl } = buildProviderAuth(provider, modelsUrl);
        const resp = await fetch(fetchUrl, {
          headers: fetchHeaders,
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return res.status(502).json({ error: `Provider API returned ${resp.status}: ${text.slice(0, 200)}` });
        }
        const data = await resp.json();

        let rawModels;
        if (isOllama) {
          rawModels = (data.models || []).map(m => ({ id: m.name || m.model, display_name: (m.name || m.model).replace(':latest', ''), context_window: m.details?.parameter_size || null, capabilities: JSON.stringify(m.details || {}) }));
        } else {
          rawModels = data.data || data.models || data;
        }

        if (Array.isArray(rawModels)) {
          if (!isOllama) {
            detected = rawModels.map(m => {
              if (typeof m === 'string') return { id: m, display_name: m };
              return {
                id: m.id || m.model_id || m.name,
                display_name: m.display_name || m.id || m.name || m.model_id,
                context_window: m.context_window || m.context_length || m.max_context_tokens || null,
                capabilities: JSON.stringify(m.capabilities || m.metadata || {}),
              };
            }).filter(m => m.id);
          } else {
            detected = rawModels;
          }
        }
      }

      let inserted = 0;
      for (const model of detected) {
        const modelId = `${provider.id}:${model.id}`;
        try {
          stmts.models.insert.run(modelId, provider.id, model.id, model.display_name || model.id, model.context_window, model.capabilities || '{}', 0, new Date().toISOString());
          inserted++;
        } catch { /* skip duplicates */ }
      }

      stmts.providers.updatePing.run(provider.id);
      audit('detect', 'llm_provider', provider.id, req.user.id, { models_detected: inserted });
      logger.info(`Detected ${inserted} models from ${provider.name}`);
      res.json({ provider: provider.name, detected: inserted, models: detected.map(m => m.display_name || m.id) });
    } catch (err) {
      logger.error(`Model detection failed for ${provider.name}: ${err.message}`);
      res.status(502).json({ error: `Failed to reach provider: ${err.message}` });
    }
  });

  // ─── Models CRUD ─────────────────────────────────────────────
  router.get('/llm/models', optionalAuth, (_req, res) => {
    const models = stmts.models.getAll.all();
    const providers = stmts.providers.getAll.all();
    const providerMap = Object.fromEntries(providers.map(p => [p.id, p.name]));
    const enriched = models.map(m => ({ ...m, provider_name: providerMap[m.provider_id] || 'Unknown', capabilities: JSON.parse(m.capabilities || '{}') }));
    res.json(enriched);
  });

  router.get('/llm/models/default', optionalAuth, (_req, res) => {
    const model = stmts.models.getDefault.get();
    if (!model) return res.json(null);
    const provider = stmts.providers.getById.get(model.provider_id);
    res.json({ ...model, provider_name: provider?.name || 'Unknown', capabilities: JSON.parse(model.capabilities || '{}') });
  });

  router.post('/llm/models/set-default', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { model_id } = req.body;
    if (!model_id) return res.status(400).json({ error: 'model_id required' });
    const model = db.prepare('SELECT * FROM llm_models WHERE id = ?').get(model_id);
    if (!model) return res.status(404).json({ error: 'Model not found' });
    stmts.models.clearDefault.run();
    stmts.models.setDefault.run(model_id);
    audit('set_default', 'llm_model', model_id, req.user.id, {});
    res.json({ ok: true, model_id: model.model_id });
  });

  router.post('/llm/models/delete', authMiddleware, requireRole('admin'), (req, res) => {
    const { model_id } = req.body;
    if (!model_id) return res.status(400).json({ error: 'model_id required' });
    stmts.models.delete.run(model_id);
    res.json({ ok: true });
  });

  // ─── Detect ALL providers at once ────────────────────────────
  router.post('/llm/detect-all', authMiddleware, requireRole('admin'), apiLimiter, async (_req, res) => {
    const providers = stmts.providers.getAll.all().filter(p => p.enabled && p.api_key);
    const results = [];

    for (const provider of providers) {
      try {
        const detectRes = await fetch(`http://localhost:${PORT}/api/llm/providers/${provider.id}/detect`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${_req.headers.authorization?.slice(7) || ''}`, 'Content-Type': 'application/json' },
        });
        const data = await detectRes.json();
        results.push({ provider: provider.name, status: 'ok', ...data });
      } catch (err) {
        results.push({ provider: provider.name, status: 'error', error: err.message });
      }
    }

    res.json({ results });
  });

  // ─── Seed default providers (no keys) ────────────────────────
  router.post('/llm/seed', authMiddleware, requireRole('admin'), apiLimiter, (_req, res) => {
    const seeds = Object.entries(PROVIDER_TYPES).map(([type, info]) => ({
      name: info.name,
      type,
      base_url: info.baseUrl,
    }));
    let created = 0;
    for (const seed of seeds) {
      const existing = stmts.providers.getByName.get(seed.name);
      if (!existing) {
        const id = randomUUID();
        stmts.providers.insert.run(id, seed.name, seed.type, '', seed.base_url, 0);
        created++;
      }
    }
    res.json({ seeded: created, total: seeds.length });
  });

  return router;
}
