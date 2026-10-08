// Wait for the delegated task to complete, then check the delegation + report
import Database from 'better-sqlite3';

await new Promise(r => setTimeout(r, 5000));

const db = new Database('data/cardinal.db', { readonly: true });
const dels = db.prepare("SELECT id, node, status, result, error FROM delegations ORDER BY created_at DESC LIMIT 2").all();
console.log('recent delegations:');
for (const d of dels) {
  console.log(`  ${d.id.slice(0, 8)}... node=${d.node} status=${d.status}`);
  if (d.result) console.log(`    result: ${d.result.slice(0, 120)}`);
  if (d.error) console.log(`    error: ${d.error.slice(0, 120)}`);
}

// The remote_task_queue on the node side (this host IS minerva — check receipt)
const queue = db.prepare("SELECT id, delegation_id, status, result FROM remote_task_queue ORDER BY created_at DESC LIMIT 3").all();
console.log('\nremote_task_queue (received delegations):');
queue.forEach(q => console.log(`  ${q.id.slice(0, 8)}... status=${q.status} result=${(q.result || '').slice(0, 80)}`));
