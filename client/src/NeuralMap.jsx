import React, { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import * as d3 from 'd3-force';
import { cachedFetch } from './dataCache';
import { useWebSocket } from './useWebSocket';
import { ActivityFeed, useActivityFeed } from './ActivityOverlay';
import { usePolling } from './usePolling';
import { Network, RefreshCw, Search, X, Eye, EyeOff, Filter, ZoomIn, ZoomOut, Maximize2, Pin, PinOff, Lock, Unlock, AlertTriangle, Activity } from 'lucide-react';

const NEON = { cyan:'#00f0ff', magenta:'#ff00ff', blue:'#3b82f6', purple:'#a855f7', green:'#22c55e', yellow:'#eab308', red:'#ef4444', pink:'#ec4899', orange:'#f97316', teal:'#14b8a6' };
const BG = { base:'#050510', card:'#0f0f23' };

// ─── Group Styles ─────────────────────────────────────────────────
const GROUP_STYLE = {
 system: { color: NEON.magenta, size: 16, glow: true },
 provider: { color: NEON.cyan, size: 9, glow: false },
 model: { color: '#5eead4', size: 4, glow: false },
 agent: { color: NEON.green, size: 8, glow: false },
 task: { color: NEON.yellow, size: 5, glow: false },
 skill: { color: NEON.purple, size: 6, glow: false },
 tool: { color: '#f59e0b', size: 5, glow: false },
 file: { color: NEON.blue, size: 4, glow: false },
 mcp: { color: NEON.orange, size: 7, glow: false },
 dag: { color: NEON.pink, size: 6, glow: false },
 conversation:{ color: NEON.teal, size: 4, glow: false },
 group: { color: '#f59e0b', size: 6, glow: false },
 user: { color: '#c084fc', size: 6, glow: false },
 plugin: { color: '#38bdf8', size: 5, glow: false },
 schedule: { color: '#fb923c', size: 5, glow: false },
 env: { color: '#a3e635', size: 3, glow: false },
 watcher: { color: '#f472b6', size: 4, glow: false },
};

const LINK_COLORS = {
 api: NEON.cyan, registered: '#444', assigned: NEON.green, depends: NEON.yellow,
 mcp: NEON.orange, workflow: NEON.pink, chat: NEON.teal, uploaded: NEON.blue,
 workspace: '#333', imports: NEON.purple, member: '#f59e0b', group: '#f59e0b',
 hosts: '#5eead4', provides: '#f59e0b', uses: NEON.cyan, tool: '#f59e0b',
 task: NEON.yellow, config: '#a3e635', schedule: '#fb923c', plugin: '#38bdf8',
 watcher: '#f472b6',
};

const STATUS_COLORS = {
 active: NEON.green, running: NEON.cyan, pending: NEON.yellow,
 completed: '#666', failed: NEON.red, idle: '#444', disconnected: '#333', unknown: '#555',
};

// ─── Clustering modes ─────────────────────────────────────────────
const CLUSTER_MODES = {
 group:       { label: 'By Group', icon: '⊞' },
 density:     { label: 'By Density', icon: '◉' },
 activity:    { label: 'By Activity', icon: '◎' },
};

// ─── Convex hull helpers ───────────────────────────────────────────
function convexHull(points) {
 if (points.length < 3) return points;
 const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
 const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
 const lower = [];
 for (const p of sorted) {
  while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
  lower.push(p);
 }
 const upper = [];
 for (let i = sorted.length - 1; i >= 0; i--) {
  const p = sorted[i];
  while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
  upper.push(p);
 }
 lower.pop(); upper.pop();
 return lower.concat(upper);
}

function drawHullPath(ctx, hull) {
 if (hull.length < 3) return;
 ctx.beginPath();
 ctx.moveTo(hull[0].x, hull[0].y);
 for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
 ctx.closePath();
}

// ─── Rope length by link type ────────────
const ROPE_LENGTHS = {
 hosts: 25, uses: 30, api: 50, registered: 40, assigned: 35,
 depends: 30, mcp: 45, workflow: 40, chat: 35, uploaded: 30,
 workspace: 20, imports: 15, member: 35, group: 40, provides: 25,
 tool: 40, task: 35, config: 50, schedule: 40, plugin: 45, watcher: 50,
};
const DEFAULT_ROPE = 35;

// ─── Draw a catenary/rope curve ────────────
function drawRope(ctx, x1, y1, x2, y2, ropeLen, color, width, globalScale, isHighlighted, showParticles, time) {
 const dx = x2 - x1;
 const dy = y2 - y1;
 const dist = Math.sqrt(dx * dx + dy * dy);
 if (dist < 0.1) return; // Safety: skip zero-length links

 const slack = Math.max(0, ropeLen - dist);
 const sag = slack * 0.4;
 const mx = (x1 + x2) / 2;
 const my = (y1 + y2) / 2;
 const nx = -dy / (dist || 1);
 const ny = dx / (dist || 1);

 ctx.beginPath();
 ctx.moveTo(x1, y1);
 if (sag > 2) {
  const segments = 12;
  for (let i = 1; i <= segments; i++) {
   const t = i / segments;
   const px = x1 + dx * t;
   const py = y1 + dy * t;
   const sagFactor = 4 * t * (1 - t);
   const sagY = sag * sagFactor;
   const wobble = Math.sin(t * Math.PI * 3 + (time || 0) * 0.001) * sag * 0.05;
   ctx.lineTo(px + wobble, py + sagY);
  }
 } else {
  const tinySag = Math.max(0, slack) * 0.1;
  ctx.quadraticCurveTo(mx, my + tinySag, x2, y2);
 }
 ctx.strokeStyle = color;
 ctx.lineWidth = width;
 ctx.stroke();

 if (showParticles && dist > 5) {
  const particleCount = isHighlighted ? 3 : 1;
  const speed = 0.0003;
  for (let p = 0; p < particleCount; p++) {
   const t = ((time || 0) * speed + p * 0.33) % 1;
   const sagFactor = 4 * t * (1 - t);
   const px = x1 + dx * t;
   const py = y1 + dy * t + sag * sagFactor;
   const radius = Math.max(1, 3 / (globalScale || 1));
   const pGrad = ctx.createRadialGradient(px, py, 0, px, py, radius);
   pGrad.addColorStop(0, color.replace(/[0-9a-f]{2}$/i, 'ff'));
   pGrad.addColorStop(1, color.replace(/[0-9a-f]{2}$/i, '00'));
   ctx.beginPath();
   ctx.arc(px, py, radius, 0, 2 * Math.PI);
   ctx.fillStyle = pGrad;
   ctx.fill();
  }
 }
}

// ─── Minimap (bottom-right thumbnail) ─────────────────────────────
// Draws all nodes scaled into a 120×80px canvas + a cyan viewport rect.
// Click on minimap pans the main view. Polls the fg transform via rAF.
const MINI_W = 140, MINI_H = 90, MINI_PAD = 6;

const Minimap = memo(function Minimap({ fgRef, graphData, dim }) {
 const canvasRef = useRef();
 const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 }); // main-view transform

 // Poll the main graph's transform every frame
 useEffect(() => {
  let raf;
  const tick = () => {
   const fg = fgRef.current;
   if (fg) {
    const t = fg.zoom();          // current zoom level (k)
    const center = fg.getCenter?.() ?? { x: 0, y: 0 };
    setViewport({ x: center.x, y: center.y, k: t });
   }
   raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
 }, [fgRef]);

 // Compute graph bounding box from node coords
 const bounds = useMemo(() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of graphData.nodes) {
   if (typeof n.x === 'number' && typeof n.y === 'number') {
    if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
   }
  }
  if (!isFinite(minX)) minX = -200, minY = -200, maxX = 200, maxY = 200;
  return { minX, minY, maxX, maxY };
 }, [graphData.nodes]);

 // Scale graph coords → minimap coords
 const draw = useCallback(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== MINI_W * dpr) { canvas.width = MINI_W * dpr; canvas.height = MINI_H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, MINI_W, MINI_H);
  ctx.fillStyle = 'rgba(5,5,16,0.9)';
  ctx.fillRect(0, 0, MINI_W, MINI_H);

  const gw = bounds.maxX - bounds.minX || 1;
  const gh = bounds.maxY - bounds.minY || 1;
  const sx = (MINI_W - MINI_PAD * 2) / gw;
  const sy = (MINI_H - MINI_PAD * 2) / gh;
  const s = Math.min(sx, sy);
  const ox = MINI_PAD + (MINI_W - MINI_PAD * 2 - gw * s) / 2;
  const oy = MINI_PAD + (MINI_H - MINI_PAD * 2 - gh * s) / 2;

  // Nodes — tiny dots colored by group
  for (const n of graphData.nodes) {
   if (typeof n.x !== 'number') continue;
   const mx = ox + (n.x - bounds.minX) * s;
   const my = oy + (n.y - bounds.minY) * s;
   const style = GROUP_STYLE[n.group] || GROUP_STYLE.system;
   ctx.fillStyle = style.color + '60';
   ctx.beginPath();
   ctx.arc(mx, my, n.group === 'cluster' ? 1.6 : 0.9, 0, 2 * Math.PI);
   ctx.fill();
  }

  // Viewport rectangle — size inversely proportional to zoom
  // Main canvas shows an area of dim.w / k × dim.h / k in graph coords
  const vpW = (dim.w / viewport.k) * s;
  const vpH = (dim.h / viewport.k) * s;
  const vpX = ox + (viewport.x - bounds.minX) * s - vpW / 2;
  const vpY = oy + (viewport.y - bounds.minY) * s - vpH / 2;
  ctx.strokeStyle = NEON.cyan + 'cc';
  ctx.lineWidth = 1;
  ctx.strokeRect(vpX, vpY, vpW, vpH);
  ctx.fillStyle = NEON.cyan + '10';
  ctx.fillRect(vpX, vpY, vpW, vpH);

  // Outer border
  ctx.strokeStyle = `${NEON.magenta}40`;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, MINI_W - 1, MINI_H - 1);
 }, [graphData.nodes, bounds, viewport, dim]);

 useEffect(() => { draw(); });
 useAnimationFrame(() => { draw(); });  // keeps viewport rect synced during pan/zoom

 // Click → pan main view to clicked graph point
 const handleClick = useCallback((e) => {
  const canvas = canvasRef.current;
  if (!canvas || !fgRef.current) return;
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const gw = bounds.maxX - bounds.minX || 1;
  const gh = bounds.maxY - bounds.minY || 1;
  const sx = (MINI_W - MINI_PAD * 2) / gw;
  const sy = (MINI_H - MINI_PAD * 2) / gh;
  const s = Math.min(sx, sy);
  const ox = MINI_PAD + (MINI_W - MINI_PAD * 2 - gw * s) / 2;
  const oy = MINI_PAD + (MINI_H - MINI_PAD * 2 - gh * s) / 2;
  const gx = (px - ox) / s + bounds.minX;
  const gy = (py - oy) / s + bounds.minY;
  fgRef.current.centerAt(gx, gy, 400);
 }, [bounds]);

 return (
  <canvas ref={canvasRef}
   onClick={handleClick}
   className="absolute bottom-12 right-3 rounded-lg cursor-pointer"
   style={{ width: MINI_W, height: MINI_H, border: `1px solid ${NEON.magenta}30`, background: BG.base, backdropFilter: 'blur(4px)' }}
   title="Click to pan main view"
  />
 );
});

// tiny hook: requestAnimationFrame loop that calls a callback each frame
function useAnimationFrame(cb) {
 const cbRef = useRef(cb);
 cbRef.current = cb;
 useEffect(() => {
  let raf;
  const tick = () => { cbRef.current(); raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
 }, []);
}

// ─── Main Component ──────────────────────────────────────────────
export default function NeuralMap() {
 const fgRef = useRef();
 const [graphData, setGraphData] = useState({ nodes: [], links: [] });
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState(null);
 const [search, setSearch] = useState('');
 const [hoverNode, setHoverNode] = useState(null);
 const [selectedNode, setSelectedNode] = useState(null);
 const [showFilters, setShowFilters] = useState(true);
 const [showActivity, setShowActivity] = useState(false);
 const [activeGroups, setActiveGroups] = useState(new Set(Object.keys(GROUP_STYLE)));
 const [dim, setDim] = useState({ w: 900, h: 600 });
 const [pinMode, setPinMode] = useState(true);
 const [clusterMode, setClusterMode] = useState('group');
 const [showHulls, setShowHulls] = useState(true);
 const [pathStart, setPathStart] = useState(null);
 const [pathResult, setPathResult] = useState(null);
 const [lodLevel, setLodLevel] = useState(2); // 0=minimal, 1=basic, 2=full
 const containerRef = useRef();
 const animTimeRef = useRef(0);

 // Responsive canvas
 useEffect(() => {
  const obs = new ResizeObserver(entries => {
   if (entries[0]) {
    const { width, height } = entries[0].contentRect;
    setDim({ w: Math.max(400, width), h: Math.max(300, height) });
   }
  });
  if (containerRef.current) obs.observe(containerRef.current);
  return () => obs.disconnect();
 }, []);

 // Animation tick
 useEffect(() => {
  let raf;
  const tick = () => { animTimeRef.current = Date.now(); raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
 }, []);

 // Load graph — with error handling
 const load = useCallback(() => {
  setLoading(true);
  setError(null);
  cachedFetch('/api/graph').then(data => {
   if (!data || !data.nodes || !Array.isArray(data.nodes)) {
    setError('Invalid graph data received');
    return;
   }
   for (const l of (data.links || [])) {
    l.ropeLen = ROPE_LENGTHS[l.type] || DEFAULT_ROPE;
   }
   setGraphData({ nodes: data.nodes, links: data.links || [] });
   // Seed initial positions from targetXY so simulation starts spread at cluster sectors,
   // not collapsed at origin (important with warmupTicks={0} — no pre-render ticks to spread)
   requestAnimationFrame(() => {
     const fg = fgRef.current;
     if (!fg) return;
     const nodes = fg.graphData().nodes;
     recomputeClusterCounts(nodes);
     for (const n of nodes) {
       if (n.fx == null && n.fy == null) {
         const [tx, ty] = targetXY(n);
         if (typeof n.x !== 'number') n.x = tx;
         if (typeof n.y !== 'number') n.y = ty;
       }
     }
     fg.d3ReheatSimulation();
   });
  }).catch(err => {
   console.error('Neural Map load error:', err);
   setError('Failed to load graph data. Check that the server is running and /api/graph responds.');
  }).finally(() => setLoading(false));
 }, []);

 usePolling(load, 60000);

 // WS live updates
 const { lastEvent } = useWebSocket();
 useEffect(() => {
  if (lastEvent && fgRef.current) {
   fgRef.current.d3ReheatSimulation();
  }
 }, [lastEvent]);

 // Activity feed
 const activity = useActivityFeed();

 // Auto-fit graph on data load
 useEffect(() => {
  if (graphData.nodes.length > 0 && fgRef.current) {
   setTimeout(() => {
    try { fgRef.current.zoomToFit(400, 50); } catch {}
   }, 4000);
  }
 }, [graphData.nodes.length]);

 // ─── Force configuration (standalone — called from onEngineTick) ─────
// Must run inside the first engine tick, NOT a useEffect, because
// useEffect fires AFTER the simulation's first tick — default forces
// would already have pulled all nodes to center.
const CLUSTER_SECTORS = { runtime: 0, models: 72, interface: 144, integrate: 216, infra: 288 };
const toRad = deg => (deg * Math.PI) / 180;

// Precompute per-cluster node count so we can scale cluster radius dynamically.
// Updated on each data load — see configureForces.
let _clusterCounts = {};
let _clusterRadii = {};

function recomputeClusterCounts(nodes) {
  _clusterCounts = {};
  for (const n of nodes) {
    const c = n.cluster || (n.id && n.id.startsWith('cluster:') ? n.id.split(':')[1] : null) || 'unclustered';
    _clusterCounts[c] = (_clusterCounts[c] || 0) + 1;
  }
  // Each node needs ~40px of ring circumference to avoid overlap.
  // radius = max(120, count * 40 / (2π)) + padding
  _clusterRadii = {};
  for (const [c, count] of Object.entries(_clusterCounts)) {
    const ringCircumference = count * 44;
    const radius = Math.max(140, ringCircumference / (2 * Math.PI) + 30);
    _clusterRadii[c] = radius;
  }
}

const targetXY = (d) => {
  if (d.group === 'system') return [0, 0];
  const cluster = d.cluster || (d.id && d.id.startsWith('cluster:') ? d.id.split(':')[1] : null);
  if (!cluster) {
    const a = Math.random() * 2 * Math.PI;
    const r = 320 + Math.random() * 60;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }
  const angle = CLUSTER_SECTORS[cluster] ?? 0;
  const clusterRadius = _clusterRadii[cluster] || 200;
  if (d.group === 'cluster') {
    return [Math.cos(toRad(angle)) * clusterRadius, Math.sin(toRad(angle)) * clusterRadius];
  }
  // Spread satellites in a ring around their cluster center.
  // Use deterministic hash for angle, plus radius proportional to cluster size.
  const hash = d.id ? d.id.split('').reduce((a, c) => a + ((a * 31) + c.charCodeAt(0)) | 0, 0) : 0;
  const nodeCount = _clusterCounts[cluster] || 1;
  // Spread across full 360° but bias toward the cluster's outward direction
  const spreadAngle = toRad(angle + (hash % 360));
  const ringR = clusterRadius + 50 + (hash % 7) * 15;
  return [Math.cos(spreadAngle) * ringR, Math.sin(spreadAngle) * ringR];
};

function configureForces(fg, n) {
  // Recompute cluster sizes for dynamic radius
  recomputeClusterCounts(fg.graphData().nodes);

  const sim = fg.d3Force('link');
  if (sim) {
   sim.distance(l => l.ropeLen || DEFAULT_ROPE);
   sim.strength(0.15);  // weaker link pull so clusters can spread
  }
  fg.d3Force('center', d3.forceCenter().strength(0.005));
  // Stronger charge for more nodes — they need more room
  const chargeStrength = n > 150 ? -400 : n > 80 ? -320 : n > 40 ? -260 : -200;
  fg.d3Force('charge', d3.forceManyBody()
   .strength(d => {
    const base = (GROUP_STYLE[d.group] || GROUP_STYLE.system).size;
    const mul = d.group === 'system' ? 3 : d.group === 'cluster' ? 2 : 1;
    return chargeStrength * mul * (base / 6);
   })
   .distanceMax(800)
   .theta(0.9)
  );
  // Bigger collision radius — nodes need more breathing room
  fg.d3Force('collision', d3.forceCollide()
   .radius(d => (GROUP_STYLE[d.group] || GROUP_STYLE.system).size * 4 + 6)
   .strength(1)
   .iterations(4)
  );
  // Stronger positional forces so clusters actually separate
  fg.d3Force('x', d3.forceX()
   .x(d => targetXY(d)[0])
   .strength(d => d.group === 'system' ? 1 : d.group === 'cluster' ? 0.8 : 0.45)
  );
  fg.d3Force('y', d3.forceY()
   .y(d => targetXY(d)[1])
   .strength(d => d.group === 'system' ? 1 : d.group === 'cluster' ? 0.8 : 0.45)
  );
  fg.d3Force('radial', null);
  fg.d3AlphaDecay(0.008);   // slower cooldown = more time to settle
  fg.d3VelocityDecay(0.3);  // less friction = nodes travel further apart
}

// Configure d3 forces — strong repulsion so nodes spread out, not pile up
 useEffect(() => {
  if (graphData.nodes.length > 0 && fgRef.current && fgRef.current.__forcesConfigured) {
   // Reconfigure on subsequent data updates (refresh/poll)
   try {
    configureForces(fgRef.current, graphData.nodes.length);
    fgRef.current.d3ReheatSimulation();
   } catch (e) { console.warn('Force reconfig error:', e); }
  }
 }, [graphData]);

 // Filter by search + active groups
 const filteredData = useMemo(() => {
  const searchLower = search.toLowerCase();
  const matchSearch = (n) => !searchLower || (n.name || '').toLowerCase().includes(searchLower) || (n.group || '').toLowerCase().includes(searchLower);
  const matchGroup = (n) => activeGroups.has(n.group);

  const visibleNodes = graphData.nodes.filter(n => matchSearch(n) && matchGroup(n));
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleLinks = graphData.links.filter(l => visibleIds.has(l.source?.id || l.source) && visibleIds.has(l.target?.id || l.target));

  return { nodes: visibleNodes, links: visibleLinks };
 }, [graphData, search, activeGroups]);

 // Memoized 2-hop neighbor map: node id → Set of nodes reachable in ≤2 hops.
 // Built once per filteredData change; O(E) construction, O(1) lookup on hover.
 const neighborMap = useMemo(() => {
   const map = new Map();          // id → Set<id>
   const ensure = id => { let s = map.get(id); if (!s) { s = new Set(); map.set(id, s); } return s; };
   for (const l of filteredData.links) {
    const sId = l.source?.id ?? l.source;
    const tId = l.target?.id ?? l.target;
    if (sId == null || tId == null) continue;
    ensure(sId).add(tId);
    ensure(tId).add(sId);
   }
   // Expand to 2-hop: union each node's neighbors-of-neighbors
   for (const [id, direct] of map) {
    const hop2 = new Set(direct);
    for (const nId of direct) {
     const ns = map.get(nId);
     if (ns) for (const nnId of ns) if (nnId !== id) hop2.add(nnId);
    }
    map.set(id, hop2);
   }
   return map;
  }, [filteredData]);

 // Hover neighbors — now uses the 2-hop map
 const hoverNeighbors = useMemo(() => {
   if (!hoverNode) return new Set();
   return neighborMap.get(hoverNode.id) ?? new Set([hoverNode.id]);
  }, [hoverNode, neighborMap]);

 // Group counts
 const groupCounts = useMemo(() => {
  const counts = {};
  for (const n of graphData.nodes) counts[n.group] = (counts[n.group] || 0) + 1;
  return counts;
 }, [graphData]);

 // ─── Pathfinding (BFS shortest path) ─────────────────────────────
 const findPath = useCallback((startId, endId) => {
  if (!startId || !endId || startId === endId) return null;
  const adj = new Map();
  for (const l of filteredData.links) {
   const sId = l.source?.id ?? l.source;
   const tId = l.target?.id ?? l.target;
   if (!adj.has(sId)) adj.set(sId, []);
   if (!adj.has(tId)) adj.set(tId, []);
   adj.get(sId).push(tId);
   adj.get(tId).push(sId);
  }
  const visited = new Set([startId]);
  const queue = [[startId]];
  while (queue.length) {
   const path = queue.shift();
   const node = path[path.length - 1];
   if (node === endId) return path;
   for (const next of (adj.get(node) || [])) {
    if (!visited.has(next)) { visited.add(next); queue.push([...path, next]); }
   }
  }
  return null;
 }, [filteredData]);

 // Handle path start/end selection
 const handlePathClick = useCallback((node) => {
  if (!pathStart) {
   setPathStart(node);
   setPathResult(null);
  } else if (pathStart.id === node.id) {
   setPathStart(null);
   setPathResult(null);
  } else {
   const path = findPath(pathStart.id, node.id);
   setPathResult(path ? { path, nodes: path.map(id => filteredData.nodes.find(n => n.id === id)).filter(Boolean) } : { path: [], nodes: [] });
   setPathStart(null);
  }
 }, [pathStart, findPath, filteredData]);

 // ─── Export functions ────────────────────────────────────────────
 const exportPNG = useCallback(() => {
  const fg = fgRef.current;
  if (!fg) return;
  const canvas = fg.container?.querySelector('canvas');
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = 'neural-map.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
 }, []);

 const exportJSON = useCallback(() => {
  const data = JSON.stringify({ nodes: filteredData.nodes.map(n => ({ id: n.id, name: n.name, group: n.group, cluster: n.cluster })), links: filteredData.links.map(l => ({ source: l.source?.id || l.source, target: l.target?.id || l.target, type: l.type })) }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const link = document.createElement('a');
  link.download = 'neural-map.json';
  link.href = URL.createObjectURL(blob);
  link.click();
 }, [filteredData]);

 // ─── LOD (Level of Detail) — adjust rendering based on zoom & node count ─
 const computedLOD = useMemo(() => {
  const zoom = fgRef.current?.zoom?.() ?? 1;
  const count = filteredData.nodes.length;
  if (count > 200 || zoom < 0.4) return 0; // minimal
  if (count > 100 || zoom < 0.8) return 1;  // basic
  return 2; // full
 }, [filteredData.nodes.length]);

 // ─── Cluster hulls for canvas overlay ─────────────────────────────
 const clusterHulls = useMemo(() => {
  if (!showHulls) return [];
  const byCluster = {};
  for (const n of filteredData.nodes) {
   if (typeof n.x !== 'number') continue;
   const c = n.cluster || (n.id && n.id.startsWith('cluster:') ? n.id.split(':')[1] : null) || n.group || 'unclustered';
   if (!byCluster[c]) byCluster[c] = [];
   byCluster[c].push({ x: n.x, y: n.y, color: (GROUP_STYLE[n.group] || GROUP_STYLE.system).color });
  }
  const hulls = [];
  for (const [cluster, points] of Object.entries(byCluster)) {
   if (points.length < 3) continue;
   const hull = convexHull(points);
   const color = points[0]?.color || NEON.magenta;
   hulls.push({ cluster, hull, color, count: points.length });
  }
  return hulls;
 }, [filteredData, showHulls]);

 // ─── Custom Canvas Renderer ─────────────────────────────────────
 const nodePaint = useCallback(({ id, name, group, status, isDefault, modelCount }, ctx, globalScale) => {
  const style = GROUP_STYLE[group] || GROUP_STYLE.system;
  const isHovered = hoverNode?.id === id;
  const isNeighbor = hoverNode ? hoverNeighbors.has(id) : true;
  const isSelected = selectedNode?.id === id;
  const isPathStart = pathStart?.id === id;
  const isOnPath = pathResult?.path?.includes(id);
  const opacity = hoverNode ? (isNeighbor ? 1 : 0.06) : 1;
  const useLOD = computedLOD === 0;

  const baseR = style.size;
  const r = baseR * (isHovered ? 1.8 : isDefault ? 1.3 : 1);

  // Outer glow (skip at LOD 0 for performance)
  if (!useLOD && ((style.glow || isHovered || isSelected || isOnPath) && opacity > 0.3)) {
   const glowR = r + (style.glow ? 14 : 10) + (isOnPath ? 6 : 0);
   const gradient = ctx.createRadialGradient(0, 0, r, 0, 0, glowR);
   const glowColor = isOnPath ? NEON.cyan : isPathStart ? NEON.yellow : style.color;
   gradient.addColorStop(0, glowColor + '35');
   gradient.addColorStop(1, glowColor + '00');
   ctx.beginPath();
   ctx.arc(0, 0, glowR, 0, 2 * Math.PI);
   ctx.fillStyle = gradient;
   ctx.fill();
  }

  // Pulsing ring for active/running
  if (status && (status === 'running' || status === 'active') && opacity > 0.3) {
   const pulse = 0.4 + 0.6 * Math.abs(Math.sin(Date.now() / 500));
   ctx.beginPath();
   ctx.arc(0, 0, r + 5, 0, 2 * Math.PI);
   ctx.strokeStyle = (STATUS_COLORS[status] || NEON.green) + Math.floor(pulse * 50).toString(16).padStart(2, '0');
   ctx.lineWidth = 1.5;
   ctx.stroke();
  }

  // Main circle
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, 2 * Math.PI);
  const fillAlpha = opacity < 1 ? '10' : isSelected ? 'dd' : isHovered ? 'cc' : '88';
  ctx.fillStyle = style.color + fillAlpha;
  ctx.fill();

  // Inner highlight
  if (opacity > 0.3 && r > 3) {
   const innerGrad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r);
   innerGrad.addColorStop(0, '#ffffff18');
   innerGrad.addColorStop(1, '#00000000');
   ctx.beginPath();
   ctx.arc(0, 0, r, 0, 2 * Math.PI);
   ctx.fillStyle = innerGrad;
   ctx.fill();
  }

  // Selected ring
  if (isSelected) {
   ctx.beginPath();
   ctx.arc(0, 0, r + 3, 0, 2 * Math.PI);
   ctx.strokeStyle = style.color + 'cc';
   ctx.lineWidth = 2;
   ctx.stroke();
  }

  // Label (respect LOD — hide labels at LOD 0)
  const showLabel = !useLOD && (globalScale > 1.2 || isHovered || isSelected || isPathStart || isOnPath || group === 'system' || group === 'provider' || group === 'user' || group === 'agent');
  if (showLabel && opacity > 0.2) {
   const fontSize = Math.max(7, 10 / globalScale);
   ctx.font = `${isHovered || isSelected ? 'bold ' : ''}${fontSize}px "Share Tech Mono", "Fira Code", monospace`;
   ctx.textAlign = 'center';
   ctx.textBaseline = 'top';
   const labelAlpha = isHovered || isSelected ? 1 : Math.min(1, opacity * 0.7);
   ctx.fillStyle = `rgba(220,220,240,${labelAlpha})`;
   // Show model count on providers
   let label = name.length > 18 ? name.slice(0, 16) + '…' : name;
   if (group === 'provider' && modelCount) label += ` (${modelCount})`;
   ctx.fillText(label, 0, r + 4);
  }
 }, [hoverNode, hoverNeighbors, selectedNode, pathStart, pathResult, computedLOD]);

 // ─── Custom Link Renderer ────────────────
 const neighborMapRef = useRef(neighborMap);
 useEffect(() => { neighborMapRef.current = neighborMap; }, [neighborMap]);
 const linkCanvasObject = useCallback((link, ctx, globalScale) => {
  const src = link.source;
  const tgt = link.target;
  if (!src || !tgt || typeof src.x !== 'number' || typeof tgt.x !== 'number') return;

  const type = link.type || 'registered';
  const baseColor = LINK_COLORS[type] || '#222';
  const ropeLen = link.ropeLen || DEFAULT_ROPE;
  const time = animTimeRef.current;

  let alpha = '18';
  let width = 0.5;
  let particles = false;
  if (hoverNode) {
   const sId = src.id || link.source;
   const tId = tgt.id || link.target;
   // 2-hop highlight: show edges where BOTH endpoints are in the hover node's 2-hop set
   const hop = neighborMapRef.current;
   const near = hop?.get(hoverNode.id);
   const inHighlight = near && near.has(sId) && near.has(tId);
   const isDirect = sId === hoverNode.id || tId === hoverNode.id;
   if (isDirect)        { alpha = 'a0'; width = 2.0; particles = true; }
   else if (inHighlight){ alpha = '48'; width = 1.0; particles = false; }
   else                 { alpha = '05'; width = 0.2; }
  } else {
   const activeTypes = ['hosts', 'uses', 'assigned', 'mcp', 'api', 'chat'];
   particles = activeTypes.includes(type);
  }

  const color = baseColor + alpha;
  drawRope(ctx, src.x, src.y, tgt.x, tgt.y, ropeLen, color, width, globalScale, alpha === 'a0' || alpha === '48', particles, time);
 }, [hoverNode]);

 const linkCanvasObjectMode = useCallback(() => 'replace', []);

 // Click handler — supports pathfinding mode
 const handleNodeClick = useCallback(node => {
  // If pathfinding mode is active (pathStart set, or path button was clicked)
  if (pathStart !== null || pathResult !== null) {
   if (!pathStart) {
    setPathStart(node);
    return;
   }
   if (pathStart.id === node.id) {
    setPathStart(null);
    return;
   }
   const path = findPath(pathStart.id, node.id);
   setPathResult(path ? { path, nodes: path.map(id => filteredData.nodes.find(n => n.id === id)).filter(Boolean) } : { path: [], nodes: [] });
   setPathStart(null);
   return;
  }
  setSelectedNode(prev => prev?.id === node.id ? null : node);
  if (fgRef.current) {
   fgRef.current.centerAt(node.x, node.y, 600);
   fgRef.current.zoom(2.5, 600);
  }
 }, [pathStart, pathResult, findPath, filteredData.nodes]);

 // Right-click to fit all
 const handleNodeRightClick = useCallback((node, e) => {
  e.preventDefault();
  setSelectedNode(null);
  if (fgRef.current) fgRef.current.zoomToFit(400, 50, 600);
 }, []);

 // Hover handler
 const handleNodeHover = useCallback(node => {
  setHoverNode(node);
  if (containerRef.current) containerRef.current.style.cursor = node ? 'grab' : 'default';
 }, []);

 // Drag handlers
 const handleNodeDrag = useCallback(node => {
  node.fx = node.x;
  node.fy = node.y;
  if (fgRef.current) fgRef.current.d3ReheatSimulation();
 }, []);

 const handleNodeDragEnd = useCallback(node => {
  if (pinMode) { node.fx = node.x; node.fy = node.y; }
  else { node.fx = null; node.fy = null; }
 }, [pinMode]);

 const handleNodeDoubleClick = useCallback(node => {
  node.fx = null; node.fy = null;
  if (fgRef.current) fgRef.current.d3ReheatSimulation();
 }, []);

 const unpinAll = useCallback(() => {
  if (!fgRef.current) return;
  const { nodes } = fgRef.current.graphData();
  for (const n of nodes) { n.fx = null; n.fy = null; }
  fgRef.current.d3ReheatSimulation();
 }, []);

 const toggleGroup = (g) => {
  setActiveGroups(prev => {
   const next = new Set(prev);
   if (next.has(g)) next.delete(g); else next.add(g);
   return next;
  });
 };

 const zoomIn = () => fgRef.current?.zoom(fgRef.current.zoom() * 1.5, 300);
 const zoomOut = () => fgRef.current?.zoom(fgRef.current.zoom() * 0.67, 300);
 const fitAll = () => fgRef.current?.zoomToFit(400, 50, 600);

 // Selected node connections
 const selectedConnections = useMemo(() => {
  if (!selectedNode) return [];
  return filteredData.links
   .filter(l => (l.source?.id || l.source) === selectedNode.id || (l.target?.id || l.target) === selectedNode.id)
   .map(l => {
    const isSource = (l.source?.id || l.source) === selectedNode.id;
    const otherId = isSource ? (l.target?.id || l.target) : (l.source?.id || l.source);
    const otherNode = filteredData.nodes.find(n => n.id === otherId);
    return { link: l, isSource, otherNode, otherId };
   });
 }, [selectedNode, filteredData]);

 // ─── Error / Empty state ────────────────────
 if (error && graphData.nodes.length === 0) {
  return (
   <div className="space-y-4">
    <div className="flex items-center gap-3">
     <Network size={20} style={{ color: NEON.magenta, filter: `drop-shadow(0 0 6px ${NEON.magenta})` }} />
     <h2 className="text-xl font-bold" style={{ color: NEON.magenta, textShadow: `0 0 15px ${NEON.magenta}44` }}>Neural Map</h2>
    </div>
    <div className="flex flex-col items-center justify-center py-20 rounded-xl" style={{ background: BG.card, border: `1px solid ${NEON.red}30` }}>
     <AlertTriangle size={32} className="mb-3" style={{ color: NEON.red }} />
     <div className="text-sm text-gray-400 mb-1">Failed to load graph</div>
     <div className="text-xs text-gray-600 mb-4 max-w-md text-center">{error}</div>
     <button onClick={load} className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all"
      style={{ background: `${NEON.cyan}10`, border: `1px solid ${NEON.cyan}30`, color: NEON.cyan }}>
      <RefreshCw size={12} /> Retry
     </button>
    </div>
   </div>
  );
 }

 return (
  <div className="space-y-4">
   {/* Header */}
   <div className="flex items-center justify-between flex-wrap gap-3">
    <div className="flex items-center gap-3">
     <Network size={20} style={{ color: NEON.magenta, filter: `drop-shadow(0 0 6px ${NEON.magenta})` }} />
     <h2 className="text-xl font-bold font-hud" style={{ color: NEON.magenta, textShadow: `0 0 15px ${NEON.magenta}44` }}>Neural Map</h2>
     <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.magenta}12`, color: NEON.magenta, border: `1px solid ${NEON.magenta}25` }}>
      {filteredData.nodes.length} nodes · {filteredData.links.length} cords
     </span>
    </div>
    <div className="flex items-center gap-2">
     <button onClick={() => setPinMode(!pinMode)} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all"
      style={{ background: pinMode ? `${NEON.green}10` : 'rgba(0,0,0,0.2)', border: `1px solid ${pinMode ? NEON.green + '30' : '#222'}`, color: pinMode ? NEON.green : '#555' }}
      title={pinMode ? 'Nodes pin where dropped' : 'Nodes float free after drag'}>
      {pinMode ? <Pin size={12} /> : <PinOff size={12} />}
      {pinMode ? 'Pin On' : 'Pin Off'}
     </button>
     <button onClick={unpinAll} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-gray-500 hover:text-cyan-400 hover:bg-white/5 transition-all"
      title="Release all pinned nodes">
      <Unlock size={12} /> Release
     </button>
     <div className="w-px h-4 bg-gray-800" />
     <div className="relative">
      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search nodes..."
       className="pl-9 pr-8 py-1.5 rounded-lg text-xs text-white bg-black/40 outline-none w-40 focus:ring-1 focus:ring-cyan-500/30 transition-all" style={{ border: `1px solid ${NEON.magenta}15` }} />
      {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"><X size={12} /></button>}
     </div>
     <button onClick={() => setShowFilters(v => !v)} className="p-1.5 rounded-lg text-gray-500 hover:bg-white/5 transition-colors"
      style={{ border: showFilters ? `1px solid ${NEON.magenta}40` : '1px solid transparent', color: showFilters ? NEON.magenta : undefined }}>
      <Filter size={14} />
     </button>
     <button onClick={load} className="p-1.5 rounded-lg text-gray-500 hover:text-magenta-400 hover:bg-white/5 transition-colors"><RefreshCw size={14} /></button>
     <div className="w-px h-4 bg-gray-800" />
     {/* Cluster mode selector */}
     <select value={clusterMode} onChange={e => setClusterMode(e.target.value)}
      className="text-[10px] rounded-lg bg-black/40 text-gray-400 outline-none px-2 py-1"
      style={{ border: `1px solid ${NEON.magenta}20` }} title="Clustering mode">
      {Object.entries(CLUSTER_MODES).map(([key, mode]) => (
       <option key={key} value={key}>{mode.icon} {mode.label}</option>
      ))}
     </select>
     <button onClick={() => setShowHulls(v => !v)} className="p-1.5 rounded-lg transition-colors"
      style={{ border: showHulls ? `1px solid ${NEON.cyan}40` : '1px solid transparent', color: showHulls ? NEON.cyan : '#555' }}
      title="Toggle cluster hulls">
      <span className="text-[10px]">⊕</span> Hulls
     </button>
     <button onClick={() => { setPathStart(null); setPathResult(null); }} className="p-1.5 rounded-lg text-gray-500 hover:text-yellow-400 hover:bg-white/5 transition-colors"
      style={{ border: pathStart ? `1px solid ${NEON.yellow}40` : '1px solid transparent', color: pathStart ? NEON.yellow : '#555' }}
      title="Pathfinding: click two nodes">
      <span className="text-[10px]">→</span> Path
     </button>
     <button onClick={exportPNG} className="p-1.5 rounded-lg text-gray-500 hover:text-cyan-400 hover:bg-white/5 transition-colors" title="Export PNG">
      <span className="text-[10px]">PNG</span>
     </button>
     <button onClick={exportJSON} className="p-1.5 rounded-lg text-gray-500 hover:text-cyan-400 hover:bg-white/5 transition-colors" title="Export JSON">
      <span className="text-[10px]">JSON</span>
     </button>
     <div className="w-px h-4 bg-gray-800" />
     <button onClick={() => setShowActivity(v => !v)} className="p-1.5 rounded-lg transition-colors"
      style={{ border: showActivity ? `1px solid ${NEON.green}40` : '1px solid transparent', color: showActivity ? NEON.green : '#555' }}
      title="Toggle live activity feed">
      <Activity size={14} />
     </button>
    </div>
   </div>

   {/* Group filter pills */}
   {showFilters && (
    <div className="flex flex-wrap gap-1.5 px-1">
     {Object.entries(GROUP_STYLE).map(([key, style]) => {
      const count = groupCounts[key] || 0;
      if (count === 0 && !activeGroups.has(key)) return null;
      return (
       <button key={key} onClick={() => toggleGroup(key)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
        style={{
         background: activeGroups.has(key) ? `${style.color}12` : 'rgba(0,0,0,0.2)',
         border: `1px solid ${activeGroups.has(key) ? style.color + '35' : '#1a1a1a'}`,
         color: activeGroups.has(key) ? style.color : '#444',
        }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: activeGroups.has(key) ? style.color : '#333' }} />
        {key} <span className="text-[9px] opacity-60">{count}</span>
       </button>
      );
     })}
    </div>
   )}

   {/* Force Graph Canvas */}
   <div ref={containerRef} className="rounded-xl overflow-hidden relative" style={{ background: BG.base, border: `1px solid ${NEON.cyan}10` }}>
    {loading && graphData.nodes.length === 0 ? (
     <div className="flex items-center justify-center" style={{ height: dim.h }}>
      <div className="text-center text-gray-600">
       <Network size={32} className="mx-auto mb-2 opacity-30 animate-pulse" />
       <div className="text-sm">Loading graph...</div>
      </div>
     </div>
    ) : graphData.nodes.length === 0 ? (
     <div className="flex items-center justify-center" style={{ height: dim.h }}>
      <div className="text-center text-gray-600">
       <Network size={32} className="mx-auto mb-2 opacity-30" />
       <div className="text-sm">No graph data available</div>
       <div className="text-xs text-gray-700 mt-1">Create agents, tasks, or providers to populate the map</div>
      </div>
     </div>
    ) : (
     <ForceGraph2D
      ref={fgRef}
      width={dim.w}
      height={dim.h}
      graphData={filteredData}
      nodeId="id"
      nodeLabel="name"
      nodeVal={n => (GROUP_STYLE[n.group] || GROUP_STYLE.system).size}
      nodeCanvasObject={nodePaint}
      nodeCanvasObjectMode={() => 'replace'}
      linkCanvasObject={linkCanvasObject}
      linkCanvasObjectMode={linkCanvasObjectMode}
      onNodeClick={handleNodeClick}
      onNodeHover={handleNodeHover}
      onNodeDrag={handleNodeDrag}
      onNodeDragEnd={handleNodeDragEnd}
      onNodeRightClick={handleNodeRightClick}
      onNodeDoubleClick={handleNodeDoubleClick}
      onBackgroundClick={() => setSelectedNode(null)}
      backgroundColor={BG.base}
      warmupTicks={0}
      cooldownTicks={300}
      cooldownTime={15000}
      d3AlphaDecay={0.008}
      d3VelocityDecay={0.3}
      onEngineTick={() => {
        // One-shot force configuration on the very first tick.
        // Custom forces must be installed here because useEffect runs
        // AFTER the simulation has already had its first tick — which
        // means default forces have already pulled everything to center.
        const fg = fgRef.current;
        if (!fg || fg.__forcesConfigured) return;
        fg.__forcesConfigured = true;
        try {
          configureForces(fg, filteredData.nodes.length);
          fg.d3ReheatSimulation();
        } catch (e) {
          console.warn('Force config error:', e);
        }
      }}
      enableNodeDrag={true}
      enableZoomInteraction={true}
      enablePanInteraction={true}
      minZoom={0.2}
      maxZoom={12}
     />
    )}

    {/* Legend overlay */}
    <div className="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-600 bg-black/70 backdrop-blur-sm px-3 py-1.5 rounded-lg">
     {Object.entries(GROUP_STYLE).filter(([k]) => (groupCounts[k] || 0) > 0).map(([key, style]) => (
      <span key={key} className="flex items-center gap-1 cursor-pointer hover:text-gray-400 transition-colors" onClick={() => toggleGroup(key)}>
       <span className="w-1.5 h-1.5 rounded-full" style={{ background: style.color, opacity: activeGroups.has(key) ? 1 : 0.3 }} /> {key}
      </span>
     ))}
    </div>

    {/* Zoom controls */}
    <div className="absolute bottom-3 right-3 flex items-center gap-1">
     <button onClick={zoomOut} className="p-1.5 rounded-lg bg-black/70 backdrop-blur-sm text-gray-500 hover:text-white hover:bg-white/5 transition-all" style={{ border: '1px solid #222' }}><ZoomOut size={14} /></button>
     <button onClick={fitAll} className="p-1.5 rounded-lg bg-black/70 backdrop-blur-sm text-gray-500 hover:text-white hover:bg-white/5 transition-all" style={{ border: '1px solid #222' }}><Maximize2 size={14} /></button>
     <button onClick={zoomIn} className="p-1.5 rounded-lg bg-black/70 backdrop-blur-sm text-gray-500 hover:text-white hover:bg-white/5 transition-all" style={{ border: '1px solid #222' }}><ZoomIn size={14} /></button>
    </div>

    {/* Live Activity Feed overlay */}
    {showActivity && (
     <div className="absolute top-3 right-3 w-72 max-w-[60%]" style={{ animation: 'fadeIn 0.2s ease' }}>
      <ActivityFeed
        events={activity.events}
        connected={activity.connected}
        paused={activity.paused}
        setPaused={activity.setPaused}
        clear={activity.clear}
        compact
      />
     </div>
    )}

    {/* Minimap — shows full graph bounding box + current viewport rectangle.
        Renders node dots + a cyan viewport rect. Click to pan. */}
    <Minimap fgRef={fgRef} graphData={filteredData} dim={dim} />

    {/* Hint */}
    <div className="absolute top-3 right-3 text-[10px] text-gray-700 bg-black/50 backdrop-blur-sm px-2 py-1 rounded">
     Drag to pin · Double-click to release · Right-click to fit all
    </div>
   </div>

   {/* Selected node detail panel */}
   {selectedNode && (
    <div className="rounded-xl p-4" style={{ background: `${BG.card}f5`, border: `1px solid ${(GROUP_STYLE[selectedNode.group] || GROUP_STYLE.system).color}20` }}>
     <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2.5">
       <span className="w-3.5 h-3.5 rounded-full" style={{ background: (GROUP_STYLE[selectedNode.group] || GROUP_STYLE.system).color, boxShadow: `0 0 8px ${(GROUP_STYLE[selectedNode.group] || GROUP_STYLE.system).color}60` }} />
       <h3 className="text-sm font-bold text-white font-hud">{selectedNode.name}</h3>
       <span className="px-2 py-0.5 rounded text-[10px] font-medium" style={{
        background: `${(GROUP_STYLE[selectedNode.group] || GROUP_STYLE.system).color}12`,
        color: (GROUP_STYLE[selectedNode.group] || GROUP_STYLE.system).color,
        border: `1px solid ${(GROUP_STYLE[selectedNode.group] || GROUP_STYLE.system).color}25`
       }}>{selectedNode.group}</span>
       {selectedNode.status && (
        <span className="px-2 py-0.5 rounded text-[10px]" style={{
         background: `${STATUS_COLORS[selectedNode.status] || '#555'}12`,
         color: STATUS_COLORS[selectedNode.status] || '#888',
        }}>{selectedNode.status}</span>
       )}
       {selectedNode.isDefault && (
        <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ background: `${NEON.yellow}12`, color: NEON.yellow, border: `1px solid ${NEON.yellow}25` }}>★ default</span>
       )}
       {selectedNode.fx != null && (
        <span className="px-1.5 py-0.5 rounded text-[9px]" style={{ background: `${NEON.green}10`, color: NEON.green, border: `1px solid ${NEON.green}20` }}>📌 pinned</span>
       )}
      </div>
      <div className="flex items-center gap-2">
       {selectedNode.fx != null && (
        <button onClick={() => { selectedNode.fx = null; selectedNode.fy = null; fgRef.current?.d3ReheatSimulation(); setSelectedNode({...selectedNode, fx: null, fy: null}); }}
         className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors" style={{ color: NEON.cyan }}>
         <Unlock size={11} className="inline mr-1" />Unpin
        </button>
       )}
       <button onClick={() => setSelectedNode(null)} className="text-gray-600 hover:text-gray-400"><X size={14} /></button>
      </div>
     </div>

     {/* Metadata grid */}
     <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
      {selectedNode.modelCount && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">Models</span><span className="text-xs font-mono font-code" style={{ color: '#5eead4' }}>{selectedNode.modelCount}</span></div>}
      {selectedNode.ptype && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">Type</span><span className="text-xs font-mono font-code" style={{ color: NEON.cyan }}>{selectedNode.ptype}</span></div>}
      {selectedNode.context && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">Context</span><span className="text-xs font-mono font-code" style={{ color: NEON.blue }}>{(selectedNode.context/1000).toFixed(0)}k</span></div>}
      {selectedNode.transport && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">Transport</span><span className="text-xs font-mono font-code" style={{ color: NEON.orange }}>{selectedNode.transport}</span></div>}
      {selectedNode.mime && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">MIME</span><span className="text-xs font-mono font-code" style={{ color: NEON.blue }}>{selectedNode.mime}</span></div>}
      {selectedNode.role && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">Role</span><span className="text-xs font-mono font-code" style={{ color: NEON.purple }}>{selectedNode.role}</span></div>}
      {selectedNode.category && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">Category</span><span className="text-xs font-mono font-code" style={{ color: NEON.purple }}>{selectedNode.category}</span></div>}
      {selectedNode.endpoint && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">Endpoint</span><span className="text-xs font-mono font-code text-gray-400">{selectedNode.endpoint}</span></div>}
      {selectedNode.path && <div className="rounded-lg p-2" style={{ background: 'rgba(0,0,0,0.3)' }}><span className="text-[10px] text-gray-600 block">Path</span><span className="text-xs font-mono font-code text-gray-400 truncate">{selectedNode.path}</span></div>}
     </div>

     {/* Connections list — split into inbound / outbound */}
     <div className="text-xs space-y-2">
      <div className="flex items-center justify-between text-gray-500">
       <span className="font-medium">Cords</span>
       <span className="text-[10px] text-gray-700">{selectedConnections.length} · {selectedConnections.filter(c => c.isSource).length} out · {selectedConnections.filter(c => !c.isSource).length} in</span>
      </div>
      <div className="max-h-40 overflow-y-auto space-y-0.5 pr-1" style={{ scrollbarWidth: 'thin' }}>
       {[['→', 'Outbound', c => c.isSource], ['←', 'Inbound', c => !c.isSource]].map(([arrow, label, filterFn]) => {
        const items = selectedConnections.filter(filterFn);
        if (items.length === 0) return null;
        return (
         <React.Fragment key={label}>
          <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-gray-700 pl-2 pt-1.5 pb-0.5 sticky top-0" style={{ background: BG.card }}>{arrow} {label}</div>
          {items.map(({ link, isSource, otherNode, otherId }, i) => {
           const otherStyle = GROUP_STYLE[otherNode?.group || 'system'] || GROUP_STYLE.system;
           const linkColor = LINK_COLORS[link.type] || '#555';
           return (
            <div key={`${label}-${i}`} className="flex items-center gap-2 pl-2 py-1 cursor-pointer hover:bg-white/3 rounded transition-colors"
             onClick={() => { const n = filteredData.nodes.find(nn => nn.id === otherId); if (n) handleNodeClick(n); }}>
             <span className="text-[10px]" style={{ color: linkColor }}>{isSource ? '→' : '←'}</span>
             <span className="w-2 h-2 rounded-full shrink-0" style={{ background: otherStyle.color }} />
             <span className="text-gray-300 truncate">{otherNode?.name || otherId}</span>
             <span className="text-[9px] text-gray-600 ml-auto shrink-0">{link.type}</span>
            </div>
           );
          })}
         </React.Fragment>
        );
       })}
       {selectedConnections.length === 0 && <div className="text-gray-700 pl-2">No cords</div>}
      </div>
     </div>
    </div>
   )}

  {/* Pathfinding result panel */}
  {(pathStart || pathResult) && (
   <div className="rounded-xl p-4" style={{ background: `${BG.card}f5`, border: `1px solid ${NEON.yellow}25` }}>
    <div className="flex items-center justify-between mb-2">
     <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold" style={{ color: NEON.yellow }}>→ PATHFIND</span>
      {pathStart && <span className="text-xs text-gray-400">Start: <span style={{ color: NEON.yellow }}>{pathStart.name}</span> — select end node</span>}
      {pathResult?.path?.length > 0 && <span className="text-xs text-gray-400">{pathResult.path.length - 1} hops · {pathResult.path.length} nodes</span>}
      {pathResult && pathResult.path.length === 0 && <span className="text-xs" style={{ color: NEON.red }}>No path found</span>}
     </div>
     <button onClick={() => { setPathStart(null); setPathResult(null); }} className="text-gray-600 hover:text-gray-400"><X size={14} /></button>
    </div>
    {pathResult?.nodes?.length > 0 && (
     <div className="flex flex-wrap gap-1.5">
      {pathResult.nodes.map((n, i) => {
       const style = GROUP_STYLE[n.group] || GROUP_STYLE.system;
       return (
        <React.Fragment key={n.id}>
         {i > 0 && <span className="text-gray-600 self-center">→</span>}
         <span className="px-2 py-0.5 rounded text-[10px] cursor-pointer" style={{ background: `${style.color}10`, color: style.color, border: `1px solid ${style.color}20` }} onClick={() => { const fn = filteredData.nodes.find(nn => nn.id === n.id); if (fn) handleNodeClick(fn); }}>{n.name}</span>
        </React.Fragment>
       );
      })}
     </div>
    )}
   </div>
  )}

  {/* Cluster hull legend (when hulls are on) */}
  {showHulls && clusterHulls.length > 0 && (
   <div className="flex flex-wrap gap-2 text-[10px] text-gray-600">
    {clusterHulls.slice(0, 8).map(h => (
     <span key={h.cluster} className="flex items-center gap-1">
      <span className="w-2 h-2 rounded-sm" style={{ background: h.color + '30', border: `1px solid ${h.color}` }} />
      {h.cluster} ({h.count})
     </span>
    ))}
    {clusterHulls.length > 8 && <span>+{clusterHulls.length - 8} more</span>}
   </div>
  )}
  </div>
 );
}
