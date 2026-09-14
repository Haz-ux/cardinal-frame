-- 027_learning_clusters.sql
-- Phase 3: semantic clustering of learning candidates + merge proposals.
--
-- Clusters group near-duplicate candidates (same procedure described
-- differently). Merge proposals are REVIEW OBJECTS ONLY: nothing merges
-- until Haz approves via the merge-proposals route (shadow mode).
--
-- learning_clusters: one row per cluster. Rows with
-- is_legacy_readonly=1 are backfilled from the old learn_patterns store:
-- they inform (visible in the UI) but never trigger merge proposals and
-- are never deleted by re-clustering.
-- learning_merge_proposals: a proposal to merge several candidates
-- (from_candidate_ids) into a survivor (into_candidate_id, set on
-- approval). state: proposed|approved|dismissed.

CREATE TABLE IF NOT EXISTS learning_clusters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  centroid_signature TEXT NOT NULL DEFAULT '',
  member_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',
  is_legacy_readonly INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_clusters_user ON learning_clusters(user_id);
CREATE INDEX IF NOT EXISTS idx_learning_clusters_user_legacy
  ON learning_clusters(user_id, is_legacy_readonly);

CREATE TABLE IF NOT EXISTS candidate_cluster_members (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES learning_clusters(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(id) ON DELETE CASCADE,
  similarity REAL NOT NULL DEFAULT 0,
  is_centroid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(cluster_id, candidate_id)
);

CREATE INDEX IF NOT EXISTS idx_candidate_cluster_members_candidate
  ON candidate_cluster_members(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_cluster_members_cluster
  ON candidate_cluster_members(cluster_id);

CREATE TABLE IF NOT EXISTS learning_merge_proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL REFERENCES learning_clusters(id) ON DELETE CASCADE,
  from_candidate_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of candidate ids
  into_candidate_id TEXT,                          -- survivor; set on approval
  combined_support TEXT NOT NULL DEFAULT '{}',     -- JSON: {verified, recovered, corrections}
  state TEXT NOT NULL DEFAULT 'proposed',          -- proposed|approved|dismissed
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_merge_proposals_user_state
  ON learning_merge_proposals(user_id, state);
CREATE INDEX IF NOT EXISTS idx_learning_merge_proposals_cluster
  ON learning_merge_proposals(cluster_id);
