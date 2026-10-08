// FINAL HA verification (PORT fix applied): three delegation scenarios.
import Database from 'better-sqlite3';

await new Promise(r => setTimeout(r, 4000));

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }

const db = new Database('data/cardinal.db');

async function delegateAndPoll(name, command, nodeName, timeoutMs = 20000) {
  const t0 = Date.now();
  const del = await fetch(BASE + '/delegate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name, command, node: nodeName, wait: true, waitTimeout: timeoutMs, warden_approve: true }),
    signal: AbortSignal.timeout(timeoutMs + 30000),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const dj = await del.json().catch(() => ({}));
  const node = dj.node || dj.delegation?.node;
  const status = dj.status || dj.delegation?.status;
  return { delStatus: del.status, node, status, elapsed };
}

console.log('=== Test 1: node=minerva (this host → local, no loop) ===');
const t1 = await delegateAndPoll('ha-self-test', 'echo ha-self-ok', 'minerva');
const t1done = t1.status === 'completed' || t1.status === 'done';
console.log(`  → ${t1.delStatus} in ${t1.elapsed}s | node=${t1.node} status=${t1.status} ${t1done ? '✅' : '❌'}`);

console.log('\n=== Test 2: node=ikaris (offline remote → fallback) ===');
const t2 = await delegateAndPoll('ha-fallback-test', 'echo ha-fallback-ok', 'ikaris');
const t2done = t2.status === 'completed' || t2.status === 'done';
console.log(`  → ${t2.delStatus} in ${t2.elapsed}s | node=${t2.node} status=${t2.status} ${t2done ? '✅' : '❌'}`);

console.log('\n=== Test 3: no node (registry pick, self excluded) ===');
const t3 = await delegateAndPoll('ha-auto-test', 'echo ha-auto-ok', null);
const t3done = t3.status === 'completed' || t3.status === 'done';
console.log(`  → ${t3.delStatus} in ${t3.elapsed}s | node=${t3.node} status=${t3.status} ${t3done ? '✅' : '❌'}`);

const stuck = db.prepare("SELECT COUNT(*) as n FROM delegations WHERE status IN ('pending','running','awaiting_node')").get();
console.log(`\nstuck delegations: ${stuck.n} ${stuck.n === 0 ? '✅' : '⚠️'}`);
const passed = (t1done ? 1 : 0) + (t2done ? 1 : 0) + (t3done ? 1 : 0);
console.log(`\n=== ${passed}/3 delegation scenarios pass ===`);
