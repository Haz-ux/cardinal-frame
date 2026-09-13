-- 017_identity.sql
-- Companion identity: one singleton row shared across all clients, plus the
-- avatar candidate staging table. Activation (user pick) flips a staged
-- candidate to active — the machine never re-faces itself unprompted.

CREATE TABLE IF NOT EXISTS identity (
  id TEXT PRIMARY KEY CHECK(id = 'singleton'),
  name TEXT NOT NULL DEFAULT 'Cardinal',
  character TEXT NOT NULL DEFAULT '',
  vibe TEXT NOT NULL DEFAULT '',
  color_language TEXT NOT NULL DEFAULT '{}',
  style_anchors TEXT NOT NULL DEFAULT '[]',
  avatar_master_ref TEXT,
  voice_profile TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS avatar_candidates (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  negative_prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'staged'
    CHECK(status IN ('staged','active','archived','rejected')),
  created_at TEXT DEFAULT (datetime('now')),
  activated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_avatar_candidates_status ON avatar_candidates(status);
