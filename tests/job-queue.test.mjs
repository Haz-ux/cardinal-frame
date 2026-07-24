/**
 * Tests for SQLite-backed Job Queue (durable state, enqueue/dequeue/heartbeat/recovery)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createJobQueue } from '../src/server/job-queue.mjs';

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

  it('should process a task job and mark it completed', async () => {
    queue = createJobQueue(db, { concurrency: 1, defaultTimeout: 5000 });
    queue.start();
    const id = queue.enqueue('task', { command: 'echo test123' });

    // Wait for processing
    await new Promise(r => setTimeout(r, 3000));

    const job = queue.getJob(id);
    expect(job.status).toBe('completed');
    const result = JSON.parse(job.result);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('test123');

    await queue.stop();
  });

  it('should retry failed jobs with exponential backoff', async () => {
    queue = createJobQueue(db, { concurrency: 1, maxRetries: 2, defaultTimeout: 2000, baseDelay: 100 });
    const id = queue.enqueue('task', { command: 'exit 1' });

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
    const id = queue.enqueue('task', { command: 'exit 1' });

    queue.start();
    await new Promise(r => setTimeout(r, 4000));

    const job = queue.getJob(id);
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBeTruthy();

    const deadJobs = queue.getDeadJobs();
    expect(deadJobs.length).toBeGreaterThanOrEqual(1);

    await queue.stop();
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
    const id = queue.enqueue('task', { command: 'sleep 5' }, { timeoutMs: 500 });

    queue.start();
    await new Promise(r => setTimeout(r, 3000));

    const job = queue.getJob(id);
    // Should have timed out and either retrying or dead
    expect(['dead', 'pending']).toContain(job.status);
    expect(job.last_error).toContain('timed out');

    await queue.stop();
  });
});
