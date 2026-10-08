// Fix the multi-node issues — both root causes now confirmed:
//
// 1. PEM newline: MINERVA row pubkey lacks trailing newline (112 chars vs 113).
//    Same key, different encoding — verification works (crypto is lenient),
//    but sha256(pem) differs → payload node_id ≠ registry row id.
//    Fix: normalize the row's pubkey in the DB (append trailing newline).
//
// 2. Case-sensitive lookup: getNodeByName('minerva') → NULL because the row
//    is 'MINERVA'. Delegation to node=minerva fell to awaiting_node.
//    Fix: COLLATE NOCASE in node-registry.mjs (getNodeByName + getReachableNode).
import Database from 'better-sqlite3';

// ─── Fix 1: normalize MINERVA row pubkey (append trailing newline) ──
const db = new Database('data/cardinal.db');
const minerva = db.prepare("SELECT id, public_key_pem FROM nodes WHERE name = 'MINERVA'").get();
if (minerva && !minerva.public_key_pem.endsWith('\n')) {
  db.prepare('UPDATE nodes SET public_key_pem = ? WHERE id = ?').run(minerva.public_key_pem + '\n', minerva.id);
  console.log('✅ MINERVA row pubkey normalized (trailing newline added)');
} else {
  console.log('MINERVA pubkey already normalized');
}

// Also normalize IKARIS/ARIES rows for consistency
const others = db.prepare("SELECT id, public_key_pem FROM nodes WHERE name != 'MINERVA'").all();
for (const n of others) {
  if (n.public_key_pem && !n.public_key_pem.endsWith('\n')) {
    db.prepare('UPDATE nodes SET public_key_pem = ? WHERE id = ?').run(n.public_key_pem + '\n', n.id);
    console.log(`✅ ${n.id} pubkey normalized`);
  }
}
