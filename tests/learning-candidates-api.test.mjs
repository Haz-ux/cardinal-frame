import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { record } from '../src/server/learning/events.mjs';
import learningRoutes from '../src/server/routes/learning.mjs';
import { listCandidates, getCandidate } from '../src/server/learning/candidates.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;
let tv = 0;

function freshDb() {
  const d = new Database(':memory:');
  for (const f of ['014_learning_events.sql', '022_learning_events.sql', '026_learning_candidates.sql',
                   '028_learning_skill_versions.sql', '032_learning_skill_versions_one_active.sql']) {
    d.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return d;
}

function makeCtx() {
  const auditCalls = [];
  const warnings = [];
  const ctx = {
    db,
    stmts: {
      learningReviewJobs: {
        getByUser: db.prepare(`SELECT id, status, events_scanned, candidates_assembled,
          dead_lettered, budget_used, started_at, finished_at, error
          FROM learning_review_jobs WHERE user_id = ?
          ORDER BY started_at DESC, rowid DESC LIMIT 20`),
      },
    },
    logger: {
      info() {}, debug() {},
      warn: (m) => warnings.push(String(m)),
      error() {},
    },
    audit: (action, resourceType, resourceId, userId, details) => {
      auditCalls.push({ action, resourceType, resourceId, userId, details });
    },
    authMiddleware: (req, res, next) => {
      const u = req.headers['x-test-user'];
      if (!u) return res.status(401).json({ error: 'unauthorized' });
      req.user = { id: u, role: req.headers['x-test-role'] || 'user', username: u };
      next();
    },
    apiLimiter: (_req, _res, next) => next(),
  };
  const app = express();
  app.use(express.json());
  app.use('/api', learningRoutes(ctx));
  return { app, auditCalls, warnings };
}

function seedEvent(userId, traceId, type, payload, outcome, conv = 'c') {
  const r = record(db, {
    userId, conversationId: conv, traceId, type, payload, outcome,
    terminalVersion: `av${++tv}`,
  });
  if (r.error) throw new Error(`seed failed: ${r.error}`);
  return r.id;
}

function seedJob(userId, startedAt) {
  db.prepare(`INSERT INTO learning_review_jobs
    (id, user_id, status, events_scanned, candidates_assembled, started_at, finished_at)
    VALUES (?, ?, 'completed', 1, 1, ?, ?)`)
    .run(randomUUID(), userId, startedAt, startedAt);
}

beforeEach(() => {
  db = freshDb();
  delete process.env.LEARNING_REVIEW_BUDGET;
});

afterEach(() => {
  db.close();
  delete process.env.LEARNING_REVIEW_BUDGET;
});

describe('learning candidates API', () => {
  it('requires authentication', async () => {
    const { app } = makeCtx();
    await request(app).get('/api/learning/candidates').expect(401);
    await request(app).post('/api/learning/review/run').expect(401);
  });

  it('lists candidates in the list-item shape, ordered by score desc', async () => {
    const { app } = makeCtx();
    seedEvent('u1', 't1', 'tool_outcome', { tool: 'file_read' }, 'completed');
    seedEvent('u1', 't2', 'tool_outcome', { tool: 'file_read' }, 'completed');
    seedEvent('u1', 't2', 'tool_outcome', { tool: 'file_read' }, 'completed');
    await request(app).post('/api/learning/review/run').set('x-test-user', 'u1').expect(200);

    const res = await request(app).get('/api/learning/candidates').set('x-test-user', 'u1').expect(200);
    expect(res.body.candidates).toHaveLength(2);
    const [first, second] = res.body.candidates;
    expect(first.promotion_score).toBeGreaterThanOrEqual(second.promotion_score);
    expect(Object.keys(first).sort()).toEqual([
      'created_at', 'id', 'kind', 'promotion_score', 'risk_tier', 'state',
      'support_corrections', 'support_recovered', 'support_verified', 'title', 'updated_at',
    ].sort());
  });

  it('maps ?state=review to DB state candidate; rejects bad states', async () => {
    const { app } = makeCtx();
    seedEvent('u1', 't1', 'tool_outcome', { tool: 'file_read' }, 'completed');
    await request(app).post('/api/learning/review/run').set('x-test-user', 'u1').expect(200);

    const review = await request(app).get('/api/learning/candidates?state=review').set('x-test-user', 'u1').expect(200);
    expect(review.body.candidates).toHaveLength(1);
    expect(review.body.candidates[0].state).toBe('candidate');

    const promoted = await request(app).get('/api/learning/candidates?state=promoted').set('x-test-user', 'u1').expect(200);
    expect(promoted.body.candidates).toHaveLength(0);

    await request(app).get('/api/learning/candidates?state=bogus').set('x-test-user', 'u1').expect(400);
  });

  it('returns candidate detail with redacted evidence excerpts, never raw payloads', async () => {
    const { app } = makeCtx();
    seedEvent('u1', 't1', 'tool_outcome', { tool: 'file_read', path: '/secret', note: 'mail bob@example.com' }, 'completed');
    await request(app).post('/api/learning/review/run').set('x-test-user', 'u1').expect(200);
    const id = listCandidates(db, 'u1', null)[0].id;

    const res = await request(app).get(`/api/learning/candidates/${id}`).set('x-test-user', 'u1').expect(200);
    const { candidate, evidence } = res.body;
    expect(Array.isArray(candidate.draft)).toBe(true);
    expect(candidate.draft.every((s) => typeof s === 'string')).toBe(true);
    expect(Array.isArray(candidate.requested_caps)).toBe(true);
    expect(typeof candidate.quality_json).toBe('object');
    expect(typeof candidate.eligibility_note).toBe('string');
    expect(evidence).toHaveLength(1);
    const ev = evidence[0];
    expect(Object.keys(ev).sort()).toEqual([
      'created_at', 'event_id', 'event_type', 'excerpt', 'id', 'outcome', 'role', 'trace_id', 'weight',
    ].sort());
    expect(typeof ev.excerpt).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('bob@example.com');
    expect(JSON.stringify(res.body)).not.toContain('payload');
  });

  it('returns 404 for missing or other-user candidates (no existence leak)', async () => {
    const { app } = makeCtx();
    seedEvent('u1', 't1', 'tool_outcome', { tool: 'file_read' }, 'completed');
    await request(app).post('/api/learning/review/run').set('x-test-user', 'u1').expect(200);
    const id = listCandidates(db, 'u1', null)[0].id;

    await request(app).get('/api/learning/candidates/does-not-exist').set('x-test-user', 'u1').expect(404)
      .then((r) => expect(r.body).toEqual({ error: 'not found' }));
    await request(app).get(`/api/learning/candidates/${id}`).set('x-test-user', 'u2').expect(404)
      .then((r) => expect(r.body).toEqual({ error: 'not found' }));
    await request(app).post(`/api/learning/candidates/${id}/approve`).set('x-test-user', 'u2').expect(404);
    await request(app).post(`/api/learning/candidates/${id}/reject`).set('x-test-user', 'u2').send({ reason: 'x' }).expect(404);
  });

  it('approve flips state to promoted and audit-logs', async () => {
    const { app, auditCalls } = makeCtx();
    seedEvent('u1', 't1', 'tool_outcome', { tool: 'file_read' }, 'completed');
    await request(app).post('/api/learning/review/run').set('x-test-user', 'u1').expect(200);
    const id = listCandidates(db, 'u1', null)[0].id;

    const res = await request(app).post(`/api/learning/candidates/${id}/approve`).set('x-test-user', 'u1').expect(200);
    expect(res.body.candidate.state).toBe('promoted');
    expect(getCandidate(db, id, 'u1').state).toBe('promoted');
    expect(auditCalls.some((a) => a.action === 'learning.candidate.approve' && a.resourceId === id)).toBe(true);
  });

  it('logs a warning when approving a HIGH-risk candidate', async () => {
    const { app, warnings } = makeCtx();
    seedEvent('u1', 't1', 'tool_outcome', { tool: 'shell_exec', command: 'rm -rf /tmp/*' }, 'completed');
    await request(app).post('/api/learning/review/run').set('x-test-user', 'u1').expect(200);
    const id = listCandidates(db, 'u1', null)[0].id;
    expect(getCandidate(db, id, 'u1').risk_tier).toBe('high');

    await request(app).post(`/api/learning/candidates/${id}/approve`).set('x-test-user', 'u1').expect(200);
    expect(warnings.some((w) => /HIGH-risk/.test(w))).toBe(true);
  });

  it('reject sets rejected + reason + ~30d cooldown and audit-logs', async () => {
    const { app, auditCalls } = makeCtx();
    seedEvent('u1', 't1', 'tool_outcome', { tool: 'file_read' }, 'completed');
    await request(app).post('/api/learning/review/run').set('x-test-user', 'u1').expect(200);
    const id = listCandidates(db, 'u1', null)[0].id;

    const res = await request(app).post(`/api/learning/candidates/${id}/reject`)
      .set('x-test-user', 'u1').send({ reason: 'not useful' }).expect(200);
    expect(res.body.candidate.state).toBe('rejected');
    const c = getCandidate(db, id, 'u1');
    expect(c.reject_reason).toBe('not useful');
    const coolMs = Date.parse(c.cooldown_until) - Date.now();
    expect(coolMs).toBeGreaterThan(29.9 * 864e5);
    expect(coolMs).toBeLessThan(30.1 * 864e5);
    expect(auditCalls.some((a) => a.action === 'learning.candidate.reject' && a.resourceId === id)).toBe(true);
  });
});

describe('learning review job API', () => {
  it('POST /review/run runs synchronously and returns the job shape', async () => {
    const { app, auditCalls } = makeCtx();
    seedEvent('u1', 't1', 'tool_outcome', { tool: 'file_read' }, 'completed');
    const res = await request(app).post('/api/learning/review/run').set('x-test-user', 'u1').expect(200);
    const { job } = res.body;
    expect(Object.keys(job).sort()).toEqual([
      'budget_used', 'candidates_assembled', 'dead_lettered', 'error',
      'events_scanned', 'finished_at', 'id', 'started_at', 'status',
    ].sort());
    expect(job.status).toBe('completed');
    expect(job.events_scanned).toBe(1);
    expect(job.candidates_assembled).toBe(1);
    expect(auditCalls.some((a) => a.action === 'learning.review.run')).toBe(true);
  });

  it('admin may run a review for another user via ?user_id=', async () => {
    const { app } = makeCtx();
    seedEvent('u-target', 't1', 'tool_outcome', { tool: 'file_read' }, 'completed');
    const res = await request(app).post('/api/learning/review/run?user_id=u-target')
      .set('x-test-user', 'admin1').set('x-test-role', 'admin').expect(200);
    expect(res.body.job.candidates_assembled).toBe(1);
    expect(listCandidates(db, 'u-target', null)).toHaveLength(1);
    expect(listCandidates(db, 'admin1', null)).toHaveLength(0);
  });

  it('non-admin ?user_id= is ignored (owner-scoped)', async () => {
    const { app } = makeCtx();
    seedEvent('u-target', 't1', 'tool_outcome', { tool: 'file_read' }, 'completed');
    const res = await request(app).post('/api/learning/review/run?user_id=u-target')
      .set('x-test-user', 'u1').expect(200);
    expect(res.body.job.candidates_assembled).toBe(0);
    expect(listCandidates(db, 'u-target', null)).toHaveLength(0);
  });

  it('GET /review/jobs returns most recent first, limited to 20', async () => {
    const { app } = makeCtx();
    for (let i = 0; i < 21; i++) {
      seedJob('u1', new Date(Date.now() + i * 1000).toISOString());
    }
    seedJob('u2', new Date().toISOString());
    const res = await request(app).get('/api/learning/review/jobs').set('x-test-user', 'u1').expect(200);
    expect(res.body.jobs).toHaveLength(20);
    const times = res.body.jobs.map((j) => j.started_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(res.body.jobs.every((j) => j.status === 'completed')).toBe(true);
  });
});
