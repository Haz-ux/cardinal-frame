/**
 * NodeSimulation — per-cluster independent force simulations.
 *
 * Each cluster gets its own d3-force simulation with only its own nodes.
 * This replaces the single-giant-simulation approach where every node
 * interacts with every other node, causing clusters to collapse together.
 *
 * Key design points:
 * - Each cluster sim runs independently (can stop/reheat without affecting others)
 * - The hub node is frozen (fx/fy set by ClusterSimulation) and serves as
 *   a fixed anchor point — all satellite positions are relative to it
 * - Intra-cluster links use normal spring strength
 * - No bridge links here — those are handled by LinkRouter at the world level
 * - Collision detection is local to the cluster (no inter-cluster collision here)
 */

import * as d3 from 'd3-force';
import { satelliteTarget } from './SectorLayout.js';

const NODE_ALPHA = 1.0;
const NODE_ALPHA_DECAY = 0.0228;
const NODE_VELOCITY_DECAY = 0.4;
const NODE_WARMUP_TICKS = 300;
const NODE_MAX_TICKS = 20000;
const NODE_SETTLE_ALPHA = 0.001;

// Group style sizes — must match NeuralMap GROUP_STYLE
const GROUP_SIZE = {
  system: 16, cluster: 12, provider: 9, model: 4, agent: 8,
  task: 5, skill: 6, tool: 5, file: 4, mcp: 7, dag: 6,
  conversation: 4, group: 6, user: 6, plugin: 5, schedule: 5,
  env: 3, watcher: 4, node: 10,
};

/**
 * Create and run a force simulation for a single cluster.
 *
 * @param {object} plan - ClusterPlan from ClusterPlanner
 * @param {Array} intraLinks - links within this cluster
 * @param {object} hubPosition - { x, y } of the frozen hub (world coords)
 * @param {number} clusterRadius - ideal cluster radius based on node count
 * @returns {object} simulation handle { sim, nodes, tick, stop, reheat }
 */
export function createClusterSimulation(plan, intraLinks, hubPosition, clusterRadius) {
  // Include ALL nodes (hub + satellites) — hub stays frozen via fx/fy
  const simNodes = [...plan.nodes];

  // Ensure hub is frozen at its position
  if (plan.hubNode) {
    plan.hubNode.fx = hubPosition.x;
    plan.hubNode.fy = hubPosition.y;
  }

  // Seed satellite positions around the hub with golden-angle distribution.
  const minRingRadius = Math.max(clusterRadius + 50, 80);
  // Assign each satellite a sequential index within the cluster so
  // satelliteTarget can apply index-based golden-angle spread.
  let satIndex = 0;
  for (const node of simNodes) {
    if (node === plan.hubNode) continue;
    if (typeof node.x !== 'number' || (node.x === hubPosition.x && node.y === hubPosition.y)) {
      const idx = satIndex++;
      const target = satelliteTarget(node.id, hubPosition.x, hubPosition.y, minRingRadius, idx);
      node.x = target.x + (Math.random() - 0.5) * 8;
      node.y = target.y + (Math.random() - 0.5) * 8;
    } else {
      satIndex++;
    }
  }

  // Resolve link source/target to actual node objects (d3-force mutates these)
  const resolvedLinks = [];
  for (const link of intraLinks) {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const srcNode = plan.nodes.find(n => n.id === srcId);
    const tgtNode = plan.nodes.find(n => n.id === tgtId);
    if (srcNode && tgtNode) {
      resolvedLinks.push({ ...link, source: srcNode, target: tgtNode });
    }
  }

  // Create the simulation (NOT running yet — we control ticks manually)
  const sim = d3.forceSimulation(simNodes)
    .force('link', d3.forceLink(resolvedLinks)
      .distance(l => {
        // Link distance must be >= combined collision radius to prevent overlap
        const ropeLen = l.ropeLen || 50;
        const sBase = GROUP_SIZE[l.source?.group] || 8;
        const tBase = GROUP_SIZE[l.target?.group] || 8;
        const sSize = sBase * 10 + 30;
        const tSize = tBase * 10 + 30;
        // Hub nodes get extra collision
        const sMul = l.source?.group === 'cluster' || l.source?.group === 'system' ? 2.5 : 1;
        const tMul = l.target?.group === 'cluster' || l.target?.group === 'system' ? 2.5 : 1;
        const minDist = (sSize * sMul + tSize * tMul);
        return Math.max(ropeLen, minDist);
      })
      .strength(0.1)
    )
    .force('charge', d3.forceManyBody()
      .strength(d => {
        const base = GROUP_SIZE[d.group] || 8;
        const mul = d.group === 'system' ? 4 : d.group === 'cluster' ? 2.5 : 1;
        const raw = -600 * mul * (base / 6);
        return Math.min(raw, -300);
      })
      .distanceMax(1000)
      .theta(0.9)
    )
    .force('collide', d3.forceCollide()
      .radius(d => {
        const base = GROUP_SIZE[d.group] || 8;
        const mul = d.group === 'cluster' ? 2.5 : d.group === 'system' ? 1.5 : 1;
        return base * 10 * mul + 30;
      })
      .strength(1)
      .iterations(8)
    )
    .force('center', d3.forceCenter(hubPosition.x, hubPosition.y).strength(0.005))
    .alpha(NODE_ALPHA)
    .alphaDecay(NODE_ALPHA_DECAY)
    .velocityDecay(NODE_VELOCITY_DECAY);

  return {
    sim,
    nodes: simNodes,
    clusterId: plan.id,

    /** Advance the simulation by N ticks. */
    tick(n = 1) {
      sim.tick(n);
      return sim.alpha();
    },

    /** Run warmup + settle to a stable position. Blocks until settled. */
    settle() {
      sim.tick(NODE_WARMUP_TICKS);
      let ticks = NODE_WARMUP_TICKS;
      while (sim.alpha() > NODE_SETTLE_ALPHA && ticks < NODE_MAX_TICKS) {
        sim.tick(1);
        ticks++;
      }
      return sim.alpha();
    },

    /** Reheat the simulation (e.g., after adding new nodes). */
    reheat(alpha = 0.5) {
      sim.alpha(alpha).restart();
    },

    /** Stop the simulation. */
    stop() {
      sim.stop();
    },

    /** Update hub position (when hub relocates). Translates all nodes. */
    translateTo(newHubX, newHubY) {
      const dx = newHubX - hubPosition.x;
      const dy = newHubY - hubPosition.y;
      for (const node of simNodes) {
        node.x += dx;
        node.y += dy;
        if (node.vx) node.vx += dx * 0.1;
        if (node.vy) node.vy += dy * 0.1;
      }
      hubPosition.x = newHubX;
      hubPosition.y = newHubY;
      // Update center force target
      const centerForce = sim.force('center');
      if (centerForce) {
        sim.force('center', d3.forceCenter(newHubX, newHubY).strength(0.005));
      }
    },

    /** Add a new node to the simulation. */
    addNode(node, links = []) {
      simNodes.push(node);
      for (const link of links) {
        const srcId = typeof link.source === 'object' ? link.source.id : link.source;
        const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
        const srcNode = plan.nodes.find(n => n.id === srcId);
        const tgtNode = plan.nodes.find(n => n.id === tgtId);
        if (srcNode && tgtNode) {
          resolvedLinks.push({ ...link, source: srcNode, target: tgtNode });
        }
      }
      sim.nodes(simNodes);
      const linkForce = sim.force('link');
      if (linkForce) {
        linkForce.links(resolvedLinks);
      }
      this.reheat(0.5);
    },

    /** Get current alpha (for checking if settled). */
    alpha() { return sim.alpha(); },
  };
}

export { NODE_SETTLE_ALPHA, NODE_MAX_TICKS };
