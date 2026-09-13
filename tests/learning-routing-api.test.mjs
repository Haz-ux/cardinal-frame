// Phase 5 routing API — route tests.
// Uses supertest against the real learning router with an in-memory DB.
// CI runs these; they can't run on the dev box (Node 24 bus-errors on
// vitest, pre-existing).
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'crypto';
import learningRoutes from '../src/server/routes/learning.mjs';
import { getRetrievalFlags } from '../src/server/learning/retrieval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;
let app;
let auditCalls;

function freshDb() {
  const d = new Database(':memory:');
  for (const f of ['014_learning_events.sql', '026_learning_candidates.sql', '028_learning_skill_versions.sql', '029_learning_retrieval.sql']) {
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

const U1 = 'user-1', U2 = 'user-2';

function seedDecision(userId, overrides = {}) {
  const id = randomUUID();
  db.prepare(`INSERT INTO learning_routing_decisions
    (id, user_id, request_hash, request_excerpt, winner_version_id, winner_score,
     runner_up_score, margin, decision, fallback_reason, mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shadow', datetime('now'))`)
    .run(id, userId,
      createHash('sha256').update('req').digest('hex'),
      overrides.request_excerpt || 'check the deploy gate',
      overrides.winner_version_id || null,
      overrides.winner_score ?? null,
      overrides.runner_up_score ?? null,
      overrides.margin ?? null,
      overrides.decision || 'shadow_routed',
      overrides.fallback_reason || null);
  return id;
}

function seedVersionWithStats(userId, vid, candTitle, stats) {
  const candId = randomUUID();
  db.prepare(`INSERT INTO learning_candidates (id, user_id, kind, title, draft, state, risk_tier, created_at)
    VALUES (?, ?, 'procedure', ?, 'draft', 'promoted', 'low', datetime('now'))`)
    .run(candId, userId, candTitle);
  db.prepare(`INSERT INTO learning_skill_versions
    (id, user_id, candidate_id, version_number, kind, spec, artifact, content_hash, requires_docker, state, created_at, updated_at)
    VALUES (?, ?, ?, 1, 'prompt_template', '{}', 'artifact', 'hash', 0, 'active', datetime('now'), datetime('now'))`)
    .run(vid, userId, candId);
  if (stats) {
    db.prepare(`INSERT INTO learning_skill_stats (version_id, routed_count, success_count, failure_count, last_routed_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run(vid, stats.routed_count, stats.success_count, stats.failure_count);
  }
  return vid;
}

beforeEach(() => {
  db = freshDb();
  app = makeApp();
});

describe('GET /api/learning/routing/decisions', () => {
  it('returns recent-first decisions with winner metadata', async () => {
    seedVersionWithStats(U1, 'v1', 'Deploy Gate');
    const id = seedDecision(U1, { winner_version_id: 'v1', winner_score: 0.9, runner_up_score: 0.7, margin: 0.2 });
    const res = await request(app).get('/api/learning/routing/decisions').set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
    const d = res.body.decisions[0];
    expect(d).toMatchObject({
      id, winner_version_id: 'v1', winner_title: 'Deploy Gate',
      winner_kind: 'prompt_template', winner_score: 0.9,
      runner_up_score: 0.7, margin: 0.2, decision: 'shadow_routed', mode: 'shadow',
    });
    expect(d.created_at).toBeTruthy();
  });

  it('is owner-scoped (no cross-user leakage)', async () => {
    seedDecision(U1, {});
    const res = await request(app).get('/api/learning/routing/decisions').set(H(U2));
    expect(res.status).toBe(200);
    expect(res.body.decisions).toEqual([]);
  });

  it('admin ?user_id= override works', async () => {
    seedDecision(U1, {});
    const res = await request(app).get('/api/learning/routing/decisions?user_id=user-1').set(H('admin-1', 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
  });

  it('non-admin ?user_id= is ignored (own data only)', async () => {
    seedDecision(U1, {});
    const res = await request(app).get('/api/learning/routing/decisions?user_id=user-1').set(H(U2));
    expect(res.body.decisions).toEqual([]);
  });
});

describe('GET /api/learning/routing/stats', () => {
  it('returns per-version counters plus summary', async () => {
    seedVersionWithStats(U1, 'v1', 'Deploy Gate', { routed_count: 4, success_count: 3, failure_count: 1 });
    seedDecision(U1, { winner_version_id: 'v1', winner_score: 0.9, runner_up_score: 0.7, margin: 0.2, decision: 'shadow_routed' });
    seedDecision(U1, { decision: 'fallback_normal', fallback_reason: 'top score 0.650 below floor 0.700' });
    const res = await request(app).get('/api/learning/routing/stats').set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    const v = res.body.versions[0];
    expect(v).toMatchObject({
      version_id: 'v1', title: 'Deploy Gate', routed_count: 4,
      success_count: 3, failure_count: 1,
    });
    expect(v.success_rate).toBeCloseTo(4 / 6, 6); // Laplace (3+1)/(3+1+2)
    expect(res.body.summary).toMatchObject({
      total_decisions: 2, fallback_rate: 0.5, avg_margin: 0.2,
    });
  });

  it('empty users get zeroed summary', async () => {
    const res = await request(app).get('/api/learning/routing/stats').set(H(U2));
    expect(res.status).toBe(200);
    expect(res.body.versions).toEqual([]);
    expect(res.body.summary).toMatchObject({ total_decisions: 0, fallback_rate: 0, avg_margin: null });
  });
});

describe('POST /api/learning/routing/decisions/:id/feedback', () => {
  it('records route feedback and bumps route counters', async () => {
    seedVersionWithStats(U1, 'v1', 'Deploy Gate', { routed_count: 1, success_count: 0, failure_count: 0 });
    const id = seedDecision(U1, { winner_version_id: 'v1', winner_score: 0.9 });
    const res = await request(app)
      .post(`/api/learning/routing/decisions/${id}/feedback`)
      .set(H(U1))
      .send({ ledger: 'route', positive: true, detail: 'good pick' });
    expect(res.status).toBe(200);
    expect(res.body.feedback).toMatchObject({ decisionId: id, ledger: 'route', positive: true });
    const stats = db.prepare('SELECT * FROM learning_skill_stats WHERE version_id = ?').get('v1');
    expect(stats.success_count).toBe(1);
    expect(auditCalls.some(a => a.action === 'learning.routing.feedback')).toBe(true);
  });

  it('execution feedback writes a feedback row but never touches route counters', async () => {
    seedVersionWithStats(U1, 'v1', 'Deploy Gate', { routed_count: 1, success_count: 0, failure_count: 0 });
    const id = seedDecision(U1, { winner_version_id: 'v1', winner_score: 0.9 });
    const res = await request(app)
      .post(`/api/learning/routing/decisions/${id}/feedback`)
      .set(H(U1))
      .send({ ledger: 'execution', positive: false, detail: 'runtime failure' });
    expect(res.status).toBe(200);
    const stats = db.prepare('SELECT * FROM learning_skill_stats WHERE version_id = ?').get('v1');
    expect(stats.success_count).toBe(0);
    expect(stats.failure_count).toBe(0);
    const rows = db.prepare('SELECT ledger, positive FROM learning_route_feedback WHERE decision_id = ?').all(id);
    expect(rows).toEqual([{ ledger: 'execution', positive: 0 }]);
  });

  it('validates input', async () => {
    const id = seedDecision(U1, {});
    for (const body of [
      { ledger: 'bogus', positive: true },
      { ledger: 'route', positive: 'yes' },
      {},
    ]) {
      const res = await request(app)
        .post(`/api/learning/routing/decisions/${id}/feedback`)
        .set(H(U1)).send(body);
      expect(res.status).toBe(400);
    }
  });

  it('cross-user feedback is a 404', async () => {
    const id = seedDecision(U1, {});
    const res = await request(app)
      .post(`/api/learning/routing/decisions/${id}/feedback`)
      .set(H(U2)).send({ ledger: 'route', positive: true });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/learning/retrieval/flags', () => {
  it('returns the phase kill-switches', async () => {
    const res = await request(app).get('/api/learning/retrieval/flags').set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual(getRetrievalFlags());
    expect(res.body.flags.curator).toBe(false);
  });
});
