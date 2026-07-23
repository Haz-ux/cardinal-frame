import express from 'express';
import { randomUUID } from 'crypto';
import { SEED_SKILLS } from './seed-skills.mjs';

/**
 * Heartbeat routes: rules CRUD, state inspection, skill match, seed library.
 * Dependencies: db, stmts, authMiddleware, requireRole, apiLimiter, audit, broadcast, matchSkillTrigger
 */
export default function heartbeatRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter, audit, broadcast, matchSkillTrigger } = ctx;
  const router = express.Router();

  // ─── Heartbeat Rules ─────────────────────────────────────────────
  router.get('/heartbeat/rules', authMiddleware, (_req, res) => {
    res.json(stmts.heartbeat.getAll.all());
  });

  router.post('/heartbeat/rules', authMiddleware, requireRole('admin'), (req, res) => {
    const { name, description, condition, action_type, action_target, action_input, cooldown_seconds } = req.body;
    if (!name || !condition || !action_type || !action_target)
      return res.status(400).json({ error: 'name, condition, action_type, action_target required' });

    const validActions = ['chain', 'skill', 'alert', 'webhook'];
    if (!validActions.includes(action_type))
      return res.status(400).json({ error: `action_type must be one of: ${validActions.join(', ')}` });

    if (typeof condition !== 'string' || condition.includes('\n') || condition.includes('\r'))
      return res.status(400).json({ error: 'Condition must be a single-line expression' });

    const validStateRef = /^(agents|tasks|chains|skills|providers|schedules|messages)\.(total|active|stale|pending|running|failed|enabled)$/;
    const refs = condition.match(/\b\w+\.\w+\b/g) || [];
    for (const ref of refs) {
      if (!validStateRef.test(ref)) {
        return res.status(400).json({ error: `Unknown state reference "${ref}". Valid refs: agents.total, agents.active, agents.stale, tasks.pending, tasks.running, tasks.failed, chains.total, chains.failed, skills.total, skills.enabled, providers.total, providers.enabled, schedules.total, schedules.enabled, messages.pending` });
      }
    }
    const condStripped = condition
      .replace(/\b\w+\.\w+\b/g, '0')
      .replace(/\btrue\b/g, '1')
      .replace(/\bfalse\b/g, '0');
    if (/\b[a-zA-Z_]\w*\b/.test(condStripped)) {
      return res.status(400).json({ error: 'Condition contains invalid identifiers. Only state refs and comparison/boolean operators are allowed' });
    }
    if (!/^[\d\s<>=!&|().]+$/.test(condStripped)) {
      return res.status(400).json({ error: 'Condition contains invalid characters' });
    }

    const id = randomUUID();
    stmts.heartbeat.insert.run(id, name, description || '', condition, action_type, action_target,
      JSON.stringify(action_input || {}), cooldown_seconds || 300);
    res.json({ id, name, condition, action_type, action_target, enabled: 1 });
  });

  router.patch('/heartbeat/rules/:id/toggle', authMiddleware, (req, res) => {
    const rule = stmts.heartbeat.getById.get(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    stmts.heartbeat.updateEnabled.run(rule.enabled ? 0 : 1, req.params.id);
    res.json({ ok: true, enabled: !rule.enabled });
  });

  router.delete('/heartbeat/rules/:id', authMiddleware, (req, res) => {
    stmts.heartbeat.delete.run(req.params.id);
    res.json({ ok: true });
  });

  router.get('/heartbeat/state', authMiddleware, (_req, res) => {
    if (globalThis._heartbeat) {
      res.json(globalThis._heartbeat.collectState());
    } else {
      res.json({ error: 'Heartbeat not running' });
    }
  });

  // ─── Skill Match ─────────────────────────────────────────────────
  router.get('/skills/match/:input', authMiddleware, (req, res) => {
    try {
      const match = matchSkillTrigger(decodeURIComponent(req.params.input));
      if (!match) return res.json({ matched: false });
      res.json({
        matched: true,
        trigger: match.trigger,
        skill: {
          id: match.skill.id,
          name: match.skill.name,
          description: match.skill.description,
          category: match.skill.category,
          confidence: match.confidence,
          trigger: match.trigger,
        },
        should_auto_invoke: match.confidence >= 0.8,
        should_suggest: match.confidence >= 0.5 && match.confidence < 0.8,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Seed Skill Library ──────────────────────────────────────────
  router.post('/skills/seed', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const seeded = [];
      const skipped = [];

      for (const s of SEED_SKILLS) {
        const existing = stmts.skills.getByName.get(s.name);
        if (existing) { skipped.push(s.name); continue; }
        const id = randomUUID();
        stmts.skills.insertFull.run(
          id, s.name, s.description, s.category, s.handler,
          JSON.stringify(s.parameters || {}), 1, s.confidence || 0.5, 0,
          s.trigger || '', 1
        );
        seeded.push(s.name);
      }

      audit('seed', 'skills', null, req.user.id, { seeded: seeded.length, skipped: skipped.length });
      broadcast('skill:seeded', { seeded, skipped });

      // Seed chain templates
      const SEED_CHAIN_TEMPLATES = [
        {
          name: 'research-and-summarize',
          description: 'Research a topic and summarize the findings into a concise report',
          steps: [
            { skill_name: 'web-research', name: 'Research', input_mapping: { query: '$input' } },
            { skill_name: 'paper-summarize', name: 'Summarize', input_mapping: { text: '$prev.output' } },
          ],
        },
        {
          name: 'audit-and-report',
          description: 'Run deployment audit checks and generate an actionable report',
          steps: [
            { skill_name: 'deploy-check', name: 'Audit Deploy', input_mapping: { service: '$input' } },
            { skill_name: 'log-analyzer', name: 'Analyze Logs', input_mapping: { logs: '$prev.output' } },
            { skill_name: 'paper-summarize', name: 'Generate Report', input_mapping: { text: '$prev.output' } },
          ],
        },
        {
          name: 'build-and-deploy',
          description: 'Run build checks, execute build, and verify deployment health',
          steps: [
            { skill_name: 'code-linter', name: 'Lint Code', input_mapping: { path: '$input' } },
            { skill_name: 'deploy-check', name: 'Deploy & Check', input_mapping: { service: '$prev.output' } },
          ],
        },
        {
          name: 'monitor-and-respond',
          description: 'Check system health and auto-respond to issues with corrective actions',
          steps: [
            { skill_name: 'monitor-check', name: 'Monitor', input_mapping: {} },
            { skill_name: 'incident-responder', name: 'Respond', input_mapping: { alerts: '$prev.output' } },
          ],
        },
        {
          name: 'research-to-landing-page',
          description: 'Research a product topic and generate a landing page from findings',
          steps: [
            { skill_name: 'web-research', name: 'Research Topic', input_mapping: { query: '$input' } },
            { skill_name: 'paper-summarize', name: 'Extract Key Points', input_mapping: { text: '$prev.output' } },
            { skill_name: 'landing-page-generator', name: 'Generate Landing Page', input_mapping: { product: '$prev.output' } },
          ],
        },
      ];

      let chainsSeeded = 0;
      for (const tmpl of SEED_CHAIN_TEMPLATES) {
        const existing = stmts.skillChains.getByName.get(tmpl.name);
        if (existing) continue;
        const id = randomUUID();
        stmts.skillChains.insert.run(id, tmpl.name, tmpl.description, JSON.stringify(tmpl.steps), 'template', req.user?.id || null);
        chainsSeeded++;
      }

      res.json({ seeded, skipped, chains_seeded: chainsSeeded, total_seeded: seeded.length, total_skipped: skipped.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
