/**
 * Google Gemini provider interface.
 * Key goes in query string, not headers. Different request/response shape.
 */

export function formatRequest(modelId, messages, opts = {}) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  return {
    contents,
    generationConfig: {
      ...(opts.max_tokens ? { maxOutputTokens: opts.max_tokens } : {}),
      ...(opts.temperature ? { temperature: opts.temperature } : {}),
    },
  };
}

export function parseResponse(data) {
  return {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    finishReason: data.candidates?.[0]?.finishReason || 'STOP',
    promptTokens: data.usageMetadata?.promptTokenCount || 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
    raw: data,
  };
}

export function streamHandler(chunk) {
  try {
    const parsed = JSON.parse(chunk);
    const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
    return { content: text || null, done: false };
  } catch {
    return { content: null, done: false };
  }
}

export function buildUrl(baseUrl, modelId, stream) {
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  const modelPath = modelId.startsWith('models/') ? modelId : `models/${modelId}`;
  return `${baseUrl}/${modelPath}:${action}`;
}

export function buildAuth(provider, url) {
  const sep = url.includes('?') ? '&' : '?';
  return {
    headers: { 'Content-Type': 'application/json' },
    url: `${url}${sep}key=${encodeURIComponent(provider.api_key)}`,
  };
}
