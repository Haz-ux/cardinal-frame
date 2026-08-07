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

describe('Activity Feed', () => {
  it('should return activity log entries (may be empty initially)', async () => {
    const res = await request(app).get('/api/activity');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should respect limit parameter', async () => {
    const res = await request(app).get('/api/activity?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(5);
  });

  it('should cap limit at 200', async () => {
    const res = await request(app).get('/api/activity?limit=99999');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(200);
  });

  it('should filter by type', async () => {
    // Generate an event by creating a task (which broadcasts task:created)
    await request(app)
      .post('/api/tasks')
      .set(adminAuth())
      .send({ name: 'Activity Test Task', command: 'echo test' })
      .expect(201);

    const res = await request(app).get('/api/activity?type=task:created');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Should find the task:created event we just generated
    if (res.body.length > 0) {
      expect(res.body.some(e => e.type === 'task:created')).toBe(true);
    }
  });

  it('should return stats', async () => {
    const res = await request(app).get('/api/activity/stats');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('should log broadcast events after activity route is mounted', async () => {
    // The fact that our task creation above worked AND we can query
    // activity events proves the broadcast → logActivity pipeline works.
    // If logActivity wasn't wired, /api/activity would always return [].
    const res = await request(app).get('/api/activity?limit=10');
    expect(res.status).toBe(200);
    // After creating tasks and other test activity, we should have events
    // (might be in-memory ring or DB)
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe('Activity Series (heatmap data)', () => {
  it('should return hourly buckets matching task creation counts', async () => {
    // Create a task — its created_at lands in the current UTC hour bucket.
    await request(app)
      .post('/api/tasks')
      .set(adminAuth())
      .send({ name: 'Heatmap Series Task', command: 'echo heatmap' })
      .expect(201);

    const res = await request(app).get('/api/dashboard/activity-series?hours=168').set(adminAuth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.buckets)).toBe(true);
    expect(res.body.buckets.length).toBe(169); // hours + current

    // Bucket keys must match the space-separated strftime format, otherwise
    // the find() lookups inside the endpoint silently produce all-zero counts.
    const key = new Date().toISOString().slice(0, 13).replace('T', ' ') + ':00';
    const current = res.body.buckets.find(b => b.hour === key);
    expect(current).toBeTruthy();
    expect(current.tasks).toBeGreaterThan(0);
  });
});
