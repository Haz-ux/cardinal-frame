-- 016_skill_candidates_versions.sql
-- Skill candidates plus immutable version history for the curator gate.
-- A candidate is compiled evidence; a version is one validation pass over
-- it. Only the curator promotes candidate -> installed.

CREATE TABLE IF NOT EXISTS skill_candidates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_event_id TEXT,
  code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK(status IN ('candidate','validating','rejected','installed')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES skill_candidates(id),
  version INTEGER NOT NULL,
  code TEXT NOT NULL,
  validation_result TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(candidate_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates(status);
CREATE INDEX IF NOT EXISTS idx_skill_versions_candidate ON skill_versions(candidate_id);
