// Final health check: verify suite + health endpoint (no pipes)
import { execSync } from 'child_process';

const out = execSync('/home/haz/.hermes/node/bin/node scripts/verify.mjs http://localhost:8080/api', { cwd: '/home/haz/cardinal-frame/cardinal-frame', timeout: 120000, encoding: 'utf8' });
const lines = out.split('\n').filter(Boolean);
console.log(lines.slice(-3).join('\n'));

const health = await fetch('http://localhost:8080/api/health', { signal: AbortSignal.timeout(10000) });
const j = await health.json();
console.log('health:', j.payload?.status, '| tables:', j.payload?.db?.tables, '| uptime_s:', Math.round(j.payload?.uptime || 0));
