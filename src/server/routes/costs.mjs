import express from 'express';

/**
 * Token cost tracking routes.
 * Dependencies: stmts, authMiddleware
 * Exports: getModelCost (shared with chat/aimi/agent routes)
 */

// Per 1M tokens [input, output]
const MODEL_PRICING = {
  // OpenAI
  'gpt-4o': [2.50, 10.00], 'gpt-4o-mini': [0.15, 0.60], 'gpt-4-turbo': [10.00, 30.00],
  'o1': [15.00, 60.00], 'o1-mini': [3.00, 12.00], 'o3-mini': [3.00, 12.00],
  // Anthropic
  'claude-3.5-sonnet': [3.00, 15.00], 'claude-3-opus': [15.00, 75.00], 'claude-3-haiku': [0.25, 1.25],
  'claude-3.7-sonnet': [3.00, 15.00], 'claude-3-5-haiku': [0.80, 4.00],
  // Meta
  'llama-3.1-70b': [0.60, 0.80], 'llama-3.1-8b': [0.05, 0.07], 'llama-3.3-70b': [0.60, 0.80],
  // Mistral
  'mixtral-8x7b': [0.27, 0.27], 'mixtral-8x22b': [1.20, 1.20],
  // DeepSeek
  'deepseek-chat': [0.14, 0.28], 'deepseek-reasoner': [0.55, 2.19],
  // xAI
  'grok-2': [2.00, 10.00], 'grok-3': [3.00, 15.00], 'grok-3-mini': [0.60, 3.00],
  // Google
  'gemini-pro': [0.50, 1.50], 'gemini-flash': [0.075, 0.30], 'gemini-1.5-pro': [1.25, 5.00], 'gemini-1.5-flash': [0.075, 0.30],
  // NVIDIA NIM
  'nemotron': [0.20, 0.40], 'glm-5': [0.10, 0.30],
  // Groq
  'gemma2-9b': [0.10, 0.10],
};

export function getModelCost(modelId, promptTokens, completionTokens) {
  // Sort keys by descending length so more specific matches win
  // (e.g. 'gpt-4o-mini' matches before 'gpt-4o')
  const sortedKeys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (modelId.includes(key)) return (promptTokens/1e6*MODEL_PRICING[key][0]) + (completionTokens/1e6*MODEL_PRICING[key][1]);
  }
  if (modelId.includes('local') || modelId.includes('ollama')) return 0;
  return (promptTokens/1e6*1) + (completionTokens/1e6*3);
}

export default function costsRoutes(ctx) {
  const { stmts, authMiddleware, logger, broadcast } = ctx;
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

  // GET /costs/budget — check spend against configurable budget
  router.get('/costs/budget', authMiddleware, (req, res) => {
    try {
      const period = req.query.period || '-24 hours';
      const budgetUsd = parseFloat(process.env.COST_BUDGET_USD || '0'); // 0 = no budget

      const rows = stmts.tokenUsage.getSummary.all(period);
      const totalCost = rows.reduce((sum, r) => sum + (r.total_cost || 0), 0);
      const totalTokens = rows.reduce((sum, r) => sum + (r.total_prompt || 0) + (r.total_completion || 0), 0);

      const result = {
        period,
        budget_usd: budgetUsd,
        spent_usd: parseFloat(totalCost.toFixed(6)),
        remaining_usd: budgetUsd > 0 ? parseFloat((budgetUsd - totalCost).toFixed(6)) : null,
        utilization: budgetUsd > 0 ? parseFloat((totalCost / budgetUsd * 100).toFixed(1)) : 0,
        total_tokens: totalTokens,
        by_category: rows,
        alert: budgetUsd > 0 && totalCost >= budgetUsd * 0.8,
        alert_threshold: budgetUsd > 0 ? parseFloat((budgetUsd * 0.8).toFixed(6)) : null,
      };

      // Emit WebSocket alert if we crossed 80% threshold
      if (result.alert && broadcast) {
        broadcast('cost:alert', result);
      }

      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
