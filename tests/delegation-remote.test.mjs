/**
 * Tests for Remote Delegation — dispatch, signature verification,
 * node-side self-recovery, and best-effort result reporting.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { createServer } from 'node:http';
import { getOrCreateNodeIdentity, signPayload, verifyPayload } from '../src/server/node-identity.mjs';
import { initNodeRegistry } from '../src/server/node-registry.mjs';

// --- Test infra: build a minimal standalone app with delegation routes ---

async function createTestApp(db, registry) {
  const app = express();
  app.use(express.json());

  // Minimal stmts mock
  const stmts = {
    agents: {
      getAll: { all: () => [{ id: 'agent-1', name: 'Aimi', status: 'active', capabilities: '["code","analysis"]' }] },
      getById: { get: (id) => id === 'agent-1' ? { id: 'agent-1', name: 'Aimi', status: 'active', capabilities: '["code"]' } : null },
    },
    tasks: {
      insert: { run: (id, name, cmd, status, user, agent) => { db.prepare('INSERT OR IGNORE INTO tasks (id, name, command, status, assigned_to) VALUES (?, ?, ?, ?, ?)').run(id, name, cmd, status, agent) } },
      assignAgent: { run: (agentId, taskId) => { db.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(agentId, taskId) } },
      updateStatus: { run: (status, exit, ts, msg, code, id) => { db.prepare('UPDATE tasks SET status = ?, exit_code = ?, completed_at = ?, result = ?, exit_code2 = ? WHERE id = ?').run(status, code, ts, msg, code, id) } },
      getById: { get: (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) },
      getAll: { all: () => db.prepare('SELECT * FROM tasks').all() },
    },
  };

  // Create tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT,
      command TEXT,
      status TEXT DEFAULT 'pending',
      assigned_to TEXT,
      exit_code INTEGER,
      exit_code2 INTEGER,
      result TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  let executeTaskCalled = [];
  const executeTask = (taskId, command) => {
    executeTaskCalled.push({ taskId, command });
    // Simulate task completion for local execution
    db.prepare("UPDATE tasks SET status = 'done', exit_code = 0, result = 'ok', completed_at = datetime('now') WHERE id = ?").run(taskId);
  };

  const audit = () => {};
  const broadcast = () => {};
  const logger = { info: () => {}, warn: () => {}, error: () => {} };

  const ctx = {
    db, stmts, audit, broadcast, logger, executeTask,
    sanitizeCommand: (cmd) => ({ safe: true }),
    authMiddleware: (req, res, next) => { req.user = { id: 'test-user', username: 'admin' }; next(); },
    optionalAuth: (req, res, next) => { req.user = { id: 'test-user' }; next(); },
    requireRole: () => (req, res, next) => next(),
    apiLimiter: (req, res, next) => next(),
    nodeRegistry: registry,
  };

  // Import and mount delegation routes
  const delegationRoutes = (await import('../src/server/routes/delegation.mjs')).default;
  app.use('/api', delegationRoutes(ctx));

  return { app, executeTaskCalled, stmts };
}

describe('Remote Delegation — dispatch with signed payloads', () => {
  let db, registry, testApp, server, baseUrl;
  let coordinatorIdentity, workerIdentity;
  let workerDb, workerRegistry, workerApp, workerServer, workerBaseUrl;

  beforeAll(async () => {
    // Coordinator (Cardinal Frame) setup
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    coordinatorIdentity = getOrCreateNodeIdentity(db);
    registry = initNodeRegistry(db);

    testApp = await createTestApp(db, registry);
    server = createServer(testApp.app);
    await new Promise(r => server.listen(0, r));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;

    // Worker node setup (separate identity, separate DB)
    workerDb = new Database(':memory:');
    workerDb.pragma('journal_mode = WAL');
    workerIdentity = getOrCreateNodeIdentity(workerDb);
    workerRegistry = initNodeRegistry(workerDb);

    // Start worker server first so we have a real base_url
    workerApp = await createTestApp(workerDb, workerRegistry);
    workerServer = createServer(workerApp.app);
    await new Promise(r => workerServer.listen(0, r));
    const workerPort = workerServer.address().port;
    workerBaseUrl = `http://localhost:${workerPort}`;

    // Now register the worker in the coordinator's registry (with real URL)
    registry.registerNode({
      id: workerIdentity.node_id,
      name: 'WORKER',
      base_url: workerBaseUrl,
      public_key_pem: workerIdentity.public_key_pem,
      capabilities: ['code', 'analysis'],
    });
    // Mark worker as online for getReachableNode to find it
    db.prepare('UPDATE nodes SET status = ? WHERE id = ?').run('online', workerIdentity.node_id);

    // Register coordinator in worker's registry
    workerRegistry.registerNode({
      id: coordinatorIdentity.node_id,
      name: 'COORDINATOR',
      base_url: baseUrl,
      public_key_pem: coordinatorIdentity.public_key_pem,
      capabilities: ['code'],
    });
  });

  afterAll(() => {
    server?.close();
    workerServer?.close();
    db?.close();
    workerDb?.close();
  });

  it('should dispatch a delegation to a remote node via signed payload', async () => {
    // Trigger remote dispatch by calling /delegate with a capability the worker has
    const resp = await fetch(`${baseUrl}/api/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test task',
        command: 'echo hello',
        capability: 'code',
      }),
    });

    expect(resp.ok || resp.status === 201).toBe(true);
    const body = await resp.json();
    expect(body.id).toBeTruthy();
    expect(body.node).toBe('WORKER'); // dispatched to remote node
  });

  it('should reject a delegation received with an invalid signature', async () => {
    const payload = {
      delegation_id: 'test-bad-sig-123',
      child_task_id: 'child-bad-sig',
      name: '[delegated] bad sig task',
      command: 'echo test',
      capability: 'code',
      agent_id: null,
      priority: 'medium',
      synchronous: false,
      timestamp: new Date().toISOString(),
    };

    // Sign with coordinator's key but send to worker — worker should verify against coordinator's public key
    const signature = signPayload(coordinatorIdentity.private_key_pem, payload);

    // Tamper with signature
    const tamperedSig = signature.slice(0, -4) + 'AAAA';

    const resp = await fetch(`${workerBaseUrl}/api/delegate/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, signature: tamperedSig, source_node_id: coordinatorIdentity.node_id }),
    });

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toContain('Signature verification failed');
  });

  it('should reject a delegation from an unknown source node', async () => {
    const payload = {
      delegation_id: 'test-unknown-123',
      child_task_id: 'child-unknown',
      name: '[delegated] unknown source',
      command: 'echo test',
      timestamp: new Date().toISOString(),
    };

    // Sign with coordinator's key
    const signature = signPayload(coordinatorIdentity.private_key_pem, payload);

    // Send with a fake source_node_id not in worker's registry
    const resp = await fetch(`${workerBaseUrl}/api/delegate/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, signature, source_node_id: 'fake-node-id-not-registered' }),
    });

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toContain('Unknown source node');
  });

  it('should reject a delegation with missing signature field', async () => {
    const payload = {
      delegation_id: 'test-no-sig-123',
      command: 'echo test',
      timestamp: new Date().toISOString(),
    };

    const resp = await fetch(`${workerBaseUrl}/api/delegate/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, source_node_id: coordinatorIdentity.node_id }),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain('required');
  });

  it('should accept a properly signed delegation on the worker node', async () => {
    const payload = {
      delegation_id: 'test-good-123',
      child_task_id: 'child-good-123',
      name: '[delegated] good task',
      command: 'echo hello from coordinator',
      capability: 'code',
      agent_id: null,
      priority: 'medium',
      synchronous: false,
      timestamp: new Date().toISOString(),
    };

    const signature = signPayload(coordinatorIdentity.private_key_pem, payload);

    const resp = await fetch(`${workerBaseUrl}/api/delegate/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, signature, source_node_id: coordinatorIdentity.node_id }),
    });

    expect(resp.status).toBe(202);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.delegation_id).toBe('test-good-123');
  });
});

describe('Remote Delegation — result reporting', () => {
  let coordDb, coordRegistry, coordApp, coordServer, coordUrl;
  let workerDb, workerIdentity, workerRegistry, workerApp, workerServer, workerUrl;
  let coordIdentity;

  beforeAll(async () => {
    coordDb = new Database(':memory:');
    coordDb.pragma('journal_mode = WAL');
    coordIdentity = getOrCreateNodeIdentity(coordDb);
    coordRegistry = initNodeRegistry(coordDb);
    coordApp = await createTestApp(coordDb, coordRegistry);
    coordServer = createServer(coordApp.app);
    await new Promise(r => coordServer.listen(0, r));
    coordUrl = `http://localhost:${coordServer.address().port}`;

    workerDb = new Database(':memory:');
    workerDb.pragma('journal_mode = WAL');
    workerIdentity = getOrCreateNodeIdentity(workerDb);
    workerRegistry = initNodeRegistry(workerDb);
    workerApp = await createTestApp(workerDb, workerRegistry);
    workerServer = createServer(workerApp.app);
    await new Promise(r => workerServer.listen(0, r));
    workerUrl = `http://localhost:${workerServer.address().port}`;

    // Cross-register
    coordRegistry.registerNode({
      id: workerIdentity.node_id, name: 'WORKER', base_url: workerUrl,
      public_key_pem: workerIdentity.public_key_pem, capabilities: ['code'],
    });
    workerRegistry.registerNode({
      id: coordIdentity.node_id, name: 'COORD', base_url: coordUrl,
      public_key_pem: coordIdentity.public_key_pem, capabilities: ['code'],
    });
  });

  afterAll(() => {
    coordServer?.close();
    workerServer?.close();
    coordDb?.close();
    workerDb?.close();
  });

  it('should accept a signed result report from a remote node', async () => {
    // First create a delegation manually in coordDb
    const delegationId = 'test-report-123';
    const childTaskId = 'child-report-123';
    coordDb.prepare(`INSERT INTO tasks (id, name, command, status) VALUES (?, ?, ?, ?)`).run(childTaskId, 'test', 'echo test', 'pending');
    coordDb.prepare(`INSERT INTO delegations (id, child_task_id, node, status) VALUES (?, ?, ?, ?)`).run(delegationId, childTaskId, 'WORKER', 'running');

    // Worker completes the task and reports back
    const reportPayload = {
      delegation_id: delegationId,
      status: 'completed',
      result: { exit_code: 0, output: 'hello from worker' },
      timestamp: new Date().toISOString(),
    };
    const signature = signPayload(workerIdentity.private_key_pem, reportPayload);

    const resp = await fetch(`${coordUrl}/api/delegations/${delegationId}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: reportPayload, signature, source_node_id: workerIdentity.node_id }),
    });

    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('completed');

    // Verify the delegation record was updated
    const del = coordDb.prepare('SELECT * FROM delegations WHERE id = ?').get(delegationId);
    expect(del.status).toBe('completed');
    expect(JSON.parse(del.result)).toEqual({ exit_code: 0, output: 'hello from worker' });
    expect(del.signature).toBe(signature);
    expect(del.reported_by).toBe(workerIdentity.node_id);
  });

  it('should reject a result report with an invalid signature', async () => {
    const delegationId = 'test-bad-report-123';
    coordDb.prepare(`INSERT INTO tasks (id, name, command, status) VALUES (?, ?, ?, ?)`).run('child-bad-report', 'test', 'echo test', 'pending');
    coordDb.prepare(`INSERT INTO delegations (id, child_task_id, node, status) VALUES (?, ?, ?, ?)`).run(delegationId, 'child-bad-report', 'WORKER', 'running');

    const reportPayload = {
      delegation_id: delegationId,
      status: 'completed',
      result: { exit_code: 0, output: 'forged' },
      timestamp: new Date().toISOString(),
    };

    // Create a separate identity to sign with (not the registered worker)
    const forgeDb = new Database(':memory:');
    const forgeIdentity = getOrCreateNodeIdentity(forgeDb);
    const signature = signPayload(forgeIdentity.private_key_pem, reportPayload);

    const resp = await fetch(`${coordUrl}/api/delegations/${delegationId}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: reportPayload, signature, source_node_id: workerIdentity.node_id }),
    });

    expect(resp.status).toBe(403);
    forgeDb.close();
  });
});

describe('Remote Delegation — self-recovery from local durable queue', () => {
  it('should recover interrupted remote tasks on restart — exercises real recovery code', async () => {
    // Build a real DB with delegation routes' actual schema
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');

    // Create tasks table (needed by stmts mock)
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, name TEXT, command TEXT, status TEXT DEFAULT 'pending',
        assigned_to TEXT, exit_code INTEGER, result TEXT, completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Mock executeTask — simulates the task completing after a short delay
    // by writing directly to the tasks table (mimics child.on('close') callback)
    let executeTaskCallCount = 0;
    const executeTask = (taskId, command) => {
      executeTaskCallCount++;
      setTimeout(() => {
        db.prepare("UPDATE tasks SET status = 'done', exit_code = 0, result = 'recovered output', completed_at = datetime('now') WHERE id = ?")
          .run(taskId);
      }, 100); // 100ms delay to simulate real execution
    };

    // Track fetch calls — reject first 2 (coordinator unreachable), then succeed
    let fetchCallCount = 0;
    let coordinatorDelegationStatus = null;
    const mockFetch = async (url, opts) => {
      fetchCallCount++;
      if (fetchCallCount <= 2) {
        throw new Error('ECONNREFUSED — coordinator unreachable');
      }
      // Third call succeeds — coordinator accepts the report
      const body = JSON.parse(opts.body);
      coordinatorDelegationStatus = body.payload.status;
      return { ok: true, json: async () => ({ ok: true, status: body.payload.status }) };
    };

    const stmts = {
      agents: {
        getAll: { all: () => [] },
        getById: { get: () => null },
      },
      tasks: {
        insert: { run: (id, name, cmd, status, user, agent) => { db.prepare('INSERT OR IGNORE INTO tasks (id, name, command, status, assigned_to) VALUES (?, ?, ?, ?, ?)').run(id, name, cmd, status, agent) } },
        assignAgent: { run: () => {} },
        updateStatus: { run: () => {} },
        getById: { get: (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) },
        getAll: { all: () => db.prepare('SELECT * FROM tasks').all() },
      },
    };

    const ctx = {
      db, stmts, executeTask,
      audit: () => {}, broadcast: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      sanitizeCommand: (cmd) => ({ safe: true, command: cmd }),
      authMiddleware: (req, res, next) => { req.user = { id: 'test' }; next(); },
      optionalAuth: (req, res, next) => { req.user = { id: 'test' }; next(); },
      requireRole: () => (req, res, next) => next(),
      apiLimiter: (req, res, next) => next(),
      nodeRegistry: null, // no registry on this node — it's the worker
    };

    // Mount the real delegation routes — this creates the schema and
    // runs startup recovery (which should find no stale tasks yet)
    const delegationRoutes = (await import('../src/server/routes/delegation.mjs')).default;
    const router = delegationRoutes(ctx);

    // The startup recovery ran with no stale tasks — now simulate a crash
    // by inserting a 'running' task that was interrupted.
    // INSERT ORDER MATTERS: tasks before delegations (FK constraint)
    db.prepare(`INSERT INTO tasks (id, name, command, status) VALUES (?, ?, ?, ?)`)
      .run('child-test-1', 'recovered task', 'echo hello', 'pending');

    db.prepare(`INSERT INTO delegations (id, child_task_id, node, status) VALUES (?, ?, ?, ?)`)
      .run('del-test-1', 'child-test-1', 'COORDINATOR', 'running');

    db.prepare(`INSERT INTO remote_task_queue (id, delegation_id, source_node_id, command, status, attempts) VALUES (?, ?, ?, ?, 'running', 1)`)
      .run('queue-test-1', 'del-test-1', 'coordinator-node-id', 'echo hello');

    // Override the report queue's getCoordinatorUrl so it returns a URL
    // (which will use our mocked fetch)
    const reportQueue = router._reportQueue;
    // Monkey-patch getCoordinatorUrl by re-initializing with a mock
    // Actually, the report queue uses getCoordinatorUrl from closure which
    // checks nodeRegistry — which is null. Let's verify the report stays queued.
    // Instead, let's recreate with a working coordinator URL:
    reportQueue.stop();

    // Create a new report queue with a real coordinator URL
    const { createReportQueue } = await import('../src/server/report-queue.mjs');
    const { getOrCreateNodeIdentity } = await import('../src/server/node-identity.mjs');
    const identity = getOrCreateNodeIdentity(db); // this node's identity

    const newReportQueue = createReportQueue(db, {
      getCoordinatorUrl: () => 'http://coordinator.local:8080',
      fetchFn: mockFetch,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    // Replace the report queue's queueOutboundReport by patching the closure ref
    // Actually, we need to use the report queue that executeAndReport uses.
    // Since we can't easily swap it, let's call recoverInterruptedTasks directly
    // and manually call attemptFlush with our mocked fetch.

    // Call the real recovery function — this should:
    // 1. Flip 'running' queue row to 'pending' via recoverStale
    // 2. Re-execute the task via executeTask (mocked)
    // 3. Wait for task completion (polls tasks table)
    // 4. Record outcome in remote_task_queue
    // 5. Enqueue outbound report

    // First, manually flush the report queue with our mock
    // We need to replace the reportQueue reference used inside executeAndReport.
    // Since that's in a closure, let's just verify the queue row was created
    // and manually flush it with our mocked fetch.

    await router._recoverInterruptedTasks();

    // Assert: executeTask was called (the recovery path re-ran the task)
    expect(executeTaskCallCount).toBeGreaterThan(0);

    // Assert: remote_task_queue is now 'completed' (not left at 'running')
    const queueRow = db.prepare('SELECT * FROM remote_task_queue WHERE id = ?').get('queue-test-1');
    // recoverStale flips to 'pending', then executeAndReport claims to 'running',
    // then queueComplete marks as 'completed'
    expect(['completed', 'running', 'pending']).toContain(queueRow.status);

    // Wait a bit for the async task completion
    await new Promise(r => setTimeout(r, 300));

    const finalQueueRow = db.prepare('SELECT * FROM remote_task_queue WHERE id = ?').get('queue-test-1');
    expect(finalQueueRow.status).toBe('completed');
    const outcome = JSON.parse(finalQueueRow.result);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result).toBe('recovered output');

    // Assert: a pending_reports row was created (coordinator was unreachable)
    const reportRows = db.prepare('SELECT * FROM pending_reports WHERE delegation_id = ?').all('del-test-1');
    expect(reportRows.length).toBeGreaterThan(0);
    expect(reportRows[0].status).toBe('completed');
    expect(reportRows[0].attempts).toBeGreaterThanOrEqual(0);

    // Now flush with the mocked fetch — first 2 calls fail, 3rd succeeds
    await newReportQueue.attemptFlush();
    // First attempt fails (coordinator unreachable)
    const afterFirstFlush = db.prepare('SELECT * FROM pending_reports WHERE delegation_id = ?').all('del-test-1');
    expect(afterFirstFlush.length).toBeGreaterThan(0); // still there

    await newReportQueue.attemptFlush();
    // Second attempt also fails
    const afterSecondFlush = db.prepare('SELECT * FROM pending_reports WHERE delegation_id = ?').all('del-test-1');
    expect(afterSecondFlush.length).toBeGreaterThan(0); // still there

    await newReportQueue.attemptFlush();
    // Third attempt should succeed — report delivered, row deleted
    const afterThirdFlush = db.prepare('SELECT * FROM pending_reports WHERE delegation_id = ?').all('del-test-1');
    expect(afterThirdFlush.length).toBe(0); // delivered and removed

    // Assert: coordinator received the correct status
    expect(coordinatorDelegationStatus).toBe('completed');

    // Assert: the task itself was never blocked by coordinator being unreachable
    const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get('child-test-1');
    expect(taskRow.status).toBe('done');

    // Assert: fetch was called exactly 3 times (2 failed + 1 success)
    expect(fetchCallCount).toBe(3);

    db.close();
  }, 15000);
});
