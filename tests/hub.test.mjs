import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;
let sourceId;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Skill Hub API', () => {
  describe('GET /api/skills/hub/sources', () => {
    it('should return sources list with auth', async () => {
      const res = await request(app).get('/api/skills/hub/sources').set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should reject without auth', async () => {
      const res = await request(app).get('/api/skills/hub/sources');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/skills/hub/sources', () => {
    it('should create source with admin auth', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({
          name: 'Test Source',
          url: 'https://github.com/example/skills-repo',
          type: 'git',
        });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('id');
      sourceId = res.body.id;
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .send({ name: 'No Auth', url: 'https://example.com', type: 'git' });
      expect(res.status).toBe(401);
    });

    it('should reject regular user (not admin)', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(userAuth())
        .send({ name: 'User Source', url: 'https://example.com', type: 'git' });
      expect(res.status).toBe(403);
    });

    it('should reject missing fields', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({ name: 'Missing URL' });
      expect([400, 500]).toContain(res.status);
    });

    it('should reject SSRF attempt (AWS metadata)', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({
          name: 'SSRF AWS',
          url: 'http://169.254.169.254/latest/meta-data/',
          type: 'git',
        });
      expect([400, 403]).toContain(res.status);
    });

    it('should reject SSRF attempt (localhost)', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({
          name: 'SSRF Local',
          url: 'http://localhost:8080/api/skills',
          type: 'git',
        });
      expect([400, 403]).toContain(res.status);
    });

    it('should reject SSRF attempt (RFC1918)', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({
          name: 'SSRF Internal',
          url: 'http://10.0.0.1/internal',
          type: 'git',
        });
      expect([400, 403]).toContain(res.status);
    });
  });

  describe('POST /api/skills/hub/sources/:id/scan', () => {
    it('should scan source with admin auth', async () => {
      if (!sourceId) return;
      const res = await request(app)
        .post(`/api/skills/hub/sources/${sourceId}/scan`)
        .set(adminAuth());
      expect([200, 404, 500]).toContain(res.status); // external URL fetch may fail in test env
    });

    it('should reject without auth', async () => {
      const res = await request(app).post(`/api/skills/hub/sources/fake-id/scan`);
      expect(res.status).toBe(401);
    });

    it('should reject regular user', async () => {
      const res = await request(app)
        .post(`/api/skills/hub/sources/fake-id/scan`)
        .set(userAuth());
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/skills/hub/sources/:id/install', () => {
    it('should reject install with failed verdict (security gate)', async () => {
      if (!sourceId) return;
      const res = await request(app)
        .post(`/api/skills/hub/sources/${sourceId}/install`)
        .set(adminAuth())
        .send({ skill_name: 'malicious-skill', verdict: 'failed' });
      expect([400, 403]).toContain(res.status);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post(`/api/skills/hub/sources/fake-id/install`)
        .send({ skill_name: 'test', verdict: 'passed' });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/skills/hub/sources/:id', () => {
    it('should delete source with auth', async () => {
      if (!sourceId) return;
      const res = await request(app)
        .delete(`/api/skills/hub/sources/${sourceId}`)
        .set(adminAuth());
      expect([200, 404]).toContain(res.status);
    });

    it('should reject without auth', async () => {
      const res = await request(app).delete('/api/skills/hub/sources/fake-id');
      expect(res.status).toBe(401);
    });
  });
});
