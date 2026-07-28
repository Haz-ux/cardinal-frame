/**
 * ClusterPlanner — groups raw graph nodes into clusters and computes
 * per-cluster metadata needed by the layout engine.
 *
 * Input:  { nodes: [...], links: [...] }
 * Output: {
 *   clusters: Map<clusterId, ClusterPlan>,
 *   nodeToCluster: Map<nodeId, clusterId>,
 *   bridgeLinks: [...],   // links between different clusters
 *   intraLinks: [...],    // links within same cluster
 * }
 *
 * A ClusterPlan contains:
 *   id, nodes: [...], nodeCount, linkCount, bridgeLinkCount,
 *   density, radius, hubNode (the cluster:xxx node or first node)
 */

import { clusterRadius } from './SectorLayout.js';

/**
 * Build an undirected adjacency map from the link list.
 * Exported so PositionCache can reuse the same BFS logic.
 */
export function buildAdjacency(links) {
  const adj = new Map(); // nodeId → Set<neighborId>
  for (const link of links) {
    const sId = typeof link.source === 'object' ? link.source.id : link.source;
    const tId = typeof link.target === 'object' ? link.target.id : link.target;
    if (!sId || !tId) continue;
    if (!adj.has(sId)) adj.set(sId, new Set());
    if (!adj.has(tId)) adj.set(tId, new Set());
    adj.get(sId).add(tId);
    adj.get(tId).add(sId);
  }
  return adj;
}

/**
 * Extract cluster ID from a node using BFS traversal.
 *
 * Resolution order:
 * 1. If node.cluster exists, use it.
 * 2. If node IS a cluster hub (id starts with 'cluster:'), extract from id.
 * 3. BFS through the graph from this node — the first reachable cluster hub wins.
 *    Traversal depth is unlimited. Do NOT stop after one hop.
 * 4. Only return 'unclustered' if absolutely no cluster is reachable.
 *
 * This replaces the previous one-hop lookup that missed nodes connected
 * through intermediaries (e.g., tool → model → provider → cluster:xxx).
 *
 * Results are cached per-planner-call via the adjacency map.
 */
export function getClusterId(node, adj) {
  if (node.cluster) return node.cluster;
  if (node.id && node.id.startsWith('cluster:')) return node.id.split(':')[1];
  if (node.group === 'cluster' && node.id) return node.id.split(':')[1] || node.group;
  // BFS — first reachable cluster hub wins
  if (adj && adj.has(node.id)) {
    const visited = new Set([node.id]);
    const queue = [node.id];
    while (queue.length > 0) {
      const cur = queue.shift();
      const neighbors = adj.get(cur);
      if (!neighbors) continue;
      for (const n of neighbors) {
        if (visited.has(n)) continue;
        visited.add(n);
        if (n.startsWith('cluster:')) return n.split(':')[1];
        queue.push(n);
      }
    }
  }
  return 'unclustered';
}

/**
 * @param {{ nodes: Array, links: Array }} graphData
 * @returns {object} plan
 */
export function planClusters(graphData) {
  const { nodes, links } = graphData;
  const nodeToCluster = new Map();
  const clusters = new Map();

  // Build adjacency map once — used by BFS cluster resolution for all nodes.
  // This is O(links) to build and O(nodes + links) to traverse for all BFS calls.
  const adj = buildAdjacency(links || []);

  // Pass 1: group nodes by cluster (BFS resolution)
  for (const node of nodes) {
    const cid = getClusterId(node, adj);
    nodeToCluster.set(node.id, cid);

    if (!clusters.has(cid)) {
      clusters.set(cid, {
        id: cid,
        nodes: [],
        nodeCount: 0,
        linkCount: 0,
        bridgeLinkCount: 0,
        density: 0,
        radius: 0,
        hubNode: null,
        isHub: false,
      });
    }

    const plan = clusters.get(cid);
    plan.nodes.push(node);
    plan.nodeCount++;

    // Identify the hub node (group === 'cluster' or first node)
    if (node.group === 'cluster' || node.id?.startsWith('cluster:')) {
      plan.hubNode = node;
      plan.isHub = true;
    } else if (!plan.hubNode) {
      plan.hubNode = node; // fallback if no explicit hub
    }
  }

  // Pass 2: compute link counts + bridge vs intra
  const bridgeLinks = [];
  const intraLinks = [];

  for (const link of links) {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const srcCluster = nodeToCluster.get(srcId) || 'unclustered';
    const tgtCluster = nodeToCluster.get(tgtId) || 'unclustered';

    const srcPlan = clusters.get(srcCluster);
    const tgtPlan = clusters.get(tgtCluster);

    if (srcCluster === tgtCluster) {
      intraLinks.push(link);
      if (srcPlan) srcPlan.linkCount++;
    } else {
      bridgeLinks.push({ link, srcCluster, tgtCluster });
      if (srcPlan) srcPlan.bridgeLinkCount++;
      if (tgtPlan) tgtPlan.bridgeLinkCount++;
    }
  }

  // Pass 3: compute density + radius
  for (const plan of clusters.values()) {
    // density = actual links / max possible links (n*(n-1)/2)
    const maxLinks = (plan.nodeCount * (plan.nodeCount - 1)) / 2;
    plan.density = maxLinks > 0 ? plan.linkCount / maxLinks : 0;
    plan.radius = clusterRadius(plan.nodeCount);
  }

  return { clusters, nodeToCluster, bridgeLinks, intraLinks };
}

/**
 * Get the cluster ID for a specific node from a plan.
 */
export function getClusterForNode(plan, nodeId) {
  return plan.nodeToCluster.get(nodeId) || 'unclustered';
}
