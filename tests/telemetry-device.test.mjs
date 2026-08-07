import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});
afterAll(() => cleanupTestServer());

describe('live telemetry device classification', () => {
  it('exposes device info on /api/telemetry', async () => {
    const res = await request(app).get('/api/telemetry');
    expect(res.status).toBe(200);
    const t = res.body;
    expect(t.device).toBeTruthy();
    expect(typeof t.device.class).toBe('string');
    expect(typeof t.device.label).toBe('string');
    expect(t.device.arch).toBe(process.arch);
    expect(Number.isInteger(t.device.cores)).toBe(true);
    expect(t.device.cores).toBeGreaterThan(0);
    expect(typeof t.device.os).toBe('string');
    expect(t.device.os.length).toBeGreaterThan(0);
  });

  it('reports cpu/mem as numbers and gpu/npu as number or null', async () => {
    const res = await request(app).get('/api/telemetry');
    expect(res.status).toBe(200);
    const t = res.body;
    expect(typeof t.cpu).toBe('number');
    expect(t.cpu).toBeGreaterThanOrEqual(0);
    expect(t.cpu).toBeLessThanOrEqual(100);
    expect(typeof t.mem).toBe('number');
    for (const key of ['gpu', 'npu']) {
      expect(t[key] === null || typeof t[key] === 'number').toBe(true);
      if (typeof t[key] === 'number') expect(t[key]).toBeGreaterThanOrEqual(0);
    }
  });
});
