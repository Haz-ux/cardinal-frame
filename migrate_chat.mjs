import Database from 'better-sqlite3';
const db = new Database('./data/cardinal.db');

// Check if message_id is NOT NULL
const cols = db.prepare("PRAGMA table_info(chat_attachments)").all();
const msgCol = cols.find(c => c.name === 'message_id');
if (msgCol && msgCol.notnull) {
  console.log('Migrating chat_attachments: making message_id nullable...');
  // SQLite doesn't support ALTER COLUMN, so recreate
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_attachments_new (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      file_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT DEFAULT 'application/octet-stream',
      size INTEGER DEFAULT 0,
      storage_path TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO chat_attachments_new SELECT * FROM chat_attachments;
    DROP TABLE chat_attachments;
    ALTER TABLE chat_attachments_new RENAME TO chat_attachments;
  `);
  console.log('Migration complete.');
} else {
  console.log('chat_attachments.message_id already nullable. No migration needed.');
}

db.close();
