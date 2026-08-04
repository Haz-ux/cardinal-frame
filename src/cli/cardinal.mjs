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

// `cardinal port` — GET /api/settings/dev, print current port (read-only; fixed to 8080 unless PORT env set)
async function port() {
  const data = await req('GET', '/settings/dev');
  console.log(`Current port: ${data.port} (fixed — set PORT env var to change)`);
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

const CF_DIR = process.env.CF_DIR || '/home/cardinal-frame';
const HEALTH_URL = 'http://localhost:8080/api/health';
const PID_FILE = '/tmp/cardinal.pid';
const LOG_FILE = process.env.CF_LOG_FILE || '/tmp/cardinal-server.log';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Check whether the API is up. Returns true if a 2xx health response arrives. */
async function isUp() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// `cardinal run` — start the server and client, wait until healthy
async function run(args) {
  const { spawn } = await import('node:child_process');
  const { writeFileSync, appendFileSync } = await import('node:fs');

  console.log('Starting Cardinal Frame...');

  if (await isUp()) {
    console.log('Server is already running on http://localhost:8080');
    console.log('Dashboard: http://localhost:5173');
    return;
  }

  // Start the server (stable entrypoint — no file watcher)
  const serverProc = spawn('node', ['src/server/server.mjs'], {
    cwd: CF_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverPid = serverProc.pid;
  writeFileSync(PID_FILE, String(serverPid));

  // Pipe server output to stdout + a log file
  const logStream = (chunk) => {
    const out = chunk.toString();
    process.stdout.write(`Server: ${out}`);
    try { appendFileSync(LOG_FILE, out); } catch {}
  };
  serverProc.stdout?.on('data', logStream);
  serverProc.stderr?.on('data', logStream);
  serverProc.on('exit', (code, signal) => {
    console.log(`Server exited (code=${code}, signal=${signal})`);
    try { appendFileSync(LOG_FILE, `\nServer exited (code=${code})\n`); } catch {}
  });

  // Wait for the API to come up (max ~30s), then report clearly
  console.log('Waiting for server to come up...');
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    if (serverProc.exitCode !== null) break;          // died during boot
    if (await isUp()) { up = true; break; }
    await sleep(1000);
  }

  if (!up) {
    console.error(`Server did not come up within 30s. Check ${LOG_FILE}`);
    process.exit(1);
  }

  console.log('Server is up: http://localhost:8080 (PID ' + serverPid + ')');

  // Start client unless disabled
  let clientProc = null;
  if (!args.includes('--no-client') && !args.includes('--server-only')) {
    console.log('Starting dashboard...');
    clientProc = spawn('npm', ['run', 'dev'], {
      cwd: CF_DIR + '/client',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    clientProc.stdout?.on('data', (d) => process.stdout.write(`Client: ${d}`));
    clientProc.stderr?.on('data', (d) => process.stdout.write(`Client: ${d}`));
    clientProc.on('exit', (code) => console.log(`Dashboard exited (code=${code})`));
    console.log('Dashboard: http://localhost:5173');
  }

  console.log('Cardinal Frame is running. Press Ctrl+C to stop.');

  const shutdown = () => {
    console.log('\nStopping Cardinal Frame...');
    if (clientProc) { try { clientProc.kill('SIGTERM'); } catch {} }
    if (serverPid) { try { process.kill(serverPid, 'SIGTERM'); } catch {} }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

// `cardinal stop` — stop server + dashboard started by `cardinal run`
async function stop() {
  const fs = await import('node:fs');
  const pids = [];
  try { pids.push(Number(fs.readFileSync(PID_FILE, 'utf8'))); } catch {}
  // Also sweep for any stray server/dashboard processes
  for (const pat of ['src/server/server.mjs', 'client/node_modules/.bin/vite']) {
    try {
      const { execSync } = await import('node:child_process');
      const out = execSync(`pgrep -f "${pat}" 2>/dev/null || true`).toString().trim();
      for (const pid of out.split('\n')) { if (pid) pids.push(Number(pid)); }
    } catch {}
  }
  if (pids.length === 0) { console.log('Nothing is running.'); return; }
  for (const pid of new Set(pids)) {
    try { process.kill(pid, 'SIGTERM'); console.log('Stopped PID ' + pid); } catch {}
  }
  console.log('Cardinal Frame stopped.');
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
  port                         Show current dev port (fixed to 8080; set PORT env var to change)
  chat <message>               Send a chat message (POST /api/chat)
  run [args]                   Start server + dashboard (--no-client, --server-only)
  stop                         Stop server + dashboard

Environment:
  CF_API    API base URL (default: http://localhost:8080/api)
  CF_TOKEN  JWT token for authenticated endpoints
  CF_LOG_FILE  Path to log file (default: /tmp/cardinal-server.log)

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
        await port();
        break;
      case 'chat':
        await chat(sub !== undefined ? process.argv.slice(3) : []);
        break;
      case 'run':
        await run(process.argv.slice(3));
        break;
      case 'stop':
        await stop();
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
