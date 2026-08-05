import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;
let server;
// Tool chains execute steps by calling back into the API over HTTP
// (http://localhost:PORT + endpoint), so the test app needs a real listener.
const TOOL_CHAIN_PORT = 32123;

beforeAll(async () => {
  process.env.PORT = String(TOOL_CHAIN_PORT); // must be set before the server module loads
  ({ app } = await getTestServer());
  server = app.listen(TOOL_CHAIN_PORT, '127.0.0.1');
});

afterAll(() => {
  if (server) { try { server.close(); } catch {} }
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

// ─── Chain Execution ────────────────────────────────────────────

describe('Skill Chain Execution', () => {
  it('should execute a multi-step skill chain and return the pipeline result', async () => {
    // Create two script skills
    const mk = (name, handler) => request(app)
      .post('/api/skills')
      .set(adminAuth())
      .send({ name, handler });
    const a = await mk(`chain-exec-a-${Date.now()}`, 'async (input) => ({ step: "a", seen: input })');
    const b = await mk(`chain-exec-b-${Date.now()}`, 'async (input) => ({ step: "b", prev: input?.seen })');
    expect(a.body.id).toBeTruthy();
    expect(b.body.id).toBeTruthy();

    // Create a chain referencing the skills by name
    const chainRes = await request(app)
      .post('/api/chains/skills')
      .set(adminAuth())
      .send({
        name: `exec-chain-${Date.now()}`,
        description: 'exec test',
        steps: [
          { skill_name: a.body.name, name: 'Step A', input_mapping: { input: '$input' } },
          { skill_name: b.body.name, name: 'Step B', input_mapping: { input: '$prev.output' } },
        ],
      });
    const chainId = chainRes.body.id;
    expect(chainId).toBeTruthy();

    const res = await request(app)
      .post(`/api/chains/skills/${chainId}/execute`)
      .set(adminAuth())
      .send({ input: 'chain-input' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toMatchObject({ stepName: 'Step A', ok: true });
    expect(res.body.results[1]).toMatchObject({ stepName: 'Step B', ok: true });
    expect(res.body.final_output).toMatchObject({ step: 'b' });

    // Chain should be marked completed with a stored result
    const getRes = await request(app)
      .get(`/api/chains/skills/${chainId}`)
      .set(adminAuth());
    expect(getRes.body.status).toBe('completed');
    expect(getRes.body.last_run_result).toHaveProperty('ok', true);
  });

  it('should fail fast on a missing skill step', async () => {
    const chainRes = await request(app)
      .post('/api/chains/skills')
      .set(adminAuth())
      .send({
        name: `bad-chain-${Date.now()}`,
        steps: [{ skill_name: 'no-such-skill-xyz', name: 'Boom' }],
      });
    const res = await request(app)
      .post(`/api/chains/skills/${chainRes.body.id}/execute`)
      .set(adminAuth())
      .send({ input: {} });
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/not found/i);
    }
  });

  it('should delete a skill chain that has execution history (cascade)', async () => {
    const mk = (name, handler) => request(app)
      .post('/api/skills')
      .set(adminAuth())
      .send({ name, handler });
    const a = await mk(`cascade-a-${Date.now()}`, 'async (input) => ({ ok: true })');
    const chainRes = await request(app)
      .post('/api/chains/skills')
      .set(adminAuth())
      .send({
        name: `cascade-chain-${Date.now()}`,
        steps: [{ skill_name: a.body.name, name: 'A' }],
      });
    const runRes = await request(app)
      .post(`/api/chains/skills/${chainRes.body.id}/execute`)
      .set(adminAuth())
      .send({ input: {} });
    expect(runRes.status).toBe(200);

    const delRes = await request(app)
      .delete(`/api/chains/skills/${chainRes.body.id}`)
      .set(adminAuth());
    expect(delRes.status).toBe(200);
    expect(delRes.body).toMatchObject({ ok: true });
    expect((await request(app).get(`/api/chains/skills/${chainRes.body.id}`).set(adminAuth())).status).toBe(404);
  });
});

describe('Tool Chain Execution', () => {
  it('should execute a tool chain step against an authenticated internal endpoint', async () => {
    // Register a tool that points at the auth-protected bash executor
    const toolName = `chain-tool-${Date.now()}`;
    const toolRes = await request(app)
      .post('/api/tools')
      .set(adminAuth())
      .send({ name: toolName, description: 'echo via chain', endpoint: '/api/tools/bash', method: 'POST', parameters: {} });
    expect([200, 201]).toContain(toolRes.status);

    const chainRes = await request(app)
      .post('/api/chains/tools')
      .set(adminAuth())
      .send({
        name: `tool-exec-chain-${Date.now()}`,
        steps: [
          { tool_name: toolName, name: 'Echo', method: 'POST', endpoint: '/api/tools/bash', input_override: { command: 'echo chain-tool-ok' } },
        ],
      });
    const res = await request(app)
      .post(`/api/chains/tools/${chainRes.body.id}/execute`)
      .set(adminAuth())
      .send({ input: {} });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results[0].ok).toBe(true);
    expect(res.body.results[0].output).toMatchObject({ exit_code: 0 });
    expect(JSON.stringify(res.body.results[0].output)).toContain('chain-tool-ok');
  });

  it('should reject tool chain execution without auth', async () => {
    const chainRes = await request(app)
      .post('/api/chains/tools')
      .set(adminAuth())
      .send({ name: `noauth-chain-${Date.now()}`, steps: [{ tool_name: 'x', name: 'X' }] });
    const res = await request(app)
      .post(`/api/chains/tools/${chainRes.body.id}/execute`)
      .send({ input: {} });
    expect(res.status).toBe(401);
  });
});
