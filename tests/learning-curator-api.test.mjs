// Phase 6 curator API — route tests.
// Uses supertest against the real learning router with an in-memory DB.
// CI runs these; they can't run on the dev box (Node 24 bus-errors on
// vitest, pre-existing).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import learningRoutes from '../src/server/routes/learning.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

const U1 = 'user-1', U2 = 'user-2';
const dISO = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

let db;
let app;
let auditCalls;

function freshDb() {
  const d = new Database(':memory:');
  for (const f of [
    '014_learning_events.sql',
    '022_learning_events.sql',
    '026_learning_candidates.sql',
    '027_learning_clusters.sql',
    '028_learning_skill_versions.sql', '032_learning_skill_versions_one_active.sql',
    '029_learning_retrieval.sql',
    '030_learning_curator.sql',
  ]) {
    d.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return d;
}

function seedCandidate(id, userId = U1, { title = `cand-${id}`, score = 0.8 } = {}) {
  db.prepare(`INSERT INTO learning_candidates (id, user_id, kind, title, risk_tier, state, promotion_score)
    VALUES (?,?,?,?,?,?,?)`).run(id, userId, 'procedure', title, 'low', 'promoted', score);
}

function seedVersion(id, userId = U1, candId, overrides = {}) {
  db.prepare(`INSERT INTO learning_skill_versions
    (id, user_id, candidate_id, version_number, kind, spec, rationale, artifact, content_hash,
     scanner_verdict, test_report, requires_docker, state, pinned, stale, archived, quarantined)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, candId, 1, 'prompt_template', JSON.stringify({ problem_signature: `sig-${id}` }),
      'r', `artifact-${id}`, 'hash', '{}', '{}', 0, 'active',
      overrides.pinned ? 1 : 0, overrides.stale ? 1 : 0,
      overrides.archived ? 1 : 0, overrides.quarantined ? 1 : 0);
}

function seedStats(vid, { s = 0, f = 0, routed = 0, last = null } = {}) {
  db.prepare(`INSERT INTO learning_skill_stats (version_id, routed_count, success_count, failure_count, last_routed_at)
    VALUES (?,?,?,?,?)`).run(vid, routed, s, f, last);
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

const H = (user, role = 'admin') => ({ 'x-test-user': user, 'x-test-role': role });
const flagOf = (vid, col) => db.prepare(`SELECT ${col} AS v FROM learning_skill_versions WHERE id = ?`).get(vid).v;

beforeEach(() => {
  db = freshDb();
  app = makeApp();
});

async function twoReviewedDryRuns(user = U1) {
  // Each dry run must actually produce findings (L10: a finding-less or
  // errored dry run does not count toward prune eligibility). Seed a fresh
  // stale version per run so every run yields >=1 finding.
  for (let i = 0; i < 2; i++) {
    seedCandidate(`proof-c${i}`, user);
    seedVersion(`proof-v${i}`, user, `proof-c${i}`);
    seedStats(`proof-v${i}`, { last: dISO(45) });
    const run = await request(app).post('/api/learning/curator/run').set(H(user)).send({ mode: 'dry_run' });
    await request(app).post(`/api/learning/curator/runs/${run.body.run.id}/review`).set(H(user));
  }
}

describe('POST /api/learning/curator/run', () => {
  it('runs a dry run and returns { run, recommendations }', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    const res = await request(app).post('/api/learning/curator/run').set(H(U1)).send({});
    expect(res.status).toBe(200);
    expect(res.body.run.mode).toBe('dry_run');
    expect(res.body.run.reviewed).toBe(false);
    expect(res.body.run.policy_snapshot.stale_after_days).toBe(30);
    expect(res.body.run.findings_count).toBe(1);
    expect(res.body.run.applied_count).toBe(0);
    expect(res.body.recommendations).toHaveLength(1);
    expect(res.body.recommendations[0].kind).toBe('stale');
    expect(res.body.recommendations[0].version_title).toBe('cand-c1');
    expect(auditCalls.some((a) => a.action === 'learning.curator.run')).toBe(true);
  });

  it('rejects prune before two reviewed dry runs with 400', async () => {
    const res = await request(app).post('/api/learning/curator/run').set(H(U1)).send({ mode: 'prune' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('prune_not_eligible');
    expect(res.body.reviewed).toBe(0);
  });

  it('allows prune after two reviewed dry runs and auto-applies only stale', async () => {
    await twoReviewedDryRuns();
    // Seed AFTER the dry runs so nothing is deduped against them.
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    seedCandidate('c2'); seedVersion('v2', U1, 'c2');
    seedStats('v2', { s: 1, f: 5, last: dISO(1) });
    const res = await request(app).post('/api/learning/curator/run').set(H(U1)).send({ mode: 'prune' });
    expect(res.status).toBe(200);
    expect(res.body.run.mode).toBe('prune');
    expect(flagOf('v1', 'stale')).toBe(1);
    expect(flagOf('v2', 'quarantined')).toBe(0);
    const byId = Object.fromEntries(res.body.recommendations.map((r) => [r.version_id, r]));
    expect(byId.v1.state).toBe('applied');
    expect(byId.v2.state).toBe('proposed');
  });

  it('requires admin', async () => {
    const res = await request(app).post('/api/learning/curator/run').set(H(U1, 'user')).send({});
    expect(res.status).toBe(403);
  });
});

describe('GET /api/learning/curator/runs', () => {
  it('lists runs newest-first with the documented projection', async () => {
    await request(app).post('/api/learning/curator/run').set(H(U1)).send({ mode: 'dry_run' });
    const res = await request(app).get('/api/learning/curator/runs').set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(Object.keys(res.body.runs[0]).sort()).toEqual(
      ['applied_count', 'created_at', 'findings_count', 'id', 'mode', 'policy_snapshot', 'reviewed']);
  });

  it('is owner-scoped', async () => {
    await request(app).post('/api/learning/curator/run').set(H(U1)).send({ mode: 'dry_run' });
    const res = await request(app).get('/api/learning/curator/runs').set(H(U2));
    expect(res.body.runs).toEqual([]);
  });
});

describe('GET /api/learning/curator/recommendations', () => {
  it('returns the documented projection with version titles', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    await request(app).post('/api/learning/curator/run').set(H(U1)).send({});
    const res = await request(app).get('/api/learning/curator/recommendations').set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.recommendations).toHaveLength(1);
    expect(Object.keys(res.body.recommendations[0]).sort()).toEqual(
      ['created_at', 'decided_at', 'decided_by', 'evidence', 'id', 'kind', 'reason',
        'run_id', 'state', 'version_id', 'version_kind', 'version_state', 'version_title']);
    expect(res.body.recommendations[0].version_title).toBe('cand-c1');
    expect(res.body.recommendations[0].version_state).toBe('active');
  });

  it('filters by state and rejects bad states', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    await request(app).post('/api/learning/curator/run').set(H(U1)).send({});
    const res = await request(app).get('/api/learning/curator/recommendations?state=proposed').set(H(U1));
    expect(res.body.recommendations).toHaveLength(1);
    const empty = await request(app).get('/api/learning/curator/recommendations?state=applied').set(H(U1));
    expect(empty.body.recommendations).toEqual([]);
    const bad = await request(app).get('/api/learning/curator/recommendations?state=bogus').set(H(U1));
    expect(bad.status).toBe(400);
  });

  it('is owner-scoped', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    await request(app).post('/api/learning/curator/run').set(H(U1)).send({});
    const res = await request(app).get('/api/learning/curator/recommendations').set(H(U2));
    expect(res.body.recommendations).toEqual([]);
  });
});

describe('recommendation approve/dismiss', () => {
  async function proposedRec() {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    await request(app).post('/api/learning/curator/run').set(H(U1)).send({});
    const res = await request(app).get('/api/learning/curator/recommendations?state=proposed').set(H(U1));
    return res.body.recommendations[0];
  }

  it('approve applies the flag and returns { recommendation, applied }', async () => {
    const rec = await proposedRec();
    const res = await request(app).post(`/api/learning/curator/recommendations/${rec.id}/approve`).set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.recommendation.state).toBe('applied');
    expect(flagOf('v1', 'stale')).toBe(1);
    expect(auditCalls.some((a) => a.action === 'learning.curator.recommendation.approve')).toBe(true);
  });

  it('cross-user approve returns 404', async () => {
    const rec = await proposedRec();
    const res = await request(app).post(`/api/learning/curator/recommendations/${rec.id}/approve`).set(H(U2));
    expect(res.status).toBe(404);
  });

  it('approve of a decided recommendation returns 400', async () => {
    const rec = await proposedRec();
    await request(app).post(`/api/learning/curator/recommendations/${rec.id}/approve`).set(H(U1));
    const res = await request(app).post(`/api/learning/curator/recommendations/${rec.id}/approve`).set(H(U1));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('not_proposed');
  });

  it('dismiss flips state without touching the version', async () => {
    const rec = await proposedRec();
    const res = await request(app).post(`/api/learning/curator/recommendations/${rec.id}/dismiss`).set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.recommendation.state).toBe('dismissed');
    expect(flagOf('v1', 'stale')).toBe(0);
    expect(auditCalls.some((a) => a.action === 'learning.curator.recommendation.dismiss')).toBe(true);
  });

  it('cross-user dismiss returns 404', async () => {
    const rec = await proposedRec();
    const res = await request(app).post(`/api/learning/curator/recommendations/${rec.id}/dismiss`).set(H(U2));
    expect(res.status).toBe(404);
  });

  it('non-admin cannot approve or dismiss', async () => {
    const rec = await proposedRec();
    const r1 = await request(app).post(`/api/learning/curator/recommendations/${rec.id}/approve`).set(H(U1, 'user'));
    const r2 = await request(app).post(`/api/learning/curator/recommendations/${rec.id}/dismiss`).set(H(U1, 'user'));
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
  });
});

describe('POST /api/learning/curator/runs/:id/review', () => {
  it('marks a run reviewed', async () => {
    const runRes = await request(app).post('/api/learning/curator/run').set(H(U1)).send({});
    const res = await request(app).post(`/api/learning/curator/runs/${runRes.body.run.id}/review`).set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.run.reviewed).toBe(true);
    expect(auditCalls.some((a) => a.action === 'learning.curator.run.review')).toBe(true);
  });

  it('cross-user review returns 404', async () => {
    const runRes = await request(app).post('/api/learning/curator/run').set(H(U1)).send({});
    const res = await request(app).post(`/api/learning/curator/runs/${runRes.body.run.id}/review`).set(H(U2));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/learning/skill-versions/:id/pin', () => {
  it('pins and unpins a version', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    const pin = await request(app).post('/api/learning/skill-versions/v1/pin').set(H(U1)).send({ pinned: true });
    expect(pin.status).toBe(200);
    expect(pin.body).toEqual({ id: 'v1', pinned: true });
    expect(flagOf('v1', 'pinned')).toBe(1);
    const unpin = await request(app).post('/api/learning/skill-versions/v1/pin').set(H(U1)).send({ pinned: false });
    expect(unpin.body.pinned).toBe(false);
    expect(auditCalls.some((a) => a.action === 'learning.version.pin')).toBe(true);
  });

  it('validates the body and ownership', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    const bad = await request(app).post('/api/learning/skill-versions/v1/pin').set(H(U1)).send({ pinned: 'yes' });
    expect(bad.status).toBe(400);
    const cross = await request(app).post('/api/learning/skill-versions/v1/pin').set(H(U2)).send({ pinned: true });
    expect(cross.status).toBe(404);
    const missing = await request(app).post('/api/learning/skill-versions/nope/pin').set(H(U1)).send({ pinned: true });
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/learning/skill-versions/:id/restore', () => {
  it('clears stale/archived/quarantined flags', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1', { stale: true, archived: true, quarantined: true });
    const res = await request(app).post('/api/learning/skill-versions/v1/restore').set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'v1', archived: 0, stale: 0, quarantined: 0 });
    expect(auditCalls.some((a) => a.action === 'learning.version.restore')).toBe(true);
  });

  it('cross-user restore returns 404', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1', { stale: true });
    const res = await request(app).post('/api/learning/skill-versions/v1/restore').set(H(U2));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/learning/curator/config', () => {
  it('returns config + prune gating status', async () => {
    const res = await request(app).get('/api/learning/curator/config').set(H(U1));
    expect(res.status).toBe(200);
    expect(res.body.config.stale_after_days).toBe(30);
    expect(res.body.config.archive_after_days).toBe(90);
    expect(res.body.config.quarantine_failure_rate).toBe(0.5);
    expect(res.body.config.min_failure_sample).toBe(5);
    expect(res.body.config.interval_hours).toBe(168);
    expect(res.body.config.prune_eligible).toBe(false);
    expect(res.body.config.reviewed_dry_runs).toBe(0);
  });

  it('reflects prune eligibility after two reviewed dry runs', async () => {
    await twoReviewedDryRuns();
    const res = await request(app).get('/api/learning/curator/config').set(H(U1));
    expect(res.body.config.prune_eligible).toBe(true);
    expect(res.body.config.reviewed_dry_runs).toBe(2);
  });
});

describe('LEARNING_CURATOR_ENABLED kill-switch (M8)', () => {
  afterEach(() => { delete process.env.LEARNING_CURATOR_ENABLED; });

  it('mutation routes return 403 curator_disabled when explicitly false', async () => {
    process.env.LEARNING_CURATOR_ENABLED = 'false';
    const run = await request(app).post('/api/learning/curator/run').set(H(U1)).send({ mode: 'dry_run' });
    expect(run.status).toBe(403);
    expect(run.body.error).toBe('curator_disabled');
    const approve = await request(app).post('/api/learning/curator/recommendations/x/approve').set(H(U1));
    expect(approve.status).toBe(403);
    expect(approve.body.error).toBe('curator_disabled');
    const flags = await request(app).get('/api/learning/retrieval/flags').set(H(U1));
    expect(flags.body.flags.curator).toBe(false);
  });

  it('curator routes work when the flag is unset (default enabled)', async () => {
    delete process.env.LEARNING_CURATOR_ENABLED;
    const res = await request(app).post('/api/learning/curator/run').set(H(U1)).send({ mode: 'dry_run' });
    expect(res.status).toBe(200);
    const flags = await request(app).get('/api/learning/retrieval/flags').set(H(U1));
    expect(flags.body.flags.curator).toBe(true);
  });
});
