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
    // Boundary = the cluster's satellite ring radius, NOT ring + padding.
    // Satellites orbit at clusterRadius+50; padding used to inflate the
    // boundary far beyond the ring, so every orbiting satellite sat inside
    // its neighbor's boundary circle and got shoved back toward its own hub
    // every frame — crushing the orbit into a pile. The boundary now marks
    // the actual ring so satellites orbit freely, and inter-cluster
    // separation is handled by hub positions + the world-sim collide force.
    boundaries.push({
      id: plan.id,
      x: plan.hubNode.x || 0,
      y: plan.hubNode.y || 0,
      r: plan.radius + 60, // ring radius + small margin for node size
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
 * A node is only pushed when it has genuinely crossed deep into a foreign
 * cluster — specifically, when it is closer to the foreign hub than to its
 * own hub. Satellites orbiting at their ring radius are naturally closer to
 * their own hub, so they orbit freely; only drifters get corrected.
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

    // Own hub position — used to decide "which side of the gap am I on?"
    let ownHubX = 0, ownHubY = 0;
    for (const b of boundaries) {
      if (b.id === myCluster) { ownHubX = b.x; ownHubY = b.y; break; }
    }
    const distToOwn = Math.hypot(node.x - ownHubX, node.y - ownHubY);

    for (const b of boundaries) {
      if (b.id === myCluster) continue; // skip own cluster

      const dx = node.x - b.x;
      const dy = node.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Only correct a node that is (a) inside the foreign boundary AND
      // (b) closer to the foreign hub than to its own hub. Otherwise we'd
      // crush satellites back onto their hubs on every tick.
      if (dist < b.r && dist > 0.1 && dist < distToOwn) {
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
