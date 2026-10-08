// Log/alert pipeline audit: what exists, what consumes alerts.
// - Winston logs → console only (no file transport, no rotation)
// - heartbeat:alert broadcasts → WS only (check consumers)
// - audit_log table → populated by audit() helper
// - heartbeat_rules table → any rules configured?
import { readFileSync } from 'fs';
import Database from 'better-sqlite3';

const db = new Database('data/cardinal.db', { readonly: true });

// 1. Heartbeat rules
const rules = db.prepare('SELECT id, name, condition, action_type, enabled, last_fired_at FROM heartbeat_rules').all();
console.log(`heartbeat_rules: ${rules.length}`);
rules.forEach(r => console.log(`  - ${r.name} | ${r.condition} | ${r.action_type} | enabled=${r.enabled} | last=${r.last_fired_at || 'never'}`));

// 2. Audit log volume
const auditCount = db.prepare('SELECT COUNT(*) as n FROM audit_log').get().n;
const recent = db.prepare('SELECT actor, action, target, ts FROM audit_log ORDER BY ts DESC LIMIT 3').all();
console.log(`\naudit_log: ${auditCount} entries`);
recent.forEach(r => console.log(`  - ${r.ts} ${r.actor} ${r.action} ${r.target}`));

// 3. alert events — are they persisted anywhere?
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
console.log('\ntables with alert/log in name:', tables.filter(t => /alert|log|event/i.test(t)).join(', '));

// 4. Server log transport config
const srv = readFileSync('src/server/server.mjs', 'utf8');
const fileTransport = /transports\.File|DailyRotateFile/.test(srv);
console.log('\nserver log file transport:', fileTransport ? 'YES' : 'NO (console only)');
