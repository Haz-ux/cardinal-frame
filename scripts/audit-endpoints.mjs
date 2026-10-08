// Focused AI endpoint audit — check which "endpoint not found" hits are real.
// GET /learn/status, /evolution/status, /aimi/status, /embeddings,
// plus /api/learn/distill backward-compat proxy.
import { readFileSync } from 'fs';

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }

async function probe(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  console.log(`${method} /${path} → ${r.status}: ${text.slice(0, 140)}`);
}

await probe('GET', 'learn/status');
await probe('GET', 'evolution/status');
await probe('GET', 'aimi/status');
await probe('GET', 'embeddings');
await probe('GET', 'embeddings/status');
await probe('GET', 'learn/stats');
await probe('GET', 'learn/patterns');
await probe('GET', 'learn/observations');
await probe('GET', 'skills');
await probe('GET', 'tools');
await probe('GET', 'chains/skills');
await probe('GET', 'chains/tools');
// The regression from the handoff: /api/learn/distill proxy
await probe('POST', 'learn/distill', { observations: [], dryRun: true });
// Main route works?
await probe('POST', 'evolution/distill', { observations: [], dryRun: true });
