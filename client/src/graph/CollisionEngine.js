/**
 * CollisionEngine — cluster-aware collision detection.
 *
 * In the layered architecture, collision is handled at two levels:
 * 1. Intra-cluster: handled by NodeSimulation's d3.forceCollide (local sim)
 * 2. Inter-cluster: a boundary check that prevents satellites from one
 *    cluster from drifting into another cluster's territory
 *
 * This module provides the inter-cluster boundary collision — it runs
 * as a post-processing step after all per-cluster simulations tick,
 * applying corrections to nodes that have crossed into another cluster's
 * radius.
 */

/**
 * Build a cluster boundary map from the cluster plan.
 * Each cluster has a center (hub position) and a radius (from ClusterPlanner).
 *
 * @param {Map<string, ClusterPlan>} clusters
 * @returns {Array<{ id: string, x: number, y: number, r: number }>}
 */
export function buildBoundaries(clusters) {
  const boundaries = [];
  for (const plan of clusters.values()) {
    if (!plan.hubNode) continue;
    boundaries.push({
      id: plan.id,
      x: plan.hubNode.x || 0,
      y: plan.hubNode.y || 0,
      r: plan.radius + 120, // padding for satellite ring + inter-cluster gap
    });
  }
  return boundaries;
}

/**
 * Apply inter-cluster boundary corrections.
 * For each node, check if it has drifted into another cluster's boundary
 * circle. If so, push it back toward its own cluster center.
 *
 * This is a soft constraint — it applies a velocity correction, not a
 * hard position snap, so the simulation can settle naturally.
 *
 * @param {Array} nodes - all nodes across all clusters
 * @param {Map<string, string>} nodeToCluster - nodeId → clusterId
 * @param {Array} boundaries - from buildBoundaries()
 * @param {number} strength - correction strength (0-1)
 */
export function applyBoundaryCollision(nodes, nodeToCluster, boundaries, strength = 0.5) {
  if (boundaries.length === 0) return;

  for (const node of nodes) {
    if (node.group === 'system' || node.group === 'cluster') continue;
    if (node.fx != null) continue; // skip pinned nodes (hubs are frozen)

    const myCluster = nodeToCluster.get(node.id);
    if (!myCluster) continue;

    for (const b of boundaries) {
      if (b.id === myCluster) continue; // skip own cluster

      const dx = node.x - b.x;
      const dy = node.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // If node is inside another cluster's boundary, snap it outside
      if (dist < b.r && dist > 0.1) {
        const push = (b.r - dist) * strength;
        // Direct position correction + velocity nudge for sim still running
        node.x += (dx / dist) * push;
        node.y += (dy / dist) * push;
        node.vx = (node.vx || 0) + (dx / dist) * push * 0.5;
        node.vy = (node.vy || 0) + (dy / dist) * push * 0.5;
      }
    }
  }
}

/**
 * Minimum distance between two cluster boundaries.
 * Used to detect overlapping clusters that need to be pushed apart.
 */
export function minBoundaryDistance(b1, b2) {
  const dx = b1.x - b2.x;
  const dy = b1.y - b2.y;
  const centerDist = Math.sqrt(dx * dx + dy * dy);
  return centerDist - b1.r - b2.r;
}
