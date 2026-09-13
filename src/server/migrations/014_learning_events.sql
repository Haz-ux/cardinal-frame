-- 014_learning_events.sql
-- Learning pipeline: redacted evidence events.
-- learning/events.mjs records here. Ingress-sanitized only — secrets are
-- dropped by defense/ingress.mjs before the event object is constructed,
-- so this table never sees raw payloads.

CREATE TABLE IF NOT EXISTS learning_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  source_tier TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','reviewing','compiled','rejected')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_events_status ON learning_events(status);
CREATE INDEX IF NOT EXISTS idx_learning_events_kind ON learning_events(kind);
