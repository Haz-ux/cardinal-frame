/**
 * Tests for Nodes API routes — GET /api/nodes, GET /api/nodes/:id,
 * GET /api/nodes/stats, POST /api/nodes
 *
 * Verifies that the node registry is properly wired to routes and
 * the HTTP endpoints return real registry data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import nodesRoutes from '../src/server/routes/nodes.mjs';
import { initNodeRegistry } from '../src/server/node-registry.mjs';
import { getOrCreateNodeIdentity, signPayload } from '../src/server/node-identity.mjs';

let db;
let registry;
let app;
let identityDb;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  registry = initNodeRegistry(db);

  // Create a real node identity for registration
  identityDb = new Database(':memory:');
  const identity = getOrCreateNodeIdentity(identityDb);

  // Register a test node
  registry.registerNode({
    id: identity.node_id,
    name: 'IKARIS',
    base_url: 'http://ikaris.local:8080',
    public_key_pem: identity.public_key_pem,
    capabilities: ['code', 'docker', 'analysis'],
  });

  // Minimal mock ctx
  const ctx = {
    nodeRegistry: registry,
    authMiddleware: (_req, _res, next) => { _req.user = { id: 'test-user', role: 'admin' }; next(); },
    optionalAuth: (_req, _res, next) => { _req.user = { id: 'test-user', role: 'admin' }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    apiLimiter: (_req, _res, next) => next(),
    audit: () => {},
    broadcast: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  app = express();
  app.use(express.json());
  app.use('/api', nodesRoutes(ctx));
});

afterEach(() => {
  registry.stopHeartbeat();
  db.close();
  identityDb.close();
});

describe('GET /api/nodes', () => {
  it('should return all registered nodes', async () => {
    const res = await fetch(
      `http://localhost:${app.listen().address().port}/api/nodes`
    );
    // Get the server port — need to use a different approach
  });

  it('should return nodes as JSON array', async () => {
    // Use supertest-style approach with Node's http server
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`);
      expect(res.status).toBe(200);
      const nodes = await res.json();
      expect(Array.isArray(nodes)).toBe(true);
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('IKARIS');
      expect(nodes[0].base_url).toBe('http://ikaris.local:8080');
      expect(nodes[0].capabilities).toEqual(['code', 'docker', 'analysis']);
    } finally {
      server.close();
    }
  });
});

describe('GET /api/nodes/:id', () => {
  it('should return a single node by its cryptographic ID', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const allRes = await fetch(`http://localhost:${port}/api/nodes`);
      const nodes = await allRes.json();
      const nodeId = nodes[0].id;

      const res = await fetch(`http://localhost:${port}/api/nodes/${nodeId}`);
      expect(res.status).toBe(200);
      const node = await res.json();
      expect(node.name).toBe('IKARIS');
      expect(node.capabilities).toEqual(['code', 'docker', 'analysis']);
    } finally {
      server.close();
    }
  });

  it('should return a node by name (fallback)', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes/IKARIS`);
      expect(res.status).toBe(200);
      const node = await res.json();
      expect(node.name).toBe('IKARIS');
    } finally {
      server.close();
    }
  });

  it('should return 404 for a non-existent node', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes/nonexistent`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('GET /api/nodes/stats', () => {
  it('should return summary counts of node statuses', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes/stats`);
      expect(res.status).toBe(200);
      const stats = await res.json();
      expect(stats.total).toBe(1);
      expect(stats.online).toBe(0); // node starts as 'unknown'
      expect(stats.offline).toBe(0);
      expect(stats.unknown).toBe(1);
    } finally {
      server.close();
    }
  });
});

describe('POST /api/nodes', () => {
  it('should register a new node', async () => {
    const server = app.listen(0);
    const port = server.address().port;

    // Create a second node identity
    const identityDb2 = new Database(':memory:');
    const id2 = getOrCreateNodeIdentity(identityDb2);

    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: id2.node_id,
          name: 'ARIES',
          base_url: 'http://aries.local:8080',
          public_key_pem: id2.public_key_pem,
          capabilities: ['code', 'analysis'],
        }),
      });
      expect(res.status).toBe(201);
      const node = await res.json();
      expect(node.name).toBe('ARIES');

      // Verify it's in the list
      const allRes = await fetch(`http://localhost:${port}/api/nodes`);
      const nodes = await allRes.json();
      expect(nodes.length).toBe(2);
      expect(nodes.some(n => n.name === 'ARIES')).toBe(true);
    } finally {
      identityDb2.close();
      server.close();
    }
  });

  it('should reject registration with missing fields', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'incomplete', name: 'BAD' }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('Node registry broadcast', () => {
  it('should broadcast on status transitions', () => {
    const calls = [];
    registry.setBroadcast((event, data) => calls.push({ event, data }));

    // Get the registered node
    const nodes = registry.getAllNodes();
    const nodeId = nodes[0].id;

    // Flip to offline
    registry.updateNodeStatus(nodeId, 'offline');
    expect(calls.length).toBe(1);
    expect(calls[0].event).toBe('node:status');
    expect(calls[0].data.status).toBe('offline');
    expect(calls[0].data.prevStatus).toBe('unknown');

    // Flip to online
    registry.updateNodeStatus(nodeId, 'online');
    expect(calls.length).toBe(2);
    expect(calls[1].event).toBe('node:status');
    expect(calls[1].data.status).toBe('online');
    expect(calls[1].data.prevStatus).toBe('offline');

    // No broadcast for same-status update
    registry.updateNodeStatus(nodeId, 'online');
    expect(calls.length).toBe(2);
  });
});
