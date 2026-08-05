import express from 'express';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { runSandboxed } from './sandbox.mjs';
import { runLearnLoop } from '../learning-loop.mjs';
import { reinforcePattern } from '../learn.mjs';

/**
 * Tools routes: CRUD tools, self-learning API, AI system tool endpoints.
 * Dependencies: db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter,
 *   audit, broadcast, logger, DATA_DIR
 */
export default function toolsRoutes(ctx) {
  const { db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter, audit, broadcast, logger, DATA_DIR } = ctx;
  const router = express.Router();

  // ─── Tools CRUD ───────────────────────────────────────────────────
  router.get('/tools', optionalAuth, (_req, res) => {
    res.json(stmts.tools.getAll.all());
  });

  router.get('/tools/enabled', optionalAuth, (_req, res) => {
    res.json(stmts.tools.getEnabled.all());
  });

  router.get('/tools/:id', optionalAuth, (req, res) => {
    const tool = stmts.tools.getById.get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    res.json(tool);
  });

  router.post('/tools', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { name, description, skill_id, endpoint, method, parameters, requires_auth, enabled } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const existing = stmts.tools.getByName.get(name);
    if (existing) return res.status(409).json({ error: 'Tool already exists' });
    const id = randomUUID();
    stmts.tools.insert.run(id, name, description || '', skill_id || null, endpoint || '', method || 'POST', JSON.stringify(parameters || {}), requires_auth !== false ? 1 : 0, enabled !== false ? 1 : 0);
    audit('create', 'tool', id, req.user.id, { name });
    res.status(201).json({ id, name });
  });

  router.delete('/tools/:id', authMiddleware, requireRole('admin'), (req, res) => {
    const tool = stmts.tools.getById.get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    stmts.tools.delete.run(req.params.id);
    audit('delete', 'tool', req.params.id, req.user.id, { name: tool.name });
    res.json({ ok: true });
  });

  // ─── Aimi Self-Learning API ─────────────────────────────────────

  router.post('/learn/observe', authMiddleware, apiLimiter, (req, res) => {
    const { conversation_id, user_input, assistant_output, intent, entities, skillProposed, confidence } = req.body;
    if (!user_input) return res.status(400).json({ error: 'user_input required' });
    const id = randomUUID();
    stmts.observations.insert.run(
      id, conversation_id || null, user_input, assistant_output || '',
      intent || '', JSON.stringify(entities || []), skillProposed || null,
      confidence || 0
    );

    const inputLower = user_input.toLowerCase();
    const words = inputLower.split(/\s+/).filter(w => w.length > 3);
    const patternKey = words.slice(0, 4).join(' ');
    if (patternKey.length > 10) {
      const existing = stmts.patterns.getByKey.get(patternKey);
      if (existing) {
        const newCount = existing.occurrence_count + 1;
        const newConfidence = Math.min(0.99, existing.confidence + 0.05);
        stmts.patterns.increment.run(newConfidence, existing.id);
        broadcast('learn:pattern', { id: existing.id, pattern_key: patternKey, occurrence_count: newCount, confidence: newConfidence });
      } else {
        const patternId = randomUUID();
        const patternType = intent || 'keyword';
        stmts.patterns.insert.run(patternId, patternKey, patternType, `Recurring: "${patternKey}"`, 0.3);
        broadcast('learn:pattern', { id: patternId, pattern_key: patternKey, pattern_type: patternType, occurrence_count: 1, confidence: 0.3 });
      }
    }

    broadcast('learn:observation', { id, intent, skillProposed });
    res.status(201).json({ id, pattern_detected: patternKey.length > 10 });
  });

  router.get('/learn/patterns', authMiddleware, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(stmts.patterns.getAll.all().slice(0, limit));
  });

  router.get('/learn/observations', authMiddleware, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(stmts.observations.getRecent.all(limit));
  });

  router.get('/learn/stats', authMiddleware, (_req, res) => {
    const obsCount = stmts.observations.count.get().count;
    const patterns = stmts.patterns.getAll.all();
    const patternCount = patterns.length;
    const highConfidencePatterns = patterns.filter(p => p.confidence >= 0.7).length;
    const autoSkills = stmts.skills.getAutoProposed.all();
    const autoSkillCount = autoSkills.length;
    const validatedSkills = autoSkills.filter(s => s.success_count > 0).length;
    const avgConfidence = patterns.length > 0
      ? patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length
      : 0;

    res.json({
      total_observations: obsCount,
      total_patterns: patternCount,
      high_confidence_patterns: highConfidencePatterns,
      auto_proposed_skills: autoSkillCount,
      validated_skills: validatedSkills,
      avg_pattern_confidence: Math.round(avgConfidence * 100) / 100,
    });
  });

  // POST /learn/run-loop — run one learning pass now (promote the most mature
  // recurring pattern into an auto-learned skill). Admin-only; the background
  // daemon calls the same logic on an interval.
  router.post('/learn/run-loop', authMiddleware, requireRole('admin'), apiLimiter, async (_req, res) => {
    const result = await runLearnLoop({ db, stmts, randomUUID, broadcast, audit, logger });
    if (!result) {
      const patterns = stmts.patterns.getAll.all();
      return res.json({ promoted: false, reason: 'No mature pattern eligible for promotion (need >=3 occurrences and >=60% confidence)', pattern_count: patterns.length });
    }
    res.json({ promoted: true, ...result });
  });

  router.post('/skills/auto-propose', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    const { pattern_id, name, description, handler, category, parameters } = req.body;

    if (name && handler) {
      const existing = stmts.skills.getByName.get(name);
      if (existing) return res.status(409).json({ error: 'Skill already exists' });
      const id = randomUUID();
      stmts.skills.insertWithConfidence.run(
        id, name, description || 'Auto-proposed by Aimi', category || 'auto-learned',
        handler, JSON.stringify(parameters || {}), 0, 0.3, 1
      );
      audit('auto-propose', 'skill', id, req.user.id, { name, pattern_id });
      broadcast('skill:proposed', { id, name, confidence: 0.3 });

      if (pattern_id) {
        const pattern = db.prepare('SELECT * FROM learn_patterns WHERE id = ?').get(pattern_id);
        if (pattern) {
          stmts.patterns.updateConfidence.run(pattern.confidence, id, pattern_id);
        }
      }
      return res.status(201).json({ id, name, confidence: 0.3, auto_proposed: true });
    }

    const recent = stmts.observations.getRecent.all(20);
    if (recent.length < 3) {
      return res.status(400).json({ error: 'Not enough observations to propose a skill (need at least 3)' });
    }

    const intentGroups = {};
    for (const obs of recent) {
      const key = obs.intent || 'unknown';
      if (!intentGroups[key]) intentGroups[key] = [];
      intentGroups[key].push(obs);
    }

    let bestIntent = null;
    let bestCount = 0;
    for (const [intent, obs] of Object.entries(intentGroups)) {
      if (obs.length > bestCount) {
        bestCount = obs.length;
        bestIntent = intent;
      }
    }

    if (!bestIntent || bestCount < 2) {
      return res.json({ proposed: false, reason: 'No recurring intent strong enough to propose a skill' });
    }

    const skillName = `auto-${bestIntent.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-${Date.now().toString(36)}`;
    const skillDesc = `Auto-proposed skill for recurring intent: ${bestIntent} (from ${bestCount} observations)`;
    const skillHandler = `async (input) => {\n  // Auto-generated by Aimi self-learning\n  // Intent: ${bestIntent}\n  // Based on ${bestCount} observations\n  return { handled: true, intent: '${bestIntent}' };\n}`;

    const id = randomUUID();
    stmts.skills.insertWithConfidence.run(
      id, skillName, skillDesc, 'auto-learned',
      skillHandler, JSON.stringify({ auto_generated: true, intent: bestIntent, observation_count: bestCount }),
      0, 0.3, 1
    );
    audit('auto-propose', 'skill', id, req.user.id, { name: skillName, intent: bestIntent, observation_count: bestCount });
    broadcast('skill:proposed', { id, name: skillName, confidence: 0.3, intent: bestIntent });

    res.status(201).json({
      id, name: skillName, description: skillDesc,
      confidence: 0.3, auto_proposed: true,
      based_on: { intent: bestIntent, observation_count: bestCount }
    });
  });

  router.post('/skills/:id/validate', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    const skill = stmts.skills.getById.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { test_input, expected_output } = req.body;
    if (!test_input) return res.status(400).json({ error: 'test_input required' });

    const validationId = randomUUID();
    const startTime = Date.now();

    let actualOutput = '';
    let exitCode = 0;
    let passed = 0;

    try {
      const { result: handlerResult } = await runSandboxed({ code: skill.handler, input: test_input });
      actualOutput = JSON.stringify(handlerResult);
      if (expected_output) {
        passed = actualOutput.includes(expected_output) ? 1 : 0;
      } else {
        passed = handlerResult && !handlerResult.error ? 1 : 0;
      }
    } catch (err) {
      actualOutput = err.message;
      exitCode = 1;
      passed = 0;
    }

    const durationMs = Date.now() - startTime;

    stmts.validations.insert.run(
      validationId, skill.id, test_input,
      expected_output || '', actualOutput, passed, exitCode, durationMs
    );

    const passRate = stmts.validations.getPassRate.get(skill.id);
    const total = passRate.total || 0;
    const passCount = passRate.passed || 0;
    const newSuccessCount = skill.success_count + (passed ? 1 : 0);
    const newFailureCount = skill.failure_count + (passed ? 0 : 1);
    const newConfidence = total > 0 ? Math.round((passCount / total) * 100) / 100 : skill.confidence;
    stmts.skills.updateConfidence.run(newConfidence, newSuccessCount, newFailureCount, skill.id);
    reinforcePattern(stmts, skill.id, !!passed);

    broadcast('skill:validated', { skill_id: skill.id, validation_id: validationId, passed, confidence: newConfidence });

    res.json({
      validation_id: validationId,
      passed: !!passed,
      actual_output: actualOutput,
      duration_ms: durationMs,
      confidence: newConfidence,
      total_validations: total,
      pass_rate: total > 0 ? `${passCount}/${total}` : '0/0',
    });
  });

  router.get('/skills/:id/validations', authMiddleware, (req, res) => {
    res.json(stmts.validations.getBySkill.all(req.params.id));
  });

  router.post('/skills/:id/feedback', authMiddleware, apiLimiter, (req, res) => {
    const skill = stmts.skills.getById.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });

    const { success } = req.body;
    if (success === undefined) return res.status(400).json({ error: 'success (bool) required' });

    const newSuccessCount = skill.success_count + (success ? 1 : 0);
    const newFailureCount = skill.failure_count + (success ? 0 : 1);
    const total = newSuccessCount + newFailureCount;
    const newConfidence = total > 0 ? Math.round((newSuccessCount / total) * 100) / 100 : skill.confidence;

    stmts.skills.updateConfidence.run(newConfidence, newSuccessCount, newFailureCount, skill.id);
    reinforcePattern(stmts, skill.id, !!success);
    broadcast('skill:feedback', { skill_id: skill.id, success, confidence: newConfidence });

    res.json({ skill_id: skill.id, confidence: newConfidence, success_count: newSuccessCount, failure_count: newFailureCount });
  });

  router.delete('/learn/patterns/:id', authMiddleware, requireRole('admin'), (req, res) => {
    stmts.patterns.delete.run(req.params.id);
    res.json({ ok: true });
  });

  // ─── AI System Tool Endpoints (admin-only) ──────────────────────
  router.post('/tools/bash', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    try {
      const output = execSync(command, { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      res.json({ output: output.trim(), exit_code: 0 });
    } catch (err) {
      res.json({ output: (err.stderr || err.message || '').toString().trim(), exit_code: err.status || 1 });
    }
  });

  router.post('/tools/file-read', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    try {
      const content = readFileSync(filePath, 'utf8');
      res.json({ content });
    } catch (err) {
      res.status(404).json({ error: 'File not found or unreadable', details: err.message });
    }
  });

  router.post('/tools/file-write', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    try {
      writeFileSync(filePath, content, 'utf8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to write file', details: err.message });
    }
  });

  router.post('/tools/pdf-parse', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    const { path: filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path required' });

    const resolved = filePath.startsWith('/') ? filePath : path.join(DATA_DIR, filePath);
    if (!existsSync(resolved)) return res.status(404).json({ error: 'PDF not found', path: resolved });

    try {
      const pdfParse = (await import('pdf-parse')).default;
      const buffer = readFileSync(resolved);
      const data = await pdfParse(buffer);
      const pages = data.text.split('\f').map(p => p.trim()).filter(Boolean);
      res.json({
        pages: pages.length || data.numpages || 1,
        text: data.text,
        pages_array: pages.length ? pages : [data.text],
        info: data.info || {},
      });
    } catch (err) {
      logger.error(`pdf-parse: ${err.message}`);
      res.status(500).json({ error: 'PDF parse failed', detail: err.message });
    }
  });

  router.post('/tools/web-search', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    const { query, max_results, search_depth } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) {
      return res.status(400).json({
        error: 'TAVILY_API_KEY is not configured. Set it under Settings → Environment Variables (key: TAVILY_API_KEY) and retry.',
      });
    }

    const maxResults = (() => {
      const n = Number(max_results);
      if (!Number.isFinite(n)) return 5;
      return Math.max(1, Math.min(10, Math.trunc(n)));
    })();
    const validDepths = new Set(['basic', 'advanced']);
    const depth = validDepths.has(search_depth) ? search_depth : 'basic';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let resp;
      try {
        resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: tavilyKey, query, max_results: maxResults, search_depth: depth }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!resp.ok) {
        let detail;
        try { detail = (await resp.json()).detail; } catch {}
        const message = detail || `Tavily API error (HTTP ${resp.status})`;
        logger.warn(`web-search: Tavily upstream error ${resp.status} for query "${query.slice(0, 80)}"`);
        return res.status(502).json({ error: 'Tavily search failed', detail: message });
      }

      const data = await resp.json();
      const results = (data.results || []).map(r => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
      }));
      res.json({ results, answer: data.answer || null });
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        logger.warn(`web-search: Tavily request timed out for query "${query.slice(0, 80)}"`);
        return res.status(504).json({ error: 'Tavily search timed out', detail: 'Request exceeded 15s limit' });
      }
      logger.error(`web-search: ${err.message}`);
      return res.status(502).json({ error: 'Tavily search failed', detail: err.message });
    }
  });

  router.post('/tools/code-exec', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { code, language } = req.body;
    if (!code || !language) return res.status(400).json({ error: 'code and language required' });
    const lang = (language || '').toLowerCase();
    try {
      let cmd;
      if (lang === 'python' || lang === 'python3') {
        cmd = `python3 -c ${JSON.stringify(code)}`;
      } else if (lang === 'node' || lang === 'javascript' || lang === 'js') {
        cmd = `node -e ${JSON.stringify(code)}`;
      } else {
        return res.status(400).json({ error: `Unsupported language: ${language}. Supported: python, node/javascript` });
      }
      const output = execSync(cmd, { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
      res.json({ output: output.trim(), exit_code: 0 });
    } catch (err) {
      res.json({ output: (err.stderr || err.message || '').toString().trim(), exit_code: err.status || 1 });
    }
  });

  return router;
}
