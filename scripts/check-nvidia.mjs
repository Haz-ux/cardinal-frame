import Database from 'better-sqlite3';
const db = new Database('data/cardinal.db');
const row = db.prepare("SELECT id, name, type, enabled, api_key FROM llm_providers WHERE type='nvidia'").get();
console.log(JSON.stringify(row, null, 2));
const cols = db.prepare('PRAGMA table_info(llm_providers)').all().map(c => c.name);
console.log('columns:', cols.join(','));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'llm%'").all();
console.log('llm tables:', tables.map(t => t.name).join(','));
