-- 026_learning_candidates.sql
-- Phase 2: learning candidate store — reviewer-assembled candidate proposals,
-- per-event evidence links, and review job history.
--
-- Candidates are REVIEW OBJECTS ONLY. Approving a candidate flips a state flag
-- for Haz's UI; no promotion path executes anything (shadow mode). Guard:
-- HIGH risk candidates are never auto-anything.

CREATE TABLE IF NOT EXISTS learning_candidates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'procedure',            -- procedure|recovery|correction
  title TEXT NOT NULL DEFAULT '',
  draft TEXT NOT NULL DEFAULT '[]',                 -- JSON array of step strings
  eligibility_note TEXT NOT NULL DEFAULT '',
  risk_tier TEXT NOT NULL DEFAULT 'low',            -- low|medium|high
  requested_caps TEXT NOT NULL DEFAULT '[]',        -- JSON array of capability strings
  state TEXT NOT NULL DEFAULT 'candidate',          -- observed|candidate|testing|promoted|rejected
  support_verified INTEGER NOT NULL DEFAULT 0,
  support_recovered INTEGER NOT NULL DEFAULT 0,
  support_corrections INTEGER NOT NULL DEFAULT 0,
  quality_json TEXT NOT NULL DEFAULT '{}',          -- JSON: quality components
  promotion_score REAL NOT NULL DEFAULT 0,
  reject_reason TEXT,
  cooldown_until TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_candidates_user ON learning_candidates(user_id);
CREATE INDEX IF NOT EXISTS idx_learning_candidates_user_state ON learning_candidates(user_id, state);

CREATE TABLE IF NOT EXISTS candidate_evidence (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES learning_events(id),
  role TEXT NOT NULL DEFAULT 'success',             -- success|recovery_trigger|recovery_action|correction
  weight REAL NOT NULL DEFAULT 1.0,
  excerpt_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(candidate_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_candidate_evidence_candidate ON candidate_evidence(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_evidence_event ON candidate_evidence(event_id);

CREATE TABLE IF NOT EXISTS learning_review_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',          -- running|completed|failed
  events_scanned INTEGER NOT NULL DEFAULT 0,
  candidates_assembled INTEGER NOT NULL DEFAULT 0,
  dead_lettered INTEGER NOT NULL DEFAULT 0,
  budget_used INTEGER NOT NULL DEFAULT 0,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_learning_review_jobs_user ON learning_review_jobs(user_id);

-- Dead-letter bookkeeping on the Phase-1 evidence stream. The migrator
-- ignores duplicate-column errors, so plain ADD COLUMN is idempotent here.
ALTER TABLE learning_events ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE learning_events ADD COLUMN review_note TEXT;
