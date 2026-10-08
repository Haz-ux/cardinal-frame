// Progress: self-row registered (MINERVA, real crypto id, online) and the
// receive path WORKS now (remote_task_queue has a pending row — the receive
// side got it). But the dispatch chose node=local this time. Why?
// getReachableNode returns ANY online node — including OUR OWN self-row.
// Delegating to ourself via registry pick would loop. But we asked for
// node=minerva explicitly... and got node=local.
// Possible: getNodeByName('minerva') now matches BOTH 'MINERVA' (manual row)
// AND the self-row? No — self-row name is also MINERVA (NODE_NAME=MINERVA)!
// The manual row has base_url 100.101.127.49:8080, self-row has the same.
// getNodeByName returns the FIRST match — which may be either.
// Actually: the self-row insert used ON CONFLICT? No — registerNode does
// INSERT ... ON CONFLICT(id) — different id (crypto vs node-minerva), so TWO
// MINERVA rows now exist. Check.
import Database from 'better-sqlite3';
const db = new Database('data/cardinal.db', { readonly: true });
const nodes = db.prepare('SELECT id, name, base_url, status, capabilities FROM nodes ORDER BY name').all();
console.log(JSON.stringify(nodes, null, 2));
const byName = db.prepare("SELECT id, name FROM nodes WHERE name = ? COLLATE NOCASE").all('minerva');
console.log('\ngetNodeByName(minerva) matches:', byName.length, byName.map(n => n.id.slice(0, 16)));
