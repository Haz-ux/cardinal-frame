// Distill endpoint test with proper payloads (conversation_id, notes).
// The previous audit sent an empty body → 400/404 by design.
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
    signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  console.log(`${method} /${path} → ${r.status}: ${text.slice(0, 160)}`);
  return { status: r.status, text };
}

// notes source — should reach the LLM (failover handles NVIDIA key issue)
// Use a dryRun-style minimal input. Check if handleDistill supports notes.
await probe('POST', 'evolution/distill', { source_type: 'notes', notes: 'Test: when asked for status, return JSON with ok flag.' });
await probe('POST', 'learn/distill', { source_type: 'notes', notes: 'Test: when asked for status, return JSON with ok flag.' });
