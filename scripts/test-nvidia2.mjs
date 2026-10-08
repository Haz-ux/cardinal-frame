// Test: decrypt stored NVIDIA key the way the SERVER does (with .env loaded)
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(import.meta.dirname, '..', '..', '.env') });

import Database from 'better-sqlite3';
import { createHash, createDecipheriv } from 'crypto';

const ENCRYPT_SECRET = process.env.ENCRYPT_SECRET || null;
console.log('ENCRYPT_SECRET from .env:', ENCRYPT_SECRET ? `set (${ENCRYPT_SECRET.length} chars)` : 'NOT SET');

if (ENCRYPT_SECRET) {
  const KEY_HEX = createHash('sha256').update(ENCRYPT_SECRET).digest('hex');
  const db = new Database('data/cardinal.db');
  const row = db.prepare("SELECT * FROM llm_providers WHERE type='nvidia'").get();
  try {
    const [ivB64, tagB64, encB64] = row.api_key.split(':');
    const key = Buffer.from(KEY_HEX, 'hex');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([d.update(Buffer.from(encB64, 'base64')), d.final()]).toString('utf8');
    console.log('decrypted OK, starts with:', dec.slice(0, 12) + '...');
    console.log('is nvapi key:', dec.startsWith('nvapi-'));

    if (dec.startsWith('nvapi-')) {
      const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dec}` },
        body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 10 }),
        signal: AbortSignal.timeout(30000),
      });
      console.log('NVIDIA status:', resp.status);
      console.log('NVIDIA resp:', (await resp.text()).slice(0, 300));
    }
  } catch (e) {
    console.log('DECRYPT_FAIL:', e.message);
  }
}
