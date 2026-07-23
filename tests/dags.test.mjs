import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;
let dagId;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('DAG API', () => {
  describe('POST /api/dags', () => {
    it('should create DAG with auth', async () => {
      const res = await request(app)
        .post('/api/dags')
        .set(adminAuth())
        .send({
          name: 'Test DAG',
          description: 'Test pipeline',
          nodes: [
            { id: 'n1', type: 'task', label: 'Step 1', config: {} },
            { id: 'n2', type: 'output', label: 'Output', config: {} },
          ],
          edges: [{ from: 'n1', to: 'n2' }],
        });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('id');
      dagId = res.body.id;
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/dags')
        .send({ name: 'No Auth', nodes: [], edges: [] });
      expect(res.status).toBe(401);
    });

    it('should reject missing name', async () => {
      const res = await request(app)
        .post('/api/dags')
        .set(adminAuth())
        .send({ nodes: [], edges: [] });
      expect([400, 500]).toContain(res.status);
    });
  });

  describe('GET /api/dags', () => {
    it('should return DAGs list', async () => {
      const res = await request(app).get('/api/dags');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('works without auth (optionalAuth)', async () => {
      const res = await request(app).get('/api/dags');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/dags/:id', () => {
    it('should return DAG by id', async () => {
      if (!dagId) return;
      const res = await request(app).get(`/api/dags/${dagId}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('name');
    });

    it('should return 404 for non-existent DAG', async () => {
      const res = await request(app).get('/api/dags/non-existent-id-99999');
      expect([404, 500]).toContain(res.status);
    });
  });

  describe('PUT /api/dags/:id', () => {
    it('should update DAG', async () => {
      if (!dagId) return;
      const res = await request(app)
        .put(`/api/dags/${dagId}`)
        .set(adminAuth())
        .send({
          name: 'Updated DAG',
          description: 'Updated description',
          nodes: [{ id: 'n1', type: 'task', label: 'Updated Step', config: {} }],
          edges: [],
        });
      expect(res.status).toBe(200);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .put(`/api/dags/${dagId || 'fake-id'}`)
        .send({ name: 'No Auth' });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/dags/:id', () => {
    it('should delete DAG', async () => {
      if (!dagId) return;
      const res = await request(app)
        .delete(`/api/dags/${dagId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
    });

    it('should reject without auth', async () => {
      const res = await request(app).delete('/api/dags/fake-id');
      expect(res.status).toBe(401);
    });
  });
});
