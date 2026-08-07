import express from 'express';
import { randomUUID } from 'crypto';
import { SEED_SKILLS } from './seed-skills.mjs';
import { SEED_SKILL_CHAINS, SEED_TOOL_CHAINS } from '../chain-seeds.mjs';

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

      // Seed chain templates (shared source of truth) — skill chains + tool chains
      const seedChains = (stmts_, list, insertStmt) => {
        let seeded = 0, updated = 0;
        for (const tmpl of list) {
          const steps = JSON.stringify(tmpl.steps);
          const existing = stmts_.getByName.get(tmpl.name);
          if (!existing) {
            insertStmt.run(randomUUID(), tmpl.name, tmpl.description, steps, 'template', req.user?.id || null);
            seeded++;
          } else if (existing.steps !== steps || existing.description !== tmpl.description || existing.status !== 'template') {
            stmts_.update.run(tmpl.name, tmpl.description, steps, 'template', existing.id);
            updated++;
          }
        }
        return { seeded, updated };
      };

      const skillChains = seedChains(stmts.skillChains, SEED_SKILL_CHAINS, stmts.skillChains.insert);
      const toolChains = seedChains(stmts.toolChains, SEED_TOOL_CHAINS, stmts.toolChains.insert);

      res.json({
        seeded, skipped,
        chains_seeded: skillChains.seeded,
        chains_updated: skillChains.updated,
        tool_chains_seeded: toolChains.seeded,
        tool_chains_updated: toolChains.updated,
        total_seeded: seeded.length,
        total_skipped: skipped.length,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
