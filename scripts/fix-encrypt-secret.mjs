// dev_settings exists but is empty. The running server therefore has NO
// stable ENCRYPT_SECRET — every boot generates a random key. Any key
// encrypted under a previous boot's key is garbage now.
//
// FIX: give the server a stable ENCRYPT_SECRET (write it into .env), then
// re-enter the NVIDIA key (via API using the admin token), encrypted with
// the stable secret. Then chat works across restarts.
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { createHash, createDecipheriv, randomBytes } from 'crypto';

// 1. Generate a stable secret
const newSecret = randomBytes(32).toString('hex');
const envPath = '/home/haz/cardinal-frame/cardinal-frame/.env';
let envText = readFileSync(envPath, 'utf8');
if (!envText.endsWith('\n')) envText += '\n';
envText += `ENCRYPT_SECRET="${newSecret}"\n`;
writeFileSync(envPath, envText);
console.log('ENCRYPT_SECRET written to .env ✓');

// 2. Login to get fresh token
const loginResp = await fetch('http://localhost:8080/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const login = await loginResp.json();
console.log('login:', loginResp.status, 'token len:', (login.token || '').length);
appendFileSync('/tmp/cf_token.txt', '\n' + login.token);
