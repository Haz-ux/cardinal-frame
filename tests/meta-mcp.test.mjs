/**
 * MCP route tests: registration validation (M3) and tool-invoke gating (M12).
 *
 * Mounts routes/meta.mjs directly with a fake ctx (temp better-sqlite3 DB +
 * stub MCP backend), mirroring the pattern in tests/connectors.test.mjs.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import metaRoutes, { validateMcpServerConfig } from '../src/server/routes/meta.mjs';
import { initGovernance } from '../src/server/routes/governance.mjs';

const tmpDir = mkdtempSync(join(tmpdir(), 'cf-meta-mcp-'));
const db = new Database(join(tmpDir, 'meta-mcp.db'));
for (const m of ['001_initial.sql', '025_mcp_autoconnect.sql']) {
  db.exec(readFileSync(join(process.cwd(), 'src/server/migrations', m), 'utf8'));
}
const governance = initGovernance(db);

const connected = new Set();
const invoked = [];
const spawned = [];
const fakeMcp = {
  isConnected: (id) => connected.has(id),
  getTools: () => [],
  disconnectServer: (id) => { connected.delete(id); },
  connectServer: async (id, command, args) => {
    spawned.push({ id, command, args });
    connected.add(id);
    return { tools: [] };
  },
  invokeTool: async (id, tool, args) => { invoked.push({ id, tool, args }); return { ok: true }; },
};

const stmts = {
  mcp: {
    insert: db.prepare('INSERT INTO mcp_servers (id, name, transport, command, args, url, status) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    getAll: db.prepare('SELECT * FROM mcp_servers'),
    getById: db.prepare('SELECT * FROM mcp_servers WHERE id = ?'),
    updateStatus: db.prepare('UPDATE mcp_servers SET status = ?, connected_at = ?, last_ping = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM mcp_servers WHERE id = ?'),
  },
  governance,
};

function audit(action, resourceType, resourceId, userId, details = {}) {
  const target = resourceId ? `${resourceType}:${resourceId}` : resourceType;
  governance.audit.insert.run(userId || 'system', action, target, JSON.stringify(details), null);
}

const fakeCtx = {
  db,
  stmts,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  audit,
  authMiddleware: (req, _res, next) => {
    req.user = { id: 'u1', username: 'tester', role: req.headers['x-test-role'] || 'user' };
    next();
  },
  optionalAuth: (_req, _res, next) => next(),
  requireRole: (role) => (req, res, next) =>
    (req.user?.role === role ? next() : res.status(403).json({ error: 'Forbidden' })),
  apiLimiter: (_req, _res, next) => next(),
  broadcast: () => {},
  randomUUID,
  mcp: fakeMcp,
  pluginLoader: { discover() {}, loaded: new Map() },
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', metaRoutes(fakeCtx));
  return app;
}

const admin = { 'x-test-role': 'admin' };
const user = { 'x-test-role': 'user' };

afterAll(() => {
  try { db.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  db.exec('DELETE FROM mcp_servers');
  db.exec('DELETE FROM audit_log');
  connected.clear();
  invoked.length = 0;
  spawned.length = 0;
});

// ─── M3: registration validation ────────────────────────────────────
describe('MCP registration validation (M3)', () => {
  it('rejects absolute paths that are not allowlisted', async () => {
    const app = makeApp();
    for (const command of ['/bin/bash', '/tmp/evil.sh', '/usr/bin/curl', '/home/haz/x']) {
      const r = await request(app).post('/api/mcp/servers').set(admin)
        .send({ name: 'n', transport: 'stdio', command, args: [] });
      expect(r.status).toBe(400);
    }
    expect(db.prepare('SELECT COUNT(*) c FROM mcp_servers').get().c).toBe(0);
  });

  it('rejects non-array args and non-string args elements', async () => {
    const app = makeApp();
    const bad1 = await request(app).post('/api/mcp/servers').set(admin)
      .send({ name: 'n', transport: 'stdio', command: 'node', args: '--foo' });
    expect(bad1.status).toBe(400);
    const bad2 = await request(app).post('/api/mcp/servers').set(admin)
      .send({ name: 'n', transport: 'stdio', command: 'node', args: ['ok', 42] });
    expect(bad2.status).toBe(400);
  });

  it('rejects the unsupported http transport with a stdio pointer', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/mcp/servers').set(admin)
      .send({ name: 'n', transport: 'http', url: 'http://x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/stdio/i);
  });

  it('accepts a valid stdio config and it still connects', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/mcp/servers').set(admin)
      .send({ name: 'good', transport: 'stdio', command: 'node', args: ['server.js'] });
    expect(r.status).toBe(201);
    const id = r.body.id;
    const conn = await request(app).post(`/api/mcp/servers/${id}/connect`).set(admin).send({});
    expect(conn.status).toBe(200);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ id, command: 'node', args: ['server.js'] });
  });

  it('non-admins still cannot register', async () => {
    const app = makeApp();
    const r = await request(app).post('/api/mcp/servers').set(user)
      .send({ name: 'n', transport: 'stdio', command: 'node', args: [] });
    expect(r.status).toBe(403);
  });

  it('validateMcpServerConfig unit checks', () => {
    expect(validateMcpServerConfig({ transport: 'stdio', command: '/bin/bash', args: [] })).toMatch(/allowlist|bin directory/);
    expect(validateMcpServerConfig({ transport: 'stdio', command: 'node', args: 'x' })).toMatch(/array of strings/);
    expect(validateMcpServerConfig({ transport: 'http', command: 'node', args: [] })).toMatch(/stdio/);
    expect(validateMcpServerConfig({ transport: 'stdio', command: 'node', args: ['a'] })).toBeNull();
    expect(validateMcpServerConfig({ transport: 'stdio', command: 'npx', args: [] })).toBeNull();
    expect(validateMcpServerConfig({ transport: 'stdio', command: '/usr/local/bin/node', args: [] })).toBeNull();
  });
});

// ─── M12: invoke gating + audit ─────────────────────────────────────
describe('MCP tool invoke gating (M12)', () => {
  function seedConnected() {
    const id = randomUUID();
    stmts.mcp.insert.run(id, 'srv', 'stdio', 'node', '[]', null, 'disconnected');
    connected.add(id);
    return id;
  }

  it('non-admin invoke → 403 and the tool never runs', async () => {
    const app = makeApp();
    const id = seedConnected();
    const r = await request(app).post(`/api/mcp/servers/${id}/tools/t/invoke`).set(user).send({ arguments: {} });
    expect(r.status).toBe(403);
    expect(invoked).toHaveLength(0);
  });

  it('admin invoke → 200, tool runs, audit row records who/what/where', async () => {
    const app = makeApp();
    const id = seedConnected();
    const r = await request(app).post(`/api/mcp/servers/${id}/tools/doThing/invoke`).set(admin).send({ arguments: { a: 1 } });
    expect(r.status).toBe(200);
    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toMatchObject({ id, tool: 'doThing' });
    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'mcp.tool.invoke'").get();
    expect(row).toBeDefined();
    expect(row.target).toBe(`mcp_server:${id}`);
    expect(row.actor).toBe('u1');
    expect(JSON.parse(row.details)).toMatchObject({ tool: 'doThing', outcome: 'ok' });
  });
});
