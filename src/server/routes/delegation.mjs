import express from 'express';
import { randomUUID } from 'crypto';

/**
 * Delegation — Cross-node subagent task delegation
 *
 * Allows the LLM agent (or any API client) to delegate subtasks to other
 * agents, either on the same node or remote nodes via the agent API.
 *
 * Dependencies: db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter,
 *               broadcast, audit, logger, executeTask, sanitizeCommand, ctx
 *
 * Endpoints:
 *   POST /api/delegate              — delegate a subtask to an agent
 *   GET  /api/delegations            — list delegations (filter: parent_id, agent_id, status)
 *   GET  /api/delegations/:id        — delegation details + result
 *   POST /api/delegations/:id/wait   — wait for delegation completion (long-poll, max 30s)
 *   POST /api/delegations/:id/cancel — cancel a pending delegation
 */
export default function delegationRoutes(ctx) {
  const { db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter, broadcast, audit, logger, executeTask, sanitizeCommand } = ctx;
  const router = express.Router();

  // ─── Schema ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegations (
      id TEXT PRIMARY KEY,
      parent_task_id TEXT,
      parent_session_id TEXT,
      child_task_id TEXT,
      agent_id TEXT,
      node TEXT DEFAULT 'local',
      status TEXT DEFAULT 'pending',
      capability TEXT,
      priority TEXT DEFAULT 'medium',
      synchronous INTEGER DEFAULT 0,
      result TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (child_task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegations_parent ON delegations(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_delegations_agent ON delegations(agent_id);
    CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status);
  `);

  const delStmts = {
    insert: db.prepare(`
      INSERT INTO delegations (id, parent_task_id, parent_session_id, child_task_id, agent_id, node, status, capability, priority, synchronous)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getById: db.prepare('SELECT * FROM delegations WHERE id = ?'),
    getByParent: db.prepare('SELECT * FROM delegations WHERE parent_task_id = ? ORDER BY created_at DESC'),
    getByAgent: db.prepare('SELECT * FROM delegations WHERE agent_id = ? ORDER BY created_at DESC'),
    getByStatus: db.prepare('SELECT * FROM delegations WHERE status = ? ORDER BY created_at DESC LIMIT ?'),
    getAll: db.prepare('SELECT * FROM delegations ORDER BY created_at DESC LIMIT ?'),
    updateResult: db.prepare(`
      UPDATE delegations SET status = ?, result = ?, error = ?, completed_at = datetime('now') WHERE id = ?
    `),
    updateStatus: db.prepare('UPDATE delegations SET status = ? WHERE id = ?'),
    getChildTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  };

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Find an available agent matching the required capability.
   * Returns the agent row or null.
   */
  function findAgentByCapability(capability) {
    const agents = stmts.agents.getAll.all().filter(a => a.status === 'active');
    if (!capability) return agents[0] || null;
    return agents.find(a => {
      try {
        const caps = JSON.parse(a.capabilities || '[]');
        return caps.some(c => c.toLowerCase().includes(capability.toLowerCase()));
      } catch { return false; }
    }) || agents[0] || null;
  }

  function parseDelegation(row) {
    if (!row) return null;
    return {
      ...row,
      synchronous: !!row.synchronous,
      result: row.result ? JSON.parse(row.result) : null,
    };
  }

  /**
   * Check if a child task has completed and update the delegation record.
   */
  function syncDelegationStatus(delegationId) {
    const delegation = delStmts.getById.get(delegationId);
    if (!delegation || delegation.status !== 'pending') return null;

    const childTask = delStmts.getChildTask.get(delegation.child_task_id);
    if (!childTask) return null;

    if (childTask.status === 'done' || childTask.status === 'completed') {
      delStmts.updateResult.run('completed', JSON.stringify({ exit_code: childTask.exit_code, result: childTask.result }), null, delegationId);
      broadcast('delegation:completed', { id: delegationId, childTaskId: delegation.child_task_id, status: 'completed' });
      return delStmts.getById.get(delegationId);
    } else if (childTask.status === 'failed' || childTask.status === 'cancelled') {
      delStmts.updateResult.run('failed', null, JSON.stringify({ status: childTask.status, exit_code: childTask.exit_code }), delegationId);
      broadcast('delegation:failed', { id: delegationId, childTaskId: delegation.child_task_id, status: childTask.status });
      return delStmts.getById.get(delegationId);
    }
    return null;
  }

  // ─── Routes ────────────────────────────────────────────────────────

  router.post('/delegate', authMiddleware, apiLimiter, async (req, res) => {
    const { name, command, capability, agentId, parentTaskId, parentSessionId, synchronous = false, priority = 'medium', wait = false, waitTimeout = 30000 } = req.body;

    if (!name || !command) return res.status(400).json({ error: 'Name and command are required' });

    // Sanitize command
    const check = sanitizeCommand(command);
    if (!check.safe) return res.status(400).json({ error: check.error });

    // Find or assign agent
    const agent = agentId
      ? stmts.agents.getById.get(agentId)
      : findAgentByCapability(capability);

    if (!agent && agentId) return res.status(404).json({ error: 'Agent not found' });

    // Create the child task
    const childTaskId = randomUUID();
    const childName = `[delegated] ${name}`;
    stmts.tasks.insert.run(childTaskId, childName, command, 'pending', req.user?.id || null, agent?.id || null);

    // Create delegation record
    const delegationId = randomUUID();
    delStmts.insert.run(
      delegationId,
      parentTaskId || null,
      parentSessionId || null,
      childTaskId,
      agent?.id || null,
      'local',
      'pending',
      capability || null,
      priority,
      synchronous ? 1 : 0
    );

    // Assign to agent if found
    if (agent) {
      stmts.tasks.assignAgent.run(agent.id, childTaskId);
    }

    // Execute the task
    executeTask(childTaskId, command);

    broadcast('delegation:created', { id: delegationId, childTaskId, agentId: agent?.id, capability });
    audit('delegate', 'delegation', delegationId, req.user?.id, { name, command: command.slice(0, 100), agentId: agent?.id });
    logger.info(`Delegation created: ${delegationId} → task ${childTaskId} → agent ${agent?.id || 'auto'}`);

    // If wait mode, poll for completion (max waitTimeout ms)
    if (wait || synchronous) {
      const start = Date.now();
      const pollInterval = 500;
      const maxPolls = Math.ceil(waitTimeout / pollInterval);

      for (let i = 0; i < maxPolls; i++) {
        await new Promise(r => setTimeout(r, pollInterval));
        const updated = syncDelegationStatus(delegationId);
        if (updated) {
          return res.json({
            ...parseDelegation(updated),
            childTask: delStmts.getChildTask.get(childTaskId),
          });
        }
        if (Date.now() - start > waitTimeout) break;
      }

      // Timeout — return pending status
      return res.status(202).json({
        ...parseDelegation(delStmts.getById.get(delegationId)),
        message: 'Delegation still pending — check status later',
      });
    }

    res.status(201).json({
      ...parseDelegation(delStmts.getById.get(delegationId)),
      childTask: delStmts.getChildTask.get(childTaskId),
    });
  });

  router.get('/delegations', optionalAuth, (req, res) => {
    const { parentId, agentId, status, limit = 50 } = req.query;
    let rows;
    if (parentId) rows = delStmts.getByParent.all(parentId);
    else if (agentId) rows = delStmts.getByAgent.all(agentId);
    else if (status) rows = delStmts.getByStatus.all(status, parseInt(limit));
    else rows = delStmts.getAll.all(parseInt(limit));
    res.json(rows.map(parseDelegation));
  });

  router.get('/delegations/:id', optionalAuth, (req, res) => {
    const row = delStmts.getById.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Delegation not found' });
    const result = parseDelegation(row);
    result.childTask = delStmts.getChildTask.get(row.child_task_id);
    res.json(result);
  });

  router.post('/delegations/:id/wait', optionalAuth, async (req, res) => {
    const delegation = delStmts.getById.get(req.params.id);
    if (!delegation) return res.status(404).json({ error: 'Delegation not found' });

    // Try immediate sync
    let updated = syncDelegationStatus(req.params.id);
    if (updated) return res.json(parseDelegation(updated));

    // Poll for up to 30s
    const timeout = parseInt(req.query.timeout) || 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 500));
      updated = syncDelegationStatus(req.params.id);
      if (updated) return res.json(parseDelegation(updated));
    }

    res.status(202).json({ ...parseDelegation(delegation), message: 'Still pending' });
  });

  router.post('/delegations/:id/cancel', authMiddleware, apiLimiter, (req, res) => {
    const delegation = delStmts.getById.get(req.params.id);
    if (!delegation) return res.status(404).json({ error: 'Delegation not found' });
    if (delegation.status !== 'pending') return res.status(409).json({ error: 'Delegation already completed' });

    // Cancel the child task
    if (delegation.child_task_id) {
      stmts.tasks.updateStatus.run('cancelled', null, new Date().toISOString(), 'Cancelled by delegation cancel', -1, delegation.child_task_id);
    }
    delStmts.updateResult.run('cancelled', null, JSON.stringify({ reason: 'Cancelled by user' }), req.params.id);
    broadcast('delegation:cancelled', { id: req.params.id });
    res.json({ id: req.params.id, status: 'cancelled' });
  });

  return router;
}
