import express from 'express';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { isIP } from 'net';
import dns from 'dns/promises';
import { buildDistillPrompt, buildEvolutionPrompt, scanSkillHandler, shouldEvolveChain } from '../evolution.mjs';

/**
 * Evolution routes: auto-skill distill, chain promotion, skill hub install/export.
 * Dependencies: db, stmts, authMiddleware, requireRole, apiLimiter, broadcast, callAgentLLM
 */

// ─── Source gatherers for distill ───────────────────────────

const MAX_SOURCE_CHARS = 24000; // truncate before it hits the LLM prompt

// ─── Directory path allowlist (defense in depth) ────────────
// Only directories under these roots are readable by the distill directory source.
const ALLOWED_BASE_DIRS = [process.cwd()];

function isPathAllowed(resolved) {
  return ALLOWED_BASE_DIRS.some(base => {
    const baseResolved = path.resolve(base);
    return resolved === baseResolved || resolved.startsWith(baseResolved + path.sep);
  });
}

// ─── SSRF protection for URL source ────────────────────────
const BLOCKED_HOSTNAMES = ['localhost', '169.254.169.254', '0.0.0.0', '[::]'];
const MAX_REDIRECTS = 3;

function isPrivateIP(ip) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(ip) || ip === '::1' || ip === '::';
}

/**
 * Validate that a URL is safe to fetch server-side.
 * Checks scheme, hostname blocklist, and resolves DNS to catch
 * hostnames that point to private/internal IPs.
 */
async function validateUrlIsSafe(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { throw new Error('Invalid URL'); }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked scheme: ${parsed.protocol}`);
  }
  if (BLOCKED_HOSTNAMES.includes(parsed.hostname.toLowerCase())) {
    throw new Error('Blocked hostname');
  }
  // Resolve hostname — don't trust the string alone, DNS can bypass a hostname check
  const ip = isIP(parsed.hostname) ? parsed.hostname : (await dns.lookup(parsed.hostname)).address;
  if (isPrivateIP(ip)) {
    throw new Error('Blocked: target resolves to a private/internal address');
  }
  return parsed;
}

/**
 * SSRF-safe fetch: validates URL before fetching and re-validates
 * at every redirect hop. Used by gatherUrl, hub scan, and hub install.
 *
 * @param {string} url — the URL to fetch
 * @param {object} opts — fetch options (signal, etc.) — redirect is forced to 'manual'
 * @returns {Promise<Response>} — the final non-redirect Response
 */
async function safeFetch(url, opts = {}) {
  let currentUrl = url;
  let redirectCount = 0;

  // Initial validation
  await validateUrlIsSafe(currentUrl);

  while (redirectCount <= MAX_REDIRECTS) {
    const resp = await fetch(currentUrl, { ...opts, redirect: 'manual' });

    // Check for redirect — re-validate before following
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const location = resp.headers.get('location');
      if (!location) throw new Error('Redirect response missing Location header');
      const nextUrl = new URL(location, currentUrl).href;
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) throw new Error('Too many redirects');
      await validateUrlIsSafe(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    return resp; // non-redirect — caller decides what to do with it
  }

  throw new Error('Too many redirects');
}

/** Gather conversation source: observations + messages → text */
function gatherConversation(stmts, conversationId) {
  const observations = stmts.observations.getByConversation.all(conversationId);
  const messages = stmts.messages.getByConversation.all(conversationId);
  if (observations.length === 0 && messages.length === 0) return null;

  const obs = observations.map(o =>
    `Input: "${(o.user_input || '').slice(0, 500)}" → Output: "${(o.assistant_output || '').slice(0, 200)}" (intent: ${o.intent || 'unknown'})`
  ).join('\n');
  const msgs = messages.map(m =>
    `${m.role}: ${(m.content || '').slice(0, 300)}`
  ).join('\n');
  return `${msgs}\n\n## Observations\n${obs}`.slice(0, MAX_SOURCE_CHARS);
}

/** Gather directory source: read files, concatenate → text (admin-only, path-allowlisted) */
function gatherDirectory(dirPath) {
  if (!dirPath) return null;
  const resolved = path.resolve(dirPath); // normalize, resolve relative to cwd
  if (!isPathAllowed(resolved)) return null; // blocked — 404
  if (!existsSync(resolved)) return null;
  const stat = statSync(resolved);
  if (!stat.isDirectory()) return null;

  const files = readdirSync(resolved)
    .filter(f => /\.(mjs|js|jsx|ts|tsx|json|md|txt|yaml|yml|sh|py)$/.test(f))
    .sort()
    .slice(0, 20); // cap at 20 files to keep prompt bounded

  const parts = [];
  for (const f of files) {
    try {
      const fp = path.join(resolved, f);
      const content = readFileSync(fp, 'utf8');
      parts.push(`### ${f}\n${content.slice(0, 2000)}`);
    } catch { /* skip unreadable files */ }
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n').slice(0, MAX_SOURCE_CHARS);
}

/**
 * Gather URL source: fetch page, strip HTML → text
 * SSRF-protected via safeFetch (validates scheme + DNS, manual redirects with re-validation).
 */
async function gatherUrl(url) {
  if (!url) return null;
  const resp = await safeFetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Failed to fetch URL: HTTP ${resp.status}`);
  const raw = await resp.text();
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, MAX_SOURCE_CHARS) || null;
}

export default function evolutionRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter, broadcast, callAgentLLM } = ctx;
  const router = express.Router();

  // ═════════════════════════════════════════════════════════════════
  // ─── Auto-Skill Authoring (Distill) ─────────────────────────────
  // ═════════════════════════════════════════════════════════════════

  // POST /learn/distill — Aimi analyzes a source and auto-creates a skill
  // Supports: conversation, directory, url, notes (defaults to conversation)
  // Admin-only: directory and url sources can access server filesystem/network
  router.post('/learn/distill', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const source_type = req.body.source_type || 'conversation';
      let sourceRef = null;   // identifier for the evolution record (conversation_id, path, url, or 'notes')
      let sourceContent = null;

      if (source_type === 'conversation') {
        const { conversation_id } = req.body;
        if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
        sourceRef = conversation_id;
        sourceContent = gatherConversation(stmts, conversation_id);
        if (!sourceContent) return res.status(404).json({ error: 'No observations or messages found for this conversation' });

      } else if (source_type === 'directory') {
        const { path: dirPath } = req.body;
        if (!dirPath) return res.status(400).json({ error: 'path required' });
        sourceRef = dirPath;
        sourceContent = gatherDirectory(dirPath);
        if (!sourceContent) return res.status(404).json({ error: 'Directory not found or contains no readable files' });

      } else if (source_type === 'url') {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'url required' });
        sourceRef = url;
        try {
          sourceContent = await gatherUrl(url);
        } catch (e) {
          return res.status(502).json({ error: e.message });
        }
        if (!sourceContent) return res.status(404).json({ error: 'URL returned no readable content' });

      } else if (source_type === 'notes') {
        const { notes } = req.body;
        if (!notes || !notes.trim()) return res.status(400).json({ error: 'notes required' });
        sourceRef = 'notes';
        sourceContent = notes.slice(0, MAX_SOURCE_CHARS);

      } else {
        return res.status(400).json({ error: `Unknown source_type: ${source_type}. Use: conversation, directory, url, or notes` });
      }

      const systemPrompt = buildDistillPrompt(source_type, sourceContent);
      const result = await callAgentLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Distill this into a reusable skill.' },
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
      stmts.evolution.insert.run(evoId, skillId, null, 1, 'auto-distill', null, `${source_type}:${sourceRef}`, `Auto-distilled from ${source_type}:${sourceRef}`);

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

      const resp = await safeFetch(manifestUrl, { signal: AbortSignal.timeout(15000) });
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

      const resp = await safeFetch(manifestUrl);
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
