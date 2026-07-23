/**
 * Lightweight SQLite migration runner.
 * Reads .sql files from migrations/ dir, tracks applied in _migrations table.
 */
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

export function runMigrations(db) {
  // Ensure tracking table exists
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map(r => r.id)
  );

  let files = [];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch {
    console.log('[migrator] No migrations directory found — skipping');
    return { applied: 0, total: 0 };
  }

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const migrate = db.transaction(() => {
      try {
        db.exec(sql);
      } catch (err) {
        // Ignore "duplicate column" errors (ALTER TABLE ADD COLUMN is not idempotent)
        if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
          throw err;
        }
      }
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(file);
    });

    try {
      migrate();
      count++;
      console.log(`[migrator] Applied: ${file}`);
    } catch (err) {
      console.error(`[migrator] Failed: ${file} — ${err.message}`);
      throw err;
    }
  }

  if (count === 0) console.log('[migrator] Database up to date');
  return { applied: count, total: files.length };
}
