// Diagnose the two multi-node issues found:
// 1. node_id mismatch: /api/health payload.node_id is sha256(public_key) from
//    node_identity table, but registry rows use 'node-minerva' style IDs.
//    The registry was seeded with cosmetic IDs, not the real cryptographic ones.
// 2. delegation node=minerva → status=awaiting_node: registry lookup by name
//    failed OR getReachableNode filtered it out. Check why.
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

const db = new Database('data/cardinal.db', { readonly: true });

console.log('=== node_identity (real cryptographic ID) ===');
const identity = db.prepare('SELECT node_id, public_key_pem FROM node_identity').get();
console.log('  real node_id:', identity.node_id.slice(0, 16) + '...');

console.log('\n=== nodes table (registry) ===');
const nodes = db.prepare('SELECT id, name, status FROM nodes').all();
for (const n of nodes) {
  const derived = createHash('sha256').update(n.public_key_pem).digest('hex');
  console.log(`  ${n.name}: registry id=${n.id.slice(0, 20)}... | derived from its pubkey=${derived.slice(0, 16)}... | match=${n.id === derived}`);
}

console.log('\n=== Delegation status for the test ===');
const delegations = db.prepare("SELECT id, node, status FROM delegations ORDER BY created_at DESC LIMIT 3").all();
delegations.forEach(d => console.log(`  ${d.id.slice(0, 8)}... node=${d.node} status=${d.status}`));

// The registry getReachableNode with capability=null returns any online node.
// node=minerva → getNodeByName('minerva') — check case sensitivity
const byName = db.prepare("SELECT id, name, status FROM nodes WHERE name = ?").get('minerva');
const byNameUpper = db.prepare("SELECT id, name, status FROM nodes WHERE name = ?").get('MINERVA');
console.log(`\ngetNodeByName('minerva') → ${byName ? 'found' : 'null'} | ('MINERVA') → ${byNameUpper ? 'found' : 'null'}`);
