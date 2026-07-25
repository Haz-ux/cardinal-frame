/**
 * Tests for Node Registry — liveness checks, signed heartbeats, getReachableNode
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initNodeRegistry } from '../src/server/node-registry.mjs';
import { getOrCreateNodeIdentity, signPayload, verifyPayload } from '../src/server/node-identity.mjs';

let db;
let registry;
let nodeIdentities = {}; // store identities for each test node

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  registry = initNodeRegistry(db);
  nodeIdentities = {};
});

afterEach(() => {
  registry.stopHeartbeat();
  db.close();
});

/** Helper: create a real node identity and register it.
 *  Each node needs its own identity DB since getOrCreateNodeIdentity
 *  returns the same identity if called on the same DB. */
function createRegisteredNode(registryDb, reg, name, baseUrl, capabilities = []) {
  // Use a separate in-memory DB for each node's identity
  const identityDb = new Database(':memory:');
  const identity = getOrCreateNodeIdentity(identityDb);
  nodeIdentities[identity.node_id] = identity;
  identityDb.close(); // identity is already in memory, don't need the DB
  reg.registerNode({
    id: identity.node_id,
    name,
    base_url: baseUrl,
    public_key_pem: identity.public_key_pem,
    capabilities,
  });
  return identity;
}

/** Helper: create a signed health response for a node */
function createSignedHealthResponse(nodeId, identity) {
  const payload = {
    status: 'ok',
    node_id: nodeId,
    timestamp: new Date().toISOString(),
  };
  const signature = signPayload(identity.private_key_pem, payload);
  return { payload, signature };
}

describe('Node Registry — registerNode', () => {
  it('should register a node with all fields', () => {
    const identity = getOrCreateNodeIdentity(db);
    const node = registry.registerNode({
      id: identity.node_id,
      name: 'IKARIS',
      base_url: 'http://ikaris.local:8080',
      public_key_pem: identity.public_key_pem,
      capabilities: ['code', 'docker'],
    });

    expect(node.id).toBe(identity.node_id);
    expect(node.name).toBe('IKARIS');
    expect(node.base_url).toBe('http://ikaris.local:8080');
    expect(node.status).toBe('unknown');
  });

  it('should update an existing node on re-registration (upsert)', () => {
    const identity = getOrCreateNodeIdentity(db);

    registry.registerNode({
      id: identity.node_id,
      name: 'IKARIS',
      base_url: 'http://ikaris.local:8080',
      public_key_pem: identity.public_key_pem,
      capabilities: ['code'],
    });

    // Re-register with different URL and capabilities
    const updated = registry.registerNode({
      id: identity.node_id,
      name: 'IKARIS-v2',
      base_url: 'http://ikaris-v2.local:8080',
      public_key_pem: identity.public_key_pem,
      capabilities: ['code', 'docker', 'analysis'],
    });

    expect(updated.name).toBe('IKARIS-v2');
    expect(updated.base_url).toBe('http://ikaris-v2.local:8080');
    const caps = JSON.parse(updated.capabilities);
    expect(caps).toHaveLength(3);
  });

  it('should throw on missing required fields', () => {
    expect(() => registry.registerNode({ id: 'abc', name: 'test' })).toThrow();
    expect(() => registry.registerNode({})).toThrow();
  });
});

describe('Node Registry — getAllNodes / getNode', () => {
  it('should return all registered nodes', () => {
    createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080');
    createRegisteredNode(db, registry, 'ARIES', 'http://aries:8080');

    const nodes = registry.getAllNodes();
    expect(nodes).toHaveLength(2);
  });

  it('should return node by id', () => {
    const identity = createRegisteredNode(db, registry, 'MINERVA', 'http://minerva:8080');

    const node = registry.getNode(identity.node_id);
    expect(node.name).toBe('MINERVA');
  });

  it('should return null for non-existent node', () => {
    expect(registry.getNode('nonexistent-id')).toBeUndefined();
  });
});

describe('Node Registry — getReachableNode', () => {
  it('should return null when no nodes are online', () => {
    createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080', ['code']);
    // Node starts as 'unknown' status, not 'online'
    const node = registry.getReachableNode('code');
    expect(node).toBeNull();
  });

  it('should return an online node matching the capability', async () => {
    const ikarisIdentity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080', ['code', 'docker']);
    const ariesIdentity = createRegisteredNode(db, registry, 'ARIES', 'http://aries:8080', ['analysis']);

    // Mock fetch for IKARIS — returns signed health response
    const mockFetch = async (url) => {
      if (url.includes('ikaris')) {
        const { payload, signature } = createSignedHealthResponse(ikarisIdentity.node_id, ikarisIdentity);
        return {
          ok: true,
          json: async () => ({ payload, signature }),
        };
      }
      // ARIES returns unsigned — should be rejected
      return {
        ok: true,
        json: async () => ({ status: 'ok' }), // no signature
      };
    };

    await registry.heartbeatCycle(mockFetch, verifyPayload);

    // IKARIS should be online, ARIES should be offline (unsigned)
    const codeNode = registry.getReachableNode('code');
    expect(codeNode).not.toBeNull();
    expect(codeNode.name).toBe('IKARIS');

    const analysisNode = registry.getReachableNode('analysis');
    expect(analysisNode).toBeNull(); // ARIES was rejected for unsigned response
  });

  it('should return null when capability does not match any online node', async () => {
    const identity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080', ['code']);

    const mockFetch = async () => {
      const { payload, signature } = createSignedHealthResponse(identity.node_id, identity);
      return { ok: true, json: async () => ({ payload, signature }) };
    };

    await registry.heartbeatCycle(mockFetch, verifyPayload);

    // IKARIS is online with 'code' capability, but we ask for 'docker'
    expect(registry.getReachableNode('docker')).toBeNull();
  });

  it('should return any online node when no capability is specified', async () => {
    const identity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080', ['code']);

    const mockFetch = async () => {
      const { payload, signature } = createSignedHealthResponse(identity.node_id, identity);
      return { ok: true, json: async () => ({ payload, signature }) };
    };

    await registry.heartbeatCycle(mockFetch, verifyPayload);

    const node = registry.getReachableNode();
    expect(node).not.toBeNull();
    expect(node.name).toBe('IKARIS');
  });
});

describe('Node Registry — Liveness checks with signed heartbeats', () => {
  it('should flip a node from unknown to online on signed health response', async () => {
    const identity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080');

    const mockFetch = async () => {
      const { payload, signature } = createSignedHealthResponse(identity.node_id, identity);
      return { ok: true, json: async () => ({ payload, signature }) };
    };

    const result = await registry.checkNodeLiveness(
      registry.getNode(identity.node_id),
      mockFetch,
      verifyPayload,
    );

    expect(result).toBe(true);
    const node = registry.getNode(identity.node_id);
    expect(node.status).toBe('online');
    expect(node.last_seen_at).toBeTruthy();
  });

  it('should reject unsigned health response (no signature field)', async () => {
    const identity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080');

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok', node_id: identity.node_id }), // no signature
    });

    const result = await registry.checkNodeLiveness(
      registry.getNode(identity.node_id),
      mockFetch,
      verifyPayload,
    );

    expect(result).toBe(false);
    const node = registry.getNode(identity.node_id);
    expect(node.status).toBe('offline'); // NOT online
  });

  it('should reject health response signed by a different key (spoofing)', async () => {
    const legitimateIdentity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080');

    // Create a separate attacker identity
    const db2 = new Database(':memory:');
    const attackerIdentity = getOrCreateNodeIdentity(db2);

    const mockFetch = async () => {
      // Attacker signs with their own key but claims to be the legitimate node
      const payload = { status: 'ok', node_id: legitimateIdentity.node_id, timestamp: new Date().toISOString() };
      const signature = signPayload(attackerIdentity.private_key_pem, payload);
      return { ok: true, json: async () => ({ payload, signature }) };
    };

    const result = await registry.checkNodeLiveness(
      registry.getNode(legitimateIdentity.node_id),
      mockFetch,
      verifyPayload,
    );

    expect(result).toBe(false);
    const node = registry.getNode(legitimateIdentity.node_id);
    expect(node.status).toBe('offline'); // Forged signature rejected

    db2.close();
  });

  it('should mark a node offline when health endpoint returns error', async () => {
    const identity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080');

    const mockFetch = async () => ({ ok: false, status: 503 });

    const result = await registry.checkNodeLiveness(
      registry.getNode(identity.node_id),
      mockFetch,
      verifyPayload,
    );

    expect(result).toBe(false);
    expect(registry.getNode(identity.node_id).status).toBe('offline');
  });

  it('should mark a node offline when fetch throws (network unreachable)', async () => {
    const identity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080');

    const mockFetch = async () => { throw new Error('ECONNREFUSED'); };

    const result = await registry.checkNodeLiveness(
      registry.getNode(identity.node_id),
      mockFetch,
      verifyPayload,
    );

    expect(result).toBe(false);
    expect(registry.getNode(identity.node_id).status).toBe('offline');
  });

  it('should complete a full online → offline → online cycle', async () => {
    const identity = createRegisteredNode(db, registry, 'IKARIS', 'http://ikaris:8080');

    // Phase 1: node comes online with valid signed heartbeat
    const goodFetch = async () => {
      const { payload, signature } = createSignedHealthResponse(identity.node_id, identity);
      return { ok: true, json: async () => ({ payload, signature }) };
    };

    await registry.heartbeatCycle(goodFetch, verifyPayload);
    expect(registry.getNode(identity.node_id).status).toBe('online');

    // Phase 2: node goes offline (process killed)
    const deadFetch = async () => { throw new Error('ECONNREFUSED'); };

    await registry.heartbeatCycle(deadFetch, verifyPayload);
    expect(registry.getNode(identity.node_id).status).toBe('offline');

    // Phase 3: node restarts and comes back online
    await registry.heartbeatCycle(goodFetch, verifyPayload);
    expect(registry.getNode(identity.node_id).status).toBe('online');
  });
});

describe('Node Registry — heartbeat scheduling', () => {
  it('should start and stop heartbeat timer without error', () => {
    // Use a very short interval for testing
    registry.startHeartbeat(1000);
    // Verify it doesn't throw
    expect(() => registry.stopHeartbeat()).not.toThrow();
  });

  it('should not start a second timer if already running', () => {
    registry.startHeartbeat(1000);
    registry.startHeartbeat(500); // should be no-op
    registry.stopHeartbeat();
  });
});
