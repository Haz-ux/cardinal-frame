import express from 'express';
import { randomUUID } from 'crypto';
import { signPayload, verifyPayload, getOrCreateNodeIdentity } from '../node-identity.mjs';
import { canDelegateToNode } from './governance.mjs';
import { createReportQueue } from '../report-queue.mjs';
import { scoreCommand } from '../warden.mjs';

/**
 * Delegation — Cross-node subagent task delegation
 *
 * Allows the LLM agent (or any API client) to delegate subtasks to other
 * agents, either on the same node or remote nodes via signed payloads.
 *
 * Remote dispatch uses Task 0's Ed25519 signing to ensure:
 * - Outgoing delegations are signed by this node's identity
 * - Incoming delegations are verified against the sender's public key
 * - Result reports are signed and verified
 *
 * Self-owned recovery: each node runs its own local job queue for
 * delegated tasks. If a node crashes mid-task, it resumes on restart
 * without needing Cardinal Frame to tell it to.
 *
 * Dependencies: db, stmts, authMiddleware, optionalAuth, requireRole, apiLimiter,
 *               broadcast, audit, logger, executeTask, sanitizeCommand, ctx
 *
 * Endpoints:
 *   POST /api/delegate              — delegate a subtask to an agent (local or remote)
 *   GET  /api/delegations            — list delegations (filter: parent_id, agent_id, status)
 *   GET  /api/delegations/:id        — delegation details + result
 *   POST /api/delegations/:id/wait   — wait for delegation completion (long-poll, max 30s)
 *   POST /api/delegations/:id/cancel — cancel a pending delegation
 *   POST /api/delegations/:id/report — receive a signed result report from a remote node
 *   POST /api/delegate/receive       — receive a signed delegation from another node (node-side receipt)
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
      signature TEXT,
      reported_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (child_task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegations_parent ON delegations(parent_task_id);
    CREATE INDEX IF NOT EXISTS idx_delegations_agent ON delegations(agent_id);
    CREATE INDEX IF NOT EXISTS idx_delegations_status ON delegations(status);

    CREATE TABLE IF NOT EXISTS remote_task_queue (
      id TEXT PRIMARY KEY,
      delegation_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      command TEXT NOT NULL,
      agent_id TEXT,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      last_error TEXT,
      result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_remote_queue_status ON remote_task_queue(status);
    CREATE INDEX IF NOT EXISTS idx_remote_queue_delegation ON remote_task_queue(delegation_id);
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
      UPDATE delegations SET status = ?, result = ?, error = ?, completed_at = datetime('now'), signature = ?, reported_by = ? WHERE id = ?
    `),
    updateStatus: db.prepare('UPDATE delegations SET status = ? WHERE id = ?'),
    getChildTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    // Remote task queue (node-side durable queue for received delegations)
    queueInsert: db.prepare(`
      INSERT INTO remote_task_queue (id, delegation_id, source_node_id, command, agent_id, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `),
    queueGetPending: db.prepare('SELECT * FROM remote_task_queue WHERE status = ? ORDER BY created_at ASC'),
    queueGetById: db.prepare('SELECT * FROM remote_task_queue WHERE id = ?'),
    queueGetByDelegation: db.prepare('SELECT * FROM remote_task_queue WHERE delegation_id = ?'),
    queueClaim: db.prepare(`UPDATE remote_task_queue SET status = 'running', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ?`),
    queueComplete: db.prepare(`UPDATE remote_task_queue SET status = 'completed', result = ?, completed_at = datetime('now') WHERE id = ?`),
    queueFail: db.prepare(`UPDATE remote_task_queue SET status = CASE WHEN attempts >= max_retries THEN 'dead' ELSE 'pending' END, last_error = ? WHERE id = ?`),
    queueGetDead: db.prepare('SELECT * FROM remote_task_queue WHERE status = ?'),
    queueRecoverStale: db.prepare(`UPDATE remote_task_queue SET status = 'pending', last_error = 'Interrupted by restart' WHERE status = 'running'`),
  };

  // ─── Node identity (lazy init on first use) ───────────────────────
  let _identity = null;
  function getIdentity() {
    if (!_identity) _identity = getOrCreateNodeIdentity(db);
    return _identity;
  }

  // ─── Node registry (lazy init from ctx) ───────────────────────────
  function getRegistry() {
    return ctx.nodeRegistry || null;
  }

  // ─── Report Queue (outbound reports to coordinator) ───────────────
  // Returns coordinator's base_url from the node registry, or null.
  function getCoordinatorUrl() {
    const registry = getRegistry();
    if (!registry) return null;
    // Find the coordinator by looking for a node that is not us
    const ourIdentity = getIdentity();
    const nodes = registry.getAllNodes();
    const coordinator = nodes.find(n => n.id !== ourIdentity.node_id);
    return coordinator?.base_url || null;
  }

  const reportQueue = createReportQueue(db, {
    getCoordinatorUrl: ctx.getCoordinatorUrl || getCoordinatorUrl,
    fetchFn: ctx.fetchFn,
    logger,
  });

  // ─── Helpers ──────────────────────────────────────────────────────

  /**
   * Wait for a task to reach a terminal state by polling the tasks table.
   * executeTask is fire-and-forget (spawns child process, result written
   * asynchronously via child.on('close') callback), so we poll for completion.
   *
   * @param {string} taskId
   * @param {number} timeoutMs — max wait (default 30s)
   * @returns {Promise<{ status: string, exitCode: number, result: string }>}
   */
  function waitForTask(taskId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const pollMs = 200;
      const deadline = Date.now() + timeoutMs;

      function poll() {
        const task = stmts.tasks.getById.get(taskId);
        if (task && (task.status === 'done' || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) {
          resolve({
            status: task.status === 'done' ? 'completed' : task.status,
            exitCode: task.exit_code ?? 0,
            result: task.result || '',
          });
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`));
          return;
        }
        setTimeout(poll, pollMs);
      }
      poll();
    });
  }

  /**
   * Execute a task, wait for it to finish, record the outcome in the
   * remote_task_queue, and enqueue an outbound report to the coordinator.
   * Used by both the fresh-receive path and the startup recovery path.
   *
   * @param {object} task — remote_task_queue row
   * @param {string} childTaskId — the tasks.id to execute
   * @param {string} command — shell command
   */
  async function executeAndReport(task, childTaskId, command) {
    delStmts.queueClaim.run(task.id);
    try {
      executeTask(childTaskId, command);
      const outcome = await waitForTask(childTaskId);
      delStmts.queueComplete.run(JSON.stringify(outcome), task.id);
      reportQueue.queueOutboundReport(task.delegation_id, outcome.status === 'completed' ? 'completed' : 'failed', outcome);
      logger.info(`[recovery] Task ${childTaskId} completed: status=${outcome.status} exit=${outcome.exitCode}`);
    } catch (err) {
      delStmts.queueFail.run(err.message.slice(0, 500), task.id);
      reportQueue.queueOutboundReport(task.delegation_id, 'failed', { error: err.message });
      logger.error(`[recovery] Task ${childTaskId} failed: ${err.message}`);
    }
  }

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
   * syncDelegationStatus — now a passive listener, not an active prober.
   * Only checks local child task status (for local delegations).
   * Remote delegations are updated via the /report endpoint when nodes
   * report back — this function does NOT poll remote nodes.
   */
  function syncDelegationStatus(delegationId) {
    const delegation = delStmts.getById.get(delegationId);
    if (!delegation || delegation.status !== 'pending') return null;

    // Only sync local delegations — remote ones are updated via /report
    if (delegation.node !== 'local') return null;

    const childTask = delStmts.getChildTask.get(delegation.child_task_id);
    if (!childTask) return null;

    if (childTask.status === 'done' || childTask.status === 'completed') {
      delStmts.updateResult.run('completed', JSON.stringify({ exit_code: childTask.exit_code, result: childTask.result }), null, null, null, delegationId);
      broadcast('delegation:completed', { id: delegationId, childTaskId: delegation.child_task_id, status: 'completed' });
      return delStmts.getById.get(delegationId);
    } else if (childTask.status === 'failed' || childTask.status === 'cancelled') {
      delStmts.updateResult.run('failed', null, JSON.stringify({ status: childTask.status, exit_code: childTask.exit_code }), null, null, delegationId);
      broadcast('delegation:failed', { id: delegationId, childTaskId: delegation.child_task_id, status: childTask.status });
      return delStmts.getById.get(delegationId);
    }
    return null;
  }

  /**
   * Dispatch a delegation to a remote node via signed HTTP payload.
   * Falls back to local execution if the remote dispatch fails.
   *
   * @returns {Promise<{ ok: boolean, node?: string, error?: string }>}
   */
  async function dispatchToRemoteNode(delegationId, payload, targetNode) {
    const identity = getIdentity();
    const signature = signPayload(identity.private_key_pem, payload);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(`${targetNode.base_url}/api/delegate/receive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, signature, source_node_id: identity.node_id }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { ok: false, error: `Remote node rejected: ${body.error || resp.status}` };
      }

      return { ok: true, node: targetNode.name };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ─── Routes ────────────────────────────────────────────────────────

  router.post('/delegate', authMiddleware, apiLimiter, async (req, res) => {
    const { name, command, capability, agentId, parentTaskId, parentSessionId, synchronous = false, priority = 'medium', wait = false, waitTimeout = 30000, node: requestedNode } = req.body;

    if (!name || !command) return res.status(400).json({ error: 'Name and command are required' });

    const check = sanitizeCommand(command);
    if (!check.safe) return res.status(400).json({ error: check.error });

    // WARDEN risk gate — block high-risk, require explicit approval for medium-risk
    const warden = scoreCommand(command);
    audit('delegate', 'warden:command', command, req.user?.id, { score: warden.score, level: warden.level, verdict: warden.verdict, reasons: warden.reasons });
    if (warden.verdict === 'block') {
      return res.status(403).json({ error: 'WARDEN: high-risk command blocked', warden });
    }
    if (warden.verdict === 'approve' && req.body?.warden_approve !== true) {
      const approvalId = randomUUID();
      stmts.warden.insert.run(approvalId, 'delegate', 'execute', JSON.stringify({ command }), JSON.stringify(warden), 'pending', req.user?.username || null);
      broadcast('warden:approval_required', { approval_id: approvalId, scope: 'delegate', warden });
      return res.status(403).json({
        error: 'WARDEN: command requires explicit approval',
        needs_approval: true,
        approval_id: approvalId,
        warden,
      });
    }

    // Find or assign agent
    const agent = agentId
      ? stmts.agents.getById.get(agentId)
      : findAgentByCapability(capability);

    if (!agent && agentId) return res.status(404).json({ error: 'Agent not found' });

    // ─── Node selection: try remote first, fall back to local ───
    let targetNode = null;
    let dispatchMode = 'local';

    const registry = getRegistry();
    if (registry && !requestedNode) {
      // Use the registry to find a reachable node with the required capability
      targetNode = registry.getReachableNode(capability);
      if (targetNode) {
        dispatchMode = 'remote';
      } else {
        // No reachable node — queue locally as awaiting_node
        dispatchMode = 'awaiting_node';
      }
    } else if (registry && requestedNode) {
      // Explicit node requested by name
      targetNode = registry.getNodeByName(requestedNode);
      if (targetNode && targetNode.status === 'online') {
        dispatchMode = 'remote';
      } else {
        dispatchMode = 'awaiting_node';
      }
    }

    // Create the child task
    const childTaskId = randomUUID();
    const childName = `[delegated] ${name}`;
    stmts.tasks.insert.run(childTaskId, childName, command, 'pending', req.user?.id || null, agent?.id || null);

    // Create delegation record
    const delegationId = randomUUID();
    const nodeValue = dispatchMode === 'remote' ? targetNode.name : 'local';
    const initialStatus = dispatchMode === 'awaiting_node' ? 'awaiting_node' : 'pending';

    delStmts.insert.run(
      delegationId,
      parentTaskId || null,
      parentSessionId || null,
      childTaskId,
      agent?.id || null,
      nodeValue,
      initialStatus,
      capability || null,
      priority,
      synchronous ? 1 : 0
    );

    if (agent) {
      stmts.tasks.assignAgent.run(agent.id, childTaskId);
    }

    // ─── Dispatch ───
    if (dispatchMode === 'remote' && targetNode) {
      // ─── Governance check: is this agent allowed to delegate to this node? ───
      const persona = agent?.id
        ? ctx.stmts.governance?.personas?.getByAgent?.get(agent.id)
        : null;
      const govCheck = canDelegateToNode(persona, targetNode.name);
      if (!govCheck.allowed) {
        audit('delegation_denied', 'node', targetNode.name, req.user?.id, {
          delegation_id: delegationId,
          agent_id: agent?.id || null,
          target_node: targetNode.name,
          reason: govCheck.reason,
        });
        logger.warn(`Delegation to ${targetNode.name} denied by governance: ${govCheck.reason}`);
        // Fall back to local execution
        dispatchMode = 'local';
        delStmts.updateStatus.run('pending', delegationId);
        executeTask(childTaskId, command);
        broadcast('delegation:denied', { id: delegationId, target_node: targetNode.name, reason: govCheck.reason });
      } else {
        // Sign and send the delegation to the remote node
        const payload = {
          delegation_id: delegationId,
          child_task_id: childTaskId,
          name: childName,
          command,
          capability,
          agent_id: agent?.id || null,
          priority,
          synchronous,
          parent_task_id: parentTaskId || null,
          parent_session_id: parentSessionId || null,
          timestamp: new Date().toISOString(),
        };

        const result = await dispatchToRemoteNode(delegationId, payload, targetNode);

        if (!result.ok) {
          logger.warn(`Remote dispatch to ${targetNode.name} failed: ${result.error} — falling back to local`);
          delStmts.updateStatus.run('pending', delegationId);
          executeTask(childTaskId, command);
        } else {
          broadcast('delegation:created', { id: delegationId, childTaskId, agentId: agent?.id, capability, node: targetNode.name });
          audit('delegate', 'delegation', delegationId, req.user?.id, { name, command: command.slice(0, 100), agentId: agent?.id, node: targetNode.name });
          logger.info(`Delegation dispatched to remote node ${targetNode.name}: ${delegationId} → task ${childTaskId}`);

          if (wait || synchronous) {
            const start = Date.now();
            while (Date.now() - start < waitTimeout) {
              await new Promise(r => setTimeout(r, 500));
              const d = delStmts.getById.get(delegationId);
              if (d && d.status !== 'pending') {
                return res.json({ ...parseDelegation(d), childTask: delStmts.getChildTask.get(childTaskId) });
              }
            }
            return res.status(202).json({ ...parseDelegation(delStmts.getById.get(delegationId)), message: 'Delegation dispatched to remote node — still pending' });
          }

          return res.status(201).json({ ...parseDelegation(delStmts.getById.get(delegationId)), childTask: delStmts.getChildTask.get(childTaskId) });
        }
      }
    } else if (dispatchMode === 'awaiting_node') {
      // No reachable node — queue locally but mark as awaiting_node
      delStmts.updateStatus.run('awaiting_node', delegationId);
      // Still execute locally as fallback
      executeTask(childTaskId, command);
      broadcast('delegation:queued', { id: delegationId, childTaskId, capability, reason: 'No reachable remote node' });
      logger.info(`Delegation queued (no reachable node): ${delegationId} → executing locally as fallback`);
    } else {
      // Local execution
      executeTask(childTaskId, command);
    }

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

  // ─── Node-side receipt: receive a signed delegation from another node ───
  router.post('/delegate/receive', async (req, res) => {
    const { payload, signature, source_node_id } = req.body;

    if (!payload || !signature || !source_node_id) {
      return res.status(400).json({ error: 'payload, signature, and source_node_id are required' });
    }

    // Look up the source node's public key from the registry
    const registry = getRegistry();
    if (!registry) {
      return res.status(503).json({ error: 'Node registry not available on this node' });
    }

    const sourceNode = registry.getNode(source_node_id);
    if (!sourceNode) {
      audit('delegation_rejected', 'node', source_node_id, null, { reason: 'Unknown source node' });
      return res.status(403).json({ error: 'Unknown source node — not in registry' });
    }

    // Verify the payload signature against the source node's public key
    const isValid = verifyPayload(sourceNode.public_key_pem, payload, signature);
    if (!isValid) {
      audit('delegation_rejected', 'node', source_node_id, null, { reason: 'Signature verification failed' });
      logger.warn(`Delegation from ${sourceNode.name} rejected — signature verification failed`);
      return res.status(403).json({ error: 'Signature verification failed — delegation rejected' });
    }

    // Signature verified — write to local durable queue
    const queueId = randomUUID();
    delStmts.queueInsert.run(
      queueId,
      payload.delegation_id,
      source_node_id,
      payload.command,
      payload.agent_id || null,
    );

    // Create a local task for this delegation
    const childTaskId = payload.child_task_id || randomUUID();
    stmts.tasks.insert.run(
      childTaskId,
      payload.name || `[delegated from ${sourceNode.name}]`,
      payload.command,
      'pending',
      null,
      payload.agent_id || null,
    );

    // Also create a delegation record (so /report can find it)
    const existingDel = delStmts.getById.get(payload.delegation_id);
    if (!existingDel) {
      delStmts.insert.run(
        payload.delegation_id,
        payload.parent_task_id || null,
        payload.parent_session_id || null,
        childTaskId,
        payload.agent_id || null,
        sourceNode.name,
        'running',
        payload.capability || null,
        payload.priority || 'medium',
        payload.synchronous ? 1 : 0,
      );
    }

    // Execute the task locally on this node, wait for outcome, and
    // enqueue an outbound report to the coordinator (best-effort).
    // executeAndReport is async but we don't await it here — the HTTP
    // response returns 202 Accepted immediately, and the report goes
    // out when the task finishes.
    const queueRow = delStmts.queueGetById.get(queueId);
    executeAndReport(queueRow, childTaskId, payload.command).catch((err) => {
      logger.error(`[receive] executeAndReport error: ${err.message}`);
    });

    broadcast('delegation:received', { delegation_id: payload.delegation_id, source: sourceNode.name });
    logger.info(`Delegation received from ${sourceNode.name}: ${payload.delegation_id} → task ${childTaskId}`);

    res.status(202).json({ ok: true, delegation_id: payload.delegation_id, status: 'accepted' });
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

    let updated = syncDelegationStatus(req.params.id);
    if (updated) return res.json(parseDelegation(updated));

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
    if (delegation.status !== 'pending' && delegation.status !== 'awaiting_node' && delegation.status !== 'running') {
      return res.status(409).json({ error: 'Delegation already completed' });
    }

    if (delegation.child_task_id) {
      stmts.tasks.updateStatus.run('cancelled', null, new Date().toISOString(), 'Cancelled by delegation cancel', -1, delegation.child_task_id);
    }
    delStmts.updateResult.run('cancelled', null, JSON.stringify({ reason: 'Cancelled by user' }), null, null, req.params.id);
    broadcast('delegation:cancelled', { id: req.params.id });
    res.json({ id: req.params.id, status: 'cancelled' });
  });

  // ─── Receive a signed result report from a remote node ───
  // This is the "reporting back" step — best-effort, not load-bearing.
  // The node completes the task on its own and reports here when reachable.
  router.post('/delegations/:id/report', async (req, res) => {
    const { payload, signature, source_node_id } = req.body;

    if (!payload || !signature || !source_node_id) {
      return res.status(400).json({ error: 'payload, signature, and source_node_id are required' });
    }

    const delegation = delStmts.getById.get(req.params.id);
    if (!delegation) {
      return res.status(404).json({ error: 'Delegation not found' });
    }

    // Verify the report signature against the source node's public key
    const registry = getRegistry();
    if (!registry) {
      return res.status(503).json({ error: 'Node registry not available' });
    }

    const sourceNode = registry.getNode(source_node_id);
    if (!sourceNode) {
      return res.status(403).json({ error: 'Unknown source node' });
    }

    const isValid = verifyPayload(sourceNode.public_key_pem, payload, signature);
    if (!isValid) {
      audit('delegation_report_rejected', 'node', source_node_id, null, { delegation_id: req.params.id, reason: 'Signature verification failed' });
      logger.warn(`Report from ${sourceNode.name} for delegation ${req.params.id} rejected — invalid signature`);
      return res.status(403).json({ error: 'Report signature verification failed' });
    }

    // Signature verified — accept the result report
    const { status, result, error } = payload;
    delStmts.updateResult.run(
      status,
      result ? JSON.stringify(result) : null,
      error || null,
      signature,
      source_node_id,
      req.params.id,
    );

    broadcast('delegation:reported', { id: req.params.id, status, source: sourceNode.name });
    audit('delegation_reported', 'delegation', req.params.id, null, { status, source_node: sourceNode.name });
    logger.info(`Delegation ${req.params.id} reported back from ${sourceNode.name} — status: ${status}`);

    res.json({ ok: true, id: req.params.id, status });
  });

  // ─── Remote task queue management (for node-side self-recovery) ───

  /**
   * Resume interrupted remote tasks after a restart.
   * Exported on the router so tests can invoke it directly rather than
   * re-running the factory. Each recovered task is awaited, its real
   * outcome is recorded in remote_task_queue, and an outbound report
   * is enqueued for the coordinator.
   */
  async function recoverInterruptedTasks() {
    const stale = delStmts.queueRecoverStale.run();
    if (stale.changes > 0) {
      logger.info(`Recovered ${stale.changes} interrupted remote task(s) after restart`);
    }
    const pending = delStmts.queueGetPending.all('pending');
    for (const task of pending) {
      const delegation = delStmts.getById.get(task.delegation_id);
      if (delegation && delegation.child_task_id) {
        await executeAndReport(task, delegation.child_task_id, task.command);
      }
    }
  }

  // Run recovery on startup (don't block server boot — fire and forget)
  recoverInterruptedTasks().catch((err) => {
    logger.error(`[recovery] Startup recovery error: ${err.message}`);
  });

  // Start the periodic report flusher
  reportQueue.scheduleReportFlush();

  // Expose recovery function and report queue on the router for testing
  router._recoverInterruptedTasks = recoverInterruptedTasks;
  router._reportQueue = reportQueue;

  return router;
}
