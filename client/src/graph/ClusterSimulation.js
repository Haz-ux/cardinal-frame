/**
 * ClusterSimulation — world-level simulation for cluster hubs only.
 *
 * Instead of simulating ALL nodes in one giant force layout, we first
 * simulate just the cluster hubs (5-20 objects). This finishes almost
 * instantly. After stabilization, hubs are frozen (fx/fy set) so they
 * become fixed anchor points for per-cluster node simulations.
 *
 * This eliminates the "clusters drift together" problem because:
 * 1. Hubs are positioned at fixed sector angles (angular constraint)
 * 2. Hubs freeze after stabilization — no more drift
 * 3. Bridge links between hubs are weak enough to not overcome the
 *    sector positioning force
 */

import * as d3 from 'd3-force';
import { assignSectors, hubTarget } from './SectorLayout.js';

const HUB_FREEZE_ALPHA = 0.001;
const HUB_MAX_TICKS = 300;
const HUB_WARMUP_TICKS = 50;

/**
 * Angular constraint force — pulls each hub toward its assigned sector angle.
 * This is the critical fix: forceRadial constrains radius but NOT angle,
 * so without this force, link springs rotate all clusters toward center.
 */
function angularForce(sectors, clusters) {
  let _nodes = null;

  function force(alpha) {
    if (!_nodes) return;
    for (const node of _nodes) {
      if (node.group === 'system') continue;

      const cid = node.cluster || (node.id && node.id.startsWith('cluster:') ? node.id.split(':')[1] : null);
      if (!cid) continue;

      const sector = sectors.get(cid);
      if (!sector) continue;

      const plan = clusters.get(cid);
      const r = plan ? plan.radius : 200;
      const targetX = Math.cos(sector.angleRad) * r;
      const targetY = Math.sin(sector.angleRad) * r;

      const k = 0.3 * alpha;
      node.vx += (targetX - node.x) * k;
      node.vy += (targetY - node.y) * k;
    }
  }

  force.initialize = (nodes) => { _nodes = nodes; };
  return force;
}

/**
 * Run the world-level simulation for cluster hubs.
 *
 * @param {Map<string, ClusterPlan>} clusters
 * @param {string[]} clusterOrder - ordered list of cluster IDs
 * @param {Array} bridgeLinks - links between clusters (from ClusterPlanner)
 * @returns {void} - mutates hubNode.x/y/fx/fy in place
 */
export function simulateClusters(clusters, clusterOrder, bridgeLinks) {
  if (clusterOrder.length === 0) return;

  // Assign sectors
  const sectors = assignSectors(clusterOrder);

  // Build hub nodes for the world simulation
  const hubNodes = [];
  const hubByCluster = new Map();

  for (const cid of clusterOrder) {
    const plan = clusters.get(cid);
    if (!plan || !plan.hubNode) continue;

    const sector = sectors.get(cid) || { angleRad: 0 };
    const target = hubTarget(sector, plan.radius);

    const hub = plan.hubNode;
    // Always seed at sector target if no position or if it's a fresh node
    if (typeof hub.x !== 'number' || hub.fx == null) {
      hub.x = target.x;
      hub.y = target.y;
    }

    hubNodes.push(hub);
    hubByCluster.set(cid, hub);
  }

  if (hubNodes.length === 0) return;

  // Build bridge link objects for the hub simulation
  const simLinks = [];
  for (const bl of bridgeLinks) {
    const src = hubByCluster.get(bl.srcCluster);
    const tgt = hubByCluster.get(bl.tgtCluster);
    if (src && tgt) {
      simLinks.push({
        source: src.id,
        target: tgt.id,
        ropeLen: 200,
        strength: 0.05, // very weak — sector force dominates
      });
    }
  }

  // Create the world simulation
  const sim = d3.forceSimulation(hubNodes)
    .force('link', d3.forceLink(simLinks)
      .id(d => d.id)
      .distance(l => l.ropeLen)
      .strength(l => l.strength)
    )
    .force('charge', d3.forceManyBody()
      .strength(d => d.group === 'system' ? -1200 : -600)
      .distanceMax(600)
    )
    .force('radial', d3.forceRadial(d => {
      if (d.group === 'system') return 0;
      const cid = d.cluster || (d.id && d.id.startsWith('cluster:') ? d.id.split(':')[1] : null);
      const plan = clusters.get(cid);
      return plan ? plan.radius : 200;
    }, 0, 0).strength(d => d.group === 'system' ? 1 : 0.3))
    .force('angle', angularForce(sectors, clusters))
    .force('collide', d3.forceCollide()
      .radius(d => d.group === 'system' ? 30 : 25)
      .strength(0.8)
      .iterations(2)
    )
    .alpha(1.0)
    .alphaDecay(0.05)
    .velocityDecay(0.4);

  // Warmup + run until settled
  sim.tick(HUB_WARMUP_TICKS);
  let ticks = HUB_WARMUP_TICKS;
  while (sim.alpha() > HUB_FREEZE_ALPHA && ticks < HUB_MAX_TICKS) {
    sim.tick(1);
    ticks++;
  }

  // Freeze hubs: set fx/fy to their final positions
  for (const hub of hubNodes) {
    hub.fx = hub.x;
    hub.fy = hub.y;
  }

  sim.stop();
}

/**
 * Relocate frozen hubs when cluster sizes change (new nodes added).
 * Recomputes sector radius and moves the hub to the new position,
 * then re-freezes. Does NOT re-run the full world simulation —
 * just adjusts the anchor point.
 */
export function relocateHubs(clusters, clusterOrder, sectors) {
  for (const cid of clusterOrder) {
    const plan = clusters.get(cid);
    if (!plan || !plan.hubNode) continue;

    const sector = sectors.get(cid);
    if (!sector) continue;

    const target = hubTarget(sector, plan.radius);
    plan.hubNode.fx = target.x;
    plan.hubNode.fy = target.y;
    plan.hubNode.x = target.x;
    plan.hubNode.y = target.y;
  }
}

export { HUB_FREEZE_ALPHA, HUB_MAX_TICKS, assignSectors };
