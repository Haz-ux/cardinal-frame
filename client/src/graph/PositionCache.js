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
 *
 * Validation: NEVER overwrites valid coordinates with 0, null, undefined, or NaN.
 * If previous coordinates exist and are finite, they are preserved unconditionally.
 */

import { buildAdjacency, getClusterId } from './ClusterPlanner.js';

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
        // Preserve position fields (x, y, vx, vy, fx, fy) — only refresh data fields.
        // VALIDATION: Only keep previous position if it's a finite number.
        // Never keep 0,0 as a valid position — it likely means "uninitialized."
        const oldX = existing.x;
        const oldY = existing.y;
        const oldVx = existing.vx;
        const oldVy = existing.vy;
        Object.assign(existing, freshNode);

        // Restore previous valid coordinates (never overwrite with null/undefined/NaN)
        if (Number.isFinite(oldX) && oldX !== 0) {
          existing.x = oldX;
        } else if (!Number.isFinite(existing.x)) {
          existing.x = undefined; // force re-seed by layout engine
        }
        if (Number.isFinite(oldY) && oldY !== 0) {
          existing.y = oldY;
        } else if (!Number.isFinite(existing.y)) {
          existing.y = undefined;
        }
        // Preserve velocity if previously set and valid
        if (Number.isFinite(oldVx)) existing.vx = oldVx;
        else existing.vx = existing.vx || 0;
        if (Number.isFinite(oldVy)) existing.vy = oldVy;
        else existing.vy = existing.vy || 0;

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

    // Adopt fresh links when they changed, OR when the cache was restored from a
    // snapshot (where this.links starts empty but the signature already matches).
    if (linksChanged || this.links.length === 0) {
      this.links = fresh.links;
      this.linkSignature = newSig;

      // Update clusterOf map using BFS cluster resolution (shared with ClusterPlanner).
      // This replaces the old one-hop logic that missed nodes connected through intermediaries.
      this.clusterOf.clear();
      const adj = buildAdjacency(this.links);
      for (const node of this.nodes.values()) {
        const cid = getClusterId(node, adj);
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

  /**
   * Restore the cache from a previously saved snapshot (see LayoutEngine.getSnapshot).
   * Seeds saved node positions so a reopened page keeps its last layout instead of
   * re-running a full world simulation that reshuffles clusters.
   *
   * @param {{ linkSignature?: string, nodes?: Object }} snapshot
   */
  restore(snapshot = {}) {
    this.nodes.clear();
    this.links = [];
    this.linkSignature = snapshot.linkSignature || '';
    this.clusterOf.clear();

    const nodes = snapshot.nodes || {};
    for (const [id, pos] of Object.entries(nodes)) {
      if (!pos || typeof pos.x !== 'number' || !Number.isFinite(pos.x)) continue;
      if (typeof pos.y !== 'number' || !Number.isFinite(pos.y)) continue;
      const entry = { id, x: pos.x, y: pos.y, vx: pos.vx || 0, vy: pos.vy || 0 };
      if (typeof pos.fx === 'number') {
        entry.fx = pos.fx;
        entry.fy = typeof pos.fy === 'number' ? pos.fy : pos.y;
      }
      this.nodes.set(id, entry);
    }
  }

  /**
   * Rebuild the clusterOf map from the current links (used after restore when
   * link signature matches so merge() won't recompute it).
   */
  refreshClusterOf() {
    this.clusterOf.clear();
    const adj = buildAdjacency(this.links);
    for (const node of this.nodes.values()) {
      const cid = getClusterId(node, adj);
      this.clusterOf.set(node.id, cid || 'unclustered');
    }
  }
}
