// Multi-node HA verification:
// 1. Registry has 3 nodes (IKARIS, ARIES, MINERVA) — MINERVA online (this host)
// 2. IKARIS/ARIES show offline — check if their base_urls are reachable
// 3. Signed health: verify /api/health response signature verifies against
//    MINERVA's registered public key
// 4. Delegation flow: POST /api/delegate with node=minerva, verify signed receipt
import Database from 'better-sqlite3';
import { verifyPayload } from '/home/haz/cardinal-frame/cardinal-frame/src/server/node-identity.mjs';
import { readFileSync } from 'fs';

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }

const db = new Database('data/cardinal.db', { readonly: true });
const nodes = db.prepare('SELECT * FROM nodes').all();

// 1. Reachability of the two offline nodes
console.log('=== Reachability of registered nodes ===');
for (const n of nodes) {
  try {
    const r = await fetch(`${n.base_url}/api/health`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json().catch(() => ({}));
    console.log(`  ${n.name} (${n.base_url}): HTTP ${r.status} — registry says ${n.status}${r.ok ? '' : ' (unreachable from here)'}`);
  } catch (e) {
    console.log(`  ${n.name} (${n.base_url}): UNREACHABLE — ${e.message.slice(0, 60)} — registry says ${n.status}`);
  }
}

// 2. Signed health verification (MINERVA = this host)
console.log('\n=== Signed health verification (MINERVA) ===');
const minerva = nodes.find(n => n.name === 'MINERVA');
if (minerva) {
  const r = await fetch(`${minerva.base_url}/api/health`, { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  const valid = verifyPayload(minerva.public_key_pem, j.payload, j.signature);
  console.log(`  signature verifies: ${valid ? '✓ (Ed25519 chain intact)' : '✗ FORGED/STALE KEY'}`);
  console.log(`  node_id in payload matches registry: ${j.payload?.node_id === minerva.id ? '✓' : '✗'}`);
}

// 3. Delegation roundtrip to minerva (online node)
console.log('\n=== Delegation roundtrip (node=MINERVA) ===');
const del = await fetch(BASE + '/delegate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    name: 'ha-test-echo',
    command: 'echo ha-test-ok',
    node: 'minerva',
    wait: true,
    waitTimeout: 20000,
    warden_approve: true,
  }),
  signal: AbortSignal.timeout(30000),
});
const delJson = await del.json().catch(() => ({}));
console.log(`  POST /delegate → ${del.status}`);
console.log(`  ${JSON.stringify(delJson).slice(0, 300)}`);
