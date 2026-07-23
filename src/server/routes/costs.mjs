import express from 'express';

/**
 * Token cost tracking routes.
 * Dependencies: stmts, authMiddleware
 * Exports: getModelCost (shared with chat/aimi/agent routes)
 */

// Per 1M tokens [input, output]
const MODEL_PRICING = {
  'gpt-4o': [2.50, 10.00], 'gpt-4o-mini': [0.15, 0.60], 'gpt-4-turbo': [10.00, 30.00],
  'claude-3.5-sonnet': [3.00, 15.00], 'claude-3-opus': [15.00, 75.00], 'claude-3-haiku': [0.25, 1.25],
  'llama-3.1-70b': [0.60, 0.80], 'llama-3.1-8b': [0.05, 0.07], 'mixtral-8x7b': [0.27, 0.27],
  'deepseek-chat': [0.14, 0.28], 'deepseek-reasoner': [0.55, 2.19],
  'grok-2': [2.00, 10.00], 'gemini-pro': [0.50, 1.50], 'gemini-flash': [0.075, 0.30],
};

export function getModelCost(modelId, promptTokens, completionTokens) {
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.includes(key)) return (promptTokens/1e6*pricing[0]) + (completionTokens/1e6*pricing[1]);
  }
  if (modelId.includes('local') || modelId.includes('ollama')) return 0;
  return (promptTokens/1e6*1) + (completionTokens/1e6*3);
}

export default function costsRoutes(ctx) {
  const { stmts, authMiddleware } = ctx;
  const router = express.Router();

  router.get('/costs', authMiddleware, (req, res) => {
    try {
      const { conversation_id, period = '-24 hours' } = req.query;
      if (conversation_id) { res.json(stmts.tokenUsage.getByConv.all(conversation_id)); }
      else { res.json(stmts.tokenUsage.getSummary.all(period)); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/costs/recent', authMiddleware, (_req, res) => {
    try { res.json(stmts.tokenUsage.getRecent.all()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
