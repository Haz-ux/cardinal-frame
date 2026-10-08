// Even wait=false /delegate hangs past 30s. The hang is NOT the wait loop —
// it's earlier. Suspects: sanitizeCommand, scoreCommand (WARDEN), or the
// registry getNodeByName with COLLATE NOCASE on a prepared stmt... or the
// getReachableNode change (I changed its signature — check the call site
// still works). Check the server log for the request and any error.
import { readFileSync } from 'fs';

const log = readFileSync('/home/haz/cardinal-frame/cardinal-frame/data/logs/server.log', 'utf8');
const lines = log.trim().split('\n');
console.log(`total lines: ${lines.length}`);
console.log('\n--- last 30 ---');
lines.slice(-30).forEach(l => {
  try {
    const j = JSON.parse(l);
    console.log(`[${j.level}] ${j.message?.slice(0, 140)}`);
  } catch { console.log(l.slice(0, 140)); }
});
