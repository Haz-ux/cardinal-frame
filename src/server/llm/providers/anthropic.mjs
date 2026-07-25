/**
 * Anthropic provider interface.
 * Different auth header, different request/response shape, different SSE format.
 */

export function formatRequest(modelId, messages, opts = {}) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  return {
    model: modelId,
    messages: chatMsgs,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    max_tokens: opts.max_tokens ?? 4096,
    stream: opts.stream ?? false,
  };
}

export function parseResponse(data) {
  return {
    content: data.content?.[0]?.text || '',
    finishReason: data.stop_reason || 'stop',
    promptTokens: data.usage?.input_tokens || 0,
    completionTokens: data.usage?.output_tokens || 0,
    raw: data,
  };
}

export function streamHandler(chunk) {
  try {
    const parsed = JSON.parse(chunk);
    if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
      return { content: parsed.delta.text, done: false };
    }
    if (parsed.type === 'message_stop') {
      return { content: null, done: true };
    }
    return { content: null, done: false };
  } catch {
    return { content: null, done: false };
  }
}

export function buildUrl(baseUrl, _modelId, _stream) {
  return `${baseUrl}/messages`;
}

export function buildAuth(provider, url) {
  return {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.api_key,
      'anthropic-version': '2023-06-01',
    },
    url,
  };
}
