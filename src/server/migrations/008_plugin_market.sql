-- 008_plugin_market.sql
-- Plugin marketplace sources (mirrors skill_hub_sources pattern for plugins).
-- Each source is a GitHub repo or JSON endpoint that exposes a plugins-index.json
-- catalog. Installed plugins land on disk under plugins/<name>/ and are loaded
-- via the existing PluginLoader.

CREATE TABLE IF NOT EXISTS plugin_market_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT DEFAULT 'github',
  verified INTEGER DEFAULT 0,
  trust_score INTEGER DEFAULT 0,
  installed_plugins TEXT DEFAULT '[]',
  scan_result TEXT,
  scan_status TEXT DEFAULT 'pending',
  last_scanned_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plugin_market_sources_scan ON plugin_market_sources(scan_status);
