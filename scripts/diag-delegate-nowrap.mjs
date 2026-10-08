// /delegate with wait=true hangs past 60s. Check: is it the warden approval
// path (broadcast → warden:approval_required) or the inline wait loop?
// Test WITHOUT wait first — should return 201 fast.
import Database from 'better-sqlite3';

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();

let t0 = Date.now();
const noWait = await fetch(BASE + '/delegate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    name: 'ha-nowrap-test',
    command: 'echo ha-nowrap-ok',
    node: 'minerva',
    wait: false,
    warden_approve: true,
  }),
  signal: AbortSignal.timeout(30000),
});
console.log(`POST /delegate (no wait) → ${noWait.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const nj = await noWait.json().catch(() => ({}));
console.log('  ', JSON.stringify(nj).slice(0, 300));

// Then poll the delegation separately
const delegationId = nj.id || nj.delegation?.id;
if (delegationId) {
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const row = await fetch(`${BASE}/delegations/${delegationId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const rj = await row.json().catch(() => ({}));
    if (rj.status === 'completed' || rj.status === 'done' || rj.status === 'failed') {
      console.log(`\ndelegation ${delegationId.slice(0, 8)}... → ${rj.status} after ${i + 1}s`);
      if (rj.result) console.log('  result:', String(rj.result).slice(0, 100));
      break;
    }
    if (i === 14) console.log(`\ndelegation still ${rj.status} after 15s`);
  }
}
