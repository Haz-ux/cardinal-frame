-- 033_learning_merge_proposal_history.sql
-- Durable per-decision history for learning merge proposals.
--
-- The L9 audit row records only per-run deleted counts; a proposal that
-- is approved, dismissed, or killed by a fresh re-cluster deserves its
-- own durable record beyond the audit log. Every decision path writes
-- one row here: merge-approve and merge-dismiss in the routes, and
-- superseded_by_recluster when runClustering deletes open proposals.
-- The full proposal row is frozen into proposal_snapshot at decision
-- time, so the record survives the proposal row itself being deleted.
-- user_id inherits the proposal's owner for ownership isolation.

CREATE TABLE IF NOT EXISTS learning_merge_proposal_history (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,              -- original learning_merge_proposals.id
  user_id TEXT NOT NULL,                  -- ownership: the proposal's owner
  survivor_candidate_id TEXT,             -- set on 'approved' only (NULL otherwise)
  merged_candidate_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of loser candidate ids
  decision TEXT NOT NULL,                 -- approved | dismissed | superseded_by_recluster
  decided_by TEXT NOT NULL,               -- user id, or 'system' for re-cluster
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  similarity REAL,                        -- avg member similarity at decision time (may be NULL)
  reason TEXT,                            -- plain-language reason / trigger
  proposal_snapshot TEXT NOT NULL DEFAULT '{}'  -- JSON: full proposal row at decision time
);

CREATE INDEX IF NOT EXISTS idx_merge_proposal_history_user_decision
  ON learning_merge_proposal_history(user_id, decision);
CREATE INDEX IF NOT EXISTS idx_merge_proposal_history_proposal
  ON learning_merge_proposal_history(proposal_id);
