#!/usr/bin/env node
// Cardinal Frame CLI — manage tasks, agents, DAGs, schedules from terminal
import { randomUUID } from 'crypto';

const BASE = process.env.CF_API || 'http://localhost:8080/api';
let TOKEN = process.env.CF_TOKEN;

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

// ─── config ──────────────────────────────────────────────────
// `cardinal config` — manage environment variables + dev settings.
//   cardinal config list                         show all env vars + dev settings
//   cardinal config get <key>                    get an env var (masked unless --raw)
//   cardinal config set <key> <value> [--encrypt] set an env var
//   cardinal config unset <key>                  delete an env var
//   cardinal config dev                         show dev settings
//   cardinal config dev <key> <value>           set a dev setting (logLevel, debugMode, sandboxTimeout, maxConcurrentAgents, wsHeartbeatMs, embeddingModel)
async function ensureAuth() {
  if (TOKEN) return;
  try {
    const data = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    if (data.token) TOKEN = data.token;
  } catch (e) {
    console.error(`✗ Could not log in as admin: ${e.message}\n  Set CF_TOKEN or run 'cardinal token' and export it.`);
    process.exit(1);
  }
}

async function config(args) {
  await ensureAuth();
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'list') return configList(rest);
  if (sub === 'get') return configGet(rest);
  if (sub === 'set') return configSet(rest);
  if (sub === 'unset') return configUnset(rest);
  if (sub === 'dev') return configDev(rest);
  console.error(`Usage: cardinal config [list|get|set|unset|dev] [args...]\nRun 'cardinal help' for details.`);
  process.exit(1);
}

async function configList(_args) {
  try {
    const env = await req('GET', '/settings/env');
    const dev = await req('GET', '/settings/dev');
    console.log('── Environment Variables ──');
    if (!env.length) console.log('(none)');
    else {
      const sens = env.map(e => ({ key: e.key, value: e.encrypted ? '•••• (encrypted)' : e.value, category: e.category || '', encrypted: e.encrypted ? 'yes' : '' }));
      table(sens, ['key', 'value', 'category', 'encrypted']);
    }
    console.log('\n── Dev Settings ──');
    for (const [k, v] of Object.entries(dev)) {
      if (k === 'port') continue;
      console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    console.log(`  port: ${dev.port} (read-only — set PORT env var)`);
  } catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
}

async function configGet(args) {
  const [key, flag] = args;
  if (!key) { console.error('Usage: cardinal config get <key>'); process.exit(1); }
  const raw = flag === '--raw';
  const all = await req('GET', '/settings/env');
  const row = all.find(r => r.key === key);
  if (!row) { console.error(`"${key}" not set`); process.exit(1); }
  if (raw && row.encrypted) console.log(row.value);
  else if (raw) console.log(row.value);
  else console.log(row.encrypted ? '•••• (encrypted — use --raw to reveal)' : row.value);
}

async function configSet(args) {
  const [key, value, flag] = args;
  if (!key || value === undefined) { console.error('Usage: cardinal config set <key> <value> [--encrypt]'); process.exit(1); }
  const encrypted = flag === '--encrypt' ? 1 : 0;
  if (encrypted && value.length < 6) { console.error('Encrypted values should be at least 6 chars — refusing to hide a trivial value.'); process.exit(1); }
  const data = await req('POST', '/settings/env', { key, value, encrypted, category: 'general' });
  console.log(`Set "${data.key}"${encrypted ? ' (encrypted)' : ''}`);
}

async function configUnset(args) {
  const [key] = args;
  if (!key) { console.error('Usage: cardinal config unset <key>'); process.exit(1); }
  const data = await req('DELETE', `/settings/env/${encodeURIComponent(key)}`);
  console.log(`Unset "${key}"`);
}

async function configDev(args) {
  if (!args.length) {
    const dev = await req('GET', '/settings/dev');
    console.log('Dev Settings:');
    for (const [k, v] of Object.entries(dev)) {
      console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    return;
  }
  const [key, ...rest] = args;
  const value = rest.join(' ');
  if (value === '') { console.error('Usage: cardinal config dev <key> <value>'); process.exit(1); }
  if (key === 'port') { console.error('Port is fixed to 8080 — set the PORT env var or --server-only flag instead'); process.exit(1); }
  const data = await req('PUT', '/settings/dev', { [key]: String(value) });
  console.log(`Updated dev settings: ${(data.updated || []).join(', ') || '(no changes)'}`);
}

// ─── setup ───────────────────────────────────────────────────
// `cardinal setup` — first-run / bootstrap wizard: check health, login, seed
// the skill library (including the skill-scanner), and report what's ready.
async function setup(args) {
  // If no CF_TOKEN was provided, login as admin so we can call admin endpoints.
  await ensureAuth();
  console.log('Cardinal Frame — setup\n');
  // 1. Health
  try {
    const h = await req('GET', '/health');
    console.log(`✓ Server up — status: ${h.status || 'unknown'}, uptime: ${h.uptime ?? '-'}s`);
  } catch (e) {
    console.error(`✗ Server not reachable at ${BASE} — is 'cardinal run' going? (${e.message})`);
    process.exit(1);
  }
  // 2. Seed skills + chains
  console.log('Seeding skill library + chains…');
  try {
    const seed = await req('POST', '/skills/seed');
    console.log(`  skills: ${seed.total_seeded || 0} seeded, ${seed.total_skipped || 0} already present`);
    console.log(`  skill chains: ${seed.chains_seeded || 0} seeded, ${seed.chains_updated || 0} updated`);
    console.log(`  tool chains: ${seed.tool_chains_seeded || 0} seeded, ${seed.tool_chains_updated || 0} updated`);
    if ((seed.seeded || []).includes('skill-scanner')) console.log('  ✓ skill-scanner installed (pre-ingest gate active)');
  } catch (e) {
    console.error(`  ✗ seeding failed: ${e.message}`);
  }
  // 3. Status snapshot
  try {
    const st = await req('GET', '/health');
    console.log(`\nStatus — agents ready, ws clients: ${st.ws?.connected_clients ?? '-'}`);
  } catch {}
  console.log('\nNext: `cardinal config list` to view settings, `cardinal commands` to list all commands.');
}

// ─── commands ────────────────────────────────────────────────
// `cardinal commands` — print all available commands.
async function commands() {
  console.log(HELP);
}

// `cardinal doctor` — health/diagnostic check (placeholder).
async function doctor(args) {
  const fix = args[0] === 'fix';
  if (fix) {
    console.error('cardinal doctor:fix — not yet implemented');
    process.exit(2);
  }
  console.error('cardinal doctor — not yet implemented');
  process.exit(2);
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
  const serverProc = spawn('node', ['--max-old-space-size=512', 'src/server/server.mjs'], {
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
  let forwardProc = null;
  let lanForwardProc = null;
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

    // IPv4 loopback forwarder — vite binds only [::1] (a wildcard host would call
    // os.networkInterfaces(), which the proot sandbox blocks), so this tiny raw-TCP
    // proxy makes http://127.0.0.1:5173 and http://localhost:5173 work too.
    forwardProc = spawn('node', ['client/vite-ipv4-forward.mjs'], {
      cwd: CF_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    forwardProc.stdout?.on('data', (d) => process.stdout.write(`Forward: ${d}`));
    forwardProc.stderr?.on('data', (d) => process.stdout.write(`Forward: ${d}`));
    forwardProc.on('exit', (code) => console.log(`IPv4 forwarder exited (code=${code})`));

    // Optional LAN forwarder — if CARDINAL_LAN_HOST is set, also listen on that
    // WiFi IP so the phone browser can reach the app via the real interface
    // (Android's loopback handling for post-load fetches has been unreliable).
    if (process.env.CARDINAL_LAN_HOST) {
      lanForwardProc = spawn('node', ['client/vite-ipv4-forward.mjs'], {
        cwd: CF_DIR,
        env: { ...process.env, FWD_LISTEN_HOST: process.env.CARDINAL_LAN_HOST },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      lanForwardProc.stdout?.on('data', (d) => process.stdout.write(`Forward(LAN): ${d}`));
      lanForwardProc.stderr?.on('data', (d) => process.stdout.write(`Forward(LAN): ${d}`));
      lanForwardProc.on('exit', (code) => console.log(`LAN forwarder exited (code=${code})`));
      console.log(`Dashboard (LAN): http://${process.env.CARDINAL_LAN_HOST}:5173`);
    }
  }

  console.log('Cardinal Frame is running. Press Ctrl+C to stop.');

  const shutdown = () => {
    console.log('\nStopping Cardinal Frame...');
    if (clientProc) { try { clientProc.kill('SIGTERM'); } catch {} }
    if (forwardProc) { try { forwardProc.kill('SIGTERM'); } catch {} }
    if (lanForwardProc) { try { lanForwardProc.kill('SIGTERM'); } catch {} }
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
  for (const pat of ['src/server/server.mjs', 'client/node_modules/.bin/vite', 'client/vite-ipv4-forward.mjs']) {
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
  setup                        First-run wizard: health check + seed skill library & chains
  config [list|get|set|unset|dev]  Manage env vars + dev settings
                                  config list
                                  config get <key> [--raw]
                                  config set <key> <value> [--encrypt]
                                  config unset <key>
                                  config dev [key value]
  commands                     Print this command list
  doctor [fix]                 Diagnostics (placeholder — not yet implemented)

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
      case 'setup':
        await setup(rest);
        break;
      case 'config':
        await config([sub, ...rest].filter(a => a !== undefined));
        break;
      case 'commands':
        await commands();
        break;
      case 'doctor':
        await doctor([sub, ...rest].filter(a => a !== undefined));
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
