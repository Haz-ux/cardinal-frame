#!/usr/bin/env node
// Cardinal Frame CLI — manage tasks, agents, DAGs, schedules from terminal
import { randomUUID } from 'crypto';

const BASE = process.env.CF_API || 'http://localhost:3000/api';
const TOKEN = process.env.CF_TOKEN;

async function req(method, path, body) {
 const headers = { 'Content-Type': 'application/json' };
 if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
 const opts = { method, headers };
 if (body) opts.body = JSON.stringify(body);
 const res = await fetch(`${BASE}${path}`, opts);
 const data = await res.json();
 if (!res.ok) { console.error(`Error: ${data.error || res.status}`); process.exit(1); }
 return data;
}

function pretty(data) { console.log(JSON.stringify(data, null, 2)); }
function table(items, fields) {
 if (!items.length) { console.log('(none)'); return; }
 // Calculate widths
 const widths = fields.map(f => Math.max(f.length, ...items.map(i => String(i[f] ?? '').slice(0, 40).length)));
 // Header
 console.log(fields.map((f, i) => f.padEnd(widths[i])).join('  '));
 console.log(fields.map((f, i) => '-'.repeat(widths[i])).join('  '));
 // Rows
 for (const item of items) {
  console.log(fields.map((f, i) => String(item[f] ?? '').slice(0, 40).padEnd(widths[i])).join('  '));
 }
}

function truncate(s, len = 40) { return s && s.length > len ? s.slice(0, len) + '…' : s; }

const commands = {
 // ─── Auth ──────────────────────────────────────────────────
 async login(args) {
  const [username, password] = args;
  if (!username || !password) { console.error('Usage: cardinal login <username> <password>'); process.exit(1); }
  const data = await req('POST', '/auth/login', { username, password });
  console.log(`Token: ${data.token}`);
  console.log('Set CF_TOKEN=<token> to authenticate future commands.');
 },

 // ─── Health ────────────────────────────────────────────────
 async health() {
  const data = await req('GET', '/health');
  pretty(data);
 },

 // ─── Tasks ─────────────────────────────────────────────────
 async tasks() {
  const data = await req('GET', '/tasks');
  table(data, ['id', 'name', 'status', 'assigned_agent_id']);
 },

 async task(args) {
  const [id] = args;
  if (!id) { console.error('Usage: cardinal task <id>'); process.exit(1); }
  const data = await req('GET', `/tasks/${id}`);
  pretty(data);
 },

 async 'tasks:create'(args) {
  const [name, command] = args;
  if (!name || !command) { console.error('Usage: cardinal tasks:create <name> <command>'); process.exit(1); }
  const data = await req('POST', '/tasks', { name, command });
  console.log(`Task created: ${data.id}`);
  pretty(data);
 },

 async 'tasks:run'(args) {
  const [id] = args;
  if (!id) { console.error('Usage: cardinal tasks:run <task_id>'); process.exit(1); }
  const data = await req('POST', `/tasks/${id}/run`);
  console.log(`Task started: ${id}`);
 },

 async 'tasks:cancel'(args) {
  const [id] = args;
  if (!id) { console.error('Usage: cardinal tasks:cancel <task_id>'); process.exit(1); }
  const data = await req('POST', `/tasks/${id}/cancel`);
  console.log(`Task cancelled: ${id}`);
 },

 // ─── Agents ────────────────────────────────────────────────
 async agents() {
  const data = await req('GET', '/agents');
  table(data, ['id', 'name', 'status', 'capabilities']);
 },

 async 'agents:register'(args) {
  const [name, capabilities] = args;
  if (!name) { console.error('Usage: cardinal agents:register <name> [capabilities]'); process.exit(1); }
  const data = await req('POST', '/agents/register', { name, capabilities: capabilities || 'general' });
  console.log(`Agent registered: ${data.id}`);
  pretty(data);
 },

 async 'agents:heartbeat'(args) {
  const [id] = args;
  if (!id) { console.error('Usage: cardinal agents:heartbeat <agent_id>'); process.exit(1); }
  const data = await req('POST', `/agents/${id}/heartbeat`);
  console.log(`Heartbeat sent for ${id}`);
 },

 async 'agents:health'() {
  const data = await req('GET', '/agents/health');
  pretty(data);
 },

 // ─── Groups ────────────────────────────────────────────────
 async groups() {
  const data = await req('GET', '/groups');
  table(data, ['id', 'name', 'memberCount']);
 },

 async 'groups:create'(args) {
  const [name, description] = args;
  if (!name) { console.error('Usage: cardinal groups:create <name> [description]'); process.exit(1); }
  const data = await req('POST', '/groups', { name, description: description || '' });
  console.log(`Group created: ${data.id}`);
 },

 async 'groups:add-agent'(args) {
  const [groupId, agentId] = args;
  if (!groupId || !agentId) { console.error('Usage: cardinal groups:add-agent <group_id> <agent_id>'); process.exit(1); }
  await req('POST', `/groups/${groupId}/members`, { agentId });
  console.log(`Agent ${agentId} added to group ${groupId}`);
 },

 // ─── DAGs ──────────────────────────────────────────────────
 async dags() {
  const data = await req('GET', '/dags');
  table(data, ['id', 'name', 'status', 'created_at']);
 },

 async 'dags:create'(args) {
  const [name] = args;
  if (!name) { console.error('Usage: cardinal dags:create <name>'); process.exit(1); }
  const data = await req('POST', '/dags', { name });
  console.log(`DAG created: ${data.id}`);
 },

 // ─── Schedules ─────────────────────────────────────────────
 async schedules() {
  const data = await req('GET', '/schedules');
  table(data, ['id', 'name', 'cron_expr', 'enabled']);
 },

 async 'schedules:create'(args) {
  const [name, cronExpr, command] = args;
  if (!name || !cronExpr || !command) { console.error('Usage: cardinal schedules:create <name> <cron_expr> <command>'); process.exit(1); }
  const data = await req('POST', '/schedules', { name, cron_expr: cronExpr, command });
  console.log(`Schedule created: ${data.id}`);
 },

 async 'schedules:toggle'(args) {
  const [id] = args;
  if (!id) { console.error('Usage: cardinal schedules:toggle <schedule_id>'); process.exit(1); }
  const data = await req('PATCH', `/schedules/${id}/toggle`);
  console.log(`Schedule ${id} ${data.enabled ? 'enabled' : 'disabled'}`);
 },

 // ─── MCP ───────────────────────────────────────────────────
 async 'mcp:servers'() {
  const data = await req('GET', '/mcp/servers');
  table(data, ['id', 'name', 'command', 'status']);
 },

 async 'mcp:register'(args) {
  const [name, command] = args;
  if (!name || !command) { console.error('Usage: cardinal mcp:register <name> <command>'); process.exit(1); }
  const data = await req('POST', '/mcp/servers', { name, command, args: [] });
  console.log(`MCP server registered: ${data.id}`);
 },

 // ─── Plugins ───────────────────────────────────────────────
 async plugins() {
  const data = await req('GET', '/plugins');
  table(data, ['id', 'name', 'version', 'enabled', 'loaded']);
 },

 async 'plugins:toggle'(args) {
  const [id] = args;
  if (!id) { console.error('Usage: cardinal plugins:toggle <plugin_id>'); process.exit(1); }
  const data = await req('PATCH', `/plugins/${id}/toggle`);
  console.log(`Plugin ${id} ${data.enabled ? 'enabled' : 'disabled'}`);
 },

 // ─── Files ─────────────────────────────────────────────────
 async files() {
  const data = await req('GET', '/files');
  table(data, ['id', 'original_name', 'size', 'mime_type']);
 },
};

// ─── Main ────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

if (!cmd) {
 console.log(`Cardinal Frame CLI

Usage: cardinal <command> [args...]

Commands:
  login <user> <pass>          Login and get token
  health                       Check server health

  tasks                        List tasks
  task <id>                    Get task details
  tasks:create <name> <cmd>   Create a task
  tasks:run <id>               Execute a task
  tasks:cancel <id>            Cancel a task

  agents                       List agents
  agents:register <name> [cap] Register an agent
  agents:heartbeat <id>        Send heartbeat
  agents:health                Agent health summary

  groups                       List agent groups
  groups:create <name> [desc]  Create a group
  groups:add-agent <gid> <aid> Add agent to group

  dags                         List DAGs
  dags:create <name>           Create a DAG

  schedules                    List schedules
  schedules:create <n> <c> <cmd> Create a schedule
  schedules:toggle <id>        Toggle schedule on/off

  mcp:servers                  List MCP servers
  mcp:register <name> <cmd>    Register MCP server

  plugins                      List plugins
  plugins:toggle <id>          Toggle plugin on/off

  files                        List uploaded files

Environment:
  CF_API    API base URL (default: http://localhost:3000/api)
  CF_TOKEN  JWT token for authenticated endpoints
`);
 process.exit(0);
}

const fn = commands[cmd];
if (!fn) { console.error(`Unknown command: ${cmd}\nRun 'cardinal' with no args for help.`); process.exit(1); }

fn(args).catch(err => { console.error('Fatal:', err.message); process.exit(1); });
