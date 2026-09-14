-- 028_learning_skill_versions.sql
-- Phase 4: compiler backend — compiled skill versions from promoted
-- candidates, plus a full event history per version.
--
-- Versions are IMMUTABLE once compiled: there is no edit path. A new
-- compile produces version_number+1. Exactly one version per candidate
-- may be in state 'active' at a time: the activate route rolls other
-- actives back inside its transaction, and migration 032 adds a partial
-- unique index ON (candidate_id) WHERE state='active' so the database
-- enforces it too (second process / direct DB write gap closed).
--
-- SHADOW MODE: even an 'active' version is DISABLED — nothing executes,
-- nothing routes live traffic. Approval/activation only flip state
-- flags for Haz's review UI.

CREATE TABLE IF NOT EXISTS learning_skill_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES learning_candidates(id),
  version_number INTEGER NOT NULL,
  kind TEXT,                          -- script|hybrid|prompt_template|memory
  spec TEXT,                          -- JSON: the validated procedure spec
  rationale TEXT,                     -- why this kind was chosen
  artifact TEXT,                      -- compiled artifact (template text / JSON payload / handler skeleton)
  content_hash TEXT,                  -- sha256(kind + artifact), for dedup/inspection
  scanner_verdict TEXT,               -- JSON: result of the pre-ingest scanner gate
  test_report TEXT,                   -- JSON: { passed, failed, tests: [...] }
  requires_docker INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'compiled',  -- compiled|tested|scanned|approved|active|rolled_back|rejected
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(candidate_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_learning_skill_versions_user_state
  ON learning_skill_versions(user_id, state);
CREATE INDEX IF NOT EXISTS idx_learning_skill_versions_candidate
  ON learning_skill_versions(candidate_id);

CREATE TABLE IF NOT EXISTS learning_version_events (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES learning_skill_versions(id) ON DELETE CASCADE,
  action TEXT NOT NULL,               -- compiled|tested|scanned|approved|activated|rolled_back|rejected
  actor TEXT,
  detail TEXT,                        -- JSON detail payload
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_version_events_version
  ON learning_version_events(version_id);
