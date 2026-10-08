// The child task executed LOCALLY (status=done, result=ha-test-ok) even though
// the delegation says node=MINERVA. Why? The dispatch went to
// http://100.101.127.49:8080/api/delegate/receive — which is THIS host (the
// server binds '::'). So the remote receipt looped back to us. But
// remote_task_queue is EMPTY and the receive path didn't run (no receipt).
// Check the server log for the dispatch outcome.
import { readFileSync } from 'fs';

const log = readFileSync('/home/haz/cardinal-frame/cardinal-frame/data/logs/server.log', 'utf8');
const lines = log.trim().split('\n');
// Find delegation-related entries
const relevant = lines.filter(l => /delegat|receive|dispatch|warden/i.test(l));
console.log(`delegation-related log lines (of ${lines.length}): ${relevant.length}`);
relevant.slice(-15).forEach(l => {
  try {
    const j = JSON.parse(l);
    console.log(`  [${j.level}] ${(j.message || '').slice(0, 140)}`);
  } catch { console.log('  ' + l.slice(0, 140)); }
});
