/**
 * PositionCache — stable node identity + position tracking across data updates.
 *
 * Solves the "simulation reset on every poll" problem by:
 * 1. Maintaining a Map of nodeId → node object (stable reference)
 * 2. On data update: Object.assign fresh data into existing nodes (keeps x/y)
 * 3. Tracking which nodes are new (need position seeding)
 * 4. Tracking which nodes were removed (need cleanup)
 *
 * This is the bridge between the API poller and the layout engine.
 * The layout engine asks PositionCache "what changed?" and only touches
 * the simulation for affected clusters.
 */

export class PositionCache {
  constructor() {
    this.nodes = new Map();      // id → node object (stable ref, mutated by d3-force)
    this.links = [];             // current link array (reused if unchanged)
    this.linkSignature = '';     // hash of link set — detects structural changes
    this.clusterOf = new Map();  // nodeId → clusterId
  }

  /**
   * Merge fresh data from the API into the cache.
   * Returns a diff describing what changed.
   *
   * @param {{ nodes: Array, links: Array }} fresh
   * @returns {{ newNodes: Array, removedNodes: Array, changedNodes: Array, linksChanged: boolean }}
   */
  merge(fresh) {
    const newNodes = [];
    const removedNodes = [];
    const changedNodes = [];

    // Mark all existing nodes as "pending removal" — unmarked after merge
    const seen = new Set();

    // Merge node data
    for (const freshNode of fresh.nodes) {
      seen.add(freshNode.id);
      const existing = this.nodes.get(freshNode.id);

      if (existing) {
        // Keep position (x, y, vx, vy, fx, fy) — only refresh data fields
        // Store old position to detect if it was moved externally
        const oldX = existing.x;
        const oldY = existing.y;
        Object.assign(existing, freshNode);
        existing.x = oldX;
        existing.y = oldY;
        changedNodes.push(existing);
      } else {
        // New node — will be seeded by the layout engine
        this.nodes.set(freshNode.id, freshNode);
        newNodes.push(freshNode);
      }
    }

    // Detect removed nodes
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        removedNodes.push(node);
        this.nodes.delete(id);
      }
    }

    // Detect link changes via signature comparison
    const newSig = this._linkSignature(fresh.links);
    const linksChanged = newSig !== this.linkSignature;

    if (linksChanged) {
      this.links = fresh.links;
      this.linkSignature = newSig;

      // Update clusterOf map by re-scanning cluster assignments
      this.clusterOf.clear();
      for (const node of this.nodes.values()) {
        let cid = node.cluster || null;
        if (!cid && node.id?.startsWith('cluster:')) cid = node.id.split(':')[1];
        if (!cid) {
          // Non-cluster node: find which cluster it links to
          for (const link of this.links) {
            const sId = typeof link.source === 'object' ? link.source.id : link.source;
            const tId = typeof link.target === 'object' ? link.target.id : link.target;
            if (sId === node.id && tId?.startsWith('cluster:')) { cid = tId.split(':')[1]; break; }
            if (tId === node.id && sId?.startsWith('cluster:')) { cid = sId.split(':')[1]; break; }
          }
        }
        this.clusterOf.set(node.id, cid || 'unclustered');
      }
    }

    return { newNodes, removedNodes, changedNodes, linksChanged };
  }

  /**
   * Get a node by ID (stable object reference — same object the simulation mutates).
   */
  get(id) {
    return this.nodes.get(id);
  }

  /**
   * Get all nodes as an array.
   */
  allNodes() {
    return Array.from(this.nodes.values());
  }

  /**
   * Get the cluster ID for a node.
   */
  getCluster(nodeId) {
    return this.clusterOf.get(nodeId) || 'unclustered';
  }

  /**
   * Compute a compact signature for the link set.
   * Signature = sorted "src→tgt:type" joined by |.
   * Order-independent: same links in different order → same signature.
   */
  _linkSignature(links) {
    const parts = links.map(l => {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      // Canonicalize direction to avoid counting A→B and B→A as different
      const [a, b] = s < t ? [s, t] : [t, s];
      return `${a}→${b}:${l.type || '?'}`;
    });
    parts.sort();
    return parts.join('|');
  }

  /**
   * Clear the cache entirely (e.g., on logout).
   */
  clear() {
    this.nodes.clear();
    this.links = [];
    this.linkSignature = '';
    this.clusterOf.clear();
  }
}
