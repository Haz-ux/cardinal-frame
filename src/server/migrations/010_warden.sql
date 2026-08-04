-- 010_warden.sql
-- WARDEN risk-gate approval queue. Medium-risk actions (sandbox code,
-- delegation commands) require an explicit approval before execution.

CREATE TABLE IF NOT EXISTS warden_approvals (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  warden TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_warden_approvals_status ON warden_approvals(status);
