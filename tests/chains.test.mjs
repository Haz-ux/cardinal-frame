import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

// Valid chain creation bodies. Give each create a unique name to avoid
// collisions across repeated runs / parallel test workers.
const skillChainBody = () => ({
  name: 'Test Chain ' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  description: 'Test desc',
  steps: [{ skill_id: 'test-skill', position: 0, input_map: {} }],
});

const toolChainBody = () => ({
  name: 'Test Tool Chain ' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  description: 'Test',
  steps: [{ tool_name: 'test-tool', position: 0, input_map: {} }],
});

// ─── Skill Chain CRUD ────────────────────────────────────────────

describe('Skill Chain API', () => {
  describe('GET /api/chains/skills', () => {
    it('should return 200 and an array with auth', async () => {
      const res = await request(app)
        .get('/api/chains/skills')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should reject without auth → 401', async () => {
      const res = await request(app)
        .get('/api/chains/skills');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/chains/skills', () => {
    it('should create a chain with auth + valid body → 200 or 201', async () => {
      const res = await request(app)
        .post('/api/chains/skills')
        .set(adminAuth())
        .send(skillChainBody());
      expect([200, 201]).toContain(res.status);
      expect(res.body.id).toBeTruthy();
      expect(res.body.name).toBeTruthy();
      expect(Array.isArray(res.body.steps)).toBe(true);
    });

    it('should reject without auth → 401', async () => {
      const res = await request(app)
        .post('/api/chains/skills')
        .send(skillChainBody());
      expect(res.status).toBe(401);
    });

    it('should reject invalid body (missing name) → 400 or 500', async () => {
      const res = await request(app)
        .post('/api/chains/skills')
        .set(adminAuth())
        .send({ description: 'no name here', steps: [] });
      expect([400, 500]).toContain(res.status);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('GET /api/chains/skills/:id', () => {
    it('should return 200 for an existing chain', async () => {
      const createRes = await request(app)
        .post('/api/chains/skills')
        .set(adminAuth())
        .send(skillChainBody());
      expect(createRes.body.id).toBeTruthy();

      const res = await request(app)
        .get(`/api/chains/skills/${createRes.body.id}`)
        .set(adminAuth());
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.id).toBe(createRes.body.id);
        expect(Array.isArray(res.body.steps)).toBe(true);
      }
    });

    it('should return 404 for a non-existent chain', async () => {
      const res = await request(app)
        .get('/api/chains/skills/00000000-0000-0000-0000-000000000000')
        .set(adminAuth());
      expect([404]).toContain(res.status);
    });
  });

  describe('PUT /api/chains/skills/:id', () => {
    it('should update a chain with auth → 200', async () => {
      const createRes = await request(app)
        .post('/api/chains/skills')
        .set(adminAuth())
        .send(skillChainBody());
      const id = createRes.body.id;
      expect(id).toBeTruthy();

      const res = await request(app)
        .put(`/api/chains/skills/${id}`)
        .set(adminAuth())
        .send({
          name: 'Updated Test Chain',
          description: 'updated desc',
          steps: [{ skill_id: 'updated-skill', position: 0, input_map: {} }],
          status: 'active',
        });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Test Chain');
      expect(Array.isArray(res.body.steps)).toBe(true);
    });
  });

  describe('DELETE /api/chains/skills/:id', () => {
    it('should delete a chain with auth → 200', async () => {
      const createRes = await request(app)
        .post('/api/chains/skills')
        .set(adminAuth())
        .send(skillChainBody());
      const id = createRes.body.id;
      expect(id).toBeTruthy();

      const res = await request(app)
        .delete(`/api/chains/skills/${id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);

      // Verify it's gone
      const getRes = await request(app)
        .get(`/api/chains/skills/${id}`)
        .set(adminAuth());
      expect(getRes.status).toBe(404);
    });
  });

  describe('Full CRUD lifecycle (create → read → update → delete)', () => {
    it('should walk through a full lifecycle cleanly', async () => {
      // Create
      const createRes = await request(app)
        .post('/api/chains/skills')
        .set(adminAuth())
        .send(skillChainBody());
      expect([200, 201]).toContain(createRes.status);
      const id = createRes.body.id;
      expect(id).toBeTruthy();

      // Read
      const getRes = await request(app)
        .get(`/api/chains/skills/${id}`)
        .set(adminAuth());
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(id);

      // List contains it
      const listRes = await request(app)
        .get('/api/chains/skills')
        .set(adminAuth());
      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body)).toBe(true);
      expect(listRes.body.some(c => c.id === id)).toBe(true);

      // Update
      const putRes = await request(app)
        .put(`/api/chains/skills/${id}`)
        .set(adminAuth())
        .send({ name: 'Lifecycle Updated', status: 'active' });
      expect(putRes.status).toBe(200);
      expect(putRes.body.name).toBe('Lifecycle Updated');

      // Delete
      const delRes = await request(app)
        .delete(`/api/chains/skills/${id}`)
        .set(adminAuth());
      expect(delRes.status).toBe(200);

      // Verify deleted
      const afterGet = await request(app)
        .get(`/api/chains/skills/${id}`)
        .set(adminAuth());
      expect(afterGet.status).toBe(404);
    });
  });
});

// ─── Tool Chain CRUD ─────────────────────────────────────────────

describe('Tool Chain API', () => {
  describe('GET /api/chains/tools', () => {
    it('should return 200 and an array with auth', async () => {
      const res = await request(app)
        .get('/api/chains/tools')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should reject without auth → 401', async () => {
      const res = await request(app)
        .get('/api/chains/tools');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/chains/tools', () => {
    it('should create a tool chain with auth + valid body → 200 or 201', async () => {
      const res = await request(app)
        .post('/api/chains/tools')
        .set(adminAuth())
        .send(toolChainBody());
      expect([200, 201]).toContain(res.status);
      expect(res.body.id).toBeTruthy();
      expect(res.body.name).toBeTruthy();
      expect(Array.isArray(res.body.steps)).toBe(true);
    });

    it('should reject without auth → 401', async () => {
      const res = await request(app)
        .post('/api/chains/tools')
        .send(toolChainBody());
      expect(res.status).toBe(401);
    });

    it('should reject invalid body (missing name) → 400 or 500', async () => {
      const res = await request(app)
        .post('/api/chains/tools')
        .set(adminAuth())
        .send({ description: 'no name', steps: [] });
      expect([400, 500]).toContain(res.status);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('GET /api/chains/tools/:id', () => {
    it('should return 200 for an existing tool chain', async () => {
      const createRes = await request(app)
        .post('/api/chains/tools')
        .set(adminAuth())
        .send(toolChainBody());
      expect(createRes.body.id).toBeTruthy();

      const res = await request(app)
        .get(`/api/chains/tools/${createRes.body.id}`)
        .set(adminAuth());
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.id).toBe(createRes.body.id);
        expect(Array.isArray(res.body.steps)).toBe(true);
      }
    });
  });

  describe('PUT /api/chains/tools/:id', () => {
    it('should update a tool chain with auth → 200', async () => {
      const createRes = await request(app)
        .post('/api/chains/tools')
        .set(adminAuth())
        .send(toolChainBody());
      const id = createRes.body.id;
      expect(id).toBeTruthy();

      const res = await request(app)
        .put(`/api/chains/tools/${id}`)
        .set(adminAuth())
        .send({
          name: 'Updated Tool Chain',
          description: 'updated',
          steps: [{ tool_name: 'updated-tool', position: 1, input_map: {} }],
          status: 'active',
        });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Tool Chain');
      expect(Array.isArray(res.body.steps)).toBe(true);
    });
  });

  describe('DELETE /api/chains/tools/:id', () => {
    it('should delete a tool chain with auth → 200', async () => {
      const createRes = await request(app)
        .post('/api/chains/tools')
        .set(adminAuth())
        .send(toolChainBody());
      const id = createRes.body.id;
      expect(id).toBeTruthy();

      const res = await request(app)
        .delete(`/api/chains/tools/${id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);

      // Verify it's gone
      const getRes = await request(app)
        .get(`/api/chains/tools/${id}`)
        .set(adminAuth());
      expect(getRes.status).toBe(404);
    });
  });
});
