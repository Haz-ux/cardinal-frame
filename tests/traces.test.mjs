/**
 * Tests for Observability & Request Tracing
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initTracing, traceMiddleware } from '../src/server/routes/traces.mjs';

let tmpDir, db, stmts;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cf-trace-'));
  db = new Database(join(tmpDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const tracesStmts = initTracing(db);
  // Wrap to match server pattern: stmts.traces.insert
  stmts = { traces: tracesStmts };
});

afterEach(() => {
  try { db?.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('Tracing — Schema', () => {
  it('should create request_traces table', () => {
    const cols = db.prepare('PRAGMA table_info(request_traces)').all();
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('method');
    expect(colNames).toContain('path');
    expect(colNames).toContain('status');
    expect(colNames).toContain('duration_ms');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('error');
    expect(colNames).toContain('ts');
  });

  it('should create indexes on ts and path', () => {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='request_traces'").all();
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_traces_ts');
    expect(names).toContain('idx_traces_path');
  });
});

describe('Tracing — Trace Persistence', () => {
  it('should insert a trace record', () => {
    stmts.traces.insert.run('trace-1', 'GET', '/api/health', 200, 15, 'user-1', null);

    const row = db.prepare('SELECT * FROM request_traces WHERE id = ?').get('trace-1');
    expect(row.method).toBe('GET');
    expect(row.path).toBe('/api/health');
    expect(row.status).toBe(200);
    expect(row.duration_ms).toBe(15);
    expect(row.user_id).toBe('user-1');
    expect(row.error).toBeNull();
  });

  it('should insert traces with error info', () => {
    stmts.traces.insert.run('trace-err', 'POST', '/api/agents/execute', 500, 1500, 'admin', 'HTTP 500');

    const row = db.prepare('SELECT * FROM request_traces WHERE id = ?').get('trace-err');
    expect(row.status).toBe(500);
    expect(row.error).toBe('HTTP 500');
  });
});

describe('Tracing — Query Endpoints', () => {
  beforeEach(() => {
    // Seed multiple traces
    stmts.traces.insert.run('t1', 'GET', '/api/health', 200, 5, null, null);
    stmts.traces.insert.run('t2', 'GET', '/api/health', 200, 10, null, null);
    stmts.traces.insert.run('t3', 'POST', '/api/agents/execute', 500, 2000, 'admin', 'HTTP 500');
    stmts.traces.insert.run('t4', 'GET', '/api/tasks', 404, 50, 'user1', 'HTTP 404');
  });

  it('should return summary stats (total, avg, max, errors)', () => {
    const summary = stmts.traces.getSummary.all('-24 hours');
    expect(summary).toBeDefined();
    expect(summary[0].total).toBe(4);
    expect(summary[0].errors).toBe(2); // t3 (500) + t4 (404)
    expect(summary[0].max_ms).toBe(2000);
  });

  it('should return slowest traces above threshold', () => {
    const slow = stmts.traces.getSlowest.all(100);
    // Only t3 (2000ms) is above 100ms threshold
    // t1=5, t2=10, t3=2000, t4=50 — only t3 > 100
    expect(slow.length).toBe(1);
    expect(slow[0].id).toBe('t3');
  });

  it('should return error traces (status >= 400)', () => {
    const errors = stmts.traces.getErrors.all();
    expect(errors.length).toBe(2);
    const ids = errors.map(e => e.id);
    expect(ids).toContain('t3');
    expect(ids).toContain('t4');
  });

  it('should aggregate by path', () => {
    const paths = stmts.traces.getByPath.all('-24 hours');
    const healthPath = paths.find(p => p.path === '/api/health');
    expect(healthPath).toBeDefined();
    expect(healthPath.count).toBe(2);
    expect(healthPath.avg_ms).toBe(7.5); // (5 + 10) / 2
    expect(healthPath.max_ms).toBe(10);
  });
});

describe('Tracing — Middleware', () => {
  it('should attach timing and call next()', () => {
    const mockReq = { method: 'GET', path: '/api/test', headers: {}, id: 'mw-trace-1' };
    const mockRes = {
      statusCode: 200,
      getHeader: () => null,
      on: (event, cb) => { if (event === 'finish') mockRes._finishCb = cb; },
    };
    const mockNext = () => {};
    const mockLogger = { info: () => {} };

    const middleware = traceMiddleware(stmts, mockLogger);
    middleware(mockReq, mockRes, mockNext);

    // Simulate response finish
    mockRes._finishCb();

    const row = db.prepare('SELECT * FROM request_traces WHERE id = ?').get('mw-trace-1');
    expect(row).toBeDefined();
    expect(row.method).toBe('GET');
    expect(row.path).toBe('/api/test');
    expect(row.status).toBe(200);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('should skip WebSocket upgrade requests', () => {
    const mockReq = { method: 'GET', path: '/ws', headers: { upgrade: 'websocket' }, id: 'ws-trace' };
    const mockRes = {
      statusCode: 101,
      getHeader: () => 'text/event-stream',
      on: (event, cb) => { if (event === 'finish') mockRes._finishCb = cb; },
    };
    const mockLogger = { info: () => {} };

    const middleware = traceMiddleware(stmts, mockLogger);
    middleware(mockReq, mockRes, () => {});
    mockRes._finishCb();

    // Should not have persisted a trace for WebSocket
    const row = db.prepare('SELECT * FROM request_traces WHERE id = ?').get('ws-trace');
    expect(row).toBeUndefined();
  });
});

describe('Tracing — Cleanup', () => {
  it('should have a cleanup statement for old traces', () => {
    // Insert an old trace (manually set ts to 8 days ago)
    stmts.traces.insert.run('old-trace', 'GET', '/api/old', 200, 10, null, null);
    db.prepare("UPDATE request_traces SET ts = datetime('now', '-8 days') WHERE id = ?").run('old-trace');

    // Insert a recent trace
    stmts.traces.insert.run('new-trace', 'GET', '/api/new', 200, 10, null, null);

    // Run cleanup
    stmts.traces.cleanup.run();

    const old = db.prepare('SELECT * FROM request_traces WHERE id = ?').get('old-trace');
    const recent = db.prepare('SELECT * FROM request_traces WHERE id = ?').get('new-trace');

    expect(old).toBeUndefined();
    expect(recent).toBeDefined();
  });
});
