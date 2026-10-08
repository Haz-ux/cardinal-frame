// FINAL verification: node-identity settings fully working.
// 1. Self-row: single entry, correct name (MINERVA from dev_settings) +
//    correct base_url (hostIp from dev_settings)
// 2. Full roundtrip: node=minerva → local, completes (no loop)
// 3. UI row data present via GET /settings/dev
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

const db = new Database('data/cardinal.db', { readonly: true });

// 1. Self-row state
const identity = db.prepare('SELECT node_id FROM node_identity').get();
const self = db.prepare('SELECT id, name, base_url, status FROM nodes WHERE id = ?').get(identity.node_id);
const dupCount = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE name = 'MINERVA' COLLATE NOCASE").get().n;
console.log(`self-row: name=${self?.name} base_url=${self?.base_url} status=${self?.status}`);
console.log(`${dupCount === 1 ? '✅' : '❌'} single MINERVA entry: ${dupCount}`);
console.log(`${self?.base_url === 'http://100.101.127.49:8080' ? '✅' : '❌'} base_url from dev_settings hostIp`);

// 2. UI settings
const dev = await fetch(BASE + '/settings/dev', { headers: H }).then(r => r.json());
console.log(`${dev.nodeName === 'MINERVA' ? '✅' : '❌'} GET /settings/dev nodeName=${dev.nodeName}`);
console.log(`${dev.hostIp === '100.101.127.49' ? '✅' : '❌'} GET /settings/dev hostIp=${dev.hostIp}`);

// 3. Full delegation roundtrip with the settings-driven identity
const t0 = Date.now();
const del = await fetch(BASE + '/delegate', {
  method: 'POST', headers: H,
  body: JSON.stringify({ name: 'ha-settings-final', command: 'echo ha-settings-final-ok', node: 'minerva', wait: true, waitTimeout: 15000, warden_approve: true }),
  signal: AbortSignal.timeout(45000),
});
const dj = await del.json().catch(() => ({}));
const status = dj.status || dj.delegation?.status;
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\ndelegation node=minerva → ${del.status} in ${elapsed}s | status=${status} ${status === 'completed' ? '✅' : '❌'}`);

// 4. Health + UI build
const health = await fetch(BASE + '/health', { signal: AbortSignal.timeout(5000) });
console.log(`health: ${health.status === 200 ? '✅ ok' : '❌ ' + health.status}`);
