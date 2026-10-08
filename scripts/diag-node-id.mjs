// Root-cause analysis for the multi-node issues:
//
// 1. GET /api/health payload.node_id (030a243e...) ≠ registry MINERVA row
//    ('node-minerva'). The registry was seeded manually on 2026-10-03 with
//    cosmetic IDs and copied public keys. MINERVA's row has THIS host's
//    pubkey? — derived hash was 79338417... ≠ real node_id 030a243e...
//    Wait — the pubkey in the MINERVA row might be from a DIFFERENT boot
//    (regenerated identity? No — identity is stable across restarts).
//    Actually: 030a243e = sha256(public_key_pem) — but node-identity.mjs
//    exports the PEM with trailing newline. Hash includes it. My diag used
//    the raw DB value — same string. So 79338417 ≠ 030a243e means the
//    MINERVA row's pubkey is NOT this host's current key.
//
// 2. getNodeByName('minerva') → NULL: SQLite is case-sensitive for = on
//    TEXT. Registry stores 'MINERVA' (uppercase); request said 'minerva'.
//    Fix: case-insensitive lookup in getNodeByName + getReachableNode, or
//    COLLATE NOCASE on the column.
import Database from 'better-sqlite3';
import { createHash } from 'crypto';

const db = new Database('data/cardinal.db', { readonly: true });

// Verify hash hypothesis: sha256 of MINERVA row's pubkey vs its registry id
const minerva = db.prepare("SELECT id, public_key_pem FROM nodes WHERE name = 'MINERVA'").get();
const derivedFromRow = createHash('sha256').update(minerva.public_key_pem).digest('hex');
console.log('MINERVA row id:', minerva.id);
console.log('sha256(row pubkey):', derivedFromRow.slice(0, 16) + '...');
console.log('row pubkey hashes to its own id:', derivedFromRow === minerva.id);

const identity = db.prepare('SELECT node_id, public_key_pem FROM node_identity').get();
const derivedFromIdentity = createHash('sha256').update(identity.public_key_pem).digest('hex');
console.log('\nidentity node_id:', identity.node_id.slice(0, 16) + '...');
console.log('sha256(identity pubkey):', derivedFromIdentity.slice(0, 16) + '...');
console.log('identity hash matches identity node_id:', derivedFromIdentity === identity.node_id);
console.log('\nMINERVA row pubkey == identity pubkey:', minerva.public_key_pem === identity.public_key_pem);
