/**
 * Cardinal Frame — Learning — Phase 6: Curator + lifecycle.
 *
 * SAFETY CONTRACT (non-negotiable): the curator PROPOSES, Haz disposes.
 * Default mode is dry_run (proposes only, applies nothing). Prune mode
 * auto-applies ONLY stale transitions and only when prune-eligible
 * (>= 2 reviewed dry runs for the user). NOTHING is ever deleted:
 * archive/stale/quarantine are reversible flags, every transition is
 * recorded in learning_version_events, and restoreVersion() clears all
 * of them.
 *
 * Findings are deterministic and data-driven:
 *   stale      — active version not routed for > stale_after_days.
 *                Versions with NO stats row get grace ("never used is
 *                absence of evidence, not failure").
 *   archive    — stale=1 AND the stale_marked event is older than
 *                archive_after_days AND nothing outside the learning
 *                bookkeeping tables references the version (fail-closed:
 *                uncertain references mean "referenced" = protected).
 *   quarantine — route ledger failure rate >= quarantine_failure_rate
 *                over >= min_failure_sample samples.
 *   merge      — a non-legacy cluster holds 2+ active, unarchived,
 *                unquarantined versions.
 *
 * runCurator() NEVER throws outward: every failure is caught, recorded
 * on the run row's `error` column, and returned with zero findings.
 */

import { randomUUID } from 'crypto';
import { recordVersionEvent } from './compiler.mjs';
import { proposeMerges } from './cluster.mjs';

// ─── Config (env-overridable) ───────────────────────────────────────

function envNum(name, def) {
  const v = Number.parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

export function curatorConfig() {
  return {
    stale_after_days: envNum('LEARNING_CURATOR_STALE_DAYS', 30),
    archive_after_days: envNum('LEARNING_CURATOR_ARCHIVE_DAYS', 90),
    quarantine_failure_rate: envNum('LEARNING_CURATOR_QUARANTINE_RATE', 0.50),
    min_failure_sample: Math.max(1, Math.floor(envNum('LEARNING_CURATOR_MIN_SAMPLE', 5))),
    interval_hours: envNum('LEARNING_CURATOR_INTERVAL_HOURS', 168),
  };
}

export const CURATOR_KINDS = ['stale', 'archive', 'quarantine', 'merge'];
export const CURATOR_REC_STATES = ['proposed', 'approved', 'dismissed', 'applied'];

// ─── Executing set (versions currently being run — never curated) ──

const executingVersions = new Set();

export function registerExecuting(versionId) {
  if (versionId) executingVersions.add(versionId);
}

export function unregisterExecuting(versionId) {
  executingVersions.delete(versionId);
}

function isExecuting(versionId) {
  return executingVersions.has(versionId);
}

// ─── Helpers ────────────────────────────────────────────────────────

function safeJsonParse(value, fallback = null) {
  try {
    const v = JSON.parse(value);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function flag(value) {
  return value === 1 || value === true;
}

function daysAgoMs(config, days) {
  return Date.now() - days * 86_400_000;
}

// ─── Reference check (archive finding) ──────────────────────────────
//
// Is this version id referenced by any table outside the learning
// bookkeeping tables? We scan the schema: foreign keys to
// learning_skill_versions plus heuristic *_version_id columns. Learning
// bookkeeping (stats, routing decisions, version events, curator rows)
// does NOT count as a reference — it is read-only history. If we
// cannot determine references with confidence, we fail closed
// (return true = protected from archive).

const INTERNAL_BOOKKEEPING = new Set([
  'learning_skill_versions',
  'learning_skill_stats',
  'learning_version_events',
  'learning_routing_decisions',
  'learning_route_feedback',
  'learning_curator_runs',
  'learning_curator_recommendations',
]);

function qident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function isVersionReferenced(db, versionId, logger = null) {
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'")
      .all();
    for (const { name } of tables) {
      if (INTERNAL_BOOKKEEPING.has(name)) continue;

      let refCols = [];
      try {
        // Prefer explicit foreign keys to learning_skill_versions.
        refCols = db.prepare(`PRAGMA foreign_key_list(${qident(name)})`).all()
          .filter((fk) => String(fk.table).toLowerCase() === 'learning_skill_versions')
          .map((fk) => fk.from)
          .filter(Boolean);
      } catch {
        continue; // cannot introspect this table — not a signal by itself
      }
      if (!refCols.length) {
        let cols = [];
        try {
          cols = db.prepare(`PRAGMA table_info(${qident(name)})`).all();
        } catch {
          continue;
        }
        refCols = cols
          .map((c) => c.name)
          .filter((n) => /(^|_)(version|skill_version)s?_?id$/i.test(String(n)));
      }
      for (const col of refCols) {
        let count = 0;
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${qident(name)} WHERE ${qident(col)} = ?`).get(versionId);
          count = row?.n ?? 0;
        } catch {
          // Query against a known reference column failed — fail closed.
          return true;
        }
        if (count > 0) return true;
      }
    }
    return false;
  } catch (err) {
    try {
      logger?.warn?.(`learning curator: reference check failed for ${versionId} — treating as referenced (${err?.message})`);
    } catch { /* never throws */ }
    return true;
  }
}

// ─── Finding pass ───────────────────────────────────────────────────

function latestStaleMarkedAt(db, versionId) {
  try {
    const row = db.prepare(`SELECT created_at FROM learning_version_events
      WHERE version_id = ? AND action = 'stale_marked'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(versionId);
    const t = row?.created_at ? Date.parse(row.created_at) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function addFinding(findings, existingKeys, versionLike, kind, evidence) {
  const key = `${versionLike.id}:${kind}`;
  if (existingKeys.has(key)) return; // dedupe against recent proposed/applied recs
  existingKeys.add(key);
  findings.push({
    kind,
    versionId: versionLike.id,
    versionTitle: versionLike.candidate_title ?? null,
    versionKind: versionLike.kind ?? null,
    versionNumber: versionLike.version_number ?? null,
    evidence: evidence ?? {},
  });
}

function loadExistingRecommendationKeys(db, userId, sinceIso) {
  const keys = new Set();
  try {
    const rows = db.prepare(`SELECT version_id, kind FROM learning_curator_recommendations
      WHERE user_id = ? AND state IN ('proposed', 'applied') AND created_at >= ?`)
      .all(userId, sinceIso);
    for (const r of rows) keys.add(`${r.version_id}:${r.kind}`);
  } catch { /* best-effort dedupe */ }
  return keys;
}

function collectMergeFindings(db, userId, existingKeys, logger) {
  const findings = [];
  try {
    const clusters = db.prepare(`SELECT id, label FROM learning_clusters
      WHERE user_id = ? AND is_legacy_readonly = 0 AND state = 'active'`).all(userId);
    for (const cluster of clusters) {
      const members = db.prepare(`SELECT c.id AS candidate_id, c.title, c.promotion_score,
          v.id AS version_id, v.kind, v.version_number,
          v.pinned, v.stale, v.archived, v.quarantined
        FROM candidate_cluster_members m
        JOIN learning_candidates c ON c.id = m.candidate_id
        JOIN learning_skill_versions v ON v.candidate_id = c.id AND v.state = 'active'
        WHERE m.cluster_id = ? AND c.user_id = ?`).all(cluster.id, userId);

      // One version per candidate (highest version_number wins a tie).
      const byCandidate = new Map();
      for (const m of members) {
        if (flag(m.pinned) || flag(m.archived) || flag(m.quarantined)) continue;
        if (isExecuting(m.version_id)) continue;
        const cur = byCandidate.get(m.candidate_id);
        if (!cur || (m.version_number ?? 0) > (cur.version_number ?? 0)) {
          byCandidate.set(m.candidate_id, m);
        }
      }
      const distinct = [...byCandidate.values()];
      if (distinct.length < 2) continue;

      distinct.sort((a, b) => (b.promotion_score ?? 0) - (a.promotion_score ?? 0));
      const lead = distinct[0];
      addFinding(findings, existingKeys,
        { id: lead.version_id, candidate_title: lead.title, kind: lead.kind, version_number: lead.version_number },
        'merge',
        {
          cluster_id: cluster.id,
          cluster_label: cluster.label,
          member_count: distinct.length,
          member_titles: distinct.map((d) => d.title).slice(0, 6),
        });
    }
  } catch (err) {
    try { logger?.warn?.(`learning curator: merge finding pass failed: ${err?.message}`); } catch { /* never throws */ }
  }
  return findings;
}

function collectFindings({ db, userId, config, logger }) {
  const findings = [];
  const dedupeSince = new Date(daysAgoMs(config, (config.interval_hours / 24) * 2)).toISOString();
  const existingKeys = loadExistingRecommendationKeys(db, userId, dedupeSince);

  const versions = db.prepare(`SELECT v.*, s.routed_count, s.success_count, s.failure_count, s.last_routed_at,
      c.title AS candidate_title, c.promotion_score AS candidate_score
    FROM learning_skill_versions v
    LEFT JOIN learning_skill_stats s ON s.version_id = v.id
    JOIN learning_candidates c ON c.id = v.candidate_id
    WHERE v.user_id = ? AND v.state = 'active'`).all(userId);

  for (const v of versions) {
    if (flag(v.pinned) || flag(v.archived) || flag(v.quarantined)) continue;
    if (isExecuting(v.id)) continue;
    const staleFlag = flag(v.stale);

    // 1) stale: routed long ago. No stats row at all = grace (absence of
    // evidence is not failure).
    if (!staleFlag) {
      const lastRouted = v.last_routed_at ? Date.parse(v.last_routed_at) : NaN;
      if (Number.isFinite(lastRouted) && lastRouted < daysAgoMs(config, config.stale_after_days)) {
        const days = Math.floor((Date.now() - lastRouted) / 86_400_000);
        addFinding(findings, existingKeys,
          { id: v.id, candidate_title: v.candidate_title, kind: v.kind, version_number: v.version_number },
          'stale',
          {
            last_routed_at: v.last_routed_at,
            days_unused: days,
            stale_after_days: config.stale_after_days,
            routed_count: v.routed_count ?? 0,
          });
      }
    }

    // 2) archive: stale long ago + nothing references it (fail-closed).
    if (staleFlag) {
      const markedAt = latestStaleMarkedAt(db, v.id);
      if (markedAt && markedAt < daysAgoMs(config, config.archive_after_days)) {
        const days = Math.floor((Date.now() - markedAt) / 86_400_000);
        if (!isVersionReferenced(db, v.id, logger)) {
          addFinding(findings, existingKeys,
            { id: v.id, candidate_title: v.candidate_title, kind: v.kind, version_number: v.version_number },
            'archive',
            {
              stale_marked_at: new Date(markedAt).toISOString(),
              days_since_stale_marked: days,
              archive_after_days: config.archive_after_days,
              references_checked: true,
            });
        } else {
          try {
            logger?.info?.(`learning curator: version ${v.id} is stale but referenced — no archive proposal`);
          } catch { /* never throws */ }
        }
      }
    }

    // 3) quarantine: failing the route ledger badly enough to matter.
    const s = v.success_count ?? 0;
    const f = v.failure_count ?? 0;
    const sample = s + f;
    if (sample >= config.min_failure_sample
      && f / sample >= config.quarantine_failure_rate) {
      addFinding(findings, existingKeys,
        { id: v.id, candidate_title: v.candidate_title, kind: v.kind, version_number: v.version_number },
        'quarantine',
        {
          success_count: s,
          failure_count: f,
          sample,
          failure_rate: f / sample,
          quarantine_failure_rate: config.quarantine_failure_rate,
          min_failure_sample: config.min_failure_sample,
        });
    }
  }

  findings.push(...collectMergeFindings(db, userId, existingKeys, logger));
  return findings;
}

// ─── Recommendation drafts (LLM → template fallback, never throws) ─

const CURATOR_SYSTEM_PROMPT =
  'You draft plain-language skill-lifecycle recommendations for Haz. '
  + 'Output a 2-4 sentence plain-language recommendation: what was observed, '
  + 'what it likely means, what is proposed, and what stays safe (nothing is '
  + 'deleted, every flag is reversible). No preamble, no headers, no bullets '
  + '— just the recommendation text.';

/** Aimi's LLM draft, same pattern as reviewer.mjs draftWithLLM. Never throws — null on any failure. */
async function draftReasonWithLLM(db, finding) {
  try {
    let provider = null;
    let modelId = null;
    try {
      const modelRow = db.prepare('SELECT * FROM llm_models WHERE is_default = 1 LIMIT 1').get();
      if (modelRow) {
        provider = db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(modelRow.provider_id);
        modelId = modelRow.model_id;
      }
    } catch { /* table may not exist on old DBs */ }
    if (!provider || !provider.enabled || !modelId) {
      const providers = db.prepare('SELECT * FROM llm_providers WHERE enabled = 1 ORDER BY created_at ASC').all();
      for (const p of providers) {
        const m = db.prepare('SELECT * FROM llm_models WHERE provider_id = ? ORDER BY model_id ASC LIMIT 1').get(p.id);
        const hasKey = p.api_key && String(p.api_key).length > 10 && !String(p.api_key).includes('*');
        if (m && (hasKey || p.type === 'ollama')) { provider = p; modelId = m.model_id; break; }
      }
    }
    if (!provider || !modelId) return null;

    const { executeChat } = await import('../llm/provider-runtime.mjs');
    const title = finding.versionTitle || 'this skill';
    const { content } = await executeChat(provider, modelId, [
      { role: 'system', content: CURATOR_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Draft a recommendation. Finding kind: ${finding.kind}. Skill: ${title} `
          + `(kind: ${finding.versionKind ?? 'unknown'}, version #${finding.versionNumber ?? '?'}). `
          + `Metrics: ${JSON.stringify(finding.evidence).slice(0, 1200)}`,
      },
    ], { max_tokens: 256, temperature: 0.2, timeoutMs: 20000 });

    const text = String(content || '').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Deterministic template draft — always available, never fails, natural-sounding. */
function templateReason(finding) {
  const title = finding.versionTitle || 'This skill';
  const ev = finding.evidence ?? {};
  switch (finding.kind) {
    case 'stale': {
      const days = ev.days_unused ?? '?';
      return `${title} hasn't been routed in ${days} days — it looks unused, though quiet isn't the same as broken. `
        + `I propose marking it stale, which simply takes it out of routing consideration for now. `
        + `Nothing is deleted, and you can restore it any time.`;
    }
    case 'archive': {
      const days = ev.days_since_stale_marked ?? '?';
      return `${title} was marked stale ${days} days ago and still nothing outside the learning logs references it — `
        + `no schedules, chains, or agent configs point at it. I propose archiving it, which is just a flag on the row. `
        + `It stays in the database and can be restored with one tap if you ever want it back.`;
    }
    case 'quarantine': {
      const f = ev.failure_count ?? '?';
      const sample = ev.sample ?? '?';
      const rate = ev.failure_rate != null ? Math.round(ev.failure_rate * 100) : '?';
      return `${title} has failed ${f} of its last ${sample} shadow-routed checks — a ${rate}% failure rate, `
        + `which usually means the underlying procedure drifted or broke. I propose quarantining it: `
        + `it stops being considered for routing but stays in place untouched, and you can restore it once it's fixed.`;
    }
    case 'merge': {
      const n = ev.member_count ?? '?';
      const names = (ev.member_titles || []).filter(Boolean).join(', ');
      return `${title} sits in a cluster of ${n} near-identical skills${names ? ` (${names})` : ''} `
        + `that overlap enough that one good version could cover them all. I propose a merge — you review it `
        + `before anything combines, and I never delete the individual versions myself.`;
    }
    default:
      return `${title}: a ${finding.kind} recommendation was proposed. Nothing is deleted; you decide.`;
  }
}

export async function draftRecommendations(db, findings, logger = null) {
  const out = [];
  for (const f of findings) {
    let reason = null;
    try {
      reason = await draftReasonWithLLM(db, f);
    } catch {
      reason = null;
    }
    if (!reason) reason = templateReason(f);
    out.push({ ...f, reason });
  }
  return out;
}

// ─── Run orchestration ──────────────────────────────────────────────

function insertRunRow(db, runId, userId, mode, policy) {
  db.prepare(`INSERT INTO learning_curator_runs
      (id, user_id, mode, reviewed, policy_snapshot, findings_count, applied_count, created_at)
    VALUES (?, ?, ?, 0, ?, 0, 0, ?)`)
    .run(runId, userId, mode, JSON.stringify(policy), new Date().toISOString());
}

function persistRecommendations({ db, runId, userId, mode, drafted, logger }) {
  let applied = 0;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const insertRec = db.prepare(`INSERT INTO learning_curator_recommendations
        (id, run_id, user_id, version_id, kind, reason, evidence, state, decided_by, decided_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const d of drafted) {
      let state = 'proposed';
      let decidedBy = null;
      let decidedAt = null;
      if (mode === 'prune' && d.kind === 'stale') {
        // Prune mode auto-applies ONLY stale transitions.
        db.prepare('UPDATE learning_skill_versions SET stale = 1, updated_at = ? WHERE id = ? AND user_id = ?')
          .run(now, d.versionId, userId);
        recordVersionEvent(db, d.versionId, 'stale_marked', userId, {
          via: 'curator_prune', run_id: runId,
        });
        state = 'applied';
        decidedBy = 'curator:prune';
        decidedAt = now;
        applied += 1;
      }
      insertRec.run(
        randomUUID(), runId, userId, d.versionId, d.kind, d.reason,
        JSON.stringify(d.evidence ?? {}), state, decidedBy, decidedAt, now,
      );
    }
    db.prepare('UPDATE learning_curator_runs SET findings_count = ?, applied_count = ? WHERE id = ?')
      .run(drafted.length, applied, runId);
  });
  tx();
  return applied;
}

/**
 * Run the curator for a user. NEVER throws outward — any failure is
 * recorded on the run row's `error` column and returned with zero
 * findings.
 *
 * mode 'dry_run' (default): proposes only, applies nothing.
 * mode 'prune': auto-applies ONLY stale transitions (caller must check
 * pruneEligible() first — the route enforces it).
 */
export async function runCurator({ db, userId, mode = 'dry_run', logger = null }) {
  const log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const config = curatorConfig();
  const normMode = mode === 'prune' ? 'prune' : 'dry_run';
  const runId = randomUUID();
  const policy = { ...config, mode: normMode, generated_at: new Date().toISOString() };

  try {
    insertRunRow(db, runId, userId, normMode, policy);
  } catch (err) {
    try { log.error(`learning curator: could not create run row: ${err?.message}`); } catch { /* never throws */ }
    return { run: null, recommendations: [], error: String(err?.message ?? err).slice(0, 500) };
  }

  try {
    const findings = collectFindings({ db, userId, config, logger: log });
    const drafted = await draftRecommendations(db, findings, log);
    persistRecommendations({ db, runId, userId, mode: normMode, drafted, logger: log });
  } catch (err) {
    try {
      db.prepare('UPDATE learning_curator_runs SET error = ? WHERE id = ?')
        .run(String(err?.message ?? err).slice(0, 1000), runId);
    } catch { /* best-effort */ }
    try { log.error(`learning curator run failed: ${err?.message ?? err}`); } catch { /* never throws */ }
  }

  let run = null;
  let recommendations = [];
  try {
    run = db.prepare('SELECT * FROM learning_curator_runs WHERE id = ?').get(runId);
    recommendations = db.prepare(`SELECT * FROM learning_curator_recommendations
      WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`).all(runId);
  } catch { /* return what we have */ }
  return { run, recommendations };
}

// ─── Decisions ──────────────────────────────────────────────────────

export function getRecommendation(db, id, userId) {
  try {
    return db.prepare('SELECT * FROM learning_curator_recommendations WHERE id = ? AND user_id = ?').get(id, userId) ?? null;
  } catch {
    return null;
  }
}

function updatedRecommendation(db, recId) {
  return db.prepare('SELECT * FROM learning_curator_recommendations WHERE id = ?').get(recId);
}

/** Try the cluster merge-proposal path for a merge recommendation. Returns { ok, note }. Never throws. */
function tryMergeProposal(db, rec) {
  try {
    const evidence = safeJsonParse(rec.evidence, {});
    const clusterId = evidence?.cluster_id;
    if (!clusterId) return { ok: false };
    const cluster = db.prepare('SELECT * FROM learning_clusters WHERE id = ? AND user_id = ?')
      .get(clusterId, rec.user_id);
    if (!cluster) return { ok: false };
    const members = db.prepare(`SELECT c.* FROM candidate_cluster_members m
      JOIN learning_candidates c ON c.id = m.candidate_id
      WHERE m.cluster_id = ?`).all(clusterId);
    const created = proposeMerges(db, rec.user_id, [{
      ...cluster,
      isLegacy: cluster.is_legacy_readonly === 1,
      members,
    }]);
    if (created && created.length) {
      return { ok: true, note: `merge proposal created: ${created.join(', ')}` };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Haz approves a proposed recommendation. Applies the lifecycle flag
 * (stale/archive/quarantine) or stages the merge path; never deletes.
 * Returns { recommendation, applied: true } or { error, recommendation }.
 */
export function approveRecommendation(db, recId, actor) {
  const rec = db.prepare('SELECT * FROM learning_curator_recommendations WHERE id = ?').get(recId);
  if (!rec) return { error: 'not_found', recommendation: null };
  if (rec.state !== 'proposed') return { error: 'not_proposed', recommendation: rec };

  const now = new Date().toISOString();
  let note = null;
  let recState = 'applied'; // stale/archive/quarantine apply their flag change
  const tx = db.transaction(() => {
    switch (rec.kind) {
      case 'stale':
        db.prepare('UPDATE learning_skill_versions SET stale = 1, updated_at = ? WHERE id = ?')
          .run(now, rec.version_id);
        recordVersionEvent(db, rec.version_id, 'stale_marked', actor, { recommendation_id: recId });
        break;
      case 'archive':
        db.prepare('UPDATE learning_skill_versions SET archived = 1, updated_at = ? WHERE id = ?')
          .run(now, rec.version_id);
        recordVersionEvent(db, rec.version_id, 'archived', actor, { recommendation_id: recId });
        break;
      case 'quarantine':
        db.prepare('UPDATE learning_skill_versions SET quarantined = 1, updated_at = ? WHERE id = ?')
          .run(now, rec.version_id);
        recordVersionEvent(db, rec.version_id, 'quarantined', actor, { recommendation_id: recId });
        break;
      case 'merge': {
        // The curator cannot execute a merge itself: it stages the cluster
        // merge-proposal path when possible, otherwise stays 'approved'
        // with a note for Haz's manual merge review.
        const res = tryMergeProposal(db, rec);
        note = res.ok ? res.note : 'pending Haz merge review';
        recState = 'approved';
        recordVersionEvent(db, rec.version_id, 'merge_approved', actor, {
          recommendation_id: recId, note,
        });
        break;
      }
      default:
        throw new Error(`unknown recommendation kind: ${rec.kind}`);
    }
    const evidence = note
      ? JSON.stringify({ ...(safeJsonParse(rec.evidence, {}) ?? {}), approval_note: note })
      : rec.evidence;
    db.prepare(`UPDATE learning_curator_recommendations
      SET state = ?, decided_by = ?, decided_at = ?, evidence = ? WHERE id = ?`)
      .run(recState, actor, now, evidence, recId);
  });
  try {
    tx();
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 500), recommendation: rec };
  }
  return { recommendation: updatedRecommendation(db, recId), applied: true };
}

/** Haz dismisses a proposed recommendation. Returns { recommendation } or { error, recommendation }. */
export function dismissRecommendation(db, recId, actor) {
  const rec = db.prepare('SELECT * FROM learning_curator_recommendations WHERE id = ?').get(recId);
  if (!rec) return { error: 'not_found', recommendation: null };
  if (rec.state !== 'proposed') return { error: 'not_proposed', recommendation: rec };
  const now = new Date().toISOString();
  db.prepare(`UPDATE learning_curator_recommendations
    SET state = 'dismissed', decided_by = ?, decided_at = ? WHERE id = ?`)
    .run(actor, now, recId);
  return { recommendation: updatedRecommendation(db, recId) };
}

// ─── Lifecycle primitives ───────────────────────────────────────────

/** Clear all curator flags — the reversible way back. Returns the version row (or null). */
export function restoreVersion(db, versionId, actor) {
  const row = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(versionId);
  if (!row) return null;
  db.prepare(`UPDATE learning_skill_versions
    SET archived = 0, stale = 0, quarantined = 0, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), versionId);
  recordVersionEvent(db, versionId, 'restored', actor, { note: 'curator flags cleared' });
  return db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(versionId);
}

/** Pin (protect from curation) or unpin a version. Returns the version row (or null). */
export function setPinned(db, versionId, pinned, actor) {
  const row = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(versionId);
  if (!row) return null;
  const v = pinned ? 1 : 0;
  db.prepare('UPDATE learning_skill_versions SET pinned = ?, updated_at = ? WHERE id = ?')
    .run(v, new Date().toISOString(), versionId);
  recordVersionEvent(db, versionId, pinned ? 'pinned' : 'unpinned', actor, {});
  return db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(versionId);
}

// ─── Prune gating ───────────────────────────────────────────────────

/** Mark a run reviewed (meaningful for dry_run runs). Returns the run row (or null). */
export function markRunReviewed(db, runId, actor) {
  const row = db.prepare('SELECT * FROM learning_curator_runs WHERE id = ?').get(runId);
  if (!row) return null;
  db.prepare('UPDATE learning_curator_runs SET reviewed = 1 WHERE id = ?').run(runId);
  return db.prepare('SELECT * FROM learning_curator_runs WHERE id = ?').get(runId);
}

export function reviewedDryRunCount(db, userId) {
  try {
    // L10: only dry runs that completed WITHOUT error and actually
    // produced findings count toward prune eligibility — an errored or
    // empty dry run proves nothing about the policy snapshot, so it
    // must not unlock prune mode.
    return db.prepare(`SELECT COUNT(*) AS n FROM learning_curator_runs
      WHERE user_id = ? AND mode = 'dry_run' AND reviewed = 1
        AND error IS NULL AND findings_count > 0`).get(userId).n ?? 0;
  } catch {
    return 0;
  }
}

/** Prune mode unlocks only after Haz has reviewed two dry runs. */
export function pruneEligible(db, userId) {
  return reviewedDryRunCount(db, userId) >= 2;
}
