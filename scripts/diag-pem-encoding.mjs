// WHY does the signature verify with two DIFFERENT pubkeys?
// Hypothesis: the row pubkey and identity pubkey are the SAME KEY in
// different PEM encodings (e.g. different line wrapping or trailing
// newline). Normalize both and compare.
import Database from 'better-sqlite3';
import { createHash, createPublicKey } from 'crypto';

const db = new Database('data/cardinal.db', { readonly: true });
const minerva = db.prepare("SELECT public_key_pem FROM nodes WHERE name = 'MINERVA'").get();
const identity = db.prepare('SELECT public_key_pem, node_id FROM node_identity').get();

// Normalize via createPublicKey (canonical spki export)
const rowNorm = createPublicKey(minerva.public_key_pem).export({ type: 'spki', format: 'pem' });
const idNorm = createPublicKey(identity.public_key_pem).export({ type: 'spki', format: 'pem' });

console.log('row pubkey (raw) len:', minerva.public_key_pem.length);
console.log('identity pubkey (raw) len:', identity.public_key_pem.length);
console.log('normalized equal:', rowNorm === idNorm);
console.log('\nsha256(normalized row):', createHash('sha256').update(rowNorm).digest('hex').slice(0, 16));
console.log('sha256(normalized id):', createHash('sha256').update(idNorm).digest('hex').slice(0, 16));
console.log('identity node_id:', identity.node_id.slice(0, 16));
console.log('\nrow pubkey raw head:', JSON.stringify(minerva.public_key_pem.slice(0, 44)));
console.log('id pubkey raw head:', JSON.stringify(identity.public_key_pem.slice(0, 44)));
