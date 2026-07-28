/**
 * GraphMetrics — shared constants + statistics for the graph layout engine.
 *
 * Centralizes the style/size constants that were previously scattered across
 * NeuralMap.jsx as module-level constants. By importing from here, all graph
 * modules use the same values, and NeuralMap.jsx stays focused on rendering.
 */

// ─── Color palette ─────────────────────────────────────────────
export const NEON = {
  cyan: '#00f0ff', magenta: '#ff00ff', blue: '#3b82f6', purple: '#a855f7',
  green: '#22c55e', yellow: '#eab308', red: '#ef4444', pink: '#ec4899',
  orange: '#f97316', teal: '#14b8a6',
};

export const BG = { base: '#050510', card: '#0f0f23' };

// ─── Group styles (node visual + size) ─────────────────────────
export const GROUP_STYLE = {
  system: { color: NEON.magenta, size: 16, glow: true },
  cluster: { color: '#7dd3fc', size: 12, glow: false },
  provider: { color: NEON.cyan, size: 9, glow: false },
  model: { color: '#5eead4', size: 4, glow: false },
  agent: { color: NEON.green, size: 8, glow: false },
  task: { color: NEON.yellow, size: 5, glow: false },
  skill: { color: NEON.purple, size: 6, glow: false },
  tool: { color: '#f59e0b', size: 5, glow: false },
  file: { color: NEON.blue, size: 4, glow: false },
  mcp: { color: NEON.orange, size: 7, glow: false },
  dag: { color: NEON.pink, size: 6, glow: false },
  conversation: { color: NEON.teal, size: 4, glow: false },
  group: { color: '#f59e0b', size: 6, glow: false },
  user: { color: '#c084fc', size: 6, glow: false },
  plugin: { color: '#38bdf8', size: 5, glow: false },
  schedule: { color: '#fb923c', size: 5, glow: false },
  env: { color: '#a3e635', size: 3, glow: false },
  watcher: { color: '#f472b6', size: 4, glow: false },
  node: { color: '#39ff14', size: 10, glow: true },
};

export const LINK_COLORS = {
  api: NEON.cyan, registered: '#444', assigned: NEON.green, depends: NEON.yellow,
  mcp: NEON.orange, workflow: NEON.pink, chat: NEON.teal, uploaded: NEON.blue,
  workspace: '#333', imports: NEON.purple, member: '#f59e0b', group: '#f59e0b',
  hosts: '#5eead4', provides: '#f59e0b', uses: NEON.cyan, tool: '#f59e0b',
  task: NEON.yellow, config: '#a3e635', schedule: '#fb923c', plugin: '#38bdf8',
  watcher: '#f472b6', delegates: '#39ff14', bridge: '#1a1a2e',
};

export const STATUS_COLORS = {
  active: NEON.green, running: NEON.cyan, pending: NEON.yellow,
  completed: '#666', failed: NEON.red, idle: '#444', disconnected: '#333',
  unknown: '#555', online: NEON.green, offline: NEON.red, stale: NEON.yellow,
};

// ─── Rope lengths (link spring distances) ─────────────────────
export const ROPE_LENGTHS = {
  hosts: 25, uses: 30, api: 50, registered: 40, assigned: 35,
  depends: 30, mcp: 45, workflow: 40, chat: 35, uploaded: 30,
  workspace: 20, imports: 15, member: 35, group: 40, provides: 25,
  tool: 40, task: 35, config: 50, schedule: 40, plugin: 45, watcher: 50,
  delegates: 55, bridge: 200,
};

export const DEFAULT_ROPE = 35;

// ─── Layout parameters ────────────────────────────────────────
export const LAYOUT_PARAMS = {
  // World sim (cluster hubs)
  hubAlphaDecay: 0.05,
  hubVelocityDecay: 0.4,
  hubMaxTicks: 300,
  hubSettleAlpha: 0.001,

  // Per-cluster sim (nodes)
  nodeAlphaDecay: 0.0228,
  nodeVelocityDecay: 0.4,
  nodeMaxTicks: 12000,
  nodeSettleAlpha: 0.001,
  nodeWarmupTicks: 200,

  // Simulation tick rate (how often to advance per-cluster sims)
  tickIntervalMs: 16, // ~60fps

  // Boundary collision
  boundaryStrength: 0.5,
  boundaryPadding: 60,
};

/**
 * Compute graph statistics for LOD and UI display.
 *
 * @param {Array} nodes
 * @param {Array} links
 * @returns {{ nodeCount, linkCount, clusterCount, groupCounts, maxClusterSize }}
 */
export function computeMetrics(nodes, links) {
  const groupCounts = {};
  const clusterCounts = {};
  let maxClusterSize = 0;

  for (const n of nodes) {
    groupCounts[n.group] = (groupCounts[n.group] || 0) + 1;
    const cid = n.cluster ||
      (n.id && n.id.startsWith('cluster:') ? n.id.split(':')[1] : null) ||
      'unclustered';
    clusterCounts[cid] = (clusterCounts[cid] || 0) + 1;
    if (clusterCounts[cid] > maxClusterSize) maxClusterSize = clusterCounts[cid];
  }

  return {
    nodeCount: nodes.length,
    linkCount: links.length,
    clusterCount: Object.keys(clusterCounts).length,
    groupCounts,
    clusterCounts,
    maxClusterSize,
  };
}

/**
 * Full diagnostics report — called after every graph build.
 *
 * Computes:
 * - Node count, link count, cluster count
 * - Unclustered count + every unclustered node printed
 * - Nodes missing x, nodes missing y
 * - Nodes at (0,0) — these are suspect and should never happen
 * - Duplicate positions (pile-up detection)
 * - Largest/smallest/average cluster size
 * - Per-cluster breakdown
 *
 * Silent failures are not allowed — all issues are logged loudly.
 *
 * @param {Array} nodes
 * @param {Map<string, string>} nodeToCluster - nodeId → clusterId (from ClusterPlanner)
 * @returns {{ nodes, links, clusters, unclustered, missingX, missingY, atOrigin, duplicates, largest, smallest, avg }}
 */
export function computeDiagnostics(nodes, links, nodeToCluster) {
  const nodeCount = nodes.length;
  const linkCount = links.length;

  // Build cluster map
  const clusters = new Map();
  const unclustered = [];

  for (const n of nodes) {
    const cid = nodeToCluster?.get(n.id) ||
      n.cluster ||
      (n.id?.startsWith('cluster:') ? n.id.split(':')[1] : null) ||
      'unclustered';

    if (cid === 'unclustered') {
      unclustered.push({ id: n.id, group: n.group, name: n.name || n.label || '' });
    }

    if (!clusters.has(cid)) clusters.set(cid, []);
    clusters.get(cid).push(n);
  }

  // Missing coordinates
  const missingX = [];
  const missingY = [];
  const atOrigin = [];

  for (const n of nodes) {
    const hasX = typeof n.x === 'number' && Number.isFinite(n.x);
    const hasY = typeof n.y === 'number' && Number.isFinite(n.y);

    if (!hasX) missingX.push({ id: n.id, group: n.group, x: n.x });
    if (!hasY) missingY.push({ id: n.id, group: n.group, y: n.y });

    // (0,0) is a suspect position — it means "uninitialized" not "center"
    if (hasX && hasY && n.x === 0 && n.y === 0) {
      atOrigin.push({ id: n.id, group: n.group });
    }
  }

  // Duplicate positions (pile-up detection)
  const posMap = new Map(); // "x,y" → [nodeIds]
  for (const n of nodes) {
    if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
    const key = `${Math.round(n.x)},${Math.round(n.y)}`;
    if (!posMap.has(key)) posMap.set(key, []);
    posMap.get(key).push(n);
  }
  const duplicates = [];
  for (const [pos, ns] of posMap) {
    if (ns.length > 1) {
      // Only flag as pile-up if 3+ nodes at exact same rounded position,
      // or 2+ nodes that are not a hub+satellite pair
      if (ns.length >= 3) {
        duplicates.push({ position: pos, count: ns.length, nodes: ns.map(n => ({ id: n.id, group: n.group })) });
      }
    }
  }

  // Cluster size statistics
  const clusterSizes = [];
  for (const [cid, ns] of clusters) {
    clusterSizes.push({ cluster: cid, count: ns.length });
  }
  clusterSizes.sort((a, b) => b.count - a.count);

  const largest = clusterSizes[0] || { cluster: 'none', count: 0 };
  const smallest = clusterSizes[clusterSizes.length - 1] || { cluster: 'none', count: 0 };
  const avg = clusterSizes.length > 0
    ? Math.round(clusterSizes.reduce((sum, c) => sum + c.count, 0) / clusterSizes.length * 10) / 10
    : 0;

  // Log summary
  if (typeof console !== 'undefined') {
    const fmt = 'color: #00f0ff';
    console.groupCollapsed('%c[Graph Diagnostics]', fmt, `${nodeCount} nodes, ${linkCount} links, ${clusters.size} clusters`);
    console.log('%c  Nodes:', fmt, nodeCount);
    console.log('%c  Links:', fmt, linkCount);
    console.log('%c  Clusters:', fmt, clusters.size);
    console.log('%c  Unclustered:', fmt, unclustered.length,
      unclustered.length > 0 ? unclustered : '');
    console.log('%c  Missing X:', fmt, missingX.length,
      missingX.length > 0 ? missingX : '');
    console.log('%c  Missing Y:', fmt, missingY.length,
      missingY.length > 0 ? missingY : '');
    console.log('%c  At (0,0):', fmt, atOrigin.length,
      atOrigin.length > 0 ? atOrigin : '');
    console.log('%c  Duplicates (pile-ups):', fmt, duplicates.length,
      duplicates.length > 0 ? duplicates : '');

    // Per-cluster breakdown
    console.groupCollapsed('%c  Per-cluster sizes:', fmt);
    for (const c of clusterSizes) {
      console.log(`    ${c.cluster}: ${c.count} nodes`);
    }
    console.groupEnd();

    console.log('%c  Largest cluster:', fmt, largest.cluster, largest.count);
    console.log('%c  Smallest cluster:', fmt, smallest.cluster, smallest.count);
    console.log('%c  Average cluster size:', fmt, avg);

    // For every unclustered node, print neighbors + resolved cluster + reason
    if (unclustered.length > 0) {
      console.group('%c  Unclustered node details:', 'color: #ef4444');
      for (const u of unclustered) {
        const node = nodes.find(n => n.id === u.id);
        const neighbors = [];
        for (const l of links) {
          const s = typeof l.source === 'object' ? l.source.id : l.source;
          const t = typeof l.target === 'object' ? l.target.id : l.target;
          if (s === u.id) neighbors.push({ target: t, type: l.type });
          if (t === u.id) neighbors.push({ target: s, type: l.type });
        }
        console.warn(`    ${u.group} ${u.id}: ${neighbors.length} neighbors`,
          neighbors.map(n => n.target));
      }
      console.groupEnd();
    }

    console.groupEnd();
  }

  return {
    nodes: nodeCount,
    links: linkCount,
    clusters: clusters.size,
    unclustered: unclustered.length,
    missingX: missingX.length,
    missingY: missingY.length,
    atOrigin: atOrigin.length,
    duplicates: duplicates.length,
    largest,
    smallest,
    avg,
    clusterSizes,
  };
}

/**
 * Determine the LOD (Level of Detail) based on node count and zoom.
 *
 * @param {number} nodeCount
 * @param {number} zoom
 * @returns {0|1|2} 0=minimal, 1=basic, 2=full
 */
export function computeLOD(nodeCount, zoom = 1) {
  if (nodeCount > 200 || zoom < 0.4) return 0;
  if (nodeCount > 100 || zoom < 0.8) return 1;
  return 2;
}
