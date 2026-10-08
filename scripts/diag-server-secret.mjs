// Diagnose: does the RUNNING server see ENCRYPT_SECRET?
// Can't read /proc/<pid>/environ for the real key (permissions/redaction).
// Instead: use the server's own API. POST /settings/env saves a value that
// the server encrypts with ITS key. GET /settings/env returns it decrypted.
// If roundtrip via API works, the server HAS a key (maybe not the .env one).
import { readFileSync } from 'fs';

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }

// Save probe (encrypted=true → server encrypts with its KEY_HEX)
const save = await fetch(BASE + '/settings/env', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ key: 'ROUNDTRIP_PROBE', value: 'abc-123-xyz', encrypted: true }),
});
console.log('save:', save.status, await save.text());

// Read back — server decrypts with the SAME key it encrypted with.
// If this returns the original value, server encrypt/decrypt works.
const list = await fetch(BASE + '/settings/env', { headers: { Authorization: `Bearer ${TOKEN}` } });
const rows = await list.json();
const probe = rows.find(r => r.key === 'ROUNDTRIP_PROBE');
console.log('readback:', JSON.stringify(probe));
console.log('roundtrip OK:', probe?.value === 'abc-123-xyz');

// Now read the RAW ciphertext from the DB and try decrypting with:
//   (a) SHA-256 of .env ENCRYPT_SECRET (what the server SHOULD have used)
//   (b) If that fails → the server is NOT using the .env secret
import Database from 'better-sqlite3';
import { createHash, createDecipheriv } from 'crypto';
const db = new Database('data/cardinal.db', { readonly: true });
const raw = db.prepare("SELECT value FROM env_vars WHERE key = 'ROUNDTRIP_PROBE'").get();

const envText = readFileSync('/home/haz/cardinal-frame/cardinal-frame/.env', 'utf8');
const envMatch = envText.match(/^ENCRYPT_SECRET="(.*)"$/m);
if (envMatch) {
  const secret = envMatch[1];
  try {
    const [ivB64, tagB64, encB64] = raw.value.split(':');
    const keyHex = createHash('sha256').update(secret).digest('hex');
    const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([d.update(Buffer.from(encB64, 'base64')), d.final()]).toString('utf8');
    console.log('decrypt with .env secret:', dec === 'abc-123-xyz' ? 'MATCH ✓ (server IS using .env secret)' : `MISMATCH (got: ${dec.slice(0, 30)})`);
  } catch (e) {
    console.log('decrypt with .env secret: FAIL —', e.message, '(server is NOT using the .env secret)');
  }
}

// Clean up
await fetch(BASE + '/settings/env/ROUNDTRIP_PROBE', { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
console.log('cleanup done');
