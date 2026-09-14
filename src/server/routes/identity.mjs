/**
 * Cardinal Frame — Identity & Avatar API Routes
 *
 * The avatar system, modeled on Muse's: one face for the companion
 * (avatar image + name + character/vibe), with per-persona avatar
 * candidates and per-persona voice casting. Aimi is the default face —
 * "one face, many hands."
 *
 * Flow: stage a candidate (upload or URL) → user explicitly activates it →
 * the previous active candidate for that persona is archived. The machine
 * never re-faces itself unprompted: activation endpoints require an
 * explicit admin pick.
 *
 * Dependencies (via ctx): db, stmts, authMiddleware, requireRole,
 *   apiLimiter, logger, broadcast, DATA_DIR
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { PERSONAS, getActivePersonaId, setActivePersonaId } from '../personas.mjs';

export default function identityRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast, DATA_DIR } = ctx;
  const router = express.Router();

  const AVATARS_DIR = path.join(path.resolve(DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data')), 'avatars');
  mkdirSync(AVATARS_DIR, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, AVATARS_DIR),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.png';
        cb(null, `avatar-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (/^image\//.test(file.mimetype)) cb(null, true);
      else cb(new Error('Only image uploads are accepted for avatars'));
    },
  });

  function validPersona(id) {
    return id && PERSONAS[id] ? id : null;
  }

  function getIdentity() {
    let row = null;
    try { row = stmts.identity.getSingleton.get() || null; } catch {}
    return row || { id: 'singleton', name: 'Aimi', character: 'AI companion', vibe: 'sharp, warm, tech-infused', color_language: '{}', style_anchors: '[]', avatar_master_ref: null, voice_profile: '{}' };
  }

  function personaView(personaId) {
    const def = PERSONAS[personaId];
    if (!def) return null;
    let avatar = null;
    let voice = null;
    try { avatar = stmts.avatarCandidates.getActive.get(personaId) || null; } catch {}
    try { voice = stmts.personaVoices.get.get(personaId) || null; } catch {}
    return {
      id: def.id,
      name: def.name,
      tagline: def.tagline,
      color: def.color,
      avatar: avatar ? { id: avatar.id, label: avatar.label, image_ref: avatar.image_ref, status: avatar.status } : null,
      voice: voice ? { provider: voice.provider, voice_id: voice.voice_id, voice_label: voice.voice_label } : null,
    };
  }

  // ─── Identity singleton ──────────────────────────────────────────

  // GET /api/identity — the companion's face: name, character, vibe,
  // active persona (Aimi by default) with its avatar + voice.
  router.get('/identity', authMiddleware, (req, res) => {
    try {
      const identity = getIdentity();
      const activePersonaId = getActivePersonaId(db);
      res.json({
        ...identity,
        active_persona: personaView(activePersonaId),
        personas: Object.keys(PERSONAS).map(personaView),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/identity — rename / re-characterize the companion (admin).
  // Muse pattern: editing the name renames the assistant.
  router.put('/identity', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const cur = getIdentity();
      const { name, character, vibe, color_language, style_anchors } = req.body || {};
      const next = {
        name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : cur.name,
        character: typeof character === 'string' ? character.slice(0, 200) : cur.character,
        vibe: typeof vibe === 'string' ? vibe.slice(0, 200) : cur.vibe,
        color_language: typeof color_language === 'string' ? color_language.slice(0, 2000) : cur.color_language,
        style_anchors: typeof style_anchors === 'string' ? style_anchors.slice(0, 2000) : cur.style_anchors,
      };
      stmts.identity.upsert.run(next.name, next.character, next.vibe, next.color_language, next.style_anchors, cur.avatar_master_ref || null);
      broadcast('identity:updated', { name: next.name, character: next.character, vibe: next.vibe });
      logger.info(`Companion identity updated by ${req.user.id}: name="${next.name}"`);
      res.json({ ok: true, identity: getIdentity() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/identity/active-persona — switch the face's persona (admin).
  router.put('/identity/active-persona', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const { persona_id } = req.body || {};
      const id = validPersona(persona_id);
      if (!id) return res.status(400).json({ error: 'Unknown persona' });
      setActivePersonaId(db, id);
      // The master avatar follows the active persona.
      const avatar = stmts.avatarCandidates.getActive.get(id);
      if (avatar && avatar.image_ref) stmts.identity.setAvatarMaster.run(avatar.image_ref);
      broadcast('identity:persona_changed', { persona_id: id });
      logger.info(`Active companion persona set to ${id} by ${req.user.id}`);
      res.json({ ok: true, active_persona: personaView(id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Avatar candidates ───────────────────────────────────────────

  // GET /api/identity/avatars?persona_id=aimi — list candidates.
  router.get('/identity/avatars', authMiddleware, (req, res) => {
    try {
      const personaId = validPersona(req.query.persona_id) || 'aimi';
      res.json({ persona_id: personaId, candidates: stmts.avatarCandidates.getByPersona.all(personaId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/identity/avatars — stage a candidate (admin). Multipart
  // `image` upload, or JSON { image_url }. Starts as 'staged'.
  router.post('/identity/avatars', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    upload.single('image')(req, res, (err) => {
      try {
        if (err) return res.status(400).json({ error: err.message });
        const personaId = validPersona(req.body.persona_id) || 'aimi';
        const label = String(req.body.label || '').slice(0, 120);
        const prompt = String(req.body.prompt || '').slice(0, 2000);
        let imageRef = null;
        if (req.file) {
          imageRef = `/media/avatars/${req.file.filename}`;
        } else if (req.body.image_url && /^https?:\/\//.test(req.body.image_url)) {
          imageRef = String(req.body.image_url).slice(0, 2000);
        }
        if (!imageRef) return res.status(400).json({ error: 'image upload or image_url required' });
        const id = randomUUID();
        stmts.avatarCandidates.insert.run(id, personaId, label, prompt, '', imageRef, 'staged');
        logger.info(`Avatar candidate staged for ${personaId} by ${req.user.id}: ${id}`);
        res.status(201).json({ ok: true, candidate: stmts.avatarCandidates.getById.get(id) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  });

  // POST /api/identity/avatars/:id/activate — explicit user pick (admin).
  // Archives the persona's current active candidate first.
  router.post('/identity/avatars/:id/activate', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const c = stmts.avatarCandidates.getById.get(req.params.id);
      if (!c) return res.status(404).json({ error: 'Candidate not found' });
      stmts.avatarCandidates.archiveActive.run(c.persona_id);
      stmts.avatarCandidates.setStatus.run('active', 'active', c.id);
      // If this persona is the active face, the master avatar follows.
      if (getActivePersonaId(db) === c.persona_id && c.image_ref) {
        stmts.identity.setAvatarMaster.run(c.image_ref);
      }
      broadcast('identity:avatar_changed', { persona_id: c.persona_id, candidate_id: c.id, image_ref: c.image_ref });
      logger.info(`Avatar candidate ${c.id} activated for ${c.persona_id} by ${req.user.id}`);
      res.json({ ok: true, candidate: stmts.avatarCandidates.getById.get(c.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/identity/avatars/:id/archive — (admin).
  router.post('/identity/avatars/:id/archive', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const c = stmts.avatarCandidates.getById.get(req.params.id);
      if (!c) return res.status(404).json({ error: 'Candidate not found' });
      stmts.avatarCandidates.setStatus.run('archived', 'archived', c.id);
      res.json({ ok: true, candidate: stmts.avatarCandidates.getById.get(c.id) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/identity/avatars/:id — (admin).
  router.delete('/identity/avatars/:id', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const c = stmts.avatarCandidates.getById.get(req.params.id);
      if (!c) return res.status(404).json({ error: 'Candidate not found' });
      if (c.status === 'active') return res.status(400).json({ error: 'Cannot delete the active avatar — archive it by activating another first' });
      stmts.avatarCandidates.delete.run(c.id);
      res.json({ ok: true, deleted: c.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Voice casting ───────────────────────────────────────────────

  // GET /api/identity/voices — per-persona voice casting.
  router.get('/identity/voices', authMiddleware, (req, res) => {
    try {
      const rows = stmts.personaVoices.getAll.all();
      const byId = Object.fromEntries(rows.map(r => [r.persona_id, { provider: r.provider, voice_id: r.voice_id, voice_label: r.voice_label }]));
      res.json({ voices: byId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT /api/identity/voices/:persona_id — cast a voice (admin).
  // The casting record stores provider + voice id; it doesn't pick them.
  // Household rule: voices stay masculine-presenting.
  router.put('/identity/voices/:persona_id', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const personaId = validPersona(req.params.persona_id);
      if (!personaId) return res.status(400).json({ error: 'Unknown persona' });
      const { provider, voice_id, voice_label } = req.body || {};
      stmts.personaVoices.upsert.run(
        personaId,
        String(provider || 'local').slice(0, 40),
        String(voice_id || '').slice(0, 200),
        String(voice_label || '').slice(0, 120)
      );
      broadcast('identity:voice_changed', { persona_id: personaId });
      logger.info(`Voice cast for ${personaId} by ${req.user.id}: ${provider}/${voice_id}`);
      res.json({ ok: true, voice: stmts.personaVoices.get.get(personaId) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/identity/voices/:persona_id — clear casting (admin).
  router.delete('/identity/voices/:persona_id', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const personaId = validPersona(req.params.persona_id);
      if (!personaId) return res.status(400).json({ error: 'Unknown persona' });
      stmts.personaVoices.delete.run(personaId);
      res.json({ ok: true, cleared: personaId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
