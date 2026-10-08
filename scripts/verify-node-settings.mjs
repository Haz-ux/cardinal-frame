// Verify node-identity settings end-to-end:
// 1. GET /settings/dev exposes nodeName + hostIp (env fallbacks)
// 2. PUT with invalid values → 400 validation
// 3. PUT valid values → saved + synced to env
// 4. Self-row updated: name + base_url reflect the settings
// 5. Restore original values
import Database from 'better-sqlite3';

await new Promise(r => setTimeout(r, 4000));

const BASE = 'http://localhost:8080/api';
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const { token: TOKEN } = await login.json();
if (!TOKEN) { console.log('FATAL: no token'); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

// 1. GET exposes nodeName + hostIp
const dev = await fetch(BASE + '/settings/dev', { headers: H }).then(r => r.json());
console.log(`GET /settings/dev: nodeName=${dev.nodeName} hostIp=${dev.hostIp}`);

// 2. Validation
const badName = await fetch(BASE + '/settings/dev', { method: 'PUT', headers: H, body: JSON.stringify({ nodeName: '' }) });
console.log(`\nPUT empty nodeName → ${badName.status} ${badName.status === 400 ? '✅' : '❌'}`);
const badIp = await fetch(BASE + '/settings/dev', { method: 'PUT', headers: H, body: JSON.stringify({ hostIp: 'not an ip!!' }) });
console.log(`PUT invalid hostIp → ${badIp.status} ${badIp.status === 400 ? '✅' : '❌'}`);
const longName = await fetch(BASE + '/settings/dev', { method: 'PUT', headers: H, body: JSON.stringify({ nodeName: 'x'.repeat(65) }) });
console.log(`PUT 65-char nodeName → ${longName.status} ${longName.status === 400 ? '✅' : '❌'}`);

// 3. Valid change: rename to "ORION" + Tailscale hostname
const put = await fetch(BASE + '/settings/dev', {
  method: 'PUT', headers: H,
  body: JSON.stringify({ nodeName: 'ORION', hostIp: '100.101.127.49' }),
});
const pj = await put.json();
console.log(`\nPUT nodeName=ORION hostIp=100.101.127.49 → ${put.status} ${put.status === 200 ? '✅' : '❌'} updated=[${(pj.updated || []).join(',')}]`);

// 4. Self-row reflects the change (registerNode upsert on boot — but this
// boot happened BEFORE the PUT; the change applies next boot. Restart.)
console.log('restarting to apply...');
await fetch(BASE + '/settings/dev/restart', { method: 'POST', headers: H }).catch(() => {});
await new Promise(r => setTimeout(r, 6000));

const db = new Database('data/cardinal.db', { readonly: true });
const selfRow = db.prepare("SELECT id, name, base_url, status FROM nodes WHERE capabilities LIKE '%self%'").get();
console.log(`\nself-row after restart: name=${selfRow?.name} base_url=${selfRow?.base_url} status=${selfRow?.status}`);
const nameMatch = selfRow?.name === 'ORION';
const urlMatch = selfRow?.base_url === 'http://100.101.127.49:8080';
console.log(`${nameMatch ? '✅' : '❌'} name applied: ${nameMatch}`);
console.log(`${urlMatch ? '✅' : '❌'} base_url applied: ${urlMatch}`);

// Legacy row re-homed?
const orionRows = db.prepare("SELECT id, name FROM nodes WHERE name = 'ORION' COLLATE NOCASE").all();
console.log(`\nORION rows: ${orionRows.length} ${orionRows.length === 1 ? '✅ (single entry)' : '⚠️'}`);
orionRows.forEach(r => console.log(`  ${r.id.slice(0, 20)}...`));

// 5. Restore original settings
const restore = await fetch(BASE + '/settings/dev', {
  method: 'PUT', headers: H,
  body: JSON.stringify({ nodeName: 'MINERVA' }),
});
console.log(`\nrestore nodeName=MINERVA → ${restore.status}`);
const dev2 = await fetch(BASE + '/settings/dev', { headers: H }).then(r => r.json());
console.log(`final: nodeName=${dev2.nodeName} hostIp=${dev2.hostIp}`);
