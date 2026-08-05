import React, { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react';
import { api } from './AuthContext';
import { usePolling } from './usePolling';
import { useWebSocket } from './useWebSocket';
import { GitBranch, Save, Plus, Trash2, AlertTriangle, CheckCircle, Play, Square, ZoomIn, ZoomOut, Maximize2, RefreshCw, X, Copy, Power, PowerOff, Layers, Split, ChevronDown, Layout, Code, Webhook, Repeat, Bell } from 'lucide-react';

const NEON = { cyan:'#00f0ff', magenta:'#ff00ff', blue:'#3b82f6', purple:'#a855f7', green:'#22c55e', yellow:'#eab308', red:'#ef4444', pink:'#ec4899', orange:'#f97316', teal:'#14b8a6' };
const BG = { base:'#050510', card:'#0a0a1e', surface:'#0f0f23' };

// ─── Node Types (expanded) ────────────────────────────────────────
const NODE_TYPES = {
  trigger:   { color: NEON.green,  icon: '⚡', label: 'Trigger',   inputs: 0, outputs: 1 },
  task:      { color: NEON.cyan,   icon: '▶',  label: 'Task',      inputs: 1, outputs: 1 },
  condition: { color: NEON.yellow, icon: '◆',  label: 'Condition', inputs: 1, outputs: 2 },
  parallel:  { color: NEON.blue,   icon: '⫸',  label: 'Parallel',  inputs: 1, outputs: 1 },
  output:    { color: NEON.pink,   icon: '◉',  label: 'Output',    inputs: 1, outputs: 0 },
  delay:     { color: NEON.orange, icon: '⏱',  label: 'Delay',     inputs: 1, outputs: 1 },
  webhook:   { color: NEON.teal,   icon: '🔗', label: 'Webhook',   inputs: 0, outputs: 1 },
  transform: { color: NEON.purple, icon: '⇄',  label: 'Transform', inputs: 1, outputs: 1 },
  branch:    { color: NEON.magenta,icon: '⑂',  label: 'Branch',    inputs: 1, outputs: 3 },
  loop:      { color: '#f59e0b',   icon: '↻',  label: 'Loop',      inputs: 1, outputs: 1 },
  notify:    { color: '#ec4899',   icon: '🔔', label: 'Notify',    inputs: 1, outputs: 0 },
};

const NODE_W = 200, NODE_H = 72, PORT_R = 6;
const PORT_GAP = 24;
const STACK_OFFSET = 28;

// ─── SVG Glow Defs ─────────────────────────────────────────────────
const DEFS = (
  <defs>
    <filter id="dag-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
    <filter id="dag-node-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="5" floodColor="#000" floodOpacity="0.5" />
    </filter>
    <filter id="dag-drag-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="#000" floodOpacity="0.7" />
    </filter>
  </defs>
);

// ─── DAG Node (SVG) with z-index + hover stack/destack ─────────────
const DAGNode = memo(function DAGNode({ node, selected, isDragging, isTopOfStack, stackCount, onSelect, onDragStart, onPortDown, onPortUp, onStack, onDestack, running, progress }) {
  const cfg = NODE_TYPES[node.type] || NODE_TYPES.task;
  const x = node.x || 0, y = node.y || 0;
  const hasInput = cfg.inputs > 0;
  const outputCount = cfg.outputs;
  const [hovered, setHovered] = useState(false);
  const statusColor = node.status === 'running' ? NEON.green : node.status === 'completed' ? NEON.cyan : node.status === 'failed' ? NEON.red : '#444';

  // Progress ring (when running)
  const progressAngle = progress != null ? (progress / 100) * 360 : 0;

  return (
    <g transform={`translate(${x},${y})`}
      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Progress ring (when running) */}
      {running && (
        <circle cx={NODE_W/2} cy={NODE_H/2} r={NODE_H/2 + 4}
          fill="none" stroke={NEON.green} strokeWidth="2" opacity="0.6"
          strokeDasharray={`${(progressAngle/360) * (Math.PI * (NODE_H/2 + 4))} 999`}
          transform={`rotate(-90 ${NODE_W/2} ${NODE_H/2})`}
          strokeLinecap="round" />
      )}
      {/* Shadow rect */}
      <rect width={NODE_W} height={NODE_H} rx="12"
        fill={BG.card}
        stroke={selected ? cfg.color : `${cfg.color}40`}
        strokeWidth={selected ? 2 : 1}
        filter={isDragging ? 'url(#dag-drag-shadow)' : 'url(#dag-node-shadow)'}
        opacity={isDragging ? 1 : isTopOfStack ? 1 : 0.92}
      />
      {/* Top accent bar */}
      <rect width={NODE_W} height="3" rx="1.5" fill={cfg.color} opacity="0.6" y="0" />
      {/* Icon + name */}
      <text x="14" y="30" fontSize="14" dominantBaseline="central">{cfg.icon}</text>
      <text x="36" y="24" fontSize="12" fontWeight="600" fill="#eee" fontFamily="sans-serif">{node.name}</text>
      <text x="36" y="42" fontSize="9" fill="#666" fontFamily="sans-serif">{cfg.label}{node.command ? ` · ${node.command.slice(0, 20)}` : ''}</text>
      {/* Status LED */}
      {node.status && (
        <circle cx={NODE_W - 14} cy="14" r="4" fill={statusColor}>
          {node.status === 'running' && <animate attributeName="opacity" values="1;0.4;1" dur="1s" repeatCount="indefinite" />}
        </circle>
      )}
      {/* Stack count badge */}
      {stackCount > 1 && (
        <g>
          <circle cx={NODE_W - 14} cy={NODE_H - 14} r="10" fill={`${cfg.color}20`} stroke={cfg.color} strokeWidth="1" />
          <text x={NODE_W - 14} y={NODE_H - 14} fontSize="9" fontWeight="700" fill={cfg.color} textAnchor="middle" dominantBaseline="central">{stackCount}</text>
        </g>
      )}
      {/* Input port */}
      {hasInput && (
        <circle cx="0" cy={NODE_H / 2} r={PORT_R} fill={selected ? cfg.color : BG.base} stroke="#555" strokeWidth="1.5"
          onMouseDown={e => { e.stopPropagation(); onPortDown(node.id, 'input', 0, x, y + NODE_H / 2); }}
          onMouseUp={e => { e.stopPropagation(); onPortUp(node.id, 'input', 0); }}
          style={{ cursor: 'crosshair' }} />
      )}
      {/* Output ports */}
      {Array.from({ length: outputCount }, (_, i) => {
        const py = NODE_H / 2 + (i - (outputCount - 1) / 2) * PORT_GAP;
        const label = node.type === 'condition' ? (i === 0 ? 'T' : 'F') : node.type === 'branch' ? (['A','B','C'][i] || '') : '';
        return (
          <g key={i}
            onMouseDown={e => { e.stopPropagation(); onPortDown(node.id, 'output', i, x + NODE_W, y + py); }}
            onMouseUp={e => { e.stopPropagation(); onPortUp(node.id, 'output', i); }}
            style={{ cursor: 'crosshair' }}>
            <circle cx={NODE_W} cy={py} r={PORT_R} fill={selected ? cfg.color : BG.base} stroke={cfg.color} strokeWidth="1.5" />
            {label && <text x={NODE_W + 10} y={py + 3} fontSize="8" fill={cfg.color} fontWeight="700">{label}</text>}
          </g>
        );
      })}
      {/* Click area */}
      <rect width={NODE_W} height={NODE_H} rx="12" fill="transparent"
        onClick={e => { e.stopPropagation(); onSelect(node.id); }}
        onMouseDown={e => { if (e.button === 0) onDragStart(node.id, e); }} />
      {/* Hover action icons */}
      {hovered && !isDragging && (
        <g transform={`translate(${NODE_W - 42}, 2)`}>
          {stackCount <= 1 && (
            <g onClick={e => { e.stopPropagation(); onStack(node.id); }} style={{ cursor: 'pointer' }}>
              <circle cx="12" cy="12" r="10" fill={`${NEON.blue}30`} stroke={NEON.blue} strokeWidth="1" />
              <text x="12" y="13" fontSize="10" fill={NEON.blue} textAnchor="middle" dominantBaseline="central">⊞</text>
            </g>
          )}
          {stackCount > 1 && (
            <g onClick={e => { e.stopPropagation(); onDestack(node.id); }} style={{ cursor: 'pointer' }}>
              <circle cx="12" cy="12" r="10" fill={`${NEON.orange}30`} stroke={NEON.orange} strokeWidth="1" />
              <text x="12" y="13" fontSize="10" fill={NEON.orange} textAnchor="middle" dominantBaseline="central">⊟</text>
            </g>
          )}
        </g>
      )}
    </g>
  );
});

// ─── Stacked Shadow ────────────────────────────────────────────────
const StackShadow = memo(function StackShadow({ node, count }) {
  const cfg = NODE_TYPES[node.type] || NODE_TYPES.task;
  const x = node.x || 0, y = node.y || 0;
  return (
    <g>
      {Array.from({ length: Math.min(count - 1, 3) }, (_, i) => (
        <rect key={i}
          x={x + (i + 1) * 4} y={y + (i + 1) * 4}
          width={NODE_W} height={NODE_H} rx="12"
          fill={BG.card} stroke={`${cfg.color}15`} strokeWidth="1"
          opacity={0.3 - i * 0.08} />
      ))}
    </g>
  );
});

// ─── Bezier Edge with arrowhead + edge label ───────────────────────
const DAGEdge = memo(function DAGEdge({ from, to, color, active, running, label, onClick, selected }) {
  const dx = to.x - from.x;
  const cp1x = from.x + Math.max(dx * 0.4, 50);
  const cp2x = to.x - Math.max(dx * 0.4, 50);
  const d = `M${from.x},${from.y} C${cp1x},${from.y} ${cp2x},${to.y} ${to.x},${to.y}`;

  // Arrowhead at target
  const angle = Math.atan2(to.y - (to.y - 0 + (to.y - from.y) * 0.1), to.x - from.x);
  const arrowSize = 6;
  const ax = to.x - arrowSize * Math.cos(angle);
  const ay = to.y - arrowSize * Math.sin(angle);
  const a1x = ax - arrowSize * 0.5 * Math.cos(angle - Math.PI / 6);
  const a1y = ay - arrowSize * 0.5 * Math.sin(angle - Math.PI / 6);
  const a2x = ax - arrowSize * 0.5 * Math.cos(angle + Math.PI / 6);
  const a2y = ay - arrowSize * 0.5 * Math.sin(angle + Math.PI / 6);

  return (
    <g style={{ cursor: 'pointer' }} onClick={onClick}>
      <path d={d} fill="none" stroke={color} strokeWidth={selected ? 3 : 2} opacity={active ? 0.5 : selected ? 0.4 : 0.15} />
      {active && <path d={d} fill="none" stroke={color} strokeWidth="3" opacity="0.15" filter="url(#dag-glow)" />}
      {running && (
        <path d={d} fill="none" stroke={color} strokeWidth="2.5" opacity="0.6"
          strokeDasharray="6 8" strokeDashoffset="0">
          <animate attributeName="stroke-dashoffset" from="0" to="-28" dur="1s" repeatCount="indefinite" />
        </path>
      )}
      {/* Arrowhead */}
      <path d={`M${to.x},${to.y} L${a1x},${a1y} L${a2x},${a2y} Z`} fill={color} opacity={active ? 0.7 : 0.3} />
      {/* Edge label */}
      {label && (
        <g>
          <rect x={(from.x + to.x) / 2 - 16} y={(from.y + to.y) / 2 - 8} width="32" height="14" rx="4" fill={BG.base} opacity="0.8" />
          <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 + 1} fontSize="8" fill={color} textAnchor="middle" dominantBaseline="central">{label}</text>
        </g>
      )}
    </g>
  );
});

// ─── Add Node Modal ────────────────────────────────────────────────
function AddNodeModal({ onClose, onAdded, existingNodes }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('task');
  const [command, setCommand] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const maxX = existingNodes.reduce((mx, n) => Math.max(mx, (n.x || 0) + NODE_W + 40), 40);
      const y = 100 + Math.random() * 200;
      const stepId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `step-${Date.now()}`;
      await api('/api/dags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          nodes: [{ id: stepId, name: name.trim(), type, command, x: maxX, y }],
          edges: [],
        }),
      });
      onAdded(); onClose();
    } catch (err) {
      console.error(err);
      setError(err.message);
      setLoading(false); // stay open — let user see error and retry
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: `${BG.card}f8`, border: `1px solid ${NEON.purple}30` }} onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4" style={{ color: NEON.purple }}>Add DAG Node</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.purple}20`, outline: 'none' }} autoFocus />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Type</label>
            <div className="flex flex-wrap gap-2">
              {Object.entries(NODE_TYPES).map(([key, cfg]) => (
                <button key={key} type="button" onClick={() => setType(key)} className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg font-semibold transition-all"
                  style={{ background: type === key ? `${cfg.color}20` : 'rgba(0,0,0,0.3)', border: `1px solid ${type === key ? cfg.color : '#333'}`, color: type === key ? cfg.color : '#666' }}>
                  <span>{cfg.icon}</span> {cfg.label}
                </button>
              ))}
            </div>
          </div>
          {(type === 'task' || type === 'trigger' || type === 'transform' || type === 'webhook' || type === 'notify') && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">{type === 'transform' ? 'Expression' : type === 'webhook' ? 'Path' : type === 'notify' ? 'Message' : 'Command'}</label>
              <input value={command} onChange={e => setCommand(e.target.value)} placeholder={type === 'transform' ? 'e.g. $.data.map(x => x.id)' : type === 'webhook' ? '/hook/my-dag' : type === 'notify' ? 'DAG completed' : 'python run.py'} className="w-full px-3 py-2 rounded-lg text-sm text-white font-mono" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.purple}20`, outline: 'none' }} />
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: `${NEON.red}10`, border: `1px solid ${NEON.red}30` }}>
              <AlertTriangle size={12} style={{ color: NEON.red, flexShrink: 0 }} />
              <span className="text-xs" style={{ color: NEON.red }}>{error}</span>
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #333', color: '#888' }}>Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.purple}20`, border: `1px solid ${NEON.purple}40`, color: NEON.purple }}>{loading ? 'Adding...' : 'Add'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Mini-map ──────────────────────────────────────────────────────
const MINI_W = 140, MINI_H = 90, MINI_PAD = 6;
const DagMinimap = memo(function DagMinimap({ nodes, edges, dimensions, zoom, pan, onPan }) {
  const canvasRef = useRef(null);

  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const nx = n.x || 0, ny = n.y || 0;
      if (nx < minX) minX = nx; if (nx + NODE_W > maxX) maxX = nx + NODE_W;
      if (ny < minY) minY = ny; if (ny + NODE_H > maxY) maxY = ny + NODE_H;
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 500; }
    return { minX, minY, maxX, maxY };
  }, [nodes]);

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
    for (const e of edges) {
      const fn = nodes.find(n => n.id === e.from);
      const tn = nodes.find(n => n.id === e.to);
      if (!fn || !tn) continue;
      ctx.beginPath();
      ctx.moveTo(ox + ((fn.x || 0) + NODE_W - bounds.minX) * s, oy + ((fn.y || 0) + NODE_H/2 - bounds.minY) * s);
      ctx.lineTo(ox + ((tn.x || 0) - bounds.minX) * s, oy + ((tn.y || 0) + NODE_H/2 - bounds.minY) * s);
      ctx.strokeStyle = '#3333';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    for (const n of nodes) {
      const cfg = NODE_TYPES[n.type] || NODE_TYPES.task;
      const mx = ox + ((n.x || 0) + NODE_W/2 - bounds.minX) * s;
      const my = oy + ((n.y || 0) + NODE_H/2 - bounds.minY) * s;
      ctx.fillStyle = cfg.color + '60';
      ctx.beginPath();
      ctx.arc(mx, my, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    const vpW = (dimensions.width / zoom) * s;
    const vpH = (dimensions.height / zoom) * s;
    const vpX = ox + (-pan.x / zoom - bounds.minX) * s - vpW / 2;
    const vpY = oy + (-pan.y / zoom - bounds.minY) * s - vpH / 2;
    ctx.strokeStyle = `${NEON.cyan}cc`;
    ctx.lineWidth = 1;
    ctx.strokeRect(vpX, vpY, vpW, vpH);
    ctx.fillStyle = `${NEON.cyan}10`;
    ctx.fillRect(vpX, vpY, vpW, vpH);
    ctx.strokeStyle = `${NEON.magenta}40`;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, MINI_W - 1, MINI_H - 1);
  }, [nodes, edges, bounds, dimensions, zoom, pan]);

  useEffect(() => { draw(); });
  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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
    onPan({ x: -(gx - dimensions.width / (2 * zoom)) * zoom, y: -(gy - dimensions.height / (2 * zoom)) * zoom });
  }, [bounds, dimensions, zoom, onPan]);

  return (
    <canvas ref={canvasRef} onClick={handleClick}
      className="absolute bottom-12 right-3 rounded-lg cursor-pointer"
      style={{ width: MINI_W, height: MINI_H, border: `1px solid ${NEON.magenta}30`, background: BG.base, backdropFilter: 'blur(4px)' }}
      title="Click to pan" />
  );
});

// ─── Auto-layout (simple hierarchical) ─────────────────────────────
function autoLayout(nodes, edges) {
  if (nodes.length === 0) return nodes;
  // Topological sort
  const adj = {}; nodes.forEach(n => adj[n.id] = []);
  edges.forEach(e => { if (adj[e.from]) adj[e.from].push(e.to); });
  const inDeg = {}; nodes.forEach(n => inDeg[n.id] = 0);
  edges.forEach(e => { if (inDeg[e.to] != null) inDeg[e.to]++; });

  const levels = {};
  const queue = nodes.filter(n => inDeg[n.id] === 0).map(n => ({ id: n.id, level: 0 }));
  const visited = new Set();
  while (queue.length) {
    const { id, level } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    levels[id] = Math.max(levels[id] || 0, level);
    for (const next of (adj[id] || [])) {
      levels[next] = Math.max(levels[next] || 0, level + 1);
      queue.push({ id: next, level: level + 1 });
    }
  }
  // Position nodes by level
  const byLevel = {};
  nodes.forEach(n => {
    const lv = levels[n.id] || 0;
    if (!byLevel[lv]) byLevel[lv] = [];
    byLevel[lv].push(n);
  });
  const colW = NODE_W + 80;
  const rowH = NODE_H + 40;
  const result = nodes.map(n => {
    const lv = levels[n.id] || 0;
    const col = byLevel[lv];
    const idx = col.indexOf(n);
    return { ...n, x: 40 + lv * colW, y: 40 + idx * rowH + (lv % 2) * 20 };
  });
  return result;
}

// ─── Main DAG Editor ───────────────────────────────────────────────
export default function DAGEditor() {
  const svgRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 500 });
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [validation, setValidation] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [dragNodeId, setDragNodeId] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [connecting, setConnecting] = useState(null);
  const [tempLine, setTempLine] = useState(null);
  const [stacks, setStacks] = useState({});
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState({}); // { [dagId]: 'running' | 'completed' | 'failed' }
  const [showInspector, setShowInspector] = useState(false);

  const { lastEvent } = useWebSocket();

  // Subscribe to dag:status WS events for live run updates
  useEffect(() => {
    if (!lastEvent || lastEvent.type !== 'dag:status') return;
    const { id, status } = lastEvent.data;
    if (status === 'running') {
      setRunStatus(prev => ({ ...prev, [id]: 'running' }));
      setRunning(true);
    } else if (status === 'completed') {
      setRunStatus(prev => ({ ...prev, [id]: 'completed' }));
      setRunning(false);
      // Update node statuses from the broadcast
      setNodes(prev => prev.map(n => n.id === id ? { ...n, status: 'completed' } : n));
    } else if (status === 'failed') {
      setRunStatus(prev => ({ ...prev, [id]: 'failed' }));
      setRunning(false);
      setValidation({ valid: false, issues: [`DAG run failed: ${lastEvent.data.error || 'Unknown error'}`] });
    }
  }, [lastEvent]);

  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width: Math.max(400, width), height: Math.max(300, height) });
    });
    if (svgRef.current?.parentElement) obs.observe(svgRef.current.parentElement);
    return () => obs.disconnect();
  }, []);

  const load = useCallback(() => {
    api('/api/dags').then(data => {
      const dagList = Array.isArray(data) ? data : (data.dags || []);
      setNodes(dagList.map(n => {
        const step = (Array.isArray(n.nodes) && n.nodes[0]) || {};
        return {
          ...n,
          type: n.type ?? step.type,
          command: n.command ?? step.command,
          x: step.x ?? n.x ?? 80,
          y: step.y ?? n.y ?? 100,
        };
      }));
      const e = [];
      dagList.forEach(n => {
        if (Array.isArray(n.edges)) {
          n.edges.forEach(ed => {
            if (ed && typeof ed === 'object' && ed.target) e.push({ from: ed.source || n.id, to: ed.target });
            else e.push({ from: n.id, to: ed });
          });
        }
      });
      setEdges(e);
    }).catch(err => {
      console.error('Failed to load DAGs:', err);
      setValidation({ valid: false, issues: [`Failed to load DAGs: ${err.message}`] });
    });
  }, []);

  usePolling(load, 30000);

  const validateDAG = useCallback(() => {
    const issues = [];
    const names = new Set();
    for (const n of nodes) {
      if (names.has(n.name)) issues.push(`Duplicate: ${n.name}`);
      names.add(n.name);
      if (n.type === 'task' && !n.command) issues.push(`"${n.name}" has no command`);
    }
    const adj = {};
    nodes.forEach(n => { adj[n.id] = []; });
    edges.forEach(e => { if (adj[e.from]) adj[e.from].push(e.to); });
    const visited = new Set(), stack = new Set();
    function dfs(id) {
      if (stack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id); stack.add(id);
      for (const next of (adj[id] || [])) { if (dfs(next)) return true; }
      stack.delete(id); return false;
    }
    if (nodes.some(n => dfs(n.id))) issues.push('Cycle detected');
    setValidation(issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues });
    return issues.length === 0;
  }, [nodes, edges]);

  const saveDAG = useCallback(async () => {
    if (!validateDAG()) return;
    try {
      const adj = {};
      edges.forEach(e => { if (!adj[e.from]) adj[e.from] = []; adj[e.from].push(e.to); });
      for (const n of nodes) {
        const step = (Array.isArray(n.nodes) && n.nodes[0]) || {};
        await api(`/api/dags/${n.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodes: [{ id: step.id || n.id, name: n.name, type: n.type || 'task', command: n.command || '', x: n.x ?? 80, y: n.y ?? 100 }],
            edges: (adj[n.id] || []).map(to => ({ source: n.id, target: to })),
          }),
        });
      }
      setValidation({ valid: true, issues: ['Saved successfully!'] });
    } catch (err) {
      setValidation({ valid: false, issues: [`Save error: ${err.message}`] });
    }
  }, [nodes, edges, validateDAG]);

  const deleteNode = useCallback(async (id) => {
    try {
      await api(`/api/dags/${id}`, { method: 'DELETE' });
      setEdges(prev => prev.filter(e => e.from !== id && e.to !== id));
      setStacks(prev => {
        const next = {};
        for (const [gid, nids] of Object.entries(prev)) {
          const filtered = nids.filter(nid => nid !== id);
          if (filtered.length > 0) next[gid] = filtered;
        }
        return next;
      });
      load(); setSelectedId(null);
    } catch (err) {
      setValidation({ valid: false, issues: [`Delete error: ${err.message}`] });
    }
  }, [load]);

  const runDag = useCallback(async (id) => {
    setRunStatus(prev => ({ ...prev, [id]: 'running' }));
    setRunning(true);
    try {
      await api(`/api/dags/${id}/run`, { method: 'POST' });
      // WS event will update runStatus to 'completed' or 'failed' live
      // But also poll load() to refresh node statuses
      load();
    } catch (err) {
      setRunStatus(prev => ({ ...prev, [id]: 'failed' }));
      setRunning(false);
      setValidation({ valid: false, issues: [`Run error: ${err.message}`] });
    }
  }, [load]);

  const handleStack = useCallback((nodeId) => {
    if (selectedId && selectedId !== nodeId) {
      setStacks(prev => {
        const next = { ...prev };
        let targetGroup = null;
        for (const [gid, nids] of Object.entries(next)) {
          if (nids.includes(selectedId) || nids.includes(nodeId)) { targetGroup = gid; break; }
        }
        if (targetGroup) {
          const existing = next[targetGroup] || [];
          if (!existing.includes(nodeId)) next[targetGroup] = [...existing, nodeId];
          if (!existing.includes(selectedId)) next[targetGroup] = [...existing, selectedId];
        } else {
          const gid = `stack-${Date.now()}`;
          next[gid] = [selectedId, nodeId];
        }
        return next;
      });
    }
  }, [selectedId]);

  const handleDestack = useCallback((nodeId) => {
    setStacks(prev => {
      const next = {};
      for (const [gid, nids] of Object.entries(prev)) {
        if (nids.includes(nodeId)) {
          const filtered = nids.filter(nid => nid !== nodeId);
          if (filtered.length > 1) next[gid] = filtered;
        } else { next[gid] = nids; }
      }
      return next;
    });
  }, []);

  const renderOrder = useMemo(() => {
    const nodeToStack = {};
    for (const [gid, nids] of Object.entries(stacks)) {
      for (const nid of nids) nodeToStack[nid] = gid;
    }
    const stackedShown = new Set(), stackedHidden = new Set();
    for (const [gid, nids] of Object.entries(stacks)) {
      nids.forEach((nid, i) => { if (i === 0) stackedShown.add(nid); else stackedHidden.add(nid); });
    }
    const regular = nodes.filter(n => !stackedHidden.has(n.id));
    const sorted = [...regular].sort((a, b) => {
      if (a.id === dragNodeId) return 1;
      if (b.id === dragNodeId) return -1;
      return 0;
    });
    return { sorted, nodeToStack, stackedHidden };
  }, [nodes, stacks, dragNodeId]);

  const handleMouseDown = useCallback((e) => {
    if (e.target === svgRef.current || e.target.tagName === 'rect' || e.target.tagName === 'pattern' || e.target.tagName === 'circle') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }, [pan]);

  const handleMouseMove = useCallback((e) => {
    if (isPanning) { setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y }); }
    if (dragNodeId) {
      const mx = (e.clientX - svgRef.current.getBoundingClientRect().left - pan.x) / zoom;
      const my = (e.clientY - svgRef.current.getBoundingClientRect().top - pan.y) / zoom;
      setNodes(prev => prev.map(n => n.id === dragNodeId ? { ...n, x: mx - dragOffset.x, y: my - dragOffset.y } : n));
    }
    if (connecting) {
      const mx = (e.clientX - svgRef.current.getBoundingClientRect().left - pan.x) / zoom;
      const my = (e.clientY - svgRef.current.getBoundingClientRect().top - pan.y) / zoom;
      setTempLine({ x: mx, y: my });
    }
  }, [isPanning, panStart, dragNodeId, dragOffset, connecting, zoom, pan]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    setDragNodeId(null);
    if (connecting) { setConnecting(null); setTempLine(null); }
  }, [connecting]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    setZoom(z => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
  }, []);

  const onDragStart = useCallback((nodeId, e) => {
    if (connecting) return;
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = (e.clientX - rect.left - pan.x) / zoom;
    const my = (e.clientY - rect.top - pan.y) / zoom;
    setDragNodeId(nodeId);
    setDragOffset({ x: mx - node.x, y: my - node.y });
    setStacks(prev => {
      const next = {};
      for (const [gid, nids] of Object.entries(prev)) {
        if (nids.includes(nodeId)) {
          const filtered = nids.filter(nid => nid !== nodeId);
          if (filtered.length > 1) next[gid] = filtered;
        } else { next[gid] = nids; }
      }
      return next;
    });
  }, [nodes, zoom, pan, connecting]);

  const onPortDown = useCallback((nodeId, portType, portIndex, portX, portY) => {
    setConnecting({ fromId: nodeId, fromType: portType, fromIndex: portIndex, x: portX, y: portY });
  }, []);

  const onPortUp = useCallback((nodeId, portType, portIndex) => {
    if (!connecting) return;
    let fromId, toId;
    if (connecting.fromType === 'output' && portType === 'input') { fromId = connecting.fromId; toId = nodeId; }
    else if (connecting.fromType === 'input' && portType === 'output') { fromId = nodeId; toId = connecting.fromId; }
    if (fromId && toId && fromId !== toId) {
      setEdges(prev => {
        if (prev.some(e => e.from === fromId && e.to === toId)) return prev;
        return [...prev, { from: fromId, to: toId }];
      });
    }
    setConnecting(null);
    setTempLine(null);
  }, [connecting]);

  const deleteEdge = useCallback((from, to) => {
    setEdges(prev => prev.filter(e => !(e.from === from && e.to === to)));
    setSelectedEdge(null);
  }, []);

  const positionedEdges = useMemo(() => {
    return edges.map(e => {
      const fromNode = nodes.find(n => n.id === e.from);
      const toNode = nodes.find(n => n.id === e.to);
      if (!fromNode || !toNode) return null;
      const fromType = NODE_TYPES[fromNode.type] || NODE_TYPES.task;
      return {
        ...e,
        from: { x: (fromNode.x || 0) + NODE_W, y: (fromNode.y || 0) + NODE_H / 2 },
        to: { x: toNode.x || 0, y: (toNode.y || 0) + NODE_H / 2 },
        color: fromType.color,
      };
    }).filter(Boolean);
  }, [edges, nodes]);

  const selectedNode = nodes.find(n => n.id === selectedId);
  const selectedCfg = selectedNode ? (NODE_TYPES[selectedNode.type] || NODE_TYPES.task) : null;

  const getStackInfo = useCallback((nodeId) => {
    for (const [gid, nids] of Object.entries(stacks)) {
      if (nids.includes(nodeId)) {
        return { groupId: gid, count: nids.length, isTop: nids[0] === nodeId, index: nids.indexOf(nodeId) };
      }
    }
    return { groupId: null, count: 1, isTop: true, index: 0 };
  }, [stacks]);

  return (
    <div className="space-y-4">
      {showAdd && <AddNodeModal onClose={() => setShowAdd(false)} onAdded={load} existingNodes={nodes} />}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <GitBranch size={20} style={{ color: NEON.purple, filter: `drop-shadow(0 0 6px ${NEON.purple})` }} />
          <h2 className="text-xl font-bold" style={{ color: NEON.purple, textShadow: `0 0 15px ${NEON.purple}44` }}>DAG Editor</h2>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.purple}15`, color: NEON.purple, border: `1px solid ${NEON.purple}30` }}>{nodes.length} nodes · {edges.length} edges</span>
          {Object.keys(stacks).length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.blue}15`, color: NEON.blue, border: `1px solid ${NEON.blue}30` }}>
              <Layers size={10} className="inline mr-1" />{Object.keys(stacks).length} stacked
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setNodes(autoLayout(nodes, edges))} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: `${NEON.teal}15`, border: `1px solid ${NEON.teal}30`, color: NEON.teal }} title="Auto-arrange nodes"><Layout size={12} /> Auto Arrange</button>
          <button onClick={validateDAG} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#888' }}><AlertTriangle size={12} /> Validate</button>
          <button onClick={saveDAG} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: `${NEON.green}15`, border: `1px solid ${NEON.green}30`, color: NEON.green }}><Save size={12} /> Save</button>
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: `${NEON.purple}15`, border: `1px solid ${NEON.purple}30`, color: NEON.purple }}><Plus size={12} /> Add Node</button>
          <button onClick={load} className="p-1.5 rounded-lg text-gray-500 hover:text-purple-400 hover:bg-white/5 transition-colors"><RefreshCw size={14} /></button>
        </div>
      </div>

      {/* Validation */}
      {validation && (
        <div className="rounded-lg px-4 py-2.5 flex items-start gap-2" style={{ background: validation.valid ? `${NEON.green}08` : `${NEON.red}08`, border: `1px solid ${validation.valid ? NEON.green + '25' : NEON.red + '25'}` }}>
          {validation.valid ? <CheckCircle size={14} style={{ color: NEON.green }} /> : <AlertTriangle size={14} style={{ color: NEON.red }} />}
          <div className="text-xs" style={{ color: validation.valid ? NEON.green : NEON.red }}>
            {validation.issues.map((iss, i) => <div key={i}>{iss}</div>)}
          </div>
        </div>
      )}

      {/* SVG Canvas */}
      <div className="rounded-xl overflow-hidden relative" style={{ background: BG.base, border: '1px solid rgba(168,85,247,0.12)' }}>
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
          <button onClick={() => setZoom(z => Math.min(3, z + 0.2))} className="p-1 rounded text-gray-500 hover:text-cyan-400 hover:bg-white/5 transition-colors"><ZoomIn size={12} /></button>
          <button onClick={() => setZoom(z => Math.max(0.3, z - 0.2))} className="p-1 rounded text-gray-500 hover:text-cyan-400 hover:bg-white/5 transition-colors"><ZoomOut size={12} /></button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="p-1 rounded text-gray-500 hover:text-cyan-400 hover:bg-white/5 transition-colors"><Maximize2 size={12} /></button>
          <span className="text-[10px] text-gray-600 font-mono ml-1">{(zoom * 100).toFixed(0)}%</span>
        </div>

        <svg
          ref={svgRef}
          width={dimensions.width}
          height={dimensions.height}
          viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{ cursor: isPanning ? 'grabbing' : dragNodeId ? 'grabbing' : connecting ? 'crosshair' : 'grab' }}
        >
          {DEFS}
          <pattern id="dag-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="12" cy="12" r="0.6" fill="#ffffff06" />
          </pattern>
          <rect width="100%" height="100%" fill="url(#dag-grid)" />

          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {positionedEdges.map((e, i) => (
              <DAGEdge key={`${e.from.x}-${e.from.y}-${e.to.x}-${e.to.y}-${i}`}
                from={e.from} to={e.to} color={e.color}
                active={selectedEdge?.from === e.from && selectedEdge?.to === e.to}
                running={running}
                selected={selectedEdge?.from === e.from && selectedEdge?.to === e.to}
                onClick={() => setSelectedEdge({ from: e.from, to: e.to })}
              />
            ))}

            {selectedEdge && (
              <g style={{ cursor: 'pointer' }} onClick={() => deleteEdge(selectedEdge.from, selectedEdge.to)}>
                <rect x={(positionedEdges.find(e => e.from === selectedEdge.from && e.to === selectedEdge.to)?.from.x + positionedEdges.find(e => e.from === selectedEdge.from && e.to === selectedEdge.to)?.to.x) / 2 - 20} y={(positionedEdges.find(e => e.from === selectedEdge.from && e.to === selectedEdge.to)?.from.y + positionedEdges.find(e => e.from === selectedEdge.from && e.to === selectedEdge.to)?.to.y) / 2 - 20} width="40" height="18" rx="4" fill={`${NEON.red}20`} stroke={NEON.red} strokeWidth="1" />
                <text x={(positionedEdges.find(e => e.from === selectedEdge.from && e.to === selectedEdge.to)?.from.x + positionedEdges.find(e => e.from === selectedEdge.from && e.to === selectedEdge.to)?.to.x) / 2} y={(positionedEdges.find(e => e.from === selectedEdge.from && e.to === selectedEdge.to)?.from.y + positionedEdges.find(e => e.from === selectedEdge.from && e.to === selectedEdge.to)?.to.y) / 2 - 10} fontSize="9" fill={NEON.red} textAnchor="middle" fontWeight="700">DELETE</text>
              </g>
            )}

            {connecting && tempLine && (
              <line x1={connecting.x} y1={connecting.y} x2={tempLine.x} y2={tempLine.y}
                stroke={NEON.cyan} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />
            )}

            {renderOrder.sorted.map(n => {
              const info = getStackInfo(n.id);
              if (info.count > 1 && info.isTop) {
                return <StackShadow key={`shadow-${n.id}`} node={n} count={info.count} />;
              }
              return null;
            })}

            {renderOrder.sorted.map(n => {
              const info = getStackInfo(n.id);
              return (
                <DAGNode key={n.id} node={n} selected={selectedId === n.id} isDragging={dragNodeId === n.id}
                  isTopOfStack={info.isTop} stackCount={info.count}
                  onSelect={setSelectedId} onDragStart={onDragStart} onPortDown={onPortDown} onPortUp={onPortUp}
                  onStack={handleStack} onDestack={handleDestack}
                  running={n.status === 'running'} progress={n.progress}
                />
              );
            })}
          </g>
        </svg>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2 text-[10px] text-gray-600 max-w-md">
          {Object.entries(NODE_TYPES).map(([key, cfg]) => (
            <span key={key} className="flex items-center gap-1"><span>{cfg.icon}</span> {cfg.label}</span>
          ))}
        </div>

        {/* Mini-map */}
        <DagMinimap nodes={nodes} edges={edges} dimensions={dimensions} zoom={zoom} pan={pan} onPan={setPan} />

        {/* Hint */}
        <div className="absolute top-3 left-3 text-[10px] text-gray-700 bg-black/50 backdrop-blur-sm px-2 py-1 rounded">
          Drag nodes · Connect ports · Click edge to delete · Scroll to zoom · Auto Arrange for layout
        </div>
      </div>

      {/* Node detail side panel */}
      {selectedNode && selectedCfg && (
        <div className="rounded-xl p-4" style={{ background: `${BG.card}f5`, border: `1px solid ${selectedCfg.color}25` }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">{selectedCfg.icon}</span>
              <h3 className="text-sm font-bold" style={{ color: selectedCfg.color }}>{selectedNode.name}</h3>
              <span className="px-2 py-0.5 rounded text-[10px]" style={{ background: `${selectedCfg.color}15`, color: selectedCfg.color, border: `1px solid ${selectedCfg.color}30` }}>{selectedNode.type}</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Run button with inline status indicator */}
              <button
                onClick={() => runDag(selectedNode.id)}
                disabled={runStatus[selectedNode.id] === 'running'}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold transition-all"
                style={{
                  background: runStatus[selectedNode.id] === 'running' ? `${NEON.green}10` : runStatus[selectedNode.id] === 'completed' ? `${NEON.cyan}15` : runStatus[selectedNode.id] === 'failed' ? `${NEON.red}15` : `${NEON.green}15`,
                  border: `1px solid ${runStatus[selectedNode.id] === 'failed' ? NEON.red + '40' : NEON.green + '30'}`,
                  color: runStatus[selectedNode.id] === 'failed' ? NEON.red : NEON.green,
                  opacity: runStatus[selectedNode.id] === 'running' ? 0.6 : 1,
                }}
                title="Run this DAG"
              >
                {runStatus[selectedNode.id] === 'running' ? (
                  <><RefreshCw size={12} className="animate-spin" /> Running…</>
                ) : runStatus[selectedNode.id] === 'completed' ? (
                  <><CheckCircle size={12} /> Ran</>
                ) : runStatus[selectedNode.id] === 'failed' ? (
                  <><AlertTriangle size={12} /> Failed</>
                ) : (
                  <><Play size={12} /> Run</>
                )}
              </button>
              <button onClick={() => deleteNode(selectedNode.id)} className="p-1 rounded text-gray-600 hover:text-red-400 transition-colors"><Trash2 size={14} /></button>
              <button onClick={() => setSelectedId(null)} className="p-1 text-gray-600 hover:text-gray-400"><X size={14} /></button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <div><span className="text-gray-500 block">ID</span><span className="font-mono" style={{ color: NEON.cyan }}>{selectedNode.id?.slice(0, 12)}…</span></div>
            {(selectedNode.type === 'task' || selectedNode.type === 'trigger') && <div><span className="text-gray-500 block">Command</span><code style={{ color: NEON.green }}>{selectedNode.command || '—'}</code></div>}
            {selectedNode.type === 'transform' && <div><span className="text-gray-500 block">Expression</span><code style={{ color: NEON.purple }}>{selectedNode.command || '—'}</code></div>}
            {selectedNode.type === 'webhook' && <div><span className="text-gray-500 block">Path</span><code style={{ color: NEON.teal }}>{selectedNode.command || '—'}</code></div>}
            <div><span className="text-gray-500 block">Created</span><span style={{ color: '#888' }}>{selectedNode.created_at ? new Date(selectedNode.created_at).toLocaleString() : '—'}</span></div>
            <div><span className="text-gray-500 block">Incoming</span><span style={{ color: NEON.blue }}>{edges.filter(e => e.to === selectedNode.id).length}</span></div>
            <div><span className="text-gray-500 block">Outgoing</span><span style={{ color: NEON.blue }}>{edges.filter(e => e.from === selectedNode.id).length}</span></div>
          </div>
          <div className="mt-3 pt-3 text-xs" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            <span className="text-gray-500 block mb-1">Connections</span>
            <div className="flex flex-wrap gap-1.5">
              {edges.filter(e => e.from === selectedNode.id).map(e => {
                const target = nodes.find(n => n.id === e.to);
                return target ? <span key={e.to} className="px-2 py-0.5 rounded" style={{ background: `${NEON.blue}10`, color: NEON.blue, border: `1px solid ${NEON.blue}20` }}>→ {target.name}</span> : null;
              })}
              {edges.filter(e => e.to === selectedNode.id).map(e => {
                const source = nodes.find(n => n.id === e.from);
                return source ? <span key={e.from} className="px-2 py-0.5 rounded" style={{ background: `${NEON.green}10`, color: NEON.green, border: `1px solid ${NEON.green}20` }}>← {source.name}</span> : null;
              })}
              {edges.filter(e => e.from === selectedNode.id || e.to === selectedNode.id).length === 0 && <span className="text-gray-600">No connections</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
