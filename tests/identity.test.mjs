import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getIdentity,
  updateIdentity,
  resetToDefault,
  resolvePrincipal,
  IDENTITY_DEFAULTS,
} from '../src/server/identity/identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;

function freshDb() {
  const d = new Database(':memory:');
  d.exec(readFileSync(join(MIGRATIONS, '017_identity.sql'), 'utf8'));
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return d;
}

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  db.close();
});

describe('identity — companion singleton record', () => {
  it('returns the default identity when no row exists yet', () => {
    const id = getIdentity(db);
    expect(id.id).toBe('singleton');
    expect(id.name).toBe('Aimi');
    expect(id.character).toBe('AI companion');
    expect(id.vibe).toBe('sharp, warm, tech-infused');
    expect(id.color_language).toBe('{}');
    expect(id.style_anchors).toBe('[]');
    expect(id.avatar_master_ref).toBeNull();
    expect(id.voice_profile).toBe('{}');
  });

  it('persists a partial update and round-trips it', () => {
    const updated = updateIdentity(db, { name: 'Nova', vibe: 'cool, calm' });
    expect(updated.name).toBe('Nova');
    expect(updated.vibe).toBe('cool, calm');
    expect(updated.character).toBe(IDENTITY_DEFAULTS.character);
    expect(getIdentity(db).name).toBe('Nova');
  });

  it('trims the name and bounds long fields', () => {
    const updated = updateIdentity(db, { name: '   Nova   ', character: 'x'.repeat(500) });
    expect(updated.name).toBe('Nova');
    expect(updated.character).toHaveLength(200);
  });

  it('ignores unknown keys and non-string values', () => {
    const updated = updateIdentity(db, { name: 'Nova', injected: 'hax', vibe: 123, malicious: true });
    expect(updated.injected).toBeUndefined();
    expect(updated.malicious).toBeUndefined();
    expect(updated.vibe).toBe(IDENTITY_DEFAULTS.vibe);
    expect(db.prepare('SELECT * FROM companion_identity').get().name).toBe('Nova');
  });

  it('does not allow an empty name to overwrite the current name', () => {
    updateIdentity(db, { name: 'Nova' });
    const updated = updateIdentity(db, { name: '   ' });
    expect(updated.name).toBe('Nova');
  });

  it('strips JSON line separators from stored values', () => {
    const updated = updateIdentity(db, { style_anchors: 'a\u2028b\u2029c' });
    expect(updated.style_anchors).toBe('a b c');
  });

  it('resets everything to the defaults', () => {
    updateIdentity(db, { name: 'Nova', vibe: 'edgy', character: 'hacker', color_language: '{"hue":"red"}' });
    const reset = resetToDefault(db);
    expect(reset.name).toBe(IDENTITY_DEFAULTS.name);
    expect(reset.vibe).toBe(IDENTITY_DEFAULTS.vibe);
    expect(reset.character).toBe(IDENTITY_DEFAULTS.character);
    expect(reset.color_language).toBe(IDENTITY_DEFAULTS.color_language);
    expect(reset.avatar_master_ref).toBeNull();
    expect(reset.voice_profile).toBe(IDENTITY_DEFAULTS.voice_profile);
  });
});

describe('identity — principal resolution (P1.10)', () => {
  it('grounds the actor role in the DB, not the token claim', () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('haz-001', 'Haz', '$2y$10$x', 'admin')`).run();
    // Token claims a (wrong) plain user role — authorization must ignore it.
    const principal = resolvePrincipal(db, { id: 'haz-001', username: 'Haz', role: 'user' });
    expect(principal).toEqual({ id: 'haz-001', role: 'admin' });
  });

  it('rejects a forged client-supplied identifier that is not in the DB', () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('haz-001', 'Haz', '$2y$10$x', 'admin')`).run();
    const principal = resolvePrincipal(db, { id: 'admin-000', username: 'admin', role: 'admin' });
    expect(principal).toBeNull();
  });

  it('fails closed (null) when the subject no longer exists', () => {
    const principal = resolvePrincipal(db, { id: 'deleted-user', role: 'admin' });
    expect(principal).toBeNull();
  });

  it('fails closed (null) on an empty payload', () => {
    expect(resolvePrincipal(db, null)).toBeNull();
    expect(resolvePrincipal(db, {})).toBeNull();
  });

  it('keeps the stored role for a plain user too', () => {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'u1', '$2y$10$x', 'user')`).run();
    expect(resolvePrincipal(db, { id: 'u1', role: 'admin' })).toEqual({ id: 'u1', role: 'user' });
  });
});