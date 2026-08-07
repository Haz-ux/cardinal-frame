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

describe('Agent Registry API', () => {
  let createdId;

  it('POST /api/agents registers an agent with full fields', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set(adminAuth())
      .send({ name: 'reg-test-' + Date.now(), version: '2.5', capabilities: ['nlp', 'code-gen'] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.version).toBe('2.5');
    expect(res.body.capabilities).toEqual(['nlp', 'code-gen']);
    expect(res.body.status).toBe('active');
    expect(res.body.registered_at).toBeTruthy();
    expect(res.body.last_heartbeat).toBeTruthy();
    createdId = res.body.id;
  });

  it('GET /api/agents returns version, heartbeat, and registered_at (not just id/name/status)', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const mine = res.body.find(a => a.id === createdId);
    expect(mine).toBeTruthy();
    expect(mine.version).toBe('2.5');
    expect(mine.capabilities).toEqual(['nlp', 'code-gen']);
    expect(mine.registered_at).toBeTruthy();
    expect(mine.last_heartbeat).toBeTruthy();
  });

  it('POST /api/agents defaults missing capabilities to []', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set(adminAuth())
      .send({ name: 'no-caps-' + Date.now() });
    expect(res.status).toBe(201);
    expect(res.body.capabilities).toEqual([]);
    expect(res.body.version).toBe('1.0');
  });

  it('POST /api/agents rejects a missing name with 400', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set(adminAuth())
      .send({ version: '1.0' });
    expect(res.status).toBe(400);
  });

  it('POST /api/agents rejects without auth', async () => {
    const res = await request(app)
      .post('/api/agents')
      .send({ name: 'noauth-' + Date.now() });
    expect(res.status).toBe(401);
  });

  it('PUT /api/agents/:id toggles status', async () => {
    const res = await request(app)
      .put(`/api/agents/${createdId}`)
      .set(adminAuth())
      .send({ status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inactive');
  });

  it('PUT /api/agents/:id allows non-admin users', async () => {
    const res = await request(app)
      .put(`/api/agents/${createdId}`)
      .set(userAuth())
      .send({ status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('PUT /api/agents/:id rejects invalid status with 400', async () => {
    const res = await request(app)
      .put(`/api/agents/${createdId}`)
      .set(adminAuth())
      .send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/agents/:id returns 404 for a missing agent', async () => {
    const res = await request(app)
      .put('/api/agents/does-not-exist')
      .set(adminAuth())
      .send({ status: 'active' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/agents/:id requires admin', async () => {
    const res = await request(app)
      .delete(`/api/agents/${createdId}`)
      .set(userAuth());
    expect(res.status).toBe(403);
  });
});
