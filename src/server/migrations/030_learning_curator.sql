-- 030_learning_curator.sql
-- Phase 6: curator + lifecycle.
--
-- SAFETY CONTRACT (non-negotiable): the curator PROPOSES, Haz disposes.
-- Default mode is dry_run (proposes only, applies nothing). Prune mode
-- auto-applies ONLY stale transitions and only when prune-eligible
-- (>= 2 reviewed dry runs). NOTHING is ever deleted: archive/stale/
-- quarantine are reversible flags, and every transition is recorded in
-- learning_version_events (028).
--
-- learning_curator_runs: one row per curator run (dry_run or prune),
-- carrying the effective policy snapshot used by that run.
-- learning_curator_recommendations: the proposed/approved/dismissed/
-- applied recommendations from each run, keyed to a skill version.
-- kind: stale|archive|quarantine|merge
-- state: proposed|approved|dismissed|applied

CREATE TABLE IF NOT EXISTS learning_curator_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'dry_run',      -- dry_run|prune
  reviewed INTEGER NOT NULL DEFAULT 0,       -- 1 once Haz marks a dry run reviewed
  policy_snapshot TEXT,                      -- JSON of the effective curator config
  findings_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,                                -- failure detail if the run crashed (never-throw contract)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_curator_runs_user_created
  ON learning_curator_runs(user_id, created_at);

CREATE TABLE IF NOT EXISTS learning_curator_recommendations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES learning_curator_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- stale|archive|quarantine|merge
  reason TEXT,                               -- Aimi's plain-language draft (or template fallback)
  evidence TEXT,                             -- JSON raw metrics behind the finding
  state TEXT NOT NULL DEFAULT 'proposed',    -- proposed|approved|dismissed|applied
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_curator_recs_user_state
  ON learning_curator_recommendations(user_id, state);
CREATE INDEX IF NOT EXISTS idx_learning_curator_recs_run
  ON learning_curator_recommendations(run_id);

-- Lifecycle flags on skill versions. Idempotent: the migrator ignores
-- duplicate-column errors, so re-runs are safe.
ALTER TABLE learning_skill_versions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE learning_skill_versions ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE learning_skill_versions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE learning_skill_versions ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;
