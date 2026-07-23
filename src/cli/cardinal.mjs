#!/usr/bin/env node
// Cardinal Frame CLI — manage tasks, agents, DAGs, schedules from terminal
import { randomUUID } from 'crypto';

const BASE = process.env.CF_API || 'http://localhost:8080/api';
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

// ─── Command handlers ───────────────────────────────────────
// Each handler receives the remaining argv slice (subcommand/arg already consumed).
// Dispatch: command = process.argv[2], subcommand or primary arg = process.argv[3].

// `cardinal status` — GET /api/health
async function status() {
  const data = await req('GET', '/health');
  console.log(`Status: ${data.status || 'unknown'}`);
  console.log(`Mode:   ${data.mode || '-'}`);
  console.log(`Uptime: ${data.uptime ?? '-'}s`);
  console.log(`WS clients: ${data.ws?.connected_clients ?? '-'}`);
}

// `cardinal agents` — GET /api/agents
async function agents() {
  const data = await req('GET', '/agents');
  table(data, ['id', 'name', 'status', 'model']);
}

// `cardinal agents:create <name>` — POST /api/agents
async function agentsCreate([name]) {
  if (!name) { console.error('Usage: cardinal agents:create <name>'); process.exit(1); }
  const data = await req('POST', '/agents', { name, system_prompt: '', model: 'auto' });
  console.log(`Agent created: ${data.id || name}`);
  pretty(data);
}

// `cardinal tasks` — GET /api/tasks
async function tasks() {
  const data = await req('GET', '/tasks');
  table(data, ['id', 'title', 'status', 'agent_id']);
}

// `cardinal tasks:create <title> [agentId]` — POST /api/tasks
async function tasksCreate(args) {
  const [title, agentId] = args;
  if (!title) { console.error('Usage: cardinal tasks:create <title> [agentId]'); process.exit(1); }
  const body = { title, agent_id: agentId || null };
  const data = await req('POST', '/tasks', body);
  console.log(`Task created: ${data.id || title}`);
  pretty(data);
}

// `cardinal token` — POST /api/auth/login (admin/admin123), print JWT
async function token() {
  const data = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
  if (data.token) {
    console.log(data.token);
  } else {
    console.error('No token in response:');
    pretty(data);
  }
}

// `cardinal port` — GET /api/settings/dev, print current port
async function port() {
  const data = await req('GET', '/settings/dev');
  console.log(`Current port: ${data.port}`);
}

// `cardinal port:set <port>` — PUT /api/settings/dev with {port}
async function portSet([portValue]) {
  if (!portValue) { console.error('Usage: cardinal port:set <port>'); process.exit(1); }
  const data = await req('PUT', '/settings/dev', { port: portValue });
  console.log(`Port set to: ${data.port ?? portValue}`);
}

// `cardinal chat <message>` — POST /api/chat
async function chat(args) {
  const message = args.join(' ');
  if (!message) { console.error('Usage: cardinal chat <message>'); process.exit(1); }
  const data = await req('POST', '/chat', { messages: [{ role: 'user', content: message }] });
  if (data && typeof data === 'object' && typeof data.response === 'string') {
    console.log(data.response);
  } else {
    pretty(data);
  }
}

// ─── Main ────────────────────────────────────────────────────
const cmd = process.argv[2];
const sub = process.argv[3]; // subcommand or primary arg
const rest = process.argv.slice(4); // remaining args

const HELP = `Cardinal Frame CLI

Usage: cardinal <command> [subcommand|arg] [args...]

Commands:
  status                       Check server health (GET /api/health)
  agents                       List agents (GET /api/agents)
  agents:create <name>         Create an agent (POST /api/agents)
  tasks                        List tasks (GET /api/tasks)
  tasks:create <title> [aid]   Create a task (POST /api/tasks)
  token                        Login as admin, print JWT (POST /api/auth/login)
  port                         Show current dev port (GET /api/settings/dev)
  port:set <port>              Set the dev port (PUT /api/settings/dev)
  chat <message>               Send a chat message (POST /api/chat)

Environment:
  CF_API    API base URL (default: http://localhost:8080/api)
  CF_TOKEN  JWT token for authenticated endpoints

Run 'cardinal' (no args) or 'cardinal help' for this message.
`;

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
  process.exit(0);
}

(async () => {
  try {
    switch (cmd) {
      case 'status':
        await status();
        break;
      case 'agents':
        if (sub === 'create') await agentsCreate(rest);
        else await agents();
        break;
      case 'tasks':
        if (sub === 'create') await tasksCreate(rest);
        else await tasks();
        break;
      case 'token':
        await token();
        break;
      case 'port':
        if (sub === 'set') await portSet(rest);
        else await port();
        break;
      case 'chat':
        await chat(sub !== undefined ? process.argv.slice(3) : []);
        break;
      default:
        console.error(`Unknown command: ${cmd}\nRun 'cardinal help' for usage.`);
        process.exit(1);
    }
  } catch (err) {
    console.error('Fatal:', err.message);
    process.exit(1);
  }
})();
