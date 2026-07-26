/**
 * Cardinal Frame — Skill Hub Routes
 *
 * Skill marketplace: search, browse, install, publish skills from
 * external hub sources. Supports GitHub-based skill repos and
 * direct URL installation.
 *
 * Dependencies: db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast, randomUUID
 */

import express from 'express';
import { safeFetch } from '../safe-fetch.mjs';

export default function skillHubRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast, randomUUID } = ctx;
  const router = express.Router();

  // ─── Hub Sources CRUD ──────────────────────────────────────────

  // List all hub sources
  router.get('/skills/hub/sources', authMiddleware, (_req, res) => {
    try {
      const sources = stmts.skillHub.getAll.all();
      res.json(sources.map(s => ({
        ...s,
        installed_skills: JSON.parse(s.installed_skills || '[]'),
        scan_result: s.scan_result ? JSON.parse(s.scan_result) : null,
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // SSRF protection — reject internal/loopback/link-local addresses
  function isInternalUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const host = u.hostname;
      // Block localhost, loopback, link-local, RFC1918, AWS metadata
      if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
      if (host.startsWith('127.')) return true;
      if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
      if (host.startsWith('169.254.')) return true;
      if (host.startsWith('172.')) {
        const octet = parseInt(host.split('.')[1], 10);
        if (octet >= 16 && octet <= 31) return true;
      }
      return false;
    } catch { return false; }
  }

  // Add a hub source (GitHub repo URL or direct hub endpoint)
  router.post('/skills/hub/sources', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { name, url, type = 'github' } = req.body;
      if (!name || !url) return res.status(400).json({ error: 'name and url required' });

      // SSRF protection
      if (isInternalUrl(url)) return res.status(403).json({ error: 'Internal/private URLs not allowed' });

      const existing = db.prepare('SELECT id FROM skill_hub_sources WHERE url = ?').get(url);
      if (existing) return res.status(409).json({ error: 'Hub source already registered' });

      const id = randomUUID();
      stmts.skillHub.insert.run(id, name, url, type, 0, 0, 'pending');
      logger.info(`Skill hub source added: ${name} (${url})`);
      broadcast('skills:hub:source-added', { id, name, url });

      // Trigger async scan
      scanHubSource(id, name, url, type).catch(e => {
        logger.error(`Hub scan failed for ${name}: ${e.message}`);
      });

      res.status(201).json({ id, name, url, type, scan_status: 'pending' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Delete a hub source
  router.delete('/skills/hub/sources/:id', authMiddleware, requireRole('admin'), (req, res) => {
    try {
      const source = stmts.skillHub.getById.get(req.params.id);
      if (!source) return res.status(404).json({ error: 'Hub source not found' });
      stmts.skillHub.delete.run(req.params.id);
      broadcast('skills:hub:source-removed', { id: req.params.id });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Manual rescan of a hub source
  router.post('/skills/hub/sources/:id/scan', authMiddleware, requireRole('admin'), async (req, res) => {
    try {
      const source = stmts.skillHub.getById.get(req.params.id);
      if (!source) return res.status(404).json({ error: 'Hub source not found' });

      stmts.skillHub.updateScan.run('scanning', null, 0, req.params.id);
      broadcast('skills:hub:scanning', { id: req.params.id, name: source.name });

      scanHubSource(req.params.id, source.name, source.url, source.type).catch(e => {
        logger.error(`Hub rescan failed for ${source.name}: ${e.message}`);
      });

      res.json({ ok: true, scan_status: 'scanning' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Install a specific skill from a hub source (with security verdict)
  router.post('/skills/hub/sources/:id/install', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { skill_name, verdict } = req.body;
      if (!skill_name) return res.status(400).json({ error: 'skill_name required' });

      // Security gate — reject if verdict is 'failed'
      if (verdict === 'failed') return res.status(403).json({ error: 'Security verdict failed — skill blocked' });

      const source = stmts.skillHub.getById.get(req.params.id);
      if (!source) return res.status(404).json({ error: 'Hub source not found' });

      const installed = JSON.parse(source.installed_skills || '[]');
      const skill = installed.find(s => s.name === skill_name);
      if (!skill) return res.status(404).json({ error: `Skill "${skill_name}" not found in hub source` });

      // Check if already installed
      const existing = db.prepare('SELECT id FROM skills WHERE name = ?').get(skill_name);
      if (existing) return res.status(409).json({ error: 'Skill already installed', id: existing.id });

      let skillContent = skill.content || '';
      if (skill.url && !skillContent) {
        try {
          const resp = await safeFetch(skill.url, { signal: AbortSignal.timeout(15000) });
          if (resp.ok) skillContent = await resp.text();
        } catch (e) {
          return res.status(502).json({ error: `Failed to fetch skill from ${skill.url}: ${e.message}` });
        }
      }

      const id = randomUUID();
      const skillId = skill.id || skill_name;
      db.prepare(`INSERT INTO skills (id, skill_id, name, description, content, enabled, source)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .run(id, skillId, skill.name, skill.description || '', skillContent, `hub:${source.name}`);

      scanInstalledSkill(id, skill_name, skillContent).catch(e => {
        logger.error(`Skill scan failed for ${skill_name}: ${e.message}`);
      });

      logger.info(`Skill installed from hub: ${skill.name} (source: ${source.name})`);
      broadcast('skills:installed', { id, name: skill.name, source: source.name });
      res.status(201).json({ id, name: skill.name, description: skill.description, source: source.name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Search / Browse Skills from Hub ────────────────────────────

  // Search skills across all registered hub sources
  router.get('/skills/hub/search', authMiddleware, async (req, res) => {
    try {
      const query = (req.query.q || '').toLowerCase();
      const sources = stmts.skillHub.getAll.all();
      const results = [];

      for (const source of sources) {
        const installed = JSON.parse(source.installed_skills || '[]');
        for (const skill of installed) {
          if (!query || skill.name?.toLowerCase().includes(query) || skill.description?.toLowerCase().includes(query)) {
            results.push({
              ...skill,
              hub_source: source.name,
              hub_source_id: source.id,
              verified: !!source.verified,
              trust_score: source.trust_score,
            });
          }
        }
      }

      res.json({ results, count: results.length, sources_scanned: sources.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Install Skill from Hub ─────────────────────────────────────

  // Install a skill from a hub source
  router.post('/skills/hub/install', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { hub_source_id, skill_name } = req.body;
      if (!hub_source_id || !skill_name) return res.status(400).json({ error: 'hub_source_id and skill_name required' });

      const source = stmts.skillHub.getById.get(hub_source_id);
      if (!source) return res.status(404).json({ error: 'Hub source not found' });

      const installed = JSON.parse(source.installed_skills || '[]');
      const skill = installed.find(s => s.name === skill_name);
      if (!skill) return res.status(404).json({ error: `Skill "${skill_name}" not found in hub source` });

      // Check if already installed in local DB
      const existing = db.prepare('SELECT id FROM skills WHERE name = ?').get(skill_name);
      if (existing) return res.status(409).json({ error: 'Skill already installed', id: existing.id });

      // Fetch skill content from URL
      let skillContent = skill.content || '';
      if (skill.url && !skillContent) {
        try {
          const resp = await safeFetch(skill.url, { signal: AbortSignal.timeout(15000) });
          if (resp.ok) skillContent = await resp.text();
        } catch (e) {
          return res.status(502).json({ error: `Failed to fetch skill from ${skill.url}: ${e.message}` });
        }
      }

      const id = randomUUID();
      const skillId = skill.id || skill_name;
      db.prepare(`INSERT INTO skills (id, skill_id, name, description, content, enabled, source)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .run(id, skillId, skill.name, skill.description || '', skillContent, `hub:${source.name}`);

      // Trigger scan for the installed skill (security)
      scanInstalledSkill(id, skill_name, skillContent).catch(e => {
        logger.error(`Skill scan failed for ${skill_name}: ${e.message}`);
      });

      logger.info(`Skill installed from hub: ${skill.name} (source: ${source.name})`);
      broadcast('skills:installed', { id, name: skill.name, source: source.name });
      res.status(201).json({ id, name: skill.name, description: skill.description, source: source.name });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Publish Skill to Hub ──────────────────────────────────────

  // Publish a local skill to a hub source (if it supports publishing)
  router.post('/skills/hub/publish', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const { skill_id, hub_source_id } = req.body;
      if (!skill_id || !hub_source_id) return res.status(400).json({ error: 'skill_id and hub_source_id required' });

      const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skill_id);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });

      const source = stmts.skillHub.getById.get(hub_source_id);
      if (!source) return res.status(404).json({ error: 'Hub source not found' });

      // For GitHub-based hubs, this would push to the repo's skills/ directory
      // For now, just mark the skill as published
      const publishId = randomUUID();
      db.prepare('INSERT INTO skill_validations (id, skill_id, test_input, expected_output, actual_output, passed, exit_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(publishId, skill_id, 'hub_publish', JSON.stringify({ hub: source.name, url: source.url }), JSON.stringify({ published_at: new Date().toISOString() }), 1, 0, 0);

      logger.info(`Skill "${skill.name}" published to hub: ${source.name}`);
      broadcast('skills:published', { skill_id, name: skill.name, hub: source.name });
      res.json({ ok: true, published: skill.name, hub: source.name, publish_id: publishId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Async Hub Source Scanner ──────────────────────────────────

  async function scanHubSource(sourceId, name, url, type) {
    try {
      stmts.skillHub.updateScan.run('scanning', null, 0, sourceId);

      let skills = [];

      if (type === 'github') {
        // Fetch skill index from GitHub repo
        // Expected: repo has a skills-index.json at root or in skills/ directory
        const rawUrl = url.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
        const indexUrl = rawUrl.endsWith('/') ? `${rawUrl}skills-index.json` : `${rawUrl}/main/skills-index.json`;

        const resp = await safeFetch(indexUrl, { signal: AbortSignal.timeout(20000) });
        if (resp.ok) {
          const data = await resp.json();
          skills = data.skills || [];
        } else {
          // Try fetching individual SKILL.md files from the repo's skills/ directory
          const skillsDirUrl = rawUrl.endsWith('/') ? `${rawUrl}skills` : `${rawUrl}/main/skills`;
          skills = [{ name: 'unknown', description: 'Could not auto-detect skills index. Manual installation required.', url: skillsDirUrl }];
        }
      } else if (type === 'url') {
        // Direct JSON API endpoint
        const resp = await safeFetch(url, { signal: AbortSignal.timeout(15000) });
        if (resp.ok) {
          const data = await resp.json();
          skills = data.skills || data || [];
        }
      }

      const trustScore = skills.length > 0 ? Math.min(100, skills.length * 10) : 0;
      const scanResult = { skills_found: skills.length, scanned_at: new Date().toISOString() };

      stmts.skillHub.updateScan.run('passed', JSON.stringify(scanResult), trustScore, sourceId);
      stmts.skillHub.updateInstalled.run(JSON.stringify(skills), sourceId);

      logger.info(`Hub scan complete: ${name} — ${skills.length} skills found`);
      broadcast('skills:hub:scanned', { source_id: sourceId, name, skills_found: skills.length });
    } catch (e) {
      stmts.skillHub.updateScan.run('failed', JSON.stringify({ error: e.message }), 0, sourceId);
      logger.error(`Hub scan failed for ${name}: ${e.message}`);
    }
  }

  // ─── Security Scanner for Installed Skills ─────────────────────

  async function scanInstalledSkill(skillId, skillName, content) {
    const checks = {
      hasShellCommands: /exec\(|spawn\(|child_process|os\.system|subprocess/.test(content),
      hasNetworkAccess: /fetch\(|http\.get|https\.get|axios|request\(/.test(content),
      hasFileAccess: /readFile|writeFile|fs\./.test(content),
      hasEnvAccess: /process\.env|os\.environ/.test(content),
    };

    const riskScore = Object.values(checks).filter(Boolean).length;
    const result = {
      risk_score: riskScore,
      checks,
      verdict: riskScore === 0 ? 'safe' : riskScore <= 2 ? 'caution' : 'elevated',
      scanned_at: new Date().toISOString(),
    };

    db.prepare('INSERT INTO skill_validations (id, skill_id, test_input, expected_output, actual_output, passed, exit_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), skillId, 'hub_security_scan', JSON.stringify({ expected: 'safe skill' }), JSON.stringify(result), riskScore === 0 ? 1 : 0, riskScore, 0);

    if (riskScore >= 2) {
      logger.warn(`Security scan: skill "${skillName}" has elevated risk (score ${riskScore})`);
      broadcast('skills:security-warning', { skill_id: skillId, name: skillName, risk_score: riskScore });
    }
  }

  return router;
}
