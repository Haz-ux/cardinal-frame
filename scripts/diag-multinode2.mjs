// Diagnose multi-node issues (fixed: registry rows store public_key_pem as
// base64? or NULL — handle both)
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

const db = new Database('data/cardinal.db', { readonly: true });

const identity = db.prepare('SELECT node_id FROM node_identity').get();
console.log('real node_id:', identity.node_id.slice(0, 16) + '...');

const nodes = db.prepare('SELECT id, name, status, public_key_pem FROM nodes').all();
console.log('\n=== nodes registry ===');
for (const n of nodes) {
  const pk = n.public_key_pem;
  let derived = null;
  if (pk) {
    try { derived = createHash('sha256').update(pk).digest('hex').slice(0, 16) + '...'; } catch {}
  }
  console.log(`  ${n.name}: registry=${n.id.slice(0, 24)} | pubkey=${pk ? pk.slice(0, 20) + '...' : 'NULL'} | derived=${derived} | match=${pk && n.id === createHash('sha256').update(pk).digest('hex')}`);
}

// Delegation name lookup
const delegations = db.prepare("SELECT id, node, status FROM delegations ORDER BY created_at DESC LIMIT 3").all();
console.log('\nrecent delegations:');
delegations.forEach(d => console.log(`  ${d.id.slice(0, 8)}... node=${d.node} status=${d.status}`));

const byName = db.prepare("SELECT id, status FROM nodes WHERE name = ?").get('minerva');
console.log(`\ngetNodeByName('minerva') → ${byName ? `found (status=${byName.status})` : 'NULL'}`);
