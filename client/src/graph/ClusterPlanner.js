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
 * Extract cluster ID from a node.
 * - Nodes with explicit `cluster` field use that.
 * - Nodes with id `cluster:xxx` ARE the cluster hub.
 * - Other nodes (user, task, tool, plugin) inherit cluster from their links
 *   — they're linked to a cluster hub, so they belong to that cluster.
 * - Falls back to 'unclustered' if no link to a cluster is found.
 */
function getClusterId(node, links) {
  if (node.cluster) return node.cluster;
  if (node.id && node.id.startsWith('cluster:')) return node.id.split(':')[1];
  if (node.group === 'cluster' && node.id) return node.id.split(':')[1] || node.group;
  // Non-cluster nodes: find which cluster they're linked to
  if (links) {
    for (const link of links) {
      const sId = typeof link.source === 'object' ? link.source.id : link.source;
      const tId = typeof link.target === 'object' ? link.target.id : link.target;
      // This node links TO a cluster hub
      if (sId === node.id && tId?.startsWith('cluster:')) return tId.split(':')[1];
      // A cluster hub links TO this node
      if (tId === node.id && sId?.startsWith('cluster:')) return sId.split(':')[1];
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

  // Pass 1: group nodes by cluster
  for (const node of nodes) {
    const cid = getClusterId(node, links);
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
