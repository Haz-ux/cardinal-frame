-- 013_skill_hub_source_types.sql
-- Expand skill_hub_sources.type CHECK to match actual usage.
-- Routes insert 'github' and 'url', but the constraint only allowed
-- ('git','tarball','http'), so sources created with the API default type
-- ('github') were rejected. SQLite cannot ALTER a CHECK constraint, so the
-- table is rebuilt with the corrected constraint.
PRAGMA foreign_keys = OFF;

CREATE TABLE skill_hub_sources_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT DEFAULT 'git' CHECK(type IN ('git','github','url','tarball','http')),
  verified INTEGER DEFAULT 0,
  trust_score REAL DEFAULT 0,
  scan_status TEXT DEFAULT 'pending' CHECK(scan_status IN ('pending','scanning','passed','blocked','failed')),
  scan_result TEXT,
  installed_skills TEXT DEFAULT '[]',
  last_scanned_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO skill_hub_sources_new (
  id, name, url, type, verified, trust_score, scan_status, scan_result,
  installed_skills, last_scanned_at, created_at
)
SELECT
  id, name, url, type, verified, trust_score, scan_status, scan_result,
  installed_skills, last_scanned_at, created_at
FROM skill_hub_sources;

DROP TABLE skill_hub_sources;
ALTER TABLE skill_hub_sources_new RENAME TO skill_hub_sources;

PRAGMA foreign_keys = ON;
