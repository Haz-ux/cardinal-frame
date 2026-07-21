#!/usr/bin/env node
// Cardinal Frame Verification Suite — tests all Sprint 1-7 endpoints
import { randomUUID } from 'crypto';
const BASE = process.argv[2] || 'http://localhost:3000/api';
let token = '';
let adminToken = '';
let testResults = { pass: 0, fail: 0, errors: [] };
let created = { taskId: null, agentId: null, dagId: null, groupId: null, scheduleId: null, mcpId: null, fileSha: null };

async function req(method, path, body, tok) {
 const headers = { 'Content-Type': 'application/json' };
 if (tok || token) headers['Authorization'] = `Bearer ${tok || token}`;
 const opts = { method, headers };
 if (body) opts.body = JSON.stringify(body);
 try {
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
 } catch (err) {
  return { status: 0, data: { error: err.message } };
 }
}

function assert(name, condition, detail = '') {
 if (condition) {
  testResults.pass++;
  console.log(`  ✅ ${name}`);
 } else {
  testResults.fail++;
  testResults.errors.push(`${name}: ${detail}`);
  console.log(`  ❌ ${name} — ${detail}`);
 }
}

// ─── Test Suite ──────────────────────────────────────────────────

async function testHealth() {
 console.log('\n🩺 Health & Basics');
 const { status, data } = await req('GET', '/health');
 assert('Health endpoint returns 200', status === 200);
 assert('Status is ok', data.status === 'ok');
 assert('DB is SQLite', data.db === 'SQLite');
}

async function testAuth() {
 console.log('\n🔐 Authentication');
 // Register
 const reg = await req('POST', '/auth/register', { username: 'testuser', password: 'testpass123' });
 assert('Register returns 201 or 409', reg.status === 201 || reg.status === 409);
 if (reg.status === 201) assert('Register returns token', !!reg.data.token);

 // Login
 const login = await req('POST', '/auth/login', { username: 'testuser', password: 'testpass123' });
 assert('Login returns 200', login.status === 200);
 assert('Login returns token', !!login.data.token);
 token = login.data.token;

 // Admin login
 const adminLogin = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
 assert('Admin login returns 200', adminLogin.status === 200);
 adminToken = adminLogin.data.token;
}

async function testTasks() {
 console.log('\n📋 Tasks');
 // Create
 const create = await req('POST', '/tasks', { name: 'Verify task', command: 'echo hello-verify' }, token);
 assert('Create task returns 201', create.status === 201);
 assert('Task has id', !!create.data.id);
 created.taskId = create.data.id;

 // List
 const list = await req('GET', '/tasks', null, token);
 assert('List tasks returns 200', list.status === 200);
 assert('Tasks is array', Array.isArray(list.data));

 // Get single
 const get = await req('GET', `/tasks/${created.taskId}`, null, token);
 assert('Get task returns 200', get.status === 200);
 assert('Task name matches', get.data.name === 'Verify task');

 // Run (PATCH /tasks/:id/execute, not POST /tasks/:id/run)
 const run = await req('PATCH', `/tasks/${created.taskId}/execute`, null, token);
 assert('Execute task returns 200', run.status === 200);

 // Wait for completion
 await new Promise(r => setTimeout(r, 3000));

 // Verify done
 const done = await req('GET', `/tasks/${created.taskId}`, null, token);
 assert('Task completed', done.data.status === 'done');
 assert('Task has result', !!done.data.result);

 // Logs
 const logs = await req('GET', `/tasks/${created.taskId}/logs`, null, token);
 assert('Task logs return 200', logs.status === 200);

 // Dependencies
 const dep = await req('GET', `/tasks/${created.taskId}/dependencies`, null, token);
 assert('Dependencies endpoint works', dep.status === 200);

 // Next task — no /tasks/next endpoint; use agent claim instead
 const claim = await req('POST', `/agents/${created.agentId}/claim`, null, token);
 assert('Agent claim endpoint works', claim.status === 200 || claim.status === 404 /* 404 = no pending tasks */);
 }

async function testAgents() {
 console.log('\n🤖 Agents');
 // Register (POST /agents, not /agents/register)
 const reg = await req('POST', '/agents', { name: 'verify-agent', capabilities: ['testing'] }, token);
 assert('Register agent returns 201', reg.status === 201);
 assert('Agent has id', !!reg.data.id);
 created.agentId = reg.data.id;

 // List
 const list = await req('GET', '/agents', null, token);
 assert('List agents returns 200', list.status === 200);

 // Heartbeat (GET, not POST)
 const hb = await req('GET', `/agents/${created.agentId}/heartbeat`, null, token);
 assert('Heartbeat returns 200', hb.status === 200);

 // Health
 const health = await req('GET', '/agents/health', null, token);
 assert('Agent health returns 200', health.status === 200);

 // Get single
 const get = await req('GET', `/agents/${created.agentId}`, null, token);
 assert('Get agent returns 200', get.status === 200);
 assert('Agent name matches', get.data.name === 'verify-agent');
}

async function testDAGs() {
 console.log('\n🔀 DAGs');
 const create = await req('POST', '/dags', { name: 'verify-dag' }, token);
 assert('Create DAG returns 201', create.status === 201);
 assert('DAG has id', !!create.data.id);
 created.dagId = create.data.id;

 const list = await req('GET', '/dags', null, token);
 assert('List DAGs returns 200', list.status === 200);

 const get = await req('GET', `/dags/${created.dagId}`, null, token);
 assert('Get DAG returns 200', get.status === 200);

 // Add node via PUT /dags/:id (no POST /dags/:id/nodes endpoint)
 const nodeId = randomUUID();
 const node = await req('PUT', `/dags/${created.dagId}`, {
   nodes: [{ id: nodeId, name: 'step1', command: 'echo dag-step' }],
   edges: [],
 }, token);
 assert('Update DAG with node returns 200', node.status === 200);
 assert('DAG has node', Array.isArray(node.data.nodes) && node.data.nodes.length > 0);
 }

async function testGroups() {
 console.log('\n👥 Agent Groups');
 const create = await req('POST', '/groups', { name: 'verify-group', description: 'Test group' }, token);
 assert('Create group returns 201', create.status === 201);
 assert('Group has id', !!create.data.id);
 created.groupId = create.data.id;

 const list = await req('GET', '/groups', null, token);
 assert('List groups returns 200', list.status === 200);

 const get = await req('GET', `/groups/${created.groupId}`, null, token);
 assert('Get group returns 200', get.status === 200);
 assert('Group name matches', get.data.name === 'verify-group');

 // Add agent to group
 const add = await req('POST', `/groups/${created.groupId}/members`, { agentId: created.agentId }, token);
 assert('Add agent to group returns 200', add.status === 200);

 // Broadcast (requires name + command)
 const broadcast = await req('POST', `/groups/${created.groupId}/broadcast`, { name: 'group-test-task', command: 'echo group-test' }, token);
 assert('Group broadcast returns 201', broadcast.status === 201);
}

async function testSchedules() {
 console.log('\n⏰ Schedules');
 const create = await req('POST', '/schedules', { name: 'verify-schedule', cron_expr: '*/30 * * * *', command: 'echo scheduled' }, token);
 assert('Create schedule returns 201', create.status === 201);
 assert('Schedule has id', !!create.data.id);
 assert('Schedule has next_run', !!create.data.next_run);
 created.scheduleId = create.data.id;

 const list = await req('GET', '/schedules', null, token);
 assert('List schedules returns 200', list.status === 200);

 // Toggle
 const toggle = await req('PATCH', `/schedules/${created.scheduleId}/toggle`, null, token);
 assert('Toggle schedule returns 200', toggle.status === 200);

 // Delete
 const del = await req('DELETE', `/schedules/${created.scheduleId}`, null, adminToken);
 assert('Delete schedule returns 200', del.status === 200);
}

async function testFiles() {
 console.log('\n📁 Files');
 // Upload using FormData
 const form = new FormData();
 form.append('file', new Blob(['verify file content'], { type: 'text/plain' }), 'verify-test.txt');
 const uploadRes = await fetch(`${BASE}/files/upload`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: form,
 });
 const uploadData = await uploadRes.json();
 assert('File upload returns 201', uploadRes.status === 201);
 assert('Upload returns file id', !!uploadData.id);

 const list = await req('GET', '/files', null, token);
 assert('List files returns 200', list.status === 200);

 if (uploadData.id) {
  const del = await req('DELETE', `/files/${uploadData.id}`, null, adminToken);
  assert('Delete file returns 200', del.status === 200);
 }
}

async function testMCP() {
 console.log('\n🔌 MCP Servers');
 const create = await req('POST', '/mcp/servers', { name: 'verify-mcp', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] }, token);
 assert('Register MCP server returns 201', create.status === 201);
 assert('MCP server has id', !!create.data.id);
 created.mcpId = create.data.id;

 const list = await req('GET', '/mcp/servers', null, token);
 assert('List MCP servers returns 200', list.status === 200);
}

async function testPlugins() {
 console.log('\n🧩 Plugins');
 const list = await req('GET', '/plugins', null, token);
 assert('List plugins returns 200', list.status === 200);
 assert('Plugins is array', Array.isArray(list.data));
}

async function testUsers() {
 console.log('\n👤 Users (admin)');
 const list = await req('GET', '/users', null, adminToken);
 assert('List users returns 200', list.status === 200);
 assert('Users is array', Array.isArray(list.data));
}

async function testCLI() {
 console.log('\n💻 CLI Tool');
 const { execSync } = await import('child_process');
 try {
  const out = execSync('node src/cli/cardinal.mjs health', { cwd: '/home/haz/cardinal-frame/cardinal-frame', env: { ...process.env, CF_TOKEN: token }, timeout: 10000 }).toString();
  assert('CLI health works', out.includes('"ok"'));
 } catch (e) {
  assert('CLI health works', false, e.message.slice(0, 100));
 }

 try {
  const out = execSync('node src/cli/cardinal.mjs tasks', { cwd: '/home/haz/cardinal-frame/cardinal-frame', env: { ...process.env, CF_TOKEN: token }, timeout: 10000 }).toString();
  assert('CLI tasks list works', out.length > 0);
 } catch (e) {
  assert('CLI tasks list works', false, e.message.slice(0, 100));
 }
}

// ─── Sprint 8: Cancel/Retry/Audit ────────────────────────────────
async function testSprint8() {
 console.log('\n🚀 Sprint 8 — Cancel / Retry / Audit / Search');

 // Create a task to cancel (use long-running allowed command)
 const t = await req('POST', '/tasks', { name: 'cancel-test', command: 'node -e "setTimeout(()=>{},60000)"' });
 const tid = t.data.id;
 created.cancelTaskId = tid;

 // Execute it, then cancel
 await req('PATCH', `/tasks/${tid}/execute`);
 await new Promise(r => setTimeout(r, 500));
 const cancel = await req('PATCH', `/tasks/${tid}/cancel`);
 assert('Cancel running task returns 200', cancel.status === 200, `got ${cancel.status}`);
 assert('Task status is cancelled', cancel.data.status === 'cancelled', `got ${cancel.data.status}`);

 // Retry the cancelled task
 const retry = await req('POST', `/tasks/${tid}/retry`);
 assert('Retry cancelled task returns 200', retry.status === 200, `got ${retry.status}`);
 assert('Retry sets status to running', retry.data.status === 'running', `got ${retry.data.status}`);

 // Agent task history
 const a = await req('GET', `/agents/${created.agentId}/tasks`);
 assert('Agent task history returns 200', a.status === 200, `got ${a.status}`);
 assert('Agent task history is array', Array.isArray(a.data), `got ${typeof a.data}`);

 // Audit log (admin)
 const audit = await req('GET', '/audit', null, adminToken);
 assert('Audit log returns 200', audit.status === 200, `got ${audit.status}`);
 assert('Audit log is array', Array.isArray(audit.data), `got ${typeof audit.data}`);
 assert('Audit log has entries', audit.data.length > 0, 'no entries');

 // Search/filter tasks
 const s1 = await req('GET', '/tasks?status=running');
 assert('Task filter by status returns 200', s1.status === 200, `got ${s1.status}`);
 const s2 = await req('GET', '/tasks?search=cancel');
 assert('Task search returns 200', s2.status === 200, `got ${s2.status}`);

 // Search agents
 const s3 = await req('GET', '/agents?search=test');
 assert('Agent search returns 200', s3.status === 200, `got ${s3.status}`);
}

// ─── Run All ─────────────────────────────────────────────────────
async function run() {
 console.log('══════════════════════════════════════════');
 console.log('  Cardinal Frame — Verification Suite');
 console.log(`  Target: ${BASE}`);
 console.log('══════════════════════════════════════════');

 await testHealth();
 await testAuth();
 await testTasks();
 await testAgents();
 await testDAGs();
 await testGroups();
 await testSchedules();
 await testFiles();
 await testMCP();
 await testPlugins();
 await testUsers();
 await testCLI();
 await testSprint8();

 console.log('\n══════════════════════════════════════════');
 console.log(`  Results: ${testResults.pass} passed, ${testResults.fail} failed`);
 if (testResults.errors.length) {
  console.log('  Failures:');
  for (const e of testResults.errors) console.log(`    - ${e}`);
 }
 console.log('══════════════════════════════════════════');
 process.exit(testResults.fail > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(2); });
