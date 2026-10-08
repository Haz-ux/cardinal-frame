// Wait for heartbeat to tick (60s interval), then verify an alert fired
// (memory_high should fire — heap runs >90%) and landed in activity_log.
import Database from 'better-sqlite3';

// Wait 70s to guarantee at least one heartbeat tick past boot
await new Promise(r => setTimeout(r, 70000));

const db = new Database('data/cardinal.db', { readonly: true });
const since = new Date(Date.now() - 120000).toISOString().slice(0, 19).replace('T', ' ');
const events = db.prepare("SELECT type, payload, ts FROM activity_log WHERE ts > ? AND type LIKE 'heartbeat%' ORDER BY ts DESC").all(since);
console.log(`heartbeat events since ${since}: ${events.length}`);

const alerts = events.filter(e => e.type === 'heartbeat:alert');
console.log(`alerts fired: ${alerts.length}`);
alerts.slice(0, 3).forEach(a => {
  const p = JSON.parse(a.payload);
  console.log(`  ✅ ${a.ts} ${p.rule}: ${p.message?.slice(0, 100)}`);
});

// Check rules' last_fired_at was updated
const rules = db.prepare('SELECT name, last_fired_at FROM heartbeat_rules WHERE last_fired_at IS NOT NULL').all();
console.log('\nrules with last_fired_at set:');
rules.forEach(r => console.log(`  - ${r.name}: ${r.last_fired_at}`));

if (alerts.length === 0 && rules.length === 0) {
  console.log('\n⚠️ no alerts fired yet — check heap level and rule evaluation');
}
