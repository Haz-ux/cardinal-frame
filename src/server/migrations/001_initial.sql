-- Migration 001: Initial schema — all tables (matches server.mjs lines 118-567)
-- Admin user seeding is handled by server.mjs (bcrypt hashes computed at startup)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT DEFAULT '1.0',
  capabilities TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active',
  registered_at TEXT DEFAULT (datetime('now')),
  last_heartbeat TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  result TEXT,
  exit_code INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  user_id TEXT,
  assigned_agent_id TEXT
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  stream TEXT NOT NULL DEFAULT 'stdout',
  line TEXT NOT NULL,
  ts TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nodes TEXT DEFAULT '[]',
  edges TEXT DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  last_run_result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER,
  mime_type TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT,
  args TEXT DEFAULT '[]',
  url TEXT,
  status TEXT DEFAULT 'disconnected',
  connected_at TEXT,
  last_ping TEXT
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS agent_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_group_members (
  group_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (group_id, agent_id)
);

CREATE TABLE IF NOT EXISTS task_batches (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  task_ids TEXT DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  command TEXT NOT NULL,
  agent_id TEXT,
  enabled INTEGER DEFAULT 1,
  last_run TEXT,
  next_run TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT DEFAULT '1.0.0',
  entry_point TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  config TEXT DEFAULT '{}',
  hooks TEXT DEFAULT '[]',
  loaded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  user_id TEXT,
  details TEXT DEFAULT '{}',
  ts TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'openai',
  api_key TEXT,
  base_url TEXT,
  enabled INTEGER DEFAULT 1,
  detected_at TEXT,
  last_ping TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT,
  context_window INTEGER,
  capabilities TEXT DEFAULT '{}',
  is_default INTEGER DEFAULT 0,
  detected_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES llm_providers(id)
);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Chat',
  user_id TEXT NOT NULL,
  model TEXT,
  system_prompt TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT DEFAULT '[]',
  tool_calls TEXT DEFAULT '[]',
  tool_call_id TEXT,
  model TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  file_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT DEFAULT 'application/octet-stream',
  size INTEGER DEFAULT 0,
  storage_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  category TEXT DEFAULT 'general',
  handler TEXT NOT NULL,
  parameters TEXT DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  skill_id TEXT,
  endpoint TEXT,
  method TEXT DEFAULT 'POST',
  parameters TEXT DEFAULT '{}',
  requires_auth INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);

CREATE TABLE IF NOT EXISTS env_vars (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  encrypted INTEGER DEFAULT 0,
  category TEXT DEFAULT 'general',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  model TEXT NOT NULL,
  provider_id TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'inference' CHECK(category IN ('inference','planning','memory_lookup','compression','failover')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_watchers (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  recursive INTEGER DEFAULT 0,
  trigger_skill TEXT,
  enabled INTEGER DEFAULT 1,
  last_event TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learn_observations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  user_input TEXT NOT NULL,
  assistant_output TEXT,
  intent TEXT,
  entities TEXT DEFAULT '[]',
  skillProposed TEXT,
  confidence REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS learn_patterns (
  id TEXT PRIMARY KEY,
  pattern_key TEXT NOT NULL UNIQUE,
  pattern_type TEXT NOT NULL,
  description TEXT NOT NULL,
  occurrence_count INTEGER DEFAULT 1,
  last_seen TEXT DEFAULT (datetime('now')),
  confidence REAL DEFAULT 0.5,
  auto_skill_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_validations (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  test_input TEXT NOT NULL,
  expected_output TEXT,
  actual_output TEXT,
  passed INTEGER DEFAULT 0,
  exit_code INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  task TEXT NOT NULL,
  mode TEXT DEFAULT 'agent' CHECK(mode IN ('agent','suggest')),
  scope TEXT DEFAULT 'sandbox' CHECK(scope IN ('sandbox','home')),
  plan TEXT DEFAULT '[]',
  status TEXT DEFAULT 'planning' CHECK(status IN ('planning','executing','awaiting_approval','completed','failed','stopped','max_steps_reached')),
  current_step INTEGER DEFAULT 0,
  model TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  step_index INTEGER DEFAULT 0,
  action_type TEXT NOT NULL CHECK(action_type IN ('read','write','exec','plan','iterate','response')),
  target TEXT,
  content TEXT,
  result TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','approved','rejected')),
  approved_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT DEFAULT 'memory' CHECK(category IN ('user','project','memory','preference','fact','correction')),
  content TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  confidence REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  last_accessed TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_index (
  id TEXT PRIMARY KEY,
  session_type TEXT NOT NULL CHECK(session_type IN ('chat','agent')),
  ref_id TEXT NOT NULL,
  user_id TEXT,
  title TEXT,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comms_channels (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK(platform IN ('telegram','discord')),
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER DEFAULT 0,
  polling INTEGER DEFAULT 0,
  last_poll_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comms_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  remote_id TEXT,
  remote_username TEXT,
  content TEXT NOT NULL,
  raw TEXT,
  agent_session_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_chains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  last_run_result TEXT,
  last_run_at TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_chains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  last_run_result TEXT,
  last_run_at TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skill_evolution (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  chain_id TEXT,
  generation INTEGER DEFAULT 1,
  evolution_type TEXT DEFAULT 'manual' CHECK(evolution_type IN ('manual','auto-distill','chain-promotion','bundle-merge','skill-hub')),
  parent_skill_id TEXT,
  trigger TEXT DEFAULT '',
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  optimal INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (skill_id) REFERENCES skills(id),
  FOREIGN KEY (chain_id) REFERENCES skill_chains(id)
);

CREATE TABLE IF NOT EXISTS skill_hub_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT DEFAULT 'git' CHECK(type IN ('git','tarball','http')),
  verified INTEGER DEFAULT 0,
  trust_score REAL DEFAULT 0,
  scan_status TEXT DEFAULT 'pending' CHECK(scan_status IN ('pending','scanning','passed','blocked','failed')),
  scan_result TEXT,
  installed_skills TEXT DEFAULT '[]',
  last_scanned_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS heartbeat_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  condition TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('chain','skill','alert','webhook')),
  action_target TEXT NOT NULL,
  action_input TEXT DEFAULT '{}',
  cooldown_seconds INTEGER DEFAULT 300,
  last_fired_at TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chain_executions (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  success INTEGER NOT NULL,
  duration_ms INTEGER DEFAULT 0,
  input TEXT,
  output TEXT,
  step_count INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (chain_id) REFERENCES skill_chains(id)
);
