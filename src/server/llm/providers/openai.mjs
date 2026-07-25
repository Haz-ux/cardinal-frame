/**
 * OpenAI-compatible provider interface.
 *
 * Used by: openai, nvidia, openrouter, groq, together, deepseek,
 * mistral, cerebras, sambanova, perplexity, xai, cohere.
 *
 * Common interface: { formatRequest, parseResponse, streamHandler }
 */

export function formatRequest(modelId, messages, opts = {}) {
  return {
    model: modelId,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    max_tokens: opts.max_tokens ?? 4096,
    stream: opts.stream ?? false,
    ...(opts.temperature ? { temperature: opts.temperature } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
  };
}

export function parseResponse(data) {
  return {
    content: data.choices?.[0]?.message?.content || '',
    finishReason: data.choices?.[0]?.finish_reason || 'stop',
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    raw: data,
  };
}

/**
 * Stream handler — called with each SSE chunk.
 * Returns { content: string|null, done: boolean }.
 */
export function streamHandler(chunk) {
  if (chunk === '[DONE]') return { content: null, done: true };
  try {
    const parsed = JSON.parse(chunk);
    const delta = parsed.choices?.[0]?.delta?.content;
    return { content: delta || null, done: false };
  } catch {
    return { content: null, done: false };
  }
}

export function buildUrl(baseUrl, _modelId, stream) {
  return `${baseUrl}/chat/completions`;
}

export function buildAuth(provider, url) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.type === 'openrouter') {
    headers['HTTP-Referer'] = 'https://cardinal-frame.local';
    return { headers: { ...headers, Authorization: `Bearer ${provider.api_key}` }, url };
  }
  return { headers: { ...headers, Authorization: `Bearer ${provider.api_key}` }, url };
}
