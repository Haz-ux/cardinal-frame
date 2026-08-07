/**
 * Cardinal Frame — Provider Runtime
 *
 * Provider-agnostic LLM execution layer: auth injection, retry/backoff,
 * streaming, timeouts. Calls the provider interface (formatRequest,
 * parseResponse, streamHandler) — never provider-specific logic directly.
 *
 * Retry/backoff logic reuses the same exponential-backoff shape as
 * job-queue.mjs, adapted for HTTP request retries (in-process, not
 * scheduled via SQLite).
 *
 * Adding a new provider = add one file in providers/ + register here.
 * No changes to this file or any route.
 */

import * as openaiProvider from './providers/openai.mjs';
import * as anthropicProvider from './providers/anthropic.mjs';
import * as googleProvider from './providers/google.mjs';
import * as ollamaProvider from './providers/ollama.mjs';
import { decryptProvider } from '../routes/settings.mjs';

// ── Provider registry ──────────────────────────────────────────────
// Maps provider type → interface module.
// All openai-compatible types share the openai provider interface.
const PROVIDER_REGISTRY = {
  openai:      openaiProvider,
  nvidia:      openaiProvider,
  openrouter:  openaiProvider,
  groq:        openaiProvider,
  together:    openaiProvider,
  deepseek:    openaiProvider,
  mistral:     openaiProvider,
  cerebras:    openaiProvider,
  sambanova:   openaiProvider,
  perplexity:  openaiProvider,
  xai:         openaiProvider,
  cohere:      openaiProvider,
  anthropic:   anthropicProvider,
  google:      googleProvider,
  ollama:      ollamaProvider,
};

export function getProviderInterface(type) {
  return PROVIDER_REGISTRY[type];
}

export function getRegisteredProviderTypes() {
  return Object.keys(PROVIDER_REGISTRY);
}

// ── HTTP Retry with Exponential Backoff ───────────────────────────
// Same shape as job-queue.mjs: base * 2^(attempt-1), capped at maxDelay.
// Used for transient failures (429, 5xx, network errors), NOT for 4xx
// client errors (bad request, auth failure — those shouldn't retry).

const DEFAULT_RETRY_OPTS = {
  maxRetries: 3,
  baseDelay: 1000,    // 1s, 2s, 4s
  maxDelay: 30000,    // cap at 30s
  retryableStatuses: [429, 500, 502, 503, 504],
};

function computeBackoffMs(attempt, baseDelay, maxDelay) {
  const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
  // Add jitter (±25%) to avoid thundering herd on rate limits
  const jitter = delay * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

function isRetryable(status, retryableStatuses) {
  return retryableStatuses.includes(status) || (status >= 500 && status < 600);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Core execution: non-streaming ─────────────────────────────────

/**
 * Execute a chat completion request against a provider.
 *
 * @param {object} provider - DB provider row { type, api_key, base_url, ... }
 * @param {string} modelId - Model ID to use
 * @param {Array} messages - Normalized message array [{ role, content }]
 * @param {object} opts - { stream, max_tokens, temperature, timeoutMs, ...retryOpts }
 * @returns {Promise<{ content, finishReason, promptTokens, completionTokens, raw }>}
 */
export async function executeChat(provider, modelId, messages, opts = {}) {
  decryptProvider(provider); // api_key is encrypted at rest in llm_providers
  const iface = getProviderInterface(provider.type);
  if (!iface) throw new Error(`Unknown provider type: ${provider.type}`);

  const {
    stream = false,
    timeoutMs = 30_000,
    ...retryOpts
  } = opts;

  const retryConfig = { ...DEFAULT_RETRY_OPTS, ...retryOpts };
  const pType = provider.type;

  // Build URL
  const providerInfo = pType === 'ollama'
    ? { baseUrl: provider.base_url || 'http://localhost:11434' }
    : null;
  const baseUrl = provider.base_url || providerInfo?.baseUrl ||
    getProviderBaseUrl(pType);
  const url = iface.buildUrl(baseUrl, modelId, stream);

  // Build auth + request
  const { headers, url: authedUrl } = iface.buildAuth(provider, url);
  const payload = iface.formatRequest(modelId, messages, { stream, ...opts });

  let lastError;
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const resp = await fetch(authedUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const error = new Error(`LLM API error (${resp.status}): ${errText.slice(0, 500)}`);
        error.status = resp.status;
        error.response = errText;

        if (isRetryable(resp.status, retryConfig.retryableStatuses) && attempt < retryConfig.maxRetries) {
          const backoff = computeBackoffMs(attempt + 1, retryConfig.baseDelay, retryConfig.maxDelay);
          await sleep(backoff);
          lastError = error;
          continue;
        }
        throw error;
      }

      // Success — parse response
      const data = await resp.json();
      return iface.parseResponse(data);

    } catch (err) {
      // Network error, timeout, or abort
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        // Timeouts are retryable
        if (attempt < retryConfig.maxRetries) {
          const backoff = computeBackoffMs(attempt + 1, retryConfig.baseDelay, retryConfig.maxDelay);
          await sleep(backoff);
          lastError = err;
          continue;
        }
      }
      // Already an HTTP error we threw above
      if (err.status) throw err;
      // Network error
      if (attempt < retryConfig.maxRetries) {
        const backoff = computeBackoffMs(attempt + 1, retryConfig.baseDelay, retryConfig.maxDelay);
        await sleep(backoff);
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('LLM call exhausted retries');
}

// ── Streaming execution ───────────────────────────────────────────

/**
 * Execute a streaming chat completion. Returns an async generator
 * yielding { content, done } chunks.
 *
 * @param {object} provider
 * @param {string} modelId
 * @param {Array} messages
 * @param {object} opts - { max_tokens, temperature, timeoutMs }
 * @returns {AsyncGenerator<{ content: string|null, done: boolean }>}
 */
export async function* executeChatStream(provider, modelId, messages, opts = {}) {
  decryptProvider(provider); // api_key is encrypted at rest in llm_providers
  const iface = getProviderInterface(provider.type);
  if (!iface) throw new Error(`Unknown provider type: ${provider.type}`);

  const { timeoutMs = 60_000 } = opts;
  const pType = provider.type;

  const baseUrl = provider.base_url || getProviderBaseUrl(pType);
  const url = iface.buildUrl(baseUrl, modelId, true);
  const { headers, url: authedUrl } = iface.buildAuth(provider, url);
  const payload = iface.formatRequest(modelId, messages, { stream: true, ...opts });

  const resp = await fetch(authedUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const error = new Error(`LLM API error (${resp.status}): ${errText.slice(0, 500)}`);
    error.status = resp.status;
    throw error;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  while (!done) {
    const { done: readerDone, value } = await reader.read();
    if (readerDone) { done = true; break; }

    const text = decoder.decode(value, { stream: true });
    buffer += text;

    // Handle both SSE (data: lines) and NDJSON (one JSON per line)
    const isSSE = buffer.includes('data: ');
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let chunkData;
      if (isSSE) {
        if (!trimmed.startsWith('data: ')) continue;
        chunkData = trimmed.slice(6);
      } else {
        chunkData = trimmed;
      }

      if (chunkData === '[DONE]') {
        yield { content: null, done: true };
        return;
      }

      const result = iface.streamHandler(chunkData);
      if (result.content !== null) yield { content: result.content, done: false };
      if (result.done) { yield { content: null, done: true }; return; }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    const chunkData = buffer.trim().startsWith('data: ')
      ? buffer.trim().slice(6)
      : buffer.trim();
    if (chunkData && chunkData !== '[DONE]') {
      try {
        const result = iface.streamHandler(chunkData);
        if (result.content !== null) yield { content: result.content, done: false };
      } catch {}
    }
  }

  yield { content: null, done: true };
}

// ── Provider base URLs (fallback when provider.base_url is null) ───

const PROVIDER_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  perplexity: 'https://api.perplexity.ai',
  xai: 'https://api.x.ai/v1',
  cohere: 'https://api.cohere.com/v2',
  ollama: 'http://localhost:11434',
};

function getProviderBaseUrl(type) {
  return PROVIDER_BASE_URLS[type] || '';
}

// ── Provider type metadata (for UI / CRUD) ────────────────────────
// Kept here so adding a new provider only touches this directory.

export const PROVIDER_TYPES = {
  openai:      { name: 'OpenAI',       baseUrl: PROVIDER_BASE_URLS.openai,      chatFormat: 'openai' },
  google:      { name: 'Google AI',    baseUrl: PROVIDER_BASE_URLS.google,       chatFormat: 'google' },
  nvidia:      { name: 'NVIDIA NIM',   baseUrl: PROVIDER_BASE_URLS.nvidia,      chatFormat: 'openai' },
  anthropic:   { name: 'Anthropic',    baseUrl: PROVIDER_BASE_URLS.anthropic,   chatFormat: 'anthropic', hardcodedModels: ['claude-sonnet-4-20250514','claude-opus-4-20250514','claude-3.5-sonnet-20241022','claude-3.5-haiku-20241022','claude-3-opus-20240229','claude-3-haiku-20240307'] },
  openrouter:  { name: 'OpenRouter',   baseUrl: PROVIDER_BASE_URLS.openrouter,  chatFormat: 'openai' },
  groq:        { name: 'Groq',         baseUrl: PROVIDER_BASE_URLS.groq,        chatFormat: 'openai' },
  together:    { name: 'Together AI',  baseUrl: PROVIDER_BASE_URLS.together,    chatFormat: 'openai' },
  deepseek:    { name: 'DeepSeek',     baseUrl: PROVIDER_BASE_URLS.deepseek,   chatFormat: 'openai' },
  mistral:     { name: 'Mistral',      baseUrl: PROVIDER_BASE_URLS.mistral,    chatFormat: 'openai' },
  cerebras:    { name: 'Cerebras',     baseUrl: PROVIDER_BASE_URLS.cerebras,   chatFormat: 'openai' },
  sambanova:   { name: 'SambaNova',    baseUrl: PROVIDER_BASE_URLS.sambanova,  chatFormat: 'openai' },
  perplexity:  { name: 'Perplexity',   baseUrl: PROVIDER_BASE_URLS.perplexity, chatFormat: 'openai' },
  xai:         { name: 'xAI (Grok)',   baseUrl: PROVIDER_BASE_URLS.xai,         chatFormat: 'openai' },
  cohere:      { name: 'Cohere',       baseUrl: PROVIDER_BASE_URLS.cohere,      chatFormat: 'openai' },
  ollama:      { name: 'Ollama (Local)', baseUrl: PROVIDER_BASE_URLS.ollama,  chatFormat: 'ollama', noKey: true },
};

// ── Ollama auto-detection (consolidated here from llm-helpers.mjs) ─

export async function detectOllama() {
  try {
    const r = await fetch('http://localhost:11434/api/version', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { connected: false };
    const version = await r.json();
    const modelsR = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    const modelsData = await modelsR.json();
    const models = (modelsData.models || []).map(m => m.name || m.model || m);
    return { connected: true, version: version.version, modelCount: models.length, models };
  } catch {
    return { connected: false };
  }
}
