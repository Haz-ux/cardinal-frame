// Full AI-function audit: login, then exercise every AI surface.
// Providers, models, skills, agents, tools, Aimi, chat, MCP, learning.
import { readFileSync } from 'fs';

const BASE = 'http://localhost:8080/api';
const results = [];
function log(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}
async function req(method, path, body, token, expect = [200, 201]) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 400) };
}

// 1. Login
const login = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
const TOKEN = login.json?.token;
log('auth/login', !!TOKEN, TOKEN ? '' : login.text);
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }

// 2. Providers
const provs = await req('GET', '/llm/providers', null, TOKEN);
const provList = provs.json || [];
const nvidia = provList.find(p => p.type === 'nvidia');
log('llm/providers list', provs.status === 200, `${provList.length} providers`);
log('nvidia provider exists', !!nvidia, nvidia ? `enabled=${nvidia.enabled} has_key=${nvidia.has_key}` : 'MISSING');

// 3. Models
const models = await req('GET', '/llm/models', null, TOKEN);
log('llm/models list', models.status === 200, `${Array.isArray(models.json) ? models.json.length : '?'} models`);
const defaultModel = await req('GET', '/llm/models/default', null, TOKEN);
log('llm/models/default', defaultModel.status === 200 || defaultModel.status === 404, defaultModel.json?.model_id || defaultModel.text?.slice(0, 80));

// 4. NVIDIA key decrypts (server-side check via detect or direct chat)
if (nvidia && nvidia.has_key) {
  const chatTest = await req('POST', '/chat/completions', {
    messages: [{ role: 'user', content: 'Say OK' }],
    model: 'z-ai/glm-5.3-flash',
    stream: false,
    persona: 'direct',
  }, TOKEN);
  const ok = chatTest.status === 200 && chatTest.json?.choices?.[0]?.message?.content;
  log('chat via NVIDIA (key decrypt + live call)', ok, ok ? `"${chatTest.json.choices[0].message.content.slice(0, 40)}"` : chatTest.text.slice(0, 200));
}

// 5. Skills
const skills = await req('GET', '/skills', null, TOKEN);
log('skills list', skills.status === 200, `${Array.isArray(skills.json) ? skills.json.length : '?'} skills`);
const skillsHealth = await req('GET', '/skills/health', null, TOKEN);
log('skills/health', skillsHealth.status === 200 || skillsHealth.status === 404, '');

// 6. Agents
const agents = await req('GET', '/agents', null, TOKEN);
log('agents list', agents.status === 200, `${Array.isArray(agents.json) ? agents.json.length : '?'} agents`);
const agentHealth = await req('GET', '/agents/health', null, TOKEN);
log('agents/health', agentHealth.status === 200 || agentHealth.status === 404, '');

// 7. Tools
const tools = await req('GET', '/tools', null, TOKEN);
log('tools list', tools.status === 200, `${Array.isArray(tools.json) ? tools.json.length : typeof tools.json === 'object' ? Object.keys(tools.json).length : '?'} tools`);

// 8. Aimi
const aimiStatus = await req('GET', '/aimi/status', null, TOKEN);
log('aimi/status', aimiStatus.status === 200 || aimiStatus.status === 404, JSON.stringify(aimiStatus.json || {}).slice(0, 120));
const aimiTest = await req('POST', '/aimi/chat', { message: 'Say OK' }, TOKEN);
const aimiOk = aimiTest.status === 200 || aimiTest.status === 202;
log('aimi/chat', aimiOk, aimiOk ? JSON.stringify(aimiTest.json).slice(0, 120) : aimiTest.text.slice(0, 120));

// 9. Personas
const personas = await req('GET', '/personas', null, TOKEN);
log('personas list', personas.status === 200, `${personas.json?.personas?.length || '?'} personas, active=${personas.json?.default}`);

// 10. MCP servers
const mcp = await req('GET', '/mcp/servers', null, TOKEN);
log('mcp/servers list', mcp.status === 200, `${Array.isArray(mcp.json) ? mcp.json.length : '?'} servers`);

// 11. Learning
const learn = await req('GET', '/learn/status', null, TOKEN);
log('learn/status', learn.status === 200 || learn.status === 404, JSON.stringify(learn.json || {}).slice(0, 120));
const evolve = await req('GET', '/evolution/status', null, TOKEN);
log('evolution/status', evolve.status === 200 || evolve.status === 404, JSON.stringify(evolve.json || {}).slice(0, 120));

// 12. Embeddings
const embed = await req('POST', '/embeddings', { text: 'test embedding' }, TOKEN);
log('embeddings', embed.status === 200 || embed.status === 201 || embed.status === 404, JSON.stringify(embed.json || {}).slice(0, 100));

// Summary
const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} AI surfaces OK ===`);
if (failed.length) { console.log('FAILED:'); failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`)); }
