// Find who inserted node-ikaris/node-aries/node-minerva rows. Not in src —
// check git history and the DB itself (created_at timestamps).
import Database from 'better-sqlite3';

const db = new Database('data/cardinal.db', { readonly: true });
const nodes = db.prepare('SELECT id, name, base_url, created_at, updated_at, last_seen_at, status FROM nodes').all();
console.log(JSON.stringify(nodes, null, 2));

// Does the /api/health payload node_id match ANY registry row?
const identity = db.prepare('SELECT node_id FROM node_identity').get();
console.log('\nreal node_id:', identity.node_id);
console.log('registry has real node_id:', nodes.some(n => n.id === identity.node_id));
