-- 031_purge_admin_comms_mappings.sql
-- Post-C2 cleanup (audit round 2): before the fail-closed fix, inbound
-- Telegram/Discord messages defaulted to the seeded admin account
-- ('haz-001'), so comms_user_sessions rows may still map external senders
-- to the admin user. Those mappings remain effective, so they are deleted
-- here. Deletion is safe and conservative: senders can re-register through
-- the sender->CF-user mapping flow, and unmapped senders are now refused
-- outright (fail-closed). Rows mapping to any other CF user are untouched;
-- nothing is rewritten to a different user.
--
-- NOTE: this table is created by server boot code (server.mjs), which runs
-- AFTER the migrator on a fresh database — so the CREATE TABLE IF NOT
-- EXISTS guard below keeps 031 from failing on fresh installs. On existing
-- databases the table already exists and the guard is a no-op.
--
-- The migrator logs this file as applied; the row count removed was
-- verified in the fix's test harness (admin-mapped rows deleted,
-- all other rows intact).

CREATE TABLE IF NOT EXISTS comms_user_sessions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  remote_username TEXT,
  cf_user_id TEXT NOT NULL,
  agent_session_id TEXT,
  last_active TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, remote_id)
);

DELETE FROM comms_user_sessions WHERE cf_user_id = 'haz-001';
