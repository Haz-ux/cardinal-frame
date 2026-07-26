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

describe('Graph API', () => {
  describe('GET /api/graph', () => {
    it('should return graph with nodes and links', async () => {
      const res = await request(app).get('/api/graph');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('nodes');
      expect(res.body).toHaveProperty('links');
      expect(Array.isArray(res.body.nodes)).toBe(true);
      expect(Array.isArray(res.body.links)).toBe(true);
    });

    it('should work without auth (optionalAuth)', async () => {
      const res = await request(app).get('/api/graph');
      expect(res.status).toBe(200);
    });

    it('should include node grouping (type or group)', async () => {
      const res = await request(app).get('/api/graph');
      expect(res.status).toBe(200);
      if (res.body.nodes.length > 0) {
        // Nodes use 'group' for categorization (some may also have 'type')
        const grouped = res.body.nodes.filter(n => n.group || n.type);
        expect(grouped.length).toBeGreaterThan(0);
      }
    });

    it('should have valid link structure (source, target)', async () => {
      const res = await request(app).get('/api/graph');
      if (res.body.links.length > 0) {
        const link = res.body.links[0];
        expect(link).toHaveProperty('source');
        expect(link).toHaveProperty('target');
      }
    });

    it('should not include server-assigned x/y coordinates on nodes', async () => {
      // Regression test: server-side position assignment was removed to fix
      // the neural map pile-up bug. The client is now the single source of
      // truth for layout via its targetXY() function.
      const res = await request(app).get('/api/graph');
      expect(res.status).toBe(200);
      for (const node of res.body.nodes) {
        expect(node).not.toHaveProperty('x');
        expect(node).not.toHaveProperty('y');
      }
    });
  });

  describe('GET /api/graph/core', () => {
    it('should return core graph view', async () => {
      const res = await request(app).get('/api/graph/core');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('nodes');
      expect(Array.isArray(res.body.nodes)).toBe(true);
    });
  });

  describe('GET /api/graph/expand', () => {
    it('should return expanded graph for a node', async () => {
      // First get the full graph to find a typed node id
      const graphRes = await request(app).get('/api/graph');
      const typedNode = graphRes.body.nodes.find(n => n.type && n.type !== 'cluster');
      if (typedNode) {
        const res = await request(app).get(`/api/graph/expand?id=${typedNode.id}`);
        expect([200, 400, 404]).toContain(res.status);
        if (res.status === 200) expect(res.body).toHaveProperty('nodes');
      }
    });

    it('should handle non-existent node gracefully', async () => {
      const res = await request(app).get('/api/graph/expand?id=non-existent-node-99999');
      expect([200, 400, 404]).toContain(res.status);
    });
  });
});
