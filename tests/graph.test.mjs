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

    it('should include the central Cardinal system node', async () => {
      const res = await request(app).get('/api/graph');
      expect(res.status).toBe(200);
      const system = res.body.nodes.find(n => n.group === 'system');
      expect(system).toBeDefined();
      expect(system.id).toBe('system');
      expect(system.name).toBe('Cardinal');
    });

    it('should link Cardinal to every cluster hub', async () => {
      const res = await request(app).get('/api/graph');
      const hubs = res.body.nodes.filter(n => n.group === 'cluster');
      for (const hub of hubs) {
        const link = res.body.links.find(l =>
          (l.source === 'system' && l.target === hub.id) ||
          (l.target === 'system' && l.source === hub.id)
        );
        expect(link, `missing bridge ${hub.id} → system`).toBeDefined();
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

// ─── Layout Simulation Tests ───────────────────────────────────────

import { simulateClusters, relocateHubs } from '../client/src/graph/ClusterSimulation.js';
import { assignSectors } from '../client/src/graph/SectorLayout.js';

describe('ClusterSimulation', () => {
  it('should run world simulation for cluster hubs', () => {
    const clusters = new Map();
    const clusterOrder = ['cluster1', 'cluster2'];
    const bridgeLinks = [];
    
    // Mock cluster data with hubNode
    const hub1 = { id: 'cluster:1', x: 100, y: 100, group: 'cluster', cluster: 'cluster1', fx: null, fy: null };
    const hub2 = { id: 'cluster:2', x: 200, y: 200, group: 'cluster', cluster: 'cluster2', fx: null, fy: null };
    
    clusters.set('cluster1', { 
      radius: 150, 
      hubNode: hub1,
      nodes: [hub1]
    });
    clusters.set('cluster2', {
      radius: 120,
      hubNode: hub2,
      nodes: [hub2]
    });
    
    // Run simulation - should set fx/fy on hubs
    simulateClusters(clusters, clusterOrder, bridgeLinks);
    
    expect(hub1.fx).toBeDefined();
    expect(hub1.fy).toBeDefined();
    expect(hub2.fx).toBeDefined();
    expect(hub2.fy).toBeDefined();
    
    // Hubs should be at sector angles
    expect(hub1.x).toBeGreaterThan(-200);
    expect(hub1.y).toBeGreaterThan(-200);
    expect(hub2.x).toBeGreaterThan(-200);
    expect(hub2.y).toBeGreaterThan(-200);
  });

  it('should enforce minimum hub radius', () => {
    const clusters = new Map();
    const clusterOrder = ['cluster1'];
    const bridgeLinks = [];
    
    const hub1 = { id: 'cluster:1', x: 100, y: 100, group: 'cluster', cluster: 'cluster1', fx: null, fy: null };
    
    clusters.set('cluster1', { 
      radius: 50, // Less than MIN_HUB_RADIUS (180)
      hubNode: hub1,
      nodes: [hub1]
    });
    
    simulateClusters(clusters, clusterOrder, bridgeLinks);
    
    // Hub should be positioned at MIN_HUB_RADIUS (180) from origin
    const distFromOrigin = Math.sqrt(hub1.x * hub1.x + hub1.y * hub1.y);
    expect(distFromOrigin).toBeGreaterThanOrEqual(180);
  });

  it('should not crash with empty cluster order', () => {
    const clusters = new Map();
    const clusterOrder = [];
    const bridgeLinks = [];
    
    // Should not throw
    simulateClusters(clusters, clusterOrder, bridgeLinks);
  });
});

describe('relocateHubs', () => {
  it('should move hubs to new sector positions', () => {
    const clusters = new Map();
    const clusterOrder = ['cluster1'];
    const sectors = new Map();
    
    const hub1 = { id: 'cluster:1', x: 100, y: 100, group: 'cluster', cluster: 'cluster1', fx: null, fy: null };
    
    clusters.set('cluster1', { 
      radius: 150,
      hubNode: hub1,
      nodes: [hub1]
    });
    
    sectors.set('cluster1', { angleRad: 0, angleDeg: 0 });
    
    // First position hubs
    simulateClusters(clusters, clusterOrder, []);
    const firstX = hub1.x;
    const firstY = hub1.y;
    
    // Move to new sector
    sectors.set('cluster1', { angleRad: Math.PI / 2, angleDeg: 90 }); // 90 degrees
    relocateHubs(clusters, clusterOrder, sectors);

    // Hub should be at new sector position: (0, radius) for 90°
    expect(hub1.x).toBeCloseTo(0, 5);
    expect(hub1.y).toBeGreaterThanOrEqual(150);
  });
});

describe('assignSectors', () => {
  it('should assign known clusters to fixed angles', () => {
    const result = assignSectors(['runtime', 'models']);
    
    expect(result.get('runtime').angleDeg).toBe(0);
    expect(result.get('models').angleDeg).toBe(72);
  });

  it('should assign unknown clusters to gaps between known ones', () => {
    // Known sectors are at 0, 72, 144, 216, 288. All gaps are 72 wide;
    // the code fills the first largest gap (0→72), so the unknown lands mid-gap at 36.
    const result = assignSectors(['runtime', 'models', 'interface', 'integrate', 'infra', 'unknown1']);

    const unknownAngle = result.get('unknown1').angleDeg;
    expect(unknownAngle).toBeCloseTo(36);
  });

  it('should distribute unknown clusters evenly when no known sectors exist', () => {
    const result = assignSectors(['unknown1', 'unknown2']);
    const angles = Array.from(result.values()).map(s => s.angleDeg);
    angles.sort((a, b) => a - b);
    expect(angles.length).toBe(2);
    const diff = (angles[1] - angles[0] + 360) % 360;
    expect(diff).toBeCloseTo(180); // 360 / 2 evenly
  });
});