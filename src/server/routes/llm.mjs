import express from 'express';
import { randomUUID } from 'crypto';
import { PROVIDER_TYPES, buildProviderAuth, detectOllama, detectModelsFromProvider } from './llm-helpers.mjs';

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
          let added = 0;
          for (const modelName of status.models) {
            try {
              const existingModel = db.prepare('SELECT id FROM llm_models WHERE provider_id = ? AND model_id = ?').get(provider.id, modelName);
              if (existingModel) continue;
              const mid = `${provider.id}:${modelName}`;
              db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name) VALUES (?, ?, ?, ?)')
                .run(mid, provider.id, modelName, modelName.replace(':latest', ''));
              added++;
            } catch (e) {
              logger.warn(`🦙 Failed to register model "${modelName}": ${e.message}`);
            }
          }
          logger.info(`🦙 Auto-detected ${added} Ollama models (${status.models.length} available)`);
        }
      }
    } else {
      logger.info('🦙 Ollama not detected on localhost:11434');
    }
  });
}

export default function llmRoutes(ctx) {
  const { db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter, audit, broadcast, logger, PORT } = ctx;
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
          const mid = `${provider.id}:${modelName}`;
          db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name) VALUES (?, ?, ?, ?)')
            .run(mid, provider.id, modelName, modelName.replace(':latest', ''));
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
    const url = base_url || PROVIDER_TYPES[type]?.baseUrl || '';
    const existing = stmts.providers.getByName.get(name) || stmts.providers.getByTypeAndUrl?.get(type, url);
    if (existing) return res.status(409).json({ error: 'Provider already exists' });
    const id = randomUUID();
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

  // ─── Test provider API key (before saving) ──────────────────

  router.post('/llm/providers/test', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { type, api_key, base_url } = req.body;
      if (!type) return res.status(400).json({ error: 'type required' });
      if (!PROVIDER_TYPES[type] && !base_url) return res.status(400).json({ error: `Unknown type. Use: ${Object.keys(PROVIDER_TYPES).join(', ')}` });

      const baseUrl = base_url || PROVIDER_TYPES[type]?.baseUrl || '';
      if (!baseUrl && type !== 'ollama') return res.status(400).json({ error: 'base_url required for custom providers' });

      // Build a minimal test request — just listing models or sending "Hi"
      const testProvider = { type, api_key: api_key || '', base_url: baseUrl };
      const testMessages = [{ role: 'user', content: 'Say "ok" and nothing else.' }];
      const { buildChatUrl, buildChatPayload } = await import('./llm-helpers.mjs');
      const rawUrl = buildChatUrl(baseUrl, type, PROVIDER_TYPES[type]?.hardcodedModels?.[0] || 'test', false);
      const { headers, url } = buildProviderAuth(testProvider, rawUrl);
      const payload = buildChatPayload(type, PROVIDER_TYPES[type]?.hardcodedModels?.[0] || 'test', testMessages, false);
      if (!payload.max_tokens) payload.max_tokens = 10;
      else payload.max_tokens = Math.min(payload.max_tokens, 10);

      const resp = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return res.json({ ok: false, status: resp.status, error: `${resp.status} ${resp.statusText}`, detail: text.slice(0, 500) });
      }

      const data = await resp.json();
      // Extract the actual response text to confirm the model works
      let reply = '';
      if (type === 'ollama') reply = data.message?.content || '';
      else if (type === 'google') reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      else if (type === 'anthropic') reply = data.content?.[0]?.text || '';
      else reply = data.choices?.[0]?.message?.content || '';

      res.json({ ok: true, reply: reply.slice(0, 100), model_used: payload.model });
    } catch (e) {
      res.json({ ok: false, error: e.message?.slice(0, 500) || 'Connection failed' });
    }
  });

  // ─── Auto-detect models from a provider ──────────────────────
  router.post('/llm/providers/:id/detect', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    const provider = stmts.providers.getById.get(req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    const isOllama = provider.type === 'ollama';
    if (!provider.api_key && !isOllama) return res.status(400).json({ error: 'No API key configured for this provider' });

    try {
      const { detected, inserted } = await detectModelsFromProvider(db, provider);
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

  // ─── Detect ALL enabled providers at once ─────────────────────
  // Runs the shared detection logic directly (no loopback HTTP call),
  // covering keyed providers and local Ollama.
  router.post('/llm/detect-all', authMiddleware, requireRole('admin'), apiLimiter, async (_req, res) => {
    const providers = stmts.providers.getAll.all()
      .filter(p => p.enabled)
      .map(p => stmts.providers.getById.get(p.id))
      .filter(p => p && (p.api_key || p.type === 'ollama'));
    const results = [];

    for (const provider of providers) {
      try {
        const { detected, inserted } = await detectModelsFromProvider(db, provider);
        stmts.providers.updatePing.run(provider.id);
        results.push({ provider: provider.name, provider_id: provider.id, status: 'ok', detected: inserted, models: detected.map(m => m.display_name || m.id) });
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
      // A provider is identified by (type, base_url) — the same vendor must
      // not be seeded twice under a different display name (e.g. "Nvidia"
      // vs "NVIDIA NIM").
      const existing = stmts.providers.getByTypeAndUrl?.get(seed.type, seed.base_url) || stmts.providers.getByName.get(seed.name);
      if (!existing) {
        const id = randomUUID();
        stmts.providers.insert.run(id, seed.name, seed.type, '', seed.base_url, 0);
        created++;
      }
    }
    res.json({ seeded: created, total: seeds.length });
  });

  // ─── Provider Setup Wizard ─────────────────────────────────
  // One-shot endpoint: adds provider, tests API key, auto-detects models, sets default model
  router.post('/llm/providers/setup', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { type, name, api_key, base_url } = req.body;
      if (!type || !name) return res.status(400).json({ error: 'type and name required' });
      const providerInfo = PROVIDER_TYPES[type];
      if (!providerInfo) return res.status(400).json({ error: `Unknown provider type: ${type}` });

      // Step 1: Create provider (disabled until tested)
      const finalBaseUrl = base_url || providerInfo.baseUrl || '';
      const existing = stmts.providers.getByName.get(name) || stmts.providers.getByTypeAndUrl?.get(type, finalBaseUrl);
      if (existing) return res.status(409).json({ error: `Provider "${name}" already exists`, provider_id: existing.id });

      const id = randomUUID();
      stmts.providers.insert.run(id, name, type, api_key || '', finalBaseUrl, 0);
      let provider = stmts.providers.getById.get(id);

      const result = { provider_id: id, steps: [] };

      // Step 2: Test API key (skip for ollama — no key needed)
      if (type !== 'ollama' && api_key) {
        try {
          const { headers } = buildProviderAuth({ type, api_key: api_key || '', base_url: finalBaseUrl || providerInfo.baseUrl || '' }, (finalBaseUrl || providerInfo.baseUrl) + (providerInfo.modelsUrl || '/models'));

          if (type === 'anthropic') {
            const testResp = await fetch('https://api.anthropic.com/v1/models', { headers });
            if (!testResp.ok) {
              const errText = await testResp.text().catch(() => '');
              result.steps.push({ step: 'test', status: 'failed', error: `${testResp.status} ${errText.slice(0, 200)}` });
              res.json(result);
              return;
            }
          } else {
            const modelsUrl = finalBaseUrl ? `${finalBaseUrl}${providerInfo.modelsUrl || '/models'}` : `${providerInfo.baseUrl}${providerInfo.modelsUrl || '/models'}`;
            const testResp = await fetch(modelsUrl, { headers });
            if (!testResp.ok) {
              const errText = await testResp.text().catch(() => '');
              result.steps.push({ step: 'test', status: 'failed', error: `${testResp.status} ${errText.slice(0, 200)}` });
              res.json(result);
              return;
            }
          }
          result.steps.push({ step: 'test', status: 'passed' });
        } catch (e) {
          result.steps.push({ step: 'test', status: 'failed', error: e.message?.slice(0, 300) });
          res.json(result);
          return;
        }
      } else {
        result.steps.push({ step: 'test', status: 'skipped', reason: type === 'ollama' ? 'Ollama needs no API key' : 'No API key provided' });
      }

      // Step 3: Enable provider
      db.prepare('UPDATE llm_providers SET enabled = 1 WHERE id = ?').run(id);
      provider = stmts.providers.getById.get(id);
      result.steps.push({ step: 'enable', status: 'passed' });

      // Step 4: Auto-detect models
      try {
        let detectedModels = [];
        if (type === 'anthropic') {
          const { headers } = buildProviderAuth({ type, api_key: api_key || '', base_url: providerInfo.baseUrl || '' }, 'https://api.anthropic.com/v1/models');
          const modelsResp = await fetch('https://api.anthropic.com/v1/models', { headers });
          if (modelsResp.ok) {
            const modelsData = await modelsResp.json();
            detectedModels = (modelsData.data || []).map(m => m.id);
          }
        } else {
          const { headers, url: modelsUrl } = buildProviderAuth({ type, api_key: api_key || '', base_url: finalBaseUrl || providerInfo.baseUrl || '' }, (finalBaseUrl || providerInfo.baseUrl) + (providerInfo.modelsUrl || '/models'));
          const modelsResp = await fetch(modelsUrl, { headers });
          if (modelsResp.ok) {
            const modelsData = await modelsResp.json();
            const dataArr = modelsData.data || modelsData.models || modelsData;
            detectedModels = Array.isArray(dataArr) ? dataArr.map(m => typeof m === 'string' ? m : m.id || m.name).filter(Boolean) : [];
          }
        }

        let added = 0;
        for (const modelId of detectedModels) {
          const existingModel = db.prepare('SELECT id FROM llm_models WHERE provider_id = ? AND model_id = ?').get(id, modelId);
          if (!existingModel) {
            const modelUuid = `${id}:${modelId}`;
            db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name) VALUES (?, ?, ?, ?)').run(modelUuid, id, modelId, modelId);
            added++;
          }
        }
        result.steps.push({ step: 'detect_models', status: 'passed', models_found: detectedModels.length, models_added: added, models: detectedModels.slice(0, 20) });

        // Step 5: Set first detected model as default if no default exists
        const currentDefault = stmts.models.getDefault.get();
        if (!currentDefault && detectedModels.length > 0) {
          const firstModel = db.prepare('SELECT id FROM llm_models WHERE provider_id = ? AND model_id = ?').get(id, detectedModels[0]);
          if (firstModel) {
            db.prepare('UPDATE llm_models SET is_default = 0').run();
            db.prepare('UPDATE llm_models SET is_default = 1 WHERE id = ?').run(firstModel.id);
            result.steps.push({ step: 'set_default', status: 'passed', model: detectedModels[0] });
          }
        } else {
          result.steps.push({ step: 'set_default', status: 'skipped', reason: currentDefault ? 'Default already set' : 'No models detected' });
        }
      } catch (e) {
        result.steps.push({ step: 'detect_models', status: 'failed', error: e.message?.slice(0, 300) });
      }

      result.provider = { ...provider, config: JSON.parse(provider.config || '{}') };
      broadcast('llm:provider', { type: 'setup_complete', provider_id: id });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
