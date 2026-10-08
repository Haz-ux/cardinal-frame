// The self-row came back undefined after restart. Two possibilities:
// 1. The restart endpoint exits the server but nothing restarted it (I ran
//    the server via a background shell — the restart endpoint does
//    process.exit(0), and the shell wrapper doesn't relaunch).
// 2. Server is down → check health.
import { execSync } from 'child_process';

let health = 'down';
try {
  const r = await fetch('http://localhost:8080/api/health', { signal: AbortSignal.timeout(5000) });
  health = `HTTP ${r.status}`;
} catch (e) { health = `down (${e.message.slice(0, 40)})`; }
console.log('health:', health);

// Is any node server process running?
try {
  const out = execSync('ps aux | /usr/bin/grep "node src/server/server.mjs" | /usr/bin/grep -v grep || true', { encoding: 'utf8' });
  console.log('server process:', out.trim() || 'NOT RUNNING');
} catch {}
