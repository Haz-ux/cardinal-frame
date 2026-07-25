/**
 * Tests for Docker backend wiring in executeSkill.
 *
 * Tests that:
 * 1. Skills with execution_backend='docker' route to executeInDocker
 * 2. Skills with execution_backend='local' (default) use local sandbox
 * 3. Docker fallback: when Docker unavailable, falls back to local sandbox
 * 4. The execution_backend field is preserved in the result object
 *
 * Uses mocked executeInDocker/isDockerAvailable — doesn't actually spawn containers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { executeSkill } from '../src/server/routes/skills.mjs';

// Import the real sandbox to use as fallback
import { runSandboxed } from '../src/server/routes/sandbox.mjs';

let db;
let originalDeps;

// We need to access the module's deps object to inject mocks.
// The module-level `deps` is private, but it gets set when skillsRoutes(ctx) is called.
// We'll call the factory with mocked deps.

import skillsFactory from '../src/server/routes/skills.mjs';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create skills + skill_invocations tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      handler TEXT NOT NULL,
      parameters TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      trigger TEXT DEFAULT '',
      version INTEGER DEFAULT 1,
      execution_backend TEXT DEFAULT 'local'
    );
    CREATE TABLE IF NOT EXISTS skill_invocations (
      id TEXT PRIMARY KEY,
      skill_id TEXT,
      skill_name TEXT,
      success INTEGER,
      duration_ms INTEGER,
      invoked_at TEXT DEFAULT (datetime('now'))
    );
  `);
});

afterEach(() => {
  db.close();
});

function setupSkillDeps(overrides = {}) {
  const mockStmts = {
    skills: {
      getById: { get: (id) => db.prepare('SELECT * FROM skills WHERE id = ?').get(id) },
      getByName: { get: (name) => db.prepare('SELECT * FROM skills WHERE name = ?').get(name) },
      getAll: { all: () => db.prepare('SELECT * FROM skills').all() },
      getEnabled: { all: () => db.prepare('SELECT * FROM skills WHERE enabled = 1').all() },
      insertWithTrigger: { run: (id, name, desc, cat, handler, params, enabled, trigger) => {
        db.prepare('INSERT INTO skills (id, name, description, category, handler, parameters, enabled, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, name, desc, cat, handler, params, enabled, trigger);
      } },
      update: { run: () => {} },
      delete: { run: () => {} },
    },
    skillInvocations: {
      insert: { run: () => {} },
      getStats: { all: () => [] },
      getBySkill: { all: () => [] },
      getRecent: { all: () => [] },
    },
  };

  const ctx = {
    db,
    stmts: mockStmts,
    authMiddleware: (_req, _res, next) => next(),
    optionalAuth: (_req, _res, next) => next(),
    requireRole: () => (_req, _res, next) => next(),
    apiLimiter: (_req, _res, next) => next(),
    audit: () => {},
    broadcast: () => {},
    fireHook: async () => {},
    callAgentLLM: async () => ({ content: 'mock', promptTokens: 0, completionTokens: 0 }),
    getDevSetting: (_db, _key, fallback) => fallback,
    runSandboxed,
    runSandboxedHybrid: async () => ({ result: 'hybrid-mock', logs: [] }),
    randomUUID: () => 'test-uuid',
    ...overrides,
  };

  // Call factory to populate module-level deps
  skillsFactory(ctx);

  return ctx;
}

describe('executeSkill — Docker backend wiring', () => {
  it('should use local sandbox when execution_backend is "local" (default)', async () => {
    setupSkillDeps();

    const skill = {
      id: 'skill-1',
      name: 'Echo',
      handler: '(input) => { return { echoed: input.message }; }',
      parameters: '{}',
      execution_backend: 'local',
    };

    const result = await executeSkill(skill, { message: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.type).toBe('script');
    expect(result.execution_backend).toBe('local');
    expect(result.output.echoed).toBe('hello');
  });

  it('should use Docker backend when execution_backend is "docker" and Docker is available', async () => {
    const mockDocker = vi.fn(async () => ({
      ok: true,
      output: { dockerResult: 'success' },
      durationMs: 42,
    }));
    const mockDockerCheck = vi.fn(() => true);

    setupSkillDeps({
      executeInDocker: mockDocker,
      isDockerAvailable: mockDockerCheck,
    });

    const skill = {
      id: 'skill-2',
      name: 'DockerSkill',
      handler: '(input) => input',
      parameters: '{}',
      execution_backend: 'docker',
    };

    const result = await executeSkill(skill, { test: true });
    expect(mockDockerCheck).toHaveBeenCalled();
    expect(mockDocker).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.type).toBe('docker');
    expect(result.execution_backend).toBe('docker');
    expect(result.output.dockerResult).toBe('success');
  });

  it('should fall back to local sandbox when Docker is requested but unavailable', async () => {
    const mockDocker = vi.fn(async () => ({
      ok: false,
      error: 'Docker is not available on this host',
      durationMs: 0,
    }));
    const mockDockerCheck = vi.fn(() => false);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    setupSkillDeps({
      executeInDocker: mockDocker,
      isDockerAvailable: mockDockerCheck,
      logger,
    });

    const skill = {
      id: 'skill-3',
      name: 'FallbackSkill',
      handler: '(input) => { return { saved: input.val }; }',
      parameters: '{}',
      execution_backend: 'docker',
    };

    const result = await executeSkill(skill, { val: 'local-fallback' });
    expect(mockDockerCheck).toHaveBeenCalled();
    // Docker exec should NOT be called since check returned false
    expect(mockDocker).not.toHaveBeenCalled();
    // Should fall back to local
    expect(result.ok).toBe(true);
    expect(result.type).toBe('script');
    expect(result.execution_backend).toBe('local (docker fallback)');
    expect(result.output.saved).toBe('local-fallback');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should fall back to local sandbox when Docker exec returns "not available" error', async () => {
    const mockDocker = vi.fn(async () => ({
      ok: false,
      error: 'Docker is not available on this host',
      durationMs: 0,
    }));
    const mockDockerCheck = vi.fn(() => true); // Says available, but exec fails

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    setupSkillDeps({
      executeInDocker: mockDocker,
      isDockerAvailable: mockDockerCheck,
      logger,
    });

    const skill = {
      id: 'skill-4',
      name: 'DockerVanished',
      handler: '(input) => input',
      parameters: '{}',
      execution_backend: 'docker',
    };

    const result = await executeSkill(skill, { recover: 'me' });
    expect(mockDockerCheck).toHaveBeenCalled();
    expect(mockDocker).toHaveBeenCalled();
    // Should fall back to local
    expect(result.ok).toBe(true);
    expect(result.type).toBe('script');
    expect(result.execution_backend).toBe('local (docker fallback)');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should return error for Docker exec failures (non-availability)', async () => {
    const mockDocker = vi.fn(async () => ({
      ok: false,
      error: 'Container crashed: OOM killed',
      durationMs: 500,
    }));
    const mockDockerCheck = vi.fn(() => true);

    setupSkillDeps({
      executeInDocker: mockDocker,
      isDockerAvailable: mockDockerCheck,
    });

    const skill = {
      id: 'skill-5',
      name: 'OOMSkill',
      handler: '(input) => input',
      parameters: '{}',
      execution_backend: 'docker',
    };

    const result = await executeSkill(skill, {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Container crashed: OOM killed');
    expect(result.execution_backend).toBe('docker');
  });

  it('should default to local when execution_backend is not set', async () => {
    setupSkillDeps();

    const skill = {
      id: 'skill-6',
      name: 'DefaultBackend',
      handler: '(input) => input.val + 1',
      parameters: '{}',
      // execution_backend not set — should default to 'local'
    };

    const result = await executeSkill(skill, { val: 41 });
    expect(result.ok).toBe(true);
    expect(result.type).toBe('script');
    expect(result.execution_backend).toBe('local');
    expect(result.output).toBe(42);
  });
});
