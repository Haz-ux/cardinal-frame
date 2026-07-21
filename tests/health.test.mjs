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

describe('Health & Infrastructure', () => {
  describe('GET /api/health', () => {
    it('should return enhanced health info', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.mode).toBe('AI-Powered');
      // Enhanced fields
      expect(res.body).toHaveProperty('db');
      expect(res.body.db).toHaveProperty('type', 'SQLite');
      expect(res.body.db).toHaveProperty('tables');
      expect(res.body.db).toHaveProperty('size_mb');
      expect(res.body).toHaveProperty('ws');
      expect(res.body.ws).toHaveProperty('connected_clients');
      expect(res.body).toHaveProperty('uptime');
      expect(res.body).toHaveProperty('memory');
      expect(res.body.memory).toHaveProperty('rss_mb');
      expect(res.body).toHaveProperty('timestamp');
    });

    it('should not require auth', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/dashboard/summary', () => {
    it('should return dashboard summary', async () => {
      const res = await request(app).get('/api/dashboard/summary');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/graph', () => {
    it('should return graph data with nodes and links', async () => {
      const res = await request(app).get('/api/graph');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('nodes');
      expect(res.body).toHaveProperty('links');
      expect(Array.isArray(res.body.nodes)).toBe(true);
      expect(Array.isArray(res.body.links)).toBe(true);
    });
  });

  describe('API 404 catch-all', () => {
    it('should return JSON 404 for unknown API routes', async () => {
      const res = await request(app).get('/api/nonexistent-endpoint');
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('should return JSON 404 for unknown POST API routes', async () => {
      const res = await request(app)
        .post('/api/nonexistent-endpoint')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  describe('Request ID tracking', () => {
    it('should set X-Request-Id header on responses', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers).toHaveProperty('x-request-id');
      expect(res.headers['x-request-id']).toBeTruthy();
    });

    it('should respect client-provided X-Request-Id', async () => {
      const customId = 'test-req-12345';
      const res = await request(app)
        .get('/api/health')
        .set('X-Request-Id', customId);
      expect(res.headers['x-request-id']).toBe(customId);
    });
  });

  describe('Skills API', () => {
    it('should list skills', async () => {
      const res = await request(app).get('/api/skills');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should list enabled skills', async () => {
      const res = await request(app).get('/api/skills/enabled');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('Tools API', () => {
    it('should list tools', async () => {
      const res = await request(app).get('/api/tools');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('LLM Providers API', () => {
    it('should list providers', async () => {
      const res = await request(app).get('/api/llm/providers');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should get default model', async () => {
      const res = await request(app).get('/api/llm/models/default');
      expect(res.status).toBe(200);
    });
  });
});
