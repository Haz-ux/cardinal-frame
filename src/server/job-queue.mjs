/**
 * Cardinal Frame — SQLite-backed Job Queue
 *
 * Durable task/DAG execution that survives restarts.
 * No Redis dependency — uses the existing SQLite DB.
 *
 * Features:
 * - Persistent job state across restarts
 * - Automatic retry with exponential backoff
 * - Dead-letter queue for permanently failed jobs
 * - Concurrent execution with configurable limits
 * - Timeout enforcement
 * - Resume incomplete jobs on startup
 *
 * Usage:
 *   import { createJobQueue } from './job-queue.mjs';
 *   const queue = createJobQueue(db, { concurrency: 5 });
 *   await queue.enqueue({ type: 'dag', dagId: '...', layers: [...] });
 *   queue.start(); // begins processing + resumes incomplete jobs
 *   await queue.stop(); // waits for current jobs, persists state
 */

import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function createJobQueue(db, opts = {}) {
  const {
    concurrency = 3,
    defaultTimeout = 30000,
    maxRetries = 3,
    baseDelay = 1000,     // 1s, 2s, 4s, 8s...
    maxDelay = 30000,     // cap at 30s
  } = opts;

  // ─── Schema ───────────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,              -- 'dag' | 'chain' | 'task' | 'agent'
      payload TEXT NOT NULL,           -- JSON: { dagId, layers, sessionId, ... }
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed | dead
      priority INTEGER DEFAULT 0,      -- higher = first
      attempts INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT ${maxRetries},
      timeout_ms INTEGER DEFAULT ${defaultTimeout},
      scheduled_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT,
      result TEXT,                     -- JSON result on success
      trace_id TEXT,                   -- for observability (Phase 2.3)
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority DESC, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type, status);

    CREATE TABLE IF NOT EXISTS job_steps (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      step_type TEXT,                  -- 'layer' | 'task' | 'agent_step'
      payload TEXT,                    -- JSON: per-step data
      status TEXT DEFAULT 'pending',   -- pending | running | completed | failed
      started_at TEXT,
      completed_at TEXT,
      result TEXT,                     -- JSON: { exitCode, stdout, durationMs, ... }
      error TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_job_steps_job ON job_steps(job_id, step_index);
  `);

  // ─── Prepared statements ─────────────────────────────────────────

  const stmts = {
    enqueue: db.prepare(`
      INSERT INTO jobs (id, type, payload, priority, max_retries, timeout_ms, trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    claim: db.prepare(`
      UPDATE jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
      WHERE id = ?
    `),
    complete: db.prepare(`
      UPDATE jobs SET status = 'completed', completed_at = datetime('now'),
        result = ?, updated_at = datetime('now')
      WHERE id = ?
    `),
    fail: db.prepare(`
      UPDATE jobs SET status = CASE WHEN attempts >= max_retries THEN 'dead' ELSE 'pending' END,
        last_error = ?, updated_at = datetime('now'),
        scheduled_at = CASE WHEN attempts < max_retries THEN datetime('now', '+' || ? || ' seconds') ELSE scheduled_at END
      WHERE id = ?
    `),
    getNext: db.prepare(`
      SELECT * FROM jobs WHERE status = 'pending'
        AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
      ORDER BY priority DESC, scheduled_at ASC LIMIT 1
    `),
    getRunning: db.prepare(`SELECT * FROM jobs WHERE status = 'running'`),
    getById: db.prepare(`SELECT * FROM jobs WHERE id = ?`),
    recoverStale: db.prepare(`
      UPDATE jobs SET status = 'pending', last_error = 'Interrupted by server restart'
      WHERE status = 'running'
    `),
    insertStep: db.prepare(`
      INSERT INTO job_steps (id, job_id, step_index, step_type, payload)
      VALUES (?, ?, ?, ?, ?)
    `),
    updateStep: db.prepare(`
      UPDATE job_steps SET status = ?, started_at = ?, completed_at = ?,
        result = ?, error = ?
      WHERE id = ?
    `),
    getSteps: db.prepare(`SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_index`),
    getDead: db.prepare(`SELECT * FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 50`),
    getStats: db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'running' THEN 1 END) as running,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'dead' THEN 1 END) as dead
      FROM jobs
    `),
  };

  // ─── Handlers registry ───────────────────────────────────────────

  const handlers = new Map();

  function registerHandler(type, fn) {
    handlers.set(type, fn);
  }

  // Default DAG handler
  registerHandler('dag', async (job, ctx) => {
    const { payload, id: jobId } = job;
    const { dagId, layers, nodes } = JSON.parse(payload);
    const { db, broadcast } = ctx;
    const steps = [];

    // Prepared statement to update DAG status in the dags table
    // (wrapped in try — the dags table may not exist in isolated queue tests)
    let updateDagStatus = null;
    try {
      updateDagStatus = db.prepare('UPDATE dags SET status = ?, last_run_result = ? WHERE id = ?');
    } catch {}

    try {
      for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        const layer = layers[layerIdx];
        const layerResults = await Promise.all(layer.map(async (nodeId, nodeIdx) => {
          const node = nodes.find(n => n.id === nodeId);
          if (!node || !node.command) return { nodeId, status: 'skipped' };

          const stepId = randomUUID();
          stmts.insertStep.run(stepId, jobId, layerIdx * 100 + nodeIdx, 'node', JSON.stringify({ nodeId, command: node.command }));
          stmts.updateStep.run('running', new Date().toISOString(), null, null, null, stepId);

          try {
            const start = Date.now();
            const { stdout } = await execAsync(node.command, {
              timeout: job.timeout_ms,
              shell: '/bin/sh',
              env: { PATH: process.env.PATH },
              cwd: '/tmp',
            });
            const durationMs = Date.now() - start;
            const result = { nodeId, nodeName: node.name, status: 'success', exitCode: 0, output: stdout.trim().slice(0, 500), durationMs };
            stmts.updateStep.run('completed', new Date().toISOString(), new Date().toISOString(), JSON.stringify(result), null, stepId);
            return result;
          } catch (err) {
            const result = { nodeId, nodeName: node.name, status: 'failed', exitCode: err.code ?? 1, error: (err.stderr || err.message).slice(0, 500), durationMs: 0 };
            stmts.updateStep.run('failed', new Date().toISOString(), new Date().toISOString(), JSON.stringify(result), err.message, stepId);
            return result;
          }
        }));
        steps.push({ layer: layerIdx, results: layerResults });
      }

      // Update dags table + broadcast dag:status so the UI's WS subscription can react
      const result = { steps, totalLayers: layers.length, completedAt: new Date().toISOString() };
      try { updateDagStatus.run('completed', JSON.stringify(result), dagId); } catch {} // dags table may not exist in isolated queue tests
      broadcast?.('dag:status', { id: dagId, status: 'completed', steps });

      return result;
    } catch (err) {
      try { updateDagStatus.run('failed', JSON.stringify({ error: err.message }), dagId); } catch {}
      broadcast?.('dag:status', { id: dagId, status: 'failed', error: err.message });
      throw err; // re-throw so processJob's retry/dead-letter logic still fires
    }
  });

  // Default task handler
  registerHandler('task', async (job) => {
    const { command } = JSON.parse(job.payload);
    const { stdout } = await execAsync(command, {
      timeout: job.timeout_ms,
      shell: '/bin/sh',
      env: { PATH: process.env.PATH },
      cwd: '/tmp',
    });
    return { exitCode: 0, output: stdout.trim().slice(0, 2000) };
  });

  // ─── Queue logic ──────────────────────────────────────────────────

  let running = false;
  let activeJobs = 0;
  let pollTimer = null;
  let broadcast = null; // WebSocket broadcast fn, set via setBroadcast()
  let logger = null;

  function setBroadcast(fn) { broadcast = fn; }
  function setLogger(l) { logger = l; }

  function computeBackoff(attempts) {
    const delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
    return Math.ceil(delay / 1000); // seconds for SQLite
  }

  async function processJob(job) {
    const handler = handlers.get(job.type);
    if (!handler) {
      stmts.fail.run(`No handler for job type: ${job.type}`, computeBackoff(job.attempts || 1), job.id);
      return;
    }

    stmts.claim.run(job.id);
    job.attempts = (job.attempts || 0) + 1;

    broadcast?.('job:started', { id: job.id, type: job.type, attempt: job.attempts });

    try {
      // Wrap with timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Job timed out after ${job.timeout_ms}ms`)), job.timeout_ms)
      );
      const result = await Promise.race([
        handler(job, { db, jobId: job.id, stmts, broadcast }),
        timeoutPromise,
      ]);

      stmts.complete.run(JSON.stringify(result), job.id);
      broadcast?.('job:completed', { id: job.id, type: job.type, result });
    } catch (err) {
      const backoff = computeBackoff(job.attempts);
      stmts.fail.run(err.message.slice(0, 500), backoff, job.id);

      if (job.attempts >= job.max_retries) {
        broadcast?.('job:dead', { id: job.id, type: job.type, error: err.message, attempts: job.attempts });
        logger?.error?.(`Job ${job.id} (${job.type}) permanently failed after ${job.attempts} attempts: ${err.message}`);
      } else {
        broadcast?.('job:retry', { id: job.id, type: job.type, attempt: job.attempts, backoffSeconds: backoff });
        logger?.warn?.(`Job ${job.id} (${job.type}) failed (attempt ${job.attempts}/${job.max_retries}), retrying in ${backoff}s: ${err.message}`);
      }
    }
  }

  async function poll() {
    if (!running) return;

    while (activeJobs < concurrency) {
      const job = stmts.getNext.get();
      if (!job) break;

      activeJobs++;
      processJob(job)
        .catch(err => logger?.error?.(`Job processing error: ${err.message}`))
        .finally(() => { activeJobs--; });
    }
  }

  function start() {
    // Recover jobs interrupted by server restart
    const stale = stmts.recoverStale.run();
    if (stale.changes > 0) {
      logger?.info?.(`Recovered ${stale.changes} interrupted job(s) after restart`);
    }

    running = true;
    pollTimer = setInterval(poll, 2000);
    poll(); // immediate first poll
    logger?.info?.(`Job queue started (concurrency=${concurrency})`);
  }

  async function stop() {
    running = false;
    if (pollTimer) clearInterval(pollTimer);

    // Wait for active jobs to finish (with max wait)
    const maxWait = 30000;
    const startWait = Date.now();
    while (activeJobs > 0 && Date.now() - startWait < maxWait) {
      await new Promise(r => setTimeout(r, 200));
    }

    // Any still-running jobs get recovered on next start
    if (activeJobs > 0) {
      stmts.recoverStale.run();
      logger?.warn?.(`Stopped with ${activeJobs} jobs still running — they will resume on restart`);
    }
  }

  function enqueue(type, payload, opts = {}) {
    const id = opts.id || randomUUID();
    stmts.enqueue.run(
      id, type, JSON.stringify(payload),
      opts.priority || 0,
      opts.maxRetries ?? maxRetries,
      opts.timeoutMs ?? defaultTimeout,
      opts.traceId || null,
    );
    broadcast?.('job:enqueued', { id, type, priority: opts.priority || 0 });

    // Trigger immediate poll if queue was idle
    if (running && activeJobs < concurrency) poll();

    return id;
  }

  function getStatus() {
    return stmts.getStats.get();
  }

  function getJob(id) {
    const job = stmts.getById.get(id);
    if (!job) return null;
    job.steps = stmts.getSteps.all(id);
    return job;
  }

  function getDeadJobs() {
    return stmts.getDead.all();
  }

  return {
    start,
    stop,
    enqueue,
    registerHandler,
    setBroadcast,
    setLogger,
    getStatus,
    getJob,
    getDeadJobs,
  };
}
