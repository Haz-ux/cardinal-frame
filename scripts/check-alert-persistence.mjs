// Check whether heartbeat:alert events land in activity_log (broadcast → logActivity)
import Database from 'better-sqlite3';
const db = new Database('data/cardinal.db', { readonly: true });
const alerts = db.prepare("SELECT id, type, payload, ts FROM activity_log WHERE type LIKE '%heartbeat%' ORDER BY ts DESC LIMIT 5").all();
console.log(`heartbeat events in activity_log: ${alerts.length}`);
alerts.forEach(a => console.log(`  - ${a.ts} ${a.type}: ${a.payload.slice(0, 100)}`));
const types = db.prepare("SELECT type, COUNT(*) as n FROM activity_log GROUP BY type ORDER BY n DESC").all();
console.log('\nall activity types:', types.map(t => `${t.type}(${t.n})`).join(', '));
