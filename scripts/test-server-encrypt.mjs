// Test: what ENCRYPT_SECRET does the RUNNING server see?
// The server boots via preload-env.mjs which loads .env at import time.
// Query the live server instead of guessing: check /api/health + try a test
// roundtrip through the server's own encrypt/decrypt (via settings env test).

const TOKEN = (await import('fs')).readFileSync('/tmp/cf_token.txt', 'utf8').trim();

// 1. Save a test env var via the server API (server encrypts it with ITS key)
const saveResp = await fetch('http://localhost:8080/api/settings/env', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ key: 'TEST_DECRYPT_PROBE', value: 'probe-value-123', encrypted: true }),
});
console.log('save env:', saveResp.status);
const saved = await saveResp.json().catch(() => ({}));
console.log('saved:', JSON.stringify(saved).slice(0, 200));

// 2. Read it back with includeEncrypted (server decrypts with ITS key)
const listResp = await fetch('http://localhost:8080/api/settings/env', {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const list = await listResp.json().catch(() => []);
const probe = Array.isArray(list) ? list.find(e => e.key === 'TEST_DECRYPT_PROBE') : null;
console.log('probe row:', JSON.stringify(probe).slice(0, 300));

// 3. Clean up
const delResp = await fetch(`http://localhost:8080/api/settings/env/TEST_DECRYPT_PROBE`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${TOKEN}` },
});
console.log('cleanup:', delResp.status);
