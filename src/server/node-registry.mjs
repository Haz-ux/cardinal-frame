/**
 * Cardinal Frame — Node Registry
 *
 * Tracks known nodes (IKARIS, ARIES, MINERVA) and their liveness status
 * for routing decisions. Uses signed heartbeats (Ed25519) to verify
 * health responses actually come from the claimed node.
 *
 * SCOPE: This registry answers "should I send NEW work here right now?"
 * It does NOT handle recovery of in-flight work — each node owns its own
 * recovery via its local job queue (see Task 2).
 *
 * Reuses heartbeat.mjs scheduling pattern — no second scheduler.
 */

import { verifyPayload } from './node-identity.mjs';

const HEARTBEAT_INTERVAL_MS = 30_000; // 30s
const OFFLINE_THRESHOLD_MS = 90_000;  // 3 missed heartbeats = offline

/**
 * Initialize the node registry — creates tables, returns helper functions.
 * Call once at server boot.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ registerNode, getNode, getAllNodes, getReachableNode, startHeartbeat, stopHeartbeat, updateNodeStatus }}
 */
export function initNodeRegistry(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,              -- cryptographic node_id from Task 0
      name TEXT NOT NULL,              -- display label (IKARIS, ARIES, MINERVA)
      base_url TEXT NOT NULL,          -- e.g. http://ikaris.local:8080
      public_key_pem TEXT NOT NULL,    -- for verifying signed responses
      last_seen_at TEXT,               -- ISO timestamp of last successful heartbeat
      status TEXT DEFAULT 'unknown',   -- 'online' | 'offline' | 'unknown'
      capabilities TEXT DEFAULT '[]',  -- JSON array of capability strings
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
  `);

  const stmts = {
    insert: db.prepare(`
      INSERT INTO nodes (id, name, base_url, public_key_pem, status, capabilities)
      VALUES (?, ?, ?, ?, 'unknown', ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        public_key_pem = excluded.public_key_pem,
        capabilities = excluded.capabilities,
        updated_at = datetime('now')
    `),
    getById: db.prepare('SELECT * FROM nodes WHERE id = ?'),
    getByName: db.prepare('SELECT * FROM nodes WHERE name = ?'),
    getAll: db.prepare('SELECT * FROM nodes ORDER BY name'),
    getByStatus: db.prepare('SELECT * FROM nodes WHERE status = ? ORDER BY name'),
    updateLastSeen: db.prepare(`
      UPDATE nodes SET last_seen_at = datetime('now'), status = 'online', updated_at = datetime('now')
      WHERE id = ?
    `),
    updateStatus: db.prepare(`
      UPDATE nodes SET status = ?, updated_at = datetime('now') WHERE id = ?
    `),
    getOnlineWithCapability: db.prepare(`
      SELECT * FROM nodes WHERE status = 'online'
      ORDER BY last_seen_at DESC
    `),
  };

  let heartbeatTimer = null;
  let heartbeatFn = null; // injectable for testing

  /**
   * Register or update a node in the registry.
   * The public key is used to verify signed health responses.
   */
  function registerNode({ id, name, base_url, public_key_pem, capabilities = [] }) {
    if (!id || !name || !base_url || !public_key_pem) {
      throw new Error('id, name, base_url, and public_key_pem are required');
    }
    stmts.insert.run(id, name, base_url, public_key_pem, JSON.stringify(capabilities));
    return stmts.getById.get(id);
  }

  function getNode(id) {
    return stmts.getById.get(id);
  }

  function getNodeByName(name) {
    return stmts.getByName.get(name);
  }

  function getAllNodes() {
    return stmts.getAll.all().map(parseNode);
  }

  function parseNode(row) {
    if (!row) return null;
    return {
      ...row,
      capabilities: JSON.parse(row.capabilities || '[]'),
    };
  }

  /**
   * Get the best available node that claims a given capability
   * and is currently online.
   *
   * @param {string} capability — e.g. 'code', 'analysis', 'docker'
   * @returns {object|null} node row or null if none qualify
   */
  function getReachableNode(capability) {
    const onlineNodes = stmts.getOnlineWithCapability.all();

    if (!capability) {
      // No capability filter — return any online node
      return parseNode(onlineNodes[0] || null);
    }

    // Filter by capability (case-insensitive substring match)
    for (const node of onlineNodes) {
      const caps = JSON.parse(node.capabilities || '[]');
      if (caps.some(c => c.toLowerCase().includes(capability.toLowerCase()))) {
        return parseNode(node);
      }
    }

    return null;
  }

  /**
   * Mark a node's status (online/offline/unknown).
   */
  function updateNodeStatus(nodeId, status) {
    stmts.updateStatus.run(status, nodeId);
  }

  /**
   * Check a single node's liveness by pinging its /api/health endpoint.
   * Verifies the response signature before flipping status to online.
   *
   * @param {object} node — row from nodes table
   * @param {function} fetchFn — injectable fetch (for testing)
   * @param {function} verifyFn — injectable verify (for testing)
   * @returns {Promise<boolean>} true if node is alive and verified
   */
  async function checkNodeLiveness(node, fetchFn = globalThis.fetch, verifyFn = verifyPayload) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const resp = await fetchFn(`${node.base_url}/api/health`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        updateNodeStatus(node.id, 'offline');
        return false;
      }

      const body = await resp.json();

      // Verify the health response is signed by this node
      // The response should contain: { status, node_id, timestamp, signature }
      if (!body.signature || !body.payload) {
        // Unsigned health response — reject for security
        updateNodeStatus(node.id, 'offline');
        return false;
      }

      // Verify the signature against this node's public key
      const isValid = verifyFn(node.public_key_pem, body.payload, body.signature);
      if (!isValid) {
        // Forged or spoofed response — do NOT flip to online
        updateNodeStatus(node.id, 'offline');
        return false;
      }

      // Signature verified — node is alive and authentic
      stmts.updateLastSeen.run(node.id);
      return true;
    } catch {
      // Network error, timeout, etc.
      updateNodeStatus(node.id, 'offline');
      return false;
    }
  }

  /**
   * Run a single heartbeat cycle — check all registered nodes' liveness.
   * Also mark nodes as offline if they haven't been seen recently.
   */
  async function heartbeatCycle(fetchFn, verifyFn) {
    const nodes = stmts.getAll.all();
    const now = Date.now();

    for (const node of nodes) {
      // Check if node should be marked offline due to timeout
      if (node.last_seen_at) {
        const lastSeen = new Date(node.last_seen_at + 'Z').getTime();
        if (now - lastSeen > OFFLINE_THRESHOLD_MS && node.status === 'online') {
          updateNodeStatus(node.id, 'offline');
          continue; // Skip the ping — already stale
        }
      }

      await checkNodeLiveness(node, fetchFn, verifyFn);
    }
  }

  /**
   * Start the periodic heartbeat checker.
   * Reuses the same setInterval + unref pattern from HeartbeatDaemon.
   */
  function startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS, fetchFn, verifyFn) {
    if (heartbeatTimer) return;

    // Run first cycle immediately
    heartbeatCycle(fetchFn, verifyFn).catch(() => {});

    heartbeatTimer = setInterval(() => {
      heartbeatCycle(fetchFn, verifyFn).catch(() => {});
    }, intervalMs);
    heartbeatTimer.unref(); // Don't block graceful shutdown
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return {
    registerNode,
    getNode,
    getNodeByName,
    getAllNodes,
    getReachableNode,
    updateNodeStatus,
    checkNodeLiveness,
    heartbeatCycle,
    startHeartbeat,
    stopHeartbeat,
    _stmts: stmts, // exposed for testing
  };
}
