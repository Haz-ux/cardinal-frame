/**
 * Cardinal Frame — Learning — Candidate Store (Phase 2)
 *
 * CRUD + ownership for learning_candidates / candidate_evidence
 * (migration 026). Every function is owner-scoped: userId is required and
 * always filters; cross-user reads/writes are impossible through this API.
 *
 * SHADOW MODE: candidates are review objects, never usable skills. The
 * approve/reject transitions only flip state flags — no promotion path
 * executes, installs, or activates anything.
 */

import { createHash, randomUUID } from 'crypto';
import { redactPayload, redactText } from './redact.mjs';

// Evidence roles and their support weights (mirrors reviewer config).
export const EVIDENCE_WEIGHTS = {
  success: 1.0,
  recovery_trigger: 1.5,
  recovery_action: 1.5,
  correction: 2.0,
};

/** Cooldown applied to a rejected candidate: 30 days. */
export const REJECT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

function safeParseObj(json) {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function safeParseArr(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Parse a candidate row into the API-facing shape (JSON columns parsed). */
function parseCandidateRow(r) {
  if (!r) return null;
  return {
    ...r,
    draft: safeParseArr(r.draft),
    requested_caps: safeParseArr(r.requested_caps),
    quality_json: safeParseObj(r.quality_json),
  };
}

/**
 * Build a short redacted excerpt from a stored (already redacted) event
 * payload JSON. Never returns the full raw payload. Re-runs the redactor
 * as defense-in-depth — the masks are stable so this is idempotent.
 */
export function buildExcerpt(payloadJson, maxLen = 280) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    payload = {};
  }
  const { payload: redacted } = redactPayload(payload ?? {});
  const parts = [];
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    if (redacted.tool) parts.push(`tool: ${String(redacted.tool).slice(0, 80)}`);
    const cmd = redacted.command ?? redacted.cmd ?? redacted.args;
    if (cmd != null && cmd !== '') parts.push(`cmd: ${String(cmd).slice(0, 120)}`);
    const msg = redacted.summary ?? redacted.message ?? redacted.text ?? redacted.note;
    if (msg != null && msg !== '') parts.push(String(msg).slice(0, 160));
    if (parts.length === 0) parts.push(JSON.stringify(redacted).slice(0, 200));
  } else if (redacted != null) {
    parts.push(String(redacted).slice(0, 200));
  }
  const { text } = redactText(parts.join(' | '));
  return text.slice(0, maxLen);
}

/** sha256 of an excerpt — the stable link stored on candidate_evidence. */
export function excerptHash(excerpt) {
  return createHash('sha256').update(String(excerpt ?? ''), 'utf8').digest('hex');
}

/**
 * Get one candidate. Ownership enforced: returns null when the row does
 * not exist or belongs to another user (no existence leak).
 */
export function getCandidate(db, id, userId) {
  if (!userId) throw new Error('userId is required (ownership)');
  if (!id) return null;
  const row = db
    .prepare('SELECT * FROM learning_candidates WHERE id = ? AND user_id = ?')
    .get(id, userId);
  return parseCandidateRow(row);
}

/**
 * List candidates for a user, newest-score first. state is a DB state
 * ('candidate'|'observed'|'testing'|'promoted'|'rejected') or null for all.
 */
export function listCandidates(db, userId, state = null) {
  if (!userId) throw new Error('userId is required (ownership)');
  const base = `SELECT id, kind, title, risk_tier, state, promotion_score,
                       support_verified, support_recovered, support_corrections,
                       created_at, updated_at
                FROM learning_candidates WHERE user_id = ?`;
  const rows = state
    ? db.prepare(`${base} AND state = ? ORDER BY promotion_score DESC, created_at DESC`).all(userId, state)
    : db.prepare(`${base} ORDER BY promotion_score DESC, created_at DESC`).all(userId);
  return rows;
}

/**
 * Insert a candidate with its evidence rows (one transaction).
 * evidenceItems: [{ eventId, role, weight, excerptHash }]
 */
export function insertCandidate(db, fields, evidenceItems = []) {
  const {
    userId, kind = 'procedure', title = '', draft = [], eligibilityNote = '',
    riskTier = 'low', requestedCaps = [], state = 'candidate',
    supportVerified = 0, supportRecovered = 0, supportCorrections = 0,
    qualityJson = {}, promotionScore = 0,
  } = fields || {};
  if (!userId) throw new Error('userId is required (ownership)');
  const id = randomUUID();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO learning_candidates
      (id, user_id, kind, title, draft, eligibility_note, risk_tier, requested_caps,
       state, support_verified, support_recovered, support_corrections,
       quality_json, promotion_score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, userId, kind, title, JSON.stringify(draft), eligibilityNote,
        riskTier, JSON.stringify(requestedCaps), state,
        supportVerified, supportRecovered, supportCorrections,
        JSON.stringify(qualityJson), promotionScore, now, now,
      );
    const ins = db.prepare(`INSERT OR IGNORE INTO candidate_evidence
      (id, candidate_id, event_id, role, weight, excerpt_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const ev of evidenceItems) {
      ins.run(randomUUID(), id, ev.eventId, ev.role, ev.weight, ev.excerptHash, now);
    }
  });
  tx();
  return getCandidate(db, id, userId);
}

/**
 * Link additional evidence rows to an existing candidate (used when a
 * rejected candidate is reopened on fresh evidence). Idempotent.
 */
export function linkEvidence(db, candidateId, userId, evidenceItems = []) {
  if (!userId) throw new Error('userId is required (ownership)');
  const owner = db
    .prepare('SELECT id FROM learning_candidates WHERE id = ? AND user_id = ?')
    .get(candidateId, userId);
  if (!owner) return 0;
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO candidate_evidence
    (id, candidate_id, event_id, role, weight, excerpt_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let linked = 0;
  const tx = db.transaction(() => {
    for (const ev of evidenceItems) {
      const info = ins.run(randomUUID(), candidateId, ev.eventId, ev.role, ev.weight, ev.excerptHash, now);
      linked += info.changes;
    }
  });
  tx();
  return linked;
}

/**
 * Refresh a candidate's computed fields in place (title, draft, risk,
 * caps, support counts, quality, score). Used on reopen with new evidence.
 */
export function updateCandidateFields(db, id, userId, fields = {}) {
  if (!userId) throw new Error('userId is required (ownership)');
  const sets = [];
  const params = [];
  const jsonCols = { draft: 'draft', requested_caps: 'requestedCaps', quality_json: 'qualityJson' };
  const direct = {
    kind: 'kind', title: 'title', eligibility_note: 'eligibilityNote',
    risk_tier: 'riskTier', support_verified: 'supportVerified',
    support_recovered: 'supportRecovered', support_corrections: 'supportCorrections',
    promotion_score: 'promotionScore',
  };
  for (const [col, key] of Object.entries(direct)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); params.push(fields[key]); }
  }
  for (const [col, key] of Object.entries(jsonCols)) {
    if (fields[key] !== undefined) { sets.push(`${col} = ?`); params.push(JSON.stringify(fields[key])); }
  }
  if (sets.length === 0) return getCandidate(db, id, userId);
  sets.push(`updated_at = ?`);
  params.push(new Date().toISOString(), id, userId);
  db.prepare(`UPDATE learning_candidates SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  return getCandidate(db, id, userId);
}

/**
 * Approve: state -> 'promoted'. Review object only — nothing executes.
 * HIGH risk candidates can still be approved (Haz's explicit tap); the
 * route logs a warning. Returns the updated candidate or null.
 */
export function approveCandidate(db, id, userId) {
  if (!userId) throw new Error('userId is required (ownership)');
  const existing = getCandidate(db, id, userId);
  if (!existing) return null;
  db.prepare(`UPDATE learning_candidates SET state = 'promoted', updated_at = ?
              WHERE id = ? AND user_id = ?`)
    .run(new Date().toISOString(), id, userId);
  return getCandidate(db, id, userId);
}

/**
 * M6 — roll back a candidate's routable versions. Called when a candidate
 * leaves the live set (rejected, or merged away as a merge loser): every
 * 'active'/'approved' version flips to 'rolled_back' so it can never be
 * routed again, with a learning_version_events row recording why.
 *
 * This performs no commit of its own — the caller MUST invoke it inside
 * its transaction so the candidate transition and the version rollbacks
 * commit atomically. Returns the rolled-back version ids.
 *
 * NOTE: the version-event INSERT mirrors compiler.mjs:recordVersionEvent
 * and is inlined here to avoid a candidates<->compiler import cycle
 * (compiler.mjs imports getCandidate from this module).
 */
export function rollbackCandidateVersions(db, candidateId, userId, actor, reason) {
  const now = new Date().toISOString();
  const rows = db.prepare(`SELECT id FROM learning_skill_versions
    WHERE candidate_id = ? AND user_id = ? AND state IN ('active', 'approved')`)
    .all(candidateId, userId);
  const rolledBack = [];
  const upd = db.prepare(`UPDATE learning_skill_versions
    SET state = 'rolled_back', updated_at = ? WHERE id = ?`);
  const evt = db.prepare(`INSERT INTO learning_version_events
    (id, version_id, action, actor, detail, created_at)
    VALUES (?, ?, 'rolled_back', ?, ?, ?)`);
  for (const r of rows) {
    upd.run(now, r.id);
    evt.run(randomUUID(), r.id, actor || null,
      JSON.stringify({ reason, candidate_id: candidateId }), now);
    rolledBack.push(r.id);
  }
  return rolledBack;
}

/**
 * Reject: state -> 'rejected' with reason and a 30-day cooldown. Any
 * 'active'/'approved' versions roll back in the SAME transaction (M6) —
 * a rejected candidate's versions must not stay routable. Returns the
 * updated candidate or null.
 */
export function rejectCandidate(db, id, userId, reason = '') {
  if (!userId) throw new Error('userId is required (ownership)');
  const existing = getCandidate(db, id, userId);
  if (!existing) return null;
  const cooldownUntil = new Date(Date.now() + REJECT_COOLDOWN_MS).toISOString();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE learning_candidates SET state = 'rejected', reject_reason = ?,
                cooldown_until = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(String(reason || '').slice(0, 500), cooldownUntil, now, id, userId);
    rollbackCandidateVersions(db, id, userId, userId, 'candidate rejected');
  });
  tx();
  return getCandidate(db, id, userId);
}

/**
 * Reopen a rejected candidate back to 'candidate' (cooldown cleared).
 * Used by the reviewer when fresh evidence arrives for the same trace
 * after the cooldown expired. No-op unless state is 'rejected'.
 */
export function reopenCandidate(db, id, userId) {
  if (!userId) throw new Error('userId is required (ownership)');
  const info = db.prepare(`UPDATE learning_candidates
    SET state = 'candidate', reject_reason = NULL, cooldown_until = NULL, updated_at = ?
    WHERE id = ? AND user_id = ? AND state = 'rejected'`)
    .run(new Date().toISOString(), id, userId);
  if (info.changes === 0) return getCandidate(db, id, userId);
  return getCandidate(db, id, userId);
}

/**
 * Find candidates already linked to any of the given event ids (for the
 * reviewer's dedupe check). Returns [{ id, state, cooldown_until }].
 */
export function findCandidatesByEventIds(db, userId, eventIds = []) {
  if (!userId) throw new Error('userId is required (ownership)');
  if (!eventIds.length) return [];
  const placeholders = eventIds.map(() => '?').join(',');
  return db.prepare(`SELECT DISTINCT c.id, c.state, c.cooldown_until
    FROM learning_candidates c
    JOIN candidate_evidence e ON e.candidate_id = c.id
    WHERE c.user_id = ? AND e.event_id IN (${placeholders})`)
    .all(userId, ...eventIds);
}

/**
 * Find candidates already linked to evidence from the given trace or
 * conversation key (for the reviewer's dedupe check: never a second open
 * candidate for the same trace). Returns [{ id, state, cooldown_until }].
 */
export function findCandidatesByTraceKey(db, userId, traceKey) {
  if (!userId) throw new Error('userId is required (ownership)');
  if (!traceKey) return [];
  return db.prepare(`SELECT DISTINCT c.id, c.state, c.cooldown_until
    FROM learning_candidates c
    JOIN candidate_evidence e ON e.candidate_id = c.id
    JOIN learning_events le ON le.id = e.event_id
    WHERE c.user_id = ? AND (le.trace_id = ? OR le.conversation_id = ?)`)
    .all(userId, traceKey, traceKey);
}

/** Candidates assembled today (UTC date) for the daily review budget. */
export function countCandidatesToday(db, userId) {
  if (!userId) throw new Error('userId is required (ownership)');
  const row = db.prepare(`SELECT COUNT(*) AS c FROM learning_candidates
    WHERE user_id = ? AND date(created_at) = date('now')`).get(userId);
  return row ? row.c : 0;
}

/**
 * Raw event rows backing a candidate's evidence (for the reviewer to
 * rebuild items when refreshing a reopened candidate). Owner-checked
 * through the candidate row. Returns the stored evidence role alongside
 * each event.
 */
export function getCandidateEventRows(db, candidateId, userId) {
  if (!userId) throw new Error('userId is required (ownership)');
  return db.prepare(`SELECT e.event_id AS id, e.role, e.weight,
      le.trace_id, le.conversation_id, le.type, le.payload, le.outcome,
      le.created_at, le.rowid AS rowid
    FROM candidate_evidence e
    JOIN learning_events le ON le.id = e.event_id
    JOIN learning_candidates c ON c.id = e.candidate_id
    WHERE e.candidate_id = ? AND c.user_id = ?
    ORDER BY le.created_at ASC, le.rowid ASC`).all(candidateId, userId);
}

/**
 * Evidence for a candidate detail view: joins the linked events (owner
 * checked through the candidate row) and computes a short redacted
 * excerpt per event. Full payloads are never returned.
 */
export function getCandidateEvidence(db, candidateId, userId) {
  if (!userId) throw new Error('userId is required (ownership)');
  const rows = db.prepare(`SELECT e.id, e.role, e.weight, e.event_id,
      le.type AS event_type, le.outcome, le.trace_id, le.created_at, le.payload
    FROM candidate_evidence e
    JOIN learning_events le ON le.id = e.event_id
    JOIN learning_candidates c ON c.id = e.candidate_id
    WHERE e.candidate_id = ? AND c.user_id = ?
    ORDER BY le.created_at ASC, le.rowid ASC`).all(candidateId, userId);
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    weight: r.weight,
    event_id: r.event_id,
    event_type: r.event_type,
    outcome: r.outcome,
    trace_id: r.trace_id,
    created_at: r.created_at,
    excerpt: buildExcerpt(r.payload),
  }));
}
