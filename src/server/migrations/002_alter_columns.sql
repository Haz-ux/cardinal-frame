-- Migration 002: Column additions (ALTER TABLE — server.mjs lines 577-641)
-- Note: SQLite ALTER TABLE ADD COLUMN is not idempotent.
-- The migrator wraps these in try/catch to ignore "duplicate column" errors.

-- Users
ALTER TABLE users ADD COLUMN metadata TEXT DEFAULT '{}';

-- Agents
ALTER TABLE agents ADD COLUMN system_prompt TEXT DEFAULT '';
ALTER TABLE agents ADD COLUMN model TEXT DEFAULT '';

-- Skills (batch 1)
ALTER TABLE skills ADD COLUMN confidence REAL DEFAULT 0.5;
ALTER TABLE skills ADD COLUMN auto_proposed INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN success_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN failure_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN evolved_from TEXT;
ALTER TABLE skills ADD COLUMN generation INTEGER DEFAULT 1;
ALTER TABLE skills ADD COLUMN bundle_id TEXT DEFAULT '';

-- Skills (batch 2)
ALTER TABLE skills ADD COLUMN trigger TEXT DEFAULT '';
ALTER TABLE skills ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE skills ADD COLUMN last_invoked TEXT;
ALTER TABLE skills ADD COLUMN invoke_count INTEGER DEFAULT 0;

-- Skill chains
ALTER TABLE skill_chains ADD COLUMN run_count INTEGER DEFAULT 0;
ALTER TABLE skill_chains ADD COLUMN success_count INTEGER DEFAULT 0;
ALTER TABLE skill_chains ADD COLUMN evolved_to_skill TEXT;
