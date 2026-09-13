-- 024_learning_imports.sql
-- TRACK B: learning source connectors — import run history.
--
-- Every learning-source import (JSONL text, Telegram history, future
-- connectors) records one run row here: source, owner, status, and the
-- import counters returned by the adapter. Dry runs are recorded too
-- (dry_run = 1) so operators can audit what was previewed.
--
-- Errors are stored as a count plus a capped detail list; full per-line
-- errors are returned in the API response but not duplicated here.

CREATE TABLE IF NOT EXISTS learning_imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  total INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  deduplicated INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_imports_user ON learning_imports(user_id);
CREATE INDEX IF NOT EXISTS idx_learning_imports_source ON learning_imports(source);
