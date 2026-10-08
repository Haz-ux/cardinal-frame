// Full AI-function audit v2 — after server restart with stable ENCRYPT_SECRET.
// The stored NVIDIA key was encrypted under a PREVIOUS boot's random key, so
// it still fails. Check whether the provider row was re-encrypted by the boot
// migration (it only encrypts encrypted=0 rows — the dead key is encrypted=1
// garbage). Then update the NVIDIA key via API with the CURRENT secret.
import { readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { createHash, createDecipheriv } from 'crypto';

const BASE = 'http://localhost:8080/api';
const results = [];
function log(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}
async function req(method, path, body, token, timeout = 45000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text: text.slice(0, 400) };
}

const login = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
const TOKEN = login.json?.token;
if (!TOKEN) { console.log('FATAL: no token — ' + login.text); process.exit(1); }
log('auth/login', true);

// Read ENCRYPT_SECRET from .env (same file the server loads at boot)
const envText = readFileSync('/home/haz/cardinal-frame/cardinal-frame/.env', 'utf8');
const m = envText.match(/^ENCRYPT_SECRET="(.*)"$/m);
const SECRET = m ? m[1] : null;
log('ENCRYPT_SECRET in .env', !!SECRET, SECRET ? `${SECRET.length} chars` : 'MISSING');

// Check provider row encryption state
const db = new Database('data/cardinal.db', { readonly: true });
const nvidiaRow = db.prepare("SELECT * FROM llm_providers WHERE type='nvidia'").get();
log('nvidia row encrypted flag', nvidiaRow?.encrypted === 1, `encrypted=${nvidiaRow?.encrypted}`);

// Try decrypting the stored key with the .env secret
let keyOk = false, decryptedKey = null;
if (SECRET && nvidiaRow?.api_key) {
  try {
    const [ivB64, tagB64, encB64] = nvidiaRow.api_key.split(':');
    const keyHex = createHash('sha256').update(SECRET).digest('hex');
    const d = createDecipheriv('aes-256-gcm', keyHex, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    decryptedKey = Buffer.concat([d.update(Buffer.from(encB64, 'base64')), d.final()]).toString('utf8');
    keyOk = decryptedKey.startsWith('nvapi-');
  } catch { keyOk = false; }
}
log('stored key decrypts with .env secret', keyOk, keyOk ? decryptedKey.slice(0, 10) + '...' : 'undecryptable garbage');

// If key is garbage, re-set it via API (server re-encrypts with ITS current secret)
// NOTE: we don't have the real nvapi key value — the user must supply it.
// But we CAN check whether the server's encrypt/decrypt roundtrip works at all:
const probe = await req('POST', '/settings/env', { key: 'TEST_PROBE_2', value: 'roundtrip-check', encrypted: true }, TOKEN);
if (probe.status === 200) {
  const dbw = new Database('data/cardinal.db', { readonly: true });
  const prow = dbw.prepare("SELECT value, encrypted FROM env_vars WHERE key = 'TEST_PROBE_2'").get();
  try {
    const [ivB64, tagB64, encB64] = prow.value.split(':');
    const keyHex = createHash('sha256').update(SECRET).digest('hex');
    const d = createDecipheriv('aes-256-gcm', keyHex, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([d.update(Buffer.from(encB64, 'base64')), d.final()]).toString('utf8');
    log('server encrypt/decrypt roundtrip', dec === 'roundtrip-check', dec === 'roundtrip-check' ? 'server now uses .env secret ✓' : `got: ${dec.slice(0, 30)}`);
  } catch (e) {
    log('server encrypt/decrypt roundtrip', false, e.message);
  }
  await req('DELETE', '/settings/env/TEST_PROBE_2', null, TOKEN);
} else {
  log('server encrypt/decrypt roundtrip', false, `save probe failed: ${probe.status}`);
}

// Chat test — expected to still 401 until the user re-enters the real nvapi key
const chatTest = await req('POST', '/chat/completions', {
  messages: [{ role: 'user', content: 'Say OK' }],
  model: 'z-ai/glm-5.3-flash',
  stream: false,
  persona: 'direct',
}, TOKEN, 60000);
const chatOk = chatTest.status === 200 && chatTest.json?.choices?.[0]?.message?.content;
log('chat via NVIDIA', chatOk, chatOk ? `"${chatTest.json.choices[0].message.content.slice(0, 40)}"` : chatTest.text.slice(0, 200));

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks OK ===`);
if (failed.length) { console.log('FAILED:'); failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`)); }
