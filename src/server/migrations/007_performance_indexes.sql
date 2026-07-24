-- 007_performance_indexes.sql
-- Missing indexes for hot-path queries identified in performance audit

-- Dashboard activity-series: global time-range queries on created_at
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_created_at ON agent_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at_global ON chat_messages(created_at);

-- Conversation listing: ORDER BY updated_at DESC
CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at ON chat_conversations(updated_at);
