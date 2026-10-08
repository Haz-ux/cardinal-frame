// FINAL HA verification v3: all three delegation scenarios.
// Test 2 now: iKARIS unreachable → remote dispatch FAILS (fetch error) →
// fallback flips node to local → syncDelegationStatus tracks → completes.
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
  return { delStatus: del.status, node: dj.node || dj.delegation?.node, status: dj.status || dj.delegation?.status, elapsed };
}

const results = [];
console.log('=== Test 1: node=minerva (this host → local, no loop) ===');
const t1 = await delegateAndPoll('ha-self-t3', 'echo ha-self-t3-ok', 'minerva');
results.push(t1.status === 'completed' || t1.status === 'done');
console.log(`  → ${t1.delStatus} in ${t1.elapsed}s | node=${t1.node} status=${t1.status} ${results[0] ? '✅' : '❌'}`);

console.log('\n=== Test 2: node=ikaris (offline remote → fallback to local) ===');
const t2 = await delegateAndPoll('ha-fallback-t3', 'echo ha-fallback-t3-ok', 'ikaris');
results.push(t2.status === 'completed' || t2.status === 'done');
console.log(`  → ${t2.delStatus} in ${t2.elapsed}s | node=${t2.node} status=${t2.status} ${results[1] ? '✅ (clean fallback)' : '❌'}`);

console.log('\n=== Test 3: no node (registry pick, self excluded) ===');
const t3 = await delegateAndPoll('ha-auto-t3', 'echo ha-auto-t3-ok', null);
results.push(t3.status === 'completed' || t3.status === 'done');
console.log(`  → ${t3.delStatus} in ${t3.elapsed}s | node=${t3.node} status=${t3.status} ${results[2] ? '✅' : '❌'}`);

const stuck = db.prepare("SELECT COUNT(*) as n FROM delegations WHERE status IN ('pending','running','awaiting_node')").get();
console.log(`\nstuck delegations: ${stuck.n} ${stuck.n === 0 ? '✅' : '⚠️ (pre-existing test rows may be stuck — check below)'}`);
const stuckRows = db.prepare("SELECT id, node, status, created_at FROM delegations WHERE status IN ('pending','running','awaiting_node') ORDER BY created_at DESC LIMIT 6").all();
stuckRows.forEach(r => console.log(`  ${r.id.slice(0, 8)}... node=${r.node} status=${r.status} ${r.created_at}`));

console.log(`\n=== ${results.filter(Boolean).length}/3 delegation scenarios pass ===`);
