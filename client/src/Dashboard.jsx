import React, { useEffect, useState, useRef, useMemo, useCallback, memo } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { usePolling } from './usePolling';
import { useWsResource } from './useWsResource';
import { useWebSocket } from './useWebSocket';
import { Activity, Cpu, HardDrive, Users, ListTodo, GitBranch, Radio, Clock, Bot, Play, AlertTriangle, Trash2, Plus, Server, Zap, TrendingUp, DollarSign, BarChart3, Shield, Wifi, WifiOff, Timer, Hash, Sparkles, Plug, ShieldAlert, X } from 'lucide-react';
import { NEON, BG, FONTS, GLOW } from './theme';

// ─── Event icons ────────────────────────────────────────────────────
const eventIcons = {
 'task:created': <Plus size={12} style={{ color: NEON.green }} />,
 'task:status': <Play size={12} style={{ color: NEON.yellow }} />,
 'task:deleted': <Trash2 size={12} style={{ color: NEON.red }} />,
 'task:assigned': <Users size={12} style={{ color: NEON.blue }} />,
 'task:log': <Activity size={12} style={{ color: '#666' }} />,
 'agent:created': <Bot size={12} style={{ color: NEON.blue }} />,
 'agent:heartbeat': <Activity size={12} style={{ color: NEON.green }} />,
 'agent:status': <AlertTriangle size={12} style={{ color: NEON.yellow }} />,
 'agent:deleted': <Trash2 size={12} style={{ color: NEON.red }} />,
 'dag:created': <GitBranch size={12} style={{ color: NEON.purple }} />,
 'dag:status': <Activity size={12} style={{ color: NEON.yellow }} />,
 'dag:deleted': <Trash2 size={12} style={{ color: NEON.red }} />,
 'schedule:created': <Clock size={12} style={{ color: NEON.cyan }} />,
 'schedule:fired': <Play size={12} style={{ color: NEON.green }} />,
 'schedule:deleted': <Trash2 size={12} style={{ color: NEON.red }} />,
 'mcp:registered': <Server size={12} style={{ color: NEON.purple }} />,
 'group:created': <Users size={12} style={{ color: NEON.teal }} />,
 'group:broadcast': <Activity size={12} style={{ color: NEON.teal }} />,
 'connected': <Radio size={12} style={{ color: NEON.green }} />,
 'sentinel:alert': <ShieldAlert size={12} style={{ color: NEON.red }} />,
};

function formatEvent(msg) {
 const p = msg.payload || {};
 const typeMap = {
  'task:created': `Task "${p.name || p.id?.slice(0,8)}" created`,
  'task:status': `Task ${p.id?.slice(0,8)} → ${p.status}`,
  'task:deleted': `Task ${p.id?.slice(0,8)} deleted`,
  'task:assigned': `Task ${p.taskId?.slice(0,8)} assigned to agent ${p.agentId?.slice(0,8)}`,
  'task:log': `Log: ${p.line?.slice(0,60)}`,
  'agent:created': `Agent "${p.name || p.id?.slice(0,8)}" registered`,
  'agent:heartbeat': `Agent "${p.name || p.id?.slice(0,8)}" heartbeat`,
  'agent:status': `Agent "${p.name || p.id?.slice(0,8)}" → ${p.status}`,
  'agent:deleted': `Agent ${p.id?.slice(0,8)} deleted`,
  'dag:created': `DAG "${p.name || p.id?.slice(0,8)}" created`,
  'dag:status': `DAG ${p.id?.slice(0,8)} → ${p.status}`,
  'dag:deleted': `DAG ${p.id?.slice(0,8)} deleted`,
  'schedule:created': `Schedule "${p.name || p.id?.slice(0,8)}" created`,
  'schedule:fired': `Schedule "${p.name}" fired task ${p.taskId?.slice(0,8)}`,
  'schedule:deleted': `Schedule ${p.id?.slice(0,8)} deleted`,
  'mcp:registered': `MCP server "${p.name}" registered`,
  'group:created': `Group "${p.name || p.id?.slice(0,8)}" created`,
  'group:broadcast': `Group broadcast: ${p.taskIds?.length || 0} tasks`,
  'connected': 'WebSocket connected',
  'sentinel:alert': `SENTINEL ${p.severity?.toUpperCase()}: ${p.message}`,
 };
 return typeMap[msg.type] || msg.type;
}

// ─── Mini sparkline component ───────────────────────────────────────
// Reusable inline-SVG line chart with a subtle gradient fill under the line.
// Props: data (number[]), color, height, width, id (unique gradient id).
let __sparkId = 0;
const Sparkline = memo(function Sparkline({ data, color = NEON.green, height = 32, width = 120, id }) {
 // Unique gradient id so multiple sparklines on the same page never collide.
 const gid = useMemo(() => id || `spark-${color.replace('#','')}-${__sparkId++}`, [id, color]);
 if (!data || data.length < 2) {
  // Placeholder baseline so the card doesn't jump height when history is empty.
  return <svg width={width} height={height} className="overflow-visible opacity-20">
   <line x1="0" y1={height - 2} x2={width} y2={height - 2} stroke={color} strokeWidth="1" strokeDasharray="2 4" />
  </svg>;
 }
 const max = Math.max(...data, 1);
 const min = Math.min(...data, 0);
 const range = max - min || 1;
 const pts = data.map((v, i) => {
  const x = (i / (data.length - 1)) * width;
  const y = height - ((v - min) / range) * (height - 4) - 2;
  return `${x.toFixed(2)},${y.toFixed(2)}`;
 });
 const linePath = `M ${pts.join(' L ')}`;
 const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;
 return (
  <svg width={width} height={height} className="overflow-visible">
   <defs>
    <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
     <stop offset="0%" stopColor={color} stopOpacity="0.35" />
     <stop offset="100%" stopColor={color} stopOpacity="0" />
    </linearGradient>
   </defs>
   <path
    d={areaPath}
    fill={`url(#${gid})`}
   />
   <path
    d={linePath}
    fill="none"
    stroke={color}
    strokeWidth="1.5"
    strokeLinejoin="round"
    strokeLinecap="round"
    style={{ filter: `drop-shadow(0 0 3px ${color})` }}
   />
   {/* Head dot — last sample */}
   <circle
    cx={width}
    cy={height - ((data[data.length - 1] - min) / range) * (height - 4) - 2}
    r="1.6"
    fill={color}
    style={{ filter: `drop-shadow(0 0 4px ${color})` }}
   />
  </svg>
 );
});

// ─── Heatmap (inline SVG, green→yellow→red, 2D grid) ───────────────
// Generic reusable heatmap. Props:
//   values: number[][] — values[row][col], row=day, col=hour (0=anchored)
//   rows, cols, cell, gap, title, showAxisLabels
// Color stops: 0=green, 0.5=yellow, 1=red. Cells fade in on dark bg.
const Heatmap = memo(function Heatmap({
 values, rows = 7, cols = 24, cell = 14, gap = 2,
 showAxisLabels = true,
}) {
 const id = useMemo(() => `heat-${Math.random().toString(36).slice(2, 8)}`, []);
 // Find max for normalization; bail gracefully with empty grid.
 const flat = values ? values.flat() : [];
 const max = flat.length ? Math.max(...flat, 1) : 1;
 const W = cols * (cell + gap) + gap;
 const H = rows * (cell + gap) + gap + (showAxisLabels ? 10 : 0);

 // Interpolate green→yellow→red via HSL ballistics.
 const colorFor = (t) => {
  // t in [0,1]; 0=green(140°), ~0.55=yellow(55°), 1=red(0°)
  const hue = Math.max(0, 140 - t * 140);
  const light = 50 + (1 - t) * 5; // green a touch brighter
  return `hsl(${hue.toFixed(0)} 100% ${light}%)`;
 };

 return (
  <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
   <defs>
    {/* subtle radial wash for empty cells so the grid reads on #050510 */}
    <radialGradient id={`${id}-bg`} cx="50%" cy="50%" r="70%">
     <stop offset="0%" stopColor={NEON.green} stopOpacity="0.05" />
     <stop offset="100%" stopColor={NEON.green} stopOpacity="0.01" />
    </radialGradient>
   </defs>
   {Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
     const v = values?.[r]?.[c] ?? 0;
     const t = max > 0 ? v / max : 0;
     const x = gap + c * (cell + gap);
     const y = gap + r * (cell + gap);
     const fill = v === 0 ? `url(#${id}-bg)` : colorFor(t);
     const glow = t > 0.55 ? `drop-shadow(0 0 3px ${colorFor(t)})` : 'none';
     const opacity = v === 0 ? 0.35 : 0.85 + t * 0.15;
     return (
      <rect
       key={`${r}-${c}`}
       x={x}
       y={y}
       width={cell}
       height={cell}
        // Chamfered corners via clip-path (cyberpunk HUD aesthetic)
       rx="1"
       fill={fill}
       opacity={opacity}
       style={{ filter: glow }}
      >
       <title>{`day ${rows - 1 - r}, hour ${c}: ${v} events`}</title>
      </rect>
     );
    })
   )}
   {/* Hour axis labels (sparse) */}
   {showAxisLabels && [0, 6, 12, 18, 23].map(h => (
    <text
     key={`ax-${h}`}
     x={gap + h * (cell + gap) + cell / 2}
     y={H - 1}
     fontSize="7"
     fill="#444"
     textAnchor="middle"
     fontFamily="monospace"
    >{h}</text>
   ))}
  </svg>
 );
});

// ─── Activity Heatmap (last 7 days × 24 hours) ──────────────────────
// Builds a 7×24 2D array from WS events; falls back to seeded dummy data
// so the visualization works visually even without a time-series endpoint.
const DAYS_LABELS = ['6d', '5d', '4d', '3d', '2d', '1d', 'now'];

// Deterministic dummy data for visual fallback (not random per render).
const DUMMY_HEATMAP = (() => {
 const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
 let seed = 7;
 const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
 for (let d = 0; d < 7; d++) {
  for (let h = 0; h < 24; h++) {
   // More activity in working hours; taper toward older days.
   const dayWeight = (d + 1) / 7;
   const hourWeight = h >= 8 && h <= 22 ? 1 : 0.15;
   grid[d][h] = Math.floor(rng() * 6 * dayWeight * hourWeight);
  }
 }
 return grid;
})();

const ActivityHeatmap = memo(function ActivityHeatmap({ events }) {
 // Aggregate live WS events into a 7×24 day×hour grid.
 const cells = useMemo(() => {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const now = Date.now();
  events.forEach(ev => {
   if (!ev || !ev.ts) return;
   const agoHours = (now - ev.ts) / 3600000;
   if (agoHours < 0 || agoHours > 7 * 24) return;
   const dayIdx = Math.min(6, Math.floor(agoHours / 24));
   // row 0 = oldest (6d ago); row 6 = now — invert so latest sits at bottom.
   const row = 6 - dayIdx;
   const hourIdx = new Date(ev.ts).getHours();
   if (row >= 0 && row < 7 && hourIdx >= 0 && hourIdx < 24) grid[row][hourIdx]++;
  });
  return grid;
 }, [events]);

 // Use live data once we have real events; otherwise show dummy so the
 // visualization is meaningful even before traffic arrives.
 const hasReal = events.length > 0;
 const values = hasReal ? cells : DUMMY_HEATMAP;

 return (
  <div className="neon-card rounded-none p-4 hud-brackets">
   <div className="flex items-center gap-2 mb-2">
    <BarChart3 size={14} style={{ color: NEON.green, filter: `drop-shadow(0 0 3px ${NEON.green})` }} />
    <span className="text-xs font-bold tracking-wider uppercase font-hud" style={{ color: '#aaa' }}>Activity Heatmap</span>
    {!hasReal && (
     <span className="text-[9px] px-1.5 py-0.5 font-code ml-auto"
      style={{ background: `${NEON.cyan}08`, color: NEON.cyan, border: `1px solid ${NEON.cyan}25` }}>
      sample data
     </span>
    )}
   </div>
   {/* Day labels (left) */}
   <div className="flex gap-2">
    <div className="flex flex-col justify-between" style={{ paddingTop: 2, paddingBottom: 14 }}>
     {DAYS_LABELS.map(lbl => (
      <span key={lbl} className="text-[8px] leading-none font-code" style={{ color: '#444', height: 14 }}>
       {lbl}
      </span>
     ))}
    </div>
    <div className="flex-1">
     <Heatmap values={values} rows={7} cols={24} cell={12} gap={2} showAxisLabels />
    </div>
   </div>
  </div>
 );
});

// ─── Animated neon card — HUD style ─────────────────────────────────
const NeonCard = memo(function NeonCard({ icon: Icon, label, value, color, sub, sparkData }) {
 return (
  <div className="neon-card p-4 hud-brackets slide-up group cursor-default relative overflow-hidden">
   {/* Corner accent line — top left */}
   <div className="absolute top-0 left-0 w-10 h-px" style={{ background: `linear-gradient(90deg, ${color}, transparent)` }} />
   <div className="absolute top-0 left-0 w-px h-10" style={{ background: `linear-gradient(180deg, ${color}, transparent)` }} />
   {/* Corner accent — bottom right */}
   <div className="absolute bottom-0 right-0 w-10 h-px" style={{ background: `linear-gradient(270deg, ${color}, transparent)` }} />
   <div className="absolute bottom-0 right-0 w-px h-10" style={{ background: `linear-gradient(0deg, ${color}, transparent)` }} />
   <div className="flex items-center gap-2 mb-1">
    <Icon size={14} style={{ color, filter: `drop-shadow(0 0 4px ${color})` }} />
    <span className="text-gray-500 text-[10px] tracking-wider uppercase font-hud">{label}</span>
   </div>
   <div className="text-2xl font-bold font-hud" style={{ color, textShadow: `0 0 20px ${color}66` }}>{value}</div>
   {sub && <div className="text-gray-600 text-[11px] mt-0.5 font-code">{sub}</div>}
   {sparkData && <div className="mt-2 opacity-70"><Sparkline data={sparkData} color={color} /></div>}
  </div>
 );
});

// ─── System stat mini-card ──────────────────────────────────────────
const SysStat = memo(function SysStat({ icon: Icon, label, value, unit, color = NEON.green }) {
 return (
  <div className="flex items-center gap-3 p-3 neon-card">
   <Icon size={16} style={{ color, filter: `drop-shadow(0 0 3px ${color})` }} />
   <div>
    <div className="text-gray-600 text-[10px] tracking-wider uppercase font-hud">{label}</div>
    <div className="text-white text-sm font-bold font-code" style={{ textShadow: `0 0 8px ${color}44` }}>
     {value}<span className="text-gray-600 text-[10px] ml-0.5">{unit}</span>
    </div>
   </div>
  </div>
 );
});

// ─── Quick Actions ──────────────────────────────────────────────────
const QUICK_ACTIONS = [
 { icon: Bot, label: 'Register Agent', color: NEON.blue, action: 'register-agent' },
 { icon: Plus, label: 'New Task', color: NEON.green, action: 'new-task' },
 { icon: GitBranch, label: 'Create DAG', color: NEON.purple, action: 'new-dag' },
 { icon: Clock, label: 'Schedule', color: NEON.cyan, action: 'new-schedule' },
];

const QuickActions = memo(function QuickActions({ onAction }) {
 return (
  <div className="neon-card p-4 hud-brackets">
   <div className="flex items-center gap-2 mb-3">
    <Zap size={14} style={{ color: NEON.yellow, filter: `drop-shadow(0 0 3px ${NEON.yellow})` }} />
    <span className="text-xs font-bold tracking-wider uppercase font-hud" style={{ color: '#aaa' }}>Quick Actions</span>
   </div>
   <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
    {QUICK_ACTIONS.map(a => (
     <button key={a.action} onClick={() => onAction(a.action)}
      className="neon-btn flex items-center gap-2 px-3 py-2.5 text-xs font-semibold"
      style={{
       borderColor: `${a.color}25`,
       color: a.color,
       background: `${a.color}08`,
      }}
      onMouseEnter={e => {
       e.currentTarget.style.background = `${a.color}18`;
       e.currentTarget.style.borderColor = `${a.color}50`;
       e.currentTarget.style.boxShadow = `0 0 15px ${a.color}15`;
      }}
      onMouseLeave={e => {
       e.currentTarget.style.background = `${a.color}08`;
       e.currentTarget.style.borderColor = `${a.color}25`;
       e.currentTarget.style.boxShadow = 'none';
      }}
     >
      <a.icon size={14} /> {a.label}
     </button>
    ))}
   </div>
  </div>
 );
});

// ─── Provider Status Bar ────────────
const PROVIDER_COLORS_MAP = {
 openai: NEON.green, google: '#4285f4', nvidia: '#76b900', anthropic: NEON.orange,
 openrouter: NEON.magenta, groq: NEON.orange, together: NEON.blue, deepseek: NEON.blue,
 mistral: NEON.blue, cerebras: NEON.yellow, sambanova: NEON.green, perplexity: NEON.cyan,
 xai: '#fff', cohere: NEON.pink, ollama: NEON.teal,
};

const ProviderStatusBar = memo(function ProviderStatusBar({ summary }) {
 const [providers, setProviders] = useState([]);
 const [ollamaStatus, setOllamaStatus] = useState({ connected: false });
 useEffect(() => {
  cachedFetch('/api/llm/providers', 15000).then(setProviders).catch(() => {});
  cachedFetch('/api/ollama/status', 15000).then(setOllamaStatus).catch(() => {});
 }, []);

 usePolling(() => cachedFetch('/api/ollama/status', 15000).then(setOllamaStatus).catch(() => {}), 60000);
 return (
  <div className="neon-card p-4 hud-brackets">
   <div className="flex items-center gap-2 mb-3">
    <Plug size={14} style={{ color: NEON.orange, filter: `drop-shadow(0 0 3px ${NEON.orange})` }} />
    <span className="text-xs font-bold tracking-wider uppercase font-hud" style={{ color: '#aaa' }}>Connected Providers</span>
    <span className="text-[10px] px-1.5 py-0.5 font-code"
     style={{ background: `${NEON.green}10`, color: NEON.green, border: `1px solid ${NEON.green}25` }}>
     {providers.length}
    </span>
   </div>
   <div className="flex flex-wrap gap-2">
    {providers.filter(p => p.api_key || p.type === 'ollama').map(p => {
     const color = PROVIDER_COLORS_MAP[p.type] || NEON.cyan;
     return (
      <span key={p.id} className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold transition-all font-hud"
       style={{
        background: `${color}08`,
        border: `1px solid ${color}25`,
        color,
       }}
       onMouseEnter={e => {
        e.currentTarget.style.background = `${color}15`;
        e.currentTarget.style.boxShadow = `0 0 12px ${color}15`;
       }}
       onMouseLeave={e => {
        e.currentTarget.style.background = `${color}08`;
        e.currentTarget.style.boxShadow = 'none';
       }}
      >
       <span className="relative flex h-1.5 w-1.5">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-none"
         style={{ background: color, opacity: 0.6 }} />
        <span className="relative inline-flex h-1.5 w-1.5 status-dot"
         style={{ background: color }} />
       </span>
       {p.name}
      </span>
     );
    })}
    {/* Ollama auto-detect */}
    <span className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold font-hud"
     style={{
      background: ollamaStatus.connected ? `${NEON.teal}08` : 'rgba(255,255,255,0.02)',
      border: `1px solid ${ollamaStatus.connected ? `${NEON.teal}25` : 'rgba(255,255,255,0.05)'}`,
      color: ollamaStatus.connected ? NEON.teal : '#444',
     }}
     title={ollamaStatus.connected ? 'Ollama detected — add it as a provider' : 'Ollama not detected on localhost:11434'}
    >
     🦙 {ollamaStatus.connected ? 'Ollama Detected' : 'Ollama Offline'}
    </span>
    {providers.filter(p => p.api_key || p.type === 'ollama').length === 0 && !ollamaStatus.connected && (
     <span className="text-[11px] font-code" style={{ color: '#444' }}>No providers — add API keys in Settings</span>
    )}
   </div>
  </div>
 );
});

// ─── Live Telemetry Bar (WebSocket-pushed) ────────────────────────
const TelemetryBar = memo(function TelemetryBar() {
 const [telemetry, setTelemetry] = useState({ cpu: 0, mem: 0, gpu: 0, npu: 0, temp: 0, uptime: 0, wsClients: 0 });
 const { lastEvent } = useWebSocket();

 useEffect(() => {
  cachedFetch('/api/telemetry', 5000).then(setTelemetry).catch(() => {});
 }, []);

 useEffect(() => {
  if (lastEvent) {
   try {
    const msg = JSON.parse(lastEvent);
    if (msg.type === 'telemetry' && msg.payload) setTelemetry(msg.payload);
   } catch {}
  }
 }, [lastEvent]);

 const gauges = [
  { label: 'CPU', value: telemetry.cpu, max: 100, unit: '%', color: NEON.cyan, icon: Cpu },
  { label: 'MEM', value: telemetry.mem, max: 100, unit: '%', color: NEON.green, icon: HardDrive },
  { label: 'GPU', value: telemetry.gpu, max: 100, unit: '%', color: NEON.magenta, icon: Zap },
  { label: 'NPU', value: telemetry.npu, max: 100, unit: '%', color: NEON.purple, icon: Sparkles },
  { label: 'TEMP', value: telemetry.temp, max: 85, unit: '°C', color: telemetry.temp > 70 ? NEON.red : NEON.yellow, icon: Activity },
  { label: 'WS', value: telemetry.wsClients, max: 50, unit: '', color: NEON.teal, icon: Radio },
 ];

 const formatUptime = (s) => {
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
 };

 return (
  <div className="neon-card p-4 hud-brackets">
   <div className="flex items-center justify-between mb-3">
    <div className="flex items-center gap-2">
     <Activity size={14} style={{ color: NEON.green, filter: `drop-shadow(0 0 3px ${NEON.green})` }} />
     <span className="text-xs font-bold tracking-wider uppercase font-hud" style={{ color: '#888' }}>Live Telemetry</span>
     <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full opacity-75" style={{ background: NEON.green }} />
      <span className="relative inline-flex h-2 w-2 status-dot" style={{ background: NEON.green }} />
     </span>
    </div>
    <span className="text-[10px] font-code" style={{ color: '#444' }}>Uptime: {formatUptime(telemetry.uptime)}</span>
   </div>
   <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
    {gauges.map(g => {
     const pct = Math.min(100, (g.value / g.max) * 100);
     const Icon = g.icon;
     return (
      <div key={g.label} className="flex flex-col items-center gap-1.5 p-2" style={{ background: `${g.color}04`, border: `1px solid ${g.color}10` }}>
       <Icon size={12} style={{ color: g.color, filter: `drop-shadow(0 0 3px ${g.color})` }} />
       <div className="w-full h-1.5 overflow-hidden" style={{ background: `${g.color}10`, clipPath: 'polygon(2px 0, calc(100% - 2px) 0, 100% 2px, 100% calc(100% - 2px), calc(100% - 2px) 100%, 2px 100%, 0 calc(100% - 2px), 0 2px)' }}>
        <div className="h-full transition-all duration-700" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${g.color}88, ${g.color})`, boxShadow: `0 0 6px ${g.color}66` }} />
       </div>
       <div className="flex items-baseline gap-0.5">
        <span className="text-sm font-bold font-code" style={{ color: g.color, textShadow: `0 0 8px ${g.color}44` }}>{g.value}</span>
        <span className="text-[9px] font-code" style={{ color: '#444' }}>{g.unit}</span>
       </div>
       <span className="text-[9px] uppercase tracking-wider font-hud" style={{ color: '#555' }}>{g.label}</span>
      </div>
     );
    })}
   </div>
  </div>
 );
});

// ─── Cost Tracking Bar ──────────────────────────────────────────
const CostTracker = memo(function CostTracker({ summary, spark }) {
 const [usage, setUsage] = useState(null);
 useEffect(() => {
  cachedFetch('/api/dashboard/usage', 30000).then(setUsage).catch(() => setUsage(null));
 }, []);
 if (!usage) return null;
 const cards = [
  { label: 'Est. Cost', value: `$${usage.totalCost?.toFixed(4) || '0.00'}`, color: NEON.magenta, icon: DollarSign, data: spark?.cost },
  { label: 'Total Tokens', value: (usage.totalTokens || 0).toLocaleString(), color: NEON.cyan, icon: Hash, data: spark?.tokens },
  { label: 'Prompt Tokens', value: (usage.promptTokens || 0).toLocaleString(), color: NEON.green, icon: Sparkles, data: spark?.tokens },
  { label: 'Completion', value: (usage.completionTokens || 0).toLocaleString(), color: NEON.yellow, icon: TrendingUp, data: spark?.tokens },
 ];
 return (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 neon-card p-4 hud-brackets">
   {cards.map(c => {
    const Icon = c.icon;
    return (
     <div key={c.label} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
       <Icon size={14} style={{ color: c.color, filter: `drop-shadow(0 0 3px ${c.color})` }} />
       <div>
        <div className="text-gray-600 text-[10px] tracking-wider uppercase font-hud">{c.label}</div>
        <div className="text-white text-sm font-bold font-code" style={{ textShadow: `0 0 8px ${c.color}44` }}>
         {c.value}
        </div>
       </div>
      </div>
      <div className="opacity-80">
       <Sparkline data={c.data} color={c.color} width={140} height={26} id={`cost-${c.label.replace(/\s/g,'')}`} />
      </div>
     </div>
    );
   })}
  </div>
 );
});

// ─── Sentinel Alert Bar ───────────────────────────────────────────
const SentinelAlertBar = memo(function SentinelAlertBar() {
 const { lastMsg } = useWebSocket();
 const [alerts, setAlerts] = useState([]);
 const MAX_ALERTS = 12;

 useEffect(() => {
  if (!lastMsg || lastMsg.type !== 'sentinel:alert') return;
  const p = lastMsg.payload || {};
  setAlerts(prev => {
   const entry = { ...p, ts: p.ts || Date.now(), id: Math.random().toString(36).slice(2) };
   return [...prev, entry].slice(-MAX_ALERTS);
  });
 }, [lastMsg]);

 const dismiss = (id) => setAlerts(prev => prev.filter(a => a.id !== id));

 if (alerts.length === 0) return null;

 const sevStyle = {
  danger: { color: NEON.red, bg: `${NEON.red}08`, border: `${NEON.red}30`, glow: `${NEON.red}44` },
  warning: { color: NEON.yellow, bg: `${NEON.yellow}08`, border: `${NEON.yellow}30`, glow: `${NEON.yellow}33` },
 };

 return (
  <div className="space-y-1.5">
   {alerts.map(a => {
    const s = sevStyle[a.severity] || sevStyle.warning;
    return (
     <div key={a.id} className="flex items-start gap-2.5 px-4 py-2.5 fade-in" style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10 }}>
      <ShieldAlert size={14} style={{ color: s.color, filter: `drop-shadow(0 0 4px ${s.glow})`, marginTop: 1, flexShrink: 0 }} />
      <div className="flex-1 min-w-0">
       <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold tracking-wider uppercase font-hud" style={{ color: s.color }}>{a.severity}</span>
        <span className="text-[10px] font-code" style={{ color: '#555' }}>{a.type || 'agent'}</span>
        {a.sessionId && <span className="text-[10px] font-mono" style={{ color: '#444' }}>sess:{a.sessionId?.slice(0,8)}</span>}
       </div>
       <div className="text-xs font-code mt-0.5" style={{ color: '#ccc' }}>{a.message}</div>
      </div>
      <span className="text-[10px] shrink-0 font-code" style={{ color: '#444' }}>{new Date(a.ts).toLocaleTimeString()}</span>
      <button onClick={() => dismiss(a.id)} style={{ color: '#444', flexShrink: 0, marginTop: 1 }}><X size={12} /></button>
     </div>
    );
   })}
  </div>
 );
});

// ─── Main Dashboard ─────────────────────────────────────────────────
export default function Dashboard() {
 const [summary, setSummary] = useState(null);
 const { lastMsg, connected } = useWebSocket();
 const [events, setEvents] = useState([]);
 const [sparkHistory, setSparkHistory] = useState({});
 const feedRef = useRef(null);
 const MAX_EVENTS = 80;

 useEffect(() => {
  cachedFetch('/api/dashboard/summary', 10000).then(setSummary).catch(() => setSummary(null));
 }, []);

 useWsResource(() => cachedFetch('/api/dashboard/summary', 10000).then(s => {
   setSummary(s);
   setSparkHistory(prev => ({
    agents: [...(prev.agents || []).slice(-29), s.activeAgents],
    tasks: [...(prev.tasks || []).slice(-29), s.totalTasks],
    running: [...(prev.running || []).slice(-29), s.runningTasks],
    pending: [...(prev.pending || []).slice(-29), s.pendingTasks],
   }));
 }).catch(() => {}), 'dashboard:update', 15000);

 // Cost + token trend — refreshed from the usage endpoint and appended to
 // spark history each load. Updated on a slower cadence than stats.
 useEffect(() => {
  let mounted = true;
  cachedFetch('/api/dashboard/usage', 30000).then(u => {
   if (!mounted || !u) return;
   setSparkHistory(prev => ({
    ...prev,
    cost: [...(prev.cost || []).slice(-29), u.totalCost || 0],
    tokens: [...(prev.tokens || []).slice(-29), u.totalTokens || 0],
   }));
  }).catch(() => {});
  return () => { mounted = false; };
 }, []);

 useEffect(() => {
  if (!lastMsg || lastMsg.type === 'task:log') return;
  setEvents(prev => {
   const entry = { type: lastMsg.type, text: formatEvent(lastMsg), ts: Date.now() };
   const next = [...prev, entry];
   return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
  });
 }, [lastMsg]);

 useEffect(() => {
  if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
 }, [events]);

 const navigateTo = (action) => {
  const routes = {
   'register-agent': '/agents',
   'new-task': '/tasks',
   'new-dag': '/dags',
   'new-schedule': '/schedules',
  };
  const path = routes[action];
  if (path) window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
 };

 const cards = summary ? [
  { label: 'Active Agents', value: summary.activeAgents, icon: Bot, color: NEON.blue, sub: summary.activeAgents > 0 ? `${summary.activeAgents} online` : 'No agents', spark: sparkHistory.agents },
  { label: 'Total Tasks', value: summary.totalTasks, icon: ListTodo, color: NEON.green, sub: `${summary.runningTasks} running`, spark: sparkHistory.tasks },
  { label: 'Running', value: summary.runningTasks, icon: Activity, color: NEON.yellow, sub: `${summary.pendingTasks} pending`, spark: sparkHistory.running },
  { label: 'Pending', value: summary.pendingTasks, icon: Clock, color: '#888', sub: 'Queued', spark: sparkHistory.pending },
  { label: 'DAGs', value: summary.totalDags, icon: GitBranch, color: NEON.purple, sub: 'Workflows' },
  { label: 'Users', value: summary.totalUsers, icon: Users, color: NEON.pink, sub: 'Registered' },
  { label: 'LLM Providers', value: summary.totalProviders || 0, icon: Plug, color: NEON.orange, sub: `${summary.totalModels || 0} models` },
 ] : [];

 const sysStats = summary ? [
  { label: 'CPU Load', value: summary.cpuLoad, icon: Cpu, color: NEON.cyan },
  { label: 'NPU Util', value: summary.npuUtilization, icon: HardDrive, color: NEON.magenta },
  { label: 'WS Clients', value: summary.wsClients, icon: Radio, color: NEON.green },
  { label: 'Uptime', value: `${summary.uptimeHours}h`, icon: Timer, color: NEON.yellow },
 ] : [];

 return (
  <div className="space-y-5 fade-in">
   {/* ── Header ──────────────────────────────────────────────── */}
   <div className="flex flex-wrap items-center gap-3 mb-2">
    <div className="flex items-center gap-2">
     <Sparkles size={20} style={{ color: NEON.green, filter: `drop-shadow(0 0 8px ${NEON.green})` }} />
     <h2 className="text-2xl font-bold font-hud" style={{
      background: `linear-gradient(135deg, ${NEON.green}, ${NEON.cyan}, ${NEON.purple})`,
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      filter: `drop-shadow(0 0 20px ${NEON.green}44)`,
     }}>
      Cardinal Frame
     </h2>
    </div>
    <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 font-hud"
     style={{
      background: connected ? `${NEON.green}08` : `${NEON.red}08`,
      border: `1px solid ${connected ? `${NEON.green}25` : `${NEON.red}25`}`,
      color: connected ? NEON.green : NEON.red,
     }}
    >
     {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
     {connected ? 'LIVE' : 'OFFLINE'}
     {connected && <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full opacity-75" style={{ background: NEON.green }} />
      <span className="relative inline-flex h-2 w-2 status-dot" style={{ background: NEON.green }} />
     </span>}
    </span>
   </div>

   {/* ── Metric cards ────────────────────────────────────────── */}
   <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
    {cards.map(c => (
     <NeonCard key={c.label} icon={c.icon} label={c.label} value={c.value} color={c.color} sub={c.sub} sparkData={c.spark} />
    ))}
    {!summary && (
     <div className="col-span-full text-center py-12" style={{ color: NEON.green }}>
      <div className="animate-pulse flex items-center justify-center gap-2">
       <Activity size={16} /> Loading metrics...
      </div>
     </div>
    )}
   </div>

   {/* ── Live Telemetry ──────────────────────────────────────── */}
   <TelemetryBar />

   {/* ── Provider Status Pills ───────────────────────────────── */}
   {summary && <ProviderStatusBar summary={summary} />}

   {/* ── Cost Tracking ───────────────────────────────────────── */}
   {summary && <CostTracker summary={summary} spark={sparkHistory} />}

   {/* ── Sentinel Alerts ─────────────────────────────────────── */}
   <SentinelAlertBar />

   {/* ── Quick Actions ───────────────────────────────────────── */}
   <QuickActions onAction={navigateTo} />

   {/* ── Activity Heatmap + Feed ─────────────────────────────── */}
   <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
    <div className="lg:col-span-2">
     <ActivityHeatmap events={events} />
    </div>
    {/* Activity Feed */}
    <div className="lg:col-span-3 neon-card overflow-hidden">
     <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${NEON.green}08` }}>
      <div className="flex items-center gap-2">
       <Activity size={14} style={{ color: NEON.green, filter: `drop-shadow(0 0 3px ${NEON.green})` }} />
       <span className="text-xs font-bold tracking-wider uppercase font-hud" style={{ color: '#aaa' }}>Activity Feed</span>
       {events.length > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 font-code" style={{ background: `${NEON.green}08`, color: NEON.green, border: `1px solid ${NEON.green}20` }}>
         {events.length}
        </span>
       )}
      </div>
      <button onClick={() => setEvents([])}
       className="text-xs transition font-hud" style={{ color: '#444' }}>
       Clear
      </button>
     </div>
     <div ref={feedRef} className="max-h-72 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
      {events.length === 0 ? (
       <div className="text-center py-8" style={{ color: '#444' }}>
        <Radio size={24} className="mx-auto mb-2 opacity-20" />
        <span className="text-xs font-code">No events yet. Actions will appear here.</span>
       </div>
      ) : events.map((ev, i) => (
       <div key={i} className="flex items-center gap-2.5 px-4 py-1.5 transition-colors" style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
        <div className="shrink-0">{eventIcons[ev.type] || <Activity size={12} style={{ color: '#333' }} />}</div>
        <div className="flex-1 text-xs truncate font-code" style={{ color: '#999' }}>{ev.text}</div>
        <div className="text-[10px] shrink-0 font-code" style={{ color: '#333' }}>
         {new Date(ev.ts).toLocaleTimeString()}
        </div>
       </div>
      ))}
     </div>
    </div>
   </div>

   {/* ── Footer status bar ───────────────────────────────────── */}
   <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs neon-card font-hud" style={{ color: '#444' }}>
    <div className="flex items-center gap-4">
     <span className="flex items-center gap-1">
      <Shield size={10} style={{ color: NEON.green }} /> Secure
     </span>
    </div>
    <div className="flex items-center gap-4">
     <span className="font-code">SQLite WAL</span>
     <span className="flex items-center gap-1">
      <span className="relative flex h-1.5 w-1.5">
       <span className="animate-ping absolute inline-flex h-full w-full" style={{ background: NEON.green, opacity: 0.75 }} />
       <span className="relative inline-flex h-1.5 w-1.5 status-dot" style={{ background: NEON.green }} />
      </span>
      Operational
     </span>
    </div>
   </div>
  </div>
 );
}
