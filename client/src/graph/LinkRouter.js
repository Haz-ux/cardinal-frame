/**
 * LinkRouter — handles bridge links between clusters.
 *
 * Bridge links connect nodes in different clusters. In the old single-sim
 * approach, these links were the primary cause of cluster collapse because
 * they pulled clusters together with the same spring strength as intra-cluster
 * links.
 *
 * In the layered architecture, bridge links do NOT participate in the
 * per-cluster node simulations. Instead, they are rendered as visual
 * connections that follow the positions computed by the independent sims.
 * If a bridge link needs to influence layout (e.g., a satellite with a
 * cross-cluster dependency), it applies a very weak nudge force in the
 * NodeSimulation, not a full spring.
 */

import { ROPE_LENGTHS } from './GraphMetrics.js';

const DEFAULT_ROPE = 35;
const BRIDGE_STRENGTH = 0.02; // extremely weak — barely influences layout

/**
 * Categorize links into bridge vs intra.
 * Bridge links cross cluster boundaries; intra links stay within one cluster.
 *
 * @param {Array} links
 * @param {Map<string, string>} nodeToCluster
 * @returns {{ bridge: Array, intra: Array }}
 */
export function categorizeLinks(links, nodeToCluster) {
  const bridge = [];
  const intra = [];

  for (const link of links) {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const srcCluster = nodeToCluster.get(srcId) || 'unclustered';
    const tgtCluster = nodeToCluster.get(tgtId) || 'unclustered';

    // Assign ropeLen for rendering
    link.ropeLen = ROPE_LENGTHS[link.type] || DEFAULT_ROPE;

    if (srcCluster !== tgtCluster) {
      link._isBridge = true;
      link._bridgeStrength = BRIDGE_STRENGTH;
      bridge.push(link);
    } else {
      link._isBridge = false;
      intra.push(link);
    }
  }

  return { bridge, intra };
}

/**
 * Group intra links by cluster for consumption by NodeSimulation.
 *
 * @param {Array} intraLinks
 * @param {Map<string, string>} nodeToCluster
 * @returns {Map<string, Array>} clusterId → link[]
 */
export function groupIntraLinks(intraLinks, nodeToCluster) {
  const byCluster = new Map();
  for (const link of intraLinks) {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const cluster = nodeToCluster.get(srcId) || 'unclustered';
    if (!byCluster.has(cluster)) byCluster.set(cluster, []);
    byCluster.get(cluster).push(link);
  }
  return byCluster;
}

/**
 * Apply a weak nudge force for bridge links in a per-cluster simulation.
 * This is called from NodeSimulation's tick callback for any node that has
 * bridge links. The nudge is extremely weak and only serves to slightly
 * orient the cluster toward its bridge-connected neighbors.
 *
 * @param {Array} nodes - nodes in this cluster's simulation
 * @param {Array} bridgeLinks - bridge links involving this cluster
 * @param {Map<string, { x: number, y: number }>} hubPositions - clusterId → hub pos
 * @param {number} alpha - current sim alpha (scales the nudge)
 */
export function applyBridgeNudge(nodes, bridgeLinks, hubPositions, alpha) {
  if (!bridgeLinks || bridgeLinks.length === 0) return;
  const myCluster = bridgeLinks[0]?._srcCluster;
  if (!myCluster) return;

  const myHub = hubPositions.get(myCluster);
  if (!myHub) return;

  for (const bl of bridgeLinks) {
    const otherHub = hubPositions.get(bl._tgtCluster);
    if (!otherHub) continue;

    // Nudge nodes slightly toward the other cluster's hub direction.
    // Nudge strength is proportional to alpha so it decays as the sim settles.
    const dx = otherHub.x - myHub.x;
    const dy = otherHub.y - myHub.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.1) continue;

    const ux = dx / dist;
    const uy = dy / dist;
    const nudgeStrength = BRIDGE_STRENGTH * alpha;

    // Only nudge the node(s) that are explicitly endpoints of this bridge link
    // (not the entire cluster)
    for (const node of nodes) {
      if (bl._endpointIds?.has(node.id)) {
        node.vx += ux * nudgeStrength * 10;
        node.vy += uy * nudgeStrength * 10;
      }
    }
  }
}
