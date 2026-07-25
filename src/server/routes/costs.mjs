import express from 'express';

/**
 * Token cost tracking routes.
 * Dependencies: stmts, authMiddleware
 * Pricing sourced from model-catalog.mjs (single source of truth).
 */

import { getModelCost } from '../llm/model-catalog.mjs';
export { getModelCost };

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
