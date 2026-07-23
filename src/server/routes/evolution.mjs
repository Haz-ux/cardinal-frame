import express from 'express';
import { randomUUID } from 'crypto';
import { buildDistillPrompt, buildEvolutionPrompt, scanSkillHandler, shouldEvolveChain } from '../evolution.mjs';

/**
 * Evolution routes: auto-skill distill, chain promotion, skill hub install/export.
 * Dependencies: db, stmts, authMiddleware, requireRole, apiLimiter, broadcast, callAgentLLM
 */
export default function evolutionRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter, broadcast, callAgentLLM } = ctx;
  const router = express.Router();

  // ═════════════════════════════════════════════════════════════════
  // ─── Auto-Skill Authoring (Distill) ─────────────────────────────
  // ═════════════════════════════════════════════════════════════════

  // POST /learn/distill — Aimi analyzes a conversation and auto-creates a skill
  router.post('/learn/distill', authMiddleware, apiLimiter, async (req, res) => {
    try {
      const { conversation_id } = req.body;
      if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

      const observations = stmts.observations.getByConversation.all(conversation_id);
      const messages = stmts.messages.getByConversation.all(conversation_id);
      if (observations.length === 0 && messages.length === 0)
        return res.status(404).json({ error: 'No observations or messages found for this conversation' });

      const systemPrompt = buildDistillPrompt(observations, messages);
      const result = await callAgentLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Distill this conversation into a reusable skill.' },
      ], req.body.model);

      let skillDef;
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        skillDef = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
      } catch {
        return res.status(422).json({ error: 'Aimi could not generate a valid skill definition', raw: result.content.slice(0, 500) });
      }

      // Security scan the handler before saving
      const scan = scanSkillHandler(skillDef.handler, skillDef.name);
      if (scan.verdict === 'blocked') {
        return res.status(403).json({ error: 'Generated skill handler blocked by security scanner', scan });
      }

      // Save as auto-proposed skill
      const skillId = randomUUID();
      const handler = skillDef.handler_type === 'script' ? skillDef.handler
        : skillDef.handler_type === 'hybrid' ? `hybrid:${skillDef.handler}`
        : `template:${skillDef.handler}`;

      stmts.skills.insertWithConfidence.run(
        skillId, skillDef.name, skillDef.description, skillDef.category || 'general',
        handler, JSON.stringify(skillDef.parameters || {}), 1,
        skillDef.confidence || 0.7, 1
      );

      // Record evolution
      const evoId = randomUUID();
      stmts.evolution.insert.run(evoId, skillId, null, 1, 'auto-distill', null, conversation_id, `Auto-distilled from conversation ${conversation_id}`);

      broadcast('skill:distilled', { skillId, name: skillDef.name, confidence: skillDef.confidence });
      res.json({
        skill: { id: skillId, ...skillDef },
        scan,
        evolution_id: evoId,
        tokens: { prompt: result.promptTokens, completion: result.completionTokens },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═════════════════════════════════════════════════════════════════
  // ─── Skill Evolution (Chain Promotion) ──────────────────────────
  // ═════════════════════════════════════════════════════════════════

  router.get('/evolution', authMiddleware, requireRole('admin'), (_req, res) => {
    res.json(stmts.evolution.getAll.all());
  });

  router.get('/evolution/skill/:id', authMiddleware, requireRole('admin'), (req, res) => {
    res.json(stmts.evolution.getBySkill.all(req.params.id));
  });

  router.get('/evolution/chain/:id/check', authMiddleware, (req, res) => {
    const chain = stmts.skillChains.getById.get(req.params.id);
    if (!chain) return res.status(404).json({ error: 'Chain not found' });

    let realHistory = [];
    try {
      realHistory = stmts.chainExecutions.getRecentByChain.all(req.params.id)
        .map(e => ({ ok: Boolean(e.success), duration_ms: e.duration_ms, step_count: e.step_count, error: e.error }));
    } catch { /* table may not exist */ }

    const runCount = chain.run_count || realHistory.length;
    const successCount = chain.success_count || realHistory.filter(r => r.ok).length;
    const evaluation = shouldEvolveChain(chain, realHistory);
    res.json({ ...evaluation, run_count: runCount, success_count: successCount, executions: realHistory.length });
  });

  router.post('/evolution/chain/:id/promote', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const chain = stmts.skillChains.getById.get(req.params.id);
      if (!chain) return res.status(404).json({ error: 'Chain not found' });
      chain.steps = JSON.parse(chain.steps || '[]');

      const runCount = chain.run_count || 0;
      const successCount = chain.success_count || 0;

      let realHistory = [];
      try {
        realHistory = stmts.chainExecutions.getRecentByChain.all(req.params.id)
          .map(e => ({
            ok: Boolean(e.success),
            duration_ms: e.duration_ms,
            step_count: e.step_count,
            error: e.error,
            created_at: e.created_at,
          }));
      } catch { /* table may not exist */ }

      const eval_ = shouldEvolveChain(chain, realHistory);
      if (!eval_.ready) {
        return res.status(400).json({ error: 'Chain not ready for promotion', ...eval_ });
      }

      const evoPrompt = buildEvolutionPrompt(chain, realHistory.slice(0, 10));
      const result = await callAgentLLM([
        { role: 'system', content: evoPrompt },
        { role: 'user', content: 'Evaluate and promote this chain.' },
      ], req.body.model);

      let evoDef;
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        evoDef = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
      } catch {
        return res.status(422).json({ error: 'Aimi could not generate an evolution definition', raw: result.content.slice(0, 500) });
      }

      if (!evoDef.should_promote) {
        return res.json({ promoted: false, reason: evoDef.reason, evaluation: eval_ });
      }

      const scan = scanSkillHandler(evoDef.handler, evoDef.skill_name);
      if (scan.verdict !== 'passed') {
        return res.status(403).json({ error: `Evolved handler failed security scan: ${scan.verdict}`, scan });
      }

      const skillId = randomUUID();
      const handler = evoDef.handler_type === 'hybrid' ? `hybrid:${evoDef.handler}` : evoDef.handler;

      stmts.skills.insertWithConfidence.run(
        skillId, evoDef.skill_name, evoDef.skill_description, 'evolved',
        handler, JSON.stringify({}), 1, evoDef.confidence || 0.8, 1
      );

      const evoId = randomUUID();
      stmts.evolution.insert.run(evoId, skillId, req.params.id, 2, 'chain-promotion', null,
        `chain:${chain.name}`, `Promoted from chain "${chain.name}" (${successCount}/${runCount} successful runs)`);

      try { db.prepare('UPDATE skill_chains SET evolved_to_skill = ? WHERE id = ?').run(skillId, req.params.id); } catch {}

      broadcast('skill:evolved', { skillId, name: evoDef.skill_name, fromChain: chain.name, chainId: req.params.id });
      res.json({
        promoted: true,
        skill: { id: skillId, ...evoDef },
        scan,
        evolution_id: evoId,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/evolution/:id/optimal', authMiddleware, requireRole('admin'), (req, res) => {
    const evo = stmts.evolution.getById?.get(req.params.id);
    if (!evo) return res.status(404).json({ error: 'Evolution record not found' });

    try {
      db.prepare('UPDATE skill_evolution SET optimal = 0 WHERE skill_id = ?').run(evo.skill_id);
    } catch { /* ignore */ }
    const result = stmts.evolution.markOptimal.run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Evolution record not found' });
    res.json({ ok: true, optimal: true });
  });

  // ═════════════════════════════════════════════════════════════════
  // ─── Skill Hub (Install/Export with Security) ───────────────────
  // ═════════════════════════════════════════════════════════════════

  router.get('/skills/hub/sources', authMiddleware, (_req, res) => {
    res.json(stmts.skillHub.getAll.all());
  });

  router.post('/skills/hub/sources', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { name, url, type = 'git' } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url required' });

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'URL must use https:// scheme' });
      }
      const hostname = parsed.hostname;
      const blockedPatterns = [
        /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
        /^169\.254\./, /^0\./, /^localhost$/i,
        /^::1$/, /^fe80:/, /^fc00:/i, /^fd00:/i,
      ];
      if (blockedPatterns.some(re => re.test(hostname))) {
        return res.status(400).json({ error: 'Internal/private host addresses are not allowed' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const id = randomUUID();
    stmts.skillHub.insert.run(id, name, url, type, 0, 0, 'pending');
    res.json({ id, name, url, type, scan_status: 'pending' });
  });

  router.post('/skills/hub/sources/:id/scan', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const source = stmts.skillHub.getById.get(req.params.id);
      if (!source) return res.status(404).json({ error: 'Source not found' });
      stmts.skillHub.updateScan.run('scanning', null, 0, req.params.id);

      const parsed = new URL(source.url);
      if (parsed.protocol !== 'https:') {
        stmts.skillHub.updateScan.run('failed', 'Non-https URL blocked', 0, req.params.id);
        return res.status(400).json({ error: 'Non-https URL blocked' });
      }

      let manifestUrl = source.url;
      if (manifestUrl.endsWith('.git')) manifestUrl = manifestUrl.slice(0, -4);
      if (manifestUrl.includes('github.com')) {
        manifestUrl = manifestUrl.replace('github.com', 'raw.githubusercontent.com') + '/main/skill.json';
      }

      const resp = await fetch(manifestUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        const err = `HTTP ${resp.status}`.slice(0, 256);
        stmts.skillHub.updateScan.run('failed', err, 0, req.params.id);
        return res.json({ verdict: 'failed', error: `Could not fetch manifest: HTTP ${resp.status}` });
      }

      const manifest = await resp.json();
      const skills = Array.isArray(manifest) ? manifest : [manifest];
      const allIssues = [];

      for (const skill of skills) {
        const scan = scanSkillHandler(skill.handler, skill.name);
        allIssues.push({ skill: skill.name, ...scan });
      }

      const blocked = allIssues.some(s => s.verdict === 'blocked');
      const failed = allIssues.some(s => s.verdict === 'failed');
      const verdict = blocked ? 'blocked' : failed ? 'failed' : 'passed';
      const trustScore = allIssues.filter(s => s.verdict === 'passed').length / allIssues.length;

      const resultStr = JSON.stringify(allIssues).slice(0, 65536);
      stmts.skillHub.updateScan.run(verdict, resultStr, trustScore, req.params.id);
      res.json({ verdict, trust_score: trustScore, scans: allIssues });
    } catch (e) {
      stmts.skillHub.updateScan.run('failed', e.message, 0, req.params.id);
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/skills/hub/sources/:id/install', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const source = stmts.skillHub.getById.get(req.params.id);
      if (!source) return res.status(404).json({ error: 'Source not found' });
      if (source.scan_status !== 'passed') return res.status(403).json({ error: `Source scan status is "${source.scan_status}" — must be "passed" to install` });

      let manifestUrl = source.url;
      if (manifestUrl.endsWith('.git')) manifestUrl = manifestUrl.slice(0, -4);
      if (manifestUrl.includes('github.com')) {
        manifestUrl = manifestUrl.replace('github.com', 'raw.githubusercontent.com') + '/main/skill.json';
      }

      const resp = await fetch(manifestUrl);
      if (!resp.ok) return res.status(502).json({ error: `Failed to fetch: HTTP ${resp.status}` });

      const manifest = await resp.json();
      const skills = Array.isArray(manifest) ? manifest : [manifest];
      const installed = [];

      for (const skill of skills) {
        const scan = scanSkillHandler(skill.handler, skill.name);
        if (scan.verdict !== 'passed') {
          installed.push({ name: skill.name, installed: false, reason: `Security scan verdict: ${scan.verdict}` });
          continue;
        }

        const skillId = randomUUID();
        const existing = stmts.skills.getByName.get(skill.name);
        if (existing) {
          installed.push({ name: skill.name, installed: false, reason: 'Skill with this name already exists' });
          continue;
        }

        stmts.skills.insertWithConfidence.run(
          skillId, skill.name, skill.description || '', skill.category || 'hub',
          skill.handler, JSON.stringify(skill.parameters || {}), 1, 0.5, 1
        );

        const evoId = randomUUID();
        stmts.evolution.insert.run(evoId, skillId, null, 1, 'skill-hub', null, `hub:${source.name}`, `Installed from skill hub source "${source.name}"`);
        installed.push({ name: skill.name, installed: true, id: skillId });
      }

      stmts.skillHub.updateInstalled.run(JSON.stringify(installed), req.params.id);
      broadcast('skill:hub:installed', { sourceId: req.params.id, installed });
      res.json({ installed });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/skills/hub/sources/:id', authMiddleware, (req, res) => {
    stmts.skillHub.delete.run(req.params.id);
    res.json({ ok: true });
  });

  router.get('/skills/export/:name', authMiddleware, requireRole('admin'), (req, res) => {
    const skill = stmts.skills.getByName.get(req.params.name);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    const exportData = {
      name: skill.name,
      description: skill.description,
      category: skill.category,
      handler: skill.handler,
      parameters: JSON.parse(skill.parameters || '{}'),
      trigger: skill.trigger || '',
      version: skill.version || '1.0.0',
      exported_at: new Date().toISOString(),
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${skill.name}.json"`);
    res.json(exportData);
  });

  return router;
}
