import Database from 'better-sqlite3';
const db = new Database('./data/cardinal.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

const chatTables = tables.filter(t => t.name.startsWith('chat_') || t.name === 'skills' || t.name === 'tools');
console.log('New tables:', chatTables.map(t => t.name).join(', ') || 'NONE - need to add them');

db.close();
