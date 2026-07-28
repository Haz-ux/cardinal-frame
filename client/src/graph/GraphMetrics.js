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
