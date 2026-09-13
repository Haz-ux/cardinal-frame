import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;
let db;

beforeAll(async () => {
  ({ app, db } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Identity & Avatar system (Aimi as the face)', () => {
  it('GET /api/identity returns the singleton with Aimi as the default face', async () => {
    const res = await request(app).get('/api/identity').set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Aimi');
    expect(res.body.active_persona).toBeTruthy();
    expect(res.body.active_persona.id).toBe('aimi');
    expect(res.body.personas.map(p => p.id).sort()).toEqual(['aimi', 'cipher', 'ghost']);
  });

  it('PUT /api/identity renames the companion (admin only)', async () => {
    const res = await request(app)
      .put('/api/identity')
      .set(adminAuth())
      .send({ name: 'Aimi Prime', vibe: 'test vibe' });
    expect(res.status).toBe(200);
    expect(res.body.identity.name).toBe('Aimi Prime');

    const forbidden = await request(app)
      .put('/api/identity')
      .set(userAuth())
      .send({ name: 'Hacker' });
    expect(forbidden.status).toBe(403);

    // restore
    await request(app).put('/api/identity').set(adminAuth()).send({ name: 'Aimi' });
  });

  it('avatar stage → activate → archive flow', async () => {
    // Stage a candidate via URL (no file needed)
    const stage = await request(app)
      .post('/api/identity/avatars')
      .set(adminAuth())
      .send({ persona_id: 'aimi', label: 'test avatar', image_url: 'https://example.com/aimi.png' });
    expect(stage.status).toBe(201);
    expect(stage.body.candidate.status).toBe('staged');
    const id = stage.body.candidate.id;

    // Activate — explicit user pick
    const activate = await request(app)
      .post(`/api/identity/avatars/${id}/activate`)
      .set(adminAuth());
    expect(activate.status).toBe(200);
    expect(activate.body.candidate.status).toBe('active');

    // The face now shows the avatar
    const ident = await request(app).get('/api/identity').set(adminAuth());
    expect(ident.body.active_persona.avatar.image_ref).toBe('https://example.com/aimi.png');

    // Staging + activating a second one archives the first
    const stage2 = await request(app)
      .post('/api/identity/avatars')
      .set(adminAuth())
      .send({ persona_id: 'aimi', label: 'v2', image_url: 'https://example.com/aimi2.png' });
    await request(app).post(`/api/identity/avatars/${stage2.body.candidate.id}/activate`).set(adminAuth());
    const first = db.prepare('SELECT status FROM avatar_candidates WHERE id = ?').get(id);
    expect(first.status).toBe('archived');

    // Cannot delete the active avatar
    const delActive = await request(app)
      .delete(`/api/identity/avatars/${stage2.body.candidate.id}`)
      .set(adminAuth());
    expect(delActive.status).toBe(400);

    // Archived one can be deleted
    const del = await request(app).delete(`/api/identity/avatars/${id}`).set(adminAuth());
    expect(del.status).toBe(200);
  });

  it('voice casting is per-persona (admin write, any-auth read)', async () => {
    const put = await request(app)
      .put('/api/identity/voices/aimi')
      .set(adminAuth())
      .send({ provider: 'local', voice_id: 'masc-1', voice_label: 'Aimi voice' });
    expect(put.status).toBe(200);
    expect(put.body.voice.voice_id).toBe('masc-1');

    const get = await request(app).get('/api/identity/voices').set(userAuth());
    expect(get.status).toBe(200);
    expect(get.body.voices.aimi.voice_label).toBe('Aimi voice');

    const bad = await request(app)
      .put('/api/identity/voices/nonexistent')
      .set(adminAuth())
      .send({ voice_id: 'x' });
    expect(bad.status).toBe(400);

    const del = await request(app).delete('/api/identity/voices/aimi').set(adminAuth());
    expect(del.status).toBe(200);
  });

  it('non-admin cannot stage avatars or cast voices', async () => {
    const stage = await request(app)
      .post('/api/identity/avatars')
      .set(userAuth())
      .send({ image_url: 'https://example.com/x.png' });
    expect(stage.status).toBe(403);

    const voice = await request(app)
      .put('/api/identity/voices/ghost')
      .set(userAuth())
      .send({ voice_id: 'x' });
    expect(voice.status).toBe(403);
  });
});
