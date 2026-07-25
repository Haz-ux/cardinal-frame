/**
 * Ollama (local) provider interface.
 * No API key needed. NDJSON streaming (not SSE). Different model list URL.
 */

export function formatRequest(modelId, messages, opts = {}) {
  return {
    model: modelId,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: opts.stream ?? false,
  };
}

export function parseResponse(data) {
  return {
    content: data.message?.content || '',
    finishReason: 'stop',
    promptTokens: data.prompt_eval_count || 0,
    completionTokens: data.eval_count || 0,
    raw: data,
  };
}

export function streamHandler(chunk) {
  try {
    const parsed = JSON.parse(chunk);
    const content = parsed.message?.content || '';
    return { content: content || null, done: parsed.done ?? false };
  } catch {
    return { content: null, done: false };
  }
}

export function buildUrl(baseUrl, _modelId, _stream) {
  return `${baseUrl}/api/chat`;
}

export function buildAuth(_provider, url) {
  return { headers: { 'Content-Type': 'application/json' }, url };
}
