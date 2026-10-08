// The self-row duplicated the MINERVA entry (two rows, same name, different id).
// getNodeByName now returns the first match — the manual 'node-minerva' row.
// The delegation picked node=local because... wait, the manual row is online.
// But getReachableNode was bypassed: explicit node=minerva → getNodeByName →
// FIRST match = node-minerva (online) → dispatchMode='remote'. It returned
// node=local, so the dispatch must have FAILED and the fallback flipped it.
// The failure: dispatchToRemoteNode posted to 100.101.127.49:8080 (self-loop)
// → receive → verify signature of SENDER = our real id → self-row HAS the
// real id → should pass now... but remote_task_queue has a PENDING row that
// never got claimed/executed.
//
// REAL ISSUE: the receive path enqueues + spawns executeAndReport async —
// but its executeTask is fire-and-forget. The queue row shows pending=1
// (never claimed). And the loopback receive probably DID work but slowly.
// Check: is there a receive-side execution pending? Check the queue row +
// whether executeAndReport ran (check tasks for the diag task).
import Database from 'better-sqlite3';
const db = new Database('data/cardinal.db', { readonly: true });
const queue = db.prepare('SELECT * FROM remote_task_queue ORDER BY created_at DESC LIMIT 3').all();
console.log('remote_task_queue:');
queue.forEach(q => console.log(`  ${q.id.slice(0, 8)}... del=${q.delegation_id.slice(0, 8)} status=${q.status} attempts=${q.attempts} cmd=${q.command.slice(0, 40)} error=${(q.last_error || '').slice(0, 60)}`));
const tasks = db.prepare("SELECT id, name, status, result FROM tasks WHERE name LIKE '%ha-final%' OR name LIKE '%delegated%' ORDER BY created_at DESC LIMIT 5").all();
console.log('\nrecent delegated tasks:');
tasks.forEach(t => console.log(`  ${t.id.slice(0, 8)}... ${t.name} status=${t.status} result=${(t.result || '').slice(0, 40)}`));
