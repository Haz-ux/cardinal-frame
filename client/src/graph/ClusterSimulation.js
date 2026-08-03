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
const MIN_HUB_RADIUS = 180;
const MIN_HUB_COLLISION = 120;

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
      const r = plan ? Math.max(MIN_HUB_RADIUS, plan.radius) : MIN_HUB_RADIUS;
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

  // Build hub nodes for the world simulation — store cluster radii for distance calcs
  const hubNodes = [];
  const hubByCluster = new Map();
  const clusterRadii = {}; // cid → safe radius for collision/distance

  for (const cid of clusterOrder) {
    const plan = clusters.get(cid);
    if (!plan || !plan.hubNode) continue;

    const hub = plan.hubNode;

    // Central Cardinal hub — pinned at origin, never on a sector ring.
    if (hub.group === 'system') {
      clusterRadii[cid] = 30; // small collide radius — keep it compact
      hub.x = 0;
      hub.y = 0;
      hubNodes.push(hub);
      hubByCluster.set(cid, hub);
      continue;
    }

    const sector = sectors.get(cid) || { angleRad: 0 };
    const safeRadius = Math.max(MIN_HUB_RADIUS, plan.radius);
    clusterRadii[cid] = safeRadius;
    const target = hubTarget(sector, safeRadius);

    // Always seed at sector target if no position or if it's a fresh node
    if (typeof hub.x !== 'number' || hub.fx == null) {
      hub.x = target.x;
      hub.y = target.y;
    }

    hubNodes.push(hub);
    hubByCluster.set(cid, hub);
  }

  if (hubNodes.length === 0) return;

  // Build bridge link objects — distance must be >= sum of both cluster radii
  // or the spring will collapse them inward to satisfy the link constraint.
  const simLinks = [];
  for (const bl of bridgeLinks) {
    const src = hubByCluster.get(bl.srcCluster);
    const tgt = hubByCluster.get(bl.tgtCluster);
    if (src && tgt) {
      const rSrc = clusterRadii[bl.srcCluster] || MIN_HUB_RADIUS;
      const rTgt = clusterRadii[bl.tgtCluster] || MIN_HUB_RADIUS;
      // Rope length = combined radii + gap, so springs don't pull clusters
      // below their minimum separation. This prevents center collapse.
      const distance = Math.max(rSrc + rTgt + 100, 400);
      simLinks.push({
        source: src.id,
        target: tgt.id,
        ropeLen: distance,
        strength: 0.02, // extremely weak — angular force must dominate
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
      // Zero charge — angular + radial forces provide positioning.
      // Negative charge pulls toward center, counteracting radial force.
      .strength(0)
    )
    .force('radial', d3.forceRadial(d => {
      if (d.group === 'system') return 0;
      const cid = d.cluster || (d.id && d.id.startsWith('cluster:') ? d.id.split(':')[1] : null);
      return clusterRadii[cid] || MIN_HUB_RADIUS;
    }, 0, 0).strength(d => d.group === 'system' ? 1 : 0.5))
    .force('angle', angularForce(sectors, clusters))
    .force('collide', d3.forceCollide()
      .radius(d => {
        if (d.group === 'system') return 30;
        const cid = d.cluster || (d.id && d.id.startsWith('cluster:') ? d.id.split(':')[1] : null);
        // Use the actual cluster radius + padding as collision radius
        return (clusterRadii[cid] || MIN_HUB_COLLISION) * 0.85;
      })
      .strength(1.0)
      .iterations(4)
    )

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
  const hubs = [];

  for (const cid of clusterOrder) {
    const plan = clusters.get(cid);
    if (!plan || !plan.hubNode) continue;

    const hub = plan.hubNode;

    // Central Cardinal hub is always pinned at the origin — never relocated.
    if (hub.group === 'system') {
      hub.x = 0;
      hub.y = 0;
      hubs.push({ node: hub, radius: 30, cid });
      continue;
    }

    const sector = sectors.get(cid);
    if (!sector) continue;

    const r = Math.max(MIN_HUB_RADIUS, plan.radius);
    const target = hubTarget(sector, r);
    plan.hubNode.x = target.x;
    plan.hubNode.y = target.y;

    hubs.push({ node: plan.hubNode, radius: r, cid });
  }

  // Resolve hub overlaps — when cluster radii grow but world sim isn't re-run,
  // hubs can overlap. Iteratively push overlapping hubs outward along their
  // radial direction until minimum separation is reached.
  const MAX_ITER = 60;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let anyOverlap = false;

    for (let i = 0; i < hubs.length; i++) {
      for (let j = i + 1; j < hubs.length; j++) {
        const a = hubs[i];
        const b = hubs[j];
        const dx = b.node.x - a.node.x;
        const dy = b.node.y - a.node.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.radius + b.radius + 60;

        if (dist < minDist && dist > 0.001) {
          anyOverlap = true;
          const overlap = (minDist - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;

          b.node.x += nx * overlap;
          b.node.y += ny * overlap;
          a.node.x -= nx * overlap;
          a.node.y -= ny * overlap;
        }
      }
    }

    if (!anyOverlap) break;
  }

  for (const { node } of hubs) {
    node.fx = node.x;
    node.fy = node.y;
  }
}

export { HUB_FREEZE_ALPHA, HUB_MAX_TICKS, assignSectors };
