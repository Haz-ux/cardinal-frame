import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;
let db;
let dagId;

beforeAll(async () => {
  ({ app, db } = await getTestServer());
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

  // ─── DAG Run Endpoint ───────────────────────────────────────────
  describe('POST /api/dags/:id/run', () => {
    let runnableDagId;
    let cyclicDagId;
    let emptyDagId;

    // Helper: poll DAG status from DB until it reaches a terminal state
    async function waitForDagStatus(id, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const row = db.prepare('SELECT status, last_run_result FROM dags WHERE id = ?').get(id);
        if (row && (row.status === 'completed' || row.status === 'failed')) return row;
        await new Promise(r => setTimeout(r, 200));
      }
      return db.prepare('SELECT status, last_run_result FROM dags WHERE id = ?').get(id);
    }

    it('should 404 for non-existent DAG', async () => {
      const res = await request(app)
        .post('/api/dags/non-existent-dag-99999/run')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/dags/fake-id/run');
      expect(res.status).toBe(401);
    });

    it('should run a simple DAG and transition to completed', async () => {
      // Create a DAG with executable nodes (edges use source/target for topoSortLayers)
      const createRes = await request(app)
        .post('/api/dags')
        .set(adminAuth())
        .send({
          name: 'Runnable DAG',
          nodes: [
            { id: 'n1', name: 'Echo Step', command: 'echo hello' },
            { id: 'n2', name: 'Echo Step 2', command: 'echo world' },
          ],
          edges: [{ source: 'n1', target: 'n2' }],
        });
      expect([200, 201]).toContain(createRes.status);
      runnableDagId = createRes.body.id;

      // Trigger run
      const runRes = await request(app)
        .post(`/api/dags/${runnableDagId}/run`)
        .set(adminAuth());
      expect([200, 202]).toContain(runRes.status);
      expect(runRes.body).toHaveProperty('dagId', runnableDagId);
      expect(runRes.body).toHaveProperty('status', 'running');
      expect(runRes.body).toHaveProperty('layers');
      expect(runRes.body.layers).toBe(2);

      // Wait for the job queue to process and update DAG status
      const finalState = await waitForDagStatus(runnableDagId);
      expect(finalState.status).toBe('completed');

      // Verify last_run_result has step data
      const result = JSON.parse(finalState.last_run_result);
      expect(result).toHaveProperty('steps');
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].results[0]).toHaveProperty('status', 'success');
      expect(result.steps[1].results[0]).toHaveProperty('status', 'success');
    });

    it('should reject running an already-running DAG with 409', async () => {
      if (!runnableDagId) return;
      // The DAG from the previous test is now 'completed', so first re-run it
      // then immediately try again — but since the queue is async, we can't
      // reliably catch the 'running' window. Instead, manually set status.
      db.prepare("UPDATE dags SET status = 'running' WHERE id = ?").run(runnableDagId);
      const res = await request(app)
        .post(`/api/dags/${runnableDagId}/run`)
        .set(adminAuth());
      expect(res.status).toBe(409);
    });

    it('should detect a cycle and return 400', async () => {
      const createRes = await request(app)
        .post('/api/dags')
        .set(adminAuth())
        .send({
          name: 'Cyclic DAG',
          nodes: [
            { id: 'a', name: 'A', command: 'echo a' },
            { id: 'b', name: 'B', command: 'echo b' },
          ],
          edges: [
            { source: 'a', target: 'b' },
            { source: 'b', target: 'a' },
          ],
        });
      expect([200, 201]).toContain(createRes.status);
      cyclicDagId = createRes.body.id;

      const runRes = await request(app)
        .post(`/api/dags/${cyclicDagId}/run`)
        .set(adminAuth());
      expect(runRes.status).toBe(400);
      expect(runRes.body).toHaveProperty('error');
      expect(runRes.body.error).toMatch(/cycle/i);
    });

    it('should handle empty DAG (no nodes) gracefully', async () => {
      const createRes = await request(app)
        .post('/api/dags')
        .set(adminAuth())
        .send({
          name: 'Empty DAG',
          nodes: [],
          edges: [],
        });
      expect([200, 201]).toContain(createRes.status);
      emptyDagId = createRes.body.id;

      const runRes = await request(app)
        .post(`/api/dags/${emptyDagId}/run`)
        .set(adminAuth());
      // Empty DAG = 0 layers, completes immediately
      expect([200, 202]).toContain(runRes.status);
      expect(runRes.body.layers).toBe(0);
    });

    it('should ignore dangling edges (unknown endpoints) instead of crashing', async () => {
      const createRes = await request(app)
        .post('/api/dags')
        .set(adminAuth())
        .send({
          name: 'Dangling Edge DAG',
          nodes: [{ id: 'only-node', name: 'Solo', command: 'echo solo' }],
          edges: [{ source: 'only-node', target: 'missing-node' }],
        });
      expect([200, 201]).toContain(createRes.status);
      const id = createRes.body.id;

      const runRes = await request(app)
        .post(`/api/dags/${id}/run`)
        .set(adminAuth());
      expect([200, 202]).toContain(runRes.status);

      const finalState = await waitForDagStatus(id);
      expect(finalState.status).toBe('completed');
    });

    it('should run a single-node DAG created like the editor (step stored in nodes)', async () => {
      const createRes = await request(app)
        .post('/api/dags')
        .set(adminAuth())
        .send({
          name: 'Editor Style DAG',
          nodes: [{ id: 'editor-step-1', name: 'Editor Step', type: 'task', command: 'echo editor', x: 120, y: 80 }],
          edges: [],
        });
      expect([200, 201]).toContain(createRes.status);
      const id = createRes.body.id;

      const runRes = await request(app)
        .post(`/api/dags/${id}/run`)
        .set(adminAuth());
      expect([200, 202]).toContain(runRes.status);

      const finalState = await waitForDagStatus(id);
      expect(finalState.status).toBe('completed');
      const result = JSON.parse(finalState.last_run_result);
      expect(result).toHaveProperty('steps');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].results[0]).toHaveProperty('status', 'success');
    });

    it('should preserve node metadata through PUT (editor save format)', async () => {
      const createRes = await request(app)
        .post('/api/dags')
        .set(adminAuth())
        .send({ name: 'Metadata DAG', nodes: [], edges: [] });
      expect([200, 201]).toContain(createRes.status);
      const id = createRes.body.id;

      const putRes = await request(app)
        .put(`/api/dags/${id}`)
        .set(adminAuth())
        .send({
          nodes: [{ id: 'meta-step', name: 'Meta', type: 'delay', command: '', x: 300, y: 90 }],
          edges: [{ source: 'meta-step', target: 'other-dag' }],
        });
      expect(putRes.status).toBe(200);

      const getRes = await request(app).get(`/api/dags/${id}`);
      expect(getRes.body.nodes[0]).toMatchObject({ id: 'meta-step', name: 'Meta', type: 'delay', x: 300, y: 90 });

      const runRes = await request(app)
        .post(`/api/dags/${id}/run`)
        .set(adminAuth());
      expect([200, 202]).toContain(runRes.status);
      const finalState = await waitForDagStatus(id);
      expect(finalState.status).toBe('completed');
    });

    it('should mark DAG as completed on successful run (job queue path)', async () => {
      if (!runnableDagId) return;
      // Reset status and re-run to verify the job queue updates the dags table
      db.prepare("UPDATE dags SET status = 'draft' WHERE id = ?").run(runnableDagId);
      const runRes = await request(app)
        .post(`/api/dags/${runnableDagId}/run`)
        .set(adminAuth());
      expect([200, 202]).toContain(runRes.status);

      const finalState = await waitForDagStatus(runnableDagId);
      expect(finalState.status).toBe('completed');
    });
  });
});
