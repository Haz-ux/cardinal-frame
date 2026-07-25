/**
 * Cardinal Frame — Model Catalog
 *
 * Single source of truth for model metadata: context length, cost/token,
 * capability flags. Replaces the hardcoded MODEL_PRICING in costs.mjs.
 *
 * Adding a new model = add one entry here. No changes to provider-runtime
 * or any route file.
 */

// Per 1M tokens [input, output]
const CATALOG = {
  // ── OpenAI ──────────────────────────────────────────────────────
  'gpt-4o':               { contextWindow: 128_000, cost: [2.50, 10.00],   caps: ['vision', 'tools', 'json'] },
  'gpt-4o-mini':          { contextWindow: 128_000, cost: [0.15, 0.60],     caps: ['vision', 'tools', 'json'] },
  'gpt-4-turbo':          { contextWindow: 128_000, cost: [10.00, 30.00],   caps: ['vision', 'tools', 'json'] },
  'o1':                   { contextWindow: 200_000, cost: [15.00, 60.00],   caps: ['reasoning', 'tools'] },
  'o1-mini':              { contextWindow: 128_000, cost: [3.00, 12.00],     caps: ['reasoning'] },
  'o3-mini':              { contextWindow: 200_000, cost: [3.00, 12.00],     caps: ['reasoning', 'tools'] },
  // ── Anthropic ───────────────────────────────────────────────────
  'claude-3.5-sonnet':    { contextWindow: 200_000, cost: [3.00, 15.00],     caps: ['vision', 'tools', 'json'] },
  'claude-3-opus':        { contextWindow: 200_000, cost: [15.00, 75.00],    caps: ['vision', 'tools'] },
  'claude-3-haiku':       { contextWindow: 200_000, cost: [0.25, 1.25],      caps: ['vision', 'tools'] },
  'claude-3.7-sonnet':    { contextWindow: 200_000, cost: [3.00, 15.00],     caps: ['vision', 'tools', 'json'] },
  'claude-3-5-haiku':     { contextWindow: 200_000, cost: [0.80, 4.00],      caps: ['vision', 'tools'] },
  // ── Meta ────────────────────────────────────────────────────────
  'llama-3.1-70b':        { contextWindow: 128_000, cost: [0.60, 0.80],      caps: ['tools'] },
  'llama-3.1-8b':         { contextWindow: 128_000, cost: [0.05, 0.07],      caps: [] },
  'llama-3.3-70b':        { contextWindow: 128_000, cost: [0.60, 0.80],      caps: ['tools'] },
  // ── Mistral ─────────────────────────────────────────────────────
  'mixtral-8x7b':         { contextWindow: 32_000,  cost: [0.27, 0.27],      caps: ['tools'] },
  'mixtral-8x22b':        { contextWindow: 65_000,  cost: [1.20, 1.20],     caps: ['tools'] },
  // ── DeepSeek ────────────────────────────────────────────────────
  'deepseek-chat':        { contextWindow: 64_000,  cost: [0.14, 0.28],      caps: ['tools'] },
  'deepseek-reasoner':    { contextWindow: 64_000,  cost: [0.55, 2.19],     caps: ['reasoning'] },
  // ── xAI ─────────────────────────────────────────────────────────
  'grok-2':               { contextWindow: 128_000, cost: [2.00, 10.00],      caps: ['tools'] },
  'grok-3':               { contextWindow: 128_000, cost: [3.00, 15.00],     caps: ['tools'] },
  'grok-3-mini':          { contextWindow: 128_000, cost: [0.60, 3.00],      caps: ['reasoning'] },
  // ── Google ──────────────────────────────────────────────────────
  'gemini-pro':           { contextWindow: 32_000,  cost: [0.50, 1.50],      caps: ['vision'] },
  'gemini-flash':         { contextWindow: 1_000_000, cost: [0.075, 0.30],   caps: ['vision'] },
  'gemini-1.5-pro':       { contextWindow: 2_000_000, cost: [1.25, 5.00],    caps: ['vision', 'tools', 'json'] },
  'gemini-1.5-flash':     { contextWindow: 1_000_000, cost: [0.075, 0.30],   caps: ['vision', 'tools'] },
  // ── NVIDIA NIM ───────────────────────────────────────────────────
  'nemotron':             { contextWindow: 128_000, cost: [0.20, 0.40],      caps: ['tools'] },
  'glm-5':                { contextWindow: 128_000, cost: [0.10, 0.30],      caps: ['tools'] },
  // ── Groq ────────────────────────────────────────────────────────
  'gemma2-9b':            { contextWindow: 8_000,   cost: [0.10, 0.10],     caps: [] },
};

// ── Public API ─────────────────────────────────────────────────────

/**
 * Look up model metadata by modelId (fuzzy: longest-prefix match).
 * Returns { contextWindow, cost: [inPerM, outPerM], caps: string[] } or null.
 */
export function getModelMeta(modelId) {
  if (!modelId) return null;
  // Exact match first
  if (CATALOG[modelId]) return CATALOG[modelId];
  // Longest-prefix match (same behavior as costs.mjs's sorted-key lookup)
  const sortedKeys = Object.keys(CATALOG).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (modelId.includes(key)) return CATALOG[key];
  }
  return null;
}

/**
 * Get cost for a model given token counts.
 * Falls back to [1, 3] per 1M for unknown non-local models.
 * Local/ollama models are always 0.
 */
export function getModelCost(modelId, promptTokens, completionTokens) {
  if (!modelId) return 0;
  if (modelId.includes('local') || modelId.includes('ollama')) return 0;
  const meta = getModelMeta(modelId);
  if (meta) {
    return (promptTokens / 1e6 * meta.cost[0]) + (completionTokens / 1e6 * meta.cost[1]);
  }
  // Unknown model — default pricing
  return (promptTokens / 1e6 * 1) + (completionTokens / 1e6 * 3);
}

/**
 * Get context window for a model (returns 0 if unknown).
 */
export function getContextWindow(modelId) {
  return getModelMeta(modelId)?.contextWindow ?? 0;
}

/**
 * Check if a model has a capability.
 */
export function hasCapability(modelId, cap) {
  const meta = getModelMeta(modelId);
  return meta?.caps?.includes(cap) ?? false;
}

/**
 * List all known model IDs.
 */
export function listKnownModels() {
  return Object.keys(CATALOG);
}
