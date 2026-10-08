// FINAL HA verification: node=minerva on the minerva host → local execution
// (no loop), delegation completes with syncDelegationStatus. Also verify
// remote dispatch to a REAL remote node would work (IKARIS offline → clean
// fallback to local, node flipped, completes).
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

async function delegateAndPoll(name, command, nodeName, timeoutMs = 25000) {
  const del = await fetch(BASE + '/delegate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ name, command, node: nodeName, wait: true, waitTimeout: timeoutMs, warden_approve: true }),
    signal: AbortSignal.timeout(timeoutMs + 20000),
  });
  const dj = await del.json().catch(() => ({}));
  const delegationId = dj.id || dj.delegation?.id;
  let status = dj.status || dj.delegation?.status;
  const node = dj.node || dj.delegation?.node;
  // Poll via /delegations/:id/wait
  if (delegationId && (status === 'pending' || status === 'awaiting_node')) {
    const w = await fetch(`${BASE}/delegations/${delegationId}/wait?timeout=${timeoutMs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(timeoutMs + 10000),
    });
    const wj = await w.json().catch(() => ({}));
    if (wj.status) status = wj.status;
  }
  return { delegationId, node, status };
}

// Test 1: node=minerva (self) → local execution, completes
console.log('=== Test 1: node=minerva (this host) ===');
const t1 = await delegateAndPoll('ha-self-test', 'echo ha-self-ok', 'minerva');
console.log(`  node=${t1.node} status=${t1.status} ${t1.status === 'completed' || t1.status === 'done' ? '✅' : '❌'}`);

// Test 2: node=ikaris (offline remote) → clean fallback to local, completes
console.log('\n=== Test 2: node=ikaris (offline) ===');
const t2 = await delegateAndPoll('ha-fallback-test', 'echo ha-fallback-ok', 'ikaris');
console.log(`  node=${t2.node} status=${t2.status} ${t2.status === 'completed' || t2.status === 'done' ? '✅ (clean fallback)' : '❌'}`);

// Test 3: no node → registry pick (excludes self; both remotes offline → awaiting_node → local fallback)
console.log('\n=== Test 3: no node specified ===');
const t3 = await delegateAndPoll('ha-auto-test', 'echo ha-auto-ok', null);
console.log(`  node=${t3.node} status=${t3.status} ${t3.status === 'completed' || t3.status === 'done' ? '✅' : '❌'}`);

// Verify no stuck delegations
const stuck = db.prepare("SELECT COUNT(*) as n FROM delegations WHERE status IN ('pending','running','awaiting_node')").get();
console.log(`\nstuck delegations: ${stuck.n} ${stuck.n === 0 ? '✅' : '⚠️'}`);
