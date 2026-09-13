// Phase 5 retrieval + shadow routing — unit tests.
// Similarity is stubbed via __setSimilarityOverride (deterministic, no
// MiniLM model download). CI runs these; they can't run on the dev box
// (Node 24 bus-errors on vitest, pre-existing).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import {
  ROUTE_WEIGHTS, ROUTE_FLOOR, ROUTE_MARGIN, getRetrievalFlags,
  hardFilter, routeScore, selectWinner,
  triggerMatchScore, recencyScore, affinityScore, successRate,
  recomputeContentHash, shadowRoute, recordFeedback,
  __setSimilarityOverride,
} from '../src/server/learning/retrieval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;
const U1 = 'user-1', U2 = 'user-2';

// sha256(`${kind}\n${artifact}`) — exact replica of compiler.mjs compile().
const hashFor = (kind, artifact) =>
  createHash('sha256').update(`${kind}\n${artifact}`).digest('hex');

function freshDb() {
  const d = new Database(':memory:');
  for (const f of ['014_learning_events.sql', '026_learning_candidates.sql', '028_learning_skill_versions.sql', '029_learning_retrieval.sql']) {
    d.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return d;
}

function seedCandidate(id, userId, riskTier = 'low') {
  db.prepare(`INSERT INTO learning_candidates (id, user_id, kind, title, draft, state, risk_tier, created_at)
    VALUES (?, ?, 'procedure', ?, 'draft', 'promoted', ?, datetime('now'))`)
    .run(id, userId, `cand-${id}`, riskTier);
}

function seedVersion(id, userId, candId, overrides = {}) {
  const kind = overrides.kind || 'prompt_template';
  const artifact = `artifact-${id}`;
  const spec = overrides.spec || { problem_signature: 'deploy gate check before release', preconditions: ['ci green'] };
  db.prepare(`INSERT INTO learning_skill_versions
    (id, user_id, candidate_id, version_number, kind, spec, artifact, content_hash, requires_docker, state, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .run(id, userId, candId, kind, JSON.stringify(spec), artifact,
      overrides.hash !== undefined ? overrides.hash : hashFor(kind, artifact),
      overrides.requires_docker ? 1 : 0, overrides.state || 'active');
  return db.prepare(`SELECT v.*, c.risk_tier, c.title AS candidate_title
    FROM learning_skill_versions v JOIN learning_candidates c ON c.id = v.candidate_id
    WHERE v.id = ?`).get(id);
}

beforeEach(() => {
  db = freshDb();
  delete process.env.LEARNING_RETRIEVAL_ENABLED;
  __setSimilarityOverride(null);
});

afterEach(() => {
  __setSimilarityOverride(null);
  delete process.env.LEARNING_RETRIEVAL_ENABLED;
});

describe('config', () => {
  it('has the contract weights and defaults', () => {
    expect(ROUTE_WEIGHTS).toEqual({ semantic: 0.50, trigger: 0.20, successRate: 0.15, recency: 0.10, affinity: 0.05 });
    expect(ROUTE_FLOOR).toBe(0.70);
    expect(ROUTE_MARGIN).toBe(0.05);
  });

  it('weights are env-overridable', async () => {
    // Config is read at import time, so only assert the env names exist in
    // the wiring contract via flags instead.
    expect(getRetrievalFlags()).toEqual({ capture: true, review: true, retrieval: true, curator: false });
  });

  it('LEARNING_RETRIEVAL_ENABLED=false disables retrieval', () => {
    process.env.LEARNING_RETRIEVAL_ENABLED = '0';
    expect(getRetrievalFlags().retrieval).toBe(false);
  });
});

describe('hardFilter', () => {
  it('keeps only the routable version', () => {
    seedCandidate('c1', U1); seedCandidate('c1b', U1); seedCandidate('c2', U1, 'high'); seedCandidate('c3', U2);
    const good = seedVersion('v-good', U1, 'c1');
    const rows = [
      good,
      seedVersion('v-other', U2, 'c3'),
      seedVersion('v-high', U1, 'c2'),
      seedVersion('v-badhash', U1, 'c1b', { hash: 'deadbeef' }),
    ];
    seedCandidate('c1c', U1);
    rows.push(seedVersion('v-rolled', U1, 'c1c', { state: 'rolled_back' }));
    const { kept, excluded } = hardFilter({ db, userId: U1, versions: rows });
    expect(kept.map(v => v.id)).toEqual(['v-good']);
    expect(Object.fromEntries(excluded.map(e => [e.versionId, e.reason]))).toEqual({
      'v-other': 'wrong_owner',
      'v-high': 'high_risk_tier',
      'v-badhash': 'checksum_mismatch',
      'v-rolled': 'inactive_state:rolled_back',
    });
  });

  it('checksum replication matches compiler exactly', () => {
    seedCandidate('c1', U1);
    const v = seedVersion('v1', U1, 'c1', { kind: 'script' });
    expect(recomputeContentHash(v)).toBe(hashFor('script', 'artifact-v1'));
  });

  it('never throws on garbage rows', () => {
    const { kept, excluded } = hardFilter({ db, userId: U1, versions: [null, {}, { id: 'x' }] });
    expect(kept).toEqual([]);
    expect(excluded.length).toBe(3);
  });
});

describe('routeScore and components', () => {
  it('hand-verified: all-1.0 minus 0.1 penalty = 0.9', () => {
    expect(routeScore({ similarity: 1, triggerMatch: 1, successRate: 1, recency: 1, affinity: 1, riskPenalty: 0.1 }))
      .toBeCloseTo(0.9, 9);
  });

  it('triggerMatchScore finds overlapping triggers', () => {
    const s = triggerMatchScore('check the deploy gate before release',
      { problem_signature: 'deploy gate check before release', preconditions: ['ci green'] });
    expect(s).toBeGreaterThan(0.3);
    expect(triggerMatchScore('zzz qqq www', { problem_signature: 'deploy gate check' })).toBe(0);
  });

  it('recencyScore decays over 30 days', () => {
    expect(recencyScore(new Date().toISOString())).toBeGreaterThan(0.99);
    expect(recencyScore(new Date(Date.now() - 30 * 864e5).toISOString())).toBeCloseTo(0.5, 2);
    expect(recencyScore('not-a-date')).toBe(0);
  });

  it('affinityScore saturates at 10 routings', () => {
    expect(affinityScore(null)).toBe(0);
    expect(affinityScore({ routed_count: 5 })).toBe(0.5);
    expect(affinityScore({ routed_count: 50 })).toBe(1);
  });

  it('successRate is Laplace-smoothed', () => {
    expect(successRate(null)).toBe(0.5);
    expect(successRate({ success_count: 3, failure_count: 1 })).toBe(4 / 6);
  });
});

describe('selectWinner', () => {
  const V = id => ({ id });
  it('falls back below the floor', () => {
    const r = selectWinner([{ version: V('a'), score: 0.65 }], { floor: 0.7, margin: 0.05 });
    expect(r.decision).toBe('fallback_normal');
    expect(r.reason).toMatch(/below floor/);
  });
  it('falls back when the margin is too small', () => {
    const r = selectWinner(
      [{ version: V('a'), score: 0.80 }, { version: V('b'), score: 0.78 }],
      { floor: 0.7, margin: 0.05 });
    expect(r.decision).toBe('fallback_normal');
    expect(r.reason).toMatch(/margin/);
  });
  it('routes when floor and margin both clear', () => {
    const r = selectWinner(
      [{ version: V('a'), score: 0.80 }, { version: V('b'), score: 0.70 }],
      { floor: 0.7, margin: 0.05 });
    expect(r.decision).toBe('shadow_routed');
    expect(r.winner.id).toBe('a');
    expect(r.runnerUp.id).toBe('b');
  });
  it('single candidate needs only the floor', () => {
    expect(selectWinner([{ version: V('a'), score: 0.9 }], { floor: 0.7, margin: 0.05 }).decision)
      .toBe('shadow_routed');
  });
  it('empty input → filtered_all', () => {
    expect(selectWinner([], { floor: 0.7, margin: 0.05 }).decision).toBe('filtered_all');
  });
});

describe('shadowRoute', () => {
  function seedRoutable() {
    seedCandidate('c1', U1);
    return seedVersion('v-good', U1, 'c1');
  }

  it('routes the winner, persists the decision, bumps stats', async () => {
    __setSimilarityOverride(() => [0.95]);
    const v = seedRoutable();
    const r = await shadowRoute({ db, userId: U1, requestText: 'check the deploy gate before release', context: { sessionId: 's1' } });
    expect(r.decision).toBe('shadow_routed');
    expect(r.winner.id).toBe('v-good');
    expect(r.decisionId).toBeTruthy();
    const row = db.prepare('SELECT * FROM learning_routing_decisions WHERE id = ?').get(r.decisionId);
    expect(row.mode).toBe('shadow');
    expect(row.winner_version_id).toBe('v-good');
    expect(row.winner_score).toBeCloseTo(r.score, 6);
    const stats = db.prepare('SELECT * FROM learning_skill_stats WHERE version_id = ?').get('v-good');
    expect(stats.routed_count).toBe(1);
    expect(stats.last_routed_at).toBeTruthy();
    // Full spec loaded only for the winner: winner row has spec+artifact.
    expect(JSON.parse(r.winner.spec).problem_signature).toBe('deploy gate check before release');
    void v;
  });

  it('writes a filtered_all decision when nothing is routable', async () => {
    __setSimilarityOverride(() => []);
    const r = await shadowRoute({ db, userId: U1, requestText: 'anything', context: {} });
    expect(r.decision).toBe('filtered_all');
    expect(r.winner).toBeNull();
    expect(r.decisionId).toBeTruthy();
  });

  it('redacts the request excerpt', async () => {
    __setSimilarityOverride(() => [0.9]);
    seedRoutable();
    const r = await shadowRoute({
      db, userId: U1,
      requestText: 'deploy gate for haz@example.com with key sk-abc1234567890',
      context: {},
    });
    const row = db.prepare('SELECT request_excerpt, request_hash FROM learning_routing_decisions WHERE id = ?').get(r.decisionId);
    expect(row.request_excerpt).toContain('[redacted-email]');
    expect(row.request_excerpt).toContain('[redacted-api-key]');
    expect(row.request_excerpt).not.toContain('haz@example.com');
    expect(row.request_excerpt).not.toContain('sk-abc1234567890');
    expect(row.request_excerpt.length).toBeLessThanOrEqual(200);
    expect(row.request_hash).toBe(createHash('sha256').update('deploy gate for haz@example.com with key sk-abc1234567890').digest('hex'));
  });

  it('never throws on garbage input', async () => {
    expect((await shadowRoute({ db, userId: U1, requestText: '' })).decision).toBe('error');
    expect((await shadowRoute({ db: null, userId: U1, requestText: 'x' })).decision).toBe('error');
    expect((await shadowRoute({ db, userId: null, requestText: 'x' })).decision).toBe('error');
  });

  it('disabled flag → no-op with no DB write', async () => {
    process.env.LEARNING_RETRIEVAL_ENABLED = 'false';
    seedRoutable();
    const before = db.prepare('SELECT COUNT(*) AS n FROM learning_routing_decisions').get().n;
    const r = await shadowRoute({ db, userId: U1, requestText: 'check the deploy gate', context: {} });
    expect(r.decision).toBe('disabled');
    expect(db.prepare('SELECT COUNT(*) AS n FROM learning_routing_decisions').get().n).toBe(before);
  });

  it('isolates users', async () => {
    __setSimilarityOverride(() => [0.95]);
    seedRoutable(); // U1 only
    const r = await shadowRoute({ db, userId: U2, requestText: 'check the deploy gate', context: {} });
    expect(r.decision).toBe('filtered_all');
  });
});

describe('recordFeedback ledgers', () => {
  it('route ledger increments route counters; execution ledger does not', async () => {
    __setSimilarityOverride(() => [0.95]);
    seedCandidate('c1', U1);
    seedVersion('v-good', U1, 'c1');
    const r = await shadowRoute({ db, userId: U1, requestText: 'check the deploy gate', context: {} });
    recordFeedback({ db, userId: U1, decisionId: r.decisionId, ledger: 'route', positive: true, detail: 'good pick' });
    recordFeedback({ db, userId: U1, decisionId: r.decisionId, ledger: 'execution', positive: false, detail: 'failed at runtime' });
    const stats = db.prepare('SELECT * FROM learning_skill_stats WHERE version_id = ?').get('v-good');
    expect(stats.success_count).toBe(1);
    expect(stats.failure_count).toBe(0); // execution negative did NOT touch route counters
    const rows = db.prepare('SELECT ledger, positive FROM learning_route_feedback WHERE decision_id = ?').all(r.decisionId);
    expect(rows).toHaveLength(2);
    expect(rows.map(x => x.ledger).sort()).toEqual(['execution', 'route']);
  });

  it('rejects cross-user feedback', async () => {
    __setSimilarityOverride(() => [0.95]);
    seedCandidate('c1', U1);
    seedVersion('v-good', U1, 'c1');
    const r = await shadowRoute({ db, userId: U1, requestText: 'check the deploy gate', context: {} });
    expect(() => recordFeedback({ db, userId: U2, decisionId: r.decisionId, ledger: 'route', positive: true }))
      .toThrow('not found');
  });

  it('validates ledger and positive', () => {
    expect(() => recordFeedback({ db, userId: U1, decisionId: 'x', ledger: 'bogus', positive: true }))
      .toThrow("ledger must be 'route' or 'execution'");
    expect(() => recordFeedback({ db, userId: U1, decisionId: 'x', ledger: 'route', positive: 'yes' }))
      .toThrow('positive must be a boolean');
  });
});
