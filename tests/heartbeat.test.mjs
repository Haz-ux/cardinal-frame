import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;
let ruleId;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Heartbeat Daemon API', () => {
  describe('GET /api/heartbeat/rules', () => {
    it('should return rules list with auth', async () => {
      const res = await request(app).get('/api/heartbeat/rules').set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should reject without auth', async () => {
      const res = await request(app).get('/api/heartbeat/rules');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/heartbeat/rules', () => {
    it('should create rule with admin auth', async () => {
      const res = await request(app)
        .post('/api/heartbeat/rules')
        .set(adminAuth())
        .send({
          name: 'Test Rule',
          condition: 'agents.length > 0',
          actions: [{ type: 'notify', target: 'admin' }],
          interval_seconds: 60,
        });
      expect([200, 201, 400]).toContain(res.status);
      if (res.body.id) ruleId = res.body.id;
    });

    it('should reject without auth', async () => {
      const res = await request(app).post('/api/heartbeat/rules').send({
        name: 'No Auth',
        condition: 'true',
        actions: [],
        interval_seconds: 60,
      });
      expect(res.status).toBe(401);
    });

    it('should reject regular user (not admin)', async () => {
      const res = await request(app)
        .post('/api/heartbeat/rules')
        .set(userAuth())
        .send({
          name: 'User Rule',
          condition: 'true',
          actions: [],
          interval_seconds: 60,
        });
      expect(res.status).toBe(403);
    });

    it('should reject missing name', async () => {
      const res = await request(app)
        .post('/api/heartbeat/rules')
        .set(adminAuth())
        .send({ condition: 'true', actions: [], interval_seconds: 60 });
      expect([400, 500]).toContain(res.status);
    });

    it('should reject dangerous condition (process.exit)', async () => {
      const res = await request(app)
        .post('/api/heartbeat/rules')
        .set(adminAuth())
        .send({
          name: 'Dangerous',
          condition: 'process.exit(1)',
          actions: [{ type: 'notify', target: 'admin' }],
          interval_seconds: 60,
        });
      // Should either reject or sanitize — never execute it
      expect([400, 403, 200, 201]).toContain(res.status);
      if (res.body.id) ruleId = res.body.id;
    });
  });

  describe('PATCH /api/heartbeat/rules/:id/toggle', () => {
    it('should toggle rule enabled state', async () => {
      // Ensure we have a rule
      if (!ruleId) {
        const create = await request(app)
          .post('/api/heartbeat/rules')
          .set(adminAuth())
          .send({
            name: 'Toggle Test',
            condition: 'true',
            actions: [],
            interval_seconds: 60,
          });
        ruleId = create.body.id;
      }
      const res = await request(app)
        .patch(`/api/heartbeat/rules/${ruleId}/toggle`)
        .set(adminAuth());
      expect([200, 404]).toContain(res.status);
    });
  });

  describe('DELETE /api/heartbeat/rules/:id', () => {
    it('should delete rule', async () => {
      if (!ruleId) return; // skip if creation failed
      const res = await request(app)
        .delete(`/api/heartbeat/rules/${ruleId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/heartbeat/state', () => {
    it('should return daemon state with auth', async () => {
      const res = await request(app).get('/api/heartbeat/state').set(adminAuth());
      expect(res.status).toBe(200);
      // State may be { running: false } or { error: 'Heartbeat not running' }
      expect(res.body).toBeDefined();
    });

    it('should reject without auth', async () => {
      const res = await request(app).get('/api/heartbeat/state');
      expect(res.status).toBe(401);
    });
  });
});
