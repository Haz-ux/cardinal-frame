import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeChat, getProviderInterface, getRegisteredProviderTypes, computeBackoffMs } from '../src/server/llm/provider-runtime.mjs';
import { getModelCost, getModelMeta, getContextWindow, hasCapability, listKnownModels } from '../src/server/llm/model-catalog.mjs';

// ── Model Catalog Tests ───────────────────────────────────────────

describe('Model Catalog', () => {
  it('should return cost for known models', () => {
    const cost = getModelCost('gpt-4o', 1_000_000, 500_000);
    expect(cost).toBeCloseTo(2.50 + 5.00, 4); // 2.50/1M input + 10.00/1M output * 0.5M
  });

  it('should match longest prefix first (gpt-4o-mini before gpt-4o)', () => {
    const cost = getModelCost('gpt-4o-mini', 1_000_000, 0);
    expect(cost).toBeCloseTo(0.15, 4);
  });

  it('should return 0 for local/ollama models', () => {
    expect(getModelCost('ollama/llama3', 1000, 1000)).toBe(0);
    expect(getModelCost('local-model', 1000, 1000)).toBe(0);
  });

  it('should return default cost for unknown models', () => {
    const cost = getModelCost('some-unknown-model', 1_000_000, 500_000);
    expect(cost).toBeCloseTo(1 + 1.5, 4);
  });

  it('should return context window for known models', () => {
    expect(getContextWindow('gpt-4o')).toBe(128_000);
    expect(getContextWindow('unknown-model')).toBe(0);
  });

  it('should check capabilities', () => {
    expect(hasCapability('gpt-4o', 'vision')).toBe(true);
    expect(hasCapability('llama-3.1-8b', 'vision')).toBe(false);
    expect(hasCapability('unknown', 'vision')).toBe(false);
  });

  it('should list all known models', () => {
    const models = listKnownModels();
    expect(models.length).toBeGreaterThan(15);
    expect(models).toContain('gpt-4o');
    expect(models).toContain('claude-3.5-sonnet');
  });

  it('should return null for unknown model meta', () => {
    expect(getModelMeta('')).toBeNull();
    expect(getModelMeta(null)).toBeNull();
    const meta = getModelMeta('nonexistent-model-xyz');
    expect(meta).toBeNull();
  });
});

// ── Provider Registry Tests ────────────────────────────────────────

describe('Provider Registry', () => {
  it('should return provider interface for known types', () => {
    const types = ['openai', 'anthropic', 'google', 'ollama', 'nvidia', 'openrouter'];
    for (const type of types) {
      const iface = getProviderInterface(type);
      expect(iface).toBeDefined();
      expect(typeof iface.formatRequest).toBe('function');
      expect(typeof iface.parseResponse).toBe('function');
      expect(typeof iface.streamHandler).toBe('function');
      expect(typeof iface.buildUrl).toBe('function');
      expect(typeof iface.buildAuth).toBe('function');
    }
  });

  it('should return undefined for unknown provider type', () => {
    expect(getProviderInterface('unknown')).toBeUndefined();
  });

  it('should list all registered provider types', () => {
    const types = getRegisteredProviderTypes();
    expect(types.length).toBeGreaterThanOrEqual(10);
    expect(types).toContain('openai');
    expect(types).toContain('anthropic');
    expect(types).toContain('ollama');
    expect(types).toContain('nvidia');
  });

  it('should share openai interface across compatible types', () => {
    const openaiIface = getProviderInterface('openai');
    const nvidiaIface = getProviderInterface('nvidia');
    const groqIface = getProviderInterface('groq');
    expect(nvidiaIface).toBe(openaiIface);
    expect(groqIface).toBe(openaiIface);
  });
});

// ── Provider Interface Tests ──────────────────────────────────────

describe('OpenAI Provider Interface', () => {
  const iface = getProviderInterface('openai');

  it('should format request with messages and options', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const payload = iface.formatRequest('gpt-4o', messages, { max_tokens: 2000, temperature: 0.7 });
    expect(payload.model).toBe('gpt-4o');
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(payload.max_tokens).toBe(2000);
    expect(payload.temperature).toBe(0.7);
    expect(payload.stream).toBe(false);
  });

  it('should parse response correctly', () => {
    const data = {
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = iface.parseResponse(data);
    expect(result.content).toBe('hi');
    expect(result.finishReason).toBe('stop');
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(5);
  });

  it('should handle [DONE] in stream handler', () => {
    const result = iface.streamHandler('[DONE]');
    expect(result.done).toBe(true);
    expect(result.content).toBeNull();
  });

  it('should parse SSE chunk', () => {
    const chunk = JSON.stringify({ choices: [{ delta: { content: 'hello' } }] });
    const result = iface.streamHandler(chunk);
    expect(result.content).toBe('hello');
    expect(result.done).toBe(false);
  });
});

describe('Anthropic Provider Interface', () => {
  const iface = getProviderInterface('anthropic');

  it('should separate system message from chat messages', () => {
    const messages = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hello' },
    ];
    const payload = iface.formatRequest('claude-3-opus', messages, {});
    expect(payload.system).toBe('be helpful');
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(payload.max_tokens).toBe(4096);
  });

  it('should parse response content from content[0].text', () => {
    const data = {
      content: [{ text: 'response' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 10 },
    };
    const result = iface.parseResponse(data);
    expect(result.content).toBe('response');
    expect(result.promptTokens).toBe(20);
    expect(result.completionTokens).toBe(10);
  });
});

describe('Google Provider Interface', () => {
  const iface = getProviderInterface('google');

  it('should map roles correctly (assistant→model)', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const payload = iface.formatRequest('gemini-pro', messages, { max_tokens: 1000 });
    expect(payload.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
    ]);
    expect(payload.generationConfig.maxOutputTokens).toBe(1000);
  });

  it('should put API key in query string', () => {
    const { url } = iface.buildAuth({ api_key: 'test-key' }, 'https://example.com/generateContent');
    expect(url).toContain('key=test-key');
  });
});

describe('Ollama Provider Interface', () => {
  const iface = getProviderInterface('ollama');

  it('should format request without max_tokens', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const payload = iface.formatRequest('llama3', messages, {});
    expect(payload.model).toBe('llama3');
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(payload.stream).toBe(false);
    expect(payload.max_tokens).toBeUndefined();
  });

  it('should not require API key in auth', () => {
    const { headers } = iface.buildAuth(null, 'http://localhost:11434/api/chat');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
  });
});

// ── Retry/Backoff Tests ────────────────────────────────────────────

describe('executeChat retry/backoff', () => {
  const mockProvider = {
    type: 'openai',
    api_key: 'test-key',
    base_url: 'https://api.openai.com/v1',
  };

  beforeEach(() => {
    // Mock global fetch
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('should succeed on first try with valid response', async () => {
    const mockData = {
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    });

    const result = await executeChat(mockProvider, 'gpt-4o', [{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('hello');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on 429 then succeed', async () => {
    const mockData = {
      choices: [{ message: { content: 'success' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    fetch
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce({ ok: true, json: async () => mockData });

    const result = await executeChat(mockProvider, 'gpt-4o', [{ role: 'user', content: 'hi' }], {
      baseDelay: 10, // fast for tests
      maxDelay: 50,
    });
    expect(result.content).toBe('success');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should NOT retry on 400 (non-retryable)', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    });

    await expect(
      executeChat(mockProvider, 'gpt-4o', [{ role: 'user', content: 'hi' }], {
        baseDelay: 10,
        maxDelay: 50,
      })
    ).rejects.toThrow('LLM API error (400)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on network error then succeed', async () => {
    const mockData = {
      choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    fetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, json: async () => mockData });

    const result = await executeChat(mockProvider, 'gpt-4o', [{ role: 'user', content: 'hi' }], {
      baseDelay: 10,
      maxDelay: 50,
    });
    expect(result.content).toBe('recovered');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should exhaust retries and throw on persistent 500', async () => {
    fetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    });

    await expect(
      executeChat(mockProvider, 'gpt-4o', [{ role: 'user', content: 'hi' }], {
        baseDelay: 10,
        maxDelay: 50,
        maxRetries: 2,
      })
    ).rejects.toThrow('LLM API error (503)');
    expect(fetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('should throw for unknown provider type', async () => {
    await expect(
      executeChat({ type: 'unknown-provider', api_key: '' }, 'model', [])
    ).rejects.toThrow('Unknown provider type');
  });
});
