-- 029_learning_retrieval.sql
-- Phase 5: retrieval + shadow routing backend.
--
-- SHADOW MODE: routing decisions are recorded for review only. Nothing
-- routes live traffic; the agent loop's behavior is unchanged (the hook
-- in runAgentLoop is fire-and-forget and never awaited).

CREATE TABLE IF NOT EXISTS learning_routing_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,        -- sha256 of the raw request text
  request_excerpt TEXT,              -- redacted (redact.mjs), max 200 chars
  winner_version_id TEXT,            -- NULL when no winner (fallback/filtered)
  winner_score REAL,
  runner_up_score REAL,
  margin REAL,                       -- winner_score - runner_up_score
  score_components TEXT,             -- JSON: {similarity, triggerMatch, successRate, recency, affinity, riskPenalty} for the top-ranked version
  decision TEXT NOT NULL,            -- shadow_routed|fallback_normal|filtered_all
  fallback_reason TEXT,
  mode TEXT NOT NULL DEFAULT 'shadow',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_routing_decisions_user_created
  ON learning_routing_decisions(user_id, created_at);

CREATE TABLE IF NOT EXISTS learning_route_feedback (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES learning_routing_decisions(id) ON DELETE CASCADE,
  ledger TEXT NOT NULL,              -- route|execution (never mixed)
  positive INTEGER NOT NULL,         -- 1 or 0
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_route_feedback_decision
  ON learning_route_feedback(decision_id);

-- Route ledger counters. The EXECUTION ledger is stored ONLY as
-- learning_route_feedback rows; exec confidence is derived from those
-- rows. The two ledgers must NEVER mix.
CREATE TABLE IF NOT EXISTS learning_skill_stats (
  version_id TEXT PRIMARY KEY,
  routed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_routed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
