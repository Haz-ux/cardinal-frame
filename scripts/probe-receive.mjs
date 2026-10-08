// The delegation logs aren't in the file. The receive path never ran — check
// whether the dispatch actually reached /delegate/receive by probing it
// directly with a signed payload, and check the delegations table for the
// latest entry (maybe the report loop is polling wrong).
import Database from 'better-sqlite3';
import { verifyPayload, getOrCreateNodeIdentity, signPayload } from '/home/haz/cardinal-frame/cardinal-frame/src/server/node-identity.mjs';

const db = new Database('data/cardinal.db');

// Latest delegation
const del = db.prepare("SELECT * FROM delegations ORDER BY created_at DESC LIMIT 1").get();
console.log('latest delegation:', del.id.slice(0, 8), '| node:', del.node, '| status:', del.status);
console.log('child_task_id:', del.child_task_id);

// Was the child task executed?
const task = db.prepare('SELECT id, status, result, exit_code FROM tasks WHERE id = ?').get(del.child_task_id);
console.log('child task:', task ? `status=${task.status} exit=${task.exit_code} result=${(task.result || '').slice(0, 60)}` : 'NOT FOUND');

// Check remote_task_queue for ANY entries ever
const queueAll = db.prepare('SELECT COUNT(*) as n FROM remote_task_queue').get();
console.log('\nremote_task_queue total rows ever:', queueAll.n);

// Direct probe: POST /delegate/receive with a signed payload (self-loop)
const identity = getOrCreateNodeIdentity(db);
const payload = {
  delegation_id: 'diag-' + Date.now(),
  child_task_id: 'diag-task-' + Date.now(),
  name: '[diag] receive-probe',
  command: 'echo receive-probe-ok',
  capability: null,
  agent_id: null,
  priority: 'medium',
  synchronous: false,
  parent_task_id: null,
  parent_session_id: null,
  timestamp: new Date().toISOString(),
};
const signature = signPayload(identity.private_key_pem, payload);
const resp = await fetch('http://localhost:8080/api/delegate/receive', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ payload, signature, source_node_id: identity.node_id }),
  signal: AbortSignal.timeout(15000),
});
const rj = await resp.json().catch(() => ({}));
console.log('\nPOST /delegate/receive (direct, signed) →', resp.status, JSON.stringify(rj).slice(0, 200));
if (resp.status !== 200 && resp.status !== 202) {
  console.log('receive path REJECTS self-signed payload — that is why the roundtrip never completes');
}
