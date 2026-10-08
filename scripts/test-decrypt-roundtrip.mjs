// Roundtrip: save a probe via the SERVER (server encrypts with its key),
// then read the ciphertext from DB and decrypt it with keys derived from
// candidate ENCRYPT_SECRETs. If decryption succeeds, we've identified the
// secret the server used — then test it against the stored NVIDIA key.
import Database from 'better-sqlite3';
import { createHash, createDecipheriv, randomBytes } from 'crypto';
import { readFileSync } from 'fs';

const TOKEN = readFileSync('/tmp/cf_token.txt', 'utf8').trim();

// 1. Save probe via server API
const saveResp = await fetch('http://localhost:8080/api/settings/env', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ key: 'TEST_DECRYPT_PROBE', value: 'probe-value-123', encrypted: true }),
});
console.log('save probe:', saveResp.status);

// 2. Grab raw ciphertext from DB
const db = new Database('data/cardinal.db');
const probe = db.prepare("SELECT value, encrypted FROM env_vars WHERE key = 'TEST_DECRYPT_PROBE'").get();
console.log('probe ciphertext:', probe?.value?.slice(0, 40) + '...');

// 3. Candidate secrets to try
const candidates = {
  'cf-default-secret-v1 (legacy XOR)': 'xor',
  'JWT_SECRET from .env': 'aes-jwt',
  'random (unknown)': null,
};

// Load JWT_SECRET from .env
const envText = readFileSync('.env', 'utf8');
const jwtMatch = envText.match(/^JWT_SECRET=(.*)$/m);
if (jwtMatch) candidates['JWT_SECRET from .env'] = jwtMatch[1].replace(/^["']|["']$/g, '');

function tryAes(secret, packed) {
  try {
    const [ivB64, tagB64, encB64] = packed.split(':');
    const key = createHash('sha256').update(secret).digest('hex');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(encB64, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}
function tryXor(secret, b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const key = Buffer.from(secret, 'utf8');
    for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
    return buf.toString('utf8');
  } catch { return null; }
}

let matchedSecret = null;
console.log('\n=== Decrypt probe with candidate secrets ===');
for (const [label, secret] of Object.entries(candidates)) {
  if (!secret) { console.log(`  ${label}: skip`); continue; }
  let out = null;
  if (secret === 'xor') out = tryXor(secret, probe.value);
  else out = tryAes(secret, probe.value);
  console.log(`  ${label}: ${out === 'probe-value-123' ? 'MATCH ✓' : out ? `wrong (${out.slice(0,15)})` : 'fail'}`);
  if (out === 'probe-value-123' && secret !== 'xor') matchedSecret = secret;
}

// 4. If we found the secret, decrypt the NVIDIA key
if (matchedSecret) {
  console.log(`\n=== Server's ENCRYPT_SECRET identified: ${matchedSecret.slice(0, 8)}... ===`);
  const nvidia = db.prepare("SELECT * FROM llm_providers WHERE type='nvidia'").get();
  const dec = tryAes(matchedSecret, nvidia.api_key);
  if (dec?.startsWith('nvapi-')) {
    console.log('NVIDIA key DECRYPTS ✓ — testing live call...');
    const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dec}` },
      body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 10 }),
      signal: AbortSignal.timeout(30000),
    });
    console.log('NVIDIA status:', resp.status);
    console.log('NVIDIA resp:', (await resp.text()).slice(0, 300));
  } else {
    console.log('NVIDIA key does NOT decrypt with this secret:', dec ? dec.slice(0, 20) : 'null');
  }
}

// 5. Clean up
await fetch('http://localhost:8080/api/settings/env/TEST_DECRYPT_PROBE', {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${TOKEN}` },
});
console.log('\ncleanup done');
