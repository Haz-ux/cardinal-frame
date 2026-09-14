/**
 * Cardinal Frame — Identity — Singleton Companion Record
 *
 * One server-managed identity, shared across all clients. Carries the name,
 * character anchor, vibe, color language, style anchors, the active avatar
 * reference, and the voice profile.
 *
 * Kept strictly separate from src/server/node-identity.mjs: cryptographic
 * node identity is not persona identity, and the two must never merge.
 *
 * Dependencies: migrations/017_identity.sql (companion_identity table),
 * migrations/001.sql (users table, for resolvePrincipal).
 */

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Strip U+2028/U+2029 line separators (JSON line-terminator hardening).
 */
function stripLineSeparators(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\u2028|\u2029/g, ' ');
}

export const IDENTITY_DEFAULTS = Object.freeze({
  name: 'Aimi',
  character: 'AI companion',
  vibe: 'sharp, warm, tech-infused',
  color_language: '{}',
  style_anchors: '[]',
  avatar_master_ref: null,
  voice_profile: '{}',
});

/** Fields that may be updated via updateIdentity. */
const UPDATABLE_FIELDS = ['name', 'character', 'vibe', 'color_language', 'style_anchors', 'avatar_master_ref', 'voice_profile'];

/** Bounded string lengths for sanitised fields. */
const MAX_LENGTHS = {
  name: 80,
  character: 200,
  vibe: 200,
  color_language: 2000,
  style_anchors: 2000,
  avatar_master_ref: 2000,
  voice_profile: 2000,
};

// ─── Prepared statements (per-db cache) ─────────────────────────────────────

const _stmtCache = new WeakMap();
function stmts(db) {
  let cached = _stmtCache.get(db);
  if (cached) return cached;
  cached = {
    getSingleton: db.prepare(`SELECT * FROM companion_identity WHERE id = 'singleton'`),
    upsert: db.prepare(`
      INSERT INTO companion_identity (id, name, character, vibe, color_language, style_anchors, avatar_master_ref, voice_profile)
      VALUES ('singleton', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, character = excluded.character, vibe = excluded.vibe,
        color_language = excluded.color_language, style_anchors = excluded.style_anchors,
        avatar_master_ref = excluded.avatar_master_ref, voice_profile = excluded.voice_profile,
        updated_at = datetime('now')
    `),
    setAvatarMaster: db.prepare(`UPDATE companion_identity SET avatar_master_ref = ?, updated_at = datetime('now') WHERE id = 'singleton'`),
  };
  _stmtCache.set(db, cached);
  return cached;
}

// Principal resolution only needs the users table — kept separate so it
// works against any DB (no dependency on the identity singleton schema).
const _principalCache = new WeakMap();
function principalStmts(db) {
  let cached = _principalCache.get(db);
  if (cached) return cached;
  cached = {
    getUserById: db.prepare(`SELECT id, role FROM users WHERE id = ?`),
  };
  _principalCache.set(db, cached);
  return cached;
}

// ─── Domain functions ───────────────────────────────────────────────────────

/**
 * Retrieve the companion identity singleton. Returns the stored row merged
 * with IDENTITY_DEFAULTS so callers always get a complete object.
 * @param {import('better-sqlite3').Database} db
 * @returns {object} identity singleton
 */
export function getIdentity(db) {
  const s = stmts(db);
  const row = s.getSingleton.get() || {};
  return { ...IDENTITY_DEFAULTS, ...row, id: 'singleton' };
}

/**
 * Partial update of the companion identity. Only whitelisted scalar
 * string fields are accepted; unrecognised fields are silently ignored.
 * All values are bounded, trimmed (where appropriate), and line-terminators
 * stripped to match the existing route contract.
 * @param {import('better-sqlite3').Database} db
 * @param {object} patch  partial identity fields
 * @returns {object} the updated identity
 */
export function updateIdentity(db, patch) {
  if (!patch || typeof patch !== 'object') return getIdentity(db);
  const s = stmts(db);
  const cur = getIdentity(db);

  const next = {};
  for (const field of UPDATABLE_FIELDS) {
    const raw = patch[field];
    if (raw === undefined) { next[field] = cur[field]; continue; }
    if (raw === null) { next[field] = null; continue; }
    if (typeof raw !== 'string') { next[field] = cur[field]; continue; }
    const trimmed = field === 'name' ? raw.trim() : raw;
    if (field === 'name' && !trimmed) { next[field] = cur[field]; continue; }
    const max = MAX_LENGTHS[field] || 2000;
    next[field] = stripLineSeparators(trimmed).slice(0, max);
  }

  s.upsert.run(
    next.name, next.character, next.vibe,
    next.color_language, next.style_anchors,
    next.avatar_master_ref, next.voice_profile,
  );
  return getIdentity(db);
}

/**
 * Reset the companion identity to defaults (clears all fields).
 * @param {import('better-sqlite3').Database} db
 * @returns {object} the identity with default values
 */
export function resetToDefault(db) {
  const s = stmts(db);
  s.upsert.run(
    IDENTITY_DEFAULTS.name,
    IDENTITY_DEFAULTS.character,
    IDENTITY_DEFAULTS.vibe,
    IDENTITY_DEFAULTS.color_language,
    IDENTITY_DEFAULTS.style_anchors,
    IDENTITY_DEFAULTS.avatar_master_ref,
    IDENTITY_DEFAULTS.voice_profile,
  );
  return getIdentity(db);
}

/**
 * Resolve the canonical principal for a decoded JWT token by re-reading the
 * users table. This grounds authorization in the actual DB identity rather
 * than trusting the token's role claim — satisfying P1.10's requirement
 * that authorization is based on actual identity, not a client-supplied
 * identifier.
 *
 * Returns { id, role } from the DB if the user exists, or null if the
 * user has been deleted (fail closed).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, role?: string, username?: string }} tokenUser  decoded JWT payload
 * @returns {{ id: string, role: string } | null}
 */
export function resolvePrincipal(db, tokenUser) {
  if (!tokenUser || !tokenUser.id) return null;
  const user = principalStmts(db).getUserById.get(tokenUser.id);
  if (!user) return null;
  return { id: user.id, role: user.role };
}
