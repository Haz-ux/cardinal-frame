// Post-restart check: server up, Tailscale origins whitelisted (no env needed),
// CORS preflight from minerva origin passes.
import { execSync } from 'child_process';

await new Promise(r => setTimeout(r, 4000));

const health = await fetch('http://localhost:8080/api/health', { signal: AbortSignal.timeout(10000) });
const j = await health.json();
console.log('health:', j.payload?.status, '| uptime_s:', Math.round(j.payload?.uptime || 0));

// CORS preflight as if from the Tailscale hostname
const preflight = await fetch('http://localhost:8080/api/health', {
  method: 'OPTIONS',
  headers: { 'Origin': 'http://minerva:8080', 'Access-Control-Request-Method': 'GET' },
  signal: AbortSignal.timeout(10000),
});
console.log('preflight from minerva:', preflight.status, '| ACAO:', preflight.headers.get('access-control-allow-origin'));

// And from the tailscale IP
const preflight2 = await fetch('http://localhost:8080/api/health', {
  method: 'OPTIONS',
  headers: { 'Origin': 'http://100.101.127.49:8080', 'Access-Control-Request-Method': 'GET' },
  signal: AbortSignal.timeout(10000),
});
console.log('preflight from tailscale IP:', preflight2.status, '| ACAO:', preflight2.headers.get('access-control-allow-origin'));

// CORP header check
const resp = await fetch('http://localhost:8080/api/health', { signal: AbortSignal.timeout(10000) });
console.log('CORP:', resp.headers.get('cross-origin-resource-policy'));
