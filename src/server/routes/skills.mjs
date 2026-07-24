import express from 'express';
import { randomUUID } from 'crypto';
import { runSandboxed, runSandboxedHybrid } from './sandbox.mjs';

/**
 * Skills API routes + shared skill execution engine.
 * Dependencies (passed via ctx): db, stmts, authMiddleware, optionalAuth,
 *   requireRole, apiLimiter, audit, broadcast, fireHook, callAgentLLM,
 *   getDevSetting, randomUUID
 *
 * Named exports used elsewhere in the server:
 *   - collectSkillSecrets(skill)
 *   - executeSkill(skill, input)
 *   - matchSkillTrigger(userInput)
 *
 * These named functions need ctx-bound values (db, callAgentLLM, fireHook,
 * stmts, getDevSetting, runSandboxed, runSandboxedHybrid). They read them
 * from the module-level `deps` object, which the default factory populates on
 * first invocation. Importing code must mount this route module (i.e. call the
 * default export) once before calling the named exports.
 */

let deps = null;

// ─── Skill Secret Collection ──────────────────────────────────────
// Whitelisted env var names that skills can access via `secrets.<key>`
export const SKILL_SECRET_KEYS = new Set([
  'TAVILY_API_KEY',
  'SHOPIFY_SHOP_DOMAIN',
  'SHOPIFY_ACCESS_TOKEN',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NVIDIA_API_KEY',
  'OPENROUTER_API_KEY',
  'GITHUB_TOKEN',
  'STRIPE_SECRET_KEY',
  'FIGMA_API_TOKEN',
]);

export function collectSkillSecrets(skill) {
  const secrets = {};
  for (const key of SKILL_SECRET_KEYS) {
    if (process.env[key]) secrets[key] = process.env[key];
  }
  // Also allow skill-specific secrets declared in skill.parameters.secrets array
  try {
    const params = typeof skill.parameters === 'string' ? JSON.parse(skill.parameters) : (skill.parameters || {});
    const extraKeys = params.secrets || [];
    for (const key of extraKeys) {
      if (process.env[key]) secrets[key] = process.env[key];
    }
  } catch {}
  return secrets;
}

/**
 * Execute a skill by evaluating its handler function.
 * Skills are JS function strings: async (input) => { ... return result; }
 * Supports three skill types:
 * 1. Script skills: pure JS function, returns directly
 * 2. Template skills: handler starts with "template:" — uses LLM with the template as system prompt
 * 3. Hybrid skills: handler starts with "hybrid:" — runs JS that can call LLM
 */
export async function executeSkill(skill, input = {}, traceId = null) {
  if (!deps) throw new Error('executeSkill: skills route module not initialized (call default export first)');
  const {
    db,
    stmts,
    callAgentLLM,
    fireHook,
    getDevSetting,
    runSandboxed: sb,
    runSandboxedHybrid: sbHybrid,
  } = deps;

  const handlerStr = skill.handler || '';
  const startTime = Date.now();
  let result;

  try {
    // Template skill — LLM prompt template
    if (handlerStr.startsWith('template:')) {
      const template = handlerStr.slice('template:'.length).trim();
      const llmResult = await callAgentLLM([
        { role: 'system', content: template },
        { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
      ], skill.model || undefined);
      result = {
        ok: true,
        type: 'template',
        output: llmResult.content,
        tokens: { prompt: llmResult.promptTokens, completion: llmResult.completionTokens },
        duration_ms: Date.now() - startTime,
      };
    } else if (handlerStr.startsWith('hybrid:')) {
      // Hybrid skill — JS function that can call LLM and use execSync/fetch
      const code = handlerStr.slice('hybrid:'.length).trim();
      const llmCall = (messages, model) => callAgentLLM(messages, model || skill.model || undefined);
      const secrets = collectSkillSecrets(skill);
      const sandboxTimeoutMs = parseInt(getDevSetting(db, 'sandboxTimeout', '30'), 10) * 1000;
      const { result: sandboxResult } = await sbHybrid({ code, input, llmCall, secrets, timeoutMs: sandboxTimeoutMs });
      result = { ok: true, type: 'hybrid', output: sandboxResult, duration_ms: Date.now() - startTime };
    } else {
      // Script skill — pure JS function (sandboxed via vm.runInNewContext)
      const secrets = collectSkillSecrets(skill);
      const sandboxTimeoutMs = parseInt(getDevSetting(db, 'sandboxTimeout', '30'), 10) * 1000;
      const { result: sandboxResult } = await sb({ code: handlerStr, input, secrets, timeoutMs: sandboxTimeoutMs });
      result = { ok: true, type: 'script', output: sandboxResult, duration_ms: Date.now() - startTime };
    }
  } catch (err) {
    result = { ok: false, error: err.message, duration_ms: Date.now() - startTime };
  }

  // Fire onSkillExecuted hook
  fireHook('onSkillExecuted', {
    skillId: skill.id,
    skillName: skill.name,
    input,
    output: result.output || result.error,
    success: result.ok,
    durationMs: result.duration_ms,
  });

  // Log invocation to skill_invocations table for outcome tracking + failure-rate signal
  try {
    stmts.skillInvocations.insert.run(
      skill.id,
      skill.name,
      traceId,
      result.ok ? 1 : 0,
      result.duration_ms ?? null,
      result.type || null,
      result.ok ? null : (result.error || 'unknown error'),
    );
  } catch (logErr) {
    // Non-fatal — don't fail the skill execution if logging fails
    console.error('[skill-invocations] Failed to log:', logErr.message);
  }

  return result;
}

/**
 * Check if user input matches a skill trigger.
 * Triggers are comma-separated keywords/phrases.
 * Returns matched skill or null.
 */
export function matchSkillTrigger(userInput) {
  if (!deps) throw new Error('matchSkillTrigger: skills route module not initialized (call default export first)');
  const { stmts } = deps;
  if (!userInput || typeof userInput !== 'string') return null;
  const inputLower = userInput.toLowerCase();
  const skills = stmts.skills.getAllWithTrigger.all();

  for (const skill of skills) {
    const triggers = (skill.trigger || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    for (const trigger of triggers) {
      if (inputLower.includes(trigger)) {
        // Check confidence threshold
        const confidence = skill.confidence || 0.5;
        return { skill, trigger, confidence };
      }
    }
  }
  return null;
}

export default function skillsRoutes(ctx) {
  const {
    db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter,
    audit, broadcast, fireHook, callAgentLLM, getDevSetting,
  } = ctx;

  // Populate module-level deps so the named exports work when imported
  // elsewhere in the server. Prefer ctx-provided runSandboxed* (if present)
  // over the bundled sandbox.mjs import, to keep a single source of truth.
  deps = {
    db,
    stmts,
    fireHook,
    callAgentLLM,
    getDevSetting,
    runSandboxed: ctx.runSandboxed || runSandboxed,
    runSandboxedHybrid: ctx.runSandboxedHybrid || runSandboxedHybrid,
  };

  const router = express.Router();

  // ─── Skill Invocation Stats ──────────────────────────────────
  // GET /api/skills/stats/invocations — failure-rate signal for dashboard
  router.get('/skills/stats/invocations', authMiddleware, (req, res) => {
    const window = req.query.window || '-7 days';
    try {
      const stats = stmts.skillInvocations.getStats.all(window);
      res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/skills/:id/invocations — recent invocations for a skill
  router.get('/skills/:id/invocations', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit || '20', 10);
    try {
      const invocations = stmts.skillInvocations.getBySkill.all(req.params.id, limit);
      res.json(invocations);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/skills/invocations/recent — recent invocations across all skills
  router.get('/skills/invocations/recent', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit || '50', 10);
    try {
      const invocations = stmts.skillInvocations.getRecent.all(limit);
      res.json(invocations);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Skills CRUD ──────────────────────────────────────────────
  router.get('/skills', optionalAuth, (_req, res) => {
    res.json(stmts.skills.getAll.all());
  });

  router.get('/skills/enabled', optionalAuth, (_req, res) => {
    res.json(stmts.skills.getEnabled.all());
  });

  router.get('/skills/:id', optionalAuth, (req, res) => {
    const skill = stmts.skills.getById.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json(skill);
  });

  router.post('/skills', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { name, description, category, handler, parameters, enabled, trigger } = req.body;
    if (!name || !handler) return res.status(400).json({ error: 'name and handler required' });
    const existing = stmts.skills.getByName.get(name);
    if (existing) return res.status(409).json({ error: 'Skill already exists' });
    const id = randomUUID();
    stmts.skills.insertWithTrigger.run(id, name, description || '', category || 'general', handler, JSON.stringify(parameters || {}), enabled !== false ? 1 : 0, trigger || '');
    audit('create', 'skill', id, req.user.id, { name, category });
    res.status(201).json({ id, name });
  });

  router.put('/skills/:id', authMiddleware, requireRole('admin'), (req, res) => {
    const skill = stmts.skills.getById.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    const { description, category, parameters, enabled } = req.body;
    stmts.skills.update.run(description ?? skill.description, category ?? skill.category, JSON.stringify(parameters ?? JSON.parse(skill.parameters)), enabled !== undefined ? (enabled ? 1 : 0) : skill.enabled, req.params.id);
    res.json({ ok: true });
  });

  router.delete('/skills/:id', authMiddleware, requireRole('admin'), (req, res) => {
    const skill = stmts.skills.getById.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    stmts.skills.delete.run(req.params.id);
    audit('delete', 'skill', req.params.id, req.user.id, { name: skill.name });
    res.json({ ok: true });
  });

  // ─── Skill Execution ──────────────────────────────────────────
  // POST /api/skills/:id/execute — execute a skill with input
  router.post('/skills/:id/execute', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const skill = stmts.skills.getById.get(req.params.id);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      if (!skill.enabled) return res.status(400).json({ error: 'Skill is disabled' });

      const input = req.body.input ?? req.body;
      const result = await executeSkill(skill, input, req.id);

      // Update invoke tracking
      stmts.skills.updateInvoke.run(skill.id);

      // Update confidence based on result
      const newSuccess = skill.success_count + (result.ok ? 1 : 0);
      const newFailure = skill.failure_count + (result.ok ? 0 : 1);
      const total = newSuccess + newFailure;
      const newConfidence = total > 0 ? Math.round((newSuccess / total) * 100) / 100 : skill.confidence;
      stmts.skills.updateConfidence.run(newConfidence, newSuccess, newFailure, skill.id);

      broadcast('skill:executed', { skill_id: skill.id, name: skill.name, ok: result.ok, duration_ms: result.duration_ms });
      res.json({ skill_id: skill.id, name: skill.name, ...result, confidence: newConfidence });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/skills/execute/:name — execute by name (convenience)
  router.post('/skills/execute/:name', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const skill = stmts.skills.getByName.get(req.params.name);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      const input = req.body.input ?? req.body;
      const result = await executeSkill(skill, input, req.id);
      stmts.skills.updateInvoke.run(skill.id);
      res.json({ skill_id: skill.id, name: skill.name, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
