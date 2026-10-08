// Aimi tool-calling audit: exercise SYSTEM_TOOLS via /api/aimi/chat and
// skills CRUD via the API. Also verify skills execute + chain endpoints.
import { readFileSync } from 'fs';

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }

async function req(method, path, body, timeout = 60000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 220) };
}

// Skills CRUD roundtrip
const create = await req('POST', '/skills', {
  name: 'audit-test-skill',
  handler: 'template:Return status ok for {{input}}',
  description: 'Audit test skill — safe to delete',
  category: 'general',
});
console.log('POST /skills →', create.status, create.text.slice(0, 120));
let skillId = create.json?.id || create.json?.skill?.id;
if (skillId) {
  const del = await req('DELETE', `/skills/${skillId}`);
  console.log('DELETE /skills/:id →', del.status, del.text.slice(0, 80));
}

// Tools CRUD roundtrip
const toolCreate = await req('POST', '/tools', {
  name: 'audit-test-tool',
  description: 'Audit test tool — safe to delete',
  endpoint: '/api/health',
  method: 'GET',
});
console.log('POST /tools →', toolCreate.status, toolCreate.text.slice(0, 120));
const toolId = toolCreate.json?.id;
if (toolId) {
  const del = await req('DELETE', `/tools/${toolId}`);
  console.log('DELETE /tools/:id →', del.status, del.text.slice(0, 80));
}

// Chains
const chainsS = await req('GET', '/chains/skills');
console.log('GET /chains/skills →', chainsS.status, chainsS.text.slice(0, 100));
const chainsT = await req('GET', '/chains/tools');
console.log('GET /chains/tools →', chainsT.status, chainsT.text.slice(0, 100));

// Aimi tool-calling: ask it to list agents (uses SYSTEM_TOOLS internally)
// This exercises executeSkill + tool resolution.
const aimi = await req('POST', '/aimi/chat', { message: 'Use the list_agents tool and tell me how many agents are registered.' }, 90000);
console.log('POST /aimi/chat (tool-call) →', aimi.status, aimi.text.slice(0, 200));
