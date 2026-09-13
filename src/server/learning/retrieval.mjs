/**
 * Cardinal Frame — Learning — Phase 5: Retrieval + Shadow Routing.
 *
 * SHADOW MODE ONLY. This module scores Haz-activated skill versions
 * against an agent request and records what WOULD have been routed —
 * it never alters agent behavior, never executes anything, and never
 * throws (shadowRoute catches everything internally).
 *
 * Pipeline per request:
 *   1. hardFilter  — drop versions that must not be considered (owner,
 *      state, risk tier, Docker availability, checksum integrity).
 *   2. similarity  — MiniLM embeddings over COMPACT metadata only
 *      (title / problem_signature / kind — never full spec), with a
 *      lexical Jaccard fallback if the model fails (same approach as
 *      cluster.mjs buildSimilarity).
 *   3. routeScore  — weighted blend of similarity, trigger match,
 *      Laplace-smoothed success rate, recency, affinity, minus a
 *      risk-tier penalty.
 *   4. selectWinner — winner must clear ROUTE_FLOOR and beat the
 *      runner-up by ROUTE_MARGIN (single candidate needs only floor).
 *   5. persist     — decision row with redacted excerpt + sha256 of the
 *      raw request; FULL spec is loaded only for the winner
 *      (progressive disclosure); winner's routed_count bumped.
 *
 * Two feedback ledgers, kept strictly separate:
 *   - route ledger     → learning_skill_stats.success_count/failure_count
 *   - execution ledger → learning_route_feedback rows ONLY (exec
 *     confidence is derived by aggregating those rows, never stored
 *     on the stats row). The two ledgers must NEVER mix.
 */

import { createHash, randomUUID } from 'crypto';
import { redactText } from './redact.mjs';
import { embedBatch, cosineSimilarity, unloadEmbeddingModel } from '../embeddings.mjs';
import { lexicalSimilarity } from './cluster.mjs';
import { isDockerAvailable } from '../routes/docker-backend.mjs';

// ─── Config (env-overridable) ─────────────────────────────────────────

function envBool(name, def) {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const v = String(raw).trim().toLowerCase();
  return !['0', 'false', 'no', 'off', ''].includes(v);
}

/**
 * M7 — read an env override clamped to [0, 1]. Out-of-range (or
 * non-numeric) values warn and fall back to the default — same pattern
 * as cluster.mjs:readThreshold. zeroAllowed=false also rejects 0 (used
 * for the route floor, where 0 would silently disable the safety check).
 */
function envClamped(name, def, { zeroAllowed = true } = {}) {
  const raw = Number.parseFloat(process.env[name]);
  const outOfRange = !Number.isFinite(raw) || raw < 0 || raw > 1 || (!zeroAllowed && raw === 0);
  if (outOfRange) {
    if (Number.isFinite(raw)) {
      console.warn(`[learning-retrieval] ${name}=${raw} out of range — clamped to default ${def}`);
    }
    return def;
  }
  return raw;
}

/** Blend weights for routeScore(). Env: LEARNING_WEIGHT_<NAME>. */
export const ROUTE_WEIGHTS = {
  semantic: envClamped('LEARNING_WEIGHT_SEMANTIC', 0.50),
  trigger: envClamped('LEARNING_WEIGHT_TRIGGER', 0.20),
  successRate: envClamped('LEARNING_WEIGHT_SUCCESS_RATE', 0.15),
  recency: envClamped('LEARNING_WEIGHT_RECENCY', 0.10),
  affinity: envClamped('LEARNING_WEIGHT_AFFINITY', 0.05),
};

/** Minimum score for a shadow route. Env: LEARNING_ROUTE_FLOOR (0.70). */
export const ROUTE_FLOOR = envClamped('LEARNING_ROUTE_FLOOR', 0.70, { zeroAllowed: false });

/** Minimum winner-minus-runner-up gap. Env: LEARNING_ROUTE_MARGIN (0.05). */
export const ROUTE_MARGIN = envClamped('LEARNING_ROUTE_MARGIN', 0.05);

/**
 * Phase kill-switches. All are read live from the environment on every
 * call, so tests and operators can flip them without a restart.
 */
export function getRetrievalFlags() {
  return {
    capture: envBool('LEARNING_CAPTURE_ENABLED', true),
    review: envBool('LEARNING_REVIEW_ENABLED', true),
    retrieval: envBool('LEARNING_RETRIEVAL_ENABLED', true),
    // M8: defaults to enabled — that matches the effective behavior before
    // this flag was wired into the curator routes. Only an explicit
    // 'false' disables them (see requireCuratorEnabled in routes/learning.mjs).
    curator: envBool('LEARNING_CURATOR_ENABLED', true),
  };
}

// ─── Checksum (must match compiler.mjs EXACTLY) ──────────────────────

/**
 * Recompute the content hash for a version row. This replicates
 * compiler.mjs compile() verbatim:
 *   createHash('sha256').update(`${kind}\n${artifact}`).digest('hex')
 * A mismatch means the stored artifact/spec no longer matches what was
 * compiled and scanned — the version is excluded from routing.
 */
export function recomputeContentHash(versionRow) {
  const kind = versionRow.kind ?? '';
  const artifact = versionRow.artifact ?? '';
  return createHash('sha256').update(`${kind}\n${artifact}`).digest('hex');
}

// ─── Component score helpers (exported for tests) ───────────────────

/**
 * Trigger match: Jaccard token overlap between the request text and the
 * version's trigger surface (problem_signature + preconditions).
 * Normalized 0..1 via lexicalSimilarity (same tokenizer as cluster.mjs).
 */
export function triggerMatchScore(requestText, spec) {
  let parsed = null;
  if (typeof spec === 'string') {
    try { parsed = JSON.parse(spec); } catch { parsed = null; }
  } else if (spec && typeof spec === 'object') {
    parsed = spec;
  }
  const triggerText = [
    parsed?.problem_signature ?? '',
    ...(Array.isArray(parsed?.preconditions) ? parsed.preconditions : []),
  ].join(' ');
  return lexicalSimilarity(requestText ?? '', triggerText);
}

/** Recency: 1/(1+days/30) — today ≈ 1, 30 days ago = 0.5, never 0. */
export function recencyScore(isoDate) {
  if (!isoDate) return 0;
  const t = new Date(isoDate).getTime();
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, (Date.now() - t) / 86_400_000);
  return 1 / (1 + days / 30);
}

/** Affinity: how often this version has been shadow-routed (0..1). */
export function affinityScore(statsRow) {
  const n = statsRow?.routed_count ?? 0;
  return Math.min(1, Math.max(0, n) / 10);
}

/** Success rate with Laplace smoothing: (s+1)/(s+f+2). No stats → 0.5. */
export function successRate(statsRow) {
  const s = Math.max(0, statsRow?.success_count ?? 0);
  const f = Math.max(0, statsRow?.failure_count ?? 0);
  return (s + 1) / (s + f + 2);
}

/**
 * Weighted blend. All inputs 0..1; riskPenalty >= 0.
 * riskPenalty source: 0.05 for risk_tier 'medium', 0 otherwise
 * ('high' is hard-filtered out entirely).
 */
export function routeScore({ similarity, triggerMatch, successRate: sr, recency, affinity, riskPenalty = 0 }) {
  const w = ROUTE_WEIGHTS;
  return w.semantic * similarity
    + w.trigger * triggerMatch
    + w.successRate * sr
    + w.recency * recency
    + w.affinity * affinity
    - riskPenalty;
}

// ─── Hard filter (runs BEFORE scoring) ──────────────────────────────

/**
 * Exclude versions that must not be routable. Input rows are
 * learning_skill_versions rows joined with the candidate's risk_tier,
 * title, and state (see shadowRoute's loader). Phase 6 curator flags
 * (stale/archived/quarantined) and dead candidate states
 * (rejected/archived) also exclude a version from routing. Never throws:
 * a version that fails filtering itself is excluded with reason
 * 'filter_error'.
 *
 * @returns {{ kept: object[], excluded: Array<{versionId, reason}> }}
 */
export function hardFilter({ db, userId, versions, logger = null }) {
  const kept = [];
  const excluded = [];
  const list = Array.isArray(versions) ? versions : [];

  for (const v of list) {
    try {
      const versionId = v?.id ?? '(unknown)';
      let reason = null;

      if (!v || v.user_id !== userId) {
        reason = 'wrong_owner';
      } else if (v.state !== 'active') {
        // Only Haz-activated versions are routable. State also covers
        // rolled_back / superseded / approved / compiled / tested.
        reason = `inactive_state:${v.state ?? 'null'}`;
      } else if (v.candidate_state && ['rejected', 'archived'].includes(String(v.candidate_state))) {
        // M6: versions of rejected/merged-away candidates must never route,
        // even if a lifecycle transition missed rolling them back.
        reason = `candidate_${v.candidate_state}`;
      } else if (v.stale === 1 || v.stale === true) {
        // Phase 6 curator: marked stale — out of routing until restored.
        reason = 'curator_stale';
      } else if (v.archived === 1 || v.archived === true) {
        // Phase 6 curator: archived — reversible flag, not routed.
        reason = 'curator_archived';
      } else if (v.quarantined === 1 || v.quarantined === true) {
        // Phase 6 curator: quarantined — failing, not routed until restored.
        reason = 'curator_quarantined';
      } else if (String(v.risk_tier ?? '').toLowerCase() === 'high') {
        reason = 'high_risk_tier';
      } else if (v.requires_docker && !isDockerAvailable()) {
        reason = 'docker_unavailable';
      } else if (recomputeContentHash(v) !== (v.content_hash ?? '')) {
        reason = 'checksum_mismatch';
        // Checksum mismatch is an integrity signal, not just a routing
        // skip — log it. The version stays in place for review; it is
        // only excluded from routing.
        try { logger?.warn(`learning retrieval: checksum mismatch on version ${versionId} — excluded from shadow routing`); } catch { /* never throws */ }
      }

      if (reason) excluded.push({ versionId, reason });
      else kept.push(v);
    } catch {
      excluded.push({ versionId: v?.id ?? '(unknown)', reason: 'filter_error' });
    }
  }

  return { kept, excluded };
}

// ─── Winner selection ───────────────────────────────────────────────

/**
 * ranked: [{ version, score }] sorted desc by score.
 * Winner must clear `floor` AND beat the runner-up by `margin`.
 * A single candidate needs only the floor. Empty input → filtered_all.
 */
export function selectWinner(ranked, { floor = ROUTE_FLOOR, margin = ROUTE_MARGIN } = {}) {
  const list = Array.isArray(ranked) ? ranked : [];
  if (list.length === 0) {
    return { winner: null, runnerUp: null, decision: 'filtered_all', reason: 'no routable versions after filtering' };
  }
  const [top, ...rest] = list;
  if (!(top.score >= floor)) {
    return {
      winner: null, runnerUp: rest[0]?.version ?? null,
      decision: 'fallback_normal',
      reason: `top score ${fmt(top.score)} below floor ${fmt(floor)}`,
    };
  }
  if (rest.length === 0) {
    return { winner: top.version, runnerUp: null, decision: 'shadow_routed', reason: '' };
  }
  const runnerUp = rest[0];
  const gap = top.score - runnerUp.score;
  if (gap < margin) {
    return {
      winner: null, runnerUp: runnerUp.version,
      decision: 'fallback_normal',
      reason: `margin ${fmt(gap)} below required ${fmt(margin)} (${fmt(top.score)} vs ${fmt(runnerUp.score)})`,
    };
  }
  return { winner: top.version, runnerUp: runnerUp.version, decision: 'shadow_routed', reason: '' };
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(3) : 'n/a';
}

// ─── Similarity seam (MiniLM with lexical fallback) ──────────────────

// Test seam: shadowRoute uses this override when set, so unit tests and
// smoke scripts stay deterministic without the MiniLM model download.
let similarityOverride = null;

/** @internal — tests only. Set a deterministic (requestText, signatures) => number[] fn. */
export function __setSimilarityOverride(fn) {
  similarityOverride = typeof fn === 'function' ? fn : null;
}

async function computeSimilarities(requestText, signatures) {
  if (similarityOverride) {
    const out = await similarityOverride(requestText, signatures);
    if (Array.isArray(out) && out.length === signatures.length) return out;
    return signatures.map(() => 0);
  }

  try {
    const raw = await embedBatch([requestText, ...signatures]);
    if (Array.isArray(raw) && raw.length === signatures.length + 1
        && raw.every(v => Array.isArray(v) && v.length > 0)) {
      // MiniLM success: free the model now; routing is bursty, not continuous.
      try { unloadEmbeddingModel(); } catch { /* never breaks routing */ }
      const q = raw[0];
      return signatures.map((_, i) =>
        Math.max(0, Math.min(1, cosineSimilarity(q, raw[i + 1]))));
    }
  } catch { /* fall through to lexical */ }
  // Lexical Jaccard fallback (same approach as cluster.mjs buildSimilarity).
  return signatures.map(sig => lexicalSimilarity(requestText, sig));
}

// Compact signature: only the routable metadata surface, NOT the full spec.
function versionSignature(v, spec) {
  return [v?.kind ?? '', spec?.problem_signature ?? '', spec?.title ?? '']
    .filter(Boolean).join(' ');
}

function parseSpec(versionRow) {
  if (versionRow?._parsedSpec) return versionRow._parsedSpec;
  let parsed = null;
  try { parsed = JSON.parse(versionRow?.spec ?? 'null'); } catch { parsed = null; }
  return parsed ?? {};
}

function riskPenaltyFor(versionRow) {
  return String(versionRow?.risk_tier ?? '').toLowerCase() === 'medium' ? 0.05 : 0;
}

// ─── Main entry: shadowRoute ─────────────────────────────────────────

/**
 * Shadow-route an agent request against the user's active skill versions.
 * NEVER throws and NEVER affects the caller — it only records what would
 * have been routed. Resolves { winner, score, decision, decisionId, reason }.
 *
 * winner is the full version row (loaded only after selection —
 * progressive disclosure), or null when there is no winner.
 */
export async function shadowRoute({ db, userId, requestText, context = {} }) {
  const fail = (reason) => ({ winner: null, score: null, decision: 'error', decisionId: null, reason });

  try {
    const flags = getRetrievalFlags();
    if (!flags.retrieval) {
      // No DB write when retrieval is disabled.
      return { winner: null, score: null, decision: 'disabled', decisionId: null, reason: 'LEARNING_RETRIEVAL_ENABLED=false' };
    }
    if (!db || !userId || typeof requestText !== 'string' || requestText.trim() === '') {
      return fail('empty or invalid input');
    }

    // M10: the cheap exclusion filters are pushed into SQL — curator
    // flags (stale/archived/quarantined) and dead candidate states —
    // so a JS-side bug or early return in hardFilter can never silently
    // route a quarantined or orphaned version. hardFilter below stays
    // as the second defense layer.
    const rows = db.prepare(`
      SELECT v.*, c.risk_tier, c.title AS candidate_title, c.state AS candidate_state
      FROM learning_skill_versions v
      JOIN learning_candidates c ON c.id = v.candidate_id
      WHERE v.user_id = ? AND v.state = 'active'
        AND COALESCE(v.stale, 0) = 0
        AND COALESCE(v.archived, 0) = 0
        AND COALESCE(v.quarantined, 0) = 0
        AND c.state NOT IN ('rejected', 'archived')
    `).all(userId);

    const { kept, excluded } = hardFilter({ db, userId, versions: rows });

    let selection;
    let ranked = [];
    if (kept.length === 0) {
      const reasons = excluded.slice(0, 5).map(e => `${e.versionId}:${e.reason}`).join(', ');
      selection = {
        winner: null, runnerUp: null,
        decision: 'filtered_all',
        reason: reasons ? `all versions filtered: ${reasons}` : 'no active versions',
      };
    } else {
      const parsed = kept.map(v => ({ v, spec: parseSpec(v) }));
      const signatures = parsed.map(({ v, spec }) => versionSignature(v, spec));
      const sims = await computeSimilarities(requestText, signatures);

      ranked = await Promise.all(parsed.map(async ({ v, spec }, i) => {
        const stats = db.prepare('SELECT * FROM learning_skill_stats WHERE version_id = ?').get(v.id) ?? null;
        // Retain the components alongside the score — they are persisted on
        // the decision row so the UI can show WHY the router chose (or not).
        const components = {
          similarity: sims[i] ?? 0,
          triggerMatch: triggerMatchScore(requestText, spec),
          successRate: successRate(stats),
          recency: recencyScore(v.updated_at ?? v.created_at),
          affinity: affinityScore(stats),
          riskPenalty: riskPenaltyFor(v),
        };
        const score = routeScore(components);
        return { version: v, score, components };
      }));
      ranked.sort((a, b) => b.score - a.score);

      selection = selectWinner(ranked, { floor: ROUTE_FLOOR, margin: ROUTE_MARGIN });
    }

    // Persist the decision (shadow record only).
    const now = new Date().toISOString();
    const decisionId = randomUUID();
    const excerpt = redactText(requestText).text.slice(0, 200);
    const requestHash = createHash('sha256').update(requestText).digest('hex');

    const winnerRow = selection.winner;
    const topScore = ranked.length > 0 ? ranked[0].score : null;
    const secondScore = ranked.length > 1 ? ranked[1].score : null;
    const marginVal = topScore !== null && secondScore !== null
      ? topScore - secondScore
      : null;
    // Components of the top-ranked version (winner or near-miss) so the
    // decision log can explain the ranking. NULL when nothing was ranked.
    const topComponents = ranked.length > 0 ? ranked[0].components : null;
    const insert = db.prepare(`INSERT INTO learning_routing_decisions
      (id, user_id, request_hash, request_excerpt, winner_version_id,
       winner_score, runner_up_score, margin, score_components, decision, fallback_reason, mode, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shadow', ?)`);
    insert.run(
      decisionId, userId, requestHash, excerpt,
      winnerRow ? winnerRow.id : null,
      winnerRow ? topScore : null,
      secondScore,
      winnerRow ? marginVal : null,
      topComponents ? JSON.stringify(topComponents) : null,
      selection.decision,
      selection.reason || null,
      now,
    );

    let winner = null;
    if (winnerRow) {
      // Progressive disclosure: load the FULL version row only for the winner.
      winner = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(winnerRow.id) ?? null;
      bumpStats(db, winnerRow.id, now);
    }

    return {
      winner,
      score: winnerRow ? topScore : null,
      decision: selection.decision,
      decisionId,
      reason: selection.reason,
    };
  } catch (err) {
    return fail(err?.message ?? 'unknown error');
  }
}

// bump routed_count / last_routed_at for the shadow winner
function bumpStats(db, versionId, now) {
  db.prepare(`INSERT INTO learning_skill_stats (version_id, routed_count, last_routed_at, updated_at)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(version_id) DO UPDATE SET
      routed_count = routed_count + 1,
      last_routed_at = excluded.last_routed_at,
      updated_at = excluded.updated_at`).run(versionId, now, now);
}

// ─── Feedback (two ledgers, never mixed) ────────────────────────────

/**
 * Record feedback on a routing decision. Owner-scoped: the decision must
 * belong to userId (throws Error('not found') on mismatch → routes map to
 * 404).
 *
 * LEDGER SEPARATION (documented choice):
 *   - ledger 'route'     → increments the winner's
 *     learning_skill_stats.success_count/failure_count (route ledger).
 *   - ledger 'execution' → writes a learning_route_feedback row ONLY.
 *     Execution confidence is DERIVED by aggregating those rows; no
 *     exec_* counters live on learning_skill_stats. The two ledgers
 *     never touch each other's storage.
 */
export function recordFeedback({ db, userId, decisionId, ledger, positive, detail = null }) {
  if (!db || !userId || !decisionId) throw new Error('db, userId, and decisionId are required');
  if (ledger !== 'route' && ledger !== 'execution') throw new Error("ledger must be 'route' or 'execution'");
  if (typeof positive !== 'boolean') throw new Error('positive must be a boolean');

  const decision = db.prepare('SELECT * FROM learning_routing_decisions WHERE id = ? AND user_id = ?')
    .get(decisionId, userId);
  if (!decision) throw new Error('not found');

  const now = new Date().toISOString();
  const pos = positive ? 1 : 0;

  db.prepare(`INSERT INTO learning_route_feedback (id, decision_id, ledger, positive, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), decisionId, ledger, pos, detail, now);

  if (ledger === 'route' && decision.winner_version_id) {
    // Route ledger ONLY: route counters on the winner's stats row.
    db.prepare(`INSERT INTO learning_skill_stats (version_id, updated_at)
      VALUES (?, ?) ON CONFLICT(version_id) DO NOTHING`).run(decision.winner_version_id, now);
    db.prepare(`UPDATE learning_skill_stats
      SET ${pos ? 'success_count = success_count + 1' : 'failure_count = failure_count + 1'},
          updated_at = ?
      WHERE version_id = ?`).run(now, decision.winner_version_id);
  }
  // Execution ledger: feedback row only — never touches route counters.

  return { ok: true, decisionId, ledger, positive };
}
