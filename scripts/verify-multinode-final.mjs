// Final multi-node HA verification after fixes:
// 1. node_id in /api/health matches MINERVA registry row (PEM normalized)
// 2. getNodeByName('minerva') case-insensitive → delegation dispatches remote
// 3. Delegation roundtrip with wait → completes
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

const db = new Database('data/cardinal.db', { readonly: true });
const minerva = db.prepare("SELECT * FROM nodes WHERE name = 'MINERVA'").get();

// 1. Signed health + node_id match
const r = await fetch(`${minerva.base_url}/api/health`, { signal: AbortSignal.timeout(5000) });
const j = await r.json();
const sigOk = verifyPayload(minerva.public_key_pem, j.payload, j.signature);
const idMatch = j.payload?.node_id === minerva.id;
console.log(`${sigOk ? '✅' : '❌'} signature verifies: ${sigOk}`);
console.log(`${idMatch ? '✅' : '❌'} payload node_id == registry id: ${idMatch} (${j.payload?.node_id?.slice(0, 16)} vs ${minerva.id.slice(0, 16)})`);

// 2. Delegation with lowercase node name — should now dispatch remote (to minerva)
const del = await fetch(BASE + '/delegate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    name: 'ha-test-echo-2',
    command: 'echo ha-test-ok',
    node: 'minerva',
    wait: true,
    waitTimeout: 25000,
    warden_approve: true,
  }),
  signal: AbortSignal.timeout(40000),
});
const delJson = await del.json().catch(() => ({}));
console.log(`\nPOST /delegate (node=minerva, lowercase) → ${del.status}`);
console.log(`  node: ${delJson.delegation?.node || delJson.node} | status: ${delJson.delegation?.status || delJson.status}`);
const remoteDispatched = delJson.delegation?.node === 'MINERVA' || delJson.node === 'MINERVA';
console.log(`${remoteDispatched ? '✅' : '❌'} dispatched to MINERVA (remote): ${remoteDispatched}`);

// 3. Final state
const nodes = db.prepare('SELECT name, status FROM nodes').all();
console.log('\nnode fleet:', nodes.map(n => `${n.name}=${n.status}`).join(', '));
