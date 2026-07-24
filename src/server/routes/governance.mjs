/**
 * Cardinal Frame — Governance Layer
 *
 * Persona management, granular permissions, and SOUL docs.
 * SOUL = machine-readable behavioral rules that constrain agent actions.
 *
 * Dependencies: db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast
 */

import express from 'express';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    soul TEXT DEFAULT '{}',
    permissions TEXT DEFAULT '[]',
    constraints TEXT DEFAULT '[]',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT DEFAULT '{}',
    trace_id TEXT,
    ts TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_personas_agent ON personas(agent_id);
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`;

// Default SOUL template — constrains agent behavior
const DEFAULT_SOUL = {
  identity: '',
  principles: [],
  boundaries: [
    'Never execute commands not in the allowed list',
    'Never access files outside the workspace',
    'Never expose secrets or API keys',
    'Never modify system files',
  ],
  escalation: {
    require_approval_for: ['rm', 'sudo', 'chmod', 'chown', 'mkfs'],
    auto_approve: ['echo', 'ls', 'cat', 'pwd', 'date', 'grep', 'wc'],
  },
};

export function initGovernance(db) {
  db.exec(SCHEMA);
  return {
    personas: {
      getAll: db.prepare('SELECT * FROM personas ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM personas WHERE id = ?'),
      getByAgent: db.prepare('SELECT * FROM personas WHERE agent_id = ? AND enabled = 1'),
      insert: db.prepare(
        `INSERT INTO personas (id, agent_id, name, description, soul, permissions, constraints, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      ),
      update: db.prepare(
        `UPDATE personas SET name = ?, description = ?, soul = ?, permissions = ?, constraints = ?,
         enabled = ?, updated_at = datetime('now') WHERE id = ?`
      ),
      delete: db.prepare('DELETE FROM personas WHERE id = ?'),
    },
    audit: {
      insert: db.prepare('INSERT INTO audit_log (actor, action, target, details, trace_id) VALUES (?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?'),
      getByActor: db.prepare('SELECT * FROM audit_log WHERE actor = ? ORDER BY ts DESC LIMIT ?'),
      getByTrace: db.prepare('SELECT * FROM audit_log WHERE trace_id = ? ORDER BY ts'),
    },
  };
}

/**
 * Check if an action is permitted by the agent's persona.
 * Returns { allowed: boolean, reason?: string }
 */
export function checkPermission(persona, action, target) {
  if (!persona || !persona.enabled) {
    return { allowed: true, reason: 'No persona restrictions' };
  }

  const perms = JSON.parse(persona.permissions || '[]');
  const constraints = JSON.parse(persona.constraints || '[]');
  const soul = JSON.parse(persona.soul || '{}');

  // Check explicit deny constraints
  for (const constraint of constraints) {
    if (typeof constraint === 'string' && action.match(new RegExp(constraint, 'i'))) {
      return { allowed: false, reason: `Denied by constraint: ${constraint}` };
    }
  }

  // Check escalation requirements
  const escalation = soul.escalation || {};
  const requiresApproval = (escalation.require_approval_for || []);
  if (requiresApproval.some(cmd => action.includes(cmd))) {
    return { allowed: false, reason: `Requires approval: ${action}`, requiresApproval: true };
  }

  // If permissions list is non-empty, action must be in the list
  if (perms.length > 0 && !perms.includes(action)) {
    return { allowed: false, reason: `Action '${action}' not in allowed permissions` };
  }

  return { allowed: true };
}

/**
 * Log an auditable action
 */
export function auditLog(stmts, actor, action, target = null, details = {}, traceId = null) {
  try {
    stmts.governance.audit.insert.run(actor, action, target, JSON.stringify(details), traceId);
  } catch { /* non-critical */ }
}

export default function governanceRoutes(ctx) {
  const { stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast } = ctx;
  const router = express.Router();

  // ─── Persona CRUD ────────────────────────────────────────────────

  // GET /api/governance/personas
  router.get('/governance/personas', authMiddleware, (_req, res) => {
    res.json(stmts.governance.personas.getAll.all());
  });

  // GET /api/governance/personas/:id
  router.get('/governance/personas/:id', authMiddleware, (req, res) => {
    const persona = stmts.governance.personas.getById.get(req.params.id);
    if (!persona) return res.status(404).json({ error: 'Persona not found' });
    res.json(persona);
  });

  // POST /api/governance/personas — create persona
  router.post('/governance/personas', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { id, agent_id, name, description = '', soul = DEFAULT_SOUL, permissions = [], constraints = [] } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });

    try {
      stmts.governance.personas.insert.run(
        id, agent_id || null, name, description,
        JSON.stringify(soul), JSON.stringify(permissions), JSON.stringify(constraints)
      );
      auditLog(stmts, req.user.username, 'persona:create', id);
      broadcast?.('governance:persona:created', { id, name });
      res.json({ success: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/governance/personas/:id — update persona
  router.put('/governance/personas/:id', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const { name, description = '', soul, permissions, constraints, enabled = 1 } = req.body;
    const existing = stmts.governance.personas.getById.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Persona not found' });

    try {
      stmts.governance.personas.update.run(
        name ?? existing.name,
        description ?? existing.description,
        JSON.stringify(soul ?? JSON.parse(existing.soul)),
        JSON.stringify(permissions ?? JSON.parse(existing.permissions)),
        JSON.stringify(constraints ?? JSON.parse(existing.constraints)),
        enabled ? 1 : 0,
        req.params.id
      );
      auditLog(stmts, req.user.username, 'persona:update', req.params.id);
      broadcast?.('governance:persona:updated', { id: req.params.id });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/governance/personas/:id
  router.delete('/governance/personas/:id', authMiddleware, requireRole('admin'), (req, res) => {
    const existing = stmts.governance.personas.getById.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Persona not found' });

    stmts.governance.personas.delete.run(req.params.id);
    auditLog(stmts, req.user.username, 'persona:delete', req.params.id);
    broadcast?.('governance:persona:deleted', { id: req.params.id });
    res.json({ success: true });
  });

  // ─── Permission Check ────────────────────────────────────────────

  // POST /api/governance/check — check if an action is allowed
  router.post('/governance/check', authMiddleware, (req, res) => {
    const { persona_id, action, target } = req.body;
    const persona = persona_id ? stmts.governance.personas.getById.get(persona_id) : null;
    const result = checkPermission(persona, action, target);
    auditLog(stmts, req.user.username, 'permission:check', action, { persona_id, allowed: result.allowed });
    res.json(result);
  });

  // ─── Audit Log ───────────────────────────────────────────────────

  // GET /api/governance/audit?limit=100&actor=username&trace_id=xxx
  router.get('/governance/audit', authMiddleware, requireRole('admin'), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const actor = req.query.actor;
    const traceId = req.query.trace_id;
    if (traceId) {
      res.json(stmts.governance.audit.getByTrace.all(traceId));
    } else if (actor) {
      res.json(stmts.governance.audit.getByActor.all(actor, limit));
    } else {
      res.json(stmts.governance.audit.getAll.all(limit));
    }
  });

  return router;
}
