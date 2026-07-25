import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(async () => {
  await cleanupTestServer();
});

describe('Delegation', () => {
  let delegationId;

  it('should delegate a subtask (async mode)', async () => {
    const res = await request(app)
      .post('/api/delegate')
      .set(adminAuth())
      .send({
        name: 'Subtask Test',
        command: 'echo hello from delegation',
        synchronous: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.child_task_id).toBeDefined();
    // Status is 'awaiting_node' when no remote node is reachable, 'pending' otherwise
    expect(['pending', 'awaiting_node']).toContain(res.body.status);
    delegationId = res.body.id;
  });

  it('should delegate with synchronous mode and wait', async () => {
    const res = await request(app)
      .post('/api/delegate')
      .set(adminAuth())
      .send({
        name: 'Sync Subtask',
        command: 'echo sync result',
        synchronous: true,
        waitTimeout: 5000,
      });
    // Should either complete (200) or timeout (202)
    expect([200, 202]).toContain(res.status);
    expect(res.body.id).toBeDefined();
    expect(res.body.child_task_id).toBeDefined();
  });

  it('should validate required fields', async () => {
    const res = await request(app)
      .post('/api/delegate')
      .set(adminAuth())
      .send({ capability: 'build' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Name and command are required');
  });

  it('should reject unsafe commands', async () => {
    const res = await request(app)
      .post('/api/delegate')
      .set(adminAuth())
      .send({
        name: 'Unsafe',
        command: 'rm -rf /',
        synchronous: false,
      });
    expect(res.status).toBe(400);
  });

  it('should list delegations', async () => {
    const res = await request(app).get('/api/delegations');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('should get a delegation by id', async () => {
    const res = await request(app).get(`/api/delegations/${delegationId}`);
    // May be 200 or 404 if the delegation was cleaned up
    if (res.status === 200) {
      expect(res.body.id).toBe(delegationId);
      expect(res.body.childTask).toBeDefined();
    } else {
      expect(res.status).toBe(404);
    }
  });

  it('should return 404 for missing delegation', async () => {
    const res = await request(app).get('/api/delegations/nonexistent');
    expect(res.status).toBe(404);
  });

  it('should filter by parent task ID', async () => {
    // First create a delegation with parentTaskId
    const parentRes = await request(app)
      .post('/api/tasks')
      .set(adminAuth())
      .send({ name: 'Parent Task', command: 'echo parent' })
      .expect(201);
    const parentId = parentRes.body.id;

    await request(app)
      .post('/api/delegate')
      .set(adminAuth())
      .send({
        name: 'Child With Parent',
        command: 'echo child',
        parentTaskId: parentId,
        synchronous: false,
      })
      .expect(201);

    const res = await request(app).get(`/api/delegations?parentId=${parentId}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every(d => d.parent_task_id === parentId)).toBe(true);
  });

  it('should support wait endpoint for pending delegations', async () => {
    // Create a new async delegation
    const createRes = await request(app)
      .post('/api/delegate')
      .set(adminAuth())
      .send({
        name: 'Wait Test',
        command: 'echo wait test',
        synchronous: false,
      })
      .expect(201);

    // Wait on it (should either complete or timeout)
    const res = await request(app)
      .post(`/api/delegations/${createRes.body.id}/wait`)
      .query({ timeout: 3000 });
    expect([200, 202]).toContain(res.status);
  });

  it('should list agent tools and include delegate_task', async () => {
    const res = await request(app).get('/api/agent/tools').set(adminAuth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(t => t.name === 'delegate_task')).toBe(true);
  });
});
