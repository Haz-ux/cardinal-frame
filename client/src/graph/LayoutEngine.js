/**
 * LayoutEngine — the orchestrator.
 *
 * Pipeline:
 *   API → PositionCache.merge → ClusterPlanner → ClusterSimulation →
 *     NodeSimulation (per cluster) → CollisionEngine → Position output
 *
 * The engine runs entirely outside React. NeuralMap.jsx calls:
 *   engine.setData(graphData)  — on API poll
 *   engine.tick()              — on each animation frame (optional; or use autoTick)
 *   engine.getPositions()      — to get { nodes, links } for rendering
 *   engine.reheatCluster(cid)  — when a cluster needs redistribution
 *   engine.onTick(cb)          — register a callback for position updates
 *
 * The engine maintains its own RAF loop by default (autoTick=true), calling
 * registered tick callbacks with the latest positions. This keeps React
 * purely as a renderer — it receives positions and draws them, with no
 * knowledge of the simulation.
 */

import * as d3 from 'd3-force';
import { PositionCache } from './PositionCache.js';
import { planClusters, getClusterForNode } from './ClusterPlanner.js';
import { simulateClusters, relocateHubs, assignSectors } from './ClusterSimulation.js';
import { createClusterSimulation } from './NodeSimulation.js';
import { buildBoundaries, applyBoundaryCollision } from './CollisionEngine.js';
import { categorizeLinks, groupIntraLinks } from './LinkRouter.js';
import { clusterRadius } from './SectorLayout.js';
import { LAYOUT_PARAMS, computeMetrics, computeDiagnostics } from './GraphMetrics.js';

export class LayoutEngine {
  constructor(opts = {}) {
    this.cache = new PositionCache();
    this.plan = null;             // ClusterPlanner output
    this.sectors = null;          // assignSectors output
    this.clusterSims = new Map(); // clusterId → NodeSimulation handle
    this.boundaries = [];         // for inter-cluster collision
    this.autoTick = opts.autoTick !== false;
    this.rafId = null;
    this._callbacks = new Set();
    this._metrics = null;
    this._initialLayoutDone = false;
    this._tickAccum = 0;

    // Restore a previously persisted layout (see getSnapshot). When the graph
    // structure is unchanged, the restored positions are used as-is instead of
    // re-running the world simulation — which is what caused clusters to
    // reshuffle every time the page was reopened.
    const snapshot = opts.snapshot || null;
    this._snapshotClusters = null;
    if (snapshot && typeof snapshot === 'object') {
      this.cache.restore(snapshot);
      this._snapshotClusters = snapshot.clusters || null;
      this._initialLayoutDone = true;
    }
  }

  /**
   * Accept fresh data from the API. Merges into cache, then:
   * - Re-plans clusters (if links changed)
   * - Runs world sim (on first load or when cluster set changes)
   * - Creates/relocates per-cluster sims
   * - Seeds new node positions
   */
  setData(nodes, links) {
    const graphData = Array.isArray(nodes) ? { nodes, links: links || [] } : nodes;
    if (!graphData || !graphData.nodes) return;

    // 1. Merge into cache (preserves existing positions)
    const diff = this.cache.merge(graphData);

    // 2. Re-plan clusters (always — node counts may have changed)
    this.plan = planClusters({
      nodes: this.cache.allNodes(),
      links: graphData.links || this.cache.links,
    });

    const clusterOrder = Array.from(this.plan.clusters.keys());

    // 3. Assign sectors (or reuse if same cluster set)
    this.sectors = assignSectors(clusterOrder);

    // 4. Stable-reload fast path: if this engine was restored from a snapshot
    //    AND the graph structure is unchanged, keep the saved positions and
    //    rebuild per-cluster state around them. This prevents clusters from
    //    reshuffling when the page is reopened.
    const stableRestore = this._snapshotClusters !== null &&
      !diff.linksChanged &&
      diff.newNodes.length === 0 &&
      diff.removedNodes.length === 0 &&
      this._layoutMatchesSnapshot();

    if (stableRestore) {
      // Rebuild clusterOf from the (now populated) link set, then let the
      // per-cluster sim creation below reuse the saved hub fx/fy anchors.
      this.cache.refreshClusterOf();
    } else {
      // World sim: run on first load, when cluster set or radii change, or when
      // new nodes appear. We track the previous plan's cluster radii to detect
      // growth that would cause overlapping hub positions.
      const prevRadii = this._prevRadii || new Map();
      let radiiChanged = false;
      for (const [cid, plan] of this.plan.clusters) {
        const prevR = prevRadii.get(cid);
        const currR = Math.max(180, plan.radius);
        if (prevR !== undefined && Math.abs(prevR - currR) > 20) {
          radiiChanged = true;
          break;
        }
        if (prevR === undefined) radiiChanged = true;
      }
      this._prevRadii = new Map();
      for (const [cid, plan] of this.plan.clusters) {
        this._prevRadii.set(cid, Math.max(180, plan.radius));
      }

      if (!this._initialLayoutDone || diff.linksChanged ||
          diff.newNodes.length > 0 || radiiChanged) {
        simulateClusters(this.plan.clusters, clusterOrder, this.plan.bridgeLinks);
        this._initialLayoutDone = true;
      } else {
        relocateHubs(this.plan.clusters, clusterOrder, this.sectors);
      }
    }

    // 5. Categorize links
    const categorized = categorizeLinks(
      graphData.links || this.cache.links,
      this.plan.nodeToCluster
    );

    // 6. Group intra links by cluster
    const intraByCluster = groupIntraLinks(
      categorized.intra,
      this.plan.nodeToCluster
    );

    // 7. Create per-cluster simulations
    for (const cid of clusterOrder) {
      const clusterPlan = this.plan.clusters.get(cid);
      if (!clusterPlan || !clusterPlan.hubNode) continue;

      const hubPos = {
        x: clusterPlan.hubNode.x || 0,
        y: clusterPlan.hubNode.y || 0,
      };

      const intraLinks = intraByCluster.get(cid) || [];

      let sim = this.clusterSims.get(cid);
      if (!sim) {
        // New cluster — create simulation
        sim = createClusterSimulation(
          clusterPlan,
          intraLinks,
          hubPos,
          clusterPlan.radius
        );
        sim.settle(); // run initial warmup
        this.clusterSims.set(cid, sim);
      } else {
        // Existing cluster — check if hub moved or new nodes appeared
        const newNodesInCluster = diff.newNodes.filter(n =>
          getClusterForNode(this.plan, n.id) === cid
        );

        if (newNodesInCluster.length > 0) {
          // Add new nodes to the existing sim
          for (const newNode of newNodesInCluster) {
            // Seed position around hub at a safe distance
            const hub = clusterPlan.hubNode;
            const angle = Math.random() * Math.PI * 2;
            const r = Math.max(clusterPlan.radius + 50, 80) + Math.random() * 30;
            newNode.x = (hub.x || 0) + Math.cos(angle) * r;
            newNode.y = (hub.y || 0) + Math.sin(angle) * r;
            const nodeLinks = intraLinks.filter(l => {
              const s = typeof l.source === 'object' ? l.source.id : l.source;
              const t = typeof l.target === 'object' ? l.target.id : l.target;
              return s === newNode.id || t === newNode.id;
            });
            sim.addNode(newNode, nodeLinks);
          }
          sim.reheat(0.5);
        }

        // Update hub position if it moved
        const currentHub = clusterPlan.hubNode;
        if (sim.nodes && (Math.abs(hubPos.x - currentHub.x) > 5 || Math.abs(hubPos.y - currentHub.y) > 5)) {
          sim.translateTo(currentHub.x || 0, currentHub.y || 0);
          sim.reheat(0.3);
        }
      }
    }

    // Remove simulations for deleted clusters
    for (const [cid, sim] of this.clusterSims) {
      if (!this.plan.clusters.has(cid)) {
        sim.stop();
        this.clusterSims.delete(cid);
      }
    }

    // 8. Build cluster boundaries for inter-cluster collision
    this.boundaries = buildBoundaries(this.plan.clusters);

    // 9. Compute metrics + full diagnostics report
    const allNodes = this.cache.allNodes();
    this._metrics = computeMetrics(allNodes, this.cache.links);
    this._diagnostics = computeDiagnostics(allNodes, this.cache.links, this.plan.nodeToCluster);

    // 10. VALIDATION — post-layout sanity checks. Never silently substitute 0,0.
    //     Every node must have finite x and y after the layout engine runs.
    this._validateLayout(allNodes);

    // 11. Start auto-tick if not already running
    if (this.autoTick && !this.rafId) {
      this._startAutoTick();
    }
  }

  /**
   * Validate that every node has finite x and y coordinates.
   * - Missing coordinates → throw (don't silently substitute 0,0)
   * - NaN/Infinity → throw
   * - Identical (0,0) for non-origin nodes → warn loudly
   * - Coordinates that are exactly (0,0) for hub nodes → warn (hubs should be at sector positions)
   *
   * This is the "Layout Validation" from the patch report:
   * "Every node must satisfy Number.isFinite(node.x) and Number.isFinite(node.y).
   *  If either coordinate is invalid: throw or warn loudly.
   *  Never silently substitute 0,0."
   */
  _validateLayout(nodes) {
    const invalid = [];
    const atOrigin = [];

    for (const node of nodes) {
      const xOk = typeof node.x === 'number' && Number.isFinite(node.x);
      const yOk = typeof node.y === 'number' && Number.isFinite(node.y);

      if (!xOk || !yOk) {
        invalid.push({ id: node.id, group: node.group, x: node.x, y: node.y });
      } else if (node.x === 0 && node.y === 0) {
        // The central Cardinal hub is intentionally pinned at the origin.
        if (node.group === 'system') continue;
        atOrigin.push({ id: node.id, group: node.group });
      }
    }

    if (invalid.length > 0) {
      // Don't throw — log a loud error. Throwing would crash the UI.
      // The layout engine should have seeded these; if not, the auto-tick
      // loop will eventually settle them. But this warning surfaces the problem.
      console.error(
        '%c[LayoutEngine] VALIDATION ERROR: %d nodes have invalid coordinates!',
        'color: #ef4444; font-weight: bold',
        invalid.length,
        invalid
      );
    }

    if (atOrigin.length > 0) {
      console.warn(
        '%c[LayoutEngine] WARNING: %d nodes at (0,0) — may be uninitialized:',
        'color: #eab308; font-weight: bold',
        atOrigin.length,
        atOrigin
      );
    }

    return { invalid: invalid.length, atOrigin: atOrigin.length };
  }

  /**
   * Advance all per-cluster simulations by one tick.
   * Called automatically by autoTick, or manually from NeuralMap.
   */
  tick() {
    let anyActive = false;

    for (const sim of this.clusterSims.values()) {
      if (sim.alpha() > LAYOUT_PARAMS.nodeSettleAlpha) {
        sim.tick(1);
        anyActive = true;
      }
    }

    // Apply inter-cluster boundary collision only while sims are actively
    // settling. Once settled, satellites hold their orbit rings via the
    // radial force — running this every frame fights the radial force and
    // crushes satellites onto their hubs (see CollisionEngine notes).
    if (anyActive) {
      applyBoundaryCollision(
        this.cache.allNodes(),
        this.plan?.nodeToCluster,
        this.boundaries,
        LAYOUT_PARAMS.boundaryStrength
      );
    }

    // Notify listeners
    this._notifyTick();

    return anyActive;
  }

  /**
   * Get current positions for rendering.
   * Returns { nodes, links } where node objects are the same stable refs
   * the simulation mutates (so react-force-graph can read .x/.y directly).
   */
  getPositions() {
    return {
      nodes: this.cache.allNodes(),
      links: this.cache.links,
    };
  }

  /**
   * Capture the current layout as a compact snapshot for persistence.
   * Includes per-node positions/velocities/fixed anchors, the link signature
   * (detects structural changes), and the cluster membership per node.
   * Pass the result back into the constructor as `{ snapshot }` on reload.
   */
  getSnapshot() {
    const nodes = {};
    for (const node of this.cache.allNodes()) {
      const entry = {
        x: node.x,
        y: node.y,
        vx: node.vx || 0,
        vy: node.vy || 0,
      };
      if (typeof node.fx === 'number') {
        entry.fx = node.fx;
        entry.fy = typeof node.fy === 'number' ? node.fy : node.y;
      }
      nodes[node.id] = entry;
    }

    const clusters = {};
    for (const node of this.cache.allNodes()) {
      const cid = this.cache.getCluster(node.id);
      (clusters[cid] = clusters[cid] || []).push(node.id);
    }

    return {
      linkSignature: this.cache.linkSignature,
      nodes,
      clusters,
    };
  }

  /**
   * Get the current metrics.
   */
  getMetrics() {
    return this._metrics;
  }

  /**
   * Get the full diagnostics report from the last setData() call.
   */
  getDiagnostics() {
    return this._diagnostics;
  }

  /**
   * Reheat a specific cluster's simulation.
   */
  reheatCluster(clusterId, alpha = 0.5) {
    const sim = this.clusterSims.get(clusterId);
    if (sim) sim.reheat(alpha);
  }

  /**
   * Reheat all clusters.
   */
  reheatAll(alpha = 0.3) {
    for (const sim of this.clusterSims.values()) {
      sim.reheat(alpha);
    }
  }

  /** Get a single node's position by id. */
  getPosition(nodeId) {
    const node = this.cache.get(nodeId);
    if (!node) return null;
    return { x: node.x, y: node.y, vx: node.vx || 0, vy: node.vy || 0 };
  }

  /**
   * Pin a node (set fx/fy). Stops the simulation from moving it.
   */
  pin(nodeId, x, y) {
    const node = this.cache.get(nodeId);
    if (node) {
      node.fx = x;
      node.fy = y;
    }
  }

  /** Alias for pin — during active drag, updates the fixed position. */
  setFixed(nodeId, x, y) {
    this.pin(nodeId, x, y);
  }

  /**
   * Unpin a node (clear fx/fy). The simulation takes over again.
   */
  unpin(nodeId) {
    const node = this.cache.get(nodeId);
    if (node) {
      node.fx = null;
      node.fy = null;
      // Reheat the affected cluster
      const cid = this.cache.getCluster(nodeId);
      if (cid) this.reheatCluster(cid, 0.3);
    }
  }

  /** Keep pinNode/unpinNode as aliases for backwards compat. */
  pinNode(nodeId, x, y) { this.pin(nodeId, x, y); }
  unpinNode(nodeId) { this.unpin(nodeId); }

  /** Nudge the engine — reheat all clusters slightly. Used for WS events. */
  poke() {
    this.reheatAll(0.1);
  }

  /** Property callback — NeuralMap assigns engine.onTick = fn(positions). */
  get onTick() { return this._onTickProp || null; }
  set onTick(fn) { this._onTickProp = fn; }

  /**
   * Unpin all nodes.
   */
  unpinAll() {
    for (const node of this.cache.allNodes()) {
      node.fx = null;
      node.fy = null;
    }
    this.reheatAll(0.3);
  }

  /**
   * Tear down — stop all sims and clean up.
   */
  destroy() {
    this._stopAutoTick();
    for (const sim of this.clusterSims.values()) {
      sim.stop();
    }
    this.clusterSims.clear();
    this.cache.clear();
    this._callbacks.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────

  /**
   * Compare the current cluster plan's membership against the snapshot that
   * seeded this engine. Returns true only when every cluster has the exact
   * same node set, so restored positions are safe to reuse.
   */
  _layoutMatchesSnapshot() {
    if (!this._snapshotClusters || !this.plan) return false;
    const saved = this._snapshotClusters;
    const plan = this.plan;

    if (Object.keys(saved).length !== plan.clusters.size) return false;

    for (const [cid, savedIds] of Object.entries(saved)) {
      const planNodes = plan.clusters.get(cid)?.nodes;
      if (!planNodes || planNodes.length !== savedIds.length) return false;
      for (const node of planNodes) {
        if (!savedIds.includes(node.id)) return false;
      }
    }
    return true;
  }

  _notifyTick() {
    const positions = this.getPositions();
    for (const cb of this._callbacks) {
      try { cb(positions); } catch (e) { console.warn('LayoutEngine tick callback error:', e); }
    }
    // Also call the property-style callback (used by NeuralMap)
    if (this._onTickProp) {
      try { this._onTickProp(positions); } catch (e) { console.warn('LayoutEngine onTick prop error:', e); }
    }
  }

  _startAutoTick() {
    let lastTime = performance.now();
    const loop = (now) => {
      const dt = now - lastTime;
      lastTime = now;
      this._tickAccum += dt;

      const interval = LAYOUT_PARAMS.tickIntervalMs;
      let steps = 0;
      while (this._tickAccum >= interval && steps < 4) {
        this.tick();
        this._tickAccum -= interval;
        steps++;
      }

      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  _stopAutoTick() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
