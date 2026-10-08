// The /delegate POST itself timed out — the wait=true path polls inline for
// waitTimeout (25s) + warden approval roundtrip; my fetch timeout was too
// tight (timeoutMs + 20000 = 45s vs server holding up to 25s + overhead).
// Actually: server returns after waitTimeout (25s) — fetch timeout 45s should
// be fine. The real stall: server-side inline wait polls syncDelegationStatus
// every 500ms and returns when complete — but if the task completes in 1s it
// should return fast. UNLESS warden approval blocks (403) — no, warden_approve
// = true. Retry with a single delegation and generous timeouts, watch closely.
import Database from 'better-sqlite3';

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();

const t0 = Date.now();
const del = await fetch(BASE + '/delegate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    name: 'ha-self-test',
    command: 'echo ha-self-ok',
    node: 'minerva',
    wait: true,
    waitTimeout: 15000,
    warden_approve: true,
  }),
  signal: AbortSignal.timeout(60000),
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const dj = await del.json().catch(() => ({}));
console.log(`POST /delegate → ${del.status} in ${elapsed}s`);
console.log(JSON.stringify(dj).slice(0, 400));
