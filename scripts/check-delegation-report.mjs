// Wait longer, then check: did the delegation complete + report back?
// The receive path enqueues an outbound report via reportQueue.
import Database from 'better-sqlite3';

await new Promise(r => setTimeout(r, 8000));

const db = new Database('data/cardinal.db', { readonly: true });

const dels = db.prepare("SELECT id, node, status, result, error, signature, reported_by FROM delegations ORDER BY created_at DESC LIMIT 2").all();
console.log('recent delegations:');
for (const d of dels) {
  console.log(`  ${d.id.slice(0, 8)}... node=${d.node} status=${d.status} reported_by=${d.reported_by || 'none'}`);
  if (d.result) console.log(`    result: ${d.result.slice(0, 150)}`);
  if (d.error) console.log(`    error: ${d.error.slice(0, 150)}`);
  if (d.signature) console.log(`    signature: ${d.signature.slice(0, 40)}...`);
}

// Report queue state (outbound)
try {
  const reports = db.prepare("SELECT * FROM report_queue ORDER BY created_at DESC LIMIT 3").all();
  console.log('\nreport_queue:', reports.length);
  reports.forEach(r => console.log(`  ${r.id.slice(0, 8)}... status=${r.status} attempts=${r.attempts} error=${(r.last_error || '').slice(0, 60)}`));
} catch (e) { console.log('\nreport_queue table:', e.message); }

// Task result for the child task
const tasks = db.prepare("SELECT id, name, status, result, exit_code FROM tasks WHERE name LIKE '%delegated%' OR name LIKE '%ha-test%' ORDER BY created_at DESC LIMIT 3").all();
console.log('\ndelegated tasks:');
tasks.forEach(t => console.log(`  ${t.id.slice(0, 8)}... ${t.name} status=${t.status} exit=${t.exit_code} result=${(t.result || '').slice(0, 60)}`));
