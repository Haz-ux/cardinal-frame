import { describe, it, expect } from 'vitest';
import { LayoutEngine } from '../client/src/graph/LayoutEngine.js';

function buildGraph(satelliteCounts) {
  const nodes = [{ id: 'system', group: 'system', name: 'Cardinal' }];
  const links = [];
  for (const [cluster, count] of Object.entries(satelliteCounts)) {
    nodes.push({ id: `cluster:${cluster}`, group: 'cluster', name: cluster });
    for (let i = 0; i < count; i++) {
      const id = `${cluster}:agent${i}`;
      nodes.push({ id, group: 'agent', name: id });
      links.push({ source: `cluster:${cluster}`, target: id, type: 'hosts' });
    }
    links.push({ source: 'system', target: `cluster:${cluster}`, type: 'manages' });
  }
  return { nodes, links };
}

function hubPosition(engine, clusterId) {
  const id = clusterId === 'system' ? 'system' : `cluster:${clusterId}`;
  const hub = engine.cache.get(id);
  return { x: hub?.x, y: hub?.y };
}

describe('LayoutEngine snapshot restore', () => {
  it('preserves hub positions when the graph structure is unchanged', () => {
    const graph = buildGraph({ alpha: 20, beta: 15 });

    const a = new LayoutEngine({ autoTick: false });
    a.setData(graph.nodes, graph.links);
    const snapshot = a.getSnapshot();

    const b = new LayoutEngine({ autoTick: false, snapshot });
    b.setData(graph.nodes, graph.links);

    const aAlpha = hubPosition(a, 'alpha');
    const bAlpha = hubPosition(b, 'alpha');
    const aBeta = hubPosition(a, 'beta');
    const bBeta = hubPosition(b, 'beta');

    expect(aAlpha.x).toBeTypeOf('number');
    expect(Number.isFinite(aAlpha.x)).toBe(true);
    expect(bAlpha.x).toBeCloseTo(aAlpha.x, 5);
    expect(bAlpha.y).toBeCloseTo(aAlpha.y, 5);
    expect(bBeta.x).toBeCloseTo(aBeta.x, 5);
    expect(bBeta.y).toBeCloseTo(aBeta.y, 5);

    // Central system hub stays pinned near the origin on both sides
    const aSystem = hubPosition(a, 'system');
    const bSystem = hubPosition(b, 'system');
    expect(Math.hypot(aSystem.x, aSystem.y)).toBeLessThan(10);
    expect(bSystem.x).toBeCloseTo(aSystem.x, 5);
    expect(bSystem.y).toBeCloseTo(aSystem.y, 5);

    // No satellite may be left unseeded at the origin
    for (const node of b.cache.allNodes()) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }

    // Cluster membership must survive the restore
    expect(b.getSnapshot().clusters.alpha.length).toBe(21); // hub + 20 agents
  });

  it('re-runs the world simulation when the graph structure changes', () => {
    const graph = buildGraph({ alpha: 20, beta: 15 });

    const a = new LayoutEngine({ autoTick: false });
    a.setData(graph.nodes, graph.links);
    const snapshot = a.getSnapshot();

    // Grow the alpha cluster (+5 nodes) — the saved layout is now stale, so the
    // engine must bypass the stable-restore fast path and run a world re-layout
    const grown = buildGraph({ alpha: 25, beta: 15 });
    const c = new LayoutEngine({ autoTick: false, snapshot });
    c.setData(grown.nodes, grown.links);

    // Every new node got seeded with finite coordinates (no origin pile-up)
    for (const id of ['alpha:agent20', 'alpha:agent21', 'alpha:agent24']) {
      const node = c.cache.get(id);
      expect(node).toBeTruthy();
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }

    // The alpha cluster simulation was recreated with the full node set
    const alphaSim = c.clusterSims.get('alpha');
    expect(alphaSim).toBeTruthy();
    expect(alphaSim.nodes.length).toBe(26); // hub + 25 agents

    // No node is left stranded with invalid coordinates anywhere
    for (const node of c.cache.allNodes()) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });
});
