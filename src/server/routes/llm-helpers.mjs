// ─── LLM Helpers (compat shim — re-exports from llm/ provider-runtime) ─
// All provider logic now lives in src/server/llm/:
//   - provider-runtime.mjs: execution, retry/backoff, streaming
//   - providers/: per-provider request/response shaping
//   - model-catalog.mjs: pricing, context windows, capabilities
//
// This file re-exports the old API surface so existing imports continue
// to work. New code should import from llm/ directly.

export {
  PROVIDER_TYPES,
  detectOllama,
  getProviderInterface,
  getRegisteredProviderTypes,
  executeChat,
  executeChatStream,
} from '../llm/provider-runtime.mjs';

export { getModelCost, getModelMeta, getContextWindow, hasCapability, listKnownModels } from '../llm/model-catalog.mjs';

// ── Legacy compat functions (delegate to provider-runtime internals) ──
// These are kept because chat-completions.mjs and agent.mjs call them
// directly. They'll be phased out as those routes migrate to executeChat.

import { PROVIDER_TYPES, getProviderInterface } from '../llm/provider-runtime.mjs';
import { decryptProvider } from './settings.mjs';

export function buildProviderAuth(provider, url) {
  decryptProvider(provider); // api_key is encrypted at rest in llm_providers
  const iface = getProviderInterface(provider.type);
  return iface ? iface.buildAuth(provider, url) : { headers: { 'Content-Type': 'application/json' }, url };
}

export function buildChatUrl(baseUrl, providerType, modelId, stream = false) {
  const iface = getProviderInterface(providerType);
  if (!iface) return `${baseUrl}/chat/completions`;
  return iface.buildUrl(baseUrl, modelId, stream);
}

export function buildChatPayload(providerType, modelId, messages, stream = false) {
  const iface = getProviderInterface(providerType);
  if (!iface) return { model: modelId, messages: messages.map(m => ({ role: m.role, content: m.content })), max_tokens: 4096, stream };
  return iface.formatRequest(modelId, messages, { stream, max_tokens: 4096 });
}

// Fetches the model list for any provider (OpenAI-compatible /models,
// Ollama /api/tags, or the known Anthropic catalog) and upserts each
// model into llm_models, keyed by `${provider.id}:${model.id}`.
export async function detectModelsFromProvider(db, provider) {
  const isOllama = provider.type === 'ollama';
  const providerInfo = PROVIDER_TYPES[provider.type];
  const baseUrl = provider.base_url || providerInfo?.baseUrl || '';
  const modelsUrl = isOllama
    ? `${baseUrl}/api/tags`
    : `${baseUrl}${providerInfo?.modelsUrl || '/models'}`;

  let detected = [];
  if (provider.type === 'anthropic') {
    detected = [
      { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', context_window: 200000 },
      { id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4', context_window: 200000 },
      { id: 'claude-3.7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet', context_window: 200000 },
      { id: 'claude-3.5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet (v2)', context_window: 200000 },
      { id: 'claude-3.5-haiku-20241022', display_name: 'Claude 3.5 Haiku', context_window: 200000 },
      { id: 'claude-3-opus-20240229', display_name: 'Claude 3 Opus', context_window: 200000 },
      { id: 'claude-3-sonnet-20240229', display_name: 'Claude 3 Sonnet', context_window: 200000 },
      { id: 'claude-3-haiku-20240307', display_name: 'Claude 3 Haiku', context_window: 200000 },
    ];
  } else {
    const { headers, url } = buildProviderAuth(provider, modelsUrl);
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Provider API returned ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = await resp.json();

    let rawModels;
    if (isOllama) {
      rawModels = (data.models || []).map(m => ({ id: m.name || m.model, display_name: (m.name || m.model).replace(':latest', ''), context_window: m.details?.parameter_size || null, capabilities: JSON.stringify(m.details || {}) }));
    } else {
      rawModels = data.data || data.models || data;
    }

    if (Array.isArray(rawModels)) {
      if (isOllama) {
        detected = rawModels;
      } else {
        detected = rawModels
          .map(m => {
            if (typeof m === 'string') return { id: m, display_name: m };
            return {
              id: m.id || m.model_id || m.name,
              display_name: m.display_name || m.id || m.name || m.model_id,
              context_window: m.context_window || m.context_length || m.max_context_tokens || null,
              capabilities: JSON.stringify(m.capabilities || m.metadata || {}),
            };
          })
          .filter(m => m.id);
      }
    }
  }

  let inserted = 0;
  const upsert = db.prepare(`
    INSERT INTO llm_models (id, provider_id, model_id, display_name, context_window, capabilities, is_default, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET
      model_id = excluded.model_id,
      display_name = excluded.display_name,
      context_window = excluded.context_window,
      capabilities = excluded.capabilities,
      detected_at = excluded.detected_at
  `);
  for (const model of detected) {
    const modelId = `${provider.id}:${model.id}`;
    try {
      upsert.run(modelId, provider.id, model.id, model.display_name || model.id, model.context_window, model.capabilities || '{}', new Date().toISOString());
      inserted++;
    } catch { /* skip duplicates */ }
  }
  return { detected, inserted };
}
