import React, { useEffect, useState, useRef, useCallback, useMemo, memo } from 'react';
import { api } from './AuthContext';
import { usePolling } from './usePolling';
import { GitBranch, Save, Plus, Trash2, AlertTriangle, CheckCircle, Play, Square, ZoomIn, ZoomOut, Maximize2, RefreshCw, X, Copy, Power, PowerOff, Layers, Split, ChevronDown } from 'lucide-react';

const NEON = { cyan:'#00f0ff', magenta:'#ff00ff', blue:'#3b82f6', purple:'#a855f7', green:'#22c55e', yellow:'#eab308', red:'#ef4444', pink:'#ec4899', orange:'#f97316', teal:'#14b8a6' };
const BG = { base:'#050510', card:'#0a0a1e', surface:'#0f0f23' };

const NODE_TYPES = {
  trigger: { color: NEON.green, icon: '⚡', label: 'Trigger' },
  task:    { color: NEON.cyan, icon: '▶', label: 'Task' },
  condition:{ color: NEON.yellow, icon: '◆', label: 'Condition' },
  parallel: { color: NEON.blue, icon: '⫸', label: 'Parallel' },
  output:  { color: NEON.pink, icon: '◉', label: 'Output' },
  delay:   { color: NEON.orange, icon: '⏱', label: 'Delay' },
};

const NODE_W = 200, NODE_H = 72, PORT_R = 6;
const PORT_GAP = 24;
const STACK_OFFSET = 28; // pixel offset for stacked nodes

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
const DAGNode = memo(function DAGNode({ node, selected, isDragging, isTopOfStack, stackCount, onSelect, onDragStart, onPortDown, onStack, onDestack }) {
  const cfg = NODE_TYPES[node.type] || NODE_TYPES.task;
  const x = node.x || 0, y = node.y || 0;
  const hasInput = node.type !== 'trigger';
  const outputCount = node.type === 'condition' ? 2 : 1;
  const [hovered, setHovered] = useState(false);

  return (
    <g transform={`translate(${x},${y})`}
      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Shadow rect */}
      <rect width={NODE_W} height={NODE_H} rx="12"
        fill={BG.card}
        stroke={selected ? cfg.color : `${cfg.color}40`}
        strokeWidth={selected ? 2 : 1}
        filter={isDragging ? 'url(#dag-drag-shadow)' : 'url(#dag-node-shadow)'}
        opacity={isDragging ? 1 : isTopOfStack ? 1 : 0.92}
      />
      {/* Top accent bar */}
      <rect width={NODE_W} height="3" rx="1.5" fill={cfg.color} opacity="0.6" y="0" clipPath="inset(0 0 0 0 round 12px 12px 0 0)" />
      {/* Icon + name */}
      <text x="14" y="30" fontSize="14" dominantBaseline="central">{cfg.icon}</text>
      <text x="36" y="24" fontSize="12" fontWeight="600" fill="#eee" fontFamily="sans-serif">{node.name}</text>
      <text x="36" y="42" fontSize="9" fill="#666" fontFamily="sans-serif">{cfg.label}{node.command ? ` · ${node.command.slice(0, 20)}` : ''}</text>
      {/* Status LED */}
      {node.status && (
        <circle cx={NODE_W - 14} cy="14" r="4" fill={node.status === 'running' ? NEON.green : node.status === 'completed' ? NEON.cyan : node.status === 'failed' ? NEON.red : '#444'}>
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
        <circle cx="0" cy={NODE_H / 2} r={PORT_R} fill={BG.base} stroke="#555" strokeWidth="1.5"
          onMouseDown={e => { e.stopPropagation(); onPortDown(node.id, 'input', 0, x, y + NODE_H / 2); }}
          style={{ cursor: 'crosshair' }} />
      )}
      {/* Output ports */}
      {Array.from({ length: outputCount }, (_, i) => {
        const py = NODE_H / 2 + (i - (outputCount - 1) / 2) * PORT_GAP;
        const label = node.type === 'condition' ? (i === 0 ? 'T' : 'F') : '';
        return (
          <g key={i} onMouseDown={e => { e.stopPropagation(); onPortDown(node.id, 'output', i, x + NODE_W, y + py); }} style={{ cursor: 'crosshair' }}>
            <circle cx={NODE_W} cy={py} r={PORT_R} fill={BG.base} stroke={cfg.color} strokeWidth="1.5" />
            {label && <text x={NODE_W + 10} y={py + 3} fontSize="8" fill={cfg.color} fontWeight="700">{label}</text>}
          </g>
        );
      })}
      {/* Click area for selection / drag */}
      <rect width={NODE_W} height={NODE_H} rx="12" fill="transparent"
        onClick={e => { e.stopPropagation(); onSelect(node.id); }}
        onMouseDown={e => { if (e.button === 0) onDragStart(node.id, e); }} />

      {/* Hover action icons — stack/destack */}
      {hovered && !isDragging && (
        <g transform={`translate(${NODE_W - 42}, 2)`}>
          {/* Stack icon (Layers) — shown when not in a stack */}
          {stackCount <= 1 && (
            <g onClick={e => { e.stopPropagation(); onStack(node.id); }} style={{ cursor: 'pointer' }}>
              <circle cx="12" cy="12" r="10" fill={`${NEON.blue}30`} stroke={NEON.blue} strokeWidth="1" />
              <text x="12" y="13" fontSize="10" fill={NEON.blue} textAnchor="middle" dominantBaseline="central">⊞</text>
            </g>
          )}
          {/* Destack icon (Split) — shown when in a stack */}
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

// ─── Stacked nodes visual (collapsed pile behind top node) ─────────
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
          opacity={0.3 - i * 0.08}
        />
      ))}
    </g>
  );
});

// ─── Bezier Edge ───────────────────────────────────────────────────
const DAGEdge = memo(function DAGEdge({ from, to, color, active, running }) {
  const dx = to.x - from.x;
  const cp1x = from.x + Math.max(dx * 0.4, 50);
  const cp2x = to.x - Math.max(dx * 0.4, 50);
  const d = `M${from.x},${from.y} C${cp1x},${from.y} ${cp2x},${to.y} ${to.x},${to.y}`;

  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth="2" opacity={active ? 0.5 : 0.15} />
      {active && <path d={d} fill="none" stroke={color} strokeWidth="3" opacity="0.15" filter="url(#dag-glow)" />}
      {running && (
        <path d={d} fill="none" stroke={color} strokeWidth="2.5" opacity="0.6"
          strokeDasharray="6 8" strokeDashoffset="0">
          <animate attributeName="stroke-dashoffset" from="0" to="-28" dur="1s" repeatCount="indefinite" />
        </path>
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);
    try {
      const maxX = existingNodes.reduce((mx, n) => Math.max(mx, (n.x || 0) + NODE_W + 40), 40);
      await api('/api/dags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), type, command, edges: [], x: maxX, y: 100 + Math.random() * 200 }),
      });
      onAdded(); onClose();
    } catch (err) { console.error(err); }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6" style={{ background: `${BG.card}f8`, border: `1px solid ${NEON.purple}30` }} onClick={e => e.stopPropagation()}>
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
          {(type === 'task' || type === 'trigger') && (
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Command</label>
              <input value={command} onChange={e => setCommand(e.target.value)} placeholder="e.g. python run.py" className="w-full px-3 py-2 rounded-lg text-sm text-white font-mono" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.purple}20`, outline: 'none' }} />
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

// ─── Main DAG Editor ───────────────────────────────────────────────
export default function DAGEditor() {
  const svgRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 500 });
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [validation, setValidation] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [dragNodeId, setDragNodeId] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [connecting, setConnecting] = useState(null);
  const [tempLine, setTempLine] = useState(null);
  const [stacks, setStacks] = useState({}); // { stackGroupId: [nodeId, nodeId, ...] }

  // Debounced resize
  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width: Math.max(400, width), height: Math.max(300, height) });
    });
    if (svgRef.current?.parentElement) obs.observe(svgRef.current.parentElement);
    return () => obs.disconnect();
  }, []);

  // Load DAG data
  const load = useCallback(() => {
    api('/api/dags').then(data => {
      const dagList = Array.isArray(data) ? data : (data.dags || []);
      setNodes(dagList.map(n => ({ ...n, x: n.x ?? 80, y: n.y ?? 100 })));
      const e = [];
      dagList.forEach(n => {
        if (n.edges && Array.isArray(n.edges)) {
          n.edges.forEach(targetId => { e.push({ from: n.id, to: targetId }); });
        }
      });
      setEdges(e);
    }).catch(() => {});
  }, []);

  usePolling(load, 30000);

  // Validate DAG
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

  // Save DAG
  const saveDAG = useCallback(async () => {
    if (!validateDAG()) return;
    try {
      const adj = {};
      edges.forEach(e => { if (!adj[e.from]) adj[e.from] = []; adj[e.from].push(e.to); });
      for (const n of nodes) {
        await api(`/api/dags/${n.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ edges: adj[n.id] || [], x: n.x, y: n.y }),
        });
      }
      setValidation({ valid: true, issues: ['Saved successfully!'] });
    } catch (err) {
      setValidation({ valid: false, issues: [`Save error: ${err.message}`] });
    }
  }, [nodes, edges, validateDAG]);

  const deleteNode = useCallback(async (id) => {
    await api(`/api/dags/${id}`, { method: 'DELETE' });
    setEdges(prev => prev.filter(e => e.from !== id && e.to !== id));
    // Remove from stacks
    setStacks(prev => {
      const next = {};
      for (const [gid, nids] of Object.entries(prev)) {
        const filtered = nids.filter(nid => nid !== id);
        if (filtered.length > 0) next[gid] = filtered;
      }
      return next;
    });
    load(); setSelectedId(null);
  }, [load]);

  // ─── Stack / Destack ──────────────────────────────────────────────
  const handleStack = useCallback((nodeId) => {
    // If a node is selected, stack this node with the selected node
    if (selectedId && selectedId !== nodeId) {
      setStacks(prev => {
        const next = { ...prev };
        // Find if either node is already in a stack
        let targetGroup = null;
        for (const [gid, nids] of Object.entries(next)) {
          if (nids.includes(selectedId) || nids.includes(nodeId)) {
            targetGroup = gid; break;
          }
        }
        if (targetGroup) {
          // Merge into existing stack
          const existing = next[targetGroup] || [];
          if (!existing.includes(nodeId)) next[targetGroup] = [...existing, nodeId];
          if (!existing.includes(selectedId)) next[targetGroup] = [...existing, selectedId];
        } else {
          // Create new stack
          const gid = `stack-${Date.now()}`;
          next[gid] = [selectedId, nodeId];
        }
        return next;
      });
    } else {
      // No selected node — just flag this node as stackable (UI hint)
    }
  }, [selectedId]);

  const handleDestack = useCallback((nodeId) => {
    setStacks(prev => {
      const next = {};
      for (const [gid, nids] of Object.entries(prev)) {
        if (nids.includes(nodeId)) {
          // Remove this node from the stack
          const filtered = nids.filter(nid => nid !== nodeId);
          if (filtered.length > 1) next[gid] = filtered;
          // If only 1 left, dissolve the stack
        } else {
          next[gid] = nids;
        }
      }
      return next;
    });
  }, []);

  // ─── Compute render order (z-index: dragged node on top, stacked nodes grouped) ──
  const renderOrder = useMemo(() => {
    // Build reverse map: nodeId → stackGroupId
    const nodeToStack = {};
    for (const [gid, nids] of Object.entries(stacks)) {
      for (const nid of nids) nodeToStack[nid] = gid;
    }

    // Separate nodes into: non-stacked, stacked (only render top of stack)
    const stackedShown = new Set(); // nodeIds that are top-of-stack
    const stackedHidden = new Set(); // nodeIds hidden behind stack top
    const stackGroups = {}; // groupId → ordered nodeIds

    for (const [gid, nids] of Object.entries(stacks)) {
      stackGroups[gid] = nids;
      nids.forEach((nid, i) => {
        if (i === 0) stackedShown.add(nid);
        else stackedHidden.add(nid);
      });
    }

    // Build render list — dragged node goes last (on top)
    const regular = nodes.filter(n => !stackedHidden.has(n.id));
    // Sort: dragged node to end
    const sorted = [...regular].sort((a, b) => {
      if (a.id === dragNodeId) return 1;
      if (b.id === dragNodeId) return -1;
      return 0;
    });

    return { sorted, stackGroups, nodeToStack, stackedHidden };
  }, [nodes, stacks, dragNodeId]);

  // ─── Canvas interaction handlers ─────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.target === svgRef.current || e.target.tagName === 'rect' || e.target.tagName === 'pattern' || e.target.tagName === 'circle') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }, [pan]);

  const handleMouseMove = useCallback((e) => {
    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    }
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
    if (connecting) {
      setConnecting(null);
      setTempLine(null);
    }
  }, [connecting]);

  const handleWheel = useCallback((e) => {
    e.preventDefault();
    setZoom(z => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
  }, []);

  // Node drag start — brings node to front
  const onDragStart = useCallback((nodeId, e) => {
    if (connecting) return;
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = (e.clientX - rect.left - pan.x) / zoom;
    const my = (e.clientY - rect.top - pan.y) / zoom;
    setDragNodeId(nodeId);
    setDragOffset({ x: mx - node.x, y: my - node.y });
    // If this node is in a stack, destack it first
    setStacks(prev => {
      const next = {};
      for (const [gid, nids] of Object.entries(prev)) {
        if (nids.includes(nodeId)) {
          // Pull this node out of stack when dragged
          const filtered = nids.filter(nid => nid !== nodeId);
          if (filtered.length > 1) next[gid] = filtered;
          // dissolve stack if < 2 remain
        } else {
          next[gid] = nids;
        }
      }
      return next;
    });
  }, [nodes, zoom, pan, connecting]);

  // Port connection start
  const onPortDown = useCallback((nodeId, portType, portIndex, portX, portY) => {
    setConnecting({ fromId: nodeId, fromType: portType, fromIndex: portIndex, x: portX, y: portY });
  }, []);

  // Port connection end
  const handlePortUp = useCallback((nodeId, portType, portIndex) => {
    if (!connecting) return;
    let fromId, toId;
    if (connecting.fromType === 'output' && portType === 'input') {
      fromId = connecting.fromId; toId = nodeId;
    } else if (connecting.fromType === 'input' && portType === 'output') {
      fromId = nodeId; toId = connecting.fromId;
    }
    if (fromId && toId && fromId !== toId) {
      setEdges(prev => {
        if (prev.some(e => e.from === fromId && e.to === toId)) return prev;
        return [...prev, { from: fromId, to: toId }];
      });
    }
    setConnecting(null);
    setTempLine(null);
  }, [connecting]);

  // Compute edge positions from nodes
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

  // Get stack info for a node
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
        {/* Zoom controls */}
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
          {/* Dot grid background */}
          <pattern id="dag-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="12" cy="12" r="0.6" fill="#ffffff06" />
          </pattern>
          <rect width="100%" height="100%" fill="url(#dag-grid)" />

          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {/* Edges (render behind nodes) */}
            {positionedEdges.map((e, i) => (
              <DAGEdge key={`${e.from.x}-${e.from.y}-${e.to.x}-${e.to.y}-${i}`} from={e.from} to={e.to} color={e.color} active running={false} />
            ))}

            {/* Temp connection line */}
            {connecting && tempLine && (
              <line x1={connecting.x} y1={connecting.y} x2={tempLine.x} y2={tempLine.y}
                stroke={NEON.cyan} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />
            )}

            {/* Stack shadows (render behind stacked nodes) */}
            {renderOrder.sorted.map(n => {
              const info = getStackInfo(n.id);
              if (info.count > 1 && info.isTop) {
                return <StackShadow key={`shadow-${n.id}`} node={n} count={info.count} />;
              }
              return null;
            })}

            {/* Nodes — rendered in z-order (dragged node last = on top) */}
            {renderOrder.sorted.map(n => {
              const info = getStackInfo(n.id);
              return (
                <DAGNode
                  key={n.id}
                  node={n}
                  selected={selectedId === n.id}
                  isDragging={dragNodeId === n.id}
                  isTopOfStack={info.isTop}
                  stackCount={info.count}
                  onSelect={setSelectedId}
                  onDragStart={onDragStart}
                  onPortDown={onPortDown}
                  onStack={handleStack}
                  onDestack={handleDestack}
                />
              );
            })}
          </g>
        </svg>

        {/* Legend */}
        <div className="absolute bottom-3 left-3 flex items-center gap-3 text-[10px] text-gray-600">
          {Object.entries(NODE_TYPES).map(([key, cfg]) => (
            <span key={key} className="flex items-center gap-1"><span>{cfg.icon}</span> {cfg.label}</span>
          ))}
          <span className="flex items-center gap-1">⊞ Stack</span>
          <span className="flex items-center gap-1">⊟ Destack</span>
        </div>

        {/* Instructions */}
        <div className="absolute bottom-3 right-14 text-[10px] text-gray-700">Drag nodes · Connect ports · Scroll to zoom · ⊞ to stack into workflow</div>
      </div>

      {/* Node detail panel */}
      {selectedNode && selectedCfg && (
        <div className="rounded-xl p-4" style={{ background: `${BG.card}f5`, border: `1px solid ${selectedCfg.color}25` }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">{selectedCfg.icon}</span>
              <h3 className="text-sm font-bold" style={{ color: selectedCfg.color }}>{selectedNode.name}</h3>
              <span className="px-2 py-0.5 rounded text-[10px]" style={{ background: `${selectedCfg.color}15`, color: selectedCfg.color, border: `1px solid ${selectedCfg.color}30` }}>{selectedNode.type}</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => deleteNode(selectedNode.id)} className="p-1 rounded text-gray-600 hover:text-red-400 transition-colors"><Trash2 size={14} /></button>
              <button onClick={() => setSelectedId(null)} className="p-1 text-gray-600 hover:text-gray-400"><X size={14} /></button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div><span className="text-gray-500 block">ID</span><span className="font-mono" style={{ color: NEON.cyan }}>{selectedNode.id?.slice(0, 12)}…</span></div>
            {(selectedNode.type === 'task' || selectedNode.type === 'trigger') && <div><span className="text-gray-500 block">Command</span><code style={{ color: NEON.green }}>{selectedNode.command || '—'}</code></div>}
            <div><span className="text-gray-500 block">Created</span><span style={{ color: '#888' }}>{selectedNode.created_at ? new Date(selectedNode.created_at).toLocaleString() : '—'}</span></div>
            <div><span className="text-gray-500 block">Incoming</span><span style={{ color: NEON.blue }}>{edges.filter(e => e.to === selectedNode.id).length}</span></div>
            <div><span className="text-gray-500 block">Outgoing</span><span style={{ color: NEON.blue }}>{edges.filter(e => e.from === selectedNode.id).length}</span></div>
          </div>
          {/* Connected nodes */}
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
