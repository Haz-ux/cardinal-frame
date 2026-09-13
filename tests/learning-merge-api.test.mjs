import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import learningRoutes from '../src/server/routes/learning.mjs';

// Deterministic similarity for CI: embedder always throws → lexical
// fallback (no model load, no network).
vi.mock('../src/server/embeddings.mjs', () => ({
  embedBatch: async () => { throw new Error('mock embedder failure'); },
  cosineSimilarity: () => 0,
  unloadEmbeddingModel: () => {},
  getEmbeddingPipeline: async () => { throw new Error('mock embedder failure'); },
  isModelLoaded: () => false,
  getEmbeddingStatus: () => ({ loaded: false }),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;

function freshDb() {
  const d = new Database(':memory:');
  for (const f of ['014_learning_events.sql', '022_learning_events.sql',
                   '026_learning_candidates.sql', '027_learning_clusters.sql']) {
    d.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return d;
}

function makeCtx() {
  const auditCalls = [];
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
    logger: { info() {}, debug() {}, warn() {}, error() {} },
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
  return { app, auditCalls };
}

const NOW = new Date().toISOString();

function seedCandidate(userId, fields) {
  const {
    id = randomUUID(), title = 'T', draft = [], state = 'candidate', score = 0.5,
    verified = 0, recovered = 0, corrections = 0,
  } = fields;
  db.prepare(`INSERT INTO learning_candidates
    (id, user_id, kind, title, draft, risk_tier, state, support_verified,
     support_recovered, support_corrections, promotion_score, created_at, updated_at)
    VALUES (?, ?, 'procedure', ?, ?, 'low', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, title, JSON.stringify(draft), state,
      verified, recovered, corrections, score, NOW, NOW);
  return id;
}

function seedEvent(userId, id = randomUUID()) {
  db.prepare(`INSERT INTO learning_events (id, user_id, kind, type, payload, outcome, created_at)
    VALUES (?, ?, 'tool', 'tool', ?, 'success', ?)`)
    .run(id, userId, JSON.stringify({ tool: 'curl' }), NOW);
  return id;
}

function seedEvidence(candidateId, eventId, role = 'success', weight = 1.0) {
  db.prepare(`INSERT INTO candidate_evidence (id, candidate_id, event_id, role, weight, excerpt_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), candidateId, eventId, role, weight, 'h', NOW);
}

const U = 'u-api';
const hdr = { 'x-test-user': U };

beforeEach(() => {
  db = freshDb();
});

describe('GET /api/learning/clusters', () => {
  it('returns empty list when nothing clustered', async () => {
    const { app } = makeCtx();
    const res = await request(app).get('/api/learning/clusters').set(hdr);
    expect(res.status).toBe(200);
    expect(res.body.clusters).toEqual([]);
  });

  it('401 without auth', async () => {
    const { app } = makeCtx();
    const res = await request(app).get('/api/learning/clusters');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/learning/cluster/run', () => {
  it('clusters lexically-similar candidates and creates a proposal', async () => {
    const { app, auditCalls } = makeCtx();
    seedCandidate(U, { id: 'c1', title: 'Deploy health check',
      draft: ['ping the staging health endpoint', 'page the on-call engineer after two failures'],
      score: 0.9, verified: 2 });
    seedCandidate(U, { id: 'c2', title: 'Staging health monitor',
      draft: ['check the staging health endpoint', 'alert the on-call engineer after two failures'],
      score: 0.8, verified: 3 });
    seedCandidate(U, { id: 'c3', title: 'Log rotation',
      draft: ['rotate service logs at one hundred megabytes', 'compress old archives'],
      score: 0.7 });

    const run = await request(app).post('/api/learning/cluster/run')
      .set(hdr).send({ threshold: 0.4 });
    expect(run.status).toBe(200);
    expect(run.body.stats.method).toBe('lexical');
    expect(run.body.stats.threshold).toBe(0.4);
    expect(run.body.stats.clusters_formed).toBe(2);
    expect(run.body.stats.proposals_created).toBe(1);
    expect(auditCalls.some(a => a.action === 'learning.cluster.run')).toBe(true);

    const clusters = await request(app).get('/api/learning/clusters').set(hdr);
    expect(clusters.status).toBe(200);
    expect(clusters.body.clusters.length).toBe(2);
    const big = clusters.body.clusters.find(c => c.member_count === 2);
    expect(big).toBeTruthy();
    expect(big.is_legacy_readonly).toBe(false);
    expect(big.members.length).toBe(2);
    const centroid = big.members.find(m => m.is_centroid);
    expect(centroid.candidate_id).toBe('c1'); // highest score
    expect(centroid.title).toBe('Deploy health check');
    expect(big.avg_similarity).toBeGreaterThan(0);

    const props = await request(app).get('/api/learning/merge-proposals').set(hdr);
    expect(props.status).toBe(200);
    expect(props.body.proposals.length).toBe(1);
    expect(props.body.proposals[0].from_candidate_ids).toEqual(['c1', 'c2']);
    expect(props.body.proposals[0].combined_support).toEqual({ verified: 5, recovered: 0, corrections: 2 });
    expect(props.body.proposals[0].member_titles.length).toBe(2);
  });

  it('ignores invalid body thresholds and falls back to env default', async () => {
    const { app } = makeCtx();
    seedCandidate(U, { id: 'c1', title: 'Solo one', draft: ['x'], score: 0.5 });
    const run = await request(app).post('/api/learning/cluster/run')
      .set(hdr).send({ threshold: 'garbage' });
    expect(run.status).toBe(200);
    expect(run.body.stats.threshold).toBe(0.8);
  });

  it('is owner-scoped: another user sees nothing', async () => {
    const { app } = makeCtx();
    seedCandidate(U, { id: 'c1', title: 'Deploy health check',
      draft: ['ping the staging health endpoint'], score: 0.9 });
    seedCandidate(U, { id: 'c2', title: 'Staging health monitor',
      draft: ['check the staging health endpoint'], score: 0.8 });
    await request(app).post('/api/learning/cluster/run').set(hdr).send({ threshold: 0.3 });
    const other = await request(app).get('/api/learning/clusters')
      .set({ 'x-test-user': 'u-other' });
    expect(other.status).toBe(200);
    expect(other.body.clusters).toEqual([]);
  });
});

describe('merge proposal approve/dismiss', () => {
  function seedProposal() {
    const c1 = seedCandidate(U, { id: 'c1', title: 'Deploy health check',
      draft: ['ping the staging health endpoint', 'page the on-call engineer after two failures'],
      score: 0.9, verified: 2 });
    const c2 = seedCandidate(U, { id: 'c2', title: 'Staging health monitor',
      draft: ['check the staging health endpoint', 'alert the on-call engineer after two failures'],
      score: 0.8, verified: 3 });
    const e1 = seedEvent(U);
    const e2 = seedEvent(U);
    seedEvidence(c1, e1, 'success', 1.0);
    seedEvidence(c2, e2, 'recovery_trigger', 1.5);
    return { c1, c2 };
  }

  async function runAndGetProposal(app) {
    const run = await request(app).post('/api/learning/cluster/run')
      .set(hdr).send({ threshold: 0.4 });
    expect(run.body.stats.proposals_created).toBe(1);
    const props = await request(app).get('/api/learning/merge-proposals').set(hdr);
    return props.body.proposals[0].id;
  }

  it('approve merges evidence, sums support, archives losers, 404s cross-user', async () => {
    const { app, auditCalls } = makeCtx();
    const { c1, c2 } = seedProposal();
    const pid = await runAndGetProposal(app);

    const res = await request(app).post(`/api/learning/merge-proposals/${pid}/approve`).set(hdr);
    expect(res.status).toBe(200);
    expect(res.body.survivor.id).toBe(c1); // highest promotion_score
    expect(res.body.survivor.support_verified).toBe(5);
    expect(res.body.proposal.state).toBe('approved');
    expect(res.body.proposal.into_candidate_id).toBe(c1);

    const loser = db.prepare('SELECT * FROM learning_candidates WHERE id = ?').get(c2);
    expect(loser.state).toBe('archived'); // row kept, not deleted
    const survEv = db.prepare('SELECT COUNT(*) c FROM candidate_evidence WHERE candidate_id = ?').get(c1).c;
    expect(survEv).toBe(2); // e1 kept + e2 re-pointed
    expect(db.prepare('SELECT COUNT(*) c FROM candidate_evidence WHERE candidate_id = ?').get(c2).c).toBe(0);

    const approveAudit = auditCalls.find(a => a.action === 'learning.merge.approve');
    expect(approveAudit).toBeTruthy();
    expect(approveAudit.details.merged_count).toBe(1);

    // Second approve → 400 (no longer proposed)
    const again = await request(app).post(`/api/learning/merge-proposals/${pid}/approve`).set(hdr);
    expect(again.status).toBe(400);

    // Cross-user → 404
    const cross = await request(app).post(`/api/learning/merge-proposals/${pid}/approve`)
      .set({ 'x-test-user': 'u-other' });
    expect(cross.status).toBe(404);
  });

  it('dismiss flips state and audits; unknown id → 404', async () => {
    const { app, auditCalls } = makeCtx();
    seedProposal();
    const pid = await runAndGetProposal(app);

    const res = await request(app).post(`/api/learning/merge-proposals/${pid}/dismiss`).set(hdr);
    expect(res.status).toBe(200);
    expect(res.body.proposal.state).toBe('dismissed');
    expect(res.body.proposal.decided_at).toBeTruthy();
    expect(auditCalls.some(a => a.action === 'learning.merge.dismiss')).toBe(true);

    // Nothing merged: both candidates still live
    expect(db.prepare('SELECT state FROM learning_candidates WHERE id = ?').get('c2').state).toBe('candidate');

    // Dismiss again → 400
    const again = await request(app).post(`/api/learning/merge-proposals/${pid}/dismiss`).set(hdr);
    expect(again.status).toBe(400);

    // Unknown id → 404
    const missing = await request(app).post('/api/learning/merge-proposals/nope/dismiss').set(hdr);
    expect(missing.status).toBe(404);
    const cross = await request(app).post(`/api/learning/merge-proposals/${pid}/dismiss`)
      .set({ 'x-test-user': 'u-other' });
    expect(cross.status).toBe(404);
  });

  it('merge-proposals state filter validates input', async () => {
    const { app } = makeCtx();
    const res = await request(app).get('/api/learning/merge-proposals?state=bogus').set(hdr);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/learning/cluster/backfill-legacy', () => {
  it('imports read-only legacy clusters visible in the list', async () => {
    const { app } = makeCtx();
    db.exec(`CREATE TABLE learn_patterns (pattern_key TEXT, description TEXT, occurrence_count INTEGER)`);
    db.prepare(`INSERT INTO learn_patterns VALUES ('p1','Old pattern one',5)`).run();

    const res = await request(app).post('/api/learning/cluster/backfill-legacy').set(hdr);
    expect(res.status).toBe(200);
    expect(res.body.result.imported).toBe(1);

    const clusters = await request(app).get('/api/learning/clusters').set(hdr);
    const legacy = clusters.body.clusters.find(c => c.is_legacy_readonly);
    expect(legacy).toBeTruthy();
    expect(legacy.label).toBe('Old pattern one');
    expect(legacy.member_count).toBe(5);
    expect(legacy.members).toEqual([]);

    // Idempotent: second call imports nothing
    const again = await request(app).post('/api/learning/cluster/backfill-legacy').set(hdr);
    expect(again.body.result.imported).toBe(0);
  });
});
