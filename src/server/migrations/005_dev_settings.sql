-- 005: Dev settings table (port, log level, debug mode, etc.)
CREATE TABLE IF NOT EXISTS dev_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
