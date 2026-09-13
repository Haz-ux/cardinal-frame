import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { record } from '../src/server/learning/events.mjs';
import learningRoutes from '../src/server/routes/learning.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;
let app;
let auditCalls;

function freshDb() {
  const d = new Database(':memory:');
  for (const f of ['014_learning_events.sql', '022_learning_events.sql', '026_learning_candidates.sql', '028_learning_skill_versions.sql']) {
    d.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  d.exec('CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER DEFAULT 1)');
  return d;
}

function makeApp() {
  auditCalls = [];
  const ctx = {
    db,
    stmts: {},
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    audit: (action, resourceType, resourceId, userId, details) => {
      auditCalls.push({ action, resourceType, resourceId, userId, details });
    },
    auditLog: () => {},
    executeSkill: async () => { throw new Error('no skills'); },
    authMiddleware: (req, res, next) => {
      const u = req.headers['x-test-user'];
      if (!u) return res.status(401).json({ error: 'unauthorized' });
      req.user = { id: u, role: req.headers['x-test-role'] || 'user', username: u };
      next();
    },
    requireRole: (...roles) => (req, res, next) =>
      (req.user && roles.includes(req.user.role)) ? next() : res.status(403).json({ error: 'forbidden' }),
    apiLimiter: (_req, _res, next) => next(),
  };
  const a = express();
  a.use(express.json());
  a.use('/api', learningRoutes(ctx));
  return a;
}

const H = (user, role = 'user') => ({ 'x-test-user': user, 'x-test-role': role });

function seedCandidate(userId, overrides = {}) {
  const id = randomUUID();
  db.prepare(`INSERT INTO learning_candidates
    (id, user_id, kind, title, draft, eligibility_note, risk_tier, requested_caps,
     state, support_verified, quality_json, promotion_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, 0.9)`)
    .run(id, userId,
      overrides.kind || 'procedure',
      overrides.title || 'Fix the stuck queue',
      overrides.draft !== undefined ? overrides.draft : JSON.stringify(['Drain the queue', 'Restart the worker']),
      'reviewed', overrides.risk_tier || 'low', overrides.caps || '[]',
      overrides.state || 'promoted',
      JSON.stringify(overrides.quality || {
        confidence: 0.8,
        verification: ['queue depth returns to zero'],
        failure_modes: [{ symptom: 'worker crashes', recovery: 'restore from snapshot' }],
      }));
  const r = record(db, {
    userId, conversationId: 'c1', traceId: `t-${id.slice(0, 8)}`, type: 'tool_outcome',
    payload: JSON.stringify({ note: 'drained and restarted' }), outcome: 'success',
    terminalVersion: `av-${id.slice(0, 8)}`,
  });
  if (!r.error) {
    db.prepare(`INSERT INTO candidate_evidence (id, candidate_id, event_id, role, weight, excerpt_hash, created_at)
      VALUES (?, ?, ?, 'success', 1.0, 'h', ?)`).run(randomUUID(), id, r.id, new Date().toISOString());
  }
  return id;
}

async function compileAs(userId) {
  const cand = seedCandidate(userId);
  const res = await request(app).post(`/api/learning/candidates/${cand}/compile`).set(H(userId));
  return { cand, res };
}

beforeEach(() => {
  db = freshDb();
  app = makeApp();
});

describe('POST /learning/candidates/:id/compile', () => {
  it('compiles a promoted candidate through the full pipeline', async () => {
    const { res } = await compileAs('u1');
    expect(res.status).toBe(200);
    const v = res.body.version;
    expect(v.version_number).toBe(1);
    expect(v.kind).toBe('prompt_template');
    expect(v.state).toBe('scanned');
    expect(v.rationale).toBeTruthy();
    expect(v.content_hash).toHaveLength(12);
    expect(v.requires_docker).toBe(false);
    expect(v.test_summary).toEqual({ passed: 2, failed: 0 });
    expect(v.scanner).toEqual({ verdict: 'no_scanner', blocked: false });
    expect(v.candidate_title).toBe('Fix the stuck queue');
    expect(auditCalls.some(a => a.action === 'learning.version.compile')).toBe(true);
  });
  it('404s for a missing or cross-user candidate', async () => {
    const cand = seedCandidate('u1');
    expect((await request(app).post('/api/learning/candidates/nope/compile').set(H('u1'))).status).toBe(404);
    expect((await request(app).post(`/api/learning/candidates/${cand}/compile`).set(H('u2'))).status).toBe(404);
  });
  it('400s when the candidate is not promoted', async () => {
    const cand = seedCandidate('u1', { state: 'candidate' });
    const res = await request(app).post(`/api/learning/candidates/${cand}/compile`).set(H('u1'));
    expect(res.status).toBe(400);
  });
  it('400s with errors and writes nothing when the spec is invalid', async () => {
    const cand = seedCandidate('u1', { draft: JSON.stringify('prose blob, not steps') });
    const before = db.prepare('SELECT COUNT(*) c FROM learning_skill_versions').get().c;
    const res = await request(app).post(`/api/learning/candidates/${cand}/compile`).set(H('u1'));
    expect(res.status).toBe(400);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM learning_skill_versions').get().c).toBe(before);
  });
  it('bumps version_number on re-compile', async () => {
    const { cand, res } = await compileAs('u1');
    expect(res.body.version.version_number).toBe(1);
    const res2 = await request(app).post(`/api/learning/candidates/${cand}/compile`).set(H('u1'));
    expect(res2.body.version.version_number).toBe(2);
  });
});

describe('GET /learning/skill-versions', () => {
  it('lists owner-scoped versions with the frozen projection', async () => {
    const { res } = await compileAs('u1');
    const list = await request(app).get('/api/learning/skill-versions').set(H('u1'));
    expect(list.status).toBe(200);
    expect(list.body.versions).toHaveLength(1);
    expect(Object.keys(list.body.versions[0]).sort()).toEqual(
      ['candidate_id', 'candidate_title', 'content_hash', 'created_at', 'id', 'kind',
        'rationale', 'requires_docker', 'scanner', 'state', 'test_summary', 'version_number'].sort());
    expect(res.body.version.id).toBe(list.body.versions[0].id);
  });
  it('filters by state and rejects bad states', async () => {
    await compileAs('u1');
    const ok = await request(app).get('/api/learning/skill-versions?state=scanned').set(H('u1'));
    expect(ok.body.versions).toHaveLength(1);
    const empty = await request(app).get('/api/learning/skill-versions?state=active').set(H('u1'));
    expect(empty.body.versions).toHaveLength(0);
    expect((await request(app).get('/api/learning/skill-versions?state=bogus').set(H('u1'))).status).toBe(400);
  });
  it('returns nothing for other users', async () => {
    await compileAs('u1');
    const list = await request(app).get('/api/learning/skill-versions').set(H('u2'));
    expect(list.body.versions).toHaveLength(0);
  });
});

describe('GET /learning/skill-versions/:id', () => {
  it('returns full detail with history', async () => {
    const { res } = await compileAs('u1');
    const id = res.body.version.id;
    const det = await request(app).get(`/api/learning/skill-versions/${id}`).set(H('u1'));
    expect(det.status).toBe(200);
    const v = det.body.version;
    expect(v.spec.procedure).toHaveLength(2);
    expect(v.artifact).toContain('## Procedure');
    expect(v.test_report.passed).toBe(2);
    expect(v.scanner_verdict.verdict).toBe('no_scanner');
    expect(v.history.map(h => h.action)).toEqual(['compiled', 'tested', 'scanned']);
  });
  it('404s for other users (no existence leak)', async () => {
    const { res } = await compileAs('u1');
    expect((await request(app).get(`/api/learning/skill-versions/${res.body.version.id}`).set(H('u2'))).status).toBe(404);
  });
});

describe('approve / activate / rollback', () => {
  async function approvedVersion(userId = 'u1') {
    const { res } = await compileAs(userId);
    const id = res.body.version.id;
    const ap = await request(app).post(`/api/learning/skill-versions/${id}/approve?user_id=${userId}`).set(H('admin', 'admin'));
    return { id, ap };
  }

  it('approve requires admin', async () => {
    const { res } = await compileAs('u1');
    expect((await request(app).post(`/api/learning/skill-versions/${res.body.version.id}/approve`).set(H('u1'))).status).toBe(403);
  });
  it('admin approve without ?user_id= 404s (owner-scoped)', async () => {
    const { res } = await compileAs('u1');
    expect((await request(app).post(`/api/learning/skill-versions/${res.body.version.id}/approve`).set(H('admin', 'admin'))).status).toBe(404);
  });
  it('admin approve with ?user_id= approves a scanned version', async () => {
    const { id, ap } = await approvedVersion();
    expect(ap.status).toBe(200);
    expect(ap.body.version.state).toBe('approved');
    expect(auditCalls.some(a => a.action === 'learning.version.approve')).toBe(true);
    const det = await request(app).get(`/api/learning/skill-versions/${id}`).set(H('u1'));
    expect(det.body.version.history.map(h => h.action)).toContain('approved');
  });
  it('approve rejects non-scanned states', async () => {
    const { id, ap } = await approvedVersion();
    expect(ap.status).toBe(200);
    const again = await request(app).post(`/api/learning/skill-versions/${id}/approve?user_id=u1`).set(H('admin', 'admin'));
    expect(again.status).toBe(400);
  });
  it('activate rolls back the previously active version atomically', async () => {
    const cand = seedCandidate('u1');
    const c1 = await request(app).post(`/api/learning/candidates/${cand}/compile`).set(H('u1'));
    const v1 = c1.body.version.id;
    await request(app).post(`/api/learning/skill-versions/${v1}/approve?user_id=u1`).set(H('admin', 'admin'));
    const a1 = await request(app).post(`/api/learning/skill-versions/${v1}/activate?user_id=u1`).set(H('admin', 'admin'));
    expect(a1.body.version.state).toBe('active');

    const c2 = await request(app).post(`/api/learning/candidates/${cand}/compile`).set(H('u1'));
    const v2 = c2.body.version.id;
    expect(c2.body.version.version_number).toBe(2);
    await request(app).post(`/api/learning/skill-versions/${v2}/approve?user_id=u1`).set(H('admin', 'admin'));
    const a2 = await request(app).post(`/api/learning/skill-versions/${v2}/activate?user_id=u1`).set(H('admin', 'admin'));
    expect(a2.body.version.state).toBe('active');
    expect(a2.body.rolled_back).toContain(v1);

    const d1 = await request(app).get(`/api/learning/skill-versions/${v1}`).set(H('u1'));
    expect(d1.body.version.state).toBe('rolled_back');
    // Exactly one active per candidate.
    const actives = db.prepare(`SELECT COUNT(*) c FROM learning_skill_versions
      WHERE candidate_id = ? AND state = 'active'`).get(cand).c;
    expect(actives).toBe(1);
    expect(auditCalls.some(a => a.action === 'learning.version.activate')).toBe(true);
  });
  it('activate only works from approved', async () => {
    const { res } = await compileAs('u1');
    const r = await request(app).post(`/api/learning/skill-versions/${res.body.version.id}/activate?user_id=u1`).set(H('admin', 'admin'));
    expect(r.status).toBe(400);
  });
  it('rollback moves active -> rolled_back', async () => {
    const { id } = await approvedVersion();
    await request(app).post(`/api/learning/skill-versions/${id}/activate?user_id=u1`).set(H('admin', 'admin'));
    const rb = await request(app).post(`/api/learning/skill-versions/${id}/rollback?user_id=u1`).set(H('admin', 'admin'));
    expect(rb.status).toBe(200);
    expect(rb.body.version.state).toBe('rolled_back');
    expect(auditCalls.some(a => a.action === 'learning.version.rollback')).toBe(true);
  });
  it('rollback rejects non-active/non-approved states', async () => {
    const { res } = await compileAs('u1');
    const r = await request(app).post(`/api/learning/skill-versions/${res.body.version.id}/rollback?user_id=u1`).set(H('admin', 'admin'));
    expect(r.status).toBe(400);
  });
});
