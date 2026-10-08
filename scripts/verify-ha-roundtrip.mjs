// Final multi-node HA verification — full signed delegation roundtrip:
// 1. Delegation dispatches to MINERVA (remote, signed Ed25519)
// 2. Receive path verifies signature, queues locally, executes
// 3. Report back: delegation completes with signed result
// Note: delegating to THIS host (minerva) loops back through its own
// /delegate/receive — still exercises the full crypto + queue path.
import Database from 'better-sqlite3';
import { verifyPayload } from '/home/haz/cardinal-frame/cardinal-frame/src/server/node-identity.mjs';

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

// 1. Delegate to minerva (lowercase name — tests case-insensitive lookup)
const del = await fetch(BASE + '/delegate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    name: 'ha-final-echo',
    command: 'echo ha-final-ok',
    node: 'minerva',
    wait: true,
    waitTimeout: 25000,
    warden_approve: true,
  }),
  signal: AbortSignal.timeout(40000),
});
const delJson = await del.json().catch(() => ({}));
const delegationId = delJson.id || delJson.delegation?.id;
const node = delJson.node || delJson.delegation?.node;
const status = delJson.status || delJson.delegation?.status;
console.log(`POST /delegate → ${del.status} | node=${node} | status=${status}`);
console.log(`${node === 'MINERVA' ? '✅' : '❌'} dispatched remote to MINERVA`);

// 2. Wait for completion + report back
let finalStatus = status, finalResult = null, finalSig = null;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const check = await fetch(`${BASE}/delegations/${delegationId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const cj = await check.json().catch(() => ({}));
  if (cj.status && cj.status !== 'pending' && cj.status !== 'running') {
    finalStatus = cj.status;
    finalResult = typeof cj.result === 'string' ? cj.result : JSON.stringify(cj.result);
    finalSig = cj.signature;
    break;
  }
  finalStatus = cj.status || finalStatus;
}
console.log(`\nfinal status: ${finalStatus}`);
if (finalResult) console.log(`result: ${finalResult.slice(0, 120)}`);
if (finalSig) {
  const dbRow = db.prepare('SELECT signature, reported_by FROM delegations WHERE id = ?').get(delegationId);
  console.log(`signed report: yes (reported_by=${dbRow?.reported_by || 'none'})`);
}

// 3. Remote queue state
const queue = db.prepare("SELECT status, COUNT(*) as n FROM remote_task_queue GROUP BY status").all();
console.log('\nremote_task_queue:', queue.map(q => `${q.status}=${q.n}`).join(', ') || 'empty');

const completed = finalStatus === 'completed' || finalStatus === 'done';
console.log(`\n${completed ? '✅ FULL ROUNDTRIP COMPLETE' : '⚠️ roundtrip incomplete — check logs'}`);
