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

describe('/api/aimi/chat admin gate', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app)
      .post('/api/aimi/chat')
      .send({ message: '/help' });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app)
      .post('/api/aimi/chat')
      .set(userAuth())
      .send({ message: '/help' });
    expect(res.status).toBe(403);
  });

  it('still serves admins', async () => {
    const res = await request(app)
      .post('/api/aimi/chat')
      .set(adminAuth())
      .send({ message: '/help' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('/compress');
  });
});
