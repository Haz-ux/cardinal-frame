#!/usr/bin/env node
import compression from 'compression';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import winston from 'winston';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import path from 'path';
import { existsSync } from 'fs';
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
import jobCatalogRoutes from './routes/job-catalog.mjs';
import activityRoutes from './routes/activity.mjs';
import delegationRoutes from './routes/delegation.mjs';
import metaRoutes from './routes/meta.mjs';
import { runSandboxed, runSandboxedHybrid } from './routes/sandbox.mjs';
import usersRoutes from './routes/users.mjs';
import stateRoutes from './routes/state.mjs';
import costsRoutes, { getModelCost } from './routes/costs.mjs';
import memoryRoutes from './routes/memory.mjs';
import systemRoutes from './routes/system.mjs';
import { PROVIDER_TYPES, buildProviderAuth, buildChatUrl, buildChatPayload } from './routes/llm-helpers.mjs';
import settingsRoutes, { getDevSetting, getDevSettings, decryptValue } from './routes/settings.mjs';
import chatConvRoutes from './routes/chat-conversations.mjs';
import chatCompRoutes from './routes/chat-completions.mjs';
import skillsRoutes, { executeSkill, matchSkillTrigger } from './routes/skills.mjs';
import skillHubRoutes from './routes/skill-hub.mjs';
import chainsRoutes from './routes/chains.mjs';
import evolutionRoutes from './routes/evolution.mjs';
import heartbeatRulesRoutes from './routes/heartbeat-rules.mjs';
import toolsRoutes from './routes/tools.mjs';
import aimiRoutes, { buildAimiSystemPrompt, autoRegisterSystemTools } from './routes/aimi.mjs';
import llmRoutes, { initOllama } from './routes/llm.mjs';
import agentRoutes, { callAgentLLM, agentTools } from './routes/agent.mjs';
import commsRoutes from './routes/comms.mjs';
import tracesRoutes, { initTracing, traceMiddleware } from './routes/traces.mjs';
import governanceRoutes, { initGovernance, checkPermission, auditLog } from './routes/governance.mjs';
import { createJobQueue } from './job-queue.mjs';
import { PluginLoader } from './plugins.mjs';
import { executeSkillChain } from './chains.mjs';
import { HeartbeatDaemon } from './heartbeat.mjs';
import { runMigrations } from './migrator.mjs';

dotenv.config();

const app = express();
app.set('etag', false); // Disable ETags — prevents 304 stale cache on auth routes
let PORT = process.env.PORT || 8080; // may be overridden by dev_settings below
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
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    const type = res.getHeader('Content-Type');
    if (type && (String(type).includes('text/event-stream') || String(type).includes('image/'))) return false;
    return compression.filter(req, res);
  },
}));
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

// ─── Override PORT from saved dev_settings (persists across boots) ─
// ENV PORT takes highest priority (Docker/CI), then saved dev setting, then default 8080
try {
  const savedPort = db.prepare('SELECT value FROM dev_settings WHERE key = ?').get('port');
  if (savedPort && !process.env.PORT) {
    const p = parseInt(savedPort.value, 10);
    if (p >= 1 && p <= 65535) PORT = p;
  }
} catch {} // table might not exist on first boot before schema runs

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

  CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  soul TEXT DEFAULT '{}',
  permissions TEXT DEFAULT '[]',
  constraints TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_personas_agent ON personas(agent_id);

  CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT DEFAULT '{}',
  trace_id TEXT,
  ts TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

  CREATE TABLE IF NOT EXISTS skill_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  skill_name TEXT,
  trace_id TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  skill_type TEXT,
  error TEXT,
  ts TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_skill_inv_skill ON skill_invocations(skill_id);
  CREATE INDEX IF NOT EXISTS idx_skill_inv_ts ON skill_invocations(ts);

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

  CREATE TABLE IF NOT EXISTS dev_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
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

  INSERT OR IGNORE INTO personas (id, agent_id, name, description, soul, permissions, constraints, enabled)
  VALUES ('persona-default', NULL, 'Default', 'Baseline governance — allows all actions with audit logging',
    '{"identity":"Cardinal Frame agent","principles":["Be helpful","Be safe","Be transparent"],"boundaries":["Never expose secrets","Never modify system files"],"escalation":{"require_approval_for":["rm","sudo","chmod","chown","mkfs"],"auto_approve":["echo","ls","cat","pwd","date","grep","wc"]}}',
    '[]', '[]', 1);
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
      skillInvocations: {
        insert: db.prepare('INSERT INTO skill_invocations (skill_id, skill_name, trace_id, success, duration_ms, skill_type, error) VALUES (?, ?, ?, ?, ?, ?, ?)'),
        getBySkill: db.prepare('SELECT * FROM skill_invocations WHERE skill_id = ? ORDER BY ts DESC, id DESC LIMIT ?'),
        getRecent: db.prepare('SELECT * FROM skill_invocations ORDER BY ts DESC, id DESC LIMIT ?'),
        getStats: db.prepare(`SELECT
          skill_id, skill_name,
          COUNT(*) as total,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
          ROUND(AVG(duration_ms), 1) as avg_duration_ms,
          MAX(ts) as last_invoked
          FROM skill_invocations
          WHERE ts > datetime('now', ?)
          GROUP BY skill_id, skill_name
          ORDER BY failures DESC, total DESC`),
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
      traces: initTracing(db),
      governance: initGovernance(db),
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
        // Per-row statements kept for backward compat with /graph/core & /graph/expand
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
        // ─── Batched aggregate statements (used by GET /graph) ───
        // Each replaces a per-row sub-query loop with one grouped query.
        skillUseCounts: (() => { try { return db.prepare('SELECT skill_id, COUNT(*) as c FROM skill_executions GROUP BY skill_id'); } catch { return null; } })(),
        allPluginsWithHooks: (() => { try { return db.prepare('SELECT id, name, version, enabled, hooks FROM plugins'); } catch { return null; } })(),
        convMsgCounts: (() => { try { return db.prepare('SELECT conversation_id as id, COUNT(*) as c FROM chat_messages GROUP BY conversation_id'); } catch { return null; } })(),
        modelCountsByProvider: (() => { try { return db.prepare('SELECT provider_id, COUNT(*) as c FROM llm_models GROUP BY provider_id'); } catch { return null; } })(),
        allModelProviders: (() => { try { return db.prepare('SELECT model_id, display_name, provider_id FROM llm_models'); } catch { return null; } })(),
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
  // Log activity for the live overlay feed
  if (ctx.logActivity) ctx.logActivity(type, payload);
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
  DATA_DIR, PORT,
  matchSkillTrigger,
  getDevSetting, getDevSettings,
  runSandboxed, runSandboxedHybrid,
  getModelCost, buildAimiSystemPrompt,
  checkPermission, auditLog,
  // These are populated later (declared with const/let below)
  get collectTelemetry() { return collectTelemetry; },
  get telemetryCache() { return telemetryCache; },
  get deviceStateCache() { return deviceStateCache; },
  get executeTask() { return executeTask; },
  get sanitizeCommand() { return sanitizeCommand; },
  get callAgentLLM() { return callAgentLLM; },
};

// ─── Request Tracing (observability) ───────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(traceMiddleware(stmts, logger));
}

// ─── Modularized Routes ─────────────────────────────────────────
app.use('/api/auth', authRoutes(ctx));
app.use('/api', dashboardRoutes(ctx));
app.use('/api', graphRoutes(ctx));
app.use('/api', taskRoutes(ctx));
app.use('/api', jobCatalogRoutes(ctx));
app.use('/api', activityRoutes(ctx));
app.use('/api', delegationRoutes(ctx));
app.use('/api', metaRoutes(ctx));
app.use('/api', usersRoutes(ctx));
app.use('/api', stateRoutes(ctx));
app.use('/api', costsRoutes(ctx));
app.use('/api', memoryRoutes(ctx));
app.use('/api', systemRoutes(ctx));
app.use('/api', settingsRoutes(ctx));
app.use('/api', chatConvRoutes(ctx));
app.use('/api', chatCompRoutes(ctx));
app.use('/api', skillsRoutes(ctx));
app.use('/api', skillHubRoutes(ctx));
app.use('/api', chainsRoutes(ctx));
app.use('/api', evolutionRoutes(ctx));
app.use('/api', heartbeatRulesRoutes(ctx));
app.use('/api', toolsRoutes(ctx));
app.use('/api', aimiRoutes(ctx));
app.use('/api', llmRoutes(ctx));
app.use('/api', agentRoutes(ctx));
app.use('/api', commsRoutes(ctx));
app.use('/api', tracesRoutes(ctx));
app.use('/api', governanceRoutes(ctx));

// ─── Job Queue ───────────────────────────────────────────────────
const jobQueue = createJobQueue(db, {
  concurrency: parseInt(process.env.JOB_CONCURRENCY || '3'),
  defaultTimeout: parseInt(process.env.JOB_TIMEOUT_MS || '30000'),
  maxRetries: parseInt(process.env.JOB_MAX_RETRIES || '3'),
});
jobQueue.setBroadcast(broadcast);
jobQueue.setLogger(logger);

// Job queue API routes
app.get('/api/jobs/stats', authMiddleware, apiLimiter, (_req, res) => {
  res.json(jobQueue.getStatus());
});

app.get('/api/jobs/:id', authMiddleware, apiLimiter, (req, res) => {
  const job = jobQueue.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/jobs/dead', authMiddleware, apiLimiter, (_req, res) => {
  res.json(jobQueue.getDeadJobs());
});

app.post('/api/jobs/:id/retry', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  const job = jobQueue.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'dead') return res.status(409).json({ error: 'Only dead jobs can be retried' });
  db.prepare(`UPDATE jobs SET status = 'pending', attempts = 0, last_error = NULL, scheduled_at = datetime('now') WHERE id = ?`).run(req.params.id);
  res.json({ retried: true, id: req.params.id });
});

// ─── Code Execution Sandbox ──────────────────────────────────────
app.post('/api/sandbox/execute', authMiddleware, requireRole('admin'), sandboxLimiter, validateBody(schemas.sandboxExecute), async (req, res) => {
 try {
  const { code, language = 'javascript' } = req.body;
  auditLog(stmts, req.user.username, 'sandbox:execute', language, { code_length: code.length }, req.id);
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

// ─── Token Cost Tracking (moved to routes/costs.mjs) ──────────────

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

// ─── Device-State Ingestion (async — no execSync on event loop) ──
let deviceStateCache = { battery_pct: null, battery_charging: null, network_type: 'unknown', thermal_throttling: false, gpu_util: 0, npu_util: 0, ram_pct: 0, cpu_temp: 0, swap_pct: 0 };
async function collectDeviceState() {
  try {
    const { readFile } = await import('fs/promises');
    const read = async (p) => { try { return (await readFile(p, 'utf-8')).trim(); } catch { return ''; } };

    const b = await read('/sys/class/power_supply/battery/capacity');
    if (b) deviceStateCache.battery_pct = parseInt(b);
    const bs = await read('/sys/class/power_supply/battery/status') || await read('/sys/class/power_supply/AC/online');
    deviceStateCache.battery_charging = bs.includes('Charging') || bs === '1';

    const iface = await read('/sys/class/net/wlan0/operstate').then(() => 'wlan0').catch(() =>
      read('/sys/class/net/eth0/operstate').then(() => 'eth0').catch(() => ''));
    if (iface) {
      const s = await read(`/sys/class/net/${iface}/operstate`);
      deviceStateCache.network_type = s === 'up' ? (iface.startsWith('wlan') ? 'wifi' : 'ethernet') : 'disconnected';
    }

    const t = await read('/sys/class/thermal/thermal_zone0/temp');
    if (t) { const tc = parseInt(t) / 1000; deviceStateCache.cpu_temp = tc; deviceStateCache.thermal_throttling = tc > 80; }

    // RAM/Swap via /proc/meminfo (no shell fork)
    const meminfo = await read('/proc/meminfo');
    if (meminfo) {
      const getKB = (key) => { const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`)); return m ? parseInt(m[1]) : 0; };
      const memTotal = getKB('MemTotal'), memAvail = getKB('MemAvailable');
      if (memTotal) deviceStateCache.ram_pct = Math.round(((memTotal - memAvail) / memTotal) * 100);
      const swapTotal = getKB('SwapTotal'), swapFree = getKB('SwapFree');
      if (swapTotal) deviceStateCache.swap_pct = Math.round(((swapTotal - swapFree) / swapTotal) * 100);
    }

    // tegrastats (short, non-blocking timeout)
    try {
      const { exec: execCb } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(execCb);
      const { stdout } = await execAsync('tegrastats --sleep 1 2>&1 | head -1', { timeout: 3000 });
      const rm = stdout.match(/RAM\s+(\d+)\/(\d+)/);
      if (rm) deviceStateCache.ram_pct = Math.round(parseInt(rm[1]) / parseInt(rm[2]) * 100);
      const gm = stdout.match(/GR3D\s+(\d+)%/);
      if (gm) deviceStateCache.gpu_util = parseInt(gm[1]);
    } catch {}
  } catch {}
}
setInterval(collectDeviceState, 15000);
collectDeviceState();

// ─── File Watcher Service (moved to routes/system.mjs) ──────────

// ─── Health & Dashboard (moved to routes/system.mjs) ────────────

// ─── Detailed Health (moved to routes/system.mjs) ───────────────

// ─── Request Logger Middleware ──────────────────────────────────
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

// ─── Live Telemetry (async — no execSync) ────────────────────────
let telemetryCache = { cpu: 0, mem: 0, gpu: 0, npu: 0, temp: 0, uptime: 0, wsClients: 0, ts: Date.now() };
const _cores = parseInt(execSync('nproc').toString().trim()) || 4; // one-time at boot
async function collectTelemetry() {
  try {
    const { readFile } = await import('fs/promises');
    const read = async (p) => { try { return (await readFile(p, 'utf-8')).trim(); } catch { return ''; } };

    // CPU from /proc/loadavg (no shell)
    let cpuLoad = 0;
    const loadavg = await read('/proc/loadavg');
    if (loadavg) { const load = parseFloat(loadavg.split(' ')[0]) || 0; cpuLoad = Math.min(100, Math.round((load / _cores) * 100)); }

    // Memory from /proc/meminfo (no shell)
    let memUsage = 0;
    const meminfo = await read('/proc/meminfo');
    if (meminfo) {
      const getKB = (key) => { const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`)); return m ? parseInt(m[1]) : 0; };
      const total = getKB('MemTotal'), avail = getKB('MemAvailable');
      if (total) memUsage = Math.round(((total - avail) / total) * 100);
    }

    // GPU/NPU temp from sysfs (no shell)
    let gpuUtil = deviceStateCache.gpu_util, npuUtil = 0, tempC = deviceStateCache.cpu_temp;
    const zoneTemp = await read('/sys/class/thermal/thermal_zone0/temp');
    if (zoneTemp) tempC = parseInt(zoneTemp) / 1000;

    // tegrastats (non-blocking)
    try {
      const { exec: execCb } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(execCb);
      const { stdout } = await execAsync('tegrastats --sleep 1 2>&1 | head -1', { timeout: 3000 });
      const gpuMatch = stdout.match(/GPU\s+(\d+)%/); if (gpuMatch) gpuUtil = parseInt(gpuMatch[1]);
      const dlaMatch = stdout.match(/DLA\s+(\d+)%/); if (dlaMatch) npuUtil = parseInt(dlaMatch[1]);
      const tempMatch = stdout.match(/(\d+)C/); if (tempMatch) tempC = parseInt(tempMatch[1]);
    } catch {}

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

// ─── Chat Conversations + Completions + Failover (moved to routes/chat-*.mjs) ──
// ─── Skills / Chains / Evolution / Heartbeat / Tools / Aimi / LLM (moved to routes/) ──
// Initialize Ollama auto-detection on boot
initOllama(db, stmts, logger);
// Auto-register system tools (Aimi built-in tools)
autoRegisterSystemTools(stmts, randomUUID, logger);


// ─── Settings / Env Vars + Dev Settings (moved to routes/settings.mjs) ──

// Load stored env vars into process.env on startup
try {
  const stored = db.prepare('SELECT key, value, encrypted FROM env_vars').all();
  for (const row of stored) {
    process.env[row.key] = row.encrypted ? decryptValue(row.value, row.encrypted) : row.value;
  }
  if (stored.length) logger.info(`Loaded ${stored.length} env vars into process.env`);
} catch {}

// Load embedding model from dev_settings into env for embeddings.mjs
try {
  const savedModel = db.prepare('SELECT value FROM dev_settings WHERE key = ?').get('embeddingModel');
  if (savedModel) process.env.CF_EMBEDDING_MODEL = savedModel.value;
} catch {}
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

// ─── Trace cleanup (hourly, 7-day retention) ───────────────────────────
setInterval(() => {
  try { stmts.traces.cleanup.run(); }
  catch { /* non-critical */ }
}, 3_600_000);

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
  // Stop job queue — running jobs will resume on restart
  if (globalThis._jobQueue) {
    globalThis._jobQueue.stop();
  }
  wss.clients.forEach(c => c.close(1001, 'Server shutting down'));
  server.close(() => {
    logger.info('HTTP server closed');
    try { db.close(); logger.info('DB closed'); } catch {}
    process.exit(0);
  });
  // Force exit after 10s if something hangs (allow job queue drain time)
  setTimeout(() => { logger.warn('Forcing exit after timeout'); process.exit(1); }, 10000);
}

// ─── Boot ──────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, '0.0.0.0', () => {
   logger.info(`Server running on http://localhost:${PORT} (SQLite + JWT + WS + bcrypt + rate-limit + RBAC + log-stream + health-monitor + agent-loop + job-queue)`);
   fireHook('onServerStart', { port: PORT, version: pkg?.version || 'unknown' });

   // Start job queue — recovers interrupted jobs from restart
   jobQueue.start();
   globalThis._jobQueue = jobQueue;

   // Start heartbeat daemon
   const heartbeat = new HeartbeatDaemon(stmts, broadcast,
     async (chainId, input) => {
       const chain = stmts.skillChains.getById.get(chainId);
       if (!chain) return { ok: false, error: 'Chain not found' };
       chain.steps = JSON.parse(chain.steps || '[]');
       const executeSkillFn = async (step, inp) => {
         const skill = stmts.skills.getByName.get(step.skill_name);
         if (!skill) throw new Error(`Skill "${step.skill_name}" not found`);
         return await executeSkill(skill, inp, `heartbeat:${Date.now()}`);
       };
       return await executeSkillChain(chain, input, executeSkillFn, broadcast, {
         persona: stmts.governance?.personas.getById.get('persona-default') || null,
         checkPermission,
         auditLog: (action, details) => auditLog(stmts, 'heartbeat', action, null, details),
       });
     },
     async (skillName, input) => {
       const skill = stmts.skills.getByName.get(skillName);
       if (!skill) return { ok: false, error: 'Skill not found' };
       return await executeSkill(skill, input, `heartbeat:${Date.now()}`);
     },
     logger
   );
   heartbeat.start(parseInt(process.env.HEARTBEAT_INTERVAL || '60') * 1000);
   globalThis._heartbeat = heartbeat;
  });
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
