// Roundtrip stuck at pending. The dispatch targeted
// http://100.101.127.49:8080/api/delegate/receive — this host. Check the log
// for what happened on the receive side.
import { readFileSync } from 'fs';

const log = readFileSync('/home/haz/cardinal-frame/cardinal-frame/data/logs/server.log', 'utf8');
const lines = log.trim().split('\n');
const relevant = lines.filter(l => /delegat|receive|dispatch|denied|signature|failed/i.test(l));
console.log(`relevant lines (of ${lines.length}): ${relevant.length}`);
relevant.slice(-12).forEach(l => {
  try {
    const j = JSON.parse(l);
    console.log(`  [${j.level}] ${(j.message || '').slice(0, 150)}`);
  } catch { console.log('  ' + l.slice(0, 150)); }
});
