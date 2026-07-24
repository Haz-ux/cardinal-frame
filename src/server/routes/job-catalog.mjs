import express from 'express';
import { randomUUID } from 'crypto';

/**
 * Job Catalog — Reusable task templates + AI-suggested patterns
 *
 * Dependencies: db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter,
 *               broadcast, audit, logger, callAgentLLM
 *
 * Endpoints:
 *   GET    /api/job-catalog              — list templates (filter: category, search)
 *   GET    /api/job-catalog/:id          — single template
 *   POST   /api/job-catalog              — create template
 *   PUT    /api/job-catalog/:id          — update template
 *   DELETE /api/job-catalog/:id          — delete template
 *   POST   /api/job-catalog/:id/instantiate — create a task from template (param substitution)
 *   POST   /api/job-catalog/suggest      — AI analyzes task history → suggests templates
 *   GET    /api/job-catalog/categories   — distinct categories with counts
 */
export default function jobCatalogRoutes(ctx) {
  const { db, authMiddleware, optionalAuth, requireRole, apiLimiter, broadcast, audit, logger, callAgentLLM } = ctx;
  const router = express.Router();

  // ─── Schema (idempotent) ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      command TEXT NOT NULL,
      parameters TEXT DEFAULT '[]',
      category TEXT,
      tags TEXT DEFAULT '[]',
      priority TEXT DEFAULT 'medium',
      timeout_ms INTEGER DEFAULT 30000,
      created_by TEXT,
      use_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_job_catalog_category ON job_catalog(category);
    CREATE INDEX IF NOT EXISTS idx_job_catalog_name ON job_catalog(name);
  `);

  const stmts = {
    insert: db.prepare(`
      INSERT INTO job_catalog (id, name, description, command, parameters, category, tags, priority, timeout_ms, created_by, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getById: db.prepare('SELECT * FROM job_catalog WHERE id = ?'),
    getAll: db.prepare('SELECT * FROM job_catalog ORDER BY use_count DESC, created_at DESC'),
    getByCategory: db.prepare('SELECT * FROM job_catalog WHERE category = ? ORDER BY use_count DESC, created_at DESC'),
    update: db.prepare(`
      UPDATE job_catalog SET name = ?, description = ?, command = ?, parameters = ?, category = ?, tags = ?, priority = ?, timeout_ms = ?, updated_at = datetime('now')
      WHERE id = ?
    `),
    delete: db.prepare('DELETE FROM job_catalog WHERE id = ?'),
    incrementUse: db.prepare(`
      UPDATE job_catalog SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?
    `),
    getCategories: db.prepare(`
      SELECT category, COUNT(*) as count FROM job_catalog WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC
    `),
    search: db.prepare(`
      SELECT * FROM job_catalog
      WHERE name LIKE ? OR description LIKE ? OR command LIKE ? OR tags LIKE ?
      ORDER BY use_count DESC, created_at DESC
    `),
  };

  // ─── Helpers ──────────────────────────────────────────────────────

  function parseTemplate(row) {
    if (!row) return null;
    return {
      ...row,
      parameters: JSON.parse(row.parameters || '[]'),
      tags: JSON.parse(row.tags || '[]'),
    };
  }

  /** Replace {{param}} placeholders in a command string */
  function substituteParams(command, params) {
    return command.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = params?.[key];
      if (val === undefined || val === null) return '';
      // Basic sanitization — strip shell metachars except spaces, dashes, dots, slashes
      return String(val).replace(/[;&|`$(){}<>!\\]/g, '');
    });
  }

  function validateTemplate(body) {
    if (!body.name || typeof body.name !== 'string') return { error: 'Name is required' };
    if (!body.command || typeof body.command !== 'string') return { error: 'Command is required' };
    if (body.parameters && !Array.isArray(body.parameters)) return { error: 'Parameters must be an array' };
    if (body.tags && !Array.isArray(body.tags)) return { error: 'Tags must be an array' };
    return null;
  }

  // ─── Routes ────────────────────────────────────────────────────────

  router.get('/job-catalog/categories', optionalAuth, (_req, res) => {
    res.json(stmts.getCategories.all());
  });

  router.get('/job-catalog', optionalAuth, (req, res) => {
    const { category, search } = req.query;
    let rows;
    if (search) {
      const q = `%${search}%`;
      rows = stmts.search.all(q, q, q, q);
    } else if (category) {
      rows = stmts.getByCategory.all(category);
    } else {
      rows = stmts.getAll.all();
    }
    res.json(rows.map(parseTemplate));
  });

  router.get('/job-catalog/:id', optionalAuth, (req, res) => {
    const row = stmts.getById.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    res.json(parseTemplate(row));
  });

  router.post('/job-catalog', authMiddleware, apiLimiter, (req, res) => {
    const err = validateTemplate(req.body);
    if (err) return res.status(400).json({ error: err.error });

    const { name, description = '', command, parameters = [], category = null, tags = [], priority = 'medium', timeout_ms = 30000 } = req.body;
    const id = randomUUID();
    stmts.insert.run(id, name, description, command, JSON.stringify(parameters), category, JSON.stringify(tags), priority, timeout_ms, req.user?.id || null, 'manual');
    const row = stmts.getById.get(id);
    broadcast('job-catalog:created', parseTemplate(row));
    audit('create', 'job-catalog', id, req.user?.id, { name });
    res.status(201).json(parseTemplate(row));
  });

  router.put('/job-catalog/:id', authMiddleware, apiLimiter, (req, res) => {
    const existing = stmts.getById.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const err = validateTemplate(req.body);
    if (err) return res.status(400).json({ error: err.error });

    const { name, description, command, parameters, category, tags, priority, timeout_ms } = req.body;
    stmts.update.run(
      name ?? existing.name,
      description ?? existing.description,
      command ?? existing.command,
      JSON.stringify(parameters ?? JSON.parse(existing.parameters)),
      category ?? existing.category,
      JSON.stringify(tags ?? JSON.parse(existing.tags)),
      priority ?? existing.priority,
      timeout_ms ?? existing.timeout_ms,
      req.params.id
    );
    const row = stmts.getById.get(req.params.id);
    broadcast('job-catalog:updated', parseTemplate(row));
    res.json(parseTemplate(row));
  });

  router.delete('/job-catalog/:id', authMiddleware, requireRole('admin'), (req, res) => {
    const info = stmts.delete.run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Template not found' });
    broadcast('job-catalog:deleted', { id: req.params.id });
    res.json({ deleted: true });
  });

  // ─── Instantiate: create a task from a template ───────────────────
  router.post('/job-catalog/:id/instantiate', authMiddleware, apiLimiter, (req, res) => {
    const tpl = stmts.getById.get(req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const params = req.body.params || {};
    const command = substituteParams(tpl.command, params);

    // Validate required params
    const tplParams = JSON.parse(tpl.parameters || '[]');
    const missing = tplParams.filter(p => p.required && (params[p.name] === undefined || params[p.name] === null));
    if (missing.length > 0) return res.status(400).json({
      error: `Missing required parameters: ${missing.map(p => p.name).join(', ')}`,
    });

    // Check command safety via existing sanitizeCommand
    const { sanitizeCommand, stmts: ctxStmts, executeTask } = ctx;
    const check = sanitizeCommand(command);
    if (!check.safe) return res.status(400).json({ error: check.error });

    const taskId = randomUUID();
    const taskName = req.body.name || `[${tpl.name}] ${new Date().toISOString().slice(0, 16)}`;
    ctxStmts.tasks.insert.run(taskId, taskName, command, 'pending', req.user?.id || null, null);

    stmts.incrementUse.run(req.params.id);

    const task = ctxStmts.tasks.getById.get(taskId);
    broadcast('task:created', task);
    broadcast('job-catalog:instantiated', { templateId: req.params.id, taskId });
    audit('instantiate', 'job-catalog', req.params.id, req.user?.id, { taskId, name: taskName });
    logger.info(`Job catalog: instantiated "${tpl.name}" → task ${taskId}`);

    // Auto-execute if requested
    if (req.body.autoExecute !== false) {
      executeTask(taskId, command);
    }

    res.status(201).json({ ...task, template: parseTemplate(tpl) });
  });

  // ─── AI Suggest: analyze task history → suggest templates ──────────
  router.post('/job-catalog/suggest', authMiddleware, apiLimiter, async (req, res) => {
    if (!callAgentLLM) return res.status(503).json({ error: 'LLM provider not configured' });

    try {
      // Get recent completed tasks to analyze for patterns
      const recentTasks = db.prepare(`
        SELECT name, command, status, COUNT(*) as freq
        FROM tasks
        WHERE status = 'done' AND command IS NOT NULL
        GROUP BY command
        ORDER BY freq DESC
        LIMIT 50
      `).all();

      if (recentTasks.length === 0) return res.json({ suggestions: [] });

      // Get existing template names to avoid duplicates
      const existing = stmts.getAll.all().map(t => t.name);

      const systemPrompt = `You are Aimi, the Cardinal Frame AI assistant. Analyze the user's task execution history and suggest reusable job templates.

For each suggestion, identify:
- name: short template name (3-5 words)
- description: what it does (1 sentence)
- command: the command pattern — replace varying parts with {{paramName}} placeholders
- parameters: array of { name, description, defaultValue, required } for each placeholder
- category: one of: build, deploy, test, data, maintenance, monitoring, research, other
- priority: low | medium | high

Return ONLY a JSON array of 3-8 template suggestions. No prose, no markdown fences.`;

      const userPrompt = `Existing templates (avoid duplicates): ${JSON.stringify(existing)}

Recent task history (name | command | frequency):
${recentTasks.map(t => `- ${t.name} | ${t.command} | ${t.freq}×`).join('\n')}

Analyze these tasks. Group similar commands, identify patterns, and suggest reusable templates with parameterized commands.`;

      const result = await callAgentLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);

      // Parse the LLM response — be defensive about JSON
      let suggestions = [];
      try {
        // Strip markdown code fences if present
        let raw = result.content.trim();
        if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        suggestions = JSON.parse(raw);
        if (!Array.isArray(suggestions)) suggestions = [];
      } catch {
        // LLM didn't return clean JSON — return raw content for debugging
        return res.json({ suggestions: [], raw: result.content });
      }

      res.json({ suggestions, analyzedTasks: recentTasks.length });
    } catch (err) {
      logger.error('Job catalog suggest failed:', err.message);
      res.status(500).json({ error: 'Failed to generate suggestions' });
    }
  });

  // ─── Import suggested template ─────────────────────────────────────
  router.post('/job-catalog/import', authMiddleware, apiLimiter, (req, res) => {
    const err = validateTemplate(req.body);
    if (err) return res.status(400).json({ error: err.error });

    const { name, description = '', command, parameters = [], category = null, tags = [], priority = 'medium', timeout_ms = 30000 } = req.body;
    const id = randomUUID();
    stmts.insert.run(id, name, description, command, JSON.stringify(parameters), category, JSON.stringify(tags), priority, timeout_ms, req.user?.id || null, 'ai-suggested');
    const row = stmts.getById.get(id);
    broadcast('job-catalog:created', parseTemplate(row));
    audit('import', 'job-catalog', id, req.user?.id, { name, source: 'ai-suggested' });
    res.status(201).json(parseTemplate(row));
  });

  return router;
}
