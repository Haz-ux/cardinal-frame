-- Migration 004: FTS5 full-text search virtual tables (server.mjs lines 628-629)

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_index_fts USING fts5(
  content,
  title,
  content='session_index',
  content_rowid='rowid'
);
