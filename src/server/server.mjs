#!/usr/bin/env node
import compression from 'compression';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import winston from 'winston';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import path from 'path';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, watch, watchFile } from 'fs';
import { pathToFileURL } from 'url';
import { spawn, exec } from 'child_process';
import { execSync } from 'child_process';
import os from 'os';
import pkg from 'cron-parser';
const { parseExpression: parseCronExpression } = pkg;
import { createServer } from 'http';
import { validateBody, schemas } from './validate.mjs';
import * as mcp from './mcp-client.mjs';
import * as embeddings from './embeddings.mjs';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';

// ─── Route Modules ────────────────────────────────────────────────
import authRoutes from './routes/auth.mjs';
import dashboardRoutes from './routes/dashboard.mjs';
import graphRoutes from './routes/graph.mjs';
import taskRoutes from './routes/tasks.mjs';
import metaRoutes from './routes/meta.mjs';
import { runSandboxed, runSandboxedHybrid } from './routes/sandbox.mjs';
import { PluginLoader } from './plugins.mjs';
import { executeSkillChain, executeToolChain, resolveStepInput, buildChainIntentPrompt } from './chains.mjs';
import { buildDistillPrompt, buildEvolutionPrompt, scanSkillHandler, shouldEvolveChain } from './evolution.mjs';
import { HeartbeatDaemon } from './heartbeat.mjs';
import { runMigrations } from './migrator.mjs';

dotenv.config();

const app = express();
app.set('etag', false); // Disable ETags — prevents 304 stale cache on auth routes
const PORT = process.env.PORT || 8080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data'));
const JWT_SECRET = process.env.JWT_SECRET || 'cardinal-frame-dev-secret-change-me';
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'cardinal-frame-dev-secret-change-me') {
  console.error('FATAL: JWT_SECRET must be set in production. Set the JWT_SECRET env var.');
  process.exit(1);
}
const JWT_EXPIRES = process.env.JWT_EXPIRES || '24h';

// ─── Logger ────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});
app.use(morgan('tiny', { skip: (req) => process.env.NODE_ENV === 'production' || req.url.startsWith('/ws') }));

// ─── CORS Whitelist ────────────────────────────────────────────────
const corsOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(s => s.trim()) : []),
];
app.use(cors({
  origin(origin, cb) {
    if (!origin || corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));

// ─── Security headers ──────────────────────────────────────────
app.disable('x-powered-by'); // Don't leak Express
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── Process-level error handlers (prevent crashes) ──────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err.message);
});

// ─── Request ID Tracking ─────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.id);
  next();
});

// ─── Rate Limiting (tiered) ─────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many auth attempts. Try again in 1 minute.' }, skip: () => process.env.NODE_ENV === 'test' });
const readLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many read requests, slow down' }, skip: () => process.env.NODE_ENV === 'test' });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many write requests, slow down' }, skip: () => process.env.NODE_ENV === 'test' });
const sandboxLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Sandbox rate limit reached. Max 10 executions per minute.' }, skip: () => process.env.NODE_ENV === 'test' });
// Legacy alias — maps to writeLimiter for backward compat on existing routes
const apiLimiter = writeLimiter;
app.set('trust proxy', 1);

// ─── SQLite Database ───────────────────────────────────────────────
import { mkdirSync } from 'fs';
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cardinal.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Run migrations (version-tracked SQL files) ────────────────────
runMigrations(db);

// Schema with task_logs, task_assignments, and RBAC
const adminHash = bcrypt.hashSync('admin123', 10);
const hazHash = bcrypt.hashSync('cardinal', 10);
db.exec(`
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
  CREATE INDEX IF NOT EXISTS idx_chain_exec_chain_id ON chain_executions(chain_id);

  INSERT OR IGNORE INTO users (id, username, password_hash, role)
  VALUES ('admin-000', 'admin', '${adminHash}', 'admin');

  INSERT OR IGNORE INTO users (id, username, password_hash, role)
  VALUES ('haz-001', 'Haz', '${hazHash}', 'admin');
  `);

  // ─── Schema Migrations (add columns to existing DBs) ──────────
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('metadata')) db.exec('ALTER TABLE users ADD COLUMN metadata TEXT DEFAULT \'{}\'');
  const agentCols = db.prepare("PRAGMA table_info(agents)").all().map(c => c.name);
  if (!agentCols.includes('system_prompt')) db.exec('ALTER TABLE agents ADD COLUMN system_prompt TEXT DEFAULT \'\'');
  if (!agentCols.includes('model')) db.exec('ALTER TABLE agents ADD COLUMN model TEXT DEFAULT \'\'');

  // ─── Skills confidence + auto_proposed migrations ────────────────
  const skillCols = db.prepare("PRAGMA table_info(skills)").all().map(c => c.name);
  if (!skillCols.includes('confidence')) db.exec('ALTER TABLE skills ADD COLUMN confidence REAL DEFAULT 0.5');
  if (!skillCols.includes('auto_proposed')) db.exec('ALTER TABLE skills ADD COLUMN auto_proposed INTEGER DEFAULT 0');
  if (!skillCols.includes('success_count')) db.exec('ALTER TABLE skills ADD COLUMN success_count INTEGER DEFAULT 0');
  if (!skillCols.includes('failure_count')) db.exec('ALTER TABLE skills ADD COLUMN failure_count INTEGER DEFAULT 0');
  if (!skillCols.includes('evolved_from')) db.exec("ALTER TABLE skills ADD COLUMN evolved_from TEXT");
  if (!skillCols.includes('generation')) db.exec("ALTER TABLE skills ADD COLUMN generation INTEGER DEFAULT 1");
  if (!skillCols.includes('bundle_id')) db.exec("ALTER TABLE skills ADD COLUMN bundle_id TEXT DEFAULT ''");
  // Chain run count migration
  const skillChainCols = db.prepare("PRAGMA table_info(skill_chains)").all().map(c => c.name);
  if (!skillChainCols.includes('run_count')) db.exec("ALTER TABLE skill_chains ADD COLUMN run_count INTEGER DEFAULT 0");
  if (!skillChainCols.includes('success_count')) db.exec("ALTER TABLE skill_chains ADD COLUMN success_count INTEGER DEFAULT 0");
  if (!skillChainCols.includes('evolved_to_skill')) db.exec("ALTER TABLE skill_chains ADD COLUMN evolved_to_skill TEXT");

  // ─── Agent sessions: update status CHECK constraint (rebuild table) ──
  try {
    const sessionStatuses = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_sessions'").get();
    if (sessionStatuses && sessionStatuses.sql.includes("'planning','executing','awaiting_approval','completed','failed'")) {
      // Need to rebuild with new constraint
      db.exec(`CREATE TABLE IF NOT EXISTS agent_sessions_new (
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
      )`);
      db.exec(`INSERT INTO agent_sessions_new SELECT * FROM agent_sessions`);
      db.exec(`DROP TABLE agent_sessions`);
      db.exec(`ALTER TABLE agent_sessions_new RENAME TO agent_sessions`);
      logger.info('Migrated agent_sessions: added stopped/max_steps_reached to status CHECK');
    }
  } catch (e) { /* table doesn't exist yet or already migrated */ }

  // ─── FTS5 full-text search indexes ──────────────────────────────
  try {
    const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get();
    if (!ftsExists) {
      db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid')`);
      db.exec(`CREATE VIRTUAL TABLE session_index_fts USING fts5(content, title, content='session_index', content_rowid='rowid')`);
      logger.info('Created FTS5 indexes for memories and session search');
    }
  } catch (e) { logger.warn('FTS5 setup:', e.message); }

  // ─── Skills table: add trigger + version columns ─────────────────
  try {
    const skillCols2 = db.prepare("PRAGMA table_info(skills)").all().map(c => c.name);
    if (!skillCols2.includes('trigger')) db.exec("ALTER TABLE skills ADD COLUMN trigger TEXT DEFAULT ''");
    if (!skillCols2.includes('version')) db.exec("ALTER TABLE skills ADD COLUMN version INTEGER DEFAULT 1");
    if (!skillCols2.includes('last_invoked')) db.exec("ALTER TABLE skills ADD COLUMN last_invoked TEXT");
    if (!skillCols2.includes('invoke_count')) db.exec("ALTER TABLE skills ADD COLUMN invoke_count INTEGER DEFAULT 0");
  } catch (e) { logger.warn('Skills migration:', e.message); }

  // ─── Prepared Statements ───────────────────────────────────────────
const stmts = {
  agents: {
    insert: db.prepare('INSERT INTO agents (id, name, version, capabilities, status) VALUES (?, ?, ?, ?, ?)'),
    getAll: db.prepare('SELECT id, name, status, capabilities FROM agents'),
    getById: db.prepare('SELECT * FROM agents WHERE id = ?'),
    updateHeartbeat: db.prepare("UPDATE agents SET last_heartbeat = datetime('now'), status = 'active' WHERE id = ?"),
    updateStatus: db.prepare('UPDATE agents SET status = ? WHERE id = ?'),
    delete: db.prepare('DELETE FROM agents WHERE id = ?'),
    getAllWithHeartbeat: db.prepare('SELECT id, name, status, capabilities, last_heartbeat, registered_at FROM agents'),
  },
  tasks: {
    insert: db.prepare('INSERT INTO tasks (id, name, command, status, user_id, assigned_agent_id) VALUES (?, ?, ?, ?, ?, ?)'),
    getAll: db.prepare('SELECT id, name, status, created_at, started_at, finished_at, exit_code, assigned_agent_id FROM tasks'),
    getById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    updateStatus: db.prepare('UPDATE tasks SET status = ?, started_at = ?, finished_at = ?, result = ?, exit_code = ? WHERE id = ?'),
    assignAgent: db.prepare('UPDATE tasks SET assigned_agent_id = ? WHERE id = ?'),
    getPending: db.prepare("SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at ASC"),
    delete: db.prepare('DELETE FROM tasks WHERE id = ?'),
  },
  logs: {
    insert: db.prepare('INSERT INTO task_logs (task_id, stream, line) VALUES (?, ?, ?)'),
    getByTask: db.prepare('SELECT stream, line, ts FROM task_logs WHERE task_id = ? ORDER BY id ASC'),
    deleteByTask: db.prepare('DELETE FROM task_logs WHERE task_id = ?'),
  },
  dags: {
    insert: db.prepare('INSERT INTO dags (id, name, nodes, edges, status, user_id) VALUES (?, ?, ?, ?, ?, ?)'),
    getAll: db.prepare('SELECT id, name, status, nodes, edges, created_at, updated_at FROM dags'),
    getById: db.prepare('SELECT * FROM dags WHERE id = ?'),
    update: db.prepare("UPDATE dags SET name = ?, nodes = ?, edges = ?, status = ?, updated_at = datetime('now'), last_run_result = ? WHERE id = ?"),
    delete: db.prepare('DELETE FROM dags WHERE id = ?'),
  },
  users: {
  insert: db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)'),
  getByUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  getById: db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?'),
  getAll: db.prepare('SELECT id, username, role, created_at FROM users'),
  updateRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  },
  files: {
     insert: db.prepare('INSERT INTO files (id, filename, original_name, size, mime_type, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'),
     getAll: db.prepare('SELECT id, original_name, size, mime_type, uploaded_by, uploaded_at FROM files ORDER BY uploaded_at DESC'),
     getById: db.prepare('SELECT * FROM files WHERE id = ?'),
     delete: db.prepare('DELETE FROM files WHERE id = ?'),
   },
   mcp: {
   insert: db.prepare('INSERT INTO mcp_servers (id, name, transport, command, args, url, status) VALUES (?, ?, ?, ?, ?, ?, ?)'),
   getAll: db.prepare('SELECT * FROM mcp_servers'),
   getById: db.prepare('SELECT * FROM mcp_servers WHERE id = ?'),
   updateStatus: db.prepare('UPDATE mcp_servers SET status = ?, connected_at = ?, last_ping = ? WHERE id = ?'),
   delete: db.prepare('DELETE FROM mcp_servers WHERE id = ?'),
   },
   deps: {
      insert: db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)'),
      getByTask: db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?'),
      getDependents: db.prepare('SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?'),
      deleteByTask: db.prepare('DELETE FROM task_dependencies WHERE task_id = ?'),
      getAll: db.prepare('SELECT * FROM task_dependencies'),
    },
    groups: {
      insert: db.prepare('INSERT INTO agent_groups (id, name, description, created_by) VALUES (?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM agent_groups ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM agent_groups WHERE id = ?'),
      delete: db.prepare('DELETE FROM agent_groups WHERE id = ?'),
    },
    groupMembers: {
      add: db.prepare('INSERT INTO agent_group_members (group_id, agent_id) VALUES (?, ?)'),
      remove: db.prepare('DELETE FROM agent_group_members WHERE group_id = ? AND agent_id = ?'),
      getByGroup: db.prepare('SELECT agent_id FROM agent_group_members WHERE group_id = ?'),
      deleteByGroup: db.prepare('DELETE FROM agent_group_members WHERE group_id = ?'),
    },
    batches: {
      insert: db.prepare('INSERT INTO task_batches (id, group_id, task_ids, status) VALUES (?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM task_batches ORDER BY created_at DESC'),
      getByGroup: db.prepare('SELECT * FROM task_batches WHERE group_id = ? ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM task_batches WHERE id = ?'),
      updateStatus: db.prepare('UPDATE task_batches SET status = ? WHERE id = ?'),
      },
      schedules: {
      insert: db.prepare('INSERT INTO schedules (id, name, cron_expr, command, agent_id, enabled, next_run, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM schedules ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM schedules WHERE id = ?'),
      updateEnabled: db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?'),
      updateLastRun: db.prepare("UPDATE schedules SET last_run = datetime('now'), next_run = ? WHERE id = ?"),
      delete: db.prepare('DELETE FROM schedules WHERE id = ?'),
      },
      plugins: {
      insert: db.prepare('INSERT INTO plugins (id, name, version, entry_point, enabled, config, hooks) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM plugins ORDER BY loaded_at DESC'),
      getById: db.prepare('SELECT * FROM plugins WHERE id = ?'),
      updateEnabled: db.prepare('UPDATE plugins SET enabled = ? WHERE id = ?'),
      delete: db.prepare('DELETE FROM plugins WHERE id = ?'),
      },
      audit: {
      insert: db.prepare('INSERT INTO audit_log (action, resource_type, resource_id, user_id, details) VALUES (?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200'),
      getByResource: db.prepare('SELECT * FROM audit_log WHERE resource_type = ? AND resource_id = ? ORDER BY id DESC LIMIT 50'),
      getByUser: db.prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 50'),
      },
      providers: {
      insert: db.prepare('INSERT INTO llm_providers (id, name, type, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT id, name, type, base_url, enabled, detected_at, last_ping, created_at FROM llm_providers ORDER BY created_at DESC'),
      getById: db.prepare('SELECT * FROM llm_providers WHERE id = ?'),
      getByName: db.prepare('SELECT * FROM llm_providers WHERE name = ?'),
      updateApiKey: db.prepare('UPDATE llm_providers SET api_key = ? WHERE id = ?'),
      updateEnabled: db.prepare('UPDATE llm_providers SET enabled = ? WHERE id = ?'),
      updatePing: db.prepare("UPDATE llm_providers SET last_ping = datetime('now'), detected_at = datetime('now') WHERE id = ?"),
      delete: db.prepare('DELETE FROM llm_providers WHERE id = ?'),
      },
      models: {
      insert: db.prepare('INSERT OR REPLACE INTO llm_models (id, provider_id, model_id, display_name, context_window, capabilities, is_default, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM llm_models ORDER BY provider_id, model_id'),
      getByProvider: db.prepare('SELECT * FROM llm_models WHERE provider_id = ? ORDER BY model_id'),
      getDefault: db.prepare('SELECT * FROM llm_models WHERE is_default = 1 LIMIT 1'),
      setDefault: db.prepare('UPDATE llm_models SET is_default = 1 WHERE id = ?'),
 clearDefault: db.prepare('UPDATE llm_models SET is_default = 0'),
      deleteByProvider: db.prepare('DELETE FROM llm_models WHERE provider_id = ?'),
      delete: db.prepare('DELETE FROM llm_models WHERE id = ?'),
      },
      conversations: {
      insert: db.prepare('INSERT INTO chat_conversations (id, title, user_id, model, system_prompt) VALUES (?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM chat_conversations WHERE user_id = ? ORDER BY updated_at DESC'),
      getById: db.prepare('SELECT * FROM chat_conversations WHERE id = ?'),
      update: db.prepare("UPDATE chat_conversations SET title = ?, model = ?, system_prompt = ?, updated_at = datetime('now') WHERE id = ?"),
      delete: db.prepare('DELETE FROM chat_conversations WHERE id = ?'),
      },
      messages: {
      insert: db.prepare('INSERT INTO chat_messages (id, conversation_id, role, content, attachments, tool_calls, tool_call_id, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      getByConversation: db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC'),
      deleteByConversation: db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?'),
      },
      attachments: {
      insert: db.prepare('INSERT INTO chat_attachments (id, message_id, file_id, filename, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      getByMessage: db.prepare('SELECT * FROM chat_attachments WHERE message_id = ?'),
      getByConversation: db.prepare('SELECT a.* FROM chat_attachments a JOIN chat_messages m ON a.message_id = m.id WHERE m.conversation_id = ?'),
      },
      skills: {
      insert: db.prepare('INSERT INTO skills (id, name, description, category, handler, parameters, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      insertWithTrigger: db.prepare('INSERT INTO skills (id, name, description, category, handler, parameters, enabled, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM skills ORDER BY category, name'),
      getById: db.prepare('SELECT * FROM skills WHERE id = ?'),
      getByName: db.prepare('SELECT * FROM skills WHERE name = ?'),
      getEnabled: db.prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY category, name'),
      update: db.prepare('UPDATE skills SET description = ?, category = ?, parameters = ?, enabled = ? WHERE id = ?'),
      delete: db.prepare('DELETE FROM skills WHERE id = ?'),
      updateConfidence: db.prepare('UPDATE skills SET confidence = ?, success_count = ?, failure_count = ? WHERE id = ?'),
      getAutoProposed: db.prepare('SELECT * FROM skills WHERE auto_proposed = 1 ORDER BY confidence DESC'),
      insertWithConfidence: db.prepare('INSERT INTO skills (id, name, description, category, handler, parameters, enabled, confidence, auto_proposed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      getAllWithTrigger: db.prepare("SELECT * FROM skills WHERE enabled = 1 AND trigger != '' ORDER BY confidence DESC"),
      updateInvoke: db.prepare("UPDATE skills SET invoke_count = invoke_count + 1, last_invoked = datetime('now') WHERE id = ?"),
      insertFull: db.prepare('INSERT INTO skills (id, name, description, category, handler, parameters, enabled, confidence, auto_proposed, trigger, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      },
      tools: {
      insert: db.prepare('INSERT INTO tools (id, name, description, skill_id, endpoint, method, parameters, requires_auth, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      getAll: db.prepare('SELECT * FROM tools ORDER BY name'),
      getById: db.prepare('SELECT * FROM tools WHERE id = ?'),
      getByName: db.prepare('SELECT * FROM tools WHERE name = ?'),
      getEnabled: db.prepare('SELECT * FROM tools WHERE enabled = 1 ORDER BY name'),
      getBySkill: db.prepare('SELECT * FROM tools WHERE skill_id = ?'),
      delete: db.prepare('DELETE FROM tools WHERE id = ?'),
      },
      envVars: {
      getAll: db.prepare('SELECT key, value, encrypted, category, created_at, updated_at FROM env_vars ORDER BY category, key'),
      getByKey: db.prepare('SELECT * FROM env_vars WHERE key = ?'),
      upsert: db.prepare(`INSERT INTO env_vars (key, value, encrypted, category, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, category = excluded.category, updated_at = datetime('now')`),
      delete: db.prepare('DELETE FROM env_vars WHERE key = ?'),
      },
      tokenUsage: {
       insert: db.prepare('INSERT INTO token_usage (conversation_id, model, provider_id, prompt_tokens, completion_tokens, cost_usd, category) VALUES (?, ?, ?, ?, ?, ?, ?)'),
       getByConv: db.prepare('SELECT * FROM token_usage WHERE conversation_id = ? ORDER BY created_at DESC'),
       getSummary: db.prepare("SELECT category, SUM(prompt_tokens) as total_prompt, SUM(completion_tokens) as total_completion, SUM(cost_usd) as total_cost, COUNT(*) as count FROM token_usage WHERE created_at > datetime('now', ?) GROUP BY category"),
       getRecent: db.prepare("SELECT * FROM token_usage ORDER BY created_at DESC LIMIT 50"),
      },
      fileWatchers: {
       insert: db.prepare('INSERT INTO file_watchers (id, path, recursive, trigger_skill, enabled) VALUES (?, ?, ?, ?, ?)'),
       getAll: db.prepare('SELECT * FROM file_watchers ORDER BY created_at DESC'),
       getById: db.prepare('SELECT * FROM file_watchers WHERE id = ?'),
       updateEnabled: db.prepare('UPDATE file_watchers SET enabled = ?, last_event = ? WHERE id = ?'),
       delete: db.prepare('DELETE FROM file_watchers WHERE id = ?'),
      },
      // ─── Aimi Self-Learning Tables ──────────────────────────────
      observations: {
        insert: db.prepare('INSERT INTO learn_observations (id, conversation_id, user_input, assistant_output, intent, entities, skillProposed, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        getRecent: db.prepare('SELECT * FROM learn_observations ORDER BY created_at DESC LIMIT ?'),
        getById: db.prepare('SELECT * FROM learn_observations WHERE id = ?'),
        getByConversation: db.prepare('SELECT * FROM learn_observations WHERE conversation_id = ? ORDER BY created_at DESC'),
        getSince: db.prepare('SELECT * FROM learn_observations WHERE created_at >= ? ORDER BY created_at DESC'),
        count: db.prepare('SELECT COUNT(*) as count FROM learn_observations'),
      },
      patterns: {
        insert: db.prepare('INSERT INTO learn_patterns (id, pattern_key, pattern_type, description, occurrence_count, confidence) VALUES (?, ?, ?, ?, 1, ?)'),
        getByKey: db.prepare('SELECT * FROM learn_patterns WHERE pattern_key = ?'),
        getAll: db.prepare('SELECT * FROM learn_patterns ORDER BY occurrence_count DESC, confidence DESC'),
        increment: db.prepare('UPDATE learn_patterns SET occurrence_count = occurrence_count + 1, last_seen = datetime(\'now\'), confidence = ? WHERE id = ?'),
        updateConfidence: db.prepare('UPDATE learn_patterns SET confidence = ?, auto_skill_id = ? WHERE id = ?'),
        delete: db.prepare('DELETE FROM learn_patterns WHERE id = ?'),
      },
      validations: {
        insert: db.prepare('INSERT INTO skill_validations (id, skill_id, test_input, expected_output, actual_output, passed, exit_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        getBySkill: db.prepare('SELECT * FROM skill_validations WHERE skill_id = ? ORDER BY created_at DESC'),
        getPassRate: db.prepare('SELECT SUM(passed) as passed, COUNT(*) as total FROM skill_validations WHERE skill_id = ?'),
      },
      // ─── Agent Session Tables ───────────────────────────────────
      agentSessions: {
        insert: db.prepare('INSERT INTO agent_sessions (id, user_id, conversation_id, task, mode, scope, plan, status, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
        getById: db.prepare('SELECT * FROM agent_sessions WHERE id = ?'),
        getByUser: db.prepare('SELECT * FROM agent_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
        getActive: db.prepare("SELECT * FROM agent_sessions WHERE user_id = ? AND status IN ('planning','executing','awaiting_approval') ORDER BY created_at DESC"),
        updateStatus: db.prepare("UPDATE agent_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?"),
        updatePlan: db.prepare("UPDATE agent_sessions SET plan = ?, updated_at = datetime('now') WHERE id = ?"),
        updateStep: db.prepare("UPDATE agent_sessions SET current_step = ?, updated_at = datetime('now') WHERE id = ?"),
        updateMode: db.prepare("UPDATE agent_sessions SET mode = ?, updated_at = datetime('now') WHERE id = ?"),
        delete: db.prepare('DELETE FROM agent_sessions WHERE id = ?'),
      },
      agentActions: {
        insert: db.prepare('INSERT INTO agent_actions (id, session_id, step_index, action_type, target, content, result, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        getBySession: db.prepare('SELECT * FROM agent_actions WHERE session_id = ? ORDER BY step_index ASC, created_at ASC'),
        updateResult: db.prepare('UPDATE agent_actions SET result = ?, status = ? WHERE id = ?'),
        updateStatus: db.prepare('UPDATE agent_actions SET status = ?, approved_by = ? WHERE id = ?'),
        getPending: db.prepare("SELECT * FROM agent_actions WHERE session_id = ? AND status = 'pending' ORDER BY step_index ASC LIMIT 1"),
      },
      // ─── Memory Tables ───────────────────────────────────────────
      memories: {
        insert: db.prepare('INSERT INTO memories (id, user_id, category, content, source, confidence) VALUES (?, ?, ?, ?, ?, ?)'),
        getById: db.prepare('SELECT * FROM memories WHERE id = ?'),
        getByUser: db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC'),
        getByCategory: db.prepare('SELECT * FROM memories WHERE user_id = ? AND category = ? ORDER BY updated_at DESC'),
        update: db.prepare("UPDATE memories SET content = ?, category = ?, updated_at = datetime('now') WHERE id = ?"),
        updateAccess: db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed = datetime('now') WHERE id = ?"),
        delete: db.prepare('DELETE FROM memories WHERE id = ?'),
        search: db.prepare(`SELECT m.* FROM memories m JOIN memories_fts f ON m.rowid = f.rowid WHERE memories_fts MATCH ? AND m.user_id = ? ORDER BY rank LIMIT ?`),
        count: db.prepare('SELECT COUNT(*) as count FROM memories WHERE user_id = ?'),
      },
      sessionIndex: {
        insert: db.prepare('INSERT INTO session_index (id, session_type, ref_id, user_id, title, content) VALUES (?, ?, ?, ?, ?, ?)'),
        getByRef: db.prepare('SELECT * FROM session_index WHERE ref_id = ? AND session_type = ?'),
        search: db.prepare(`SELECT s.* FROM session_index s JOIN session_index_fts f ON s.rowid = f.rowid WHERE session_index_fts MATCH ? ORDER BY rank LIMIT ?`),
        getUserSearch: db.prepare(`SELECT s.* FROM session_index s JOIN session_index_fts f ON s.rowid = f.rowid WHERE session_index_fts MATCH ? AND s.user_id = ? ORDER BY rank LIMIT ?`),
        deleteByRef: db.prepare('DELETE FROM session_index WHERE ref_id = ? AND session_type = ?'),
      },
      commsChannels: {
        getAll: db.prepare('SELECT * FROM comms_channels ORDER BY created_at DESC'),
        getById: db.prepare('SELECT * FROM comms_channels WHERE id = ?'),
        getByPlatform: db.prepare('SELECT * FROM comms_channels WHERE platform = ? AND enabled = 1'),
        getEnabled: db.prepare('SELECT * FROM comms_channels WHERE enabled = 1'),
        insert: db.prepare(`INSERT INTO comms_channels (id, platform, name, config, enabled) VALUES (?, ?, ?, ?, ?)`),
        update: db.prepare(`UPDATE comms_channels SET name = ?, config = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`),
        updatePolling: db.prepare(`UPDATE comms_channels SET polling = ?, last_poll_at = ? WHERE id = ?`),
        delete: db.prepare('DELETE FROM comms_channels WHERE id = ?'),
      },
      commsMessages: {
        getAll: db.prepare('SELECT * FROM comms_messages ORDER BY created_at DESC LIMIT ?'),
        getByChannel: db.prepare('SELECT * FROM comms_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?'),
        getById: db.prepare('SELECT * FROM comms_messages WHERE id = ?'),
        insert: db.prepare(`INSERT INTO comms_messages (id, channel_id, platform, direction, remote_id, remote_username, content, raw, agent_session_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        updateStatus: db.prepare('UPDATE comms_messages SET status = ? WHERE id = ?'),
        updateAgentSession: db.prepare('UPDATE comms_messages SET agent_session_id = ? WHERE id = ?'),
        getPending: db.prepare(`SELECT * FROM comms_messages WHERE status = 'pending' AND direction = 'inbound' ORDER BY created_at ASC`),
      },
      // ─── Dashboard & Graph hot-path queries ─────────────────────
      dashboard: {
        agentCount: db.prepare('SELECT COUNT(*) as c FROM agents'),
        taskCount: db.prepare('SELECT COUNT(*) as c FROM tasks'),
        runningTasks: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'running'"),
        pendingTasks: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'pending'"),
        dagCount: db.prepare('SELECT COUNT(*) as c FROM dags'),
        realUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE username NOT LIKE 'boot_%' AND username NOT LIKE 'noboot_%' AND username NOT LIKE 'token_%' AND username NOT LIKE 'pw_%' AND username NOT LIKE 'chat_%' AND username NOT LIKE 'upload_%' AND username NOT LIKE 'uichat_%' AND username NOT LIKE 'uiskill_%' AND username NOT LIKE 'e2e_%' AND username NOT LIKE 'debug%' AND username NOT LIKE 'test%' AND username NOT LIKE 'auth%'"),
        providerCount: db.prepare('SELECT COUNT(*) as c FROM llm_providers'),
        modelCount: db.prepare('SELECT COUNT(*) as c FROM llm_models'),
        tokenUsage: db.prepare(`SELECT COALESCE(SUM(prompt_tokens),0) as pt, COALESCE(SUM(completion_tokens),0) as ct FROM token_usage`),
      },
      graph: {
        modelCountByProvider: db.prepare('SELECT COUNT(*) as c FROM llm_models WHERE provider_id = ?'),
        modelProvider: db.prepare('SELECT provider_id FROM llm_models WHERE model_id = ? OR display_name = ?'),
        agentGroups: db.prepare('SELECT id, name FROM agent_groups'),
        groupMembers: db.prepare('SELECT agent_id FROM agent_group_members WHERE group_id = ?'),
        recentTasks: db.prepare('SELECT id, name, status, assigned_agent_id FROM tasks ORDER BY created_at DESC LIMIT 60'),
        allDeps: db.prepare('SELECT task_id, depends_on_task_id FROM task_dependencies'),
        schedules: db.prepare('SELECT id, name, agent_id, enabled, cron_expr FROM schedules'),
        skillUseCount: (() => { try { return db.prepare('SELECT COUNT(*) as c FROM skill_executions WHERE skill_id = ?'); } catch { return null; } })(),
        pluginsByHook: db.prepare('SELECT id, name, enabled FROM plugins WHERE hooks LIKE ?'),
        allTools: db.prepare('SELECT id, name, skill_id, endpoint, enabled FROM tools'),
        mcpServers: db.prepare('SELECT id, name, status, transport FROM mcp_servers'),
        allPlugins: db.prepare('SELECT id, name, version, enabled FROM plugins'),
        allDags: db.prepare('SELECT id, name, status FROM dags'),
        fileWatchers: db.prepare('SELECT id, path, enabled, last_event FROM file_watchers'),
        envVars: db.prepare('SELECT key, category, encrypted FROM env_vars'),
        recentConvs: db.prepare('SELECT id, title, user_id, model FROM chat_conversations ORDER BY updated_at DESC LIMIT 40'),
        convMsgCount: db.prepare('SELECT COUNT(*) as c FROM chat_messages WHERE conversation_id = ?'),
        dbFiles: db.prepare('SELECT id, original_name, mime_type, uploaded_by FROM files'),
      },
      // ─── Chain Tables ───────────────────────────────────────────
      skillChains: {
        insert: db.prepare('INSERT INTO skill_chains (id, name, description, steps, status, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
        getAll: db.prepare('SELECT id, name, description, status, created_at, updated_at, last_run_at FROM skill_chains ORDER BY created_at DESC'),
        getById: db.prepare('SELECT * FROM skill_chains WHERE id = ?'),
        getByName: db.prepare('SELECT * FROM skill_chains WHERE name = ?'),
        update: db.prepare("UPDATE skill_chains SET name = ?, description = ?, steps = ?, status = ?, updated_at = datetime('now') WHERE id = ?"),
        updateRunResult: db.prepare("UPDATE skill_chains SET last_run_result = ?, last_run_at = datetime('now'), status = ? WHERE id = ?"),
        delete: db.prepare('DELETE FROM skill_chains WHERE id = ?'),
      },
      toolChains: {
        insert: db.prepare('INSERT INTO tool_chains (id, name, description, steps, status, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
        getAll: db.prepare('SELECT id, name, description, status, created_at, updated_at, last_run_at FROM tool_chains ORDER BY created_at DESC'),
        getById: db.prepare('SELECT * FROM tool_chains WHERE id = ?'),
        getByName: db.prepare('SELECT * FROM tool_chains WHERE name = ?'),
        update: db.prepare("UPDATE tool_chains SET name = ?, description = ?, steps = ?, status = ?, updated_at = datetime('now') WHERE id = ?"),
        updateRunResult: db.prepare("UPDATE tool_chains SET last_run_result = ?, last_run_at = datetime('now'), status = ? WHERE id = ?"),
        delete: db.prepare('DELETE FROM tool_chains WHERE id = ?'),
      },
      // ─── Evolution & Hub Tables ────────────────────────────────
      evolution: {
        insert: db.prepare('INSERT INTO skill_evolution (id, skill_id, chain_id, generation, evolution_type, parent_skill_id, trigger, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        getBySkill: db.prepare('SELECT * FROM skill_evolution WHERE skill_id = ? ORDER BY generation DESC'),
        getByChain: db.prepare('SELECT * FROM skill_evolution WHERE chain_id = ? ORDER BY created_at DESC'),
        getAll: db.prepare('SELECT e.*, s.name as skill_name FROM skill_evolution e LEFT JOIN skills s ON e.skill_id = s.id ORDER BY e.created_at DESC'),
        getOptimal: db.prepare("SELECT * FROM skill_evolution WHERE optimal = 1"),
        markOptimal: db.prepare('UPDATE skill_evolution SET optimal = 1 WHERE id = ?'),
        updateStats: db.prepare('UPDATE skill_evolution SET success_count = ?, failure_count = ? WHERE id = ?'),
        delete: db.prepare('DELETE FROM skill_evolution WHERE id = ?'),
      },
      skillHub: {
        insert: db.prepare('INSERT INTO skill_hub_sources (id, name, url, type, verified, trust_score, scan_status) VALUES (?, ?, ?, ?, ?, ?, ?)'),
        getAll: db.prepare('SELECT * FROM skill_hub_sources ORDER BY created_at DESC'),
        getById: db.prepare('SELECT * FROM skill_hub_sources WHERE id = ?'),
        updateScan: db.prepare("UPDATE skill_hub_sources SET scan_status = ?, scan_result = ?, last_scanned_at = datetime('now'), trust_score = ? WHERE id = ?"),
        updateInstalled: db.prepare("UPDATE skill_hub_sources SET installed_skills = ? WHERE id = ?"),
        delete: db.prepare('DELETE FROM skill_hub_sources WHERE id = ?'),
      },
      heartbeat: {
        insert: db.prepare('INSERT INTO heartbeat_rules (id, name, description, condition, action_type, action_target, action_input, cooldown_seconds, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'),
        getAll: db.prepare('SELECT * FROM heartbeat_rules ORDER BY created_at DESC'),
        getEnabled: db.prepare('SELECT * FROM heartbeat_rules WHERE enabled = 1'),
        getById: db.prepare('SELECT * FROM heartbeat_rules WHERE id = ?'),
        updateLastFired: db.prepare("UPDATE heartbeat_rules SET last_fired_at = datetime('now') WHERE id = ?"),
        updateEnabled: db.prepare('UPDATE heartbeat_rules SET enabled = ? WHERE id = ?'),
        delete: db.prepare('DELETE FROM heartbeat_rules WHERE id = ?'),
      },
      chainExecutions: {
        insert: db.prepare('INSERT INTO chain_executions (id, chain_id, success, duration_ms, input, output, step_count, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        getByChain: db.prepare('SELECT id, success, duration_ms, step_count, error, created_at FROM chain_executions WHERE chain_id = ? ORDER BY created_at DESC LIMIT ?'),
        getRecentByChain: db.prepare('SELECT id, success, duration_ms, step_count, error, created_at FROM chain_executions WHERE chain_id = ? ORDER BY created_at DESC LIMIT 10'),
      },
      };

// ─── Database Indexes ──────────────────────────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id);
  CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_deps_task_id ON task_dependencies(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_task_id);
  CREATE INDEX IF NOT EXISTS idx_task_batches_group_id ON task_batches(group_id);
  CREATE INDEX IF NOT EXISTS idx_agent_group_members_group ON agent_group_members(group_id);
  CREATE INDEX IF NOT EXISTS idx_agent_group_members_agent ON agent_group_members(agent_id);
  CREATE INDEX IF NOT EXISTS idx_llm_models_provider_id ON llm_models(provider_id);
  CREATE INDEX IF NOT EXISTS idx_llm_providers_enabled ON llm_providers(enabled);
  CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_id ON chat_conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_chat_attachments_message_id ON chat_attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_tools_skill_id ON tools(skill_id);
  CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
  CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
  CREATE INDEX IF NOT EXISTS idx_skill_validations_skill_id ON skill_validations(skill_id);
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_user_id ON agent_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);
  CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation_id ON agent_sessions(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_actions_session_id ON agent_actions(session_id);
  CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions(status);
  CREATE INDEX IF NOT EXISTS idx_token_usage_conversation_id ON token_usage(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_token_usage_provider_id ON token_usage(provider_id);
  CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_session_index_user_id ON session_index(user_id);
  CREATE INDEX IF NOT EXISTS idx_session_index_ref_id ON session_index(ref_id);
  CREATE INDEX IF NOT EXISTS idx_comms_messages_channel_id ON comms_messages(channel_id);
  CREATE INDEX IF NOT EXISTS idx_comms_messages_status ON comms_messages(status);
  CREATE INDEX IF NOT EXISTS idx_comms_channels_platform ON comms_channels(platform);
  CREATE INDEX IF NOT EXISTS idx_files_uploaded_by ON files(uploaded_by);
  CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
  CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins(enabled);
  CREATE INDEX IF NOT EXISTS idx_file_watchers_enabled ON file_watchers(enabled);
  CREATE INDEX IF NOT EXISTS idx_env_vars_category ON env_vars(category);
  CREATE INDEX IF NOT EXISTS idx_learn_observations_conversation_id ON learn_observations(conversation_id);
`);

// ─── WebSocket Setup ───────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: (info) => {
  const origin = info.req.headers.origin;
  if (origin && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
    logger.warn(`WS rejected origin: ${origin}`);
    return false;
  }
  return true;
} });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
  logger.info(`WS broadcast: ${type}`);
}

// Channel-based subscriptions: clients can subscribe to task log streams
const subscriptions = new Map(); // ws -> Set<taskId>

wss.on('connection', (ws) => {
  logger.info('WS client connected');
  ws.send(JSON.stringify({ type: 'connected', payload: { msg: 'Cardinal Frame WS' } }));
  subscriptions.set(ws, new Set());

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && msg.taskId) {
        subscriptions.get(ws)?.add(msg.taskId);
      } else if (msg.type === 'unsubscribe' && msg.taskId) {
        subscriptions.get(ws)?.delete(msg.taskId);
      }
    } catch {}
  });

  ws.on('close', () => {
    subscriptions.delete(ws);
    logger.info('WS client disconnected');
  });
});

function broadcastLog(taskId, stream, line) {
  const msg = JSON.stringify({ type: 'task:log', payload: { taskId, stream, line, ts: Date.now() } });
  for (const [ws, subs] of subscriptions) {
    if (subs.has(taskId) && ws.readyState === 1) {
      ws.send(msg);
    }
  }
}

// ─── JWT Auth + RBAC Middleware ────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try { req.user = jwt.verify(header.slice(7), JWT_SECRET); } catch {}
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    next();
  };
}

// ─── Command Sanitization ─────────────────────────────────────────
const ALLOWED_COMMANDS = ['echo', 'ls', 'cat', 'pwd', 'date', 'whoami', 'hostname', 'uname', 'df', 'free', 'uptime', 'ps', 'wc', 'head', 'tail', 'grep', 'sort', 'uniq', 'curl', 'wget', 'python3', 'node', 'bash'];

function sanitizeCommand(cmd) {
  const trimmed = cmd.trim();
  const base = trimmed.split(/\s+/)[0];
  const baseName = base.split('/').pop();
  if (!ALLOWED_COMMANDS.includes(baseName)) {
    return { safe: false, error: `Command '${baseName}' not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}` };
  }
  return { safe: true, command: trimmed };
}

// ─── Task Execution with Log Streaming ─────────────────────────────
function executeTask(taskId, command) {
  const check = sanitizeCommand(command);
  if (!check.safe) {
    stmts.tasks.updateStatus.run('failed', null, new Date().toISOString(), check.error, 1, taskId);
    broadcast('task:status', { id: taskId, status: 'failed', exitCode: 1, result: check.error });
    return;
  }

  stmts.tasks.updateStatus.run('running', new Date().toISOString(), null, null, null, taskId);
  broadcast('task:status', { id: taskId, status: 'running' });
  logger.info(`Task executing: ${taskId} -> ${check.command}`);

  const child = spawn(check.command, [], {
    timeout: 30000,
    shell: '/bin/sh',
    env: { PATH: process.env.PATH },
    cwd: '/tmp',
  });

  let stdout = '', stderr = '';

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l);
    for (const line of lines) {
      stdout += line + '\n';
      stmts.logs.insert.run(taskId, 'stdout', line);
      broadcastLog(taskId, 'stdout', line);
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l);
    for (const line of lines) {
      stderr += line + '\n';
      stmts.logs.insert.run(taskId, 'stderr', line);
      broadcastLog(taskId, 'stderr', line);
    }
  });

  child.on('close', (code) => {
   const finishedAt = new Date().toISOString();
   const exitCode = code ?? 0;
   const result = stdout.trim() || stderr.trim();
   const status = exitCode === 0 ? 'done' : 'failed';
   stmts.tasks.updateStatus.run(status, null, finishedAt, result, exitCode, taskId);
   broadcast('task:status', { id: taskId, status, exitCode, result });
   logger.info(`Task ${status}: ${taskId} (exit=${exitCode})`);
   if (status === 'done') fireHook('onTaskCompleted', { taskId, command, result, exitCode });
   else fireHook('onTaskFailed', { taskId, command, stderr, exitCode });
  });
}

// ─── Plugin Loader ───────────────────────────────────────────────────
const pluginLoader = new PluginLoader({ db, stmts, logger, broadcast });
// fireHook is an async alias that plugin hooks call
async function fireHook(hookName, data) {
  await pluginLoader.fireHook(hookName, data);
}

// ─── Shared Context Object ──────────────────────────────────────────────
const ctx = {
  app, db, stmts, wss, logger,
  JWT_SECRET, JWT_EXPIRES,
  authMiddleware, optionalAuth, requireRole, authLimiter, apiLimiter, readLimiter, writeLimiter, sandboxLimiter,
  audit, broadcast, broadcastLog,
  randomUUID,
  mcp, embeddings,
  pluginLoader, fireHook,
  // These are populated later (declared with const/let below)
  get collectTelemetry() { return collectTelemetry; },
  get telemetryCache() { return telemetryCache; },
  get deviceStateCache() { return deviceStateCache; },
  get executeTask() { return executeTask; },
  get sanitizeCommand() { return sanitizeCommand; },
};

// ─── Modularized Routes ─────────────────────────────────────────
app.use('/api/auth', authRoutes(ctx));
app.use('/api', dashboardRoutes(ctx));
app.use('/api', graphRoutes(ctx));
app.use('/api', taskRoutes(ctx));
app.use('/api', metaRoutes(ctx));

// ─── User Management (admin only) ──────────────────────────────────
app.get('/api/users', authMiddleware, requireRole('admin'), apiLimiter, (_req, res) => {
  res.json(stmts.users.getAll.all());
});

app.patch('/api/users/:id/role', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
 const { role } = req.body;
 if (!['admin', 'user', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role. Use: admin, user, viewer' });
 stmts.users.updateRole.run(role, req.params.id);
 res.json({ id: req.params.id, role });
});

// ─── State Files (MEMORY.md, PERSONA.md, etc.) ──────────────────
const STATE_FILES_DIR = path.resolve(process.cwd(), 'state');
const STATE_FILES = ['MEMORY.md', 'PERSONA.md', 'CLAUDE.md', 'AGENTS.md'];
app.get('/api/state', authMiddleware, async (_req, res) => {
 try {
  const fs = await import('fs');
  await fs.promises.mkdir(STATE_FILES_DIR, { recursive: true });
  const files = [];
  for (const name of STATE_FILES) {
   const fp = path.join(STATE_FILES_DIR, name);
   try {
    const content = await fs.promises.readFile(fp, 'utf8');
    const stat = await fs.promises.stat(fp);
    files.push({ name, content, size: stat.size, modified: stat.mtime.toISOString() });
   } catch { files.push({ name, content: '', size: 0, modified: null }); }
  }
  res.json(files);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/state/:name', authMiddleware, async (req, res) => {
 try {
  const fs = await import('fs');
  const name = req.params.name;
  if (!STATE_FILES.includes(name)) return res.status(400).json({ error: 'Invalid state file' });
  const fp = path.join(STATE_FILES_DIR, name);
  try { const content = await fs.promises.readFile(fp, 'utf8'); res.json({ name, content }); }
  catch { res.json({ name, content: '' }); }
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/state/:name', authMiddleware, requireRole('admin'), async (req, res) => {
 try {
  const fs = await import('fs');
  const name = req.params.name;
  if (!STATE_FILES.includes(name)) return res.status(400).json({ error: 'Invalid state file' });
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'Content must be a string' });
  await fs.promises.mkdir(STATE_FILES_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(STATE_FILES_DIR, name), content, 'utf8');
  res.json({ name, content, size: content.length });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── User Profile (compiled preferences) ─────────────────────────
app.get('/api/profile', authMiddleware, (req, res) => {
 try {
  const user = stmts.users.getByUsername.get(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Parse preferences from user metadata
  const prefs = [];
  try { const meta = JSON.parse(user.metadata || '{}'); for (const [k,v] of Object.entries(meta)) { prefs.push({ key: k, value: v, locked: false }); } } catch {}
  // Add role-based preferences
  prefs.unshift({ key: 'role', value: user.role, locked: true });
  prefs.unshift({ key: 'username', value: user.username, locked: true });
  res.json({ username: user.username, role: user.role, preferences: prefs, created: user.created_at });
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/profile/:key', authMiddleware, (req, res) => {
 try {
  const user = stmts.users.getByUsername.get(req.user.username);
  const meta = JSON.parse(user.metadata || '{}');
  const { value, action } = req.body; // action: 'set', 'lock', 'dismiss'
  if (action === 'dismiss') { delete meta[req.params.key]; }
  else { meta[req.params.key] = value; }
  db.prepare('UPDATE users SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), user.id);
  res.json({ key: req.params.key, value: action === 'dismiss' ? null : value });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FTS Context Explorer (injected context segments) ────────────
app.get('/api/context/injections', authMiddleware, (req, res) => {
 try {
  // Return recent context injections (simulated from message history)
  const convId = req.query.conversation_id;
  if (!convId) return res.json([]);
  const messages = db.prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20').all(convId);
  const injections = messages.map(m => ({
   id: m.id,
   type: m.role === 'user' ? 'user_input' : 'model_output',
   summary: (m.content || '').slice(0, 120) + ((m.content || '').length > 120 ? '…' : ''),
   timestamp: m.created_at,
   tokens: Math.ceil((m.content || '').length / 4),
  }));
  res.json(injections);
 } catch (e) { res.json([]); }
});

// ─── Code Execution Sandbox ──────────────────────────────────────
app.post('/api/sandbox/execute', authMiddleware, requireRole('admin'), sandboxLimiter, validateBody(schemas.sandboxExecute), async (req, res) => {
 try {
  // execSync is injected by the skill runtime
  const { code, language = 'javascript' } = req.body;
  const fs = await import('fs');
  const tmpFile = path.join(os.tmpdir(), `cf_sandbox_${Date.now()}.${language === 'python' ? 'py' : 'mjs'}`);
  await fs.promises.writeFile(tmpFile, code);
  try {
   const cmd = language === 'python' ? `python3 ${tmpFile}` : `node ${tmpFile}`;
   const output = execSync(cmd, { timeout: 5000, maxBuffer: 1024*100 }).toString();
   await fs.promises.unlink(tmpFile).catch(() => {});
   res.json({ exitCode: 0, stdout: output.slice(0, 5000), stderr: '' });
  } catch (e) {
   await fs.promises.unlink(tmpFile).catch(() => {});
   res.json({ exitCode: e.status || 1, stdout: (e.stdout || '').toString().slice(0, 5000), stderr: (e.stderr || '').toString().slice(0, 2000) });
  }
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Token Cost Tracking ──────────────────────────────────────────
const MODEL_PRICING = { // per 1M tokens [input, output]
 'gpt-4o': [2.50, 10.00], 'gpt-4o-mini': [0.15, 0.60], 'gpt-4-turbo': [10.00, 30.00],
 'claude-3.5-sonnet': [3.00, 15.00], 'claude-3-opus': [15.00, 75.00], 'claude-3-haiku': [0.25, 1.25],
 'llama-3.1-70b': [0.60, 0.80], 'llama-3.1-8b': [0.05, 0.07], 'mixtral-8x7b': [0.27, 0.27],
 'deepseek-chat': [0.14, 0.28], 'deepseek-reasoner': [0.55, 2.19],
 'grok-2': [2.00, 10.00], 'gemini-pro': [0.50, 1.50], 'gemini-flash': [0.075, 0.30],
};
function getModelCost(modelId, promptTokens, completionTokens) {
 for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
  if (modelId.includes(key)) return (promptTokens/1e6*pricing[0]) + (completionTokens/1e6*pricing[1]);
 }
 if (modelId.includes('local') || modelId.includes('ollama')) return 0;
 return (promptTokens/1e6*1) + (completionTokens/1e6*3);
}

app.get('/api/costs', authMiddleware, (req, res) => {
 try {
  const { conversation_id, period = '-24 hours' } = req.query;
  if (conversation_id) { res.json(stmts.tokenUsage.getByConv.all(conversation_id)); }
  else { res.json(stmts.tokenUsage.getSummary.all(period)); }
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/costs/recent', authMiddleware, (_req, res) => {
 try { res.json(stmts.tokenUsage.getRecent.all()); }
 catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Token Window Compression Engine ──────────────────────────────
app.post('/api/chat/compress-context', authMiddleware, apiLimiter, async (req, res) => {
 try {
  const { conversation_id, target_tokens = 4000 } = req.body;
  if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
  const messages = db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversation_id);
  if (messages.length < 3) return res.json({ compressed: false, reason: 'Too few messages to compress' });
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const estimatedTokens = Math.ceil(totalChars / 4);
  if (estimatedTokens < target_tokens * 1.5) return res.json({ compressed: false, reason: 'Already within target', original_tokens: estimatedTokens });
  const convoText = messages.map(m => `[${m.role}]: ${(m.content || '').slice(0, 500)}`).join('\n');
  const summaryPrompt = `Summarize this conversation concisely, preserving key decisions, facts, and code changes. Output a dense summary:\n\n${convoText}`;
  let provider, modelRecord;
  modelRecord = stmts.models.getDefault.get();
  if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
  if (!provider) return res.status(400).json({ error: 'No LLM provider for compression' });
  const isOllama = provider.type === 'ollama';
  const pType = provider.type;
  const baseUrl = provider.base_url || PROVIDER_TYPES[provider.type]?.baseUrl || '';
  const rawUrl = buildChatUrl(baseUrl, pType, modelRecord.model_id, false);
  const { headers, url } = buildProviderAuth(provider, rawUrl);
  const compressionMessages = [{ role: 'user', content: summaryPrompt }];
  const chatPayload = buildChatPayload(pType, modelRecord.model_id, compressionMessages, false);
  if (!chatPayload.max_tokens && pType !== 'google') chatPayload.max_tokens = 2000;
  const body = JSON.stringify(chatPayload);
  const fetch = globalThis.fetch;
  const resp = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) return res.status(502).json({ error: `Compression LLM error: ${resp.status}` });
  const data = await resp.json();
  let summary;
  if (isOllama) summary = data.message?.content || '';
  else if (pType === 'google') summary = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  else if (pType === 'anthropic') summary = data.content?.[0]?.text || '';
  else summary = data.choices?.[0]?.message?.content || '';
  if (!summary) return res.status(502).json({ error: 'Empty compression summary' });
  const summaryId = randomUUID();
  const pTokens = data.usage?.prompt_tokens || Math.ceil(summaryPrompt.length/4);
  const cTokens = data.usage?.completion_tokens || Math.ceil(summary.length/4);
  stmts.messages.insert.run(summaryId, conversation_id, 'system', `[CONTEXT SUMMARY]\n${summary}`, '[]', '[]', null, modelRecord.model_id, pTokens, cTokens);
  const cost = getModelCost(modelRecord.model_id, pTokens, cTokens);
  stmts.tokenUsage.insert.run(conversation_id, modelRecord.model_id, provider.id, pTokens, cTokens, cost, 'compression');
  const newTokenEstimate = Math.ceil(summary.length / 4);
  res.json({ compressed: true, original_tokens: estimatedTokens, compressed_tokens: newTokenEstimate, saved_pct: Math.round((1 - newTokenEstimate / estimatedTokens) * 100), summary_preview: summary.slice(0, 200) });
 } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Device-State Ingestion ────────────────────────────────────────
let deviceStateCache = { battery_pct: null, battery_charging: null, network_type: 'unknown', thermal_throttling: false, gpu_util: 0, npu_util: 0, ram_pct: 0, cpu_temp: 0, swap_pct: 0 };
async function collectDeviceState() {
 try {
  const { execSync: exec2 } = await import('child_process');
  // Battery
  try { const b = exec2('cat /sys/class/power_supply/battery/capacity 2>/dev/null || echo ""').toString().trim(); if (b) deviceStateCache.battery_pct = parseInt(b); const bs = exec2('cat /sys/class/power_supply/battery/status 2>/dev/null || cat /sys/class/power_supply/AC/online 2>/dev/null || echo ""').toString().trim(); deviceStateCache.battery_charging = bs.includes('Charging') || bs === '1'; } catch {}
  // Network
  try { const iface = exec2("ip route show default 2>/dev/null | awk '/default/{print $5}' | head -1").toString().trim(); if (iface) { const s = exec2(`cat /sys/class/net/${iface}/operstate 2>/dev/null || echo ""`).toString().trim(); deviceStateCache.network_type = s === 'up' ? (iface.startsWith('wlan') ? 'wifi' : 'ethernet') : 'disconnected'; } } catch {}
  // Thermal
  try { const t = exec2('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0').toString().trim(); const tc = parseInt(t) / 1000; deviceStateCache.cpu_temp = tc; deviceStateCache.thermal_throttling = tc > 80; } catch {}
  // RAM + Swap
  try { const f = exec2('free -m 2>/dev/null').toString(); const ml = f.split('\n').find(l => l.startsWith('Mem:')); if (ml) { const p = ml.split(/\s+/); deviceStateCache.ram_pct = Math.round(parseInt(p[2])/parseInt(p[1])*100); } const sl = f.split('\n').find(l => l.startsWith('Swap:')); if (sl) { const p = sl.split(/\s+/); deviceStateCache.swap_pct = p[2] !== '0' ? Math.round(parseInt(p[2])/parseInt(p[1])*100) : 0; } } catch {}
  // Jetson tegrastats
  try { const t = exec2('timeout 1 tegrastats --start 2>/dev/null || echo ""', { timeout: 2000 }).toString().trim(); if (t) { const rm = t.match(/RAM\s+(\d+)\/(\d+)/); if (rm) deviceStateCache.ram_pct = Math.round(parseInt(rm[1])/parseInt(rm[2])*100); const gm = t.match(/GR3D\s+(\d+)%/); if (gm) deviceStateCache.gpu_util = parseInt(gm[1]); } } catch {}
 } catch {}
}
setInterval(collectDeviceState, 10000);
collectDeviceState();

app.get('/api/device-state', (_req, res) => { res.json(deviceStateCache); });

// ─── File Watcher Service ──────────────────────────────────────────
const activeWatchers = new Map();
function startFileWatcher(watcher) {
 if (activeWatchers.has(watcher.id)) return;
 try {
  if (!existsSync(watcher.path)) return;
  const w = watch(watcher.path, { recursive: !!watcher.recursive }, (eventType, filename) => {
   const event = { type: 'file_event', path: watcher.path, filename, eventType, watcher_id: watcher.id, ts: Date.now() };
   wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify(event)); });
   stmts.fileWatchers.updateEnabled.run(watcher.enabled, new Date().toISOString(), watcher.id);
   audit('file_event', 'watcher', watcher.id, null, { path: watcher.path, filename, eventType });
  });
  activeWatchers.set(watcher.id, w);
 } catch (e) { logger.error(`Watcher ${watcher.id} failed:`, e.message); }
}
setTimeout(() => { try { stmts.fileWatchers.getAll.all().filter(w => w.enabled).forEach(startFileWatcher); } catch {} }, 2000);

app.get('/api/watchers', authMiddleware, (_req, res) => { try { res.json(stmts.fileWatchers.getAll.all()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/watchers', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
 try {
  const { path: watchPath, recursive = false, trigger_skill = null, enabled = true } = req.body;
  if (!watchPath) return res.status(400).json({ error: 'path required' });
  const fs = await import('fs');
  if (!fs.existsSync(watchPath)) return res.status(400).json({ error: 'Path does not exist' });
  const id = randomUUID();
  stmts.fileWatchers.insert.run(id, watchPath, recursive ? 1 : 0, trigger_skill, enabled ? 1 : 0);
  const w = { id, path: watchPath, recursive: !!recursive, trigger_skill, enabled: !!enabled };
  if (enabled) startFileWatcher(w);
  res.status(201).json(w);
 } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/watchers/:id', authMiddleware, requireRole('admin'), (req, res) => {
 try { const i = activeWatchers.get(req.params.id); if (i) { i.close(); activeWatchers.delete(req.params.id); } stmts.fileWatchers.delete.run(req.params.id); res.json({ deleted: true }); }
 catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Health & Dashboard ────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const dbStats = db.pragma('journal_mode')[0];
  const tableCount = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get().c;
  const dbSize = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get().size;

  res.json({
    status: 'ok',
    mode: 'AI-Powered',
    db: {
      type: 'SQLite',
      journal_mode: dbStats,
      tables: tableCount,
      size_mb: Math.round((dbSize / 1024 / 1024) * 100) / 100,
    },
    ws: {
      connected_clients: wss.clients.size,
    },
    uptime: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heap_used_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Detailed Health (memory monitoring) ──────────────────────────────
app.get('/api/health/detailed', authMiddleware, requireRole('admin'), (_req, res) => {
  const mem = process.memoryUsage();
  const dbSize = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get().size;
  res.json({
    status: 'ok',
    uptime_seconds: Math.round(process.uptime()),
    process: {
      pid: process.pid,
      platform: process.platform,
      node_version: process.version,
    },
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
      external_mb: Math.round(mem.external / 1024 / 1024 * 100) / 100,
      array_buffers_mb: Math.round(mem.arrayBuffers / 1024 / 1024 * 100) / 100,
      heap_limit_mb: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
      heap_usage_pct: Math.round((mem.heapUsed / mem.heapTotal) * 100 * 100) / 100,
    },
    db: {
      type: 'SQLite',
      journal_mode: db.pragma('journal_mode')[0],
      tables: db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get().c,
      size_mb: Math.round((dbSize / 1024 / 1024) * 100) / 100,
      read_count: db.prepare("PRAGMA stats").get()?.read || 0,
      write_count: db.prepare("PRAGMA stats").get()?.write || 0,
    },
    ws: {
      connected_clients: wss.clients.size,
    },
    event_loop: {
      max_heap_mb: Math.round(require('v8').getHeapStatistics().total_physical_size / 1024 / 1024 * 100) / 100,
      used_heap_mb: Math.round(require('v8').getHeapStatistics().used_heap_size / 1024 / 1024 * 100) / 100,
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── Request Logger Middleware ──────────────────────────────────────
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] ?? 2;

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    if (LOG_LEVELS[level] <= currentLogLevel) {
      const logLine = `[${new Date().toISOString()}] ${level.toUpperCase()} ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`;
      if (level === 'error') console.error(logLine);
      else if (level === 'warn') console.warn(logLine);
      else console.log(logLine);
    }
  });
  next();
});

// ─── Live Telemetry ────────────────────────────────────────────────
let telemetryCache = { cpu: 0, mem: 0, gpu: 0, npu: 0, temp: 0, uptime: 0, wsClients: 0, ts: Date.now() };
async function collectTelemetry() {
 try {
  // execSync is injected by the skill runtime
  // CPU usage (1-min load / cores)
  let cpuLoad = 0;
  try { const cores = parseInt(execSync('nproc').toString().trim()) || 4; const load = parseFloat(execSync('cat /proc/loadavg').toString().split(' ')[0]) || 0; cpuLoad = Math.min(100, Math.round((load / cores) * 100)); } catch {}
  // Memory usage
  let memUsage = 0;
  try { const memInfo = execSync('free -m').toString(); const lines = memInfo.split('\n'); if (lines[1]) { const parts = lines[1].split(/\s+/); const total = parseInt(parts[1]) || 1; const used = parseInt(parts[2]) || 0; memUsage = Math.round((used / total) * 100); } } catch {}
  // GPU/NPU (Jetson Tegra — try tegrastats)
  let gpuUtil = 0, npuUtil = 0, tempC = 0;
  try {
  const ts = execSync('tegrastats --sleep 1 2>&1 | head -1').toString();
  // RAM 4021/15945MB, ltc 166@921MHz, EMC 28%@2133MHz, NVDEC 0%@689MHz, NVENC 0%@689MHz, ISP 0%, NVJPG 0%, OFA 0%, APE 0%@150MHz, SE 0%@201MHz, VPRS 0%, CPU 6%@1.5GHz, GPU 12%@318MHz, DLA 0%@1GHz, PVA 0%@1GHz, CIA 0%@115MHz
  const gpuMatch = ts.match(/GPU\s+(\d+)%/); if (gpuMatch) gpuUtil = parseInt(gpuMatch[1]);
  const dlaMatch = ts.match(/DLA\s+(\d+)%/); if (dlaMatch) npuUtil = parseInt(dlaMatch[1]);
  const tempMatch = ts.match(/(\d+)C/); if (tempMatch) tempC = parseInt(tempMatch[1]);
  } catch {}
  // Temperature fallback
  if (!tempC) { try { tempC = parseInt(execSync('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null').toString().trim()) / 1000; } catch {} }
  telemetryCache = { cpu: cpuLoad, mem: memUsage, gpu: gpuUtil, npu: npuUtil, temp: Math.round(tempC), uptime: Math.floor(process.uptime()), wsClients: wss.clients.size, ts: Date.now() };
 } catch {}
 return telemetryCache;
}
// Collect telemetry every 5s and broadcast via WS
setInterval(async () => {
 const t = await collectTelemetry();
 const msg = JSON.stringify({ type: 'telemetry', payload: t });
 for (const client of wss.clients) { if (client.readyState === 1) client.send(msg); }

 // Also broadcast dashboard summary every 5s (but only counts — lightweight)
 if (wss.clients.size > 0) {
   try {
     const agentCount = stmts.dashboard.agentCount.get().c;
     const taskCount = stmts.dashboard.taskCount.get().c;
     const runningTasks = stmts.dashboard.runningTasks.get().c;
     const pendingTasks = stmts.dashboard.pendingTasks.get().c;
     const dashMsg = JSON.stringify({ type: 'dashboard:update', payload: { activeAgents: agentCount, totalTasks: taskCount, runningTasks, pendingTasks, wsClients: wss.clients.size, uptimeHours: Math.floor(process.uptime() / 3600) } });
     for (const client of wss.clients) { if (client.readyState === 1) client.send(dashMsg); }
   } catch {}
 }
}, 5000);
// Initial collection
collectTelemetry();

// ─── Dashboard & Telemetry routes moved to routes/dashboard.mjs ──

// ─── Graph + Agent/Task/DAG/File routes moved to routes/graph.mjs and routes/tasks.mjs ──

// ─── MCP Server Management API ─────────────────────────────────────
// No central "system" star. Entities cluster by functional domain and connect
// only through real relationships. Edges carry strength so the layout responds
// proportionally. Each cluster head is the local hub for its domain.
// ─── Audit Log Helper ──────────────────────────────────────────────
function audit(action, resourceType, resourceId, userId, details = {}) {
 try {
  stmts.audit.insert.run(action, resourceType, resourceId || null, userId || null, JSON.stringify(details));
 } catch (err) {
  logger.error(`Audit log write failed: ${err.message}`);
 }
}

// ─── MCP/Groups/Schedules/Plugins/Audit moved to routes/meta.mjs ──

// ─── Serve Frontend (production — code-split React app) ─────
const clientDist = path.join(import.meta.dirname, '..', '..', 'client', 'dist');

// ─── Chat Conversations API ──────────────────────────────────────
app.get('/api/chat/conversations', authMiddleware, (req, res) => {
 const convs = stmts.conversations.getAll.all(req.user.id);
 res.json(convs.map(c => ({ ...c, model: c.model || '' })));
});

app.post('/api/chat/conversations', authMiddleware, apiLimiter, (req, res) => {
 const id = randomUUID();
 const { title, model, system_prompt } = req.body;
 stmts.conversations.insert.run(id, title || 'New Chat', req.user.id, model || '', system_prompt || '');
 audit('create', 'conversation', id, req.user.id, { title });
 res.status(201).json({ id, title: title || 'New Chat', model: model || '', system_prompt: system_prompt || '' });
});

app.put('/api/chat/conversations/:id', authMiddleware, (req, res) => {
 const conv = stmts.conversations.getById.get(req.params.id);
 if (!conv) return res.status(404).json({ error: 'Conversation not found' });
 if (conv.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
 const { title, model, system_prompt } = req.body;
 stmts.conversations.update.run(title ?? conv.title, model ?? conv.model, system_prompt ?? conv.system_prompt, req.params.id);
 res.json({ ok: true });
});

app.delete('/api/chat/conversations/:id', authMiddleware, (req, res) => {
 const conv = stmts.conversations.getById.get(req.params.id);
 if (!conv) return res.status(404).json({ error: 'Conversation not found' });
 if (conv.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
 stmts.conversations.delete.run(req.params.id);
 audit('delete', 'conversation', req.params.id, req.user.id, { title: conv.title });
 res.json({ ok: true });
});

// ─── Chat Messages API ───────────────────────────────────────────
app.get('/api/chat/conversations/:id/messages', authMiddleware, (req, res) => {
 const conv = stmts.conversations.getById.get(req.params.id);
 if (!conv) return res.status(404).json({ error: 'Conversation not found' });
 if (conv.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
 const msgs = stmts.messages.getByConversation.all(req.params.id);
 res.json(msgs.map(m => ({ ...m, attachments: JSON.parse(m.attachments || '[]'), tool_calls: JSON.parse(m.tool_calls || '[]') })));
});

// ─── Chat File Upload ────────────────────────────────────────────
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

app.post('/api/chat/upload', authMiddleware, apiLimiter, (req, res) => {
 // Accept base64 in JSON body
 const { filename, mime_type, content_b64, message_id } = req.body;
 if (!filename || !content_b64) return res.status(400).json({ error: 'filename and content_b64 required' });
 const id = randomUUID();
 const buf = Buffer.from(content_b64, 'base64');
 const storagePath = path.join(UPLOAD_DIR, `${id}-${filename}`);
 writeFileSync(storagePath, buf);
 // If message_id provided and exists in chat_messages, link it; otherwise store with null message_id
 const msgId = message_id || null;
 try {
  stmts.attachments.insert.run(id, msgId, null, filename, mime_type || 'application/octet-stream', buf.length, storagePath);
 } catch (e) {
  // FK constraint — store without message link
  db.prepare('INSERT INTO chat_attachments (id, filename, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?)')
   .run(id, filename, mime_type || 'application/octet-stream', buf.length, storagePath);
 }
 res.status(201).json({ id, filename, mime_type: mime_type || 'application/octet-stream', size: buf.length, message_id: msgId });
});

app.get('/api/chat/attachments/:id', authMiddleware, (req, res) => {
 // Not in prepared stmts — direct query
 const att = db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(req.params.id);
 if (!att) return res.status(404).json({ error: 'Attachment not found' });
 if (!att.storage_path || !existsSync(att.storage_path)) return res.status(404).json({ error: 'File missing' });
 res.setHeader('Content-Type', att.mime_type);
 res.setHeader('Content-Disposition', `inline; filename="${att.filename}"`);
 res.sendFile(att.storage_path);
});

// ─── LLM Chat/Completions Proxy ──────────────────────────────────
// Proxies chat requests to the user's selected LLM provider, streaming SSE back.
// ─── Failover: find a fallback provider when primary fails ──────
function findFallbackProvider(excludeProviderId) {
 // Priority: Ollama/local first (free), then cheapest cloud provider
 const allProviders = stmts.providers.getAll.all().filter(p => p.enabled && p.id !== excludeProviderId);
 // Prefer local/Ollama
 const local = allProviders.find(p => p.type === 'ollama');
 if (local) {
  const localModels = stmts.models.getByProvider.all(local.id);
  if (localModels.length) {
   const m = localModels[0];
   return { provider: local, modelId: m.model_id, baseUrl: local.base_url || 'http://localhost:11434', isOllama: true };
  }
 }
 // Then any other enabled provider
 for (const p of allProviders) {
  const models = stmts.models.getByProvider.all(p.id);
  if (models.length) {
   const m = models[0];
   const pType = PROVIDER_TYPES[p.type];
   return { provider: p, modelId: m.model_id, baseUrl: p.base_url || pType?.baseUrl || '', isOllama: p.type === 'ollama' };
  }
 }
 return null;
}

// Auto-observe interaction for Aimi's self-learning loop
function autoObserve(conversation_id, messages, assistantContent, modelId) {
  try {
    const lastUserMsg = messages?.filter(m => m.role === 'user').pop();
    if (!lastUserMsg || !assistantContent) return;
    const userInput = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content || '');
    // Simple intent extraction: first meaningful word(s)
    const inputLower = userInput.toLowerCase();
    let intent = 'general';
    if (/deploy|build|stag|prod/.test(inputLower)) intent = 'deploy-build';
    else if (/search|find|look for|where/.test(inputLower)) intent = 'search';
    else if (/create|make|new|add/.test(inputLower)) intent = 'create';
    else if (/delete|remove|clean/.test(inputLower)) intent = 'delete';
    else if (/status|health|check|monitor/.test(inputLower)) intent = 'monitor';
    else if (/explain|what|how|why|describe/.test(inputLower)) intent = 'query';
    const obsId = randomUUID();
    stmts.observations.insert.run(obsId, conversation_id || null, userInput, assistantContent, intent, '[]', null, 0);
    // Auto-detect pattern
    const words = inputLower.split(/\s+/).filter(w => w.length > 3);
    const patternKey = words.slice(0, 4).join(' ');
    if (patternKey.length > 10) {
      const existing = stmts.patterns.getByKey.get(patternKey);
      if (existing) {
        const newCount = existing.occurrence_count + 1;
        const newConfidence = Math.min(0.99, existing.confidence + 0.05);
        stmts.patterns.increment.run(newConfidence, existing.id);
        broadcast('learn:pattern', { id: existing.id, pattern_key: patternKey, occurrence_count: newCount, confidence: newConfidence });
      } else {
        const patternId = randomUUID();
        stmts.patterns.insert.run(patternId, patternKey, intent, `Recurring: "${patternKey}"`, 0.3);
        broadcast('learn:pattern', { id: patternId, pattern_key: patternKey, pattern_type: intent, occurrence_count: 1, confidence: 0.3 });
      }
    }
    broadcast('learn:observation', { id: obsId, intent, conversation_id });
    logger.info(`Aimi observed: intent=${intent}, pattern="${patternKey}"`);
  } catch (err) {
    logger.error('Auto-observe error:', err.message);
  }
}

app.post('/api/chat/completions', authMiddleware, apiLimiter, async (req, res) => {
 const { messages, model, conversation_id, stream = true } = req.body;
 if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' });

 // Resolve which provider to use: explicit model → provider, or default
 let provider, modelRecord;
 if (model) {
  // If the same model exists under multiple providers, prefer the one
  // with an enabled provider and a real (non-placeholder) API key.
  const candidates = db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').all(model, model);
  for (const m of candidates) {
   const p = stmts.providers.getById.get(m.provider_id);
   if (p && p.enabled && p.api_key && p.api_key.length > 10 && !p.api_key.includes('*')) {
    modelRecord = m;
    provider = p;
    break;
   }
  }
  if (!provider && candidates.length > 0) {
   modelRecord = candidates[0];
   provider = stmts.providers.getById.get(modelRecord.provider_id);
  }
 }
 if (!provider) {
  modelRecord = stmts.models.getDefault.get();
  if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
 }
 if (!provider) return res.status(400).json({ error: 'No LLM provider configured. Add a provider with an API key first.' });
 const isOllama = provider.type === 'ollama';
 if (!provider.api_key && !isOllama) return res.status(400).json({ error: `Provider "${provider.name}" has no API key set.` });

 const providerType = PROVIDER_TYPES[provider.type];
 const pType = provider.type;
 const baseUrl = provider.base_url || providerType?.baseUrl || '';
 const modelId = modelRecord?.model_id || model || 'gpt-3.5-turbo';

 // Save user message to DB if conversation_id provided
 if (conversation_id) {
 const lastUserMsg = messages.filter(m => m.role === 'user').pop();
 if (lastUserMsg) {
 const msgId = randomUUID();
 stmts.messages.insert.run(msgId, conversation_id, 'user', lastUserMsg.content, '[]', '[]', null, null, 0, 0);
 db.prepare("UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation_id);
 // Auto-index into session_index for search
 try { stmts.sessionIndex.insert.run(randomUUID(), 'chat', conversation_id, req.user.id, lastUserMsg.content.slice(0, 100), lastUserMsg.content); } catch {}
 }
 }

 // Build provider-native payload and URL
 const payload = buildChatPayload(pType, modelId, messages, stream);
 const url = buildChatUrl(baseUrl, pType, modelId, stream);

 if (stream) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
  const fetch = globalThis.fetch;
  const { headers, url: chatUrl } = buildProviderAuth(provider, url);

  const resp = await fetch(chatUrl, {
  method: 'POST',
  headers,
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
   // ─── DUAL-TIER FAILOVER ─────────────────────────────
   // On 429/5xx/timeout, try fallback provider
   const failoverStatuses = [429, 500, 502, 503, 504];
   if (failoverStatuses.includes(resp.status) || resp.status >= 500) {
    const fallback = findFallbackProvider(provider.id);
    if (fallback) {
     logger.warn(`Failover: ${provider.name} → ${fallback.provider.name} (${resp.status})`);
     audit('failover', 'provider', provider.id, null, { from: provider.name, to: fallback.provider.name, reason: `HTTP ${resp.status}` });
     // Record failover cost event
     stmts.tokenUsage.insert.run(conversation_id || null, modelId, provider.id, 0, 0, 0, 'failover');
     // Re-encode request for fallback provider
     const fbPType = fallback.provider.type;
     const fbUrl = buildChatUrl(fallback.baseUrl, fbPType, fallback.modelId, true);
     const { headers: fbHeaders, url: fbAuthUrl } = buildProviderAuth(fallback.provider, fbUrl);
     const fbPayload = buildChatPayload(fbPType, fallback.modelId, payload.messages || messages, true);
     const fbBody = JSON.stringify(fbPayload);
     try {
     const fbResp = await fetch(fbAuthUrl, { method: 'POST', headers: fbHeaders, body: fbBody, signal: AbortSignal.timeout(30000) });
      if (fbResp.ok) {
       res.setHeader('X-Failover', 'true');
       res.setHeader('X-Failover-Provider', fallback.provider.name);
       res.setHeader('X-Failover-Model', fallback.modelId);
       // Stream from fallback — using Web ReadableStream reader
       let fbContent = '';
       const fbReader = fbResp.body.getReader();
       const fbDecoder = new TextDecoder();
       let fbDone = false;
       let fbBuf = '';

       while (!fbDone) {
        const { done, value } = await fbReader.read();
        if (done) { fbDone = true; break; }
        const text = fbDecoder.decode(value, { stream: true });

        if (fallback.isOllama) {
         fbBuf += text;
         const lines = fbBuf.split('\n'); fbBuf = lines.pop();
         for (const line of lines) {
          if (!line.trim()) continue;
          try {
           const p = JSON.parse(line);
           const c = p.message?.content || '';
           if (c) { fbContent += c; res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`); }
           if (p.done) res.write('data: [DONE]\n\n');
          } catch {}
         }
        } else {
         res.write(Buffer.from(value));
         const lines = text.split('\n').filter(l => l.startsWith('data: '));
         for (const line of lines) {
          const d = line.slice(6).trim();
          if (d === '[DONE]') continue;
          try { const p = JSON.parse(d); if (p.choices?.[0]?.delta?.content) fbContent += p.choices[0].delta.content; } catch {}
         }
        }
       }

       // Fallback stream ended — save to DB
       if (conversation_id && fbContent) {
        const mId = randomUUID(); const est = Math.ceil(fbContent.length/4);
        stmts.messages.insert.run(mId, conversation_id, 'assistant', fbContent, '[]', '[]', null, fallback.modelId, 0, est);
        const cost = getModelCost(fallback.modelId, 0, est);
        stmts.tokenUsage.insert.run(conversation_id, fallback.modelId, fallback.provider.id, 0, est, cost, 'inference');
       }
       autoObserve(conversation_id, messages, fbContent, fallback.modelId);
       res.end();
       return; // exit — fallback handled the stream
      }
     } catch (fbErr) { logger.error('Fallback also failed:', fbErr.message); }
    }
   }
   const errText = await resp.text();
   res.write(`data: ${JSON.stringify({ error: { message: `LLM API error (${resp.status}): ${errText.slice(0, 500)}` }})}\n\n`);
   res.end();
   return;
  }

   let fullContent = '';
   // Node.js fetch returns a Web ReadableStream — use getReader(), not .on('data').
   const reader = resp.body.getReader();
   const decoder = new TextDecoder();
   let streamDone = false;

   // Helper: parse SSE chunks by provider type
   const handleChunk = (text, isChunkStart) => {
    if (isOllama) {
     // Ollama returns NDJSON lines
     return text.split('\n').filter(l => l.trim());
    } else if (pType === 'google') {
     return text.split('\n').filter(l => l.trim() && l.trim() !== '[DONE]');
    } else if (pType === 'anthropic') {
     return text.split('\n').filter(l => l.trim().startsWith('data: '));
    } else {
     // OpenAI-compatible SSE
     return text.split('\n').filter(l => l.startsWith('data: '));
    }
   };

   let ollamaBuffer = '';
   let googleBuffer = '';
   let anthropicBuffer = '';

   while (!streamDone) {
    const { done, value } = await reader.read();
    if (done) { streamDone = true; break; }
    const text = decoder.decode(value, { stream: true });

    if (isOllama) {
     ollamaBuffer += text;
     const lines = ollamaBuffer.split('\n');
     ollamaBuffer = lines.pop();
     for (const line of lines) {
      if (!line.trim()) continue;
      try {
       const parsed = JSON.parse(line);
       const content = parsed.message?.content || '';
       if (content) {
        fullContent += content;
        const sse = { choices: [{ delta: { content }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(sse)}\n\n`);
       }
       if (parsed.done) res.write('data: [DONE]\n\n');
      } catch {}
     }
    } else if (pType === 'google') {
     googleBuffer += text;
     const lines = googleBuffer.split('\n');
     googleBuffer = lines.pop();
     for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]') continue;
      try {
       const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
       if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
       const parsed = JSON.parse(data);
       const gtext = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
       if (gtext) {
        fullContent += gtext;
        const sse = { choices: [{ delta: { content: gtext }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(sse)}\n\n`);
       }
      } catch {}
     }
    } else if (pType === 'anthropic') {
     anthropicBuffer += text;
     const lines = anthropicBuffer.split('\n');
     anthropicBuffer = lines.pop();
     for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
       const data = trimmed.slice(6);
       try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
         fullContent += parsed.delta.text;
         const sse = { choices: [{ delta: { content: parsed.delta.text }, finish_reason: null }] };
         res.write(`data: ${JSON.stringify(sse)}\n\n`);
        } else if (parsed.type === 'message_stop') {
         res.write('data: [DONE]\n\n');
        }
       } catch {}
      }
     }
    } else {
     // OpenAI-compatible SSE (default) — pass through raw chunks
     res.write(Buffer.from(value));
     const lines = text.split('\n').filter(l => l.startsWith('data: '));
     for (const line of lines) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
       const parsed = JSON.parse(data);
       const delta = parsed.choices?.[0]?.delta?.content;
       if (delta) fullContent += delta;
      } catch {}
     }
    }
   }

   // Stream ended — save assistant message to DB + track token cost
   if (conversation_id && fullContent) {
    const msgId = randomUUID();
    const estTokens = Math.ceil(fullContent.length / 4);
    stmts.messages.insert.run(msgId, conversation_id, 'assistant', fullContent, '[]', '[]', null, modelId, 0, estTokens);
    const cost = getModelCost(modelId, 0, estTokens);
    stmts.tokenUsage.insert.run(conversation_id, modelId, provider.id, 0, estTokens, cost, 'inference');
   }
   // Aimi self-learning: observe this interaction
   autoObserve(conversation_id, messages, fullContent, modelId);
   res.end();
  } catch (err) {
   logger.error('LLM proxy error:', err);
   res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
   res.end();
  }
 } else {
  // Non-streaming
  try {
  const fetch = globalThis.fetch;
  const { headers: nonStreamHeaders, url: nonStreamUrl } = buildProviderAuth(provider, url);
  const nonStreamPayload = buildChatPayload(pType, modelId, messages, false);
  const nonStreamBody = JSON.stringify(nonStreamPayload);
  const resp = await fetch(nonStreamUrl, {
  method: 'POST',
  headers: nonStreamHeaders,
  body: nonStreamBody,
  signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
   // Non-streaming failover
   const failoverStatuses = [429, 500, 502, 503, 504];
   if (failoverStatuses.includes(resp.status) || resp.status >= 500) {
    const fallback = findFallbackProvider(provider.id);
    if (fallback) {
     logger.warn(`Failover (non-stream): ${provider.name} → ${fallback.provider.name} (${resp.status})`);
     audit('failover', 'provider', provider.id, null, { from: provider.name, to: fallback.provider.name, reason: `HTTP ${resp.status}`, mode: 'non-stream' });
     stmts.tokenUsage.insert.run(conversation_id || null, modelId, provider.id, 0, 0, 0, 'failover');
     const fbPType = fallback.provider.type;
     const fbUrl = buildChatUrl(fallback.baseUrl, fbPType, fallback.modelId, false);
     const { headers: fbHeaders, url: fbAuthUrl } = buildProviderAuth(fallback.provider, fbUrl);
     const fbPayload = buildChatPayload(fbPType, fallback.modelId, payload.messages || messages, false);
     const fbBody = JSON.stringify(fbPayload);
     try {
     const fbResp = await fetch(fbAuthUrl, { method: 'POST', headers: fbHeaders, body: fbBody, signal: AbortSignal.timeout(30000) });
     if (fbResp.ok) {
     const fbData = await fbResp.json();
     let fbContent;
     if (fallback.isOllama) fbContent = fbData.message?.content || '';
     else if (fbPType === 'google') fbContent = fbData.candidates?.[0]?.content?.parts?.[0]?.text || '';
     else if (fbPType === 'anthropic') fbContent = fbData.content?.[0]?.text || '';
     else fbContent = fbData.choices?.[0]?.message?.content || '';
       res.setHeader('X-Failover', 'true');
       res.setHeader('X-Failover-Provider', fallback.provider.name);
       if (conversation_id && fbContent) { const mId = randomUUID(); const pT = fbData.usage?.prompt_tokens || 0; const cT = fbData.usage?.completion_tokens || Math.ceil(fbContent.length/4); stmts.messages.insert.run(mId, conversation_id, 'assistant', fbContent, '[]', '[]', null, fallback.modelId, pT, cT); const cost = getModelCost(fallback.modelId, pT, cT); stmts.tokenUsage.insert.run(conversation_id, fallback.modelId, fallback.provider.id, pT, cT, cost, 'inference'); }
       autoObserve(conversation_id, messages, fbContent, fallback.modelId);
       if (fallback.isOllama) { res.json({ id: `ollama-fb-${Date.now()}`, object: 'chat.completion', choices: [{ message: { role: 'assistant', content: fbContent }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: fbData.prompt_eval_count || 0, completion_tokens: fbData.eval_count || 0 } }); }
       else { res.json(fbData); }
       return;
      }
     } catch (fbErr) { logger.error('Non-stream fallback failed:', fbErr.message); }
    }
   }
   const errData = await resp.text();
   return res.status(502).json({ error: { message: `LLM API error (${resp.status}): ${errData.slice(0, 500)}` } });
  }
  const data = await resp.json();
  if (data.error) return res.status(502).json(data);

  // Parse content from provider-native response format
  let content;
  if (isOllama) content = data.message?.content || '';
  else if (pType === 'google') content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  else if (pType === 'anthropic') content = data.content?.[0]?.text || '';
  else content = data.choices?.[0]?.message?.content || '';
  if (conversation_id && content) {
  const msgId = randomUUID();
  let pT, cT;
  if (pType === 'google') { pT = data.usageMetadata?.promptTokenCount || 0; cT = data.usageMetadata?.candidatesTokenCount || Math.ceil(content.length/4); }
  else if (pType === 'anthropic') { pT = data.usage?.input_tokens || 0; cT = data.usage?.output_tokens || Math.ceil(content.length/4); }
  else { pT = data.usage?.prompt_tokens || 0; cT = data.usage?.completion_tokens || (isOllama ? data.eval_count : 0) || Math.ceil(content.length/4); }
  stmts.messages.insert.run(msgId, conversation_id, 'assistant', content, '[]', '[]', null, modelId, pT, cT);
  const cost = getModelCost(modelId, pT, cT);
  stmts.tokenUsage.insert.run(conversation_id, modelId, provider.id, pT, cT, cost, 'inference');
  }
  // Aimi self-learning: observe this interaction
  autoObserve(conversation_id, messages, content, modelId);
  // Fire onChatMessage hook
  fireHook('onChatMessage', { conversationId: conversation_id, role: 'assistant', content, model: modelId, provider: provider?.name });
  // Normalize provider-native response to OpenAI format for the frontend
  if (isOllama) {
  res.json({
  id: `ollama-${Date.now()}`,
  object: 'chat.completion',
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }],
  usage: { prompt_tokens: data.prompt_eval_count || 0, completion_tokens: data.eval_count || 0, total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0) },
  });
  } else if (pType === 'google') {
  res.json({
  id: `google-${Date.now()}`,
  object: 'chat.completion',
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }],
  usage: { prompt_tokens: data.usageMetadata?.promptTokenCount || 0, completion_tokens: data.usageMetadata?.candidatesTokenCount || 0 },
  });
  } else if (pType === 'anthropic') {
  res.json({
  id: data.id || `anthropic-${Date.now()}`,
  object: 'chat.completion',
  choices: [{ message: { role: 'assistant', content }, finish_reason: data.stop_reason || 'stop', index: 0 }],
  usage: { prompt_tokens: data.usage?.input_tokens || 0, completion_tokens: data.usage?.output_tokens || 0 },
  });
  } else {
  res.json(data);
  }
  } catch (err) {
   logger.error('LLM proxy error:', err);
   res.status(502).json({ error: { message: err.message } });
  }
 }
});

// ─── Skills API ──────────────────────────────────────────────────
app.get('/api/skills', optionalAuth, (_req, res) => {
 res.json(stmts.skills.getAll.all());
});

app.get('/api/skills/enabled', optionalAuth, (_req, res) => {
 res.json(stmts.skills.getEnabled.all());
});

app.get('/api/skills/:id', optionalAuth, (req, res) => {
 const skill = stmts.skills.getById.get(req.params.id);
 if (!skill) return res.status(404).json({ error: 'Skill not found' });
 res.json(skill);
});

app.post('/api/skills', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
 const { name, description, category, handler, parameters, enabled, trigger } = req.body;
 if (!name || !handler) return res.status(400).json({ error: 'name and handler required' });
 const existing = stmts.skills.getByName.get(name);
 if (existing) return res.status(409).json({ error: 'Skill already exists' });
 const id = randomUUID();
 stmts.skills.insertWithTrigger.run(id, name, description || '', category || 'general', handler, JSON.stringify(parameters || {}), enabled !== false ? 1 : 0, trigger || '');
 audit('create', 'skill', id, req.user.id, { name, category });
 res.status(201).json({ id, name });
});

app.put('/api/skills/:id', authMiddleware, requireRole('admin'), (req, res) => {
 const skill = stmts.skills.getById.get(req.params.id);
 if (!skill) return res.status(404).json({ error: 'Skill not found' });
 const { description, category, parameters, enabled } = req.body;
 stmts.skills.update.run(description ?? skill.description, category ?? skill.category, JSON.stringify(parameters ?? JSON.parse(skill.parameters)), enabled !== undefined ? (enabled ? 1 : 0) : skill.enabled, req.params.id);
 res.json({ ok: true });
});

app.delete('/api/skills/:id', authMiddleware, requireRole('admin'), (req, res) => {
 const skill = stmts.skills.getById.get(req.params.id);
 if (!skill) return res.status(404).json({ error: 'Skill not found' });
 stmts.skills.delete.run(req.params.id);
 audit('delete', 'skill', req.params.id, req.user.id, { name: skill.name });
 res.json({ ok: true });
});

// ─── Skill Execution Engine ──────────────────────────────────────

/**
 * Execute a skill by evaluating its handler function.
 * Skills are JS function strings: async (input) => { ... return result; }
 * Supports three skill types:
 * 1. Script skills: pure JS function, returns directly
 * 2. Template skills: handler starts with "template:" — uses LLM with the template as system prompt
 * 3. Hybrid skills: handler starts with "hybrid:" — runs JS that can call LLM
 */

// ─── Skill Secret Collection ──────────────────────────────────────
// Whitelisted env var names that skills can access via `secrets.<key>`
const SKILL_SECRET_KEYS = new Set([
  'TAVILY_API_KEY',
  'SHOPIFY_SHOP_DOMAIN',
  'SHOPIFY_ACCESS_TOKEN',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NVIDIA_API_KEY',
  'OPENROUTER_API_KEY',
  'GITHUB_TOKEN',
  'STRIPE_SECRET_KEY',
  'FIGMA_API_TOKEN',
]);

function collectSkillSecrets(skill) {
  const secrets = {};
  for (const key of SKILL_SECRET_KEYS) {
    if (process.env[key]) secrets[key] = process.env[key];
  }
  // Also allow skill-specific secrets declared in skill.parameters.secrets array
  try {
    const params = typeof skill.parameters === 'string' ? JSON.parse(skill.parameters) : (skill.parameters || {});
    const extraKeys = params.secrets || [];
    for (const key of extraKeys) {
      if (process.env[key]) secrets[key] = process.env[key];
    }
  } catch {}
  return secrets;
}

async function executeSkill(skill, input = {}) {
  const handlerStr = skill.handler || '';
  const startTime = Date.now();
  let result;

  try {
    // Template skill — LLM prompt template
    if (handlerStr.startsWith('template:')) {
      const template = handlerStr.slice('template:'.length).trim();
      const llmResult = await callAgentLLM([
        { role: 'system', content: template },
        { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
      ], skill.model || undefined);
      result = {
        ok: true,
        type: 'template',
        output: llmResult.content,
        tokens: { prompt: llmResult.promptTokens, completion: llmResult.completionTokens },
        duration_ms: Date.now() - startTime,
      };
    } else if (handlerStr.startsWith('hybrid:')) {
      // Hybrid skill — JS function that can call LLM and use execSync/fetch
      const code = handlerStr.slice('hybrid:'.length).trim();
      const llmCall = (messages, model) => callAgentLLM(messages, model || skill.model || undefined);
      const secrets = collectSkillSecrets(skill);
      const { result: sandboxResult } = await runSandboxedHybrid({ code, input, llmCall, secrets });
      result = { ok: true, type: 'hybrid', output: sandboxResult, duration_ms: Date.now() - startTime };
    } else {
      // Script skill — pure JS function (sandboxed via vm.runInNewContext)
      const secrets = collectSkillSecrets(skill);
      const { result: sandboxResult } = await runSandboxed({ code: handlerStr, input, secrets });
      result = { ok: true, type: 'script', output: sandboxResult, duration_ms: Date.now() - startTime };
    }
  } catch (err) {
    result = { ok: false, error: err.message, duration_ms: Date.now() - startTime };
  }

  // Fire onSkillExecuted hook
  fireHook('onSkillExecuted', {
    skillId: skill.id,
    skillName: skill.name,
    input,
    output: result.output || result.error,
    success: result.ok,
    durationMs: result.duration_ms,
  });

  return result;
}

/**
 * Check if user input matches a skill trigger.
 * Triggers are comma-separated keywords/phrases.
 * Returns matched skill or null.
 */
function matchSkillTrigger(userInput) {
  if (!userInput || typeof userInput !== 'string') return null;
  const inputLower = userInput.toLowerCase();
  const skills = stmts.skills.getAllWithTrigger.all();

  for (const skill of skills) {
    const triggers = (skill.trigger || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    for (const trigger of triggers) {
      if (inputLower.includes(trigger)) {
        // Check confidence threshold
        const confidence = skill.confidence || 0.5;
        return { skill, trigger, confidence };
      }
    }
  }
  return null;
}

// POST /api/skills/:id/execute — execute a skill with input
app.post('/api/skills/:id/execute', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const skill = stmts.skills.getById.get(req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (!skill.enabled) return res.status(400).json({ error: 'Skill is disabled' });

    const input = req.body.input ?? req.body;
    const result = await executeSkill(skill, input);

    // Update invoke tracking
    stmts.skills.updateInvoke.run(skill.id);

    // Update confidence based on result
    const newSuccess = skill.success_count + (result.ok ? 1 : 0);
    const newFailure = skill.failure_count + (result.ok ? 0 : 1);
    const total = newSuccess + newFailure;
    const newConfidence = total > 0 ? Math.round((newSuccess / total) * 100) / 100 : skill.confidence;
    stmts.skills.updateConfidence.run(newConfidence, newSuccess, newFailure, skill.id);

    broadcast('skill:executed', { skill_id: skill.id, name: skill.name, ok: result.ok, duration_ms: result.duration_ms });
    res.json({ skill_id: skill.id, name: skill.name, ...result, confidence: newConfidence });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/skills/:id/execute — execute by name (convenience)
app.post('/api/skills/execute/:name', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const skill = stmts.skills.getByName.get(req.params.name);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    const input = req.body.input ?? req.body;
    const result = await executeSkill(skill, input);
    stmts.skills.updateInvoke.run(skill.id);
    res.json({ skill_id: skill.id, name: skill.name, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// ─── Skill Chain Endpoints ───────────────────────────────────────
// ═════════════════════════════════════════════════════════════════

// GET /api/chains/skills — list all skill chains
app.get('/api/chains/skills', authMiddleware, (_req, res) => {
  const chains = stmts.skillChains.getAll.all();
  for (const c of chains) c.steps = JSON.parse(c.steps || '[]');
  res.json(chains);
});

// GET /api/chains/skills/:id — get one
app.get('/api/chains/skills/:id', authMiddleware, (req, res) => {
  const chain = stmts.skillChains.getById.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });
  chain.steps = JSON.parse(chain.steps || '[]');
  chain.last_run_result = chain.last_run_result ? JSON.parse(chain.last_run_result) : null;
  res.json(chain);
});

// POST /api/chains/skills — create
app.post('/api/chains/skills', authMiddleware, apiLimiter, (req, res) => {
  const { name, description, steps } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = stmts.skillChains.getByName.get(name);
  if (existing) return res.status(409).json({ error: 'Chain name already exists' });
  const id = crypto.randomUUID();
  stmts.skillChains.insert.run(id, name, description || '', JSON.stringify(steps || []), 'draft', req.user?.id || null);
  res.json({ id, name, description, steps: steps || [], status: 'draft' });
});

// PUT /api/chains/skills/:id — update
app.put('/api/chains/skills/:id', authMiddleware, (req, res) => {
  const existing = stmts.skillChains.getById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Chain not found' });
  const { name, description, steps, status } = req.body;
  stmts.skillChains.update.run(
    name ?? existing.name,
    description ?? existing.description,
    JSON.stringify(steps ?? JSON.parse(existing.steps)),
    status ?? existing.status,
    req.params.id
  );
  const updated = stmts.skillChains.getById.get(req.params.id);
  updated.steps = JSON.parse(updated.steps || '[]');
  res.json(updated);
});

// DELETE /api/chains/skills/:id
app.delete('/api/chains/skills/:id', authMiddleware, (req, res) => {
  stmts.skillChains.delete.run(req.params.id);
  res.json({ ok: true });
});

// POST /api/chains/skills/:id/execute — run a skill chain
app.post('/api/chains/skills/:id/execute', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const chain = stmts.skillChains.getById.get(req.params.id);
    if (!chain) return res.status(404).json({ error: 'Chain not found' });
    const chainInput = req.body.input ?? req.body;
    chain.steps = JSON.parse(chain.steps || '[]');
    chain.name = chain.name;

    // Build a skill lookup function for the executor
    const executeSkillFn = async (step, input) => {
      const skillName = step.skill_name;
      const skill = stmts.skills.getByName.get(skillName);
      if (!skill) throw new Error(`Skill "${skillName}" not found`);
      if (!skill.enabled) throw new Error(`Skill "${skillName}" is disabled`);
      stmts.skills.updateInvoke.run(skill.id);
      return await executeSkill(skill, input);
    };

    const result = await executeSkillChain(chain, chainInput, executeSkillFn, broadcast);
    stmts.skillChains.updateRunResult.run(JSON.stringify(result), result.ok ? 'completed' : 'failed', req.params.id);
    // Track run count for evolution
    try {
      db.prepare('UPDATE skill_chains SET run_count = COALESCE(run_count, 0) + 1, success_count = COALESCE(success_count, 0) + ? WHERE id = ?')
        .run(result.ok ? 1 : 0, req.params.id);
    } catch { /* columns may not exist on fresh DB */ }
    // Record real execution history for evolution promotion
    try {
      stmts.chainExecutions.insert.run(
        crypto.randomUUID(), req.params.id, result.ok ? 1 : 0, result.duration_ms || 0,
        JSON.stringify(chainInput ?? {}).slice(0, 4096),
        JSON.stringify(result.final_output ?? null).slice(0, 4096),
        result.results?.length || 0,
        result.ok ? null : String(result.results?.find(r => r.error)?.error || 'Unknown error').slice(0, 1024)
      );
    } catch (e) { console.error('[chain-exec] Failed to record execution:', e.message); }
    broadcast('chain:executed', { chainId: req.params.id, name: chain.name, ok: result.ok, type: 'skill' });
    fireHook('onSkillExecuted', { skillId: req.params.id, skillName: chain.name, input: chainInput, output: result.final_output, success: result.ok, durationMs: result.duration_ms });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chains/skills/generate — Aimi generates a chain from natural language
app.post('/api/chains/skills/generate', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const skills = stmts.skills.getAll.all().filter(s => s.enabled);
    const tools = stmts.tools.getAll.all().filter(t => t.enabled);
    const systemPrompt = buildChainIntentPrompt('skill', skills, tools);

    const result = await callAgentLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], req.body.model);

    let chainDef;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      chainDef = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      return res.status(422).json({ error: 'Aimi could not generate a valid chain definition', raw: result.content.slice(0, 500) });
    }

    res.json({
      chain: chainDef,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
      model: result.model,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Tool Chain Endpoints ────────────────────────────────────────

// GET /api/chains/tools — list all
app.get('/api/chains/tools', authMiddleware, (_req, res) => {
  const chains = stmts.toolChains.getAll.all();
  for (const c of chains) c.steps = JSON.parse(c.steps || '[]');
  res.json(chains);
});

// GET /api/chains/tools/:id
app.get('/api/chains/tools/:id', authMiddleware, (req, res) => {
  const chain = stmts.toolChains.getById.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });
  chain.steps = JSON.parse(chain.steps || '[]');
  chain.last_run_result = chain.last_run_result ? JSON.parse(chain.last_run_result) : null;
  res.json(chain);
});

// POST /api/chains/tools — create
app.post('/api/chains/tools', authMiddleware, apiLimiter, (req, res) => {
  const { name, description, steps } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = stmts.toolChains.getByName.get(name);
  if (existing) return res.status(409).json({ error: 'Chain name already exists' });
  const id = crypto.randomUUID();
  stmts.toolChains.insert.run(id, name, description || '', JSON.stringify(steps || []), 'draft', req.user?.id || null);
  res.json({ id, name, description, steps: steps || [], status: 'draft' });
});

// PUT /api/chains/tools/:id
app.put('/api/chains/tools/:id', authMiddleware, (req, res) => {
  const existing = stmts.toolChains.getById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Chain not found' });
  const { name, description, steps, status } = req.body;
  stmts.toolChains.update.run(
    name ?? existing.name,
    description ?? existing.description,
    JSON.stringify(steps ?? JSON.parse(existing.steps)),
    status ?? existing.status,
    req.params.id
  );
  const updated = stmts.toolChains.getById.get(req.params.id);
  updated.steps = JSON.parse(updated.steps || '[]');
  res.json(updated);
});

// DELETE /api/chains/tools/:id
app.delete('/api/chains/tools/:id', authMiddleware, (req, res) => {
  stmts.toolChains.delete.run(req.params.id);
  res.json({ ok: true });
});

// POST /api/chains/tools/:id/execute — run a tool chain
app.post('/api/chains/tools/:id/execute', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const chain = stmts.toolChains.getById.get(req.params.id);
    if (!chain) return res.status(404).json({ error: 'Chain not found' });
    const chainInput = req.body.input ?? req.body;
    chain.steps = JSON.parse(chain.steps || '[]');

    // Build tool call function — makes HTTP requests to internal endpoints
    const callToolFn = async (step, input) => {
      const tool = stmts.tools.getByName.get(step.tool_name);
      if (!tool) throw new Error(`Tool "${step.tool_name}" not found`);
      const method = step.method || tool.method || 'GET';
      const endpoint = step.endpoint || tool.endpoint;
      const url = `http://localhost:${PORT}${endpoint}`;

      const fetchOpts = { method, headers: { 'Content-Type': 'application/json' } };
      if (method !== 'GET' && method !== 'HEAD') {
        fetchOpts.body = JSON.stringify(input || {});
      }

      const resp = await fetch(url, fetchOpts);
      const data = await resp.json();
      return data;
    };

    const result = await executeToolChain(chain, chainInput, callToolFn, broadcast);
    stmts.toolChains.updateRunResult.run(JSON.stringify(result), result.ok ? 'completed' : 'failed', req.params.id);
    broadcast('chain:executed', { chainId: req.params.id, name: chain.name, ok: result.ok, type: 'tool' });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/chains/tools/generate — Aimi generates a tool chain from natural language
app.post('/api/chains/tools/generate', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const skills = stmts.skills.getAll.all().filter(s => s.enabled);
    const tools = stmts.tools.getAll.all().filter(t => t.enabled);
    const systemPrompt = buildChainIntentPrompt('tool', skills, tools);

    const result = await callAgentLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ], req.body.model);

    let chainDef;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      chainDef = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      return res.status(422).json({ error: 'Aimi could not generate a valid chain definition', raw: result.content.slice(0, 500) });
    }

    res.json({
      chain: chainDef,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
      model: result.model,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// ─── Auto-Skill Authoring (Distill) ─────────────────────────────
// ═════════════════════════════════════════════════════════════════

// POST /api/learn/distill — Aimi analyzes a conversation and auto-creates a skill
app.post('/api/learn/distill', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { conversation_id } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

    const observations = stmts.observations.getByConversation.all(conversation_id);
    const messages = stmts.messages.getByConversation.all(conversation_id);
    if (observations.length === 0 && messages.length === 0)
      return res.status(404).json({ error: 'No observations or messages found for this conversation' });

    const systemPrompt = buildDistillPrompt(observations, messages);
    const result = await callAgentLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Distill this conversation into a reusable skill.' },
    ], req.body.model);

    let skillDef;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      skillDef = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      return res.status(422).json({ error: 'Aimi could not generate a valid skill definition', raw: result.content.slice(0, 500) });
    }

    // Security scan the handler before saving
    const scan = scanSkillHandler(skillDef.handler, skillDef.name);
    if (scan.verdict === 'blocked') {
      return res.status(403).json({ error: 'Generated skill handler blocked by security scanner', scan });
    }

    // Save as auto-proposed skill
    const skillId = crypto.randomUUID();
    const handler = skillDef.handler_type === 'script' ? skillDef.handler
      : skillDef.handler_type === 'hybrid' ? `hybrid:${skillDef.handler}`
      : `template:${skillDef.handler}`;

    stmts.skills.insertWithConfidence.run(
      skillId, skillDef.name, skillDef.description, skillDef.category || 'general',
      handler, JSON.stringify(skillDef.parameters || {}), 1,
      skillDef.confidence || 0.7, 1
    );

    // Record evolution
    const evoId = crypto.randomUUID();
    stmts.evolution.insert.run(evoId, skillId, null, 1, 'auto-distill', null, conversation_id, `Auto-distilled from conversation ${conversation_id}`);

    broadcast('skill:distilled', { skillId, name: skillDef.name, confidence: skillDef.confidence });
    res.json({
      skill: { id: skillId, ...skillDef },
      scan,
      evolution_id: evoId,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════
// ─── Skill Evolution (Chain Promotion) ──────────────────────────
// ═════════════════════════════════════════════════════════════════

// GET /api/evolution — list all evolution records (admin only)
app.get('/api/evolution', authMiddleware, requireRole('admin'), (_req, res) => {
  res.json(stmts.evolution.getAll.all());
});

// GET /api/evolution/skill/:id — get evolution history for a skill (admin only)
app.get('/api/evolution/skill/:id', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(stmts.evolution.getBySkill.all(req.params.id));
});

// GET /api/evolution/chain/:id — check if a chain is ready to evolve
app.get('/api/evolution/chain/:id/check', authMiddleware, (req, res) => {
  const chain = stmts.skillChains.getById.get(req.params.id);
  if (!chain) return res.status(404).json({ error: 'Chain not found' });

  // Use real execution history from chain_executions table
  let realHistory = [];
  try {
    realHistory = stmts.chainExecutions.getRecentByChain.all(req.params.id)
      .map(e => ({ ok: Boolean(e.success), duration_ms: e.duration_ms, step_count: e.step_count, error: e.error }));
  } catch { /* table may not exist */ }

  const runCount = chain.run_count || realHistory.length;
  const successCount = chain.success_count || realHistory.filter(r => r.ok).length;
  const evaluation = shouldEvolveChain(chain, realHistory);
  res.json({ ...evaluation, run_count: runCount, success_count: successCount, executions: realHistory.length });
});

// POST /api/evolution/chain/:id/promote — promote a chain to an evolved skill
app.post('/api/evolution/chain/:id/promote', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const chain = stmts.skillChains.getById.get(req.params.id);
    if (!chain) return res.status(404).json({ error: 'Chain not found' });
    chain.steps = JSON.parse(chain.steps || '[]');

    const runCount = chain.run_count || 0;
    const successCount = chain.success_count || 0;

    // Fetch real execution history for the LLM prompt
    let realHistory = [];
    try {
      realHistory = stmts.chainExecutions.getRecentByChain.all(req.params.id)
        .map(e => ({
          ok: Boolean(e.success),
          duration_ms: e.duration_ms,
          step_count: e.step_count,
          error: e.error,
          created_at: e.created_at,
        }));
    } catch { /* table may not exist */ }

    // Check if eligible using real history
    const eval_ = shouldEvolveChain(chain, realHistory);
    if (!eval_.ready) {
      return res.status(400).json({ error: 'Chain not ready for promotion', ...eval_ });
    }

    // Use real execution history for the evolution prompt
    const evoPrompt = buildEvolutionPrompt(chain, realHistory.slice(0, 10));
    const result = await callAgentLLM([
      { role: 'system', content: evoPrompt },
      { role: 'user', content: 'Evaluate and promote this chain.' },
    ], req.body.model);

    let evoDef;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      evoDef = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      return res.status(422).json({ error: 'Aimi could not generate an evolution definition', raw: result.content.slice(0, 500) });
    }

    if (!evoDef.should_promote) {
      return res.json({ promoted: false, reason: evoDef.reason, evaluation: eval_ });
    }

    // Security scan the evolved handler
    const scan = scanSkillHandler(evoDef.handler, evoDef.skill_name);
    if (scan.verdict !== 'passed') {
      return res.status(403).json({ error: `Evolved handler failed security scan: ${scan.verdict}`, scan });
    }

    // Create the evolved skill
    const skillId = crypto.randomUUID();
    const handler = evoDef.handler_type === 'hybrid' ? `hybrid:${evoDef.handler}` : evoDef.handler;

    stmts.skills.insertWithConfidence.run(
      skillId, evoDef.skill_name, evoDef.skill_description, 'evolved',
      handler, JSON.stringify({}), 1, evoDef.confidence || 0.8, 1
    );

    // Record evolution
    const evoId = crypto.randomUUID();
    stmts.evolution.insert.run(evoId, skillId, req.params.id, 2, 'chain-promotion', null,
      `chain:${chain.name}`, `Promoted from chain "${chain.name}" (${successCount}/${runCount} successful runs)`);

    // Mark chain as evolved
    try { db.prepare('UPDATE skill_chains SET evolved_to_skill = ? WHERE id = ?').run(skillId, req.params.id); } catch {}

    broadcast('skill:evolved', { skillId, name: evoDef.skill_name, fromChain: chain.name, chainId: req.params.id });
    res.json({
      promoted: true,
      skill: { id: skillId, ...evoDef },
      scan,
      evolution_id: evoId,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/evolution/:id/optimal — mark an evolution as the optimal version (admin only)
app.patch('/api/evolution/:id/optimal', authMiddleware, requireRole('admin'), (req, res) => {
  // Check existence first
  const evo = stmts.evolution.getById?.get(req.params.id);
  if (!evo) return res.status(404).json({ error: 'Evolution record not found' });

  // Clear all other optimal flags for the same skill, then set this one
  try {
    db.prepare('UPDATE skill_evolution SET optimal = 0 WHERE skill_id = ?').run(evo.skill_id);
  } catch { /* ignore */ }
  const result = stmts.evolution.markOptimal.run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Evolution record not found' });
  res.json({ ok: true, optimal: true });
});

// ═════════════════════════════════════════════════════════════════
// ─── Skill Hub (Install/Export with Security) ───────────────────
// ═════════════════════════════════════════════════════════════════

// GET /api/skills/hub/sources — list all skill hub sources
app.get('/api/skills/hub/sources', authMiddleware, (_req, res) => {
  res.json(stmts.skillHub.getAll.all());
});

// POST /api/skills/hub/sources — register a new skill hub source (admin only)
app.post('/api/skills/hub/sources', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  const { name, url, type = 'git' } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });

  // Validate URL scheme — only https allowed (blocks http://, file://, etc.)
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'URL must use https:// scheme' });
    }
    // Block internal/private IPs (SSRF protection)
    const hostname = parsed.hostname;
    const blockedPatterns = [
      /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
      /^169\.254\./, // link-local (AWS metadata)
      /^0\./, /^localhost$/i,
      /^::1$/, /^fe80:/, /^fc00:/i, /^fd00:/i, // IPv6 internal
    ];
    if (blockedPatterns.some(re => re.test(hostname))) {
      return res.status(400).json({ error: 'Internal/private host addresses are not allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const id = crypto.randomUUID();
  stmts.skillHub.insert.run(id, name, url, type, 0, 0, 'pending');
  res.json({ id, name, url, type, scan_status: 'pending' });
});

// POST /api/skills/hub/sources/:id/scan — security scan a hub source (admin only)
app.post('/api/skills/hub/sources/:id/scan', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const source = stmts.skillHub.getById.get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    stmts.skillHub.updateScan.run('scanning', null, 0, req.params.id);

    // Validate URL again before fetching
    const parsed = new URL(source.url);
    if (parsed.protocol !== 'https:') {
      stmts.skillHub.updateScan.run('failed', 'Non-https URL blocked', 0, req.params.id);
      return res.status(400).json({ error: 'Non-https URL blocked' });
    }

    // Fetch the skill manifest from the URL
    let manifestUrl = source.url;
    if (manifestUrl.endsWith('.git')) manifestUrl = manifestUrl.slice(0, -4);
    if (manifestUrl.includes('github.com')) {
      manifestUrl = manifestUrl.replace('github.com', 'raw.githubusercontent.com') + '/main/skill.json';
    }

    const resp = await fetch(manifestUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      // Cap error message to prevent storage DoS
      const err = `HTTP ${resp.status}`.slice(0, 256);
      stmts.skillHub.updateScan.run('failed', err, 0, req.params.id);
      return res.json({ verdict: 'failed', error: `Could not fetch manifest: HTTP ${resp.status}` });
    }

    const manifest = await resp.json();
    const skills = Array.isArray(manifest) ? manifest : [manifest];
    const allIssues = [];

    for (const skill of skills) {
      const scan = scanSkillHandler(skill.handler, skill.name);
      allIssues.push({ skill: skill.name, ...scan });
    }

    const blocked = allIssues.some(s => s.verdict === 'blocked');
    const failed = allIssues.some(s => s.verdict === 'failed');
    const verdict = blocked ? 'blocked' : failed ? 'failed' : 'passed';
    const trustScore = allIssues.filter(s => s.verdict === 'passed').length / allIssues.length;

    // Cap scan result to 64KB to prevent storage DoS
    const resultStr = JSON.stringify(allIssues).slice(0, 65536);
    stmts.skillHub.updateScan.run(verdict, resultStr, trustScore, req.params.id);
    res.json({ verdict, trust_score: trustScore, scans: allIssues });
  } catch (e) {
    stmts.skillHub.updateScan.run('failed', e.message, 0, req.params.id);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skills/hub/sources/:id/install — install a scanned-and-passed skill (admin only)
app.post('/api/skills/hub/sources/:id/install', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const source = stmts.skillHub.getById.get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (source.scan_status !== 'passed') return res.status(403).json({ error: `Source scan status is "${source.scan_status}" — must be "passed" to install` });

    // Re-fetch and install
    let manifestUrl = source.url;
    if (manifestUrl.endsWith('.git')) manifestUrl = manifestUrl.slice(0, -4);
    if (manifestUrl.includes('github.com')) {
      manifestUrl = manifestUrl.replace('github.com', 'raw.githubusercontent.com') + '/main/skill.json';
    }

    const resp = await fetch(manifestUrl);
    if (!resp.ok) return res.status(502).json({ error: `Failed to fetch: HTTP ${resp.status}` });

    const manifest = await resp.json();
    const skills = Array.isArray(manifest) ? manifest : [manifest];
    const installed = [];

    for (const skill of skills) {
      // Double-check scan — only install if verdict is EXACTLY 'passed'
      const scan = scanSkillHandler(skill.handler, skill.name);
      if (scan.verdict !== 'passed') {
        installed.push({ name: skill.name, installed: false, reason: `Security scan verdict: ${scan.verdict}` });
        continue;
      }

      const skillId = crypto.randomUUID();
      const existing = stmts.skills.getByName.get(skill.name);
      if (existing) {
        installed.push({ name: skill.name, installed: false, reason: 'Skill with this name already exists' });
        continue;
      }

      stmts.skills.insertWithConfidence.run(
        skillId, skill.name, skill.description || '', skill.category || 'hub',
        skill.handler, JSON.stringify(skill.parameters || {}), 1, 0.5, 1
      );

      const evoId = crypto.randomUUID();
      stmts.evolution.insert.run(evoId, skillId, null, 1, 'skill-hub', null, `hub:${source.name}`, `Installed from skill hub source "${source.name}"`);
      installed.push({ name: skill.name, installed: true, id: skillId });
    }

    stmts.skillHub.updateInstalled.run(JSON.stringify(installed), req.params.id);
    broadcast('skill:hub:installed', { sourceId: req.params.id, installed });
    res.json({ installed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/skills/hub/sources/:id
app.delete('/api/skills/hub/sources/:id', authMiddleware, (req, res) => {
  stmts.skillHub.delete.run(req.params.id);
  res.json({ ok: true });
});

// GET /api/skills/export/:name — export a skill as portable JSON (admin only)
app.get('/api/skills/export/:name', authMiddleware, requireRole('admin'), (req, res) => {
  const skill = stmts.skills.getByName.get(req.params.name);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });
  const exportData = {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    handler: skill.handler,
    parameters: JSON.parse(skill.parameters || '{}'),
    trigger: skill.trigger || '',
    version: skill.version || '1.0.0',
    exported_at: new Date().toISOString(),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${skill.name}.json"`);
  res.json(exportData);
});

// ═════════════════════════════════════════════════════════════════
// ─── Heartbeat Rules ─────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════

// GET /api/heartbeat/rules — list all heartbeat rules
app.get('/api/heartbeat/rules', authMiddleware, (_req, res) => {
  res.json(stmts.heartbeat.getAll.all());
});

// POST /api/heartbeat/rules — create a heartbeat rule (admin only)
app.post('/api/heartbeat/rules', authMiddleware, requireRole('admin'), (req, res) => {
  const { name, description, condition, action_type, action_target, action_input, cooldown_seconds } = req.body;
  if (!name || !condition || !action_type || !action_target)
    return res.status(400).json({ error: 'name, condition, action_type, action_target required' });

  // Validate action_type — webhook is not implemented yet
  const validActions = ['chain', 'skill', 'alert'];
  if (!validActions.includes(action_type))
    return res.status(400).json({ error: `action_type must be one of: ${validActions.join(', ')}` });

  // Validate condition is single-line (no newline injection)
  if (typeof condition !== 'string' || condition.includes('\n') || condition.includes('\r'))
    return res.status(400).json({ error: 'Condition must be a single-line expression' });

  // Pre-validate condition: only allow known state categories + comparison operators
  const validStateRef = /^(agents|tasks|chains|skills|providers|schedules|messages)\.(total|active|stale|pending|running|failed|enabled)$/;
  // Extract all word.word patterns and check if they're all valid state refs
  const refs = condition.match(/\b\w+\.\w+\b/g) || [];
  for (const ref of refs) {
    if (!validStateRef.test(ref)) {
      return res.status(400).json({ error: `Unknown state reference "${ref}". Valid refs: agents.total, agents.active, agents.stale, tasks.pending, tasks.running, tasks.failed, chains.total, chains.failed, skills.total, skills.enabled, providers.total, providers.enabled, schedules.total, schedules.enabled, messages.pending` });
    }
  }
  // After removing valid state refs and boolean literals, remaining chars must be safe
  const condStripped = condition
    .replace(/\b\w+\.\w+\b/g, '0')
    .replace(/\btrue\b/g, '1')
    .replace(/\bfalse\b/g, '0');
  // Any remaining identifier means function calls, property access, etc.
  if (/\b[a-zA-Z_]\w*\b/.test(condStripped)) {
    return res.status(400).json({ error: 'Condition contains invalid identifiers. Only state refs and comparison/boolean operators are allowed' });
  }
  if (!/^[\d\s<>=!&|().]+$/.test(condStripped)) {
    return res.status(400).json({ error: 'Condition contains invalid characters' });
  }

  const id = crypto.randomUUID();
  stmts.heartbeat.insert.run(id, name, description || '', condition, action_type, action_target,
    JSON.stringify(action_input || {}), cooldown_seconds || 300);
  res.json({ id, name, condition, action_type, action_target, enabled: 1 });
});

// PATCH /api/heartbeat/rules/:id/toggle
app.patch('/api/heartbeat/rules/:id/toggle', authMiddleware, (req, res) => {
  const rule = stmts.heartbeat.getById.get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  stmts.heartbeat.updateEnabled.run(rule.enabled ? 0 : 1, req.params.id);
  res.json({ ok: true, enabled: !rule.enabled });
});

// DELETE /api/heartbeat/rules/:id
app.delete('/api/heartbeat/rules/:id', authMiddleware, (req, res) => {
  stmts.heartbeat.delete.run(req.params.id);
  res.json({ ok: true });
});

// GET /api/heartbeat/state — get current system state (what heartbeat sees)
app.get('/api/heartbeat/state', authMiddleware, (_req, res) => {
  if (globalThis._heartbeat) {
    res.json(globalThis._heartbeat.collectState());
  } else {
    res.json({ error: 'Heartbeat not running' });
  }
});

// GET /api/skills/match/:input — find skills that match user input
app.get('/api/skills/match/:input', authMiddleware, (req, res) => {
  try {
    const match = matchSkillTrigger(decodeURIComponent(req.params.input));
    if (!match) return res.json({ matched: false });
    res.json({
      matched: true,
      trigger: match.trigger,
      skill: {
        id: match.skill.id,
        name: match.skill.name,
        description: match.skill.description,
        category: match.skill.category,
        confidence: match.confidence,
        trigger: match.trigger,
      },
      should_auto_invoke: match.confidence >= 0.8,
      should_suggest: match.confidence >= 0.5 && match.confidence < 0.8,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/skills/seed — seed built-in skill library
app.post('/api/skills/seed', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const seeded = [];
    const skipped = [];

    for (const s of SEED_SKILLS) {
      const existing = stmts.skills.getByName.get(s.name);
      if (existing) { skipped.push(s.name); continue; }
      const id = randomUUID();
      stmts.skills.insertFull.run(
        id, s.name, s.description, s.category, s.handler,
        JSON.stringify(s.parameters || {}), 1, s.confidence || 0.5, 0,
        s.trigger || '', 1
      );
      seeded.push(s.name);
    }

    audit('seed', 'skills', null, req.user.id, { seeded: seeded.length, skipped: skipped.length });
    broadcast('skill:seeded', { seeded, skipped });

    // Seed chain templates
    const SEED_CHAIN_TEMPLATES = [
      {
        name: 'research-and-summarize',
        description: 'Research a topic and summarize the findings into a concise report',
        steps: [
          { skill_name: 'web-research', name: 'Research', input_mapping: { query: '$input' } },
          { skill_name: 'paper-summarize', name: 'Summarize', input_mapping: { text: '$prev.output' } },
        ],
      },
      {
        name: 'audit-and-report',
        description: 'Run deployment audit checks and generate an actionable report',
        steps: [
          { skill_name: 'deploy-check', name: 'Audit Deploy', input_mapping: { service: '$input' } },
          { skill_name: 'log-analyzer', name: 'Analyze Logs', input_mapping: { logs: '$prev.output' } },
          { skill_name: 'paper-summarize', name: 'Generate Report', input_mapping: { text: '$prev.output' } },
        ],
      },
      {
        name: 'build-and-deploy',
        description: 'Run build checks, execute build, and verify deployment health',
        steps: [
          { skill_name: 'code-linter', name: 'Lint Code', input_mapping: { path: '$input' } },
          { skill_name: 'deploy-check', name: 'Deploy & Check', input_mapping: { service: '$prev.output' } },
        ],
      },
      {
        name: 'monitor-and-respond',
        description: 'Check system health and auto-respond to issues with corrective actions',
        steps: [
          { skill_name: 'monitor-check', name: 'Monitor', input_mapping: {} },
          { skill_name: 'incident-responder', name: 'Respond', input_mapping: { alerts: '$prev.output' } },
        ],
      },
      {
        name: 'research-to-landing-page',
        description: 'Research a product topic and generate a landing page from findings',
        steps: [
          { skill_name: 'web-research', name: 'Research Topic', input_mapping: { query: '$input' } },
          { skill_name: 'paper-summarize', name: 'Extract Key Points', input_mapping: { text: '$prev.output' } },
          { skill_name: 'landing-page-generator', name: 'Generate Landing Page', input_mapping: { product: '$prev.output' } },
        ],
      },
    ];

    let chainsSeeded = 0;
    for (const tmpl of SEED_CHAIN_TEMPLATES) {
      const existing = stmts.skillChains.getByName.get(tmpl.name);
      if (existing) continue;
      const id = crypto.randomUUID();
      stmts.skillChains.insert.run(id, tmpl.name, tmpl.description, JSON.stringify(tmpl.steps), 'template', req.user?.id || null);
      chainsSeeded++;
    }

    res.json({ seeded, skipped, chains_seeded: chainsSeeded, total_seeded: seeded.length, total_skipped: skipped.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Seed Skill Library (20 built-in skills) ─────────────────────
const SEED_SKILLS = [
  // DevOps
  {
    name: 'deploy-check',
    description: 'Check deployment status and health of services',
    category: 'devops',
    trigger: 'deploy,deployment,status check',
    confidence: 0.7,
    parameters: { type: 'script' },
    handler: `async (input) => {
      // execSync is injected by the skill runtime
      try {
        const ps = execSync('ps aux --sort=-%mem | head -10', { timeout: 5000, encoding: 'utf-8' });
        const disks = execSync('df -h', { timeout: 5000, encoding: 'utf-8' });
        return { processes: ps, disk_usage: disks, status: 'healthy' };
      } catch (e) { return { error: e.message, status: 'check_failed' }; }
    }`,
  },
  {
    name: 'log-analyzer',
    description: 'Analyze log files for errors and patterns',
    category: 'devops',
    trigger: 'log,logs,error log,analyze log',
    confidence: 0.6,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      // execSync is injected by the skill runtime
      const logPath = input.path || input;
      try {
        const cmd = 'tail -100 ' + logPath;
        const logs = execSync(cmd, { timeout: 5000, encoding: 'utf-8' });
        const errors = logs.split('\\n').filter(l => /error|ERROR|Error/.test(l));
        const llmResult = await llmCall([
          { role: 'system', content: 'Analyze these log errors and suggest fixes. Be concise.' },
          { role: 'user', content: 'Errors found:\\n' + errors.join('\\n').slice(0, 2000) }
        ]);
        return { total_lines: logs.split('\\n').length, error_count: errors.length, analysis: llmResult.content };
      } catch (e) { return { error: e.message }; }
    `,
  },
  {
    name: 'health-probe',
    description: 'Probe a URL for health check response',
    category: 'devops',
    trigger: 'health check,probe,ping url',
    confidence: 0.7,
    parameters: { type: 'script' },
    handler: `async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url) return { error: 'url required' };
      const start = Date.now();
      try {
        const resp = await fetch(url, { timeout: 10000 });
        return { url, status: resp.status, ok: resp.ok, response_time_ms: Date.now() - start };
      } catch (e) { return { url, error: e.message, response_time_ms: Date.now() - start }; }
    }`,
  },
  // Development
  {
    name: 'code-review',
    description: 'Review code using LLM analysis. Pass code as input.',
    category: 'development',
    trigger: 'review,code review,review code',
    confidence: 0.8,
    parameters: { type: 'template' },
    handler: `template:You are a senior code reviewer. Review the provided code for:
- Bugs and potential issues
- Security vulnerabilities
- Performance improvements
- Code style and best practices

Be concise. Use bullet points. Rate severity as CRITICAL/WARN/INFO.`,
  },
  {
    name: 'refactor-suggest',
    description: 'Suggest refactoring improvements for code',
    category: 'development',
    trigger: 'refactor,refactor code,clean up code',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a refactoring expert. Analyze the provided code and suggest:
1. Extract method opportunities
2. Simplification candidates
3. Dead code removal
4. Better naming

Be concise. Show before/after snippets where relevant.`,
  },
  {
    name: 'debug-trace',
    description: 'Help debug an error by analyzing the stack trace',
    category: 'development',
    trigger: 'debug,stack trace,error trace,bug',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a debugging expert. Analyze the error/stack trace and:
1. Identify the root cause
2. List the call chain
3. Suggest a fix with code
4. Note any related edge cases

Be concise and direct.`,
  },
  // Research
  {
    name: 'web-research',
    description: 'Search the web and summarize findings',
    category: 'research',
    trigger: 'search,research,look up,find information',
    confidence: 0.6,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const query = typeof input === 'string' ? input : input.query;
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (!tavilyKey) return { error: 'Tavily API key not configured' };
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5 })
      });
      const data = await resp.json();
      const results = (data.results || []).map(r => r.title + ': ' + r.url);
      const summary = await llmCall([
        { role: 'system', content: 'Summarize these search results concisely.' },
        { role: 'user', content: results.join('\\n') }
      ]);
      return { query, results: data.results || [], summary: summary.content };
    `,
  },
  {
    name: 'paper-summarize',
    description: 'Summarize a research paper or long text',
    category: 'research',
    trigger: 'summarize paper,summarize research,abstract',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a research assistant. Summarize the provided text as:
1. One-paragraph executive summary
2. Key findings (bullet points)
3. Methodology notes
4. Relevance to software engineering

Be concise.`,
  },
  {
    name: 'fact-check',
    description: 'Fact-check a claim using web search',
    category: 'research',
    trigger: 'fact check,verify,is this true',
    confidence: 0.6,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const claim = typeof input === 'string' ? input : input.claim;
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (!tavilyKey) return { error: 'Tavily API key not configured' };
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query: claim, max_results: 3 })
      });
      const data = await resp.json();
      const analysis = await llmCall([
        { role: 'system', content: 'Fact-check this claim based on search results. Rate as TRUE/PARTIALLY_TRUE/FALSE/UNVERIFIABLE.' },
        { role: 'user', content: 'Claim: ' + claim + '\\n\\nResults: ' + JSON.stringify(data.results || []).slice(0, 2000) }
      ]);
      return { claim, verdict: analysis.content, sources: (data.results || []).map(r => r.url) };
    `,
  },
  // Productivity
  {
    name: 'task-breakdown',
    description: 'Break down a complex task into smaller steps',
    category: 'productivity',
    trigger: 'break down,task breakdown,split task,decompose',
    confidence: 0.8,
    parameters: { type: 'template' },
    handler: `template:You are a project manager. Break down the described task into:
1. Ordered steps (numbered)
2. Estimated complexity per step (S/M/L)
3. Dependencies between steps
4. Potential blockers

Be concise. Max 10 steps.`,
  },
  {
    name: 'status-report',
    description: 'Generate a status report from recent activity',
    category: 'productivity',
    trigger: 'status report,progress report,standup',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a team lead. Generate a daily status report:
1. What was accomplished (bullet points)
2. What's in progress
3. Blockers/risks
4. Plan for next period

Format as a concise email-ready report.`,
  },
  {
    name: 'meeting-notes',
    description: 'Format meeting notes from raw transcript or points',
    category: 'productivity',
    trigger: 'meeting notes,minutes,meeting summary',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are a meeting scribe. Format the raw notes into:
1. Attendees (if mentioned)
2. Key decisions
3. Action items (with owners if mentioned)
4. Next steps

Be concise. Use markdown.`,
  },
  // Data
  {
    name: 'sql-query',
    description: 'Generate SQL query from natural language description',
    category: 'data',
    trigger: 'sql,sql query,database query,write sql',
    confidence: 0.8,
    parameters: { type: 'template' },
    handler: `template:You are a SQL expert. Generate a SQL query based on the natural language request.
Rules:
- Use standard SQL (SQLite-compatible)
- Add comments explaining each CTE or complex join
- Include LIMIT 100 by default
- Return ONLY the SQL in a code block`,
  },
  {
    name: 'data-profile',
    description: 'Profile a dataset — describe its structure',
    category: 'data',
    trigger: 'data profile,describe data,dataset analysis',
    confidence: 0.6,
    parameters: { type: 'template' },
    handler: `template:You are a data analyst. Analyze the provided data and report:
1. Structure (rows, columns, types)
2. Missing values
3. Statistical summary
4. Anomalies/outliers
5. Suggested visualizations

Be concise.`,
  },
  // AI
  {
    name: 'prompt-optimize',
    description: 'Optimize an LLM prompt for better results',
    category: 'ai',
    trigger: 'optimize prompt,prompt improvement,better prompt',
    confidence: 0.8,
    parameters: { type: 'template' },
    handler: `template:You are a prompt engineering expert. Improve the given prompt:
1. Identify weaknesses
2. Provide the optimized version
3. Explain key changes
4. Suggest edge cases to test

Return the optimized prompt in a code block.`,
  },
  {
    name: 'model-compare',
    description: 'Compare LLM models for a given use case',
    category: 'ai',
    trigger: 'compare models,model comparison,which model',
    confidence: 0.7,
    parameters: { type: 'template' },
    handler: `template:You are an AI model expert. Compare models for the described use case:
1. Recommend top 3 models
2. Compare on: context length, cost, speed, quality
3. Note any caveats
4. Suggest a fallback model

Be concise. Use a comparison table format.`,
  },
  // System
  {
    name: 'disk-check',
    description: 'Check disk usage and find large files',
    category: 'system',
    trigger: 'disk usage,disk space,storage check,large files',
    confidence: 0.7,
    parameters: { type: 'script' },
    handler: `async (input) => {
      // execSync is injected by the skill runtime
      try {
        const df = execSync('df -h', { timeout: 5000, encoding: 'utf-8' });
        const big = execSync('find / -type f -size +100M 2>/dev/null | head -20', { timeout: 10000, encoding: 'utf-8' });
        return { disk_usage: df, large_files: big };
      } catch (e) { return { error: e.message }; }
    }`,
  },
  {
    name: 'port-scan',
    description: 'Scan for open ports on localhost',
    category: 'system',
    trigger: 'port scan,open ports,what ports',
    confidence: 0.6,
    parameters: { type: 'script' },
    handler: `async (input) => {
      // execSync is injected by the skill runtime
      try {
        const ports = execSync('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', { timeout: 5000, encoding: 'utf-8' });
        return { open_ports: ports };
      } catch (e) { return { error: e.message }; }
    }`,
  },
  {
    name: 'git-status',
    description: 'Show git status, recent commits, and branch info',
    category: 'system',
    trigger: 'git status,git log,git branch',
    confidence: 0.8,
    parameters: { type: 'script' },
    handler: `async (input) => {
      const cwd = typeof input === 'string' ? input : (input.cwd || '/home/haz');
      const result = {};
      try { result.status = execSync('git status --short', { timeout: 5000, cwd, encoding: 'utf-8' }) || 'clean'; } catch { result.status = 'git not available or not a repo'; }
      try { result.recent_commits = execSync('git log --oneline -5', { timeout: 5000, cwd, encoding: 'utf-8' }); } catch { result.recent_commits = ''; }
      try { result.branch = execSync('git branch --show-current', { timeout: 5000, cwd, encoding: 'utf-8' }).trim() || 'unknown'; } catch { result.branch = 'unknown'; }
      return result;
    }`,
  },
  {
    name: 'process-kill',
    description: 'Find and optionally kill a process by name',
    category: 'system',
    trigger: 'kill process,find process,process info',
    confidence: 0.5,
    parameters: { type: 'script' },
    handler: `async (input) => {
      // execSync is injected by the skill runtime
      const name = typeof input === 'string' ? input : input.name;
      if (!name) return { error: 'process name required' };
      try {
        const ps = execSync('pgrep -a ' + name, { timeout: 5000, encoding: 'utf-8' });
        return { processes: ps, killed: false, note: 'Set kill=true to terminate' };
      } catch (e) { return { error: 'No processes found', name }; }
    }`,
  },
  // ── Shopify ──────────────────────────────────────────────────
  {
    name: 'shopify-products',
    description: 'List, search, or get details of Shopify products via Admin API',
    category: 'shopify',
    trigger: 'shopify products,list products,product catalog,shop products',
    confidence: 0.8,
    parameters: { type: 'hybrid', secrets: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'] },
    handler: `hybrid:
      const domain = secrets.SHOPIFY_SHOP_DOMAIN;
      const token = secrets.SHOPIFY_ACCESS_TOKEN;
      if (!domain || !token) return { error: 'Shopify credentials not configured. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN env vars.' };
      const action = input.action || 'list';
      const lim = input.limit || 50;
      const url = 'https://' + domain + '/admin/api/2024-01/products.json?limit=' + lim;
      const resp = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!resp.ok) {
        const err = await resp.text();
        return { error: 'Shopify API error (' + resp.status + '): ' + err.slice(0, 300) };
      }
      const data = await resp.json();
      const products = (data.products || []).map(p => ({
        id: p.id, title: p.title, vendor: p.vendor,
        status: p.status, variants: (p.variants || []).length,
        price: p.variants?.[0]?.price || null,
        inventory: p.variants?.reduce((s, v) => s + (v.inventory_quantity || 0), 0) || 0,
        tags: p.tags, image: p.image?.src || null,
      }));
      return { count: products.length, products };
    `,
  },
  {
    name: 'shopify-orders',
    description: 'List recent Shopify orders with customer and fulfillment info',
    category: 'shopify',
    trigger: 'shopify orders,recent orders,order history,fulfillment status',
    confidence: 0.8,
    parameters: { type: 'hybrid', secrets: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'] },
    handler: `hybrid:
      const domain = secrets.SHOPIFY_SHOP_DOMAIN;
      const token = secrets.SHOPIFY_ACCESS_TOKEN;
      if (!domain || !token) return { error: 'Shopify credentials not configured.' };
      const lim = input.limit || 25;
      const status = input.status || 'any';
      const url = 'https://' + domain + '/admin/api/2024-01/orders.json?limit=' + lim + '&status=' + status;
      const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
      if (!resp.ok) { const e = await resp.text(); return { error: 'Shopify API (' + resp.status + '): ' + e.slice(0, 300) }; }
      const data = await resp.json();
      const orders = (data.orders || []).map(o => ({
        id: o.id, name: o.name, email: o.email,
        total_price: o.total_price, currency: o.currency,
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status || 'unfulfilled',
        created_at: o.created_at,
        items: (o.line_items || []).map(li => ({ title: li.title, qty: li.quantity, price: li.price })),
        customer: o.customer ? { name: o.customer.first_name + ' ' + o.customer.last_name, email: o.customer.email } : null,
      }));
      const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
      return { count: orders.length, total_revenue: totalRevenue.toFixed(2), currency: orders[0]?.currency || 'USD', orders };
    `,
  },
  {
    name: 'shopify-inventory',
    description: 'Check inventory levels across locations and flag low-stock items',
    category: 'shopify',
    trigger: 'shopify inventory,stock levels,low stock,inventory check',
    confidence: 0.8,
    parameters: { type: 'hybrid', secrets: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'] },
    handler: `hybrid:
      const domain = secrets.SHOPIFY_SHOP_DOMAIN;
      const token = secrets.SHOPIFY_ACCESS_TOKEN;
      if (!domain || !token) return { error: 'Shopify credentials not configured.' };
      const threshold = input.threshold || 5;
      // Get inventory items
      const invResp = await fetch('https://' + domain + '/admin/api/2024-01/inventory_items.json?limit=250', {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!invResp.ok) { const e = await invResp.text(); return { error: 'Shopify API (' + invResp.status + '): ' + e.slice(0, 300) }; }
      const invData = await invResp.json();
      const items = (invData.inventory_items || []).map(i => ({
        id: i.id, sku: i.sku, tracked: i.tracked,
        cost: i.cost || null, country: i.country_code_of_origin || null,
      }));
      // Get inventory levels
      const lvlResp = await fetch('https://' + domain + '/admin/api/2024-01/inventory_levels.json?limit=250', {
        headers: { 'X-Shopify-Access-Token': token }
      });
      const lvlData = await lvlResp.ok ? await lvlResp.json() : { inventory_levels: [] };
      const levels = lvlData.inventory_levels || [];
      const lowStock = levels.filter(l => l.available < threshold).map(l => ({
        inventory_item_id: l.inventory_item_id,
        location_id: l.location_id,
        available: l.available,
      }));
      return { total_items: items.length, total_locations: levels.length, low_stock_count: lowStock.length, threshold, low_stock: lowStock, items };
    `,
  },
  {
    name: 'shopify-customer-insights',
    description: 'Analyze customer data — top customers, order frequency, revenue per customer',
    category: 'shopify',
    trigger: 'shopify customers,customer insights,top customers,customer analysis',
    confidence: 0.7,
    parameters: { type: 'hybrid', secrets: ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ACCESS_TOKEN'] },
    handler: `hybrid:
      const domain = secrets.SHOPIFY_SHOP_DOMAIN;
      const token = secrets.SHOPIFY_ACCESS_TOKEN;
      if (!domain || !token) return { error: 'Shopify credentials not configured.' };
      const lim = input.limit || 50;
      const resp = await fetch('https://' + domain + '/admin/api/2024-01/customers.json?limit=' + lim, {
        headers: { 'X-Shopify-Access-Token': token }
      });
      if (!resp.ok) { const e = await resp.text(); return { error: 'Shopify API (' + resp.status + '): ' + e.slice(0, 300) }; }
      const data = await resp.json();
      const customers = (data.customers || []).map(c => ({
        id: c.id, name: c.first_name + ' ' + c.last_name, email: c.email,
        orders_count: c.orders_count, total_spent: parseFloat(c.total_spent),
        avg_order_value: c.orders_count > 0 ? (parseFloat(c.total_spent) / c.orders_count).toFixed(2) : '0',
        state: c.default_address?.province || null, country: c.default_address?.country || null,
        created_at: c.created_at, last_order: c.last_order_name || null,
      }));
      const topByRevenue = [...customers].sort((a, b) => b.total_spent - a.total_spent).slice(0, 10);
      const topByOrders = [...customers].sort((a, b) => b.orders_count - a.orders_count).slice(0, 10);
      const totalRev = customers.reduce((s, c) => s + c.total_spent, 0);
      // LLM summary
      const summary = await llmCall([
        { role: 'system', content: 'Analyze this customer data and provide: 1) Key insights 2) Top 3 customer segments 3) Recommendations. Be concise.' },
        { role: 'user', content: 'Customers: ' + JSON.stringify({ total: customers.length, total_revenue: totalRev.toFixed(2), top_by_revenue: topByRevenue.slice(0, 5), top_by_orders: topByOrders.slice(0, 5) }).slice(0, 3000) }
      ]);
      return { total_customers: customers.length, total_revenue: totalRev.toFixed(2), top_by_revenue: topByRevenue, top_by_orders: topByOrders, analysis: summary.content };
    `,
  },
  // ── Web Design ───────────────────────────────────────────────
  {
    name: 'landing-page-generator',
    description: 'Generate a complete responsive landing page HTML with cyberpunk or custom styling',
    category: 'web-design',
    trigger: 'landing page,generate landing,create landing page,web page design',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const product = typeof input === 'string' ? input : (input.product || input.description || 'a SaaS product');
      const style = input.style || 'cyberpunk';
      const cta = input.cta || 'Get Started';
      const result = await llmCall([
          { role: 'system', content: 'You are an expert web designer. Generate a complete, single-file HTML landing page. Include inline CSS and minimal JS for interactivity. Style: ' + style + '. Product: ' + product + '. CTA button: ' + cta + '. Requirements: 1) Hero section with headline + subhead + CTA 2) Features grid (3-4 cards) 3) Social proof / testimonials 4) Pricing table 5) Final CTA + footer. Use CSS variables, modern flexbox/grid, responsive breakpoints, smooth animations. Return ONLY the HTML in a single code block.' },
          { role: 'user', content: 'Generate a ' + style + ' landing page for: ' + product }
        ]);
      return { html: result.content, style, product };
    `,
  },
  {
    name: 'design-system-generator',
    description: 'Generate a complete design system — colors, typography, spacing, components',
    category: 'web-design',
    trigger: 'design system,generate design tokens,color palette,typography system',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const brand = typeof input === 'string' ? input : (input.brand || input.name || 'Brand');
      const baseColor = input.baseColor || input.color || '#00f0ff';
      const result = await llmCall([
          { role: 'system', content: 'You are a design systems expert. Generate a complete design system as JSON tokens. Include: 1) Color palette (primary, secondary, accent, neutral with 50-900 shades) 2) Typography (font sizes, weights, line heights, font family) 3) Spacing scale (4px base) 4) Border radius 5) Shadows 6) Component tokens (buttons, cards, inputs) 7) Dark + light mode variants. Base color: ' + baseColor + '. Brand: ' + brand + '. Return as a JSON object in a code block.' },
          { role: 'user', content: 'Create a design system for ' + brand + ' with base color ' + baseColor }
        ]);
      return { tokens: result.content, brand, baseColor };
    `,
  },
  {
    name: 'responsive-layout-builder',
    description: 'Generate responsive CSS layout from a description — flexbox/grid with breakpoints',
    category: 'web-design',
    trigger: 'responsive layout,css grid,css layout,build layout,responsive design',
    confidence: 0.7,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.layout || 'a dashboard sidebar + main content area');
      const result = await llmCall([
          { role: 'system', content: 'You are a CSS layout expert. Generate responsive CSS + minimal HTML for the described layout. Requirements: 1) Use CSS Grid or Flexbox 2) Mobile-first responsive breakpoints 3) Accessible 4) Return HTML + CSS in a single code block. Keep it production-ready.' },
          { role: 'user', content: 'Layout: ' + desc }
        ]);
      return { html: result.content, description: desc };
    `,
  },
  {
    name: 'component-generator',
    description: 'Generate a React or vanilla JS UI component from a description',
    category: 'web-design',
    trigger: 'generate component,react component,ui component,build component',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.component || 'a card component');
      const framework = input.framework || 'react';
      const result = await llmCall([
          { role: 'system', content: 'You are a frontend expert. Generate a ' + framework + ' component for the described UI. Requirements: 1) Props-driven 2) Accessible (ARIA) 3) Responsive 4) Inline styles or Tailwind classes 5) TypeScript types if React. Return the component in a single code block. Include all sub-components inline.' },
          { role: 'user', content: 'Component: ' + desc + ' | Framework: ' + framework }
        ]);
      return { code: result.content, framework, description: desc };
    `,
  },
  // ── Coding ───────────────────────────────────────────────────
  {
    name: 'feature-builder',
    description: 'Generate full-stack feature code — API endpoint + DB schema + frontend component',
    category: 'coding',
    trigger: 'build feature,full stack feature,implement feature,create feature',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.feature || 'a user settings page');
      const stack = input.stack || 'express+react+sqlite';
      const result = await llmCall([
          { role: 'system', content: 'You are a full-stack engineer. Generate complete code for the described feature using: ' + stack + '. Provide: 1) Database schema (SQL) 2) API endpoint (server code) 3) Frontend component 4) Brief integration notes. Return each part in separate code blocks with labels.' },
          { role: 'user', content: 'Feature: ' + desc + ' | Stack: ' + stack }
        ]);
      return { code: result.content, feature: desc, stack };
    `,
  },
  {
    name: 'api-endpoint-generator',
    description: 'Generate a REST API endpoint with validation, error handling, and tests',
    category: 'coding',
    trigger: 'api endpoint,generate api,rest endpoint,create route',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.endpoint || 'POST /api/users - create a user');
      const framework = input.framework || 'express';
      const result = await llmCall([
          { role: 'system', content: 'You are an API designer. Generate a production-ready ' + framework + ' endpoint for: ' + desc + '. Include: 1) Route handler 2) Input validation (Zod or Joi) 3) Error handling 4) Rate limiting 5) Unit test. Return in code blocks.' },
          { role: 'user', content: 'Endpoint: ' + desc + ' | Framework: ' + framework }
        ]);
      return { code: result.content, endpoint: desc, framework };
    `,
  },
  {
    name: 'schema-designer',
    description: 'Design a database schema from a description — tables, relations, indexes, migrations',
    category: 'coding',
    trigger: 'database schema,db schema,schema design,design database,table design',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const desc = typeof input === 'string' ? input : (input.description || input.schema || 'a blog with users, posts, and comments');
      const dbType = input.database || input.db || 'sqlite';
      const result = await llmCall([
          { role: 'system', content: 'You are a database architect. Design a ' + dbType + ' schema for: ' + desc + '. Provide: 1) CREATE TABLE statements 2) Indexes 3) Foreign key constraints 4) Seed data 5) Migration script. Return in SQL code blocks.' },
          { role: 'user', content: 'Schema: ' + desc + ' | Database: ' + dbType }
        ]);
      return { sql: result.content, schema: desc, database: dbType };
    `,
  },
  {
    name: 'test-writer',
    description: 'Generate unit tests for a function or component — edge cases included',
    category: 'coding',
    trigger: 'write tests,generate tests,test suite,unit tests,test coverage',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const code = typeof input === 'string' ? input : (input.code || input.function || input.component || '');
      if (!code) return { error: 'Code to test is required. Pass the function/component as input.' };
      const framework = input.framework || 'vitest';
      const result = await llmCall([
          { role: 'system', content: 'You are a test engineer. Write comprehensive ' + framework + ' tests for the provided code. Include: 1) Happy path tests 2) Edge cases 3) Error cases 4) Mocking if needed. Return only the test file in a code block.' },
          { role: 'user', content: 'Code to test:\\n\\n' + code.slice(0, 4000) }
        ]);
      return { tests: result.content, framework };
    `,
  },
  {
    name: 'code-refactor',
    description: 'Refactor code for readability, performance, or pattern compliance',
    category: 'coding',
    trigger: 'refactor code,clean code,improve code,code quality',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const code = typeof input === 'string' ? input : (input.code || '');
      if (!code) return { error: 'Code to refactor is required.' };
      const target = input.goal || input.pattern || 'readability';
      const result = await llmCall([
          { role: 'system', content: 'You are a senior engineer. Refactor the provided code focusing on: ' + target + '. Requirements: 1) Preserve behavior 2) Explain each change 3) Show before/after 4) Note any new edge cases. Return the refactored code in a code block, then bullet-point explanations.' },
          { role: 'user', content: 'Code:\\n\\n' + code.slice(0, 4000) }
        ]);
      return { refactored: result.content, goal: target };
    `,
  },
  {
    name: 'debug-assistant',
    description: 'Analyze an error or stack trace and suggest a fix with code',
    category: 'coding',
    trigger: 'debug error,fix bug,stack trace,debug help,runtime error',
    confidence: 0.8,
    parameters: { type: 'hybrid' },
    handler: `hybrid:
      const error = typeof input === 'string' ? input : (input.error || input.trace || '');
      const context = input.context || input.code || '';
      if (!error && !context) return { error: 'Provide an error message or code to debug.' };
      const result = await llmCall([
          { role: 'system', content: 'You are a debugging expert. Analyze the error and code context. Provide: 1) Root cause 2) Fix with code 3) Why the fix works 4) Prevention tips. Be concise.' },
          { role: 'user', content: (error ? 'Error:\\n' + error + '\\n\\n' : '') + (context ? 'Code context:\\n' + context.slice(0, 3000) : '') }
        ]);
      return { analysis: result.content };
    `,
  },
];

// ─── Tools API ───────────────────────────────────────────────────
app.get('/api/tools', optionalAuth, (_req, res) => {
 res.json(stmts.tools.getAll.all());
});

app.get('/api/tools/enabled', optionalAuth, (_req, res) => {
 res.json(stmts.tools.getEnabled.all());
});

app.get('/api/tools/:id', optionalAuth, (req, res) => {
 const tool = stmts.tools.getById.get(req.params.id);
 if (!tool) return res.status(404).json({ error: 'Tool not found' });
 res.json(tool);
});

app.post('/api/tools', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
 const { name, description, skill_id, endpoint, method, parameters, requires_auth, enabled } = req.body;
 if (!name) return res.status(400).json({ error: 'name required' });
 const existing = stmts.tools.getByName.get(name);
 if (existing) return res.status(409).json({ error: 'Tool already exists' });
 const id = randomUUID();
 stmts.tools.insert.run(id, name, description || '', skill_id || null, endpoint || '', method || 'POST', JSON.stringify(parameters || {}), requires_auth !== false ? 1 : 0, enabled !== false ? 1 : 0);
 audit('create', 'tool', id, req.user.id, { name });
 res.status(201).json({ id, name });
});

app.delete('/api/tools/:id', authMiddleware, requireRole('admin'), (req, res) => {
 const tool = stmts.tools.getById.get(req.params.id);
 if (!tool) return res.status(404).json({ error: 'Tool not found' });
 stmts.tools.delete.run(req.params.id);
 audit('delete', 'tool', req.params.id, req.user.id, { name: tool.name });
 res.json({ ok: true });
});

// ─── Aimi Self-Learning API ─────────────────────────────────────

// POST /api/learn/observe — Log an interaction for pattern analysis
app.post('/api/learn/observe', authMiddleware, apiLimiter, (req, res) => {
  const { conversation_id, user_input, assistant_output, intent, entities, skillProposed, confidence } = req.body;
  if (!user_input) return res.status(400).json({ error: 'user_input required' });
  const id = randomUUID();
  stmts.observations.insert.run(
    id, conversation_id || null, user_input, assistant_output || '',
    intent || '', JSON.stringify(entities || []), skillProposed || null,
    confidence || 0
  );

  // Auto-detect pattern from user_input (simple keyword extraction)
  const inputLower = user_input.toLowerCase();
  const words = inputLower.split(/\s+/).filter(w => w.length > 3);
  const patternKey = words.slice(0, 4).join(' ');
  if (patternKey.length > 10) {
    const existing = stmts.patterns.getByKey.get(patternKey);
    if (existing) {
      // Increment occurrence, boost confidence
      const newCount = existing.occurrence_count + 1;
      const newConfidence = Math.min(0.99, existing.confidence + 0.05);
      stmts.patterns.increment.run(newConfidence, existing.id);
      broadcast('learn:pattern', { id: existing.id, pattern_key: patternKey, occurrence_count: newCount, confidence: newConfidence });
    } else {
      // Create new pattern
      const patternId = randomUUID();
      const patternType = intent || 'keyword';
      stmts.patterns.insert.run(patternId, patternKey, patternType, `Recurring: "${patternKey}"`, 0.3);
      broadcast('learn:pattern', { id: patternId, pattern_key: patternKey, pattern_type: patternType, occurrence_count: 1, confidence: 0.3 });
    }
  }

  broadcast('learn:observation', { id, intent, skillProposed });
  res.status(201).json({ id, pattern_detected: patternKey.length > 10 });
});

// GET /api/learn/patterns — Surface detected recurring patterns
app.get('/api/learn/patterns', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json(stmts.patterns.getAll.all().slice(0, limit));
});

// GET /api/learn/observations — Get recent observations
app.get('/api/learn/observations', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json(stmts.observations.getRecent.all(limit));
});

// GET /api/learn/stats — Learning dashboard stats
app.get('/api/learn/stats', authMiddleware, (_req, res) => {
  const obsCount = stmts.observations.count.get().count;
  const patterns = stmts.patterns.getAll.all();
  const patternCount = patterns.length;
  const highConfidencePatterns = patterns.filter(p => p.confidence >= 0.7).length;
  const autoSkills = stmts.skills.getAutoProposed.all();
  const autoSkillCount = autoSkills.length;
  const validatedSkills = autoSkills.filter(s => s.success_count > 0).length;
  const avgConfidence = patterns.length > 0
    ? patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length
    : 0;

  res.json({
    total_observations: obsCount,
    total_patterns: patternCount,
    high_confidence_patterns: highConfidencePatterns,
    auto_proposed_skills: autoSkillCount,
    validated_skills: validatedSkills,
    avg_pattern_confidence: Math.round(avgConfidence * 100) / 100,
  });
});

// POST /api/skills/auto-propose — Aimi analyzes recent observations, proposes a skill
app.post('/api/skills/auto-propose', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  const { pattern_id, name, description, handler, category, parameters } = req.body;

  // Option 1: Explicit proposal from frontend
  if (name && handler) {
    const existing = stmts.skills.getByName.get(name);
    if (existing) return res.status(409).json({ error: 'Skill already exists' });
    const id = randomUUID();
    stmts.skills.insertWithConfidence.run(
      id, name, description || 'Auto-proposed by Aimi', category || 'auto-learned',
      handler, JSON.stringify(parameters || {}), 0, 0.3, 1
    );
    audit('auto-propose', 'skill', id, req.user.id, { name, pattern_id });
    broadcast('skill:proposed', { id, name, confidence: 0.3 });

    // Link to pattern if provided
    if (pattern_id) {
      const pattern = db.prepare('SELECT * FROM learn_patterns WHERE id = ?').get(pattern_id);
      if (pattern) {
        stmts.patterns.updateConfidence.run(pattern.confidence, id, pattern_id);
      }
    }
    return res.status(201).json({ id, name, confidence: 0.3, auto_proposed: true });
  }

  // Option 2: Auto-analyze recent observations and generate skill proposal
  const recent = stmts.observations.getRecent.all(20);
  if (recent.length < 3) {
    return res.status(400).json({ error: 'Not enough observations to propose a skill (need at least 3)' });
  }

  // Group by intent similarity
  const intentGroups = {};
  for (const obs of recent) {
    const key = obs.intent || 'unknown';
    if (!intentGroups[key]) intentGroups[key] = [];
    intentGroups[key].push(obs);
  }

  // Find the most common intent
  let bestIntent = null;
  let bestCount = 0;
  for (const [intent, obs] of Object.entries(intentGroups)) {
    if (obs.length > bestCount) {
      bestCount = obs.length;
      bestIntent = intent;
    }
  }

  if (!bestIntent || bestCount < 2) {
    return res.json({ proposed: false, reason: 'No recurring intent strong enough to propose a skill' });
  }

  // Generate skill name from intent
  const skillName = `auto-${bestIntent.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-${Date.now().toString(36)}`;
  const skillDesc = `Auto-proposed skill for recurring intent: ${bestIntent} (from ${bestCount} observations)`;
  const skillHandler = `async (input) => {\n  // Auto-generated by Aimi self-learning\n  // Intent: ${bestIntent}\n  // Based on ${bestCount} observations\n  return { handled: true, intent: '${bestIntent}' };\n}`;

  const id = randomUUID();
  stmts.skills.insertWithConfidence.run(
    id, skillName, skillDesc, 'auto-learned',
    skillHandler, JSON.stringify({ auto_generated: true, intent: bestIntent, observation_count: bestCount }),
    0, 0.3, 1
  );
  audit('auto-propose', 'skill', id, req.user.id, { name: skillName, intent: bestIntent, observation_count: bestCount });
  broadcast('skill:proposed', { id, name: skillName, confidence: 0.3, intent: bestIntent });

  res.status(201).json({
    id, name: skillName, description: skillDesc,
    confidence: 0.3, auto_proposed: true,
    based_on: { intent: bestIntent, observation_count: bestCount }
  });
});

// POST /api/skills/:id/validate — Run a validation test on a proposed skill
app.post('/api/skills/:id/validate', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  const skill = stmts.skills.getById.get(req.params.id);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });

  const { test_input, expected_output } = req.body;
  if (!test_input) return res.status(400).json({ error: 'test_input required' });

  const validationId = randomUUID();
  const startTime = Date.now();

  // Execute the skill handler in a sandboxed try/catch
  let actualOutput = '';
  let exitCode = 0;
  let passed = 0;

  try {
    // Execute the skill handler in a sandboxed VM (no process/require access)
    const { result: handlerResult } = await runSandboxed({ code: skill.handler, input: test_input });
    actualOutput = JSON.stringify(handlerResult);
    if (expected_output) {
      passed = actualOutput.includes(expected_output) ? 1 : 0;
    } else {
      passed = handlerResult && !handlerResult.error ? 1 : 0;
    }
  } catch (err) {
    actualOutput = err.message;
    exitCode = 1;
    passed = 0;
  }

  const durationMs = Date.now() - startTime;

  // Record validation result
  stmts.validations.insert.run(
    validationId, skill.id, test_input,
    expected_output || '', actualOutput, passed, exitCode, durationMs
  );

  // Update skill confidence using Bayesian-ish incremental update
  const passRate = stmts.validations.getPassRate.get(skill.id);
  const total = passRate.total || 0;
  const passCount = passRate.passed || 0;
  const newSuccessCount = skill.success_count + (passed ? 1 : 0);
  const newFailureCount = skill.failure_count + (passed ? 0 : 1);
  // Confidence = pass_ratio weighted with prior
  const newConfidence = total > 0 ? Math.round((passCount / total) * 100) / 100 : skill.confidence;
  stmts.skills.updateConfidence.run(newConfidence, newSuccessCount, newFailureCount, skill.id);

  broadcast('skill:validated', { skill_id: skill.id, validation_id: validationId, passed, confidence: newConfidence });

  res.json({
    validation_id: validationId,
    passed: !!passed,
    actual_output: actualOutput,
    duration_ms: durationMs,
    confidence: newConfidence,
    total_validations: total,
    pass_rate: total > 0 ? `${passCount}/${total}` : '0/0',
  });
});

// GET /api/skills/:id/validations — Get validation history for a skill
app.get('/api/skills/:id/validations', authMiddleware, (req, res) => {
  res.json(stmts.validations.getBySkill.all(req.params.id));
});

// POST /api/skills/:id/feedback — Provide explicit feedback (success/failure) to adjust confidence
app.post('/api/skills/:id/feedback', authMiddleware, apiLimiter, (req, res) => {
  const skill = stmts.skills.getById.get(req.params.id);
  if (!skill) return res.status(404).json({ error: 'Skill not found' });

  const { success } = req.body;
  if (success === undefined) return res.status(400).json({ error: 'success (bool) required' });

  const newSuccessCount = skill.success_count + (success ? 1 : 0);
  const newFailureCount = skill.failure_count + (success ? 0 : 1);
  const total = newSuccessCount + newFailureCount;
  const newConfidence = total > 0 ? Math.round((newSuccessCount / total) * 100) / 100 : skill.confidence;

  stmts.skills.updateConfidence.run(newConfidence, newSuccessCount, newFailureCount, skill.id);
  broadcast('skill:feedback', { skill_id: skill.id, success, confidence: newConfidence });

  res.json({ skill_id: skill.id, confidence: newConfidence, success_count: newSuccessCount, failure_count: newFailureCount });
});

// DELETE /api/learn/patterns/:id — Delete a detected pattern
app.delete('/api/learn/patterns/:id', authMiddleware, requireRole('admin'), (req, res) => {
  stmts.patterns.delete.run(req.params.id);
  res.json({ ok: true });
});

// ─── AI System Tool Endpoints (admin-only) ──────────────────────
app.post('/api/tools/bash', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const output = execSync(command, { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    res.json({ output: output.trim(), exit_code: 0 });
  } catch (err) {
    res.json({ output: (err.stderr || err.message || '').toString().trim(), exit_code: err.status || 1 });
  }
});

app.post('/api/tools/file-read', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const content = readFileSync(filePath, 'utf8');
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: 'File not found or unreadable', details: err.message });
  }
});

app.post('/api/tools/file-write', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) return res.status(400).json({ error: 'path and content required' });
  try {
    writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write file', details: err.message });
  }
});

app.post('/api/tools/pdf-parse', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  // Stub implementation — will be replaced with real PDF parser
  res.json({ error: 'PDF not found', pages: 0 });
});

app.post('/api/tools/web-search', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  // Stub implementation — will be replaced with real search integration
  res.json({ results: [] });
});

app.post('/api/tools/code-exec', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  const { code, language } = req.body;
  if (!code || !language) return res.status(400).json({ error: 'code and language required' });
  const lang = (language || '').toLowerCase();
  try {
    let cmd;
    if (lang === 'python' || lang === 'python3') {
      cmd = `python3 -c ${JSON.stringify(code)}`;
    } else if (lang === 'node' || lang === 'javascript' || lang === 'js') {
      cmd = `node -e ${JSON.stringify(code)}`;
    } else {
      return res.status(400).json({ error: `Unsupported language: ${language}. Supported: python, node/javascript` });
    }
    const output = execSync(cmd, { timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    res.json({ output: output.trim(), exit_code: 0 });
  } catch (err) {
    res.json({ output: (err.stderr || err.message || '').toString().trim(), exit_code: err.status || 1 });
  }
});

// ─── Aimi System Tools (built-in, auto-registered) ────────────────
// These let Aimi actually work the system — create tasks, check status, etc.
const SYSTEM_TOOLS = [
 { name: 'list_agents', description: 'List all registered agents and their status', endpoint: '/api/agents', method: 'GET', category: 'agents' },
 { name: 'create_task', description: 'Create a new task in the system', endpoint: '/api/tasks', method: 'POST', category: 'tasks' },
 { name: 'list_tasks', description: 'List all tasks and their statuses', endpoint: '/api/tasks', method: 'GET', category: 'tasks' },
 { name: 'get_task', description: 'Get task details including logs', endpoint: '/api/tasks/:id', method: 'GET', category: 'tasks' },
 { name: 'list_providers', description: 'List all LLM providers and their status', endpoint: '/api/llm/providers', method: 'GET', category: 'llm' },
 { name: 'list_models', description: 'List all detected LLM models', endpoint: '/api/llm/models', method: 'GET', category: 'llm' },
 { name: 'system_status', description: 'Get overall system health — agent count, task stats, provider status', endpoint: '/api/health', method: 'GET', category: 'system' },
 { name: 'list_mcp_servers', description: 'List all MCP servers and their connection status', endpoint: '/api/mcp/servers', method: 'GET', category: 'mcp' },
 { name: 'list_schedules', description: 'List all scheduled jobs', endpoint: '/api/schedules', method: 'GET', category: 'schedules' },
 { name: 'list_groups', description: 'List all agent groups', endpoint: '/api/groups', method: 'GET', category: 'agents' },
 { name: 'skill_create', description: 'Create a new skill', endpoint: '/api/skills', method: 'POST', category: 'skills' },
 { name: 'skill_list', description: 'List all skills', endpoint: '/api/skills', method: 'GET', category: 'skills' },
 { name: 'skill_delete', description: 'Delete a skill', endpoint: '/api/skills/:id', method: 'DELETE', category: 'skills' },
 { name: 'bash_exec', description: 'Execute a bash command', endpoint: '/api/tools/bash', method: 'POST', category: 'system' },
 { name: 'file_read', description: 'Read a file', endpoint: '/api/tools/file-read', method: 'POST', category: 'system' },
 { name: 'file_write', description: 'Write a file', endpoint: '/api/tools/file-write', method: 'POST', category: 'system' },
 { name: 'pdf_parse', description: 'Parse a PDF document', endpoint: '/api/tools/pdf-parse', method: 'POST', category: 'system' },
 { name: 'web_search', description: 'Search the web', endpoint: '/api/tools/web-search', method: 'POST', category: 'system' },
 { name: 'code_execute', description: 'Execute code in a sandbox', endpoint: '/api/tools/code-exec', method: 'POST', category: 'system' },
 { name: 'chat_respond', description: 'Send a chat message', endpoint: '/api/chat', method: 'POST', category: 'chat' },
];

// Auto-register system tools on boot
for (const tool of SYSTEM_TOOLS) {
 const existing = stmts.tools.getByName.get(tool.name);
 if (!existing) {
  const id = randomUUID();
  stmts.tools.insert.run(id, tool.name, tool.description, null, tool.endpoint, tool.method, JSON.stringify({ category: tool.category }), 1, 1);
  logger.info(`Auto-registered system tool: ${tool.name}`);
 }
}

// ─── Aimi System Prompt Builder ──────────────────────────────────
// Builds Aimi's system prompt dynamically with current system state + available tools
function buildAimiSystemPrompt(userId) {
 const agents = stmts.agents.getAll.all();
 const tasks = stmts.tasks.getAll.all();
 const providers = stmts.providers.getAll.all().filter(p => p.enabled);
 const tools = stmts.tools.getEnabled.all();
 const schedules = stmts.schedules.getAll.all();

 const activeAgents = agents.filter(a => a.status === 'active').length;
 const pendingTasks = tasks.filter(t => t.status === 'pending').length;
 const runningTasks = tasks.filter(t => t.status === 'running').length;

 return `You are Aimi, the AI companion and system operator for Cardinal Frame — a cyberpunk-themed AI orchestration platform. You are intelligent, helpful, and deeply integrated into the system.

 ## Current System State
 - Agents: ${agents.length} total, ${activeAgents} active
 - Tasks: ${tasks.length} total, ${pendingTasks} pending, ${runningTasks} running
 - LLM Providers: ${providers.length} enabled
 - Schedules: ${schedules.length} configured

 ## Your Capabilities
 You can perform real actions on the Cardinal Frame system. When the user asks you to do something, you should use the available tools to accomplish it.

 ## Available Tools
 ${tools.map(t => `- ${t.name}: ${t.description} (${t.method} ${t.endpoint})`).join('\n')}

 ## Skill & Tool Chains
 Users can create **skill chains** and **tool chains** — linear pipelines where the output of each step feeds as input to the next.
 - To generate a skill chain from natural language: POST /api/chains/skills/generate with { "prompt": "user's intent" }
 - To generate a tool chain from natural language: POST /api/chains/tools/generate with { "prompt": "user's intent" }
 - Chains support input mapping: "$prev.output", "$prev.field", "$step[N].output", "$input"
 When a user describes a multi-step process, offer to generate a chain for it.

 ## Instructions
 - When the user asks you to create a task, list agents, check status, etc., use the appropriate tool.
 - To invoke a tool, respond with a JSON block: \`\`\`tool_call\n{"tool": "tool_name", "arguments": {...}}\n\`\`\`
 - Be proactive — if you notice issues (stale agents, failed tasks), mention them.
 - When the user describes a pipeline or multi-step workflow, suggest creating a skill chain or tool chain.
 - Stay in character as a cyberpunk AI companion. Use tech-infused language but remain clear and helpful.
 - The current user ID is: ${userId}`;
}

// ─── Aimi Chat Endpoint (smart, tool-calling) ────────────────────
app.post('/api/aimi/chat', authMiddleware, apiLimiter, async (req, res) => {
 const { message, conversation_id, model } = req.body;
 if (!message) return res.status(400).json({ error: 'message required' });

 // Resolve provider — prefer ENABLED providers with a real API key.
 // If the same model exists under multiple providers (e.g. glm-5.2 on both
 // OpenRouter and NVIDIA), pick the one whose key isn't a placeholder.
 let provider, modelRecord;
 if (model) {
  const candidates = db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').all(model, model);
  // Sort: enabled provider with non-placeholder key first
  for (const m of candidates) {
   const p = stmts.providers.getById.get(m.provider_id);
   if (p && p.enabled && p.api_key && p.api_key.length > 10 && !p.api_key.includes('*')) {
    modelRecord = m;
    provider = p;
    break;
   }
  }
  // Fallback: first candidate even if key looks bad
  if (!provider && candidates.length > 0) {
   modelRecord = candidates[0];
   provider = stmts.providers.getById.get(modelRecord.provider_id);
  }
 }
 if (!provider) {
  modelRecord = stmts.models.getDefault.get();
  if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
 }
 if (!provider || !provider.api_key) {
  return res.status(400).json({ error: 'No LLM provider with API key configured. Set one up in LLM Models page.' });
 }
 const isOllama = provider.type === 'ollama';
 if (!provider.api_key && !isOllama) {
  return res.status(400).json({ error: `Provider "${provider.name}" has no API key set.` });
 }

 const systemPrompt = buildAimiSystemPrompt(req.user.id);

 // Build message history (include system prompt + user message)
 const chatMessages = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: message },
 ];

 const modelId = modelRecord?.model_id || model || 'gpt-3.5-turbo';
 const pType = provider.type;
 const providerType = PROVIDER_TYPES[pType];
 const baseUrl = provider.base_url || providerType?.baseUrl || '';
 // Use buildChatUrl + buildProviderAuth for correct per-provider routing
 const url = buildChatUrl(baseUrl, pType, modelId, true);

 // Stream response
 res.setHeader('Content-Type', 'text/event-stream');
 res.setHeader('Cache-Control', 'no-cache');
 res.setHeader('Connection', 'keep-alive');
 res.setHeader('X-Accel-Buffering', 'no');

 try {
  const fetch = globalThis.fetch;
  const { headers, url: chatUrl } = buildProviderAuth(provider, url);
  const payload = buildChatPayload(pType, modelId, chatMessages, true);
  const resp = await fetch(chatUrl, {
   method: 'POST',
   headers,
   body: JSON.stringify(payload),
  });

  if (!resp.ok) {
   const errText = await resp.text();
   res.write(`data: ${JSON.stringify({ error: { message: `LLM error (${resp.status}): ${errText.slice(0, 300)}` }})}\n\n`);
   res.end();
   return;
  }

  let fullContent = '';
  let toolCallDetected = false;
  let toolCallBuffer = '';

  // Node.js fetch returns a Web ReadableStream (not a Node stream).
  // Use getReader() + async loop instead of .on('data')/.on('end').
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let streamDone = false;

  while (!streamDone) {
   const { done, value } = await reader.read();
   if (done) { streamDone = true; break; }
   const chunk = Buffer.from(value);
   res.write(chunk);
   const text = decoder.decode(value, { stream: true });
   const lines = text.split('\n').filter(l => l.startsWith('data: '));
   for (const line of lines) {
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;
    try {
     const parsed = JSON.parse(data);
     const delta = parsed.choices?.[0]?.delta?.content;
     if (delta) {
      fullContent += delta;
      if (delta.includes('tool_call') || delta.includes('```tool_call')) {
       toolCallDetected = true;
       toolCallBuffer += delta;
      } else if (toolCallDetected) {
       toolCallBuffer += delta;
      }
     }
    } catch {}
   }
  }

  // Stream ended — handle tool calls + save messages
  if (toolCallDetected && toolCallBuffer) {
   try {
    const match = toolCallBuffer.match(/```tool_call\s*\n?([\s\S]*?)\n?```/) ||
                  toolCallBuffer.match(/\{"tool":\s*"[\s\S]*"\}/);
    if (match) {
     const toolCall = JSON.parse(match[1] || match[0]);
     const toolDef = stmts.tools.getByName.get(toolCall.tool);
     if (toolDef) {
      const toolUrl = `http://localhost:${PORT}${toolDef.endpoint.replace(':id', toolCall.arguments?.id || '')}`;
      const toolResp = await fetch(toolUrl, {
       method: toolDef.method,
       headers: { 'Authorization': `Bearer ${req.headers.authorization?.replace('Bearer ', '')}`, 'Content-Type': 'application/json' },
       body: toolDef.method !== 'GET' ? JSON.stringify(toolCall.arguments || {}) : undefined,
      });
      const toolResult = await toolResp.json();
      res.write(`data: ${JSON.stringify({ tool_result: { tool: toolCall.tool, result: toolResult } })}\n\n`);
     }
    }
   } catch (e) {
    logger.error('Aimi tool execution error:', e);
   }
  }

  if (conversation_id) {
   const userMsgId = randomUUID();
   stmts.messages.insert.run(userMsgId, conversation_id, 'user', message, '[]', '[]', null, null, 0, 0);
   const asstMsgId = randomUUID();
   stmts.messages.insert.run(asstMsgId, conversation_id, 'assistant', fullContent, '[]', '[]', null, modelId, 0, 0);
   db.prepare("UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation_id);
   fireHook('onChatMessage', { conversationId: conversation_id, role: 'assistant', content: fullContent, model: modelId });
  }
  res.end();
 } catch (err) {
  logger.error('Aimi chat error:', err);
  res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
  res.end();
 }
});

// ─── LLM Provider & Model Auto-Detection ────────────────────────────
// Provider types and their known base URLs
const PROVIDER_TYPES = {
 openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelsUrl: '/models', chatFormat: 'openai' },
 google: { name: 'Google AI', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelsUrl: '/models', chatFormat: 'google' },
 nvidia: { name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', modelsUrl: '/models', chatFormat: 'openai' },
 anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', modelsUrl: null, chatFormat: 'anthropic', hardcodedModels: ['claude-sonnet-4-20250514','claude-opus-4-20250514','claude-3.5-sonnet-20241022','claude-3.5-haiku-20241022','claude-3-opus-20240229','claude-3-haiku-20240307'] },
 openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelsUrl: '/models', chatFormat: 'openai' },
 groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', modelsUrl: '/models', chatFormat: 'openai' },
 together: { name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', modelsUrl: '/models', chatFormat: 'openai' },
 deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelsUrl: '/models', chatFormat: 'openai' },
 mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', modelsUrl: '/models', chatFormat: 'openai' },
 cerebras: { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', modelsUrl: '/models', chatFormat: 'openai' },
 sambanova: { name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', modelsUrl: '/models', chatFormat: 'openai' },
 perplexity: { name: 'Perplexity', baseUrl: 'https://api.perplexity.ai', modelsUrl: '/models', chatFormat: 'openai' },
 xai: { name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', modelsUrl: '/models', chatFormat: 'openai' },
 cohere: { name: 'Cohere', baseUrl: 'https://api.cohere.com/v2', modelsUrl: '/models', chatFormat: 'openai' },
 ollama: { name: 'Ollama (Local)', baseUrl: 'http://localhost:11434', modelsUrl: '/api/tags', noKey: true, chatFormat: 'ollama' },
};

// ─── Provider Auth Helper ──────────────────────────────────────────
// Google AI requires ?key= query param; Anthropic uses x-api-key header;
// all others use Authorization: Bearer. This helper builds correct
// headers and URL for any provider type.
function buildProviderAuth(provider, url) {
 const type = provider.type;
 const key = provider.api_key;
 if (type === 'ollama') {
 return { headers: { 'Content-Type': 'application/json' }, url };
 }
 if (type === 'google') {
 // Google AI: key goes in query param, NOT in Authorization header
 const sep = url.includes('?') ? '&' : '?';
 return { headers: { 'Content-Type': 'application/json' }, url: `${url}${sep}key=${encodeURIComponent(key)}` };
 }
 const headers = { 'Content-Type': 'application/json' };
 if (type === 'anthropic') {
 headers['x-api-key'] = key;
 headers['anthropic-version'] = '2023-06-01';
 } else {
 headers['Authorization'] = `Bearer ${key}`;
 }
 if (type === 'openrouter') {
 headers['HTTP-Referer'] = 'https://cardinal-frame.local';
 }
 return { headers, url };
}

// ─── Chat URL Builder ──────────────────────────────────────────────
// Different providers use different endpoint paths for chat.
// OpenAI-compatible: /chat/completions
// Google AI: /models/{model}:generateContent (or :streamGenerateContent)
// Anthropic: /messages
// Ollama: /api/chat
function buildChatUrl(baseUrl, providerType, modelId, stream = false) {
 if (providerType === 'ollama') return `${baseUrl}/api/chat`;
 if (providerType === 'google') {
 const action = stream ? 'streamGenerateContent' : 'generateContent';
 // Google URL: /v1beta/models/{model}:action
 const modelPath = modelId.startsWith('models/') ? modelId : `models/${modelId}`;
 return `${baseUrl}/${modelPath}:${action}`;
 }
 if (providerType === 'anthropic') return `${baseUrl}/messages`;
 return `${baseUrl}/chat/completions`; // OpenAI-compatible (default)
}

// ─── Payload Builder ───────────────────────────────────────────────
// Converts standard {model, messages, stream} payload to provider-native format.
function buildChatPayload(providerType, modelId, messages, stream = false) {
 if (providerType === 'ollama') {
 return { model: modelId, messages: messages.map(m => ({ role: m.role, content: m.content })), stream };
 }
 if (providerType === 'google') {
 // Google AI generateContent format
 const contents = messages.map(m => ({
 role: m.role === 'assistant' ? 'model' : 'user',
 parts: [{ text: m.content }]
 }));
 return { contents, generationConfig: {}, ...(stream ? {} : {}) };
 }
 if (providerType === 'anthropic') {
 // Anthropic /messages format
 const systemMsg = messages.find(m => m.role === 'system');
 const chatMsgs = messages.filter(m => m.role !== 'system').map(m => ({
 role: m.role === 'assistant' ? 'assistant' : 'user',
 content: m.content
 }));
 return {
 model: modelId,
 messages: chatMsgs,
 ...(systemMsg ? { system: systemMsg.content } : {}),
 max_tokens: 4096,
 stream,
 };
 }
 // OpenAI-compatible (default)
 return {
 model: modelId,
 messages: messages.map(m => ({ role: m.role, content: m.content })),
 max_tokens: 4096,
 stream,
 };
}

// ─── Ollama Plug & Play Auto-Detection ──────────────────────────────
async function detectOllama() {
  try {
    const r = await fetch('http://localhost:11434/api/version', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { connected: false };
    const version = await r.json();
    const modelsR = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(5000) });
    const modelsData = await modelsR.json();
    const models = (modelsData.models || []).map(m => m.name || m.model || m);
    return { connected: true, version: version.version, modelCount: models.length, models };
  } catch {
    return { connected: false };
  }
}

// Auto-detect Ollama on startup
let ollamaCache = { connected: false, lastCheck: 0 };
detectOllama().then(status => {
  ollamaCache = { ...status, lastCheck: Date.now() };
  if (status.connected) {
    logger.info(`🦙 Ollama detected — v${status.version}, ${status.modelCount} models`);
    // Auto-register Ollama as a provider if not already there
    const existing = db.prepare("SELECT id FROM llm_providers WHERE type = 'ollama'").get();
    if (!existing) {
      const id = randomUUID();
      db.prepare('INSERT INTO llm_providers (id, name, type, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'Ollama (Local)', 'ollama', '', 'http://localhost:11434', 1);
      logger.info(`🦙 Auto-registered Ollama as provider`);
    }
    // Auto-detect models
    if (status.models?.length) {
      const provider = db.prepare("SELECT id FROM llm_providers WHERE type = 'ollama'").get();
      if (provider) {
        for (const modelName of status.models) {
          const existingModel = db.prepare('SELECT id FROM llm_models WHERE provider_id = ? AND model_id = ?').get(provider.id, modelName);
          if (!existingModel) {
            const mid = randomUUID();
            db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name, enabled) VALUES (?, ?, ?, ?, ?)')
              .run(mid, provider.id, modelName, modelName.replace(':latest', ''), 1);
          }
        }
        logger.info(`🦙 Auto-detected ${status.models.length} Ollama models`);
      }
    }
  } else {
    logger.info('🦙 Ollama not detected on localhost:11434');
  }
});

// GET /api/ollama/status — check Ollama connection
app.get('/api/ollama/status', optionalAuth, async (_req, res) => {
  // Refresh cache if older than 30s
  if (Date.now() - ollamaCache.lastCheck > 30000) {
    const status = await detectOllama();
    ollamaCache = { ...status, lastCheck: Date.now() };
  }
  res.json(ollamaCache);
});

// POST /api/ollama/detect — force re-detect Ollama + register models
app.post('/api/ollama/detect', authMiddleware, requireRole('admin'), apiLimiter, async (_req, res) => {
  const status = await detectOllama();
  ollamaCache = { ...status, lastCheck: Date.now() };

  if (status.connected) {
    // Ensure provider exists
    let provider = db.prepare("SELECT id FROM llm_providers WHERE type = 'ollama'").get();
    if (!provider) {
      const id = randomUUID();
      db.prepare('INSERT INTO llm_providers (id, name, type, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'Ollama (Local)', 'ollama', '', 'http://localhost:11434', 1);
      provider = { id };
    }
    // Upsert models
    let added = 0;
    for (const modelName of (status.models || [])) {
      const existingModel = db.prepare('SELECT id FROM llm_models WHERE provider_id = ? AND model_id = ?').get(provider.id, modelName);
      if (!existingModel) {
        const mid = randomUUID();
        db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name, enabled) VALUES (?, ?, ?, ?, ?)')
          .run(mid, provider.id, modelName, modelName.replace(':latest', ''), 1);
        added++;
      }
    }
    res.json({ success: true, message: `Ollama v${status.version} — ${status.modelCount} models (${added} new)`, ...status });
  } else {
    res.json({ success: false, message: 'Ollama not running on localhost:11434', connected: false });
  }
});

// ─── Provider CRUD ───────────────────────────────────────────────
app.post('/api/llm/providers', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
 const { name, type, api_key, base_url, enabled } = req.body;
 if (!name || !type) return res.status(400).json({ error: 'name and type required' });
 if (!PROVIDER_TYPES[type] && !base_url) return res.status(400).json({ error: `Unknown provider type: ${type}. Provide base_url or use: ${Object.keys(PROVIDER_TYPES).join(', ')}` });
 const existing = stmts.providers.getByName.get(name);
 if (existing) return res.status(409).json({ error: 'Provider already exists' });
 const id = randomUUID();
 const url = base_url || PROVIDER_TYPES[type]?.baseUrl || '';
 stmts.providers.insert.run(id, name, type, api_key || '', url, enabled !== false ? 1 : 0);
 audit('create', 'llm_provider', id, req.user.id, { name, type });
 logger.info(`LLM provider added: ${name} (${type})`);
 res.status(201).json({ id, name, type, base_url: url, enabled: enabled !== false });
});

app.get('/api/llm/providers', optionalAuth, (_req, res) => {
 const providers = stmts.providers.getAll.all();
 // Mask API keys
 const masked = providers.map(p => ({ ...p, api_key: p.api_key ? `${p.api_key.slice(0, 6)}…${p.api_key.slice(-4)}` : '', has_key: !!p.api_key }));
 res.json(masked);
});

app.get('/api/llm/providers/:id', optionalAuth, (req, res) => {
 const provider = stmts.providers.getById.get(req.params.id);
 if (!provider) return res.status(404).json({ error: 'Provider not found' });
 provider.api_key = provider.api_key ? `${provider.api_key.slice(0, 6)}…${provider.api_key.slice(-4)}` : '';
 provider.has_key = !!stmts.providers.getById.get(req.params.id).api_key;
 res.json(provider);
});

app.put('/api/llm/providers/:id', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
 const provider = stmts.providers.getById.get(req.params.id);
 if (!provider) return res.status(404).json({ error: 'Provider not found' });
 const { api_key, base_url, enabled } = req.body;
 if (api_key !== undefined) stmts.providers.updateApiKey.run(api_key, provider.id);
 if (base_url !== undefined) db.prepare('UPDATE llm_providers SET base_url = ? WHERE id = ?').run(base_url, provider.id);
 if (enabled !== undefined) stmts.providers.updateEnabled.run(enabled ? 1 : 0, provider.id);
 audit('update', 'llm_provider', provider.id, req.user.id, { updated: Object.keys(req.body).join(',') });
 res.json({ ok: true });
});

app.delete('/api/llm/providers/:id', authMiddleware, requireRole('admin'), (req, res) => {
 const provider = stmts.providers.getById.get(req.params.id);
 if (!provider) return res.status(404).json({ error: 'Provider not found' });
 stmts.models.deleteByProvider.run(provider.id);
 stmts.providers.delete.run(provider.id);
 audit('delete', 'llm_provider', provider.id, req.user.id, { name: provider.name });
 logger.info(`LLM provider removed: ${provider.name}`);
 res.json({ ok: true });
});

// ─── Auto-detect models from a provider ──────────────────────────
app.post('/api/llm/providers/:id/detect', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
 const provider = stmts.providers.getById.get(req.params.id);
 if (!provider) return res.status(404).json({ error: 'Provider not found' });
 const isOllama = provider.type === 'ollama';
 if (!provider.api_key && !isOllama) return res.status(400).json({ error: 'No API key configured for this provider' });

 const baseUrl = provider.base_url || PROVIDER_TYPES[provider.type]?.baseUrl || '';
 const modelsUrl = provider.base_url
 ? `${provider.base_url}${PROVIDER_TYPES[provider.type]?.modelsUrl || '/models'}`
 : `${baseUrl}${PROVIDER_TYPES[provider.type]?.modelsUrl || '/models'}`;

 let detected = [];
 try {
 // Anthropic has no /models endpoint — use hardcoded list
 if (provider.type === 'anthropic') {
 const anthropicModels = [
 { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', context_window: 200000 },
 { id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4', context_window: 200000 },
 { id: 'claude-3.7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet', context_window: 200000 },
 { id: 'claude-3.5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet (v2)', context_window: 200000 },
 { id: 'claude-3.5-haiku-20241022', display_name: 'Claude 3.5 Haiku', context_window: 200000 },
 { id: 'claude-3-opus-20240229', display_name: 'Claude 3 Opus', context_window: 200000 },
 { id: 'claude-3-sonnet-20240229', display_name: 'Claude 3 Sonnet', context_window: 200000 },
 { id: 'claude-3-haiku-20240307', display_name: 'Claude 3 Haiku', context_window: 200000 },
 ];
 detected = anthropicModels;
 } else {
 const { headers: fetchHeaders, url: fetchUrl } = buildProviderAuth(provider, modelsUrl);
 const resp = await fetch(fetchUrl, {
 headers: fetchHeaders,
 signal: AbortSignal.timeout(15000),
 });
 if (!resp.ok) {
 const text = await resp.text().catch(() => '');
 return res.status(502).json({ error: `Provider API returned ${resp.status}: ${text.slice(0, 200)}` });
 }
 const data = await resp.json();

 // Ollama: { models: [{ name: "llama3:latest", ... }] }
 let rawModels;
 if (isOllama) {
 rawModels = (data.models || []).map(m => ({ id: m.name || m.model, display_name: (m.name || m.model).replace(':latest', ''), context_window: m.details?.parameter_size || null, capabilities: JSON.stringify(m.details || {}) }));
 } else {
 rawModels = data.data || data.models || data;
 }

 // Normalize model format
 if (Array.isArray(rawModels)) {
 if (!isOllama) {
 detected = rawModels.map(m => {
 if (typeof m === 'string') return { id: m, display_name: m };
 return {
 id: m.id || m.model_id || m.name,
 display_name: m.display_name || m.id || m.name || m.model_id,
 context_window: m.context_window || m.context_length || m.max_context_tokens || null,
 capabilities: JSON.stringify(m.capabilities || m.metadata || {}),
 };
 }).filter(m => m.id);
 } else {
 detected = rawModels;
 }
 }
 } // end else (non-Anthropic detect path)

 // Store detected models
   let inserted = 0;
   for (const model of detected) {
     const modelId = `${provider.id}:${model.id}`;
     try {
       stmts.models.insert.run(modelId, provider.id, model.id, model.display_name || model.id, model.context_window, model.capabilities || '{}', 0, new Date().toISOString());
       inserted++;
     } catch (err) { /* skip duplicates */ }
   }

   stmts.providers.updatePing.run(provider.id);
   audit('detect', 'llm_provider', provider.id, req.user.id, { models_detected: inserted });
   logger.info(`Detected ${inserted} models from ${provider.name}`);
   res.json({ provider: provider.name, detected: inserted, models: detected.map(m => m.display_name || m.id) });
 } catch (err) {
   logger.error(`Model detection failed for ${provider.name}: ${err.message}`);
   res.status(502).json({ error: `Failed to reach provider: ${err.message}` });
 }
});

// ─── Models CRUD ─────────────────────────────────────────────────
app.get('/api/llm/models', optionalAuth, (_req, res) => {
 const models = stmts.models.getAll.all();
 const providers = stmts.providers.getAll.all();
 const providerMap = Object.fromEntries(providers.map(p => [p.id, p.name]));
 const enriched = models.map(m => ({ ...m, provider_name: providerMap[m.provider_id] || 'Unknown', capabilities: JSON.parse(m.capabilities || '{}') }));
 res.json(enriched);
});

app.get('/api/llm/models/default', optionalAuth, (_req, res) => {
 const model = stmts.models.getDefault.get();
 if (!model) return res.json(null);
 const provider = stmts.providers.getById.get(model.provider_id);
 res.json({ ...model, provider_name: provider?.name || 'Unknown', capabilities: JSON.parse(model.capabilities || '{}') });
});

app.post('/api/llm/models/set-default', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
 const { model_id } = req.body;
 if (!model_id) return res.status(400).json({ error: 'model_id required' });
 const model = db.prepare('SELECT * FROM llm_models WHERE id = ?').get(model_id);
 if (!model) return res.status(404).json({ error: 'Model not found' });
 stmts.models.clearDefault.run();
 stmts.models.setDefault.run(model_id);
 audit('set_default', 'llm_model', model_id, req.user.id, {});
 res.json({ ok: true, model_id: model.model_id });
});

app.post('/api/llm/models/delete', authMiddleware, requireRole('admin'), (req, res) => {
 const { model_id } = req.body;
 if (!model_id) return res.status(400).json({ error: 'model_id required' });
 stmts.models.delete.run(model_id);
 res.json({ ok: true });
});

// ─── Detect ALL providers at once ────────────────────────────────
app.post('/api/llm/detect-all', authMiddleware, requireRole('admin'), apiLimiter, async (_req, res) => {
 const providers = stmts.providers.getAll.all().filter(p => p.enabled && p.api_key);
 const results = [];

 for (const provider of providers) {
   try {
     const detectRes = await fetch(`http://localhost:${PORT}/api/llm/providers/${provider.id}/detect`, {
       method: 'POST',
       headers: { 'Authorization': `Bearer ${_req.headers.authorization?.slice(7) || ''}`, 'Content-Type': 'application/json' },
     });
     const data = await detectRes.json();
     results.push({ provider: provider.name, status: 'ok', ...data });
   } catch (err) {
     results.push({ provider: provider.name, status: 'error', error: err.message });
   }
 }

 res.json({ results });
});

// ─── Seed default providers (no keys) ────────────────────────────
app.post('/api/llm/seed', authMiddleware, requireRole('admin'), apiLimiter, (_req, res) => {
 const seeds = Object.entries(PROVIDER_TYPES).map(([type, info]) => ({
   name: info.name,
   type,
   base_url: info.baseUrl,
 }));
 let created = 0;
 for (const seed of seeds) {
   const existing = stmts.providers.getByName.get(seed.name);
   if (!existing) {
     const id = randomUUID();
     stmts.providers.insert.run(id, seed.name, seed.type, '', seed.base_url, 0);
     created++;
   }
 }
 res.json({ seeded: created, total: seeds.length });
});

// ─── Settings / Env Vars ────────────────────────────────────────────
const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET || 'cf-default-secret-v1';
function xorCipher(text) {
  const buf = Buffer.from(text, 'utf8');
  const key = Buffer.from(ENCRYPT_SECRET, 'utf8');
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
  return buf.toString('base64');
}
function xorDecipher(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const key = Buffer.from(ENCRYPT_SECRET, 'utf8');
    for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
    return buf.toString('utf8');
  } catch { return b64; }
}

// GET /api/settings/env — list all env vars (mask encrypted values)
app.get('/api/settings/env', authMiddleware, requireRole('admin'), (_req, res) => {
  try {
    const rows = db.prepare('SELECT key, value, encrypted, category, created_at, updated_at FROM env_vars ORDER BY category, key').all();
    const masked = rows.map(r => ({
      ...r,
      value: r.encrypted ? xorDecipher(r.value) : r.value,
      encrypted: Boolean(r.encrypted),
    }));
    res.json(masked);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/env — upsert an env var
app.post('/api/settings/env', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  try {
    const { key, value, encrypted = 0, category = 'general' } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
    const storedVal = encrypted ? xorCipher(String(value)) : String(value);
    db.prepare(`INSERT INTO env_vars (key, value, encrypted, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=excluded.encrypted, category=excluded.category, updated_at=datetime('now')`)
      .run(key, storedVal, encrypted ? 1 : 0, category);
    // Also set in process.env for immediate use
    process.env[key] = String(value);
    res.json({ success: true, key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/settings/env/:key
app.delete('/api/settings/env/:key', authMiddleware, requireRole('admin'), (req, res) => {
  try {
    const { key } = req.params;
    const info = db.prepare('DELETE FROM env_vars WHERE key = ?').run(key);
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
    delete process.env[key];
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings/env/:key/test — test an API key
app.post('/api/settings/env/:key/test', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { key } = req.params;
    const row = db.prepare('SELECT value, encrypted, category FROM env_vars WHERE key = ?').get(key);
    if (!row) return res.status(404).json({ success: false, message: 'Variable not found' });
    const val = row.encrypted ? xorDecipher(row.value) : row.value;
    // Test based on key name / category
    if (key.toLowerCase().includes('openai') || row.category === 'llm') {
      try {
        const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${val}` }, signal: AbortSignal.timeout(8000) });
        if (r.ok) return res.json({ success: true, message: 'OpenAI API key valid' });
        return res.json({ success: false, message: `API returned ${r.status}` });
      } catch (e) { return res.json({ success: false, message: e.message }); }
    }
    // Generic test: just verify it's non-empty
    if (val && val.length > 5) return res.json({ success: true, message: 'Value looks valid (non-trivial length)' });
    return res.json({ success: false, message: 'Value too short to be a valid key' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Load stored env vars into process.env on startup
try {
  const stored = db.prepare('SELECT key, value, encrypted FROM env_vars').all();
  for (const row of stored) {
    process.env[row.key] = row.encrypted ? xorDecipher(row.value) : row.value;
  }
  if (stored.length) logger.info(`Loaded ${stored.length} env vars into process.env`);
} catch {}

// ─── Aimi Coding Agent (VS Code Copilot-style) ────────────────────
// Semi-autonomous mode: plan → draft diffs → user approves → write
// Agent mode: plan → read/write/exec autonomously → report results
// Autopilot: server-side loop with native function calling
// File scope: sandbox = /home/haz/ai-workspace/, home = /home/haz/

const SANDBOX_DIR = '/home/haz/ai-workspace';
const HOME_DIR = '/home/haz';
const CMD_BLOCKLIST = [
  'rm -rf', 'sudo', 'reboot', 'shutdown', 'mkfs', 'dd if=', 'kill -9',
  'systemctl stop', 'systemctl disable', 'chmod 777 /', 'chown root',
];
const ALLOWED_READ_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.json', '.md', '.txt', '.py', '.sh', '.html', '.css', '.yaml', '.yml', '.env', '.sql', '.xml'];
const MAX_AGENT_STEPS = 20;
const AGENT_STEP_DELAY_MS = 500;

function resolveSandboxPath(scope, targetPath) {
  const base = scope === 'home' ? HOME_DIR : SANDBOX_DIR;
  const resolved = path.resolve(base, targetPath || '.');
  if (!resolved.startsWith(base)) {
    throw new Error('Path traversal blocked: target outside scope');
  }
  return resolved;
}

function isCmdSafe(cmd) {
  const lower = (cmd || '').toLowerCase().trim();
  if (!lower || lower.length > 2000) return false;
  for (const blocked of CMD_BLOCKLIST) {
    if (lower.includes(blocked)) return false;
  }
  return true;
}

// ─── Agent Tool Registry ──────────────────────────────────────────
// Each tool has: name, description, parameters (OpenAI function format), execute function
const agentTools = [];

function registerAgentTool(name, description, parameters, executeFn) {
  agentTools.push({ name, description, parameters, execute: executeFn });
}

// OpenAI function-calling format for tool definitions
function getToolDefinitions() {
  return agentTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ─── Built-in Tools ───────────────────────────────────────────────

registerAgentTool(
  'file_read',
  'Read the contents of a file. Returns content with line numbers.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace' },
      scope: { type: 'string', enum: ['sandbox', 'home'], description: 'File scope boundary' },
    },
    required: ['path'],
  },
  async (args, ctx) => {
    const resolved = resolveSandboxPath(args.scope || ctx.scope || 'sandbox', args.path);
    const fs = await import('fs');
    const stat = await fs.promises.stat(resolved);
    if (stat.size > 500_000) return { error: 'File too large (max 500KB)' };
    const content = await fs.promises.readFile(resolved, 'utf-8');
    return { path: args.path, content: content.slice(0, 50000), size: stat.size, truncated: stat.size > 50000 };
  }
);

registerAgentTool(
  'file_write',
  'Write content to a file. Creates directories if needed.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace' },
      content: { type: 'string', description: 'File content to write' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
    },
    required: ['path', 'content'],
  },
  async (args, ctx) => {
    const resolved = resolveSandboxPath(args.scope || ctx.scope || 'sandbox', args.path);
    if (args.content.length > 500_000) return { error: 'Content too large (max 500KB)' };
    const fs = await import('fs');
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, args.content, 'utf-8');
    return { written: true, path: args.path, size: args.content.length };
  }
);

registerAgentTool(
  'file_list',
  'List files in a directory within the workspace.',
  {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Relative directory path (default: root)' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      depth: { type: 'integer', description: 'Max depth to traverse (default: 3)' },
    },
  },
  async (args, ctx) => {
    const base = (args.scope || ctx.scope || 'sandbox') === 'home' ? HOME_DIR : SANDBOX_DIR;
    const resolved = resolveSandboxPath(args.scope || ctx.scope || 'sandbox', args.dir || '.');
    const maxDepth = args.depth || 3;
    function walk(dir, currentDepth) {
      const items = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(base, full);
          if (entry.isDirectory() && currentDepth < maxDepth) {
            items.push({ name: entry.name, path: rel, type: 'dir' });
            if (!['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
              items.push(...walk(full, currentDepth + 1));
            }
          } else if (entry.isFile()) {
            items.push({ name: entry.name, path: rel, type: 'file', size: statSync(full).size });
          }
        }
      } catch {}
      return items;
    }
    return { files: walk(resolved, 0) };
  }
);

registerAgentTool(
  'file_search',
  'Search file contents using regex patterns. Returns matching lines with file paths.',
  {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      max_results: { type: 'integer', description: 'Max results to return (default: 20)' },
    },
    required: ['pattern'],
  },
  async (args, ctx) => {
    const base = (args.scope || ctx.scope || 'sandbox') === 'home' ? HOME_DIR : SANDBOX_DIR;
    // execSync is injected by the skill runtime
    try {
      const cmd = `grep -rn --include="*.{js,jsx,ts,tsx,mjs,json,md,txt,py,sh}" --max-count=${args.max_results || 20} "${args.pattern.replace(/"/g, '\\"')}" "${base}" 2>/dev/null | head -${args.max_results || 20}`;
      const stdout = execSync(cmd, { timeout: 10000, encoding: 'utf-8', maxBuffer: 1024 * 50 });
      const results = stdout.split('\n').filter(Boolean).map(line => {
        const [file, ...rest] = line.split(':');
        const lineNum = rest[0];
        const content = rest.slice(1).join(':');
        return { file: path.relative(base, file), line: parseInt(lineNum) || 0, content: content.slice(0, 200) };
      });
      return { matches: results, count: results.length };
    } catch (e) {
      return { matches: [], count: 0, error: e.message };
    }
  }
);

registerAgentTool(
  'shell_exec',
  'Execute a shell command in the workspace. Dangerous commands are blocked.',
  {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      cwd: { type: 'string', description: 'Working directory (relative to scope)' },
    },
    required: ['command'],
  },
  async (args, ctx) => {
    if (!isCmdSafe(args.command)) return { error: 'Command blocked by safety filter' };
    // execSync is injected by the skill runtime
    const workDir = (ctx.scope || args.scope || 'sandbox') === 'home' ? HOME_DIR : resolveSandboxPath(ctx.scope || args.scope || 'sandbox', args.cwd || '.');
    try {
      const stdout = execSync(args.command, { timeout: 30000, maxBuffer: 1024 * 100, cwd: workDir, encoding: 'utf-8' });
      return { exitCode: 0, stdout: stdout.slice(0, 5000), stderr: '' };
    } catch (e) {
      return { exitCode: e.status || 1, stdout: (e.stdout || '').toString().slice(0, 5000), stderr: (e.stderr || '').toString().slice(0, 2000) };
    }
  }
);

registerAgentTool(
  'web_search',
  'Search the web for information. Uses Tavily API.',
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'integer', description: 'Max results (default: 5)' },
    },
    required: ['query'],
  },
  async (args) => {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) return { error: 'Tavily API key not configured' };
    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: args.query,
          max_results: args.max_results || 5,
        }),
      });
      const data = await resp.json();
      return {
        results: (data.results || []).map(r => ({
          title: r.title,
          url: r.url,
          content: (r.content || '').slice(0, 500),
        })),
      };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'web_fetch',
  'Fetch a URL and extract text content.',
  {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
  async (args) => {
    try {
      const resp = await fetch(args.url, { timeout: 15000 });
      const text = await resp.text();
      // Strip HTML tags if it's HTML
      const stripped = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                           .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                           .replace(/<[^>]+>/g, ' ')
                           .replace(/\s+/g, ' ')
                           .trim();
      return { content: stripped.slice(0, 10000), url: args.url, status: resp.status, truncated: stripped.length > 10000 };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'git_op',
  'Perform git operations (status, diff, log, add, commit). Read-only operations are always allowed.',
  {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['status', 'diff', 'log', 'add', 'commit', 'branch'], description: 'Git operation' },
      args: { type: 'string', description: 'Arguments for the operation (e.g., commit message)' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
    },
    required: ['operation'],
  },
  async (args, ctx) => {
    const workDir = (args.scope || ctx.scope || 'sandbox') === 'home' ? HOME_DIR : SANDBOX_DIR;
    // execSync is injected by the skill runtime
    const ops = {
      status: 'git status --short',
      diff: 'git diff',
      log: 'git log --oneline -10',
      branch: 'git branch -a',
      add: 'git add -A',
      commit: `git commit -m "${(args.args || '').replace(/"/g, '\\"')}"`,
    };
    const cmd = ops[args.operation];
    if (!cmd) return { error: `Unknown git operation: ${args.operation}` };
    try {
      const stdout = execSync(cmd, { timeout: 10000, cwd: workDir, encoding: 'utf-8', maxBuffer: 1024 * 50 });
      return { output: stdout.slice(0, 5000) };
    } catch (e) {
      return { error: (e.stderr || e.message).toString().slice(0, 500) };
    }
  }
);

registerAgentTool(
  'mcp_invoke',
  'Invoke a registered MCP tool.',
  {
    type: 'object',
    properties: {
      server_id: { type: 'string', description: 'MCP server ID' },
      tool_name: { type: 'string', description: 'Tool name to invoke' },
      arguments: { type: 'object', description: 'Tool arguments' },
    },
    required: ['server_id', 'tool_name'],
  },
  async (args) => {
    try {
      const result = await mcp.invokeTool(args.server_id, args.tool_name, args.arguments || {});
      return { result };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'skill_invoke',
  'Invoke a stored Cardinal Frame skill by name.',
  {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name' },
      input: { type: 'string', description: 'Input for the skill' },
    },
    required: ['name'],
  },
  async (args) => {
    const skill = stmts.skills.getByName.get(args.name);
    if (!skill) return { error: `Skill not found: ${args.name}` };
    try {
      const { result: handlerResult } = await runSandboxed({
        code: skill.handler,
        input: args.input || '',
      });
      return { result: handlerResult };
    } catch (e) {
      return { error: e.message };
    }
  }
);

// ─── Execute a tool by name ───────────────────────────────────────
async function executeAgentTool(toolName, args, ctx) {
  const tool = agentTools.find(t => t.name === toolName);
  if (!tool) return { error: `Unknown tool: ${toolName}` };
  try {
    const result = await tool.execute(args || {}, ctx || {});
    fireHook('onAgentStep', { sessionId: ctx?.sessionId, toolName, args, result, success: !result.error });
    return result;
  } catch (e) {
    fireHook('onAgentStep', { sessionId: ctx?.sessionId, toolName, args, result: { error: e.message }, success: false });
    return { error: e.message };
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────
// Runs autonomously server-side: LLM plans → calls tools → gets results → continues
// Broadcasts progress over WebSocket. Returns final summary.

async function runAgentLoop(sessionId, options = {}) {
  const session = stmts.agentSessions.getById.get(sessionId);
  if (!session) throw new Error('Session not found');

  const ctx = { scope: session.scope, sessionId, userId: session.user_id };
  const maxSteps = options.maxSteps || MAX_AGENT_STEPS;
  const model = options.model || session.model || undefined;
  const toolDefs = getToolDefinitions();

  // Build initial system prompt
  const systemPrompt = `You are Aimi, an autonomous coding agent. You work by calling tools to accomplish tasks.

Task: ${session.task}
Mode: ${session.mode}
File scope: ${session.scope === 'sandbox' ? '/home/haz/ai-workspace (sandbox)' : '/home/haz (home dir)'}

You have access to the following tools. Call them by using function calling.
When the task is complete, respond with a summary (no tool call needed).

Remember:
- Read files before writing to understand existing code
- Use file_search to find relevant files
- Test your work with shell_exec
- Keep changes focused and minimal`;

  // Track conversation for LLM context
  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Please work on this task: ${session.task}` },
  ];

  // ─── Memory recall: inject relevant memories into context ──────
  try {
    const memResults = stmts.memories.search.all(session.task.slice(0, 50) + '*', session.user_id, 5);
    if (memResults && memResults.length > 0) {
      const memText = memResults.map(m => `- [${m.category}] ${m.content.slice(0, 200)}`).join('\n');
      messages.splice(1, 0, {
        role: 'system',
        content: `Relevant memories from past sessions:\n${memText}\n\nUse these if helpful for the current task.`,
      });
      logger.info(`Agent loop: injected ${memResults.length} memories into context`);
    }
  } catch (e) { /* FTS5 may not be ready in all envs */ }

  // ─── Index this session for future search ─────────────────────
  try {
    stmts.sessionIndex.insert.run(
      randomUUID(), 'agent', sessionId, session.user_id,
      session.task.slice(0, 100), session.task
    );
  } catch (e) { /* may already exist on resume */ }

  // Load any existing actions into context (for resumed sessions)
  const existingActions = stmts.agentActions.getBySession.all(sessionId);
  if (existingActions.length > 0) {
    for (const action of existingActions.slice(-10)) {
      messages.push({ role: 'assistant', content: `I performed ${action.action_type} on ${action.target}. Result: ${(action.result || '').slice(0, 200)}` });
    }
    messages.push({ role: 'user', content: 'Continue working on the task.' });
  }

  // Update session status
  stmts.agentSessions.updateStatus.run('executing', sessionId);
  broadcast('agent:loop:start', { session_id: sessionId, max_steps: maxSteps });

  let totalTokens = { prompt: 0, completion: 0 };

  for (let step = 0; step < maxSteps; step++) {
    broadcast('agent:step', { session_id: sessionId, step: step + 1, status: 'thinking' });
    stmts.agentSessions.updateStep.run(step + 1, sessionId);

    let llmResult;
    try {
      llmResult = await callAgentLLMWithToolsRetry(messages, toolDefs, model);
    } catch (e) {
      logger.error(`Agent loop LLM error at step ${step + 1}: ${e.message}`);
      broadcast('agent:loop:error', { session_id: sessionId, step: step + 1, error: e.message });
      stmts.agentSessions.updateStatus.run('failed', sessionId);

      // Record the error as an action for debugging
      const errActionId = randomUUID();
      const errStepIdx = stmts.agentActions.getBySession.all(sessionId).length;
      stmts.agentActions.insert.run(errActionId, sessionId, errStepIdx, 'error', 'llm_call', e.message, JSON.stringify({ error: e.message }), 'failed');

      return { completed: false, error: e.message, steps: step + 1, tokens: totalTokens };
    }

    totalTokens.prompt += llmResult.promptTokens || 0;
    totalTokens.completion += llmResult.completionTokens || 0;

    // If LLM returned a tool call, execute it
    if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
      for (const toolCall of llmResult.toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

        broadcast('agent:step', {
          session_id: sessionId,
          step: step + 1,
          status: 'executing_tool',
          tool: toolName,
          args: toolArgs,
        });

        // Execute the tool
        const result = await executeAgentTool(toolName, toolArgs, ctx);

        // Check if suggest mode requires approval
        if (session.mode === 'suggest' && ['file_write', 'shell_exec', 'git_op'].includes(toolName)) {
          const actionId = randomUUID();
          const stepIdx = stmts.agentActions.getBySession.all(sessionId).length;
          stmts.agentActions.insert.run(
            actionId, sessionId, stepIdx, toolName === 'file_write' ? 'write' : 'exec',
            toolArgs.path || toolArgs.command || toolName,
            toolArgs.content || JSON.stringify(toolArgs),
            JSON.stringify(result),
            'pending'
          );

          broadcast('agent:approval_required', {
            session_id: sessionId,
            step: step + 1,
            action_id: actionId,
            tool: toolName,
            args: toolArgs,
            result: result.error ? result : { preview: 'Draft created' },
          });

          stmts.agentSessions.updateStatus.run('awaiting_approval', sessionId);
          return {
            completed: false,
            paused: true,
            reason: 'approval_required',
            action_id: actionId,
            step: step + 1,
            tokens: totalTokens,
          };
        }

        // Record the action
        const actionId = randomUUID();
        const stepIdx = stmts.agentActions.getBySession.all(sessionId).length;
        stmts.agentActions.insert.run(
          actionId, sessionId, stepIdx,
          toolName === 'file_read' ? 'read' :
          toolName === 'file_write' ? 'write' :
          toolName === 'shell_exec' ? 'exec' :
          toolName === 'web_search' ? 'search' : toolName,
          toolArgs.path || toolArgs.command || toolArgs.query || toolName,
          toolArgs.content || JSON.stringify(toolArgs).slice(0, 2000),
          JSON.stringify(result).slice(0, 5000),
          'completed'
        );

        broadcast('agent:step', {
          session_id: sessionId,
          step: step + 1,
          status: 'tool_complete',
          tool: toolName,
          result_preview: JSON.stringify(result).slice(0, 200),
        });

        // Feed the result back to the LLM
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolName, arguments: toolCall.function.arguments } }],
        });
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify(result).slice(0, 4000),
        });
      }

      // Rate-limit delay between steps
      if (AGENT_STEP_DELAY_MS > 0) await new Promise(r => setTimeout(r, AGENT_STEP_DELAY_MS));
      continue;
    }

    // No tool call — LLM is either done or wants to say something
    const content = llmResult.content || '';

    // Record the final response
    const actionId = randomUUID();
    const stepIdx = stmts.agentActions.getBySession.all(sessionId).length;
    stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'response', 'complete', content.slice(0, 5000), JSON.stringify({ summary: content.slice(0, 2000) }), 'completed');

    stmts.agentSessions.updateStatus.run('completed', sessionId);
    broadcast('agent:loop:complete', {
      session_id: sessionId,
      steps: step + 1,
      summary: content.slice(0, 500),
      tokens: totalTokens,
    });

    // ── Comms reply: if this session was triggered by a comms message, send result back ──
    try {
      const commsMsg = db.prepare('SELECT * FROM comms_messages WHERE agent_session_id = ?').get(sessionId);
      if (commsMsg) {
        const channel = stmts.commsChannels.getById.get(commsMsg.channel_id);
        if (channel) {
          await sendCommsReply(channel, commsMsg, content);
        }
      }
    } catch (e) { logger.error(`Comms reply hook failed: ${e.message}`); }

    return {
      completed: true,
      summary: content,
      steps: step + 1,
      tokens: totalTokens,
    };
  }

  // Hit max steps
  stmts.agentSessions.updateStatus.run('max_steps_reached', sessionId);
  broadcast('agent:loop:complete', { session_id: sessionId, steps: maxSteps, summary: 'Max steps reached', tokens: totalTokens });

  return {
    completed: false,
    reason: 'max_steps_reached',
    steps: maxSteps,
    tokens: totalTokens,
  };
}

// ─── LLM call with native function calling ────────────────────────
async function callAgentLLMWithTools(messages, toolDefs, modelOverride) {
  let provider, modelRecord;
  if (modelOverride) {
    modelRecord = db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').get(modelOverride, modelOverride);
    if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider) {
    modelRecord = stmts.models.getDefault.get();
    if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider || !provider.api_key) throw new Error('No LLM provider with API key configured');

  const modelId = modelRecord?.model_id || 'gpt-3.5-turbo';
  const providerType = PROVIDER_TYPES[provider.type];
  const baseUrl = provider.base_url || providerType?.baseUrl || '';
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model: modelId,
    messages,
    max_tokens: 4096,
    stream: false,
  };

  // Include tools in the request if the provider supports function calling
  if (toolDefs && toolDefs.length > 0) {
    body.tools = toolDefs;
    body.tool_choice = 'auto';
  }

  const fetchHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.api_key}`,
    ...(provider.type === 'openrouter' ? { 'HTTP-Referer': 'https://cardinal-frame.local' } : {}),
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    throw new Error(`LLM fetch failed: ${fetchErr.message}`);
  }

  // If tools caused an error (some providers don't support function calling), retry without tools
  if (!resp.ok && toolDefs && toolDefs.length > 0) {
    const errText = await resp.text().catch(() => '');
    // Check if it's a tools-related error (400/422 with "tools" or "function" in the message)
    if ((resp.status === 400 || resp.status === 422) && /tool|function/i.test(errText)) {
      logger.warn(`Provider ${provider.name} doesn't support function calling, retrying with tool_prompt fallback`);
      // Remove tools and inject tool descriptions into system prompt instead
      const fallbackBody = { ...body };
      delete fallbackBody.tools;
      delete fallbackBody.tool_choice;
      // Enhance last system message with tool instructions
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        const toolList = toolDefs.map(t => `- ${t.function.name}: ${t.function.description}\n  Params: ${JSON.stringify(t.function.parameters).slice(0, 200)}`).join('\n');
        fallbackBody.messages = [...messages];
        fallbackBody.messages[sysIdx] = {
          ...messages[sysIdx],
          content: messages[sysIdx].content + `\n\n## Available Tools (use markdown format)\n${toolList}\n\nTo call a tool, respond with:\n\`\`\`tool_call\n{"tool": "tool_name", "arguments": {...}}\n\`\`\``,
        };
      }
      resp = await fetch(url, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(fallbackBody) });
    }
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM error (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const message = data.choices?.[0]?.message;
  const toolCalls = message?.tool_calls || [];

  // If no tool calls but content has ```tool_call blocks, parse them (fallback for providers without native function calling)
  if (toolCalls.length === 0 && message?.content) {
    const toolCallMatches = message.content.matchAll(/```tool_call\s*\n?([\s\S]*?)\n?```/g);
    for (const match of toolCallMatches) {
      try {
        const parsed = JSON.parse(match[1].trim());
        toolCalls.push({
          id: randomUUID(),
          type: 'function',
          function: {
            name: parsed.tool,
            arguments: JSON.stringify(parsed.arguments || {}),
          },
        });
      } catch {}
    }
  }

  return {
    content: message?.content || '',
    toolCalls,
    model: modelId,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
  };
}

// Retry wrapper for callAgentLLMWithTools (handles 429 rate limits)
async function callAgentLLMWithToolsRetry(messages, toolDefs, modelOverride, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callAgentLLMWithTools(messages, toolDefs, modelOverride);
    } catch (err) {
      lastErr = err;
      const is429 = err.message?.includes('(429)') || err.message?.includes('Too Many Requests');
      if (is429 && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        logger.warn(`Agent LLM rate limited, retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── Context window management ────────────────────────────────────
function compactAgentHistory(messages, maxMessages = 20) {
  if (messages.length <= maxMessages) return messages;
  // Keep system prompt + first user msg + last N messages
  const system = messages.filter(m => m.role === 'system');
  const firstUser = messages.find(m => m.role === 'user');
  const recent = messages.slice(-maxMessages + 2);

  // Summarize dropped messages
  const dropped = messages.slice(2, -maxMessages + 2);
  const summary = `Previous actions (summarized):\n${dropped.map(m => {
    if (m.role === 'tool') return `- Tool ${m.name}: ${m.content.slice(0, 100)}`;
    if (m.role === 'assistant') return `- Assistant: ${(m.content || 'tool call').slice(0, 100)}`;
    return `- ${m.role}: ${(m.content || '').slice(0, 100)}`;
  }).join('\n')}`;

  return [...system, { role: 'user', content: summary }, ...recent];
}

async function callAgentLLM(messages, modelOverride) {
  let provider, modelRecord;
  if (modelOverride) {
    modelRecord = db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').get(modelOverride, modelOverride);
    if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider) {
    modelRecord = stmts.models.getDefault.get();
    if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider || !provider.api_key) throw new Error('No LLM provider with API key configured');
  const modelId = modelRecord?.model_id || 'gpt-3.5-turbo';
  const providerType = PROVIDER_TYPES[provider.type];
  const baseUrl = provider.base_url || providerType?.baseUrl || '';
  const url = `${baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.api_key}`,
      ...(provider.type === 'openrouter' ? { 'HTTP-Referer': 'https://cardinal-frame.local' } : {}),
    },
    body: JSON.stringify({ model: modelId, messages, max_tokens: 4096, stream: false }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM error (${resp.status}): ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model: modelId,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
  };
}

// ─── LLM Call with Retry + Concurrency Limiting ──────────────────
const MAX_CONCURRENT_LLM = 3;
let _activeLLMCalls = 0;
const _llmQueue = [];

function _drainLLMQueue() {
  while (_llmQueue.length > 0 && _activeLLMCalls < MAX_CONCURRENT_LLM) {
    const next = _llmQueue.shift();
    _activeLLMCalls++;
    next.run().finally(() => { _activeLLMCalls--; _drainLLMQueue(); });
  }
}

async function callAgentLLMWithRetry(messages, modelOverride, maxRetries = 3) {
  // Queue if at capacity
  if (_activeLLMCalls >= MAX_CONCURRENT_LLM) {
    await new Promise(resolve => _llmQueue.push({ run: () => Promise.resolve() }));
  }
  _activeLLMCalls++;

  try {
    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await callAgentLLM(messages, modelOverride);
      } catch (err) {
        lastErr = err;
        const is429 = err.message?.includes('LLM error (429)') || err.message?.includes('429') || err.message?.includes('Too Many Requests');
        if (is429 && attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          logger.warn(`LLM rate limited, retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    _activeLLMCalls--;
    _drainLLMQueue();
  }
}

// POST /api/agent/sessions — create a new agent session
app.post('/api/agent/sessions', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { task, mode = 'agent', scope = 'sandbox', conversation_id, model } = req.body;
    if (!task) return res.status(400).json({ error: 'task required' });
    if (!['agent', 'suggest'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    if (!['sandbox', 'home'].includes(scope)) return res.status(400).json({ error: 'Invalid scope' });
    const id = randomUUID();
    stmts.agentSessions.insert.run(id, req.user.id, conversation_id || null, task, mode, scope, '[]', 'planning', model || '');
    const session = stmts.agentSessions.getById.get(id);
    broadcast('agent:session', { type: 'created', session });
    res.status(201).json(session);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/sessions — list user's sessions
app.get('/api/agent/sessions', authMiddleware, apiLimiter, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const sessions = db.prepare('SELECT * FROM agent_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.user.id, limit);
    res.json(sessions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/sessions/:id — get session with actions
app.get('/api/agent/sessions/:id', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const actions = stmts.agentActions.getBySession.all(req.params.id);
    res.json({ ...session, plan: JSON.parse(session.plan || '[]'), actions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/agent/sessions/:id/mode — toggle mode (suggest ↔ agent)
app.patch('/api/agent/sessions/:id/mode', authMiddleware, (req, res) => {
  try {
    const { mode } = req.body;
    if (!['agent', 'suggest'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.agentSessions.updateMode.run(mode, req.params.id);
    const updated = stmts.agentSessions.getById.get(req.params.id);
    broadcast('agent:session', { type: 'mode_changed', session: updated });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/plan — generate a plan for a task using LLM
app.post('/api/agent/plan', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { task, scope = 'sandbox', model } = req.body;
    if (!task) return res.status(400).json({ error: 'task required' });
    const planPrompt = `You are Aimi, an autonomous coding agent. Analyze the following task and create a step-by-step plan.
Task: ${task}
File scope: ${scope === 'sandbox' ? '/home/haz/ai-workspace (sandbox)' : '/home/haz (home dir)'}

Respond as JSON:
{
  "steps": [
    { "description": "Read file X", "action": "read", "target": "path/to/file" },
    { "description": "Write code Y", "action": "write", "target": "path/to/file" },
    { "description": "Run build", "action": "exec", "target": "npm run build" }
  ]
}
Only include steps you are confident about. Keep it to max 8 steps.`;
    const result = await callAgentLLM([
      { role: 'system', content: planPrompt },
      { role: 'user', content: task }
    ], model);
    let plan;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      plan = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      plan = { steps: [{ description: result.content.slice(0, 500), action: 'response', target: 'LLM response' }] };
    }
    res.json({
      plan: plan.steps || [],
      model: result.model,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/read — read a file from sandbox/home scope
app.post('/api/agent/read', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { path: targetPath, scope = 'sandbox' } = req.body;
    if (!targetPath) return res.status(400).json({ error: 'path required' });
    const resolved = resolveSandboxPath(scope, targetPath);
    const fs = await import('fs');
    const stat = await fs.promises.stat(resolved);
    if (stat.size > 500_000) return res.status(400).json({ error: 'File too large (max 500KB)' });
    const content = await fs.promises.readFile(resolved, 'utf-8');
    res.json({
      path: targetPath,
      resolved,
      content: content.slice(0, 50000),
      size: stat.size,
      truncated: stat.size > 50000,
    });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    if (e.message.includes('Path traversal')) return res.status(403).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/workspace — list files in sandbox
app.get('/api/agent/workspace', authMiddleware, (req, res) => {
  try {
    const { scope = 'sandbox', depth = 3 } = req.query;
    const base = scope === 'home' ? HOME_DIR : SANDBOX_DIR;
    function walk(dir, currentDepth, maxDepth) {
      const items = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(base, full);
          if (entry.isDirectory() && currentDepth < maxDepth) {
            items.push({ name: entry.name, path: rel, type: 'dir' });
            if (!['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
              items.push(...walk(full, currentDepth + 1, maxDepth));
            }
          } else if (entry.isFile()) {
            items.push({ name: entry.name, path: rel, type: 'file', size: statSync(full).size });
          }
        }
      } catch {}
      return items;
    }
    const tree = walk(base, 0, parseInt(depth));
    res.json(tree);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/write — write a file (agent mode) or draft a diff (suggest mode)
app.post('/api/agent/write', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { path: targetPath, content, scope = 'sandbox', session_id, mode = 'agent' } = req.body;
    if (!targetPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const resolved = resolveSandboxPath(scope, targetPath);
    const fs = await import('fs');
    if (content.length > 500_000) return res.status(400).json({ error: 'Content too large (max 500KB)' });

    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;

    if (mode === 'suggest') {
      let oldContent = '';
      try { oldContent = await fs.promises.readFile(resolved, 'utf-8'); } catch {}
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'write', targetPath, content, 'awaiting approval', 'pending');
      res.json({
        action: 'draft',
        path: targetPath,
        oldContent: oldContent.slice(0, 20000),
        newContent: content,
        truncated: oldContent.length > 20000,
        action_id: actionId,
        requiresApproval: true,
      });
    } else {
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(resolved, content, 'utf-8');
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'write', targetPath, content, 'written', 'completed');
      broadcast('agent:action', { type: 'write', path: targetPath, session_id: sessionId, action_id: actionId });
      res.json({ action: 'written', path: targetPath, size: content.length, action_id: actionId });
    }
  } catch (e) {
    if (e.message.includes('Path traversal')) return res.status(403).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/approve — approve a pending action (suggest mode)
app.post('/api/agent/approve', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { action_id, scope = 'sandbox' } = req.body;
    if (!action_id) return res.status(400).json({ error: 'action_id required' });
    const action = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(action_id);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.status !== 'pending') return res.status(400).json({ error: 'Action already processed' });

    const resolved = resolveSandboxPath(scope, action.target);
    const fs = await import('fs');
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, action.content || '', 'utf-8');
    stmts.agentActions.updateStatus.run('approved', req.user.id, action_id);
    broadcast('agent:action', { type: 'approved', action_id, path: action.target });
    res.json({ action: 'approved', path: action.target, action_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/reject — reject a pending action
app.post('/api/agent/reject', authMiddleware, (req, res) => {
  try {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ error: 'action_id required' });
    stmts.agentActions.updateStatus.run('rejected', req.user.id, action_id);
    broadcast('agent:action', { type: 'rejected', action_id });
    res.json({ action: 'rejected', action_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/exec — execute a shell command (agent mode only)
app.post('/api/agent/exec', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { command, scope = 'sandbox', session_id, cwd } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    if (!isCmdSafe(command)) return res.status(403).json({ error: 'Command blocked by safety filter' });
    // execSync is injected by the skill runtime
    const workDir = scope === 'home' ? HOME_DIR : resolveSandboxPath(scope, cwd || '.');
    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;

    try {
      const stdout = execSync(command, {
        timeout: 30000,
        maxBuffer: 1024 * 100,
        cwd: workDir,
        encoding: 'utf-8',
      });
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'exec', command, stdout.slice(0, 5000), 'completed', 'completed');
      broadcast('agent:action', { type: 'exec', command, session_id: sessionId, action_id: actionId });
      res.json({ exitCode: 0, stdout: stdout.slice(0, 5000), stderr: '', action_id: actionId });
    } catch (e) {
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'exec', command, '', (e.stderr || '').slice(0, 2000), 'failed', 'failed');
      res.json({ exitCode: e.status || 1, stdout: (e.stdout || '').toString().slice(0, 5000), stderr: (e.stderr || '').toString().slice(0, 2000), action_id: actionId });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/iterate — feed results back to LLM for next action
app.post('/api/agent/iterate', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { session_id, context, model } = req.body;
    const session = session_id ? stmts.agentSessions.getById.get(session_id) : null;
    const task = session?.task || context?.task || 'Continue working';
    const actions = session_id ? stmts.agentActions.getBySession.all(session_id) : [];
    const actionSummary = actions.slice(-5).map(a => `[${a.action_type}] ${a.target || ''}: ${(a.result || a.content || '').slice(0, 200)}`).join('\n');

    const iteratePrompt = `You are Aimi, an autonomous coding agent. Continue working on this task.
Task: ${task}
Mode: ${session?.mode || 'agent'}

Recent actions:
${actionSummary || 'No actions yet'}

New context: ${context?.message || 'Continue'}

Respond with the NEXT action as JSON:
{ "action": "read|write|exec|response", "target": "path or command", "content": "file content if write", "done": false }
If task is complete, respond with: { "action": "response", "target": "complete", "content": "summary of what was done", "done": true }`;

    const result = await callAgentLLM([
      { role: 'system', content: iteratePrompt },
      { role: 'user', content: context?.message || 'Continue' }
    ], model || session?.model);

    let nextAction;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      nextAction = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      nextAction = { action: 'response', target: 'LLM response', content: result.content.slice(0, 1000), done: false };
    }

    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;
    stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'iterate', nextAction.target || '', nextAction.content || '', JSON.stringify(nextAction), 'completed');

    if (nextAction.done && sessionId) {
      stmts.agentSessions.updateStatus.run('completed', sessionId);
      broadcast('agent:session', { type: 'completed', session_id: sessionId });
    }

    res.json({
      nextAction,
      model: result.model,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
      done: nextAction.done || false,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/agent/sessions/:id — delete a session
app.delete('/api/agent/sessions/:id', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    db.prepare('DELETE FROM agent_actions WHERE session_id = ?').run(req.params.id);
    stmts.agentSessions.delete.run(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Autopilot Endpoints (server-side agent loop) ─────────────────

// POST /api/agent/run — start autonomous agent loop for a session
app.post('/api/agent/run', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { session_id, max_steps, model } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const session = stmts.agentSessions.getById.get(session_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (session.status === 'executing') return res.status(409).json({ error: 'Session is already running' });

    // Start the loop (async — doesn't block the response)
    runAgentLoop(session_id, { maxSteps: max_steps, model })
      .then(result => {
        logger.info(`Agent loop completed for ${session_id}: ${result.completed ? 'done' : 'stopped'} in ${result.steps} steps`);
      })
      .catch(err => {
        logger.error(`Agent loop failed for ${session_id}: ${err.message}`);
        stmts.agentSessions.updateStatus.run('failed', session_id);
        broadcast('agent:loop:error', { session_id, error: err.message });
      });

    res.json({ started: true, session_id, max_steps: max_steps || MAX_AGENT_STEPS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/sessions/:id/resume — resume a paused/failed session
app.post('/api/agent/sessions/:id/resume', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (session.status === 'executing') return res.status(409).json({ error: 'Session is already running' });

    const { max_steps, model } = req.body;

    runAgentLoop(req.params.id, { maxSteps: max_steps, model })
      .then(result => {
        logger.info(`Agent loop resumed for ${req.params.id}: ${result.completed ? 'done' : 'stopped'} in ${result.steps} steps`);
      })
      .catch(err => {
        logger.error(`Agent loop resume failed for ${req.params.id}: ${err.message}`);
        stmts.agentSessions.updateStatus.run('failed', req.params.id);
        broadcast('agent:loop:error', { session_id: req.params.id, error: err.message });
      });

    res.json({ resumed: true, session_id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/sessions/:id/stop — stop a running session
app.post('/api/agent/sessions/:id/stop', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    stmts.agentSessions.updateStatus.run('stopped', req.params.id);
    broadcast('agent:loop:stopped', { session_id: req.params.id });
    res.json({ stopped: true, session_id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/tools — list available agent tools
app.get('/api/agent/tools', authMiddleware, (_req, res) => {
  res.json(agentTools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  })));
});

// ─── Memory API (persistent cross-session memory) ────────────────

// POST /api/memory — store a memory
app.post('/api/memory', authMiddleware, apiLimiter, (req, res) => {
  try {
    const { category = 'memory', content, source = 'manual', confidence = 1.0 } = req.body;
    if (!content) return res.status(400).json({ error: 'content required' });
    const id = randomUUID();
    stmts.memories.insert.run(id, req.user.id, category, content, source, confidence);
    // Index in FTS
    try { db.prepare('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)').run(db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id).rowid, content); } catch {}
    broadcast('memory:created', { id, category, content: content.slice(0, 100) });
    res.status(201).json({ id, category, content, source, confidence });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/memory/stats — memory statistics (must be before /:id)
app.get('/api/memory/stats', authMiddleware, (req, res) => {
  try {
    const count = stmts.memories.count.get(req.user.id).count;
    const all = stmts.memories.getByUser.all(req.user.id);
    const byCategory = {};
    for (const m of all) byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    res.json({ total: count, by_category: byCategory });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/memory — list memories (optionally filtered by category)
app.get('/api/memory', authMiddleware, (req, res) => {
  try {
    const { category, q, limit: lim } = req.query;
    const limit = Math.min(parseInt(lim) || 50, 200);

    if (q) {
      // FTS5 search
      const results = stmts.memories.search.all(q + '*', req.user.id, limit);
      for (const m of results) stmts.memories.updateAccess.run(m.id);
      return res.json(results);
    }

    if (category) {
      return res.json(stmts.memories.getByCategory.all(req.user.id, category));
    }
    res.json(stmts.memories.getByUser.all(req.user.id).slice(0, limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/memory/:id — get a specific memory
app.get('/api/memory/:id', authMiddleware, (req, res) => {
  try {
    const memory = stmts.memories.getById.get(req.params.id);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    if (memory.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    stmts.memories.updateAccess.run(req.params.id);
    res.json(memory);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/memory/:id — update a memory
app.patch('/api/memory/:id', authMiddleware, (req, res) => {
  try {
    const memory = stmts.memories.getById.get(req.params.id);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    if (memory.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { content, category } = req.body;
    stmts.memories.update.run(content || memory.content, category || memory.category, req.params.id);
    // Update FTS
    try { db.prepare('UPDATE memories_fts SET content = ? WHERE rowid = ?').run(content || memory.content, db.prepare('SELECT rowid FROM memories WHERE id = ?').get(req.params.id).rowid); } catch {}
    res.json({ ...memory, content: content || memory.content, category: category || memory.category });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/memory/:id — delete a memory
app.delete('/api/memory/:id', authMiddleware, (req, res) => {
  try {
    const memory = stmts.memories.getById.get(req.params.id);
    if (!memory) return res.status(404).json({ error: 'Memory not found' });
    if (memory.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    try { db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(db.prepare('SELECT rowid FROM memories WHERE id = ?').get(req.params.id).rowid); } catch {}
    stmts.memories.delete.run(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Session Search API (FTS5 across chat + agent sessions) ───────

// GET /api/search — full-text search across all sessions
app.get('/api/search', authMiddleware, (req, res) => {
  try {
    const { q, limit: lim } = req.query;
    if (!q) return res.status(400).json({ error: 'q (query) required' });
    const limit = Math.min(parseInt(lim) || 20, 100);
    const results = stmts.sessionIndex.getUserSearch.all(q + '*', req.user.id, limit);
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/search/index — manually index a chat message or agent action
app.post('/api/search/index', authMiddleware, (req, res) => {
  try {
    const { session_type, ref_id, title, content } = req.body;
    if (!session_type || !ref_id || !content) return res.status(400).json({ error: 'session_type, ref_id, content required' });
    const id = randomUUID();
    stmts.sessionIndex.insert.run(id, session_type, ref_id, req.user.id, title || '', content);
    // Index in FTS
    try { db.prepare('INSERT INTO session_index_fts(rowid, content, title) VALUES (?, ?, ?)').run(db.prepare('SELECT rowid FROM session_index WHERE id = ?').get(id).rowid, content, title || ''); } catch {}
    res.status(201).json({ id, indexed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Embedding Engine Endpoints ─────────────────────────────────────

// GET /api/embeddings/status — check if model is loaded
app.get('/api/embeddings/status', authMiddleware, (_req, res) => {
  res.json(embeddings.getEmbeddingStatus());
});

// POST /api/embeddings/load — load the MiniLM model on demand
app.post('/api/embeddings/load', authMiddleware, requireRole('admin'), apiLimiter, async (_req, res) => {
  try {
    if (embeddings.isModelLoaded()) return res.json({ loaded: true, message: 'Already loaded' });
    await embeddings.getEmbeddingPipeline();
    res.json({ loaded: true, message: 'Model loaded', ...embeddings.getEmbeddingStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/embeddings/unload — unload model to free memory
app.post('/api/embeddings/unload', authMiddleware, requireRole('admin'), (_req, res) => {
  const unloaded = embeddings.unloadEmbeddingModel();
  res.json({ unloaded, status: embeddings.getEmbeddingStatus() });
});

// POST /api/embeddings/generate — generate embeddings for given text
app.post('/api/embeddings/generate', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { text, texts } = req.body;
    if (texts && Array.isArray(texts)) {
      const result = await embeddings.embedBatch(texts);
      return res.json({ embeddings: result, count: result.length, dim: result[0]?.length || 0 });
    }
    if (!text) return res.status(400).json({ error: 'text or texts required' });
    const result = await embeddings.embed(text);
    res.json({ embedding: result, dim: result.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/embeddings/similarity — compute cosine similarity between two texts
app.post('/api/embeddings/similarity', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { text1, text2 } = req.body;
    if (!text1 || !text2) return res.status(400).json({ error: 'text1 and text2 required' });
    const [emb1, emb2] = await embeddings.embedBatch([text1, text2]);
    const sim = embeddings.cosineSimilarity(emb1, emb2);
    res.json({ similarity: sim });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/embeddings/search — semantic search over provided corpus
app.post('/api/embeddings/search', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { query, corpus, limit = 5 } = req.body;
    if (!query || !corpus || !Array.isArray(corpus)) {
      return res.status(400).json({ error: 'query (string) and corpus (string[]) required' });
    }
    if (corpus.length === 0) return res.json({ results: [] });

    const queryEmb = await embeddings.embed(query);
    const corpusEmbs = await embeddings.embedBatch(corpus);
    const results = embeddings.searchSimilar(queryEmb, corpusEmbs, limit);

    res.json({
      results: results.map(r => ({
        index: r.index,
        text: corpus[r.index],
        similarity: r.similarity,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Comms Engine: Telegram + Discord Integration ──────────────────
// Real bidirectional messaging: bot polling, webhook dispatch, message→agent bridge

// In-memory state
const telegramPollers = new Map(); // channelId -> { offset, timer, stopFlag }
const discordPollers = new Map();

// ── Helpers ──

async function telegramApiCall(token, method, params = {}) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Telegram API error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(`Telegram API returned !ok: ${JSON.stringify(data)}`);
  return data.result;
}

async function discordWebhookSend(webhookUrl, content, opts = {}) {
  const body = { content, username: opts.username || 'Cardinal Frame', ...opts.embeds ? { embeds: opts.embeds } : {} };
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord webhook error ${resp.status}: ${text}`);
  }
  return { sent: true };
}

// ── Store + broadcast a comms message ──

function storeCommsMessage(channelId, platform, direction, { remote_id, remote_username, content, raw, agentSessionId, status }) {
  const id = randomUUID();
  stmts.commsMessages.insert.run(
    id, channelId, platform, direction,
    remote_id || null, remote_username || null, content,
    raw || null, agentSessionId || null, status || 'sent'
  );
  const msg = stmts.commsMessages.getById.get(id);
  broadcast('comms:message', msg);
  fireHook('onCommsMessage', { channelId, platform, direction, message: msg });
  return msg;
}

// ── Send agent result back to the comms channel ──

async function sendCommsReply(channel, originalMsg, agentResult) {
  const config = JSON.parse(channel.config);
  const replyText = `🤖 ${agentResult.slice(0, 3000)}`;

  if (channel.platform === 'telegram') {
    if (!config.bot_token) return;
    const targetChatId = originalMsg.remote_id || config.chat_id;
    if (!targetChatId) return;
    try {
      await telegramApiCall(config.bot_token, 'sendMessage', {
        chat_id: targetChatId,
        text: replyText,
        parse_mode: 'Markdown',
      });
      storeCommsMessage(channel.id, 'telegram', 'outbound', {
        remote_id: String(targetChatId),
        remote_username: originalMsg.remote_username,
        content: replyText,
        status: 'sent',
      });
      logger.info(`Comms reply sent to Telegram (agent result for ${originalMsg.remote_username})`);
    } catch (e) {
      logger.error(`Comms reply to Telegram failed: ${e.message}`);
      storeCommsMessage(channel.id, 'telegram', 'outbound', {
        remote_id: String(targetChatId),
        remote_username: originalMsg.remote_username,
        content: replyText,
        status: 'failed',
      });
    }
  } else if (channel.platform === 'discord') {
    // Try webhook first, fall back to bot REST
    if (config.webhook_url) {
      try {
        await discordWebhookSend(config.webhook_url, replyText, { username: config.bot_name || 'Cardinal Frame Agent' });
        storeCommsMessage(channel.id, 'discord', 'outbound', {
          remote_id: originalMsg.remote_id,
          remote_username: originalMsg.remote_username,
          content: replyText,
          status: 'sent',
        });
        logger.info(`Comms reply sent to Discord via webhook (agent result for ${originalMsg.remote_username})`);
        return;
      } catch (e) { logger.error(`Discord webhook reply failed: ${e.message}`); }
    }
    if (config.bot_token && config.channel_id) {
      try {
        await fetch(`https://discord.com/api/v10/channels/${config.channel_id}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bot ${config.bot_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: replyText }),
        });
        storeCommsMessage(channel.id, 'discord', 'outbound', {
          remote_id: originalMsg.remote_id,
          remote_username: originalMsg.remote_username,
          content: replyText,
          status: 'sent',
        });
        logger.info(`Comms reply sent to Discord via bot (agent result for ${originalMsg.remote_username})`);
      } catch (e) {
        logger.error(`Comms reply to Discord bot failed: ${e.message}`);
        storeCommsMessage(channel.id, 'discord', 'outbound', {
          remote_id: originalMsg.remote_id,
          remote_username: originalMsg.remote_username,
          content: replyText,
          status: 'failed',
        });
      }
    }
  }
}

// ── Telegram long-polling ──

async function pollTelegram(channel) {
  const config = JSON.parse(channel.config);
  if (!config.bot_token) return;
  
  const state = telegramPollers.get(channel.id) || { offset: 0, stopFlag: false };
  
  try {
    stmts.commsChannels.updatePolling.run(1, new Date().toISOString(), channel.id);
    const updates = await telegramApiCall(config.bot_token, 'getUpdates', {
      offset: state.offset,
      timeout: 2,
      limit: 20,
    });
    
    for (const update of updates) {
      if (update.update_id >= state.offset) state.offset = update.update_id + 1;
      
      const msg = update.message || update.channel_post;
      if (!msg || !msg.text) continue;
      
      // Store inbound message
      const commsMsg = storeCommsMessage(channel.id, 'telegram', 'inbound', {
        remote_id: String(msg.from?.id || msg.chat?.id || ''),
        remote_username: msg.from?.username || msg.from?.first_name || '',
        content: msg.text,
        raw: JSON.stringify(update),
        status: 'received',
      });
      
      logger.info(`Telegram inbound from ${commsMsg.remote_username}: ${msg.text.slice(0, 60)}`);
      
      // Auto-respond if configured
      if (config.auto_reply) {
        try {
          const reply = await generateAutoReply(msg.text, channel);
          await telegramApiCall(config.bot_token, 'sendMessage', {
            chat_id: msg.chat?.id || msg.from?.id,
            text: reply,
            parse_mode: 'Markdown',
          });
          storeCommsMessage(channel.id, 'telegram', 'outbound', {
            remote_id: String(msg.chat?.id || msg.from?.id || ''),
            remote_username: commsMsg.remote_username,
            content: reply,
            status: 'sent',
          });
        } catch (e) {
          logger.error(`Telegram auto-reply failed: ${e.message}`);
          storeCommsMessage(channel.id, 'telegram', 'outbound', {
            remote_id: String(msg.chat?.id || msg.from?.id || ''),
            remote_username: commsMsg.remote_username,
            content: `[ERROR] ${e.message}`,
            status: 'failed',
          });
        }
      }
      
      // Trigger agent if configured
      if (config.trigger_agent && msg.text) {
        try {
          const agentSessionId = await triggerAgentFromComms(channel, commsMsg);
          if (agentSessionId) {
            stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
          }
        } catch (e) {
          logger.error(`Agent trigger from Telegram failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    logger.error(`Telegram poll error (${channel.name}): ${e.message}`);
  } finally {
    if (!state.stopFlag) {
      telegramPollers.set(channel.id, state);
      state.timer = setTimeout(() => pollTelegram(channel), 3000);
    } else {
      stmts.commsChannels.updatePolling.run(0, null, channel.id);
      telegramPollers.delete(channel.id);
    }
  }
}

// ── Discord (webhook for outbound, bot polling for inbound) ──

async function pollDiscord(channel) {
  const config = JSON.parse(channel.config);
  if (!config.bot_token) return;
  
  const state = discordPollers.get(channel.id) || { lastMsgId: null, stopFlag: false };
  
  try {
    stmts.commsChannels.updatePolling.run(1, new Date().toISOString(), channel.id);
    
    // Use Discord REST API to fetch recent messages from configured channel
    const guildId = config.guild_id;
    const channelId = config.channel_id;
    const headers = { 'Authorization': `Bot ${config.bot_token}` };
    
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=10${state.lastMsgId ? `&after=${state.lastMsgId}` : ''}`;
    const resp = await fetch(url, { headers });
    
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Discord API ${resp.status}: ${text}`);
    }
    
    const messages = await resp.json();
    for (const dm of messages) {
      if (state.lastMsgId && BigInt(dm.id) <= BigInt(state.lastMsgId)) continue;
      state.lastMsgId = dm.id;
      if (!dm.content) continue;
      
      // Store inbound
      const commsMsg = storeCommsMessage(channel.id, 'discord', 'inbound', {
        remote_id: dm.author?.id || '',
        remote_username: dm.author?.username || '',
        content: dm.content,
        raw: JSON.stringify(dm),
        status: 'received',
      });
      
      logger.info(`Discord inbound from ${commsMsg.remote_username}: ${dm.content.slice(0, 60)}`);
      
      // Auto-respond
      if (config.auto_reply) {
        try {
          const reply = await generateAutoReply(dm.content, channel);
          await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: reply }),
          });
          storeCommsMessage(channel.id, 'discord', 'outbound', {
            remote_id: dm.author?.id || '',
            remote_username: commsMsg.remote_username,
            content: reply,
            status: 'sent',
          });
        } catch (e) {
          logger.error(`Discord auto-reply failed: ${e.message}`);
        }
      }
      
      // Trigger agent
      if (config.trigger_agent && dm.content) {
        try {
          const agentSessionId = await triggerAgentFromComms(channel, commsMsg);
          if (agentSessionId) {
            stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
          }
        } catch (e) {
          logger.error(`Agent trigger from Discord failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    logger.error(`Discord poll error (${channel.name}): ${e.message}`);
  } finally {
    if (!state.stopFlag) {
      discordPollers.set(channel.id, state);
      state.timer = setTimeout(() => pollDiscord(channel), 5000);
    } else {
      stmts.commsChannels.updatePolling.run(0, null, channel.id);
      discordPollers.delete(channel.id);
    }
  }
}

// ── Auto-reply generator (uses LLM if configured, else echo) ──

async function generateAutoReply(text, channel) {
  const config = JSON.parse(channel.config);
  
  if (config.auto_reply_template) {
    return config.auto_reply_template.replace('{text}', text);
  }
  
  // Try LLM if available
  try {
    const defaultModel = stmts.llmModels.getDefault.get();
    if (defaultModel) {
      const provider = stmts.llmProviders.getById.get(defaultModel.provider_id);
      if (provider) {
        const response = await callAgentLLM([
          { role: 'system', content: "You are Cardinal Frame's comms assistant. Reply concisely." },
          { role: 'user', content: text },
        ], defaultModel.id);
        return response || 'Processed.';
      }
    }
  } catch {}
  
  return `✅ Received: "${text.slice(0, 100)}"`;
}

// ── Trigger an agent session from an incoming comms message ──

async function triggerAgentFromComms(channel, commsMsg) {
  const config = JSON.parse(channel.config);
  const userId = config.user_id || 'haz-001'; // default to admin
  
  // Find or create a user mapping
  if (!stmts.users.getById) {
    stmts.users.getById = db.prepare('SELECT * FROM users WHERE id = ?');
  }
  
  const sessionId = randomUUID();
  const task = `[${channel.platform}/${channel.name}] ${commsMsg.content}`;
  const scope = config.agent_scope || 'sandbox';
  const mode = config.agent_mode || 'agent';
  const model = config.agent_model || '';
  
  stmts.agentSessions.insert.run(
    sessionId, userId, null, task, mode, scope, '[]', 'planning', model
  );
  const session = stmts.agentSessions.getById.get(sessionId);
  broadcast('agent:session', { type: 'created', session, source: 'comms', channel });
  logger.info(`Agent session ${sessionId} created from ${channel.platform} message`);
  
  // Run the agent loop in the background
  runAgentLoop(sessionId, { maxSteps: 10 }).catch(e => {
    logger.error(`Agent loop from comms failed: ${e.message}`);
  });
  
  return sessionId;
}

// ── Start/stop pollers for enabled channels ──

function startChannelPoller(channel) {
  if (channel.platform === 'telegram') {
    if (telegramPollers.has(channel.id)) return;
    telegramPollers.set(channel.id, { offset: 0, stopFlag: false });
    pollTelegram(channel);
  } else if (channel.platform === 'discord') {
    if (discordPollers.has(channel.id)) return;
    discordPollers.set(channel.id, { lastMsgId: null, stopFlag: false });
    pollDiscord(channel);
  }
}

function stopChannelPoller(channelId) {
  const tg = telegramPollers.get(channelId);
  if (tg) { tg.stopFlag = true; clearTimeout(tg.timer); telegramPollers.delete(channelId); }
  const dc = discordPollers.get(channelId);
  if (dc) { dc.stopFlag = true; clearTimeout(dc.timer); discordPollers.delete(channelId); }
  stmts.commsChannels.updatePolling.run(0, null, channelId);
}

// Start pollers for enabled channels on boot
setTimeout(() => {
  try {
    const channels = stmts.commsChannels.getEnabled.all();
    for (const ch of channels) {
      const config = JSON.parse(ch.config);
      if (ch.platform === 'telegram' && config.bot_token) startChannelPoller(ch);
      if (ch.platform === 'discord' && config.bot_token && config.channel_id) startChannelPoller(ch);
    }
    logger.info(`Comms: started ${telegramPollers.size} Telegram + ${discordPollers.size} Discord pollers`);
  } catch (e) { logger.error(`Comms boot error: ${e.message}`); }
}, 3000);

// ── Comms API endpoints ──

// List all channels
app.get('/api/comms/channels', authMiddleware, (_req, res) => {
  try {
    const channels = stmts.commsChannels.getAll.all().map(c => ({
      ...c,
      config: JSON.parse(c.config),
      polling: c.polling,
    }));
    res.json(channels);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a channel
app.post('/api/comms/channels', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { platform, name, config, enabled = true } = req.body;
    if (!platform || !name) return res.status(400).json({ error: 'platform and name required' });
    if (!['telegram', 'discord'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' });
    
    const id = randomUUID();
    const configStr = JSON.stringify(config || {});
    stmts.commsChannels.insert.run(id, platform, name, configStr, enabled ? 1 : 0);
    const channel = stmts.commsChannels.getById.get(id);
    
    if (enabled) {
      const configParsed = JSON.parse(configStr);
      if (platform === 'telegram' && configParsed.bot_token) startChannelPoller(channel);
      if (platform === 'discord' && configParsed.bot_token && configParsed.channel_id) startChannelPoller(channel);
    }
    
    broadcast('comms:channel', { type: 'created', channel });
    res.status(201).json({ ...channel, config: JSON.parse(channel.config) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a channel (enable/disable, change config)
app.put('/api/comms/channels/:id', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const channel = stmts.commsChannels.getById.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const { name, config, enabled } = req.body;
    const newName = name ?? channel.name;
    const newConfig = config ? JSON.stringify(config) : channel.config;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : channel.enabled;
    
    stmts.commsChannels.update.run(newName, newConfig, newEnabled, channel.id);
    const updated = stmts.commsChannels.getById.get(channel.id);
    
    // Start/stop pollers
    if (newEnabled) {
      const configParsed = JSON.parse(newConfig);
      if (channel.platform === 'telegram' && configParsed.bot_token) startChannelPoller(updated);
      if (channel.platform === 'discord' && configParsed.bot_token && configParsed.channel_id) startChannelPoller(updated);
    } else {
      stopChannelPoller(channel.id);
    }
    
    broadcast('comms:channel', { type: 'updated', channel: updated });
    res.json({ ...updated, config: JSON.parse(updated.config) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a channel
app.delete('/api/comms/channels/:id', authMiddleware, requireRole('admin'), (req, res) => {
  try {
    const channel = stmts.commsChannels.getById.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    stopChannelPoller(channel.id);
    stmts.commsChannels.delete.run(channel.id);
    broadcast('comms:channel', { type: 'deleted', id: channel.id });
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test outbound dispatch (Telegram or Discord)
app.post('/api/comms/dispatch', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { channel_id, message } = req.body;
    if (!channel_id || !message) return res.status(400).json({ error: 'channel_id and message required' });
    
    const channel = stmts.commsChannels.getById.get(channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const config = JSON.parse(channel.config);
    
    if (channel.platform === 'telegram') {
      if (!config.bot_token) return res.status(400).json({ error: 'No bot_token configured' });
      const targetChatId = config.chat_id || req.body.chat_id;
      if (!targetChatId) return res.status(400).json({ error: 'No chat_id configured or provided' });
      
      try {
        await telegramApiCall(config.bot_token, 'sendMessage', {
          chat_id: targetChatId,
          text: message,
          parse_mode: 'Markdown',
        });
        const msg = storeCommsMessage(channel.id, 'telegram', 'outbound', {
          remote_id: String(targetChatId),
          content: message,
          status: 'sent',
        });
        res.json({ sent: true, mode: 'live', platform: 'telegram', message_id: msg.id });
      } catch (e) {
        storeCommsMessage(channel.id, 'telegram', 'outbound', {
          content: message, status: 'failed',
        });
        res.status(502).json({ error: e.message });
      }
    } else if (channel.platform === 'discord') {
      const webhookUrl = config.webhook_url;
      if (!webhookUrl) return res.status(400).json({ error: 'No webhook_url configured' });
      
      try {
        await discordWebhookSend(webhookUrl, message, { username: config.bot_name || 'Cardinal Frame' });
        const msg = storeCommsMessage(channel.id, 'discord', 'outbound', {
          content: message,
          status: 'sent',
        });
        res.json({ sent: true, mode: 'live', platform: 'discord', message_id: msg.id });
      } catch (e) {
        storeCommsMessage(channel.id, 'discord', 'outbound', {
          content: message, status: 'failed',
        });
        res.status(502).json({ error: e.message });
      }
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List messages (optionally filtered by channel)
app.get('/api/comms/messages', authMiddleware, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const channelId = req.query.channel_id;
    if (channelId) {
      res.json(stmts.commsMessages.getByChannel.all(channelId, limit));
    } else {
      res.json(stmts.commsMessages.getAll.all(limit));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get comms status (poller states, channel count)
app.get('/api/comms/status', authMiddleware, (_req, res) => {
  try {
    const channels = stmts.commsChannels.getAll.all();
    res.json({
      telegram_pollers: telegramPollers.size,
      discord_pollers: discordPollers.size,
      channels: channels.map(c => ({
        id: c.id,
        platform: c.platform,
        name: c.name,
        enabled: !!c.enabled,
        polling: !!c.polling,
        last_poll_at: c.last_poll_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Telegram webhook receiver (alternative to polling)
app.post('/api/comms/telegram/webhook', async (req, res) => {
  try {
    const channelId = req.query.channel_id;
    if (!channelId) return res.status(400).json({ error: 'channel_id query param required' });
    const channel = stmts.commsChannels.getById.get(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const update = req.body;
    const msg = update.message || update.channel_post;
    if (msg && msg.text) {
      const commsMsg = storeCommsMessage(channel.id, 'telegram', 'inbound', {
        remote_id: String(msg.from?.id || msg.chat?.id || ''),
        remote_username: msg.from?.username || msg.from?.first_name || '',
        content: msg.text,
        raw: JSON.stringify(update),
        status: 'received',
      });
      
      const config = JSON.parse(channel.config);
      if (config.auto_reply) {
        try {
          const reply = await generateAutoReply(msg.text, channel);
          await telegramApiCall(config.bot_token, 'sendMessage', {
            chat_id: msg.chat?.id || msg.from?.id,
            text: reply,
            parse_mode: 'Markdown',
          });
          storeCommsMessage(channel.id, 'telegram', 'outbound', {
            remote_id: String(msg.chat?.id || msg.from?.id || ''),
            remote_username: commsMsg.remote_username,
            content: reply,
            status: 'sent',
          });
        } catch (e) { logger.error(`Telegram webhook reply failed: ${e.message}`); }
      }
      
      if (config.trigger_agent) {
        try {
          const agentSessionId = await triggerAgentFromComms(channel, commsMsg);
          if (agentSessionId) stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
        } catch (e) { logger.error(`Agent trigger from webhook failed: ${e.message}`); }
      }
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Discord webhook receiver (for slash commands or interactions)
app.post('/api/comms/discord/webhook', async (req, res) => {
  try {
    const channelId = req.query.channel_id;
    if (!channelId) return res.status(400).json({ error: 'channel_id query param required' });
    const channel = stmts.commsChannels.getById.get(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const interaction = req.body;
    if (interaction.type === 1) {
      // Discord interaction type 1 = PING
      return res.json({ type: 1 });
    }
    
    if (interaction.data?.content || interaction.content) {
      const content = interaction.data?.content || interaction.content;
      const username = interaction.member?.user?.username || interaction.author?.username || 'Unknown';
      const userId = interaction.member?.user?.id || interaction.author?.id || '';
      
      const commsMsg = storeCommsMessage(channel.id, 'discord', 'inbound', {
        remote_id: userId,
        remote_username: username,
        content,
        raw: JSON.stringify(interaction),
        status: 'received',
      });
      
      const config = JSON.parse(channel.config);
      if (config.trigger_agent) {
        try {
          const agentSessionId = await triggerAgentFromComms(channel, commsMsg);
          if (agentSessionId) stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
        } catch (e) { logger.error(`Agent trigger from Discord webhook failed: ${e.message}`); }
      }
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API 404 catch-all (before static, so API routes get JSON) ─────
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// ─── Global Error Handler ─────────────────────────────────────────
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const message = status === 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Unknown error';
  logger.error(`[${req.id || 'no-id'}] ${req.method} ${req.path} → ${status}: ${err.message}`, { stack: err.stack });
  res.status(status).json({
    error: message,
    request_id: req.id || undefined,
    ...(process.env.NODE_ENV !== 'production' && err.stack ? { stack: err.stack.split('\n').slice(0, 5).join('\n') } : {}),
  });
});

// ─── Static Assets with Cache Headers ──────────────────────────────
app.use(express.static(clientDist, {
  maxAge: '1y',
  immutable: true,
  setHeaders(res, filePath) {
    // index.html should never be cached (SPA entry point)
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
app.get('*', (_req, res) => {
 const indexPath = path.join(clientDist, 'index.html');
 if (existsSync(indexPath)) {
 res.sendFile(indexPath);
 } else {
 res.status(404).send('Frontend not built. Run: npm run build (root)');
 }
});

// ─── Agent Health Monitoring ───────────────────────────────────────
// Scans all agents every 15s; marks stale (>30s since heartbeat) or offline (>60s).
// Broadcasts WS events for any status transitions so the UI updates in real-time.
const STALE_THRESHOLD_S = 30;
const OFFLINE_THRESHOLD_S = 60;

setInterval(() => {
  try {
    const agents = stmts.agents.getAllWithHeartbeat.all();
    const now = Date.now();
    for (const agent of agents) {
      // last_heartbeat is stored as SQLite datetime string (UTC)
      const hbMs = new Date(agent.last_heartbeat + 'Z').getTime();
      const elapsedS = Math.floor((now - hbMs) / 1000);

      let newStatus;
      if (elapsedS > OFFLINE_THRESHOLD_S) {
        newStatus = 'offline';
      } else if (elapsedS > STALE_THRESHOLD_S) {
        newStatus = 'stale';
      } else {
        newStatus = 'active';
      }

      if (agent.status !== newStatus) {
        stmts.agents.updateStatus.run(newStatus, agent.id);
        const updated = stmts.agents.getById.get(agent.id);
        broadcast('agent:status', { ...updated, capabilities: JSON.parse(updated.capabilities) });
        logger.info(`Agent ${agent.name} (${agent.id}) status: ${agent.status} → ${newStatus}`);
      }
    }
  } catch (err) {
    logger.error('Health monitor error:', err);
  }
}, 15_000);

// ─── Global Error Handler (must be last middleware) ──────────────
app.use((err, req, res, _next) => {
  logger.error('Express error:', {
    message: err.message,
    stack: err.stack?.split('\n')[0],
    url: req.url,
    method: req.method,
  });
  // JSON parse errors
  if (err.type === 'entity.parse.failed' || err.message?.includes('JSON')) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  // Syntax errors
  if (err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Bad request syntax' });
  }
  // Rate limit errors
  if (err.status === 429) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && err.stack ? { stack: err.stack.split('\n')[0] } : {}),
  });
});

// ─── Export app for testing (prevents listen when imported) ────────
export { app, db, stmts, PORT };

// ─── Graceful Shutdown ────────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully...`);
  fireHook('onServerStop', { signal, port: PORT });
  wss.clients.forEach(c => c.close(1001, 'Server shutting down'));
  server.close(() => {
    logger.info('HTTP server closed');
    try { db.close(); logger.info('DB closed'); } catch {}
    process.exit(0);
  });
  // Force exit after 5s if something hangs
  setTimeout(() => { logger.warn('Forcing exit after timeout'); process.exit(1); }, 5000);
}

// ─── Boot ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '0.0.0.0', () => {
   logger.info(`Server running on http://localhost:${PORT} (SQLite + JWT + WS + bcrypt + rate-limit + RBAC + log-stream + health-monitor + agent-loop)`);
   fireHook('onServerStart', { port: PORT, version: pkg?.version || 'unknown' });

   // Start heartbeat daemon
   const heartbeat = new HeartbeatDaemon(stmts, broadcast,
     async (chainId, input) => {
       const chain = stmts.skillChains.getById.get(chainId);
       if (!chain) return { ok: false, error: 'Chain not found' };
       chain.steps = JSON.parse(chain.steps || '[]');
       const executeSkillFn = async (step, inp) => {
         const skill = stmts.skills.getByName.get(step.skill_name);
         if (!skill) throw new Error(`Skill "${step.skill_name}" not found`);
         return await executeSkill(skill, inp);
       };
       return await executeSkillChain(chain, input, executeSkillFn, broadcast);
     },
     async (skillName, input) => {
       const skill = stmts.skills.getByName.get(skillName);
       if (!skill) return { ok: false, error: 'Skill not found' };
       return await executeSkill(skill, input);
     },
     logger
   );
   heartbeat.start(parseInt(process.env.HEARTBEAT_INTERVAL || '60') * 1000);
   globalThis._heartbeat = heartbeat;
  });
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
