-- 025_mcp_autoconnect.sql
-- Track C: per-server auto-connect flag for the MCP manager. SELECT *
-- compatibility is preserved (new column only; existing statements and
-- the register/list/connect routes behave exactly as before).

ALTER TABLE mcp_servers ADD COLUMN auto_connect INTEGER NOT NULL DEFAULT 0;
