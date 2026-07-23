// ─── LLM Helpers (shared by chat, llm, aimi, agent routes) ──────────

export const PROVIDER_TYPES = {
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelsUrl: '/models', chatFormat: 'openai' },
  google: { name: 'Google AI', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelsUrl: '/models', chatFormat: 'google' },
  nvidia: { name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', modelsUrl: '/models', chatFormat: 'openai' },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', modelsUrl: null, chatFormat: 'anthropic', hardcodedModels: ['claude-sonnet-4-20250514','claude-opus-4-20250514','claude-3.5-sonnet-20241022','claude-3.5-haiku-20241022','claude-3-opus-20240229','claude-3-haiku-20240307'] },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelsUrl: '/models', chatFormat: 'openai' },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', modelsUrl: '/models', chatFormat: 'openai' },
  together: { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', modelsUrl: '/models', chatFormat: 'openai' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelsUrl: '/models', chatFormat: 'openai' },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', modelsUrl: '/models', chatFormat: 'openai' },
  cerebras: { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', modelsUrl: '/models', chatFormat: 'openai' },
  sambanova: { name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', modelsUrl: '/models', chatFormat: 'openai' },
  perplexity: { name: 'Perplexity', baseUrl: 'https://api.perplexity.ai', modelsUrl: '/models', chatFormat: 'openai' },
  xai: { name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', modelsUrl: '/models', chatFormat: 'openai' },
  cohere: { name: 'Cohere', baseUrl: 'https://api.cohere.com/v2', modelsUrl: '/models', chatFormat: 'openai' },
  ollama: { name: 'Ollama (Local)', baseUrl: 'http://localhost:11434', modelsUrl: '/api/tags', noKey: true, chatFormat: 'ollama' },
};

export function buildProviderAuth(provider, url) {
  const type = provider.type;
  const key = provider.api_key;
  if (type === 'ollama') {
    return { headers: { 'Content-Type': 'application/json' }, url };
  }
  if (type === 'google') {
    const sep = url.includes('?') ? '&' : '?';
    return { headers: { 'Content-Type': 'application/json' }, url: `${url}${sep}key=${encodeURIComponent(key)}` };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (type === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${key}`;
  }
  if (type === 'openrouter') {
    headers['HTTP-Referer'] = 'https://cardinal-frame.local';
  }
  return { headers, url };
}

export function buildChatUrl(baseUrl, providerType, modelId, stream = false) {
  if (providerType === 'ollama') return `${baseUrl}/api/chat`;
  if (providerType === 'google') {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const modelPath = modelId.startsWith('models/') ? modelId : `models/${modelId}`;
    return `${baseUrl}/${modelPath}:${action}`;
  }
  if (providerType === 'anthropic') return `${baseUrl}/messages`;
  return `${baseUrl}/chat/completions`;
}

export function buildChatPayload(providerType, modelId, messages, stream = false) {
  if (providerType === 'ollama') {
    return { model: modelId, messages: messages.map(m => ({ role: m.role, content: m.content })), stream };
  }
  if (providerType === 'google') {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));
    return { contents, generationConfig: {}, ...(stream ? {} : {}) };
  }
  if (providerType === 'anthropic') {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));
    return {
      model: modelId,
      messages: chatMsgs,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      max_tokens: 4096,
      stream,
    };
  }
  return {
    model: modelId,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    max_tokens: 4096,
    stream,
  };
}

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
