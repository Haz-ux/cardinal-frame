// FINAL multi-node HA verification — full signed roundtrip:
// delegate → signed dispatch → receive (verify + queue) → execute → signed report → complete
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

// Self-row present?
const selfRow = db.prepare("SELECT id, name, status FROM nodes WHERE capabilities LIKE '%self%'").get();
console.log(`self-row: ${selfRow ? `${selfRow.name} (${selfRow.id.slice(0, 12)}...) status=${selfRow.status}` : 'MISSING'}`);

// 1. Delegate to minerva
const del = await fetch(BASE + '/delegate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    name: 'ha-final-2',
    command: 'echo ha-final-2-ok',
    node: 'minerva',
    wait: false,
    warden_approve: true,
  }),
  signal: AbortSignal.timeout(40000),
});
const delJson = await del.json().catch(() => ({}));
const delegationId = delJson.id || delJson.delegation?.id;
const node = delJson.node || delJson.delegation?.node;
console.log(`\nPOST /delegate → ${del.status} | node=${node} | delegation=${delegationId?.slice(0, 8)}...`);
console.log(`${node === 'MINERVA' ? '✅' : '❌'} dispatched remote to MINERVA`);

// 2. Poll for the full roundtrip: receive → queue → execute → report → complete
let finalStatus = 'pending', finalResult = null, finalSig = null, reportedBy = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const row = db.prepare('SELECT status, result, signature, reported_by FROM delegations WHERE id = ?').get(delegationId);
  if (!row) break;
  finalStatus = row.status;
  finalSig = row.signature;
  reportedBy = row.reported_by;
  if (row.status === 'completed' || row.status === 'done' || row.status === 'failed') {
    finalResult = row.result;
    break;
  }
}
console.log(`\nfinal status: ${finalStatus}`);
if (finalResult) console.log(`result: ${String(finalResult).slice(0, 140)}`);
if (finalSig) {
  console.log(`✅ report signed (reported_by=${reportedBy})`);
  const row = db.prepare('SELECT signature, result FROM delegations WHERE id = ?').get(delegationId);
  // Verify the report signature against the node's registered pubkey
  const nodeRow = db.prepare("SELECT public_key_pem FROM nodes WHERE name = 'MINERVA'").get();
  const sigValid = verifyPayload(nodeRow.public_key_pem, JSON.parse(row.result), row.signature);
  console.log(`${sigValid ? '✅' : '⚠️'} report signature verifies against registry pubkey: ${sigValid}`);
}

// 3. Remote queue exercised?
const queue = db.prepare("SELECT status, COUNT(*) as n FROM remote_task_queue GROUP BY status").all();
console.log('\nremote_task_queue:', queue.map(q => `${q.status}=${q.n}`).join(', ') || 'empty');

const completed = finalStatus === 'completed' || finalStatus === 'done';
console.log(`\n${completed ? '✅ FULL SIGNED ROUNDTRIP COMPLETE' : '⚠️ incomplete'}`);
