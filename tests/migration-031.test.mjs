/**
 * Migration 031 regression test: purge of stale admin mappings from
 * comms_user_sessions (audit round 2, post-C2 cleanup).
 *
 * Before the C2 fail-closed fix, inbound Telegram/Discord messages defaulted
 * to the seeded admin account ('haz-001'), so rows mapping external senders
 * to the admin user may still exist — and remain effective. Migration 031
 * deletes exactly those rows; rows mapping to any other CF user are intact.
 *
 * (vitest can't run on the Node 24 dev box — CI will run these.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(__dirname, '../src/server/migrations/031_purge_admin_comms_mappings.sql'),
  'utf8'
);

function seedDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE comms_user_sessions (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      remote_username TEXT,
      cf_user_id TEXT NOT NULL,
      agent_session_id TEXT,
      last_active TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(platform, remote_id)
    );
  `);
  const ins = db.prepare(
    'INSERT INTO comms_user_sessions (id, platform, remote_id, remote_username, cf_user_id) VALUES (?, ?, ?, ?, ?)'
  );
  // Stale admin mappings — the rows 031 must remove.
  ins.run('s1', 'telegram', '111', 'attacker', 'haz-001');
  ins.run('s2', 'discord', '222', 'oldbot', 'haz-001');
  // Legitimate mappings — 031 must leave these alone.
  ins.run('s3', 'telegram', '333', 'haz', 'user-abc');
  ins.run('s4', 'telegram', '444', 'friend', 'user-def');
  return db;
}

describe('migration 031 — purge admin comms mappings', () => {
  it('deletes rows mapping senders to the admin account', () => {
    const db = seedDb();
    db.exec(MIGRATION_SQL);
    const left = db.prepare('SELECT id FROM comms_user_sessions WHERE cf_user_id = ?').all('haz-001');
    expect(left).toEqual([]);
  });

  it('leaves mappings to other users intact', () => {
    const db = seedDb();
    db.exec(MIGRATION_SQL);
    const rows = db.prepare('SELECT id, cf_user_id FROM comms_user_sessions ORDER BY id').all();
    expect(rows.map(r => r.id)).toEqual(['s3', 's4']);
    expect(rows.map(r => r.cf_user_id)).toEqual(['user-abc', 'user-def']);
  });

  it('is a no-op on a clean database', () => {
    const db = seedDb();
    db.prepare("DELETE FROM comms_user_sessions WHERE cf_user_id = 'haz-001'").run();
    expect(() => db.exec(MIGRATION_SQL)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM comms_user_sessions').get().c).toBe(2);
  });
});
