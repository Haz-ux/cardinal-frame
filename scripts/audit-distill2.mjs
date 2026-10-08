// Verify distill endpoint DIRECTLY against the running server with full URL
// (the previous probe script had a path bug — BASE + 'evolution/distill'
// without leading slash → /apievoluion/... which is the actual bug we saw).
// Now: correct paths, and also test the trailing-slash form.
import { readFileSync } from 'fs';

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }

async function probe(path, body) {
  const url = BASE + path;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await r.text();
  console.log(`POST ${url} → ${r.status}: ${text.slice(0, 200)}`);
}

await probe('/evolution/distill', { source_type: 'notes', notes: 'When asked for a status report, respond with JSON containing an ok flag and a timestamp.' });
