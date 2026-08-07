-- 011_memories_category_widen.sql
-- Widen the memories.category CHECK constraint to include framework-defined
-- categories used by the context compression engine and slash-command store.
-- SQLite cannot ALTER a CHECK in place, so we recreate the table (data preserved
-- via the temp-copy + swap pattern). Only runs if the existing table still has
-- the narrow constraint; guarded by a pragma check via the migrator runner.

-- New allowed categories: existing 6 + 'compressed-context' (from /compress).
-- Any other value falls back to 'memory' (the column default).

CREATE TABLE IF NOT EXISTS memories_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT DEFAULT 'memory' CHECK(category IN ('user','project','memory','preference','fact','correction','compressed-context')),
  content TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  confidence REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Copy existing rows (idempotent — no-op if memories is empty).
INSERT OR IGNORE INTO memories_new (id, user_id, category, content, source, confidence, access_count, last_accessed, created_at, updated_at)
SELECT id, user_id, category, content, source, confidence, access_count, last_accessed, created_at, updated_at FROM memories;

-- Swap tables atomically. The FTS index (memories_fts) references memories by
-- rowid, so we drop+recreate it and re-index after the swap.
DROP TABLE IF EXISTS memories_fts;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

-- Re-create the FTS index and repopulate it from the swapped-in table.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='rowid');
INSERT INTO memories_fts(rowid, content) SELECT rowid, content FROM memories;

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_user_category ON memories(user_id, category);
