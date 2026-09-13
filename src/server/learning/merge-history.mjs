/**
 * Cardinal Frame — Learning — Durable merge-proposal history (migration 033).
 *
 * Every decision on a learning merge proposal writes one row to
 * learning_merge_proposal_history: merge-approve and merge-dismiss
 * (from the routes, inside the decision transaction), and
 * superseded_by_recluster (when runClustering deletes open proposals;
 * the L9 audit row with per-run counts is kept as well).
 *
 * The write is deliberately BEST-EFFORT and never throws: re-clustering
 * is contractually never-throw, and a history insert must never break
 * a decision path. Callers can inspect the returned { ok, id } when
 * they want to log a miss.
 *
 * Ownership: history rows inherit the proposal's user_id, consistent
 * with the rest of the learning schema (owner-scoped queries).
 */

import { randomUUID } from 'crypto';

/** Decisions the history table records. */
export const HISTORY_DECISIONS = ['approved', 'dismissed', 'superseded_by_recluster'];

/**
 * Insert one history row for a proposal decision. Never throws.
 *
 * @param {object} db better-sqlite3 handle
 * @param {object} entry {
 *   proposalId, userId, decision, decidedBy?, decidedAt?,
 *   survivorCandidateId?, mergedCandidateIds? (array),
 *   similarity?, reason?, snapshot? (object or JSON string)
 * }
 * @param {object} logger { warn } — defaults to console
 * @returns {{ ok: boolean, id: string|null }}
 */
export function recordMergeProposalHistory(db, entry, logger = console) {
  const result = { ok: false, id: null };
  try {
    if (!entry || !entry.proposalId) throw new Error('proposalId is required');
    if (!entry.userId) throw new Error('userId is required (ownership)');
    if (!HISTORY_DECISIONS.includes(entry.decision)) {
      throw new Error(`unknown decision: ${entry.decision}`);
    }
    const id = randomUUID();
    const snapshot = typeof entry.snapshot === 'string'
      ? entry.snapshot
      : JSON.stringify(entry.snapshot ?? {});
    db.prepare(`INSERT INTO learning_merge_proposal_history
      (id, proposal_id, user_id, survivor_candidate_id, merged_candidate_ids,
       decision, decided_by, decided_at, similarity, reason, proposal_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        entry.proposalId,
        entry.userId,
        entry.survivorCandidateId ?? null,
        JSON.stringify(entry.mergedCandidateIds ?? []),
        entry.decision,
        entry.decidedBy ?? 'system',
        entry.decidedAt ?? new Date().toISOString(),
        entry.similarity ?? null,
        entry.reason ?? null,
        snapshot,
      );
    result.ok = true;
    result.id = id;
  } catch (err) {
    // Best-effort by design: a history miss must not fail the decision.
    try { logger?.warn?.(`learning merge-proposal history not written: ${err?.message || err}`); }
    catch { /* logger itself failed — nothing left to do */ }
  }
  return result;
}

/**
 * Average member similarity for a proposal's candidates inside its
 * cluster (from candidate_cluster_members), used to fill the history
 * row's similarity column. Returns null when no member rows exist.
 * Never throws.
 */
export function avgProposalSimilarity(db, proposal) {
  try {
    if (!proposal?.cluster_id) return null;
    let ids = [];
    try { ids = JSON.parse(proposal.from_candidate_ids || '[]'); } catch { return null; }
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const placeholders = ids.map(() => '?').join(',');
    const row = db.prepare(`SELECT AVG(similarity) AS avg_sim
      FROM candidate_cluster_members
      WHERE cluster_id = ? AND candidate_id IN (${placeholders})`)
      .get(proposal.cluster_id, ...ids);
    return typeof row?.avg_sim === 'number' ? row.avg_sim : null;
  } catch {
    return null;
  }
}
