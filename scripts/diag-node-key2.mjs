// Fix both multi-node registry issues:
// 1. MINERVA row has a STALE public key (not this host's current identity key)
//    → signature verification passes only because checkNodeLiveness verifies
//    with the row's own pubkey against a payload signed by the CURRENT key.
//    Wait — it passed. That means... the health endpoint signs with the
//    CURRENT private key, and verify used the row's STALE pubkey — it should
//    FAIL. But it passed. Re-check: maybe the row pubkey IS current and my
//    hash comparison is wrong (PEM trailing newline handling).
//    → Diagnostic first: verify row pubkey against health signature directly.
// 2. getNodeByName is case-sensitive ('minerva' vs 'MINERVA') → delegation
//    to node=minerva fails with awaiting_node.
//    → Fix: COLLATE NOCASE lookups in node-registry.mjs.
import Database from 'better-sqlite3';
import { verifyPayload } from '/home/haz/cardinal-frame/cardinal-frame/src/server/node-identity.mjs';
import { readFileSync } from 'fs';

const db = new Database('data/cardinal.db', { readonly: true });
const minerva = db.prepare("SELECT * FROM nodes WHERE name = 'MINERVA'").get();

// Fetch health and verify with the ROW's pubkey
const r = await fetch(`${minerva.base_url}/api/health`, { signal: AbortSignal.timeout(5000) });
const j = await r.json();
const validWithRowKey = verifyPayload(minerva.public_key_pem, j.payload, j.signature);
console.log('verify with ROW pubkey:', validWithRowKey);

const identity = db.prepare('SELECT public_key_pem FROM node_identity').get();
const validWithIdentityKey = verifyPayload(identity.public_key_pem, j.payload, j.signature);
console.log('verify with IDENTITY pubkey:', validWithIdentityKey);
console.log('row pubkey === identity pubkey:', minerva.public_key_pem === identity.public_key_pem);
console.log('\npayload node_id:', j.payload?.node_id?.slice(0, 16) + '...');
console.log('identity node_id derives to the same:', identity.public_key_pem ? 'see above' : '?');
