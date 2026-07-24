import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), `cf-skill-inv-${Date.now()}`);

function setupDB() {
  mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      handler TEXT NOT NULL,
      parameters TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      invoke_count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.5,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL,
      skill_name TEXT,
      trace_id TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      skill_type TEXT,
      error TEXT,
      ts TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_skill_inv_skill ON skill_invocations(skill_id);
    CREATE INDEX IF NOT EXISTS idx_skill_inv_ts ON skill_invocations(ts);
  `);

  const stmts = {
    skills: {
      insert: db.prepare('INSERT INTO skills (id, name, handler, enabled) VALUES (?, ?, ?, ?)'),
      getById: db.prepare('SELECT * FROM skills WHERE id = ?'),
      getAll: db.prepare('SELECT * FROM skills ORDER BY name'),
    },
    skillInvocations: {
      insert: db.prepare('INSERT INTO skill_invocations (skill_id, skill_name, trace_id, success, duration_ms, skill_type, error) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      getBySkill: db.prepare('SELECT * FROM skill_invocations WHERE skill_id = ? ORDER BY ts DESC, id DESC LIMIT ?'),
      getRecent: db.prepare('SELECT * FROM skill_invocations ORDER BY ts DESC, id DESC LIMIT ?'),
      getStats: db.prepare(`SELECT
        skill_id, skill_name,
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
        ROUND(AVG(duration_ms), 1) as avg_duration_ms,
        MAX(ts) as last_invoked
        FROM skill_invocations
        WHERE ts > datetime('now', ?)
        GROUP BY skill_id, skill_name
        ORDER BY failures DESC, total DESC`),
    },
  };

  return { db, stmts };
}

describe('Skill Invocations', () => {
  let db, stmts, skillId;

  beforeEach(() => {
    ({ db, stmts } = setupDB());
    skillId = randomUUID();
    stmts.skills.insert.run(skillId, 'test-skill', 'async (input) => input', 1);
  });

  afterEach(() => {
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should log a successful invocation', () => {
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 'trace-1', 1, 42, 'script', null);
    const inv = stmts.skillInvocations.getBySkill.all(skillId, 10);
    expect(inv).toHaveLength(1);
    expect(inv[0].success).toBe(1);
    expect(inv[0].skill_name).toBe('test-skill');
    expect(inv[0].trace_id).toBe('trace-1');
    expect(inv[0].duration_ms).toBe(42);
    expect(inv[0].skill_type).toBe('script');
    expect(inv[0].error).toBeNull();
  });

  it('should log a failed invocation with error message', () => {
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 'trace-2', 0, 5000, 'hybrid', 'ReferenceError: x is not defined');
    const inv = stmts.skillInvocations.getBySkill.all(skillId, 10);
    expect(inv).toHaveLength(1);
    expect(inv[0].success).toBe(0);
    expect(inv[0].error).toBe('ReferenceError: x is not defined');
  });

  it('should retrieve invocations by skill_id with limit', () => {
    for (let i = 0; i < 30; i++) {
      stmts.skillInvocations.insert.run(skillId, 'test-skill', `trace-${i}`, i % 3 === 0 ? 0 : 1, 100 + i, 'script', i % 3 === 0 ? 'err' : null);
    }
    const inv10 = stmts.skillInvocations.getBySkill.all(skillId, 10);
    expect(inv10).toHaveLength(10);
    // Most recent first (ORDER BY ts DESC — ties broken by id DESC implicitly)
    expect(inv10[0].trace_id).toBe('trace-29');
    expect(inv10[9].trace_id).toBe('trace-20');
  });

  it('should retrieve recent invocations across all skills', () => {
    const skillId2 = randomUUID();
    stmts.skills.insert.run(skillId2, 'skill-2', 'async (input) => input', 1);
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 't1', 1, 50, 'script', null);
    stmts.skillInvocations.insert.run(skillId2, 'skill-2', 't2', 0, 75, 'template', 'LLM timeout');
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 't3', 1, 30, 'script', null);

    const recent = stmts.skillInvocations.getRecent.all(10);
    expect(recent).toHaveLength(3);
    expect(recent[0].trace_id).toBe('t3');
    expect(recent[1].skill_id).toBe(skillId2);
  });

  it('should compute failure-rate stats per skill', () => {
    const skillId2 = randomUUID();
    stmts.skills.insert.run(skillId2, 'flaky-skill', 'async (input) => input', 1);

    // test-skill: 3 success, 1 failure
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 't1', 1, 50, 'script', null);
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 't2', 1, 60, 'script', null);
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 't3', 0, 70, 'script', 'timeout');
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 't4', 1, 40, 'script', null);

    // flaky-skill: 1 success, 3 failures
    stmts.skillInvocations.insert.run(skillId2, 'flaky-skill', 'f1', 0, 80, 'hybrid', 'error');
    stmts.skillInvocations.insert.run(skillId2, 'flaky-skill', 'f2', 1, 90, 'hybrid', null);
    stmts.skillInvocations.insert.run(skillId2, 'flaky-skill', 'f3', 0, 100, 'hybrid', 'oom');
    stmts.skillInvocations.insert.run(skillId2, 'flaky-skill', 'f4', 0, 110, 'hybrid', 'crash');

    const stats = stmts.skillInvocations.getStats.all('-1 day');
    expect(stats).toHaveLength(2);

    // flaky-skill should be first (more failures)
    expect(stats[0].skill_name).toBe('flaky-skill');
    expect(stats[0].failures).toBe(3);
    expect(stats[0].successes).toBe(1);
    expect(stats[0].total).toBe(4);
    expect(stats[0].avg_duration_ms).toBe(95);

    // test-skill second
    expect(stats[1].skill_name).toBe('test-skill');
    expect(stats[1].failures).toBe(1);
    expect(stats[1].successes).toBe(3);
    expect(stats[1].total).toBe(4);
  });

  it('should handle null trace_id (heartbeat context)', () => {
    stmts.skillInvocations.insert.run(skillId, 'test-skill', null, 1, 100, 'script', null);
    const inv = stmts.skillInvocations.getBySkill.all(skillId, 10);
    expect(inv[0].trace_id).toBeNull();
    expect(inv[0].success).toBe(1);
  });

  it('should handle null duration_ms', () => {
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 't1', 0, null, 'script', 'crashed before timing');
    const inv = stmts.skillInvocations.getBySkill.all(skillId, 10);
    expect(inv[0].duration_ms).toBeNull();
  });

  it('should support time-window queries for stats', () => {
    // Insert with success
    stmts.skillInvocations.insert.run(skillId, 'test-skill', 't1', 1, 50, 'script', null);

    // Query with a very old window (-1 year) should still include it
    const statsYear = stmts.skillInvocations.getStats.all('-1 year');
    expect(statsYear).toHaveLength(1);
    expect(statsYear[0].total).toBe(1);
    expect(statsYear[0].successes).toBe(1);

    // Query with a future window (+1 day) should exclude everything
    const statsFuture = stmts.skillInvocations.getStats.all('+1 day');
    expect(statsFuture).toHaveLength(0);
  });
});
