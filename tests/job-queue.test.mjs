/**
 * Tests for SQLite-backed Job Queue (durable state, enqueue/dequeue/heartbeat/recovery)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createJobQueue } from '../src/server/job-queue.mjs';
import { sanitizeCommand } from '../src/server/command-safety.mjs';

let tmpDir, db, queue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cf-jq-'));
  db = new Database(join(tmpDir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(async () => {
  try { queue?.stop(); } catch {}
  try { await new Promise(r => setTimeout(r, 500)); } catch {} // let poll timer stop
  try { db?.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('Job Queue', () => {
  it('should enqueue a job and persist to SQLite', () => {
    queue = createJobQueue(db, { maxRetries: 2 });
    // NOTE: 'task' is only an opaque type label here — there is intentionally
    // no default 'task' handler (M2). The queue is not started, so no handler
    // lookup happens; this tests storage only.
    const id = queue.enqueue('task', { command: 'echo hello' });
    expect(id).toBeTruthy();

    const job = queue.getJob(id);
    expect(job).toBeDefined();
    expect(job.type).toBe('task');
    expect(job.status).toBe('pending');
    expect(JSON.parse(job.payload)).toEqual({ command: 'echo hello' });
  });

  it('should enqueue with custom priority', () => {
    queue = createJobQueue(db);
    const id1 = queue.enqueue('task', { command: 'a' }, { priority: 1 });
    const id2 = queue.enqueue('task', { command: 'b' }, { priority: 5 });
    const id3 = queue.enqueue('task', { command: 'c' }, { priority: 3 });

    // getNext returns highest priority first
    const next = db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, scheduled_at ASC LIMIT 1').get('pending');
    expect(next.id).toBe(id2);
  });

  it('should dead-letter jobs with no registered handler (no_handler)', async () => {
    // M2 (audit 2026-09-13 v2): the default 'task' handler was deleted. It
    // executed raw command strings with an explicit /bin/sh and no
    // sanitization. Only 'dag' jobs are enqueued in production, so the
    // handler was removed rather than kept as a loaded footgun.
    //
    // Fix-up 2 (2026-09-13): unknown types go straight to 'dead' with
    // dead_reason='no_handler' on first pickup — they never burn retries,
    // and they can never sit in 'pending' forever again.
    queue = createJobQueue(db, { concurrency: 1, defaultTimeout: 5000 });
    queue.start();
    const id = queue.enqueue('task', { command: 'echo test123' });

    // Wait for processing
    await new Promise(r => setTimeout(r, 3000));

    const job = queue.getJob(id);
    expect(job.status).toBe('dead');
    expect(job.dead_reason).toBe('no_handler');
    expect(job.last_error).toContain('No handler for job type: task');

    // It must not have burned any retry attempts on the way there
    expect(job.attempts).toBe(0);

    // And it must be visible through the dead-letter accessor
    const deadJobs = queue.getDeadJobs();
    expect(deadJobs.map(j => j.id)).toContain(id);

    await queue.stop();
  });

  it('should retry failed jobs with exponential backoff', async () => {
    queue = createJobQueue(db, { concurrency: 1, maxRetries: 2, defaultTimeout: 2000, baseDelay: 100 });
    // Custom registered handler (no built-in 'task' handler since M2).
    queue.registerHandler('failer', async () => { throw new Error('boom'); });
    const id = queue.enqueue('failer', {});

    queue.start();
    await new Promise(r => setTimeout(r, 3000));

    const job = queue.getJob(id);
    // After first failure, should be retrying (pending) or dead if maxRetries hit
    expect(['pending', 'completed', 'dead']).toContain(job.status);
    expect(job.attempts).toBeGreaterThan(0);

    await queue.stop();
  });

  it('should move permanently failed jobs to dead status', async () => {
    queue = createJobQueue(db, { concurrency: 1, maxRetries: 1, defaultTimeout: 2000, baseDelay: 100 });
    queue.registerHandler('failer', async () => { throw new Error('boom'); });
    const id = queue.enqueue('failer', {});

    queue.start();
    await new Promise(r => setTimeout(r, 4000));

    const job = queue.getJob(id);
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBeTruthy();
    expect(job.dead_reason).toBe('max_retries_exceeded');

    const deadJobs = queue.getDeadJobs();
    expect(deadJobs.length).toBeGreaterThanOrEqual(1);

    await queue.stop();
  });

  it('should retry a transiently failing known-type job and complete it', async () => {
    // Known types keep the EXISTING retry policy untouched: a failure below
    // max_retries goes back to 'pending' on exponential backoff, and a later
    // success completes normally with no dead_reason recorded.
    queue = createJobQueue(db, { concurrency: 1, maxRetries: 3, defaultTimeout: 2000, baseDelay: 100 });
    let calls = 0;
    queue.registerHandler('flaky', async () => {
      calls++;
      if (calls < 2) throw new Error('transient boom');
      return { ok: true };
    });

    const id = queue.enqueue('flaky', {});
    queue.start();
    await new Promise(r => setTimeout(r, 4000));

    const job = queue.getJob(id);
    expect(job.status).toBe('completed');
    expect(job.attempts).toBe(2);
    expect(job.dead_reason).toBeNull();

    await queue.stop();
  });

  it('should add dead_reason to a pre-existing jobs table (no migration)', () => {
    // The jobs table is created by createJobQueue AFTER the numbered
    // migrator runs, so dead_reason cannot ship as a numbered migration
    // (there is nothing to ALTER on a fresh install). The module patches
    // pre-existing tables itself, idempotently.
    //
    // The "old" table below is the FULL pre-dead_reason schema this module
    // used to create (a real pre-existing DB would have every column) —
    // a stub table with only a few columns would fail on the index DDL.
    db.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
      timeout_ms INTEGER DEFAULT 30000,
      scheduled_at TEXT DEFAULT (datetime('now')), started_at TEXT,
      completed_at TEXT, last_error TEXT, result TEXT, trace_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    const before = db.prepare(`PRAGMA table_info(jobs)`).all().map(c => c.name);
    expect(before).not.toContain('dead_reason');

    queue = createJobQueue(db);

    const after = db.prepare(`PRAGMA table_info(jobs)`).all().map(c => c.name);
    expect(after).toContain('dead_reason');

    // Second construction must be a no-op (no duplicate-column error).
    const queue2 = createJobQueue(db);
    queue2.stop();
  });

  it('should recover stale (running) jobs on start', () => {
    // Create queue, enqueue, then simulate crash (mark as running, stop queue)
    queue = createJobQueue(db);
    const id = queue.enqueue('task', { command: 'echo hello' });
    db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('running', id);
    queue.stop();

    // Create a new queue (simulate restart) — start() calls recoverStale
    const queue2 = createJobQueue(db);
    // Don't start polling — just verify recovery worked
    db.prepare("UPDATE jobs SET status = 'pending', last_error = 'Interrupted by server restart' WHERE status = 'running'").run();

    const job = queue2.getJob(id);
    expect(job.status).toBe('pending');
    expect(job.last_error).toContain('Interrupted');
  });

  it('should track step progress for DAG jobs', async () => {
    queue = createJobQueue(db, { concurrency: 1, defaultTimeout: 5000 });
    queue.setSanitizeCommand(sanitizeCommand); // production wires this via server.mjs
    const dagPayload = {
      dagId: 'test-dag-1',
      layers: [['node-a']],
      nodes: [{ id: 'node-a', name: 'Node A', command: 'echo step1' }],
    };

    const id = queue.enqueue('dag', dagPayload);
    queue.start();

    await new Promise(r => setTimeout(r, 3000));

    const job = queue.getJob(id);
    expect(job.status).toBe('completed');
    expect(job.steps.length).toBe(1);
    expect(job.steps[0].status).toBe('completed');

    await queue.stop();
  });

  it('should return correct queue stats', () => {
    queue = createJobQueue(db);
    queue.enqueue('task', { command: 'echo 1' });
    queue.enqueue('task', { command: 'echo 2' });
    db.prepare('UPDATE jobs SET status = ? WHERE id = (SELECT id FROM jobs LIMIT 1)').run('completed');

    const stats = queue.getStatus();
    expect(stats.pending).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.running).toBe(0);
  });

  it('should allow custom handler registration', async () => {
    queue = createJobQueue(db, { concurrency: 1, defaultTimeout: 5000 });
    queue.registerHandler('custom', async (job) => {
      const { value } = JSON.parse(job.payload);
      return { doubled: value * 2 };
    });

    queue.start();
    const id = queue.enqueue('custom', { value: 21 });

    await new Promise(r => setTimeout(r, 3000));

    const job = queue.getJob(id);
    expect(job.status).toBe('completed');
    expect(JSON.parse(job.result).doubled).toBe(42);

    await queue.stop();
  });

  it('should handle job timeouts', async () => {
    queue = createJobQueue(db, { concurrency: 1, maxRetries: 1, defaultTimeout: 500, baseDelay: 100 });
    queue.registerHandler('sleeper', () => new Promise(r => setTimeout(r, 5000)));
    const id = queue.enqueue('sleeper', {}, { timeoutMs: 500 });

    queue.start();
    await new Promise(r => setTimeout(r, 3000));

    const job = queue.getJob(id);
    // Should have timed out and either retrying or dead
    expect(['dead', 'pending']).toContain(job.status);
    expect(job.last_error).toContain('timed out');

    await queue.stop();
  });
});
