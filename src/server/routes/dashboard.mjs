import express from 'express';

/**
 * Dashboard & telemetry routes: /api/telemetry, /api/dashboard/{summary,usage,cost-series,activity-series}
 *
 * Extracted from server.mjs (lines 1434-1571). Business logic is preserved verbatim;
 * only the Express routing wrapper changed (app.get(...) → router.get(...)).
 *
 * Mount point: app.use('/', dashboardRoutes(ctx));
 *   - GET  /api/telemetry
 *   - GET  /api/dashboard/summary
 *   - GET  /api/dashboard/usage            (authMiddleware)
 *   - GET  /api/dashboard/cost-series       (authMiddleware)
 *   - GET  /api/dashboard/activity-series   (authMiddleware)
 *
 * Required ctx fields:
 *   db              - better-sqlite3 database instance (for inline prepared queries)
 *   stmts           - { dashboard: { agentCount, taskCount, runningTasks, pendingTasks,
 *                                    dagCount, realUsers, providerCount, modelCount, tokenUsage },
 *                       models: { getDefault } }
 *   wss             - WebSocketServer instance (reads wss.clients.size)
 *   authMiddleware  - JWT auth guard applied to all /api/dashboard/* routes
 *
 * Optional ctx fields:
 *   apiLimiter        - rate limiter (reserved for future use; not applied in original logic)
 *   logger            - logger instance
 *   telemetryCache    - last-collected telemetry object (fallback when collectTelemetry unavailable)
 *   deviceStateCache  - reserved (present in ctx for sibling modules; not used by these routes)
 *   collectTelemetry  - async () => telemetry payload; original /api/telemetry handler calls this
 *                       directly. When not provided via ctx (e.g. the function still lives in
 *                       server.mjs during incremental refactor), the handler falls back to
 *                       returning telemetryCache so the endpoint stays functional.
 */
export default function dashboardRoutes(ctx) {
  const {
    db,
    stmts,
    wss,
    logger,
    authMiddleware,
    optionalAuth,
    apiLimiter,
  } = ctx;

  const router = express.Router();

  // ─── Telemetry (system metrics for the dashboard) ───────────────
  router.get('/telemetry', optionalAuth, async (_req, res) => {
    const t = typeof ctx.collectTelemetry === 'function'
      ? await ctx.collectTelemetry()
      : ctx.telemetryCache;
    res.json(t);
  });

  // ─── Dashboard summary (top-level counts + live WS clients) ────
  router.get('/dashboard/summary', optionalAuth, (_req, res) => {
    const agentCount = stmts.dashboard.agentCount.get().c;
    const taskCount = stmts.dashboard.taskCount.get().c;
    const runningTasks = stmts.dashboard.runningTasks.get().c;
    const pendingTasks = stmts.dashboard.pendingTasks.get().c;
    const dagCount = stmts.dashboard.dagCount.get().c;
    const userCount = stmts.dashboard.realUsers.get().c;
    const providerCount = stmts.dashboard.providerCount.get().c;
    const modelCount = stmts.dashboard.modelCount.get().c;
    const defaultModel = stmts.models.getDefault.get();
    res.json({
      activeAgents: agentCount,
      totalTasks: taskCount,
      runningTasks,
      pendingTasks,
      totalDags: dagCount,
      totalUsers: userCount,
      totalProviders: providerCount,
      totalModels: modelCount,
      defaultModel: defaultModel ? { id: defaultModel.id, model_id: defaultModel.model_id, display_name: defaultModel.display_name } : null,
      wsClients: wss.clients.size,
      cpuLoad: '35%',
      npuUtilization: '68%',
      uptimeHours: Math.floor(process.uptime() / 3600),
    });
  });

  // ─── Dashboard token usage / cost tracking ──────────────────────
  router.get('/dashboard/usage', authMiddleware, (_req, res) => {
    try {
      const row = stmts.dashboard.tokenUsage.get();
      const promptTokens = row.pt || 0;
      const completionTokens = row.ct || 0;
      const totalTokens = promptTokens + completionTokens;
      // Prefer actual stored cost; fall back to rough estimate (per 1M tokens:
      // prompt ~$3, completion ~$15 — GPT-4 tier average) for older records.
      const storedCost = row.cost_usd || 0;
      const totalCost = storedCost > 0
        ? storedCost
        : (promptTokens / 1_000_000) * 3 + (completionTokens / 1_000_000) * 15;
      res.json({ promptTokens, completionTokens, totalTokens, totalCost: Math.round(totalCost * 10000) / 10000 });
    } catch {
      res.json({ promptTokens: 0, completionTokens: 0, totalTokens: 0, totalCost: 0 });
    }
  });

  // ─── Cost time-series for sparklines ─────────────────────────────
  router.get('/dashboard/cost-series', authMiddleware, (req, res) => {
    try {
      const hours = Math.min(parseInt(req.query.hours) || 24, 168);
      // Group token_usage into hourly buckets
      const rows = db.prepare(`
        SELECT
          strftime('%Y-%m-%d %H:00', created_at) as hour,
          SUM(prompt_tokens) as prompt,
          SUM(completion_tokens) as completion,
          SUM(cost_usd) as cost,
          COUNT(*) as calls
        FROM token_usage
        WHERE created_at > datetime('now', ?)
        GROUP BY hour
        ORDER BY hour ASC
      `).all(`-${hours} hours`);

      // Fill gaps with zero buckets for continuous sparkline
      const now = new Date();
      const buckets = [];
      for (let i = hours; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 3600000);
        const key = d.toISOString().slice(0, 13).replace('T', ' ') + ':00'; // space format matches strftime('%Y-%m-%d %H:00')
        const found = rows.find(r => r.hour === key);
        buckets.push({
          hour: key,
          prompt: found?.prompt || 0,
          completion: found?.completion || 0,
          cost: found?.cost || 0,
          calls: found?.calls || 0,
        });
      }

      const totals = buckets.reduce((acc, b) => ({
        prompt: acc.prompt + b.prompt,
        completion: acc.completion + b.completion,
        cost: acc.cost + b.cost,
        calls: acc.calls + b.calls,
      }), { prompt: 0, completion: 0, cost: 0, calls: 0 });

      res.json({ buckets, totals });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Agent activity time-series for sparklines ──────────────────
  router.get('/dashboard/activity-series', authMiddleware, (req, res) => {
    try {
      const hours = Math.min(parseInt(req.query.hours) || 24, 168);
      const tasks = db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as count
        FROM tasks
        WHERE created_at > datetime('now', ?)
        GROUP BY hour ORDER BY hour ASC
      `).all(`-${hours} hours`);

      const agentActions = db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as count
        FROM agent_actions
        WHERE created_at > datetime('now', ?)
        GROUP BY hour ORDER BY hour ASC
      `).all(`-${hours} hours`);

      const messages = db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as count
        FROM chat_messages
        WHERE created_at > datetime('now', ?)
        GROUP BY hour ORDER BY hour ASC
      `).all(`-${hours} hours`);

      // Fill buckets
      const now = new Date();
      const buckets = [];
      for (let i = hours; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 3600000);
        const key = d.toISOString().slice(0, 13).replace('T', ' ') + ':00'; // space format matches strftime('%Y-%m-%d %H:00')
        buckets.push({
          hour: key,
          tasks: tasks.find(t => t.hour === key)?.count || 0,
          agentActions: agentActions.find(a => a.hour === key)?.count || 0,
          messages: messages.find(m => m.hour === key)?.count || 0,
        });
      }

      res.json({ buckets });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
