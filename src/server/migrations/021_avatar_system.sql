-- 021_avatar_system.sql
-- Work Aimi into the avatar system (Muse pattern: avatar image + name +
-- a voice per persona, one face for the companion).
--
-- Extends 017_identity: avatar candidates gain a persona link and a real
-- image reference (uploaded file served from /media/avatars or an absolute
-- URL). Voice casting moves from the singleton JSON blob to a per-persona
-- table so Aimi, Cipher, and Ghost can each be cast a distinct voice.
-- Activation is always an explicit user pick — the machine never
-- re-faces itself unprompted.

ALTER TABLE avatar_candidates ADD COLUMN persona_id TEXT NOT NULL DEFAULT 'aimi';
ALTER TABLE avatar_candidates ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE avatar_candidates ADD COLUMN image_ref TEXT;

CREATE INDEX IF NOT EXISTS idx_avatar_candidates_persona ON avatar_candidates(persona_id);

CREATE TABLE IF NOT EXISTS persona_voices (
  persona_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'local',
  voice_id TEXT NOT NULL DEFAULT '',
  voice_label TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Seed the singleton: the one face is Aimi. Never overwrites an existing row.
INSERT INTO companion_identity (id, name, character, vibe)
SELECT 'singleton', 'Aimi', 'AI companion', 'sharp, warm, tech-infused'
WHERE NOT EXISTS (SELECT 1 FROM companion_identity WHERE id = 'singleton');
