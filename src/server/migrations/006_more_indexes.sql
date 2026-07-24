-- Migration 006: Additional time-based indexes for sorting / range scans
-- (003_indexes.sql covered most FK/lookup indexes but missed several created_at/updated_at columns
-- used for ordering and time-range queries.)

CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_created_at ON agent_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at_global ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at ON chat_conversations(updated_at);
