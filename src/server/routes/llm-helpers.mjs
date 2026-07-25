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

import { PROVIDER_TYPES as _PT, getProviderInterface } from '../llm/provider-runtime.mjs';

export function buildProviderAuth(provider, url) {
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
