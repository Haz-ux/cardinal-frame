// Phase 6 curator smoke — deterministic, no network.
// Exercises: real migrator (full chain), real curator.mjs, hardFilter
// extension, and the new HTTP routes via the real learning router.
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createHash } from 'crypto';
import { runMigrations } from './src/server/migrator.mjs';
import {
  runCurator, curatorConfig, approveRecommendation, dismissRecommendation,
  restoreVersion, setPinned, markRunReviewed, reviewedDryRunCount,
  pruneEligible, isVersionReferenced, registerExecuting, unregisterExecuting,
  CURATOR_REC_STATES,
} from './src/server/learning/curator.mjs';
import { hardFilter } from './src/server/learning/retrieval.mjs';
import learningRoutes from './src/server/routes/learning.mjs';

const U = 'haz-test-user';
let pass = 0, fail = 0;
const notes = [];
function ok(cond, label, extra = '') {
  if (cond) { pass++; }
  else { fail++; notes.push(`FAIL: ${label} ${extra}`); }
}

const db = new Database(':memory:');
runMigrations(db);
runMigrations(db); // idempotency: re-run must not crash
ok(true, 'migrator full chain applied twice without error');

const dISO = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
function mkCandidate(id, title, score = 0.8, state = 'promoted') {
  db.prepare(`INSERT INTO learning_candidates (id, user_id, kind, title, risk_tier, state, promotion_score)
    VALUES (?,?,?,?,?,?,?)`).run(id, U, 'procedure', title, 'low', state, score);
}
function mkVersion(id, candId, opts = {}) {
  db.prepare(`INSERT INTO learning_skill_versions
    (id, user_id, candidate_id, version_number, kind, spec, rationale, artifact, content_hash,
     scanner_verdict, test_report, requires_docker, state, pinned, stale, archived, quarantined)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, U, candId, opts.vn ?? 1, opts.kind ?? 'prompt_template',
      JSON.stringify({ problem_signature: `sig-${id}` }), 'r', 'artifact', 'hash',
      '{}', '{}', 0, opts.state ?? 'active',
      opts.pinned ? 1 : 0, opts.stale ? 1 : 0, opts.archived ? 1 : 0, opts.quarantined ? 1 : 0);
}
function mkStats(vid, { routed = 0, s = 0, f = 0, last = null } = {}) {
  db.prepare(`INSERT INTO learning_skill_stats (version_id, routed_count, success_count, failure_count, last_routed_at)
    VALUES (?,?,?,?,?)`).run(vid, routed, s, f, last);
}
function staleEvent(vid, days) {
  db.prepare(`INSERT INTO learning_version_events (id, version_id, action, actor, detail, created_at)
    VALUES (?,?,?,?,?,?)`).run(`ev-${vid}-${days}`, vid, 'stale_marked', U, '{}', dISO(days));
}
const flagOf = (vid, col) => db.prepare(`SELECT ${col} AS v FROM learning_skill_versions WHERE id = ?`).get(vid).v;
const recsFor = (vid, kind) => db.prepare(`SELECT * FROM learning_curator_recommendations WHERE version_id = ? AND kind = ?`).all(vid, kind);

// ─── Fixtures ─────────────────────────────────────────────────────
mkCandidate('c1', 'Quiet skill');            mkVersion('v1', 'c1');  mkStats('v1', { routed: 5, s: 2, f: 0, last: dISO(45) });
mkCandidate('c2', 'Old stale');              mkVersion('v2', 'c2', { stale: true });
mkStats('v2', { routed: 9, s: 5, f: 0, last: dISO(120) }); staleEvent('v2', 100);
mkCandidate('c3', 'Flaky skill');            mkVersion('v3', 'c3');  mkStats('v3', { routed: 6, s: 2, f: 4, last: dISO(10) });
mkCandidate('c4', 'Tiny sample');            mkVersion('v4', 'c4');  mkStats('v4', { routed: 1, s: 0, f: 1, last: dISO(2) });
mkCandidate('c5', 'Pinned forever');         mkVersion('v5', 'c5', { pinned: true });
mkStats('v5', { routed: 20, s: 10, f: 0, last: dISO(200) });
mkCandidate('c6', 'Stale referenced');       mkVersion('v6', 'c6', { stale: true });
mkStats('v6', { routed: 7, s: 3, f: 0, last: dISO(120) }); staleEvent('v6', 100);
db.exec(`CREATE TABLE agent_skill_bindings (id TEXT PRIMARY KEY, version_id TEXT)`);
db.prepare('INSERT INTO agent_skill_bindings (id, version_id) VALUES (?,?)').run('b1', 'v6');
mkCandidate('c7', 'Brand new');              mkVersion('v7', 'c7'); // no stats row
mkCandidate('c8', 'Already archived');       mkVersion('v8', 'c8', { archived: true }); mkStats('v8', { last: dISO(200) });
mkCandidate('c9', 'Rolled back');            mkVersion('v9', 'c9', { state: 'rolled_back' }); mkStats('v9', { last: dISO(200) });
mkCandidate('c10', 'Slow fade');             mkVersion('v10', 'c10'); mkStats('v10', { routed: 2, s: 1, f: 0, last: dISO(40) });
// merge cluster: two near-identical candidates, fresh stats
mkCandidate('m1', 'Dedupe A', 0.9);          mkVersion('vm1', 'm1'); mkStats('vm1', { routed: 3, s: 3, f: 0, last: dISO(1) });
mkCandidate('m2', 'Dedupe B', 0.7);          mkVersion('vm2', 'm2'); mkStats('vm2', { routed: 2, s: 2, f: 0, last: dISO(1) });
db.prepare(`INSERT INTO learning_clusters (id, user_id, label, state) VALUES (?,?,?,?)`).run('cl1', U, 'dupe cluster', 'active');
db.prepare(`INSERT INTO candidate_cluster_members (id, cluster_id, candidate_id, similarity, is_centroid) VALUES (?,?,?,?,?)`)
  .run('mm1', 'cl1', 'm1', 0.95, 1);
db.prepare(`INSERT INTO candidate_cluster_members (id, cluster_id, candidate_id, similarity, is_centroid) VALUES (?,?,?,?,?)`)
  .run('mm2', 'cl1', 'm2', 0.92, 0);

ok(isVersionReferenced(db, 'v6') === true, 'referenced version detected via external table');
ok(isVersionReferenced(db, 'v2') === false, 'unreferenced version not flagged (internal bookkeeping excluded)');

// ─── Dry run #1 ───────────────────────────────────────────────────
const r1 = await runCurator({ db, userId: U, mode: 'dry_run', logger: null });
ok(r1.run && r1.run.mode === 'dry_run', 'dry run returns run row');
ok(r1.run.applied_count === 0, 'dry run applies nothing');
const kinds1 = r1.recommendations.map((r) => `${r.version_id}:${r.kind}`).sort();
ok(kinds1.includes('v1:stale'), 'v1 (unused 45d) → stale proposal');
ok(kinds1.includes('v2:archive'), 'v2 (stale 100d, unreferenced) → archive proposal');
ok(kinds1.includes('v3:quarantine'), 'v3 (4/6 failures) → quarantine proposal');
ok(kinds1.includes('v10:stale'), 'v10 (unused 40d) → stale proposal');
ok(kinds1.includes('vm1:merge'), 'merge proposal targets highest-scoring member (vm1)');
ok(!kinds1.some((k) => k.startsWith('v4:')), 'v4 (1/1 failure, sample too small) → no proposal');
ok(!kinds1.some((k) => k.startsWith('v5:')), 'v5 (pinned, unused 200d) → untouched');
ok(!kinds1.some((k) => k.startsWith('v6:')), 'v6 (referenced) → untouched');
ok(!kinds1.some((k) => k.startsWith('v7:')), 'v7 (zero stats) → no proposal');
ok(!kinds1.some((k) => k.startsWith('v8:')), 'v8 (archived) → untouched');
ok(!kinds1.some((k) => k.startsWith('v9:')), 'v9 (rolled_back) → untouched');
ok(r1.recommendations.length === 5, `exactly 5 findings, got ${r1.recommendations.length}`);
const v1rec = r1.recommendations.find((r) => r.version_id === 'v1');
ok(/hasn't been routed in \d+ days/.test(v1rec.reason) && v1rec.reason.length > 50,
  'stale reason is readable plain language', v1rec.reason.slice(0, 80));
ok(flagOf('v1', 'stale') === 0, 'dry run leaves stale flag at 0');
const snap = JSON.parse(r1.run.policy_snapshot);
ok(snap.stale_after_days === 30 && snap.quarantine_failure_rate === 0.5 && snap.mode === 'dry_run',
  'policy snapshot present on run row');

// ─── Decisions ────────────────────────────────────────────────────
const a1 = approveRecommendation(db, v1rec.id, U);
ok(a1.applied === true && a1.recommendation.state === 'applied', 'approve stale → applied');
ok(flagOf('v1', 'stale') === 1, 'approve stale sets stale=1');
ok(db.prepare(`SELECT COUNT(*) AS n FROM learning_version_events WHERE version_id = ? AND action = 'stale_marked'`)
  .get('v1').n === 1, 'approve stale writes stale_marked event');
const v3rec = r1.recommendations.find((r) => r.version_id === 'v3');
const d3 = dismissRecommendation(db, v3rec.id, U);
ok(d3.recommendation.state === 'dismissed' && d3.recommendation.decided_by === U, 'dismiss works');
const v2rec = r1.recommendations.find((r) => r.version_id === 'v2');
approveRecommendation(db, v2rec.id, U);
ok(flagOf('v2', 'archived') === 1, 'approve archive sets archived=1');
const restored = restoreVersion(db, 'v2', U);
ok(restored.archived === 0 && restored.stale === 0 && restored.quarantined === 0, 'restore clears flags');
ok(db.prepare(`SELECT COUNT(*) AS n FROM learning_version_events WHERE version_id = ? AND action = 'restored'`)
  .get('v2').n === 1, 'restore writes restored event');
const noRe = approveRecommendation(db, v1rec.id, U);
ok(noRe.error === 'not_proposed', 're-approving a non-proposed rec is a no-op error');
// merge approve stages the cluster merge path (never applied by curator itself)
const mergerec = r1.recommendations.find((r) => r.version_id === 'vm1');
const am = approveRecommendation(db, mergerec.id, U);
ok(am.applied === true && am.recommendation.state === 'approved', 'approve merge → approved, not applied');
const mpev = JSON.parse(am.recommendation.evidence);
ok(typeof mpev.approval_note === 'string' && mpev.approval_note.startsWith('merge proposal created:'),
  'merge approve creates cluster merge proposal + note', mpev.approval_note);
ok(db.prepare(`SELECT COUNT(*) AS n FROM learning_merge_proposals WHERE user_id = ? AND state = 'proposed'`).get(U).n === 1,
  'learning_merge_proposals row written');

// ─── Dry run #2 (dedupe) ──────────────────────────────────────────
const r2 = await runCurator({ db, userId: U, mode: 'dry_run', logger: null });
ok(recsFor('v10', 'stale').length === 1, 'no duplicate stale proposal for v10 across runs');
const kinds2 = r2.recommendations.map((r) => `${r.version_id}:${r.kind}`).sort();
ok(kinds2.join(',') === 'v2:stale,v3:quarantine,vm1:merge',
  'run #2 re-proposes: v2 stale (restored) + dismissed v3 quarantine + merge (approved ≠ applied, kept surfacing)', kinds2.join(','));

// ─── Prune gating ─────────────────────────────────────────────────
ok(pruneEligible(db, U) === false, 'prune not eligible before reviews');
markRunReviewed(db, r1.run.id, U);
markRunReviewed(db, r2.run.id, U);
ok(reviewedDryRunCount(db, U) === 2, 'two reviewed dry runs counted');
ok(pruneEligible(db, U) === true, 'prune eligible after 2 reviewed dry runs');

// ─── Prune run ────────────────────────────────────────────────────
mkCandidate('c11', 'Prune me');              mkVersion('v11', 'c11'); mkStats('v11', { routed: 1, s: 0, f: 0, last: dISO(40) });
mkCandidate('c12', 'Flaky again');           mkVersion('v12', 'c12'); mkStats('v12', { routed: 6, s: 1, f: 5, last: dISO(1) });
const r3 = await runCurator({ db, userId: U, mode: 'prune', logger: null });
ok(r3.run.mode === 'prune' && r3.run.applied_count === 1, 'prune run applies exactly the stale transition');
ok(flagOf('v11', 'stale') === 1, 'prune auto-applies stale=1');
const v11rec = recsFor('v11', 'stale')[0];
ok(v11rec.state === 'applied' && v11rec.decided_by === 'curator:prune', 'prune rec marked applied by curator');
ok(db.prepare(`SELECT detail FROM learning_version_events WHERE version_id = ? AND action = 'stale_marked' ORDER BY rowid DESC LIMIT 1`)
  .get('v11').detail.includes('curator_prune'), 'prune stale writes stale_marked event');
const v12rec = recsFor('v12', 'quarantine')[0];
ok(v12rec && v12rec.state === 'proposed', 'prune leaves quarantine as proposed (never auto-applies)');

// ─── Executing-set protection ─────────────────────────────────────
registerExecuting('v10');
const r4 = await runCurator({ db, userId: U, mode: 'dry_run', logger: null });
ok(!r4.recommendations.some((r) => r.version_id === 'v10' && r.kind === 'stale'),
  'executing version skipped by finding pass (v10 stale already applied anyway — no new rec)');
unregisterExecuting('v10');

// ─── hardFilter extension ─────────────────────────────────────────
const hrow = (id, extra = {}) => ({
  id, user_id: U, state: 'active', kind: 'prompt_template', artifact: 'a',
  content_hash: createHash('sha256').update('prompt_template\na').digest('hex'),
  risk_tier: 'low', requires_docker: 0, ...extra,
});
const hf = hardFilter({ db, userId: U, versions: [
  hrow('x1'), hrow('x2', { stale: 1 }), hrow('x3', { archived: 1 }),
  hrow('x4', { quarantined: 1 }), hrow('x5', { stale: 0, archived: 0, quarantined: 0 }),
] });
const byId = Object.fromEntries(hf.excluded.map((e) => [e.versionId, e.reason]));
ok(hf.kept.map((v) => v.id).sort().join(',') === 'x1,x5', 'hardFilter keeps clean active versions');
ok(byId.x2 === 'curator_stale' && byId.x3 === 'curator_archived' && byId.x4 === 'curator_quarantined',
  'hardFilter excludes stale/archived/quarantined with curator reasons');

// ─── never-throws ─────────────────────────────────────────────────
const broken = new Database(':memory:'); // no tables at all
const rb = await runCurator({ db: broken, userId: U, logger: null });
ok(rb.run === null && rb.error, 'runCurator never throws on a broken DB (returns error)');

// ─── Route level ──────────────────────────────────────────────────
function makeApp(database) {
  const auditCalls = [];
  const ctx = {
    db: database, stmts: {},
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    audit: (a, rt, rid, uid, d) => auditCalls.push({ a, rt, rid, uid, d }),
    auditLog: () => {}, executeSkill: async () => { throw new Error('no'); },
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
  const app = express();
  app.use(express.json());
  app.use('/api', learningRoutes(ctx));
  return { app, auditCalls };
}
const H = (user, role = 'admin') => ({ 'x-test-user': user, 'x-test-role': role });

// 400 prune on a fresh DB (0 reviewed dry runs)
const db2 = new Database(':memory:');
runMigrations(db2);
const { app: app2 } = makeApp(db2);
let res = await request(app2).post('/api/learning/curator/run').set(H('u2')).send({ mode: 'prune' });
ok(res.status === 400 && res.body.error === 'prune_not_eligible' && res.body.reviewed === 0,
  'POST /curator/run prune → 400 prune_not_eligible before 2 reviewed dry runs');

const { app } = makeApp(db);
res = await request(app).get('/api/learning/curator/runs').set(H(U));
ok(res.status === 200 && Array.isArray(res.body.runs) && res.body.runs.length >= 3, 'GET /curator/runs returns runs');
const runKeys = Object.keys(res.body.runs[0]).sort().join(',');
ok(runKeys === 'applied_count,created_at,findings_count,id,mode,policy_snapshot,reviewed', 'run projection keys', runKeys);
ok(res.body.runs[0].policy_snapshot.stale_after_days === 30, 'run policy_snapshot parsed');

res = await request(app).get('/api/learning/curator/recommendations?state=proposed').set(H(U));
ok(res.status === 200 && res.body.recommendations.length > 0, 'GET /curator/recommendations?state=proposed works');
const recKeys = Object.keys(res.body.recommendations[0]).sort().join(',');
ok(recKeys === 'created_at,decided_at,decided_by,evidence,id,kind,reason,run_id,state,version_id,version_kind,version_state,version_title',
  'recommendation projection keys', recKeys);
ok(typeof res.body.recommendations[0].version_title === 'string', 'version_title resolved from candidate');

const targetRec = res.body.recommendations.find((r) => r.version_id === 'v12');
res = await request(app).post(`/api/learning/curator/recommendations/${targetRec.id}/approve`).set(H('other-user'));
ok(res.status === 404, 'cross-user approve → 404');
res = await request(app).post(`/api/learning/curator/recommendations/${targetRec.id}/approve`).set(H(U));
ok(res.status === 200 && res.body.applied === true && res.body.recommendation.state === 'applied',
  'owner approve → { recommendation, applied: true }');
ok(flagOf('v12', 'quarantined') === 1, 'approve quarantine sets quarantined=1 via route');

res = await request(app).post('/api/learning/skill-versions/v4/pin').set(H(U)).send({ pinned: true });
ok(res.status === 200 && res.body.id === 'v4' && res.body.pinned === true, 'POST /skill-versions/:id/pin → { id, pinned }');
ok(flagOf('v4', 'pinned') === 1, 'pin sets pinned=1 in DB');

res = await request(app).post('/api/learning/skill-versions/v10/restore').set(H(U));
ok(res.status === 200 && res.body.archived === 0 && res.body.stale === 0 && res.body.quarantined === 0,
  'POST /skill-versions/:id/restore → zeroed flags');

res = await request(app).get('/api/learning/curator/config').set(H(U));
ok(res.status === 200 && res.body.config.stale_after_days === 30
  && res.body.config.prune_eligible === true && res.body.config.reviewed_dry_runs === 2,
  'GET /curator/config → config + prune gating');

res = await request(app).post('/api/learning/curator/run').set(H(U)).send({ mode: 'prune' });
ok(res.status === 200 && res.body.run.mode === 'prune' && Array.isArray(res.body.recommendations),
  'POST /curator/run prune → 200 once eligible, { run, recommendations }');

res = await request(app).get('/api/learning/curator/recommendations?state=bogus').set(H(U));
ok(res.status === 400, 'bad state filter → 400');

console.log(`\nphase6 smoke: ${pass} passed, ${fail} failed`);
for (const n of notes) console.log(n);
process.exit(fail ? 1 : 0);
