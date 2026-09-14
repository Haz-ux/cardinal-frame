-- 019_provenance_defense.sql
-- Defensive pillar persistence: the provenance audit log and canary tokens.
-- Every input is tagged with source + trust tier (user > local-system >
-- paired-devices > web > third-party-agents); the tag travels the turn loop
-- and lands here.

CREATE TABLE IF NOT EXISTS provenance_log (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  source TEXT NOT NULL,
  trust_tier TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS defense_canaries (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  store TEXT NOT NULL,
  planted_at TEXT DEFAULT (datetime('now')),
  tripped_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_provenance_log_tier ON provenance_log(trust_tier);
CREATE INDEX IF NOT EXISTS idx_provenance_log_event ON provenance_log(event_id);
