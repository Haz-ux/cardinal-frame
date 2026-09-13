-- 018_relationship.sql
-- Relationship memory: the shared history between user and companion.
-- Deliberately separate from semantic memory (facts about the world).
-- Loaded every turn, written back every turn — write-first.

CREATE TABLE IF NOT EXISTS relationship_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relationship_writeback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  entry TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_relationship_memory_user ON relationship_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_relationship_writeback_user ON relationship_writeback(user_id);
