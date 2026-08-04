-- 009_plugin_market_scanned_at.sql
-- Repair: 008 was initially applied without last_scanned_at. Idempotent —
-- the migrator ignores "duplicate column" errors, so fresh DBs (where 008
-- now includes the column) pass through untouched.

ALTER TABLE plugin_market_sources ADD COLUMN last_scanned_at TEXT;
