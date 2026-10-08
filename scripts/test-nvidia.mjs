// Test NVIDIA direct call + verify stored key decrypts
import Database from 'better-sqlite3';
import { createHash, createDecipheriv, randomBytes } from 'crypto';

const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET || null;
const KEY_HEX = ENCRYPT_SECRET
  ? createHash('sha256').update(ENCRYPT_SECRET).digest('hex')
  : randomBytes(32).toString('hex');

const db = new Database('data/cardinal.db');
const row = db.prepare("SELECT * FROM llm_providers WHERE type='nvidia'").get();

// Try decrypt with current process env secret
let decrypted = null;
try {
  const [ivB64, tagB64, encB64] = row.api_key.split(':');
  const key = Buffer.from(KEY_HEX, 'hex');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  decrypted = Buffer.concat([d.update(Buffer.from(encB64, 'base64')), d.final()]).toString('utf8');
} catch (e) { decrypted = `DECRYPT_FAIL: ${e.message}`; }

console.log('ENCRYPT_SECRET set:', !!ENCRYPT_SECRET);
console.log('decrypted:', decrypted ? decrypted.slice(0, 12) + '...' : 'null');
console.log('starts with nvapi-:', decrypted?.startsWith('nvapi-'));

if (decrypted?.startsWith('nvapi-')) {
  // Test direct NVIDIA call
  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${decrypted}` },
    body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 10 }),
    signal: AbortSignal.timeout(30000),
  });
  console.log('NVIDIA status:', resp.status);
  const text = await resp.text();
  console.log('NVIDIA resp:', text.slice(0, 300));
}
