import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Agent Loop & Tools API', () => {
  describe('GET /api/agent/tools — list registered tools', () => {
    it('should return all registered agent tools', async () => {
      const res = await request(app)
        .get('/api/agent/tools')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);

      // Verify tool structure
      const tool = res.body[0];
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('parameters');

      // Check for built-in tools
      const toolNames = res.body.map(t => t.name);
      expect(toolNames).toContain('file_read');
      expect(toolNames).toContain('file_write');
      expect(toolNames).toContain('file_list');
      expect(toolNames).toContain('file_search');
      expect(toolNames).toContain('shell_exec');
      expect(toolNames).toContain('web_search');
      expect(toolNames).toContain('web_fetch');
      expect(toolNames).toContain('git_op');
      expect(toolNames).toContain('mcp_invoke');
      expect(toolNames).toContain('skill_invoke');
    });

    it('should reject without auth', async () => {
      const res = await request(app).get('/api/agent/tools');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/agent/run — start autonomous loop', () => {
    it('should start the agent loop for a valid session', async () => {
      // Create a session first
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'List files in workspace', mode: 'agent', scope: 'sandbox' });

      const res = await request(app)
        .post('/api/agent/run')
        .set(adminAuth())
        .send({ session_id: createRes.body.id, max_steps: 2 });
      expect(res.status).toBe(200);
      expect(res.body.started).toBe(true);
      expect(res.body.session_id).toBe(createRes.body.id);
    });

    it('should reject missing session_id', async () => {
      const res = await request(app)
        .post('/api/agent/run')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });

    it('should reject non-existent session', async () => {
      const res = await request(app)
        .post('/api/agent/run')
        .set(adminAuth())
        .send({ session_id: 'nonexistent-uuid' });
      expect(res.status).toBe(404);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/agent/run')
        .send({ session_id: 'test' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/agent/sessions/:id/stop — stop a session', () => {
    it('should stop a running session', async () => {
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Stop me', mode: 'agent' });

      const res = await request(app)
        .post(`/api/agent/sessions/${createRes.body.id}/stop`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.stopped).toBe(true);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .post('/api/agent/sessions/nonexistent/stop')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/agent/sessions/:id/resume — resume a session', () => {
    it('should resume a stopped session', async () => {
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Resume test', mode: 'agent', scope: 'sandbox' });

      // Stop it first
      await request(app)
        .post(`/api/agent/sessions/${createRes.body.id}/stop`)
        .set(adminAuth());

      // Resume it
      const res = await request(app)
        .post(`/api/agent/sessions/${createRes.body.id}/resume`)
        .set(adminAuth())
        .send({ max_steps: 2 });
      expect(res.status).toBe(200);
      expect(res.body.resumed).toBe(true);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .post('/api/agent/sessions/nonexistent/resume')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('Agent session status flow', () => {
    it('should track status through session lifecycle', async () => {
      // Create
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Lifecycle test', mode: 'agent' });
      expect(createRes.body.status).toBe('planning');

      // Stop it (simulating: the loop hasn't started → status becomes 'stopped')
      const stopRes = await request(app)
        .post(`/api/agent/sessions/${createRes.body.id}/stop`)
        .set(adminAuth());
      expect(stopRes.status).toBe(200);

      // Get session — should show 'stopped'
      const getRes = await request(app)
        .get(`/api/agent/sessions/${createRes.body.id}`)
        .set(adminAuth());
      expect(getRes.body.status).toBe('stopped');
    });

    it('should have current_step field that updates', async () => {
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Step tracking test' });

      const getRes = await request(app)
        .get(`/api/agent/sessions/${createRes.body.id}`)
        .set(adminAuth());
      expect(getRes.body).toHaveProperty('current_step');
    });
  });
});
