-- 023: Service connector framework storage.
-- One row per connector (github, gmail, google-calendar, ...).
-- Secrets (PATs, OAuth client secrets, tokens) are AES-256-GCM encrypted
-- JSON blobs in secret_json — NEVER plaintext. oauth_state holds the
-- single-use CSRF token for the in-flight Google OAuth flow.

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'service',
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_json TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unconfigured',
  last_test_at TEXT,
  last_error TEXT,
  oauth_state TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connectors_enabled ON connectors(enabled);
