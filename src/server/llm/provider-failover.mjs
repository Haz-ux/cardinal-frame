/**
 * Cardinal Frame — Provider Failover Wrapper
 *
 * Wraps executeChat with automatic failover to backup providers.
 * Reads failover config from llm_providers table (priority, is_fallback).
 *
 * Usage:
 *   import { executeChatWithFailover } from './provider-failover.mjs';
 *   const result = await executeChatWithFailover(db, modelId, messages, opts);
 */

import { getProviderInterface, executeChat, executeChatStream } from './provider-runtime.mjs';
import { decryptProvider } from '../routes/settings.mjs';

const FAILOVER_ORDER = ['nvidia', 'anthropic', 'google', 'openai', 'ollama'];

export async function getProviderFailoverChain(db, preferredType = null) {
  const providers = db.prepare('SELECT * FROM llm_providers WHERE enabled = 1').all();
  const usable = providers
    .filter(p => p.type === 'ollama' || (p.api_key && p.api_key.length > 10 && !p.api_key.includes('*')))
    .sort((a, b) => {
      // First sort by explicit priority
      if (a.priority !== b.priority) return (a.priority || 100) - (b.priority || 100);
      // Then by failover order preference
      const ai = FAILOVER_ORDER.indexOf(a.type);
      const bi = FAILOVER_ORDER.indexOf(b.type);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

  if (preferredType) {
    const preferred = usable.find(p => p.type === preferredType);
    if (preferred) return [preferred, ...usable.filter(p => p.id !== preferred.id)];
  }
  return usable;
}

export async function getModelWithFailover(db, modelId) {
  // Find the model across all providers
  const modelRows = db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').all(modelId, modelId);
  if (modelRows.length === 0) return null;

  // Group by provider
  const byProvider = {};
  for (const m of modelRows) {
    const provider = db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(m.provider_id);
    if (provider && provider.enabled) {
      byProvider[provider.id] = { model: m, provider };
    }
  }

  // Sort providers by failover preference
  const providerIds = Object.keys(byProvider).sort((a, b) => {
    const pa = byProvider[a].provider;
    const pb = byProvider[b].provider;
    const ai = FAILOVER_ORDER.indexOf(pa.type);
    const bi = FAILOVER_ORDER.indexOf(pb.type);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return providerIds.map(id => byProvider[id]);
}

/**
 * Execute chat with automatic failover to backup providers/models.
 *
 * @param {object} db - Database connection
 * @param {string} modelId - Model ID to try first
 * @param {Array} messages - Chat messages
 * @param {object} opts - { stream, max_tokens, temperature, timeoutMs, retryOpts, onFailover }
 * @returns {Promise<{ content, finishReason, promptTokens, completionTokens, raw, provider, model }>}
 */
export async function executeChatWithFailover(db, modelId, messages, opts = {}) {
  const candidates = await getModelWithFailover(db, modelId);
  if (candidates.length === 0) {
    throw new Error(`No available providers for model: ${modelId}`);
  }

  let lastError;
  for (let i = 0; i < candidates.length; i++) {
    const { model, provider } = candidates[i];
    const actualModelId = model.model_id;

    try {
      const timeoutMs = opts.timeoutMs || (provider.type === 'nvidia' ? 150000 : 30000);

      const result = await executeChat(provider, actualModelId, messages, {
        ...opts,
        timeoutMs,
      });

      return {
        ...result,
        provider: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        model: actualModelId,
        modelDisplayName: model.display_name,
        failoverAttempt: i,
      };
    } catch (err) {
      // A 404 means the provider no longer offers this model — surface a
      // clear, actionable error instead of the raw upstream body.
      if (err.status === 404) {
        err.message = `Model "${actualModelId}" is no longer available on ${provider.name}. Re-run Detect Models on the LLM Models page and pick a current model.`;
      }
      lastError = err;
      console.warn(`[Failover] Provider ${provider.name} (${provider.type}) failed: ${err.message}`);

      // Call optional failover callback
      if (opts.onFailover) {
        await opts.onFailover({ attempt: i, provider: provider.id, error: err.message });
      }

      // Don't retry on 4xx client errors (bad request, auth failure, etc.)
      if (err.status && err.status >= 400 && err.status < 500) {
        continue; // Try next provider
      }
      // For 5xx and network errors, we already have retry logic in executeChat
      // If we reach here, executeChat exhausted its retries
      continue;
    }
  }

  throw new Error(`All providers failed for model ${modelId}. Last error: ${lastError?.message}`);
}

/**
 * Streaming version with failover.
 */
export async function* executeChatStreamWithFailover(db, modelId, messages, opts = {}) {
  const candidates = await getModelWithFailover(db, modelId);
  if (candidates.length === 0) {
    throw new Error(`No available providers for model: ${modelId}`);
  }

  let lastError;
  for (let i = 0; i < candidates.length; i++) {
    const { model, provider } = candidates[i];
    const actualModelId = model.model_id;

    try {
      const timeoutMs = opts.timeoutMs || (provider.type === 'nvidia' ? 150000 : 60000);

      // Try streaming
      for await (const chunk of executeChatStream(provider, actualModelId, messages, {
        ...opts,
        timeoutMs,
      })) {
        yield {
          ...chunk,
          provider: provider.id,
          providerType: provider.type,
          model: actualModelId,
          failoverAttempt: i,
        };
      }
      return; // Success - exit the generator

    } catch (err) {
      // A 404 means the provider no longer offers this model — surface a
      // clear, actionable error instead of the raw upstream body.
      if (err.status === 404) {
        err.message = `Model "${actualModelId}" is no longer available on ${provider.name}. Re-run Detect Models on the LLM Models page and pick a current model.`;
      }
      lastError = err;
      console.warn(`[Failover Stream] Provider ${provider.name} (${provider.type}) failed: ${err.message}`);

      if (opts.onFailover) {
        await opts.onFailover({ attempt: i, provider: provider.id, error: err.message });
      }

      // Don't failover on 4xx
      if (err.status && err.status >= 400 && err.status < 500) {
        continue;
      }
      continue;
    }
  }

  throw new Error(`All providers failed for model ${modelId}. Last error: ${lastError?.message}`);
}