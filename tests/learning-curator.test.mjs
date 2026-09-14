// Phase 6 curator + lifecycle — unit tests.
// Deterministic: no llm_providers rows, so recommendation drafts use the
// template fallback (no network). CI runs these; they can't run on the
// dev box (Node 24 bus-errors on vitest, pre-existing).
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  curatorConfig,
  runCurator,
  draftRecommendations,
  approveRecommendation,
  dismissRecommendation,
  restoreVersion,
  setPinned,
  markRunReviewed,
  reviewedDryRunCount,
  pruneEligible,
  isVersionReferenced,
  registerExecuting,
  unregisterExecuting,
  CURATOR_REC_STATES,
} from '../src/server/learning/curator.mjs';
import { hardFilter } from '../src/server/learning/retrieval.mjs';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

const U1 = 'user-1', U2 = 'user-2';
let db;

const dISO = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

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

function seedCandidate(id, userId = U1, { title = `cand-${id}`, score = 0.8, state = 'promoted' } = {}) {
  db.prepare(`INSERT INTO learning_candidates (id, user_id, kind, title, risk_tier, state, promotion_score)
    VALUES (?,?,?,?,?,?,?)`).run(id, userId, 'procedure', title, 'low', state, score);
}

function seedVersion(id, userId = U1, candId, overrides = {}) {
  db.prepare(`INSERT INTO learning_skill_versions
    (id, user_id, candidate_id, version_number, kind, spec, rationale, artifact, content_hash,
     scanner_verdict, test_report, requires_docker, state, pinned, stale, archived, quarantined)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, candId, overrides.vn ?? 1, 'prompt_template',
      JSON.stringify({ problem_signature: `sig-${id}` }), 'r', `artifact-${id}`, 'hash',
      '{}', '{}', 0, overrides.state ?? 'active',
      overrides.pinned ? 1 : 0, overrides.stale ? 1 : 0,
      overrides.archived ? 1 : 0, overrides.quarantined ? 1 : 0);
}

function seedStats(vid, { s = 0, f = 0, routed = 0, last = null } = {}) {
  db.prepare(`INSERT INTO learning_skill_stats (version_id, routed_count, success_count, failure_count, last_routed_at)
    VALUES (?,?,?,?,?)`).run(vid, routed, s, f, last);
}

function seedStaleEvent(vid, daysAgo) {
  db.prepare(`INSERT INTO learning_version_events (id, version_id, action, actor, detail, created_at)
    VALUES (?,?,?,?,?,?)`).run(`ev-${vid}`, vid, 'stale_marked', U1, '{}', dISO(daysAgo));
}

const flagOf = (vid, col) => db.prepare(`SELECT ${col} AS v FROM learning_skill_versions WHERE id = ?`).get(vid).v;
const kindsOf = (recs) => recs.map((r) => `${r.version_id}:${r.kind}`).sort();

beforeEach(() => {
  db = freshDb();
});

describe('curatorConfig', () => {
  it('returns the documented defaults', () => {
    expect(curatorConfig()).toEqual({
      stale_after_days: 30,
      archive_after_days: 90,
      quarantine_failure_rate: 0.50,
      min_failure_sample: 5,
      interval_hours: 168,
    });
  });

  it('is env-overridable', () => {
    process.env.LEARNING_CURATOR_STALE_DAYS = '7';
    process.env.LEARNING_CURATOR_QUARANTINE_RATE = '0.9';
    try {
      const c = curatorConfig();
      expect(c.stale_after_days).toBe(7);
      expect(c.quarantine_failure_rate).toBe(0.9);
    } finally {
      delete process.env.LEARNING_CURATOR_STALE_DAYS;
      delete process.env.LEARNING_CURATOR_QUARANTINE_RATE;
    }
  });
});

describe('runCurator finding pass', () => {
  it('proposes stale for a version unused beyond the threshold', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { s: 2, last: dISO(45) });
    const { run, recommendations } = await runCurator({ db, userId: U1 });
    expect(run.mode).toBe('dry_run');
    expect(run.applied_count).toBe(0);
    expect(kindsOf(recommendations)).toEqual(['v1:stale']);
    expect(recommendations[0].reason).toMatch(/hasn't been routed in \d+ days/);
    expect(flagOf('v1', 'stale')).toBe(0); // dry run applies nothing
  });

  it('gives grace to versions with no stats row (absence of evidence)', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(recommendations).toEqual([]);
  });

  it('skips pinned, archived, quarantined, and non-active versions', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1', { pinned: true });
    seedCandidate('c2'); seedVersion('v2', U1, 'c2', { archived: true });
    seedCandidate('c3'); seedVersion('v3', U1, 'c3', { quarantined: true });
    seedCandidate('c4'); seedVersion('v4', U1, 'c4', { state: 'rolled_back' });
    for (const v of ['v1', 'v2', 'v3', 'v4']) seedStats(v, { last: dISO(200) });
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(recommendations).toEqual([]);
  });

  it('skips versions in the executing set', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    registerExecuting('v1');
    try {
      const { recommendations } = await runCurator({ db, userId: U1 });
      expect(recommendations).toEqual([]);
    } finally {
      unregisterExecuting('v1');
    }
  });

  it('is owner-scoped', async () => {
    seedCandidate('c1', U2); seedVersion('v1', U2, 'c1');
    seedStats('v1', { last: dISO(45) });
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(recommendations).toEqual([]);
  });

  it('proposes archive for old stale versions with no references', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1', { stale: true });
    seedStats('v1', { last: dISO(120) });
    seedStaleEvent('v1', 100);
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(kindsOf(recommendations)).toEqual(['v1:archive']);
    expect(recommendations[0].reason).toMatch(/marked stale \d+ days ago/);
  });

  it('withholds archive when the version is referenced (fail-closed)', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1', { stale: true });
    seedStats('v1', { last: dISO(120) });
    seedStaleEvent('v1', 100);
    db.exec('CREATE TABLE agent_skill_bindings (id TEXT PRIMARY KEY, version_id TEXT)');
    db.prepare('INSERT INTO agent_skill_bindings (id, version_id) VALUES (?,?)').run('b1', 'v1');
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(recommendations).toEqual([]);
  });

  it('withholds archive without a stale_marked event', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1', { stale: true });
    seedStats('v1', { last: dISO(120) });
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(recommendations).toEqual([]);
  });

  it('proposes quarantine at/above the failure rate with enough samples', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { s: 2, f: 4, last: dISO(1) }); // 4/6 = 0.667
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(kindsOf(recommendations)).toEqual(['v1:quarantine']);
  });

  it('does not quarantine below the minimum sample', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { s: 0, f: 1, last: dISO(1) });
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(recommendations).toEqual([]);
  });

  it('proposes one merge per cluster, targeting the highest-scoring member', async () => {
    seedCandidate('m1', U1, { title: 'Dedupe A', score: 0.9 }); seedVersion('vm1', U1, 'm1');
    seedCandidate('m2', U1, { title: 'Dedupe B', score: 0.7 }); seedVersion('vm2', U1, 'm2');
    seedStats('vm1', { last: dISO(1) }); seedStats('vm2', { last: dISO(1) });
    db.prepare('INSERT INTO learning_clusters (id, user_id, label, state) VALUES (?,?,?,?)')
      .run('cl1', U1, 'dupe', 'active');
    db.prepare('INSERT INTO candidate_cluster_members (id, cluster_id, candidate_id, similarity) VALUES (?,?,?,?)')
      .run('mm1', 'cl1', 'm1', 0.95);
    db.prepare('INSERT INTO candidate_cluster_members (id, cluster_id, candidate_id, similarity) VALUES (?,?,?,?)')
      .run('mm2', 'cl1', 'm2', 0.92);
    const { recommendations } = await runCurator({ db, userId: U1 });
    const merges = recommendations.filter((r) => r.kind === 'merge');
    expect(merges).toHaveLength(1);
    expect(merges[0].version_id).toBe('vm1');
    expect(JSON.parse(merges[0].evidence).member_count).toBe(2);
  });

  it('ignores legacy clusters for merge findings', async () => {
    seedCandidate('m1', U1, { score: 0.9 }); seedVersion('vm1', U1, 'm1');
    seedCandidate('m2', U1, { score: 0.7 }); seedVersion('vm2', U1, 'm2');
    db.prepare('INSERT INTO learning_clusters (id, user_id, label, state, is_legacy_readonly) VALUES (?,?,?,?,?)')
      .run('cl1', U1, 'legacy', 'active', 1);
    db.prepare('INSERT INTO candidate_cluster_members (id, cluster_id, candidate_id, similarity) VALUES (?,?,?,?)')
      .run('mm1', 'cl1', 'm1', 0.95);
    db.prepare('INSERT INTO candidate_cluster_members (id, cluster_id, candidate_id, similarity) VALUES (?,?,?,?)')
      .run('mm2', 'cl1', 'm2', 0.92);
    const { recommendations } = await runCurator({ db, userId: U1 });
    expect(recommendations.filter((r) => r.kind === 'merge')).toEqual([]);
  });

  it('dedupes findings against recent proposed/applied recommendations', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    const r1 = await runCurator({ db, userId: U1 });
    const r2 = await runCurator({ db, userId: U1 });
    expect(r1.recommendations).toHaveLength(1);
    expect(r2.recommendations).toHaveLength(0);
  });

  it('logs the policy snapshot on the run row', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    const { run } = await runCurator({ db, userId: U1 });
    const snap = JSON.parse(run.policy_snapshot);
    expect(snap.stale_after_days).toBe(30);
    expect(snap.mode).toBe('dry_run');
    expect(run.findings_count).toBe(0);
  });

  it('never throws on a broken DB', async () => {
    const broken = new Database(':memory:');
    const { run, recommendations, error } = await runCurator({ db: broken, userId: U1 });
    expect(run).toBeNull();
    expect(recommendations).toEqual([]);
    expect(error).toBeTruthy();
  });
});

describe('draftRecommendations', () => {
  it('falls back to natural-sounding templates without an LLM', async () => {
    const drafted = await draftRecommendations(db, [
      { kind: 'stale', versionId: 'v1', versionTitle: 'Quiet skill', versionKind: 'prompt_template', versionNumber: 1,
        evidence: { days_unused: 45 } },
      { kind: 'archive', versionId: 'v2', versionTitle: 'Old skill', evidence: { days_since_stale_marked: 100 } },
      { kind: 'quarantine', versionId: 'v3', versionTitle: 'Flaky skill',
        evidence: { failure_count: 4, sample: 6, failure_rate: 2 / 3 } },
      { kind: 'merge', versionId: 'v4', versionTitle: 'Dedupe A',
        evidence: { member_count: 3, member_titles: ['Dedupe A', 'Dedupe B'] } },
    ]);
    expect(drafted).toHaveLength(4);
    for (const d of drafted) expect(d.reason.length).toBeGreaterThan(60);
    expect(drafted[0].reason).toContain("hasn't been routed in 45 days");
    expect(drafted[1].reason).toContain('restored with one tap');
    expect(drafted[2].reason).toContain('67% failure rate');
    expect(drafted[3].reason).toContain('cluster of 3 near-identical skills');
  });
});

describe('decisions', () => {
  it('approve applies stale/archive/quarantine with version events', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    const { recommendations } = await runCurator({ db, userId: U1 });
    const rec = recommendations[0];
    const { recommendation, applied } = approveRecommendation(db, rec.id, U1);
    expect(applied).toBe(true);
    expect(recommendation.state).toBe('applied');
    expect(recommendation.decided_by).toBe(U1);
    expect(flagOf('v1', 'stale')).toBe(1);
    const ev = db.prepare("SELECT COUNT(*) AS n FROM learning_version_events WHERE version_id = ? AND action = 'stale_marked'")
      .get('v1').n;
    expect(ev).toBe(1);
  });

  it('approve quarantine sets quarantined=1', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { s: 1, f: 5, last: dISO(1) });
    const { recommendations } = await runCurator({ db, userId: U1 });
    const { applied } = approveRecommendation(db, recommendations[0].id, U1);
    expect(applied).toBe(true);
    expect(flagOf('v1', 'quarantined')).toBe(1);
  });

  it('approve merge stages a cluster merge proposal and stays approved', async () => {
    seedCandidate('m1', U1, { title: 'Dedupe A', score: 0.9 }); seedVersion('vm1', U1, 'm1');
    seedCandidate('m2', U1, { title: 'Dedupe B', score: 0.7 }); seedVersion('vm2', U1, 'm2');
    db.prepare('INSERT INTO learning_clusters (id, user_id, label, state) VALUES (?,?,?,?)')
      .run('cl1', U1, 'dupe', 'active');
    for (const [mm, c] of [['mm1', 'm1'], ['mm2', 'm2']]) {
      db.prepare('INSERT INTO candidate_cluster_members (id, cluster_id, candidate_id, similarity) VALUES (?,?,?,?)')
        .run(mm, 'cl1', c, 0.9);
    }
    const { recommendations } = await runCurator({ db, userId: U1 });
    const merge = recommendations.find((r) => r.kind === 'merge');
    const { recommendation, applied } = approveRecommendation(db, merge.id, U1);
    expect(applied).toBe(true);
    expect(recommendation.state).toBe('approved');
    const note = JSON.parse(recommendation.evidence).approval_note;
    expect(note).toMatch(/^merge proposal created: /);
    const props = db.prepare("SELECT COUNT(*) AS n FROM learning_merge_proposals WHERE user_id = ? AND state = 'proposed'")
      .get(U1).n;
    expect(props).toBe(1);
    // The curator never touches the version itself on merge approve.
    expect(flagOf('vm1', 'archived')).toBe(0);
  });

  it('approve merge without a cluster falls back to pending Haz review', () => {
    const id = 'rec-orphan';
    db.prepare(`INSERT INTO learning_curator_runs (id, user_id, mode) VALUES (?,?,?)`).run('run-1', U1, 'dry_run');
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    db.prepare(`INSERT INTO learning_curator_recommendations
      (id, run_id, user_id, version_id, kind, reason, evidence, state) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, 'run-1', U1, 'v1', 'merge', 'r', JSON.stringify({}), 'proposed');
    const { recommendation } = approveRecommendation(db, id, U1);
    expect(recommendation.state).toBe('approved');
    expect(JSON.parse(recommendation.evidence).approval_note).toBe('pending Haz merge review');
  });

  it('approve/dismiss are no-ops unless proposed', async () => {
    expect(approveRecommendation(db, 'missing', U1).error).toBe('not_found');
    expect(dismissRecommendation(db, 'missing', U1).error).toBe('not_found');
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    const { recommendations } = await runCurator({ db, userId: U1 });
    const rec = recommendations[0];
    dismissRecommendation(db, rec.id, U1);
    expect(approveRecommendation(db, rec.id, U1).error).toBe('not_proposed');
    expect(dismissRecommendation(db, rec.id, U1).error).toBe('not_proposed');
  });

  it('dismiss sets state + decided_by/at without touching the version', async () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    const { recommendations } = await runCurator({ db, userId: U1 });
    const { recommendation } = dismissRecommendation(db, recommendations[0].id, U1);
    expect(recommendation.state).toBe('dismissed');
    expect(recommendation.decided_by).toBe(U1);
    expect(recommendation.decided_at).toBeTruthy();
    expect(flagOf('v1', 'stale')).toBe(0);
  });
});

describe('lifecycle primitives', () => {
  it('restoreVersion clears all curator flags and records an event', () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1', { stale: true, archived: true, quarantined: true });
    const v = restoreVersion(db, 'v1', U1);
    expect(v.archived).toBe(0);
    expect(v.stale).toBe(0);
    expect(v.quarantined).toBe(0);
    const ev = db.prepare("SELECT COUNT(*) AS n FROM learning_version_events WHERE version_id = 'v1' AND action = 'restored'").get().n;
    expect(ev).toBe(1);
    expect(restoreVersion(db, 'missing', U1)).toBeNull();
  });

  it('setPinned pins/unpins with version events', () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    expect(setPinned(db, 'v1', true, U1).pinned).toBe(1);
    expect(setPinned(db, 'v1', false, U1).pinned).toBe(0);
    const pinned = db.prepare("SELECT COUNT(*) AS n FROM learning_version_events WHERE version_id = 'v1' AND action = 'pinned'").get().n;
    const unpinned = db.prepare("SELECT COUNT(*) AS n FROM learning_version_events WHERE version_id = 'v1' AND action = 'unpinned'").get().n;
    expect(pinned).toBe(1);
    expect(unpinned).toBe(1);
    expect(setPinned(db, 'missing', true, U1)).toBeNull();
  });
});

describe('prune gating', () => {
  it('requires two reviewed, successful, non-empty dry runs', async () => {
    expect(pruneEligible(db, U1)).toBe(false);
    expect(reviewedDryRunCount(db, U1)).toBe(0);
    // L10: seed a stale-eligible version before each dry run so every
    // counted run has findings_count > 0 (a fresh version per run —
    // dedup would suppress the same version's finding twice).
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(45) });
    const r1 = await runCurator({ db, userId: U1 });
    expect(r1.run.error).toBeNull();
    expect(r1.run.findings_count).toBeGreaterThan(0);
    seedCandidate('c2'); seedVersion('v2', U1, 'c2');
    seedStats('v2', { last: dISO(45) });
    const r2 = await runCurator({ db, userId: U1 });
    expect(r2.run.error).toBeNull();
    expect(r2.run.findings_count).toBeGreaterThan(0);
    markRunReviewed(db, r1.run.id, U1);
    expect(pruneEligible(db, U1)).toBe(false);
    markRunReviewed(db, r2.run.id, U1);
    expect(reviewedDryRunCount(db, U1)).toBe(2);
    expect(pruneEligible(db, U1)).toBe(true);
    expect(markRunReviewed(db, 'missing', U1)).toBeNull();
  });

  it('L10: errored dry runs do not count toward prune eligibility', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO learning_curator_runs
      (id, user_id, mode, reviewed, findings_count, applied_count, error, created_at)
      VALUES ('run-err', ?, 'dry_run', 1, 3, 0, 'finding phase exploded', ?)`)
      .run(U1, now);
    expect(reviewedDryRunCount(db, U1)).toBe(0);
    expect(pruneEligible(db, U1)).toBe(false);
  });

  it('L10: empty dry runs (no findings) do not count toward prune eligibility', async () => {
    const r = await runCurator({ db, userId: U1 }); // no versions -> 0 findings
    expect(r.run.error).toBeNull();
    expect(r.run.findings_count).toBe(0);
    markRunReviewed(db, r.run.id, U1);
    expect(reviewedDryRunCount(db, U1)).toBe(0);
    expect(pruneEligible(db, U1)).toBe(false);
  });

  it('prune mode auto-applies ONLY stale transitions', async () => {
    const r1 = await runCurator({ db, userId: U1 });
    const r2 = await runCurator({ db, userId: U1 });
    markRunReviewed(db, r1.run.id, U1);
    markRunReviewed(db, r2.run.id, U1);
    // Seed AFTER the dry runs so nothing is deduped against them.
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(40) }); // stale-eligible
    seedCandidate('c2'); seedVersion('v2', U1, 'c2');
    seedStats('v2', { s: 1, f: 5, last: dISO(1) }); // quarantine-eligible
    const { run, recommendations } = await runCurator({ db, userId: U1, mode: 'prune' });
    expect(run.mode).toBe('prune');
    expect(flagOf('v1', 'stale')).toBe(1);
    expect(flagOf('v2', 'quarantined')).toBe(0);
    const byId = Object.fromEntries(recommendations.map((r) => [r.version_id, r]));
    expect(byId.v1.state).toBe('applied');
    expect(byId.v1.decided_by).toBe('curator:prune');
    expect(byId.v2.state).toBe('proposed');
    expect(run.applied_count).toBe(1);
    const ev = db.prepare("SELECT detail FROM learning_version_events WHERE version_id = 'v1' AND action = 'stale_marked'")
      .get();
    expect(JSON.parse(ev.detail).via).toBe('curator_prune');
  });
});

describe('isVersionReferenced', () => {
  it('treats internal bookkeeping as non-references and fails closed', () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    seedStats('v1', { last: dISO(120) });
    seedStaleEvent('v1', 100);
    expect(isVersionReferenced(db, 'v1')).toBe(false);
    db.exec('CREATE TABLE agent_skill_bindings (id TEXT PRIMARY KEY, version_id TEXT)');
    db.prepare('INSERT INTO agent_skill_bindings (id, version_id) VALUES (?,?)').run('b1', 'v1');
    expect(isVersionReferenced(db, 'v1')).toBe(true);
  });

  it('honours explicit foreign keys to learning_skill_versions', () => {
    seedCandidate('c1'); seedVersion('v1', U1, 'c1');
    db.exec('CREATE TABLE exec_log (id TEXT PRIMARY KEY, version_id TEXT REFERENCES learning_skill_versions(id))');
    db.prepare('INSERT INTO exec_log (id, version_id) VALUES (?,?)').run('e1', 'v1');
    expect(isVersionReferenced(db, 'v1')).toBe(true);
  });
});

describe('hardFilter curator flags', () => {
  const hrow = (id, extra = {}) => ({
    id, user_id: U1, state: 'active', kind: 'prompt_template', artifact: 'a',
    content_hash: createHash('sha256').update('prompt_template\na').digest('hex'),
    risk_tier: 'low', requires_docker: 0, ...extra,
  });

  it('excludes stale/archived/quarantined versions', () => {
    const { kept, excluded } = hardFilter({
      db, userId: U1,
      versions: [hrow('a'), hrow('s', { stale: 1 }), hrow('x', { archived: 1 }), hrow('q', { quarantined: 1 })],
    });
    expect(kept.map((v) => v.id)).toEqual(['a']);
    const reasons = Object.fromEntries(excluded.map((e) => [e.versionId, e.reason]));
    expect(reasons).toEqual({ s: 'curator_stale', x: 'curator_archived', q: 'curator_quarantined' });
  });

  it('keeps versions when the flags are absent (pre-migration rows)', () => {
    const row = hrow('a');
    delete row.stale; delete row.archived; delete row.quarantined;
    const { kept } = hardFilter({ db, userId: U1, versions: [row] });
    expect(kept).toHaveLength(1);
  });
});

describe('constants', () => {
  it('exposes the documented rec states', () => {
    expect(CURATOR_REC_STATES).toEqual(['proposed', 'approved', 'dismissed', 'applied']);
  });
});
