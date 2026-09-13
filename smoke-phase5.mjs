// Deterministic smoke test for Phase 5 retrieval + shadow routing.
// Stubs similarity via __setSimilarityOverride — no MiniLM download.
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import {
  ROUTE_WEIGHTS, ROUTE_FLOOR, ROUTE_MARGIN, getRetrievalFlags,
  hardFilter, routeScore, selectWinner,
  triggerMatchScore, recencyScore, affinityScore, successRate,
  recomputeContentHash, shadowRoute, recordFeedback, __setSimilarityOverride,
} from './src/server/learning/retrieval.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

// ─── Setup: in-memory DB with the three Phase-5 tables + minimal parents ─
const db = new Database(':memory:');
for (const f of ['014_learning_events.sql','026_learning_candidates.sql','028_learning_skill_versions.sql','029_learning_retrieval.sql']) {
  db.exec(readFileSync(`src/server/migrations/${f}`, 'utf8'));
}

const U1 = 'user-1', U2 = 'user-2';
const mkCandidate = (id, userId, riskTier) => db.prepare(
  `INSERT INTO learning_candidates (id, user_id, kind, title, draft, state, risk_tier, created_at)
   VALUES (?, ?, 'procedure', ?, 'draft', 'promoted', ?, datetime('now'))`)
  .run(id, userId, `cand-${id}`, riskTier);

// content_hash must replicate compiler.mjs: sha256(`${kind}\n${artifact}`)
const hashFor = (kind, artifact) => createHash('sha256').update(`${kind}\n${artifact}`).digest('hex');
const mkVersion = (id, userId, candId, { state = 'active', kind = 'prompt_template', requires_docker = 0, hash = null } = {}) => {
  const artifact = `artifact-${id}`;
  const h = hash ?? hashFor(kind, artifact);
  db.prepare(`INSERT INTO learning_skill_versions
    (id, user_id, candidate_id, version_number, kind, spec, artifact, content_hash, requires_docker, state, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .run(id, userId, candId, kind,
      JSON.stringify({ problem_signature: 'deploy gate check before release', preconditions: ['ci green'] }),
      artifact, h, requires_docker, state);
  return { id, kind, artifact, hash: h };
};

mkCandidate('c1', U1, 'low');
mkCandidate('c1b', U1, 'low');
mkCandidate('c1c', U1, 'low');
mkCandidate('c2', U1, 'high');
mkCandidate('c3', U2, 'low');
const vGood = mkVersion('v-good', U1, 'c1');
mkVersion('v-other-owner', U2, 'c3');
mkVersion('v-high-risk', U1, 'c2');                     // HIGH risk tier
mkVersion('v-bad-hash', U1, 'c1b', { hash: 'deadbeef' }); // checksum mismatch
mkVersion('v-rolled', U1, 'c1c', { state: 'rolled_back' });

const loadVersion = id => db.prepare(`SELECT v.*, c.risk_tier, c.title AS candidate_title
  FROM learning_skill_versions v JOIN learning_candidates c ON c.id = v.candidate_id WHERE v.id = ?`).get(id);
const all = ['v-good','v-other-owner','v-high-risk','v-bad-hash','v-rolled'].map(loadVersion);

// ─── 1. hardFilter ───────────────────────────────────────────────────
const f = hardFilter({ db, userId: U1, versions: all });
check('hardFilter keeps only the valid version', f.kept.length === 1 && f.kept[0].id === 'v-good', JSON.stringify(f.excluded));
const reasons = Object.fromEntries(f.excluded.map(e => [e.versionId, e.reason]));
check('wrong owner excluded', reasons['v-other-owner'] === 'wrong_owner');
check('HIGH risk excluded', reasons['v-high-risk'] === 'high_risk_tier');
check('checksum mismatch excluded', reasons['v-bad-hash'] === 'checksum_mismatch');
check('rolled_back excluded', reasons['v-rolled'] === 'inactive_state:rolled_back');
check('checksum replicates compiler exactly', recomputeContentHash(loadVersion('v-good')) === vGood.hash);

// ─── 2. routeScore hand-verified ─────────────────────────────────────
const s = routeScore({ similarity: 1, triggerMatch: 1, successRate: 1, recency: 1, affinity: 1, riskPenalty: 0.1 });
check('routeScore all-1.0 minus 0.1 = 0.9', Math.abs(s - 0.9) < 1e-9, String(s));
check('default weights', JSON.stringify(ROUTE_WEIGHTS) === JSON.stringify({ semantic: 0.5, trigger: 0.2, successRate: 0.15, recency: 0.1, affinity: 0.05 }));
check('defaults floor/margin', ROUTE_FLOOR === 0.70 && ROUTE_MARGIN === 0.05);

// ─── 3. component helpers ────────────────────────────────────────────
check('triggerMatchScore matches', triggerMatchScore('check the deploy gate before release', { problem_signature: 'deploy gate check before release', preconditions: ['ci green'] }) > 0.3);
check('triggerMatchScore 0 on garbage', triggerMatchScore('zzz qqq www', { problem_signature: 'deploy gate check' }) === 0);
check('recencyScore today ≈ 1', recencyScore(new Date().toISOString()) > 0.99);
check('recencyScore 30d ≈ 0.5', Math.abs(recencyScore(new Date(Date.now() - 30 * 864e5).toISOString()) - 0.5) < 0.01);
check('affinityScore caps at 1', affinityScore({ routed_count: 50 }) === 1 && affinityScore({ routed_count: 5 }) === 0.5);
check('successRate Laplace no-data = 0.5', successRate(null) === 0.5);
check('successRate Laplace 3/1', successRate({ success_count: 3, failure_count: 1 }) === 4 / 6);

// ─── 4. selectWinner ─────────────────────────────────────────────────
const V = id => ({ id });
const r1 = selectWinner([{ version: V('a'), score: 0.65 }], { floor: 0.7, margin: 0.05 });
check('floor fallback 0.65<0.70', r1.decision === 'fallback_normal' && /below floor/.test(r1.reason));
const r2 = selectWinner([{ version: V('a'), score: 0.80 }, { version: V('b'), score: 0.78 }], { floor: 0.7, margin: 0.05 });
check('margin fallback 0.80 vs 0.78', r2.decision === 'fallback_normal' && /margin/.test(r2.reason));
const r3 = selectWinner([{ version: V('a'), score: 0.80 }, { version: V('b'), score: 0.70 }], { floor: 0.7, margin: 0.05 });
check('winner clears floor+margin', r3.decision === 'shadow_routed' && r3.winner.id === 'a' && r3.runnerUp.id === 'b');
const r4 = selectWinner([{ version: V('a'), score: 0.9 }], { floor: 0.7, margin: 0.05 });
check('single candidate needs only floor', r4.decision === 'shadow_routed');
check('empty → filtered_all', selectWinner([], { floor: 0.7, margin: 0.05 }).decision === 'filtered_all');

// ─── 5. shadowRoute never throws; writes decision; disabled no-op ───
__setSimilarityOverride(() => [0.95]); // single active version gets 0.95
const r5 = await shadowRoute({ db, userId: U1, requestText: 'check the deploy gate before release', context: { sessionId: 's1' } });
check('shadowRoute routes', r5.decision === 'shadow_routed' && r5.winner?.id === 'v-good' && r5.decisionId, JSON.stringify({ d: r5.decision, r: r5.reason }));
const drow = db.prepare('SELECT * FROM learning_routing_decisions WHERE id = ?').get(r5.decisionId);
check('decision row persisted (shadow mode)', drow && drow.mode === 'shadow' && drow.decision === 'shadow_routed');
check('stats bumped', db.prepare('SELECT routed_count FROM learning_skill_stats WHERE version_id = ?').get('v-good')?.routed_count === 1);

const r6 = await shadowRoute({ db, userId: U1, requestText: '' });
check('empty input → error, no throw', r6.decision === 'error');
const r7 = await shadowRoute({ db: null, userId: U1, requestText: 'x' });
check('null db → error, no throw', r7.decision === 'error');

const before = db.prepare('SELECT COUNT(*) AS n FROM learning_routing_decisions').get().n;
process.env.LEARNING_RETRIEVAL_ENABLED = 'false';
const r8 = await shadowRoute({ db, userId: U1, requestText: 'check the deploy gate' });
delete process.env.LEARNING_RETRIEVAL_ENABLED;
check('disabled → no-op, no DB write', r8.decision === 'disabled' && db.prepare('SELECT COUNT(*) AS n FROM learning_routing_decisions').get().n === before);
check('flags reflect env', getRetrievalFlags().retrieval === true && (() => { process.env.LEARNING_RETRIEVAL_ENABLED = '0'; const f2 = getRetrievalFlags().retrieval; delete process.env.LEARNING_RETRIEVAL_ENABLED; return f2 === false; })());
check('flags defaults', (() => { const f3 = getRetrievalFlags(); return f3.capture === true && f3.review === true && f3.curator === false; })());

// ─── 6. redaction ────────────────────────────────────────────────────
__setSimilarityOverride(() => [0.9]);
const r9 = await shadowRoute({ db, userId: U1, requestText: 'deploy gate for haz@example.com with key sk-abc1234567890' });
const erow = db.prepare('SELECT request_excerpt FROM learning_routing_decisions WHERE id = ?').get(r9.decisionId);
check('excerpt redacts email+api key', erow.request_excerpt.includes('[redacted-email]') && erow.request_excerpt.includes('[redacted-api-key]') && !erow.request_excerpt.includes('haz@example.com') && !erow.request_excerpt.includes('sk-abc1234567890'), erow.request_excerpt);
check('excerpt ≤ 200 chars', erow.request_excerpt.length <= 200);

// ─── 7. route vs execution ledgers stay separate ─────────────────────
recordFeedback({ db, userId: U1, decisionId: r5.decisionId, ledger: 'route', positive: true, detail: 'good pick' });
recordFeedback({ db, userId: U1, decisionId: r5.decisionId, ledger: 'execution', positive: false, detail: 'failed at runtime' });
const stats = db.prepare('SELECT * FROM learning_skill_stats WHERE version_id = ?').get('v-good');
check('route ledger hits route counters only', stats.success_count === 1 && stats.failure_count === 0);
const fbRows = db.prepare('SELECT * FROM learning_route_feedback WHERE decision_id = ? ORDER BY ledger').all(r5.decisionId);
check('both ledgers logged as feedback rows', fbRows.length === 2 && fbRows[0].ledger === 'execution' && fbRows[1].ledger === 'route');
check('execution ledger did not touch route counters', stats.failure_count === 0);

// ─── 8. cross-user isolation on recordFeedback ───────────────────────
let threw = false;
try { recordFeedback({ db, userId: U2, decisionId: r5.decisionId, ledger: 'route', positive: true }); }
catch (e) { threw = e.message === 'not found'; }
check('cross-user feedback → not found', threw);
threw = false;
try { recordFeedback({ db, userId: U1, decisionId: r5.decisionId, ledger: 'bogus', positive: true }); }
catch { threw = true; }
check('bad ledger rejected', threw);

// ─── 9. agent-loop hook is fire-and-forget (code inspection) ─────────
const agentSrc = readFileSync('src/server/routes/agent.mjs', 'utf8');
check('hook present after session load', /shadowRoute\(\{ db: _deps\.db, userId: session\.user_id, requestText: session\.task/.test(agentSrc));
check('hook not awaited', !/await shadowRoute/.test(agentSrc));
check('hook wrapped in try/catch with .catch', /try \{\s*\n\s*shadowRoute\(/.test(agentSrc) && /\.catch\(\(\)/.test(agentSrc));
check('loop ignores the result', !/const \w+ = await shadowRoute|await shadowRoute\(/.test(agentSrc));
check('debug log with decision id', /shadow route \$\{r\.decisionId/.test(agentSrc));

__setSimilarityOverride(null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
