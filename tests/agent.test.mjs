import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestServer, cleanupTestServer, adminAuth, userAuth, makeToken } from './helpers.mjs';

let app, db;
const TEST_SANDBOX = '/tmp/cf-test-sandbox';

beforeAll(async () => {
  ({ app, db } = await getTestServer());
  // Create test sandbox dir
  mkdirSync(TEST_SANDBOX, { recursive: true });
  writeFileSync(join(TEST_SANDBOX, 'hello.js'), 'console.log("hello");');
  writeFileSync(join(TEST_SANDBOX, 'data.txt'), 'test data 123');
});

afterAll(() => {
  cleanupTestServer();
  try { rmSync(TEST_SANDBOX, { recursive: true, force: true }); } catch {}
});

describe('Agent API', () => {
  describe('POST /api/agent/sessions — create session', () => {
    it('should create a session with valid params', async () => {
      const res = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Build a hello world script', mode: 'agent', scope: 'sandbox' });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.task).toBe('Build a hello world script');
      expect(res.body.mode).toBe('agent');
      expect(res.body.scope).toBe('sandbox');
      expect(res.body.status).toBe('planning');
    });

    it('should default mode to agent and scope to sandbox', async () => {
      const res = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Test defaults' });
      expect(res.status).toBe(201);
      expect(res.body.mode).toBe('agent');
      expect(res.body.scope).toBe('sandbox');
    });

    it('should reject missing task', async () => {
      const res = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });

    it('should reject invalid mode', async () => {
      const res = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Test', mode: 'autopilot' });
      expect(res.status).toBe(400);
    });

    it('should reject invalid scope', async () => {
      const res = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Test', scope: 'global' });
      expect(res.status).toBe(400);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/agent/sessions')
        .send({ task: 'Test' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/agent/sessions — list sessions', () => {
    it('should list sessions for the authenticated user', async () => {
      // Create a session first
      await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'List test session' });

      const res = await request(app)
        .get('/api/agent/sessions')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .get('/api/agent/sessions');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/agent/sessions/:id — get session detail', () => {
    it('should return session with plan and actions', async () => {
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Detail test' });
      const sessionId = createRes.body.id;

      const res = await request(app)
        .get(`/api/agent/sessions/${sessionId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(sessionId);
      expect(res.body).toHaveProperty('plan');
      expect(res.body).toHaveProperty('actions');
      expect(Array.isArray(res.body.actions)).toBe(true);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .get('/api/agent/sessions/nonexistent-uuid')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/agent/sessions/:id/mode — toggle mode', () => {
    it('should switch from agent to suggest', async () => {
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Mode toggle test', mode: 'agent' });
      const sessionId = createRes.body.id;

      const res = await request(app)
        .patch(`/api/agent/sessions/${sessionId}/mode`)
        .set(adminAuth())
        .send({ mode: 'suggest' });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('suggest');
    });

    it('should reject invalid mode', async () => {
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Bad mode test' });

      const res = await request(app)
        .patch(`/api/agent/sessions/${createRes.body.id}/mode`)
        .set(adminAuth())
        .send({ mode: 'autopilot' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/agent/workspace — list workspace', () => {
    it('should list sandbox files', async () => {
      const res = await request(app)
        .get('/api/agent/workspace?scope=sandbox')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .get('/api/agent/workspace');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/agent/write — write files', () => {
    it('should write a file in agent mode', async () => {
      const res = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({
          path: 'test-write-' + Date.now() + '.js',
          content: 'console.log("test");',
          scope: 'sandbox',
          mode: 'agent'
        });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('written');
      expect(res.body).toHaveProperty('action_id');
    });

    it('should create a draft in suggest mode (requires approval)', async () => {
      const res = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({
          path: 'test-suggest.js',
          content: 'console.log("suggested");',
          scope: 'sandbox',
          mode: 'suggest'
        });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('draft');
      expect(res.body.requiresApproval).toBe(true);
      expect(res.body).toHaveProperty('action_id');
    });

    it('should reject missing path', async () => {
      const res = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({ content: 'test' });
      expect(res.status).toBe(400);
    });

    it('should reject missing content', async () => {
      const res = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({ path: 'test.js' });
      expect(res.status).toBe(400);
    });

    it('should block path traversal', async () => {
      const res = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({
          path: '../../../etc/passwd',
          content: 'hacked',
          scope: 'sandbox'
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('traversal');
    });

    it('should reject content over 500KB', async () => {
      const res = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({
          path: 'big.js',
          content: 'x'.repeat(500_001),
          scope: 'sandbox'
        });
      // Express body-parser returns 413 Payload Too Large for oversized bodies
      expect([400, 413]).toContain(res.status);
    });
  });

  describe('POST /api/agent/read — read files', () => {
    it('should read an existing file', async () => {
      // First write a file
      const filePath = 'read-test.js';
      await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({ path: filePath, content: 'const x = 42;', scope: 'sandbox', mode: 'agent' });

      const res = await request(app)
        .post('/api/agent/read')
        .set(adminAuth())
        .send({ path: filePath, scope: 'sandbox' });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('const x = 42;');
    });

    it('should return 404 for non-existent file', async () => {
      const res = await request(app)
        .post('/api/agent/read')
        .set(adminAuth())
        .send({ path: 'nope.js', scope: 'sandbox' });
      expect(res.status).toBe(404);
    });

    it('should block path traversal', async () => {
      const res = await request(app)
        .post('/api/agent/read')
        .set(adminAuth())
        .send({ path: '../../../etc/shadow', scope: 'sandbox' });
      expect(res.status).toBe(403);
    });

    it('should reject missing path', async () => {
      const res = await request(app)
        .post('/api/agent/read')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/agent/approve — approve draft action', () => {
    it('should approve a pending suggest-mode action', async () => {
      // Create a suggest-mode draft
      const draftRes = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({
          path: 'approve-test.js',
          content: 'console.log("approved!");',
          scope: 'sandbox',
          mode: 'suggest'
        });
      const actionId = draftRes.body.action_id;

      const res = await request(app)
        .post('/api/agent/approve')
        .set(adminAuth())
        .send({ action_id: actionId, scope: 'sandbox' });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('approved');
    });

    it('should reject already processed action', async () => {
      // Create and approve
      const draftRes = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({ path: 'double-approve.js', content: 'x', scope: 'sandbox', mode: 'suggest' });
      const actionId = draftRes.body.action_id;

      await request(app)
        .post('/api/agent/approve')
        .set(adminAuth())
        .send({ action_id: actionId, scope: 'sandbox' });

      // Try to approve again
      const res = await request(app)
        .post('/api/agent/approve')
        .set(adminAuth())
        .send({ action_id: actionId, scope: 'sandbox' });
      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent action', async () => {
      const res = await request(app)
        .post('/api/agent/approve')
        .set(adminAuth())
        .send({ action_id: 'nonexistent', scope: 'sandbox' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/agent/reject — reject draft action', () => {
    it('should reject a pending action', async () => {
      const draftRes = await request(app)
        .post('/api/agent/write')
        .set(adminAuth())
        .send({ path: 'reject-test.js', content: 'rejected', scope: 'sandbox', mode: 'suggest' });
      const actionId = draftRes.body.action_id;

      const res = await request(app)
        .post('/api/agent/reject')
        .set(adminAuth())
        .send({ action_id: actionId });
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('rejected');
    });
  });

  describe('POST /api/agent/exec — execute commands', () => {
    it('should run a safe command', async () => {
      const res = await request(app)
        .post('/api/agent/exec')
        .set(adminAuth())
        .send({ command: 'echo hello', scope: 'sandbox' });
      expect(res.status).toBe(200);
      expect(res.body.exitCode).toBe(0);
      expect(res.body.stdout).toContain('hello');
    });

    it('should block rm -rf /', async () => {
      const res = await request(app)
        .post('/api/agent/exec')
        .set(adminAuth())
        .send({ command: 'rm -rf /', scope: 'sandbox' });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('safety');
    });

    it('should block sudo commands', async () => {
      const res = await request(app)
        .post('/api/agent/exec')
        .set(adminAuth())
        .send({ command: 'sudo rm something', scope: 'sandbox' });
      expect(res.status).toBe(403);
    });

    it('should block mkfs', async () => {
      const res = await request(app)
        .post('/api/agent/exec')
        .set(adminAuth())
        .send({ command: 'mkfs.ext4 /dev/sda1', scope: 'sandbox' });
      expect(res.status).toBe(403);
    });

    it('should reject without admin role', async () => {
      // Login as regular user
      const regRes = await request(app)
        .post('/api/auth/register')
        .send({ username: 'agentuser_' + Date.now(), password: 'pass123' });
      const token = regRes.body.token;

      const res = await request(app)
        .post('/api/agent/exec')
        .set('Authorization', `Bearer ${token}`)
        .send({ command: 'echo test', scope: 'sandbox' });
      expect(res.status).toBe(403);
    });

    it('should reject missing command', async () => {
      const res = await request(app)
        .post('/api/agent/exec')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/agent/sessions/:id — delete session', () => {
    it('should delete a session', async () => {
      const createRes = await request(app)
        .post('/api/agent/sessions')
        .set(adminAuth())
        .send({ task: 'Delete me' });
      const sessionId = createRes.body.id;

      const res = await request(app)
        .delete(`/api/agent/sessions/${sessionId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      // Verify it's gone
      const getRes = await request(app)
        .get(`/api/agent/sessions/${sessionId}`)
        .set(adminAuth());
      expect(getRes.status).toBe(404);
    });

    it('should return 404 for non-existent session', async () => {
      const res = await request(app)
        .delete('/api/agent/sessions/nonexistent')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });
});
