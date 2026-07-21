const Database = require('better-sqlite3');
const db = new Database('data/cardinal.db');
const before = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
db.prepare("DELETE FROM users WHERE id != 'admin-000'").run();
const after = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
db.prepare("DELETE FROM conversations WHERE user_id != 'admin-000'").run();
db.prepare("DELETE FROM messages WHERE user_id != 'admin-000'").run();
console.log(`Before: ${before} | After: ${after}`);
console.log('Cleaned up test data');
