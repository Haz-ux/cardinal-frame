// The log only shows "request" lines — the delegation logs use logger.info
// but the file may only capture some. Check ALL entries around the delegate
// call time, and check whether /delegate/receive was even hit.
import { readFileSync } from 'fs';

const log = readFileSync('/home/haz/cardinal-frame/cardinal-frame/data/logs/server.log', 'utf8');
const lines = log.trim().split('\n');
console.log(`total: ${lines.length}`);
// Show last 25 lines raw
console.log('\n--- last 25 ---');
lines.slice(-25).forEach(l => {
  try {
    const j = JSON.parse(l);
    console.log(`[${j.level}] ${j.message?.slice(0, 130)}`);
  } catch { console.log(l.slice(0, 130)); }
});
