-- 022_learning_events.sql
-- Phase 1: durable learning events (plan: persistence design).
--
-- Extends 014's learning_events (id, kind, evidence, source_tier, status)
-- with the plan's evidence-stream fields: ownership (user_id), conversation
-- and trace linkage, event type, redacted JSON payload, outcome, redaction
-- status, and an idempotency key. Existing 014 columns are left readable
-- during the transition; new writes populate both shapes.
--
-- The idempotency uniqueness is a partial index: legacy 014 rows carry an
-- empty key and are never constrained, while every Phase-1 write sets a
-- key derived from (user, conversation, terminal message/version).

ALTER TABLE learning_events ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE learning_events ADD COLUMN conversation_id TEXT NOT NULL DEFAULT '';
ALTER TABLE learning_events ADD COLUMN trace_id TEXT NOT NULL DEFAULT '';
ALTER TABLE learning_events ADD COLUMN type TEXT NOT NULL DEFAULT '';
ALTER TABLE learning_events ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';
ALTER TABLE learning_events ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE learning_events ADD COLUMN redaction_status TEXT NOT NULL DEFAULT 'redacted';
ALTER TABLE learning_events ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';

-- Plan query paths: event conversation/trace/type (+ ownership).
CREATE INDEX IF NOT EXISTS idx_learning_events_user ON learning_events(user_id);
CREATE INDEX IF NOT EXISTS idx_learning_events_conversation ON learning_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_learning_events_trace ON learning_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_learning_events_type ON learning_events(type);

-- Idempotency: one event per (user, conversation, terminal version).
CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_events_idempotency
  ON learning_events(user_id, idempotency_key)
  WHERE idempotency_key <> '';
