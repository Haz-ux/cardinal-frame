import express from 'express';
import { randomUUID } from 'crypto';
import { executeSkillChain, executeToolChain, buildChainIntentPrompt } from '../chains.mjs';
import { SEED_SKILL_CHAINS, SEED_TOOL_CHAINS } from '../chain-seeds.mjs';

/**
 * Skill chain and tool chain endpoints: CRUD + execution + Aimi generation.
 * Dependencies: db, stmts, authMiddleware, requireRole, apiLimiter, broadcast,
 *   fireHook, callAgentLLM, PORT, executeSkill
 */
export default function chainsRoutes(ctx) {
  const {
    db,
    stmts,
    authMiddleware,
    requireRole,
    apiLimiter,
    broadcast,
    fireHook,
    callAgentLLM,
    PORT,
    executeSkill,
    checkPermission,
    auditLog,
  } = ctx;
  const router = express.Router();

  // ─── Skill Chain Endpoints ──────────────────────────────────────

  // GET /api/chains/skills — list all skill chains
  router.get('/chains/skills', authMiddleware, (_req, res) => {
    const chains = stmts.skillChains.getAll.all();
    for (const c of chains) c.steps = JSON.parse(c.steps || '[]');
    res.json(chains);
  });

  // GET /api/chains/skills/:id — get one
  router.get('/chains/skills/:id', authMiddleware, (req, res) => {
    const chain = stmts.skillChains.getById.get(req.params.id);
    if (!chain) return res.status(404).json({ error: 'Chain not found' });
    chain.steps = JSON.parse(chain.steps || '[]');
    chain.last_run_result = chain.last_run_result ? JSON.parse(chain.last_run_result) : null;
    res.json(chain);
  });

  // POST /api/chains/skills — create
  router.post('/chains/skills', authMiddleware, apiLimiter, (req, res) => {
    const { name, description, steps } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const existing = stmts.skillChains.getByName.get(name);
    if (existing) return res.status(409).json({ error: 'Chain name already exists' });
    const id = randomUUID();
    stmts.skillChains.insert.run(id, name, description || '', JSON.stringify(steps || []), 'draft', req.user?.id || null);
    res.json({ id, name, description, steps: steps || [], status: 'draft' });
  });

  // PUT /api/chains/skills/:id — update
  router.put('/chains/skills/:id', authMiddleware, (req, res) => {
    const existing = stmts.skillChains.getById.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Chain not found' });
    const { name, description, steps, status } = req.body;
    stmts.skillChains.update.run(
      name ?? existing.name,
      description ?? existing.description,
      JSON.stringify(steps ?? JSON.parse(existing.steps)),
      status ?? existing.status,
      req.params.id
    );
    const updated = stmts.skillChains.getById.get(req.params.id);
    updated.steps = JSON.parse(updated.steps || '[]');
    res.json(updated);
  });

  // DELETE /api/chains/skills/:id
  router.delete('/chains/skills/:id', authMiddleware, (req, res) => {
    if (!stmts.skillChains.getById.get(req.params.id)) return res.status(404).json({ error: 'Chain not found' });
    stmts.chainExecutions?.deleteByChain?.run(req.params.id);
    stmts.skillChains.delete.run(req.params.id);
    res.json({ ok: true });
  });

  // ─── Skill Chain Execution ────────────────────────────────────────

  // Reusable skill-chain runner — resolves the chain, enforces governance,
  // executes steps, records run history + evolution stats, and fires hooks.
  const runSkillChain = async (chainId, chainInput, req) => {
    const chain = stmts.skillChains.getById.get(chainId);
    if (!chain) { const e = new Error('Chain not found'); e.status = 404; throw e; }
    chain.steps = JSON.parse(chain.steps || '[]');

    // Build a skill lookup function for the executor
    const executeSkillFn = async (step, input) => {
      const skillName = step.skill_name;
      const skill = stmts.skills.getByName.get(skillName);
      if (!skill) throw new Error(`Skill "${skillName}" not found`);
      if (!skill.enabled) throw new Error(`Skill "${skillName}" is disabled`);
      stmts.skills.updateInvoke.run(skill.id);
      return await executeSkill(skill, input, req.id);
    };

    // Governance: build enforcement object
    const persona = stmts.governance?.personas.getById.get('persona-default') || null;
    const traceId = req.id;
    const governance = persona ? {
      persona,
      checkPermission,
      auditLog: (action, details) => auditLog(stmts, req.user?.username || 'system', action, null, details, traceId),
    } : null;

    const result = await executeSkillChain(chain, chainInput, executeSkillFn, broadcast, governance);
    stmts.skillChains.updateRunResult.run(JSON.stringify(result), result.ok ? 'completed' : 'failed', chainId);
    // Track run count for evolution
    try {
      db.prepare('UPDATE skill_chains SET run_count = COALESCE(run_count, 0) + 1, success_count = COALESCE(success_count, 0) + ? WHERE id = ?')
        .run(result.ok ? 1 : 0, chainId);
    } catch { /* columns may not exist on fresh DB */ }
    // Record real execution history for evolution promotion
    try {
      stmts.chainExecutions.insert.run(
        randomUUID(), chainId, result.ok ? 1 : 0, result.duration_ms || 0,
        JSON.stringify(chainInput ?? {}).slice(0, 4096),
        JSON.stringify(result.final_output ?? null).slice(0, 4096),
        result.results?.length || 0,
        result.ok ? null : String(result.results?.find(r => r.error)?.error || 'Unknown error').slice(0, 1024)
      );
    } catch (e) { console.error('[chain-exec] Failed to record execution:', e.message); }
    broadcast('chain:executed', { chainId, name: chain.name, ok: result.ok, type: 'skill' });
    fireHook('onSkillExecuted', { skillId: chainId, skillName: chain.name, input: chainInput, output: result.final_output, success: result.ok, durationMs: result.duration_ms });
    return result;
  };

  const executeSkillChainById = async (chainId, req) => {
    const chainInput = req.body.input ?? req.body;
    return runSkillChain(chainId, chainInput, req);
  };

  const executeSkillChainByName = async (name, req) => {
    const chain = stmts.skillChains.getByName.get(name);
    if (!chain) { const e = new Error('Chain not found'); e.status = 404; throw e; }
    // Strip the "name" field so it doesn't leak into the chain input.
    const chainInput = req.body.input ?? Object.fromEntries(Object.entries(req.body).filter(([k]) => k !== 'name'));
    return runSkillChain(chain.id, chainInput, req);
  };

  const routeChainError = (res, e) => res.status(e.status || 500).json({ error: e.message });

  // POST /api/chains/skills/:id/execute — run a skill chain by id
  router.post('/chains/skills/:id/execute', authMiddleware, apiLimiter, async (req, res) => {
    try { res.json(await executeSkillChainById(req.params.id, req)); }
    catch (e) { routeChainError(res, e); }
  });

  // POST /api/chains/skills/execute-by-name — run a skill chain by name (Aimi)
  router.post('/chains/skills/execute-by-name', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      res.json(await executeSkillChainByName(name, req));
    } catch (e) { routeChainError(res, e); }
  });

  // POST /api/chains/skills/generate — Aimi generates a chain from natural language
  router.post('/chains/skills/generate', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      const skills = stmts.skills.getAll.all().filter(s => s.enabled);
      const tools = stmts.tools.getAll.all().filter(t => t.enabled);
      const systemPrompt = buildChainIntentPrompt('skill', skills, tools);

      const result = await callAgentLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ], req.body.model);

      let chainDef;
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        chainDef = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
      } catch {
        return res.status(422).json({ error: 'Aimi could not generate a valid chain definition', raw: result.content.slice(0, 500) });
      }

      res.json({
        chain: chainDef,
        tokens: { prompt: result.promptTokens, completion: result.completionTokens },
        model: result.model,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Tool Chain Endpoints ────────────────────────────────────────

  // GET /api/chains/tools — list all
  router.get('/chains/tools', authMiddleware, (_req, res) => {
    const chains = stmts.toolChains.getAll.all();
    for (const c of chains) c.steps = JSON.parse(c.steps || '[]');
    res.json(chains);
  });

  // GET /api/chains/tools/:id
  router.get('/chains/tools/:id', authMiddleware, (req, res) => {
    const chain = stmts.toolChains.getById.get(req.params.id);
    if (!chain) return res.status(404).json({ error: 'Chain not found' });
    chain.steps = JSON.parse(chain.steps || '[]');
    chain.last_run_result = chain.last_run_result ? JSON.parse(chain.last_run_result) : null;
    res.json(chain);
  });

  // POST /api/chains/tools — create
  router.post('/chains/tools', authMiddleware, apiLimiter, (req, res) => {
    const { name, description, steps } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const existing = stmts.toolChains.getByName.get(name);
    if (existing) return res.status(409).json({ error: 'Chain name already exists' });
    const id = randomUUID();
    stmts.toolChains.insert.run(id, name, description || '', JSON.stringify(steps || []), 'draft', req.user?.id || null);
    res.json({ id, name, description, steps: steps || [], status: 'draft' });
  });

  // PUT /api/chains/tools/:id
  router.put('/chains/tools/:id', authMiddleware, (req, res) => {
    const existing = stmts.toolChains.getById.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Chain not found' });
    const { name, description, steps, status } = req.body;
    stmts.toolChains.update.run(
      name ?? existing.name,
      description ?? existing.description,
      JSON.stringify(steps ?? JSON.parse(existing.steps)),
      status ?? existing.status,
      req.params.id
    );
    const updated = stmts.toolChains.getById.get(req.params.id);
    updated.steps = JSON.parse(updated.steps || '[]');
    res.json(updated);
  });

  // DELETE /api/chains/tools/:id
  router.delete('/chains/tools/:id', authMiddleware, (req, res) => {
    if (!stmts.toolChains.getById.get(req.params.id)) return res.status(404).json({ error: 'Chain not found' });
    stmts.chainExecutions?.deleteByChain?.run(req.params.id);
    stmts.toolChains.delete.run(req.params.id);
    res.json({ ok: true });
  });

  // ─── Tool Chain Execution ─────────────────────────────────────────

  // Reusable tool-chain runner — executes HTTP steps against internal endpoints
  // and records run history.
  const runToolChain = async (chainId, chainInput, req) => {
    const chain = stmts.toolChains.getById.get(chainId);
    if (!chain) { const e = new Error('Chain not found'); e.status = 404; throw e; }
    chain.steps = JSON.parse(chain.steps || '[]');

    // Build tool call function — makes HTTP requests to internal endpoints
    const callToolFn = async (step, input) => {
      const tool = stmts.tools.getByName.get(step.tool_name);
      if (!tool) throw new Error(`Tool "${step.tool_name}" not found`);
      const method = step.method || tool.method || 'GET';
      const endpoint = step.endpoint || tool.endpoint;
      const url = `http://localhost:${PORT}${endpoint}`;

      const fetchOpts = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        },
      };
      if (method !== 'GET' && method !== 'HEAD') {
        fetchOpts.body = JSON.stringify(input || {});
      }

      const resp = await fetch(url, fetchOpts);
      const data = await resp.json();
      return data;
    };

    // Governance: build enforcement object
    const persona = stmts.governance?.personas.getById.get('persona-default') || null;
    const traceId = req.id;
    const governance = persona ? {
      persona,
      checkPermission,
      auditLog: (action, details) => auditLog(stmts, req.user?.username || 'system', action, null, details, traceId),
    } : null;

    const result = await executeToolChain(chain, chainInput, callToolFn, broadcast, governance);
    stmts.toolChains.updateRunResult.run(JSON.stringify(result), result.ok ? 'completed' : 'failed', chainId);
    broadcast('chain:executed', { chainId, name: chain.name, ok: result.ok, type: 'tool' });
    return result;
  };

  const executeToolChainById = async (chainId, req) => {
    const chainInput = req.body.input ?? req.body;
    return runToolChain(chainId, chainInput, req);
  };

  const executeToolChainByName = async (name, req) => {
    const chain = stmts.toolChains.getByName.get(name);
    if (!chain) { const e = new Error('Chain not found'); e.status = 404; throw e; }
    // Strip the "name" field so it doesn't leak into the chain input.
    const chainInput = req.body.input ?? Object.fromEntries(Object.entries(req.body).filter(([k]) => k !== 'name'));
    return runToolChain(chain.id, chainInput, req);
  };

  // POST /api/chains/tools/:id/execute — run a tool chain by id
  router.post('/chains/tools/:id/execute', authMiddleware, apiLimiter, async (req, res) => {
    try { res.json(await executeToolChainById(req.params.id, req)); }
    catch (e) { routeChainError(res, e); }
  });

  // POST /api/chains/tools/execute-by-name — run a tool chain by name (Aimi)
  router.post('/chains/tools/execute-by-name', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });
      res.json(await executeToolChainByName(name, req));
    } catch (e) { routeChainError(res, e); }
  });

  // POST /api/chains/tools/generate — Aimi generates a tool chain from natural language
  router.post('/chains/tools/generate', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      const skills = stmts.skills.getAll.all().filter(s => s.enabled);
      const tools = stmts.tools.getAll.all().filter(t => t.enabled);
      const systemPrompt = buildChainIntentPrompt('tool', skills, tools);

      const result = await callAgentLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ], req.body.model);

      let chainDef;
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        chainDef = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
      } catch {
        return res.status(422).json({ error: 'Aimi could not generate a valid chain definition', raw: result.content.slice(0, 500) });
      }

      res.json({
        chain: chainDef,
        tokens: { prompt: result.promptTokens, completion: result.completionTokens },
        model: result.model,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Seed Chain Library ─────────────────────────────────────────
  // Upserts the starter skill + tool chain templates so re-running is idempotent.
  router.post('/chains/seed', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const seedSkillChains = () => {
      const seeded = [], updated = [], skipped = [];
      for (const t of SEED_SKILL_CHAINS) {
        const steps = JSON.stringify(t.steps);
        const existing = stmts.skillChains.getByName.get(t.name);
        if (!existing) {
          stmts.skillChains.insert.run(randomUUID(), t.name, t.description, steps, 'template', req.user?.id || null);
          seeded.push(t.name);
        } else if (existing.steps !== steps || existing.description !== t.description || existing.status !== 'template') {
          stmts.skillChains.update.run(t.name, t.description, steps, 'template', existing.id);
          updated.push(t.name);
        } else {
          skipped.push(t.name);
        }
      }
      return { seeded, updated, skipped };
    };

    const seedToolChains = () => {
      const seeded = [], updated = [], skipped = [];
      for (const t of SEED_TOOL_CHAINS) {
        const steps = JSON.stringify(t.steps);
        const existing = stmts.toolChains.getByName.get(t.name);
        if (!existing) {
          stmts.toolChains.insert.run(randomUUID(), t.name, t.description, steps, 'template', req.user?.id || null);
          seeded.push(t.name);
        } else if (existing.steps !== steps || existing.description !== t.description || existing.status !== 'template') {
          stmts.toolChains.update.run(t.name, t.description, steps, 'template', existing.id);
          updated.push(t.name);
        } else {
          skipped.push(t.name);
        }
      }
      return { seeded, updated, skipped };
    };

    try {
      const skill = seedSkillChains();
      const tool = seedToolChains();
      auditLog(stmts, req.user?.username || 'system', 'seed', 'chains', { skill, tool }, req.id);
      broadcast('chains:seeded', { skill, tool });
      res.json({ skill, tool });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
