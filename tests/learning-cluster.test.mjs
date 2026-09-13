import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Deterministic similarity for CI: the embedder always throws here, so
// every buildSimilarity call exercises the lexical fallback (no model
// load, no network, no timers).
vi.mock('../src/server/embeddings.mjs', () => ({
  embedBatch: async () => { throw new Error('mock embedder failure'); },
  cosineSimilarity: () => 0,
  unloadEmbeddingModel: () => {},
  getEmbeddingPipeline: async () => { throw new Error('mock embedder failure'); },
  isModelLoaded: () => false,
  getEmbeddingStatus: () => ({ loaded: false }),
}));
import {
  signatureFor,
  tokenize,
  lexicalSimilarity,
  buildSimilarity,
  clusterCandidates,
  proposeMerges,
  runClustering,
  backfillLegacyClusters,
  MERGEABLE_STATES,
  isMergeable,
} from '../src/server/learning/cluster.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

function freshDb() {
  const d = new Database(':memory:');
  for (const f of ['026_learning_candidates.sql', '027_learning_clusters.sql']) {
    d.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return d;
}

function seedCandidate(db, userId, fields) {
  const {
    id, title = 'T', draft = [], state = 'candidate', score = 0.5,
    verified = 0, recovered = 0, corrections = 0, cooldown = null,
  } = fields;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO learning_candidates
    (id, user_id, kind, title, draft, risk_tier, state, support_verified,
     support_recovered, support_corrections, promotion_score, cooldown_until, created_at, updated_at)
    VALUES (?, ?, 'procedure', ?, ?, 'low', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, title, JSON.stringify(draft), state,
      verified, recovered, corrections, score, cooldown, now, now);
  return id;
}

// Stub similarity: c1/c2/c3 near-identical, c4 distinct.
function stubSimFactory(ids) {
  const hi = new Set(['c1,c2', 'c1,c3', 'c2,c3']);
  return (i, j) => {
    if (i === j) return 1;
    const key = [ids[i], ids[j]].sort().join(',');
    return hi.has(key) ? 0.92 : 0.05;
  };
}

describe('cluster.mjs pure functions', () => {
  it('signatureFor joins title + draft steps, handles array or JSON string', () => {
    expect(signatureFor({ title: 'T', draft: ['a', 'b'] })).toBe('T\na\nb');
    expect(signatureFor({ title: 'T', draft: '["a"]' })).toBe('T\na');
    expect(signatureFor({ title: 'T' })).toBe('T\n');
    expect(signatureFor(null)).toBe('\n');
  });

  it('tokenize lowercases, splits, drops stopwords and short tokens', () => {
    const t = tokenize('The API retry POLICY, use it!');
    expect(t.has('the')).toBe(false);
    expect(t.has('it')).toBe(false);   // stopword
    expect(t.has('api')).toBe(true);
    expect(t.has('retry')).toBe(true);
    expect(t.has('policy')).toBe(true);
    expect(t.has('use')).toBe(false);  // < 3 chars after stopword? 'use' is stopword
  });

  it('lexicalSimilarity: 1 for identical, 0 for disjoint, 0 for empty', () => {
    expect(lexicalSimilarity('hello world test', 'hello world test')).toBe(1);
    expect(lexicalSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
    expect(lexicalSimilarity('', '')).toBe(0);
    const s = lexicalSimilarity('deploy health check', 'deploy health monitor');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('buildSimilarity with no signatures returns lexical without loading the model', async () => {
    const { sim, method } = await buildSimilarity([]);
    expect(method).toBe('lexical');
    expect(sim(0, 0)).toBe(1);
  });

  it('buildSimilarity falls back to lexical when the embedder throws', async () => {
    const { sim, method } = await buildSimilarity(['deploy health check ping staging', 'deploy health check ping staging']);
    expect(method).toBe('lexical');
    expect(sim(0, 1)).toBeGreaterThan(0.9);
  });
});

describe('clusterCandidates', () => {
  const cands = [
    { promotion_score: 0.9 }, { promotion_score: 0.85 },
    { promotion_score: 0.7 }, { promotion_score: 0.8 },
  ];
  const ids = ['c1', 'c2', 'c3', 'c4'];

  it('groups the paraphrases, leaves the distinct candidate singleton', () => {
    const plan = clusterCandidates(cands, { threshold: 0.8, similarity: stubSimFactory(ids) });
    expect(plan.length).toBe(2);
    const big = plan.find(p => p.members.length === 3);
    expect(big).toBeTruthy();
    expect(big.members.slice().sort()).toEqual([0, 1, 2]);
    expect(big.avgSim).toBeGreaterThan(0);
    expect(plan.find(p => p.members.length === 1).avgSim).toBe(0);
  });

  it('respects the threshold: high threshold splits', () => {
    const plan = clusterCandidates(cands, { threshold: 0.99, similarity: stubSimFactory(ids) });
    expect(plan.length).toBe(4);
  });

  it('orders by promotion_score: centroid is the highest-score member', () => {
    const plan = clusterCandidates(cands, { threshold: 0.8, similarity: stubSimFactory(ids) });
    const big = plan.find(p => p.members.length === 3);
    expect(big.members[0]).toBe(0); // highest score joins first = centroid
  });

  it('throws when no similarity fn is given', () => {
    expect(() => clusterCandidates(cands)).toThrow();
  });
});

describe('isMergeable / MERGEABLE_STATES', () => {
  it('excludes rejected, archived, and cooldown-active candidates', () => {
    expect(MERGEABLE_STATES.has('rejected')).toBe(false);
    expect(isMergeable({ state: 'candidate', cooldown_until: null })).toBe(true);
    expect(isMergeable({ state: 'rejected', cooldown_until: null })).toBe(false);
    expect(isMergeable({ state: 'candidate', cooldown_until: new Date(Date.now() + 100000).toISOString() })).toBe(false);
    expect(isMergeable({ state: 'candidate', cooldown_until: new Date(Date.now() - 100000).toISOString() })).toBe(true);
  });
});

describe('runClustering + proposeMerges', () => {
  let db;
  const USER = 'u1';

  beforeEach(() => {
    db = freshDb();
    seedCandidate(db, USER, { id: 'c1', title: 'Deploy health check', draft: ['ping /health'], score: 0.9, verified: 3 });
    seedCandidate(db, USER, { id: 'c2', title: 'Staging health monitor', draft: ['check /health'], score: 0.85, verified: 2 });
    seedCandidate(db, USER, { id: 'c3', title: 'Health check deploy', draft: ['watch /health'], score: 0.7, corrections: 2 });
    seedCandidate(db, USER, { id: 'c4', title: 'Log rotation', draft: ['rotate logs'], score: 0.8 });
    seedCandidate(db, USER, { id: 'c5', title: 'Rejected paraphrase', draft: ['ping health'], score: 0.95, state: 'rejected' });
  });

  it('clusters, persists members with centroid flags, proposes merges, never throws', async () => {
    const sim = stubSimFactory(['c1', 'c2', 'c3', 'c4']);
    const r = await runClustering({ db, userId: USER, logger: QUIET, similarity: sim });
    expect(r.ok).toBe(true);
    expect(r.stats.candidates_scanned).toBe(4); // rejected excluded
    expect(r.stats.method).toBe('test-stub');

    const clusters = db.prepare('SELECT * FROM learning_clusters WHERE user_id = ?').all(USER);
    expect(clusters.length).toBe(r.stats.clusters_formed);
    const big = clusters.find(c => c.member_count === 3);
    expect(big).toBeTruthy();
    expect(big.label).toBe('Deploy health check'); // highest-score centroid
    expect(big.centroid_signature).toContain('Deploy health check');
    const centroids = db.prepare('SELECT COUNT(*) c FROM candidate_cluster_members WHERE is_centroid = 1').get().c;
    expect(centroids).toBe(clusters.length);

    const props = db.prepare(`SELECT * FROM learning_merge_proposals
      WHERE user_id = ? AND state = 'proposed'`).all(USER);
    expect(props.length).toBe(1);
    const fromIds = JSON.parse(props[0].from_candidate_ids);
    expect(fromIds).toEqual(['c1', 'c2', 'c3']); // sorted, rejected never a target
    expect(JSON.parse(props[0].combined_support)).toEqual({ verified: 5, recovered: 0, corrections: 2 });
  });

  it('re-clustering is fresh: old clusters and open proposals are replaced', async () => {
    const sim = stubSimFactory(['c1', 'c2', 'c3', 'c4']);
    await runClustering({ db, userId: USER, logger: QUIET, similarity: sim });
    const first = db.prepare('SELECT id FROM learning_clusters WHERE user_id = ?').all(USER).map(r => r.id);
    await runClustering({ db, userId: USER, logger: QUIET, similarity: sim });
    const second = db.prepare('SELECT id FROM learning_clusters WHERE user_id = ?').all(USER).map(r => r.id);
    expect(second).not.toEqual(first);
    const openProps = db.prepare(`SELECT COUNT(*) c FROM learning_merge_proposals
      WHERE user_id = ? AND state = 'proposed'`).get(USER).c;
    expect(openProps).toBe(1); // no duplicates accumulate
  });

  it('returns ok:false instead of throwing on a broken db', async () => {
    const r = await runClustering({ db: null, userId: USER, logger: QUIET });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('leaves other users clusters alone', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO learning_clusters (id, user_id, label, member_count, created_at, updated_at)
      VALUES ('other-1', 'u2', 'x', 1, ?, ?)`).run(now, now);
    await runClustering({ db, userId: USER, logger: QUIET, similarity: stubSimFactory(['c1', 'c2', 'c3', 'c4']) });
    expect(db.prepare('SELECT * FROM learning_clusters WHERE id = ?').get('other-1')).toBeTruthy();
  });
});

describe('backfillLegacyClusters', () => {
  let db;
  const USER = 'u1';

  beforeEach(() => {
    db = freshDb();
  });

  it('imports learn_patterns rows as read-only clusters, idempotently', () => {
    db.exec(`CREATE TABLE learn_patterns (pattern_key TEXT, description TEXT, occurrence_count INTEGER)`);
    db.prepare(`INSERT INTO learn_patterns VALUES ('p1','Old pattern one',5),('p2','Old pattern two',2)`).run();
    const r1 = backfillLegacyClusters({ db, userId: USER, logger: QUIET });
    expect(r1.ok).toBe(true);
    expect(r1.imported).toBe(2);
    const legacy = db.prepare('SELECT * FROM learning_clusters WHERE user_id = ? AND is_legacy_readonly = 1').all(USER);
    expect(legacy.length).toBe(2);
    expect(legacy.every(l => l.label.length > 0 && l.label.length <= 120)).toBe(true);
    expect(legacy.find(l => l.label === 'Old pattern one').member_count).toBe(5);

    const r2 = backfillLegacyClusters({ db, userId: USER, logger: QUIET });
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(2);
  });

  it('is a no-op when learn_patterns does not exist', () => {
    const r = backfillLegacyClusters({ db, userId: USER, logger: QUIET });
    expect(r.ok).toBe(true);
    expect(r.imported).toBe(0);
  });

  it('legacy clusters survive re-clustering and never produce proposals', async () => {
    db.exec(`CREATE TABLE learn_patterns (pattern_key TEXT, description TEXT, occurrence_count INTEGER)`);
    db.prepare(`INSERT INTO learn_patterns VALUES ('p1','Old pattern one',5)`).run();
    backfillLegacyClusters({ db, userId: USER, logger: QUIET });
    seedCandidate(db, USER, { id: 'c1', title: 'Alpha one', draft: ['x'], score: 0.9 });
    seedCandidate(db, USER, { id: 'c2', title: 'Alpha two', draft: ['x'], score: 0.8 });
    const sim = (i, j) => (i === j ? 1 : 0.99);
    await runClustering({ db, userId: USER, logger: QUIET, similarity: sim });
    expect(db.prepare('SELECT COUNT(*) c FROM learning_clusters WHERE is_legacy_readonly = 1').get().c).toBe(1);
    const legacyIds = new Set(db.prepare('SELECT id FROM learning_clusters WHERE is_legacy_readonly = 1').all().map(r => r.id));
    const props = db.prepare(`SELECT * FROM learning_merge_proposals WHERE state = 'proposed'`).all();
    expect(props.some(p => legacyIds.has(p.cluster_id))).toBe(false);
  });
});
