// Read dev_settings table (readonly) — find ENCRYPT_SECRET if stored there
import Database from 'better-sqlite3';
const db = new Database('data/cardinal.db', { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
const dev = tables.includes('dev_settings');
console.log('dev_settings exists:', dev);
if (dev) {
  const rows = db.prepare('SELECT key, value FROM dev_settings').all();
  for (const r of rows) console.log(r.key, '=', String(r.value).slice(0, 60));
}
