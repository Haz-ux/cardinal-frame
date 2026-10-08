#!/usr/bin/env node
/**
 * Cardinal Frame — SQLite backup via VACUUM INTO (safe, online, WAL-safe).
 * Creates a timestamped snapshot in backups/ and prunes old ones (keep N).
 * Usage: node scripts/backup-db.mjs [--keep 7] [--dest backups]
 * Server boots with HOST_IP + NODE_NAME env (minerva) — see server.mjs.
 */
import Database from 'better-sqlite3';
import { readdirSync, statSync, mkdirSync, unlinkSync } from 'fs';
import path from 'path';

const REPO = '/home/haz/cardinal-frame/cardinal-frame';
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const KEEP = parseInt(getArg('keep', '7'));
const DEST = path.resolve(getArg('dest', path.join(REPO, 'backups')));

mkdirSync(DEST, { recursive: true });

// Live DB (WAL mode — cardinal.db). VACUUM INTO is online-safe:
// consistent snapshot while the server keeps running.
const dbPath = path.join(REPO, 'data', 'cardinal.db');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = path.join(DEST, `cardinal-${stamp}.db`);

const db = new Database(dbPath, { readonly: true });
db.exec(`VACUUM INTO '${outFile.replace(/'/g, "''")}'`);
db.close();

const info = new Database(outFile, { readonly: true });
const tables = info.prepare("SELECT COUNT(*) as n FROM sqlite_master WHERE type='table'").get().n;
const integrity = info.pragma('integrity_check')[0].integrity_check;
info.close();

// Prune old backups beyond KEEP
const files = readdirSync(DEST)
  .filter(f => f.startsWith('cardinal-') && f.endsWith('.db'))
  .sort()
  .reverse();
let pruned = 0;
for (const f of files.slice(KEEP)) {
  unlinkSync(path.join(DEST, f));
  pruned++;
}

const sizeMB = (statSync(outFile).size / 1024 / 1024).toFixed(2);
console.log(`✅ Backup: ${outFile}`);
console.log(`   size: ${sizeMB}MB | tables: ${tables} | integrity: ${integrity}`);
console.log(`   pruned: ${pruned} old (keeping ${KEEP})`);
if (integrity !== 'ok') { console.error('INTEGRITY CHECK FAILED'); process.exit(1); }
