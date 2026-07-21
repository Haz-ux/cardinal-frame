import { useEffect, useState, useRef, useCallback } from "react";
import { useWebSocket } from "../components/useWebSocket";
import {
  Activity, Cpu, HardDrive, Users, ListTodo, GitBranch,
  Radio, Clock, Bot, Play, AlertTriangle, Trash2, Plus, Server, Zap,
  MessageSquare, Hash, DollarSign, TrendingUp
} from "lucide-react";

const eventIcons: Record<string, React.ReactNode> = {
  "task:created": <Plus size={12} className="text-green-400" />,
  "task:status": <Play size={12} className="text-yellow-400" />,
  "task:deleted": <Trash2 size={12} className="text-red-400" />,
  "task:assigned": <Users size={12} className="text-blue-400" />,
  "task:log": <Activity size={12} className="text-gray-400" />,
  "agent:created": <Bot size={12} className="text-cyan-400" />,
  "agent:heartbeat": <Activity size={12} className="text-green-400" />,
  "agent:status": <AlertTriangle size={12} className="text-yellow-400" />,
  "agent:deleted": <Trash2 size={12} className="text-red-400" />,
  "dag:created": <GitBranch size={12} className="text-purple-400" />,
  "dag:status": <Activity size={12} className="text-yellow-400" />,
  "dag:deleted": <Trash2 size={12} className="text-red-400" />,
  "schedule:created": <Clock size={12} className="text-cyan-400" />,
  "schedule:fired": <Play size={12} className="text-green-400" />,
  "schedule:deleted": <Trash2 size={12} className="text-red-400" />,
  "mcp:registered": <Server size={12} className="text-indigo-400" />,
  "group:created": <Users size={12} className="text-teal-400" />,
  "group:broadcast": <Activity size={12} className="text-teal-400" />,
  "comms:message": <MessageSquare size={12} className="text-magenta-400" />,
  "comms:channel": <Hash size={12} className="text-indigo-400" />,
  connected: <Radio size={12} className="text-green-400" />,
};

function formatEvent(msg: any) {
  const p = msg.payload || {};
  const map: Record<string, string> = {
    "task:created": `Task "${p.name || p.id?.slice(0, 8)}" created`,
    "task:status": `Task ${p.id?.slice(0, 8)} → ${p.status}`,
    "task:deleted": `Task ${p.id?.slice(0, 8)} deleted`,
    "task:assigned": `Task ${p.taskId?.slice(0, 8)} → agent ${p.agentId?.slice(0, 8)}`,
    "task:log": `Log: ${p.line?.slice(0, 60)}`,
    "agent:created": `Agent "${p.name || p.id?.slice(0, 8)}" registered`,
    "agent:heartbeat": `Agent "${p.name || p.id?.slice(0, 8)}" heartbeat`,
    "agent:status": `Agent "${p.name || p.id?.slice(0, 8)}" → ${p.status}`,
    "agent:deleted": `Agent ${p.id?.slice(0, 8)} deleted`,
    "dag:created": `DAG "${p.name || p.id?.slice(0, 8)}" created`,
    "dag:status": `DAG ${p.id?.slice(0, 8)} → ${p.status}`,
    "dag:deleted": `DAG ${p.id?.slice(0, 8)} deleted`,
    "schedule:created": `Schedule "${p.name || p.id?.slice(0, 8)}" created`,
    "schedule:fired": `Schedule "${p.name}" fired task ${p.taskId?.slice(0, 8)}`,
    "schedule:deleted": `Schedule ${p.id?.slice(0, 8)} deleted`,
    "mcp:registered": `MCP server "${p.name}" registered`,
    "group:created": `Group "${p.name || p.id?.slice(0, 8)}" created`,
    "group:broadcast": `Group broadcast: ${p.taskIds?.length || 0} tasks`,
    "comms:message": `${p.direction === "inbound" ? "←" : "→"} [${p.platform || "comms"}] ${p.remote_username || ""}: ${(p.content || "").slice(0, 60)}`,
    "comms:channel": `Comms channel ${p.type || "event"}: ${p.name || p.id?.slice(0, 8) || ""}`,
    connected: "WebSocket connected",
  };
  return map[msg.type] || msg.type;
}

/* ── Neon metric card ── */
function NeonCard({ label, value, icon: Icon, glow }: {
  label: string; value: string | number; icon: any; glow: string;
}) {
  return (
    <div className={`relative group rounded-xl p-4 border backdrop-blur-sm overflow-hidden transition-all duration-300 hover:scale-[1.02] ${glow}`}
      style={{ background: "linear-gradient(135deg, rgba(17,24,39,0.8), rgba(17,24,39,0.4))" }}>
      {/* Glow background pulse */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ background: `radial-gradient(ellipse at center, ${glow.includes("cyan") ? "rgba(6,182,212,0.08)" : glow.includes("purple") ? "rgba(168,85,247,0.08)" : glow.includes("green") ? "rgba(16,185,129,0.08)" : glow.includes("amber") ? "rgba(245,158,11,0.08)" : "rgba(59,130,246,0.08)"}, transparent 70%)` }} />
      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-2">
          <Icon size={16} className={`drop-shadow-[0_0_6px_currentColor]`} />
          <span className="text-[10px] uppercase tracking-widest text-gray-500 font-mono">{label}</span>
        </div>
        <div className="text-3xl font-bold font-mono tracking-tight">{value}</div>
      </div>
    </div>
  );
}

/* ── System stat pill ── */
function StatPill({ label, value, icon: Icon }: { label: string; value: any; icon: any }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-gray-800/60 bg-gray-900/40 backdrop-blur-sm">
      <Icon size={14} className="text-cyan-500/60" />
      <div>
        <div className="text-[9px] uppercase tracking-widest text-gray-600 font-mono">{label}</div>
        <div className="text-sm font-semibold font-mono text-gray-300">{value}</div>
      </div>
    </div>
  );
}

/* ── Sparkline (pure SVG, no deps) ── */
function Sparkline({ data, color = "#06b6d4", height = 30, width = 120 }: {
  data: number[]; color?: string; height?: number; width?: number;
}) {
  if (data.length < 2) return <svg width={width} height={height} />;

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");

  const areaPoints = `0,${height} ${points} ${width},${height}`;

  // Build unique gradient ID
  const gradId = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradId})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 3px ${color}88)` }}
      />
      {/* Last point dot */}
      {data.length > 0 && (
        <circle
          cx={(data.length - 1) / (data.length - 1) * width}
          cy={height - ((data[data.length - 1] - min) / range) * height}
          r="2"
          fill={color}
          style={{ filter: `drop-shadow(0 0 4px ${color})` }}
        />
      )}
    </svg>
  );
}

/* ── Cost + activity chart panel ── */
function CostChart({ costData, activityData }: { costData: any; activityData: any }) {
  const [view, setView] = useState<"cost" | "tokens" | "activity">("cost");

  if (!costData && !activityData) return null;

  const costBuckets = costData?.buckets || [];
  const actBuckets = activityData?.buckets || [];

  const costSeries = costBuckets.map((b: any) => b.cost || 0);
  const tokenSeries = costBuckets.map((b: any) => (b.prompt || 0) + (b.completion || 0));
  const taskSeries = actBuckets.map((b: any) => b.tasks || 0);
  const msgSeries = actBuckets.map((b: any) => b.messages || 0);
  const actionSeries = actBuckets.map((b: any) => b.agentActions || 0);

  const totals = costData?.totals || {};

  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-900/30 backdrop-blur-sm overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-gray-800/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DollarSign size={14} className="text-emerald-500 drop-shadow-[0_0_4px_rgba(16,185,129,0.5)]" />
          <span className="text-xs font-semibold tracking-wider text-gray-400 uppercase font-mono">Cost & Activity</span>
        </div>
        <div className="flex items-center gap-1">
          {(["cost", "tokens", "activity"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide transition ${
                view === v
                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-600/40"
                  : "text-gray-600 hover:text-gray-400 border border-transparent"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {/* Summary stats */}
        <div className="flex items-center gap-6 mb-4">
          {view === "cost" && (
            <>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-gray-600 font-mono">Total Cost</div>
                <div className="text-lg font-bold font-mono text-emerald-400">${((totals.cost || 0)).toFixed(4)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-gray-600 font-mono">API Calls</div>
                <div className="text-lg font-bold font-mono text-cyan-400">{totals.calls || 0}</div>
              </div>
            </>
          )}
          {view === "tokens" && (
            <>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-gray-600 font-mono">Prompt</div>
                <div className="text-lg font-bold font-mono text-cyan-400">{(totals.prompt || 0).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-gray-600 font-mono">Completion</div>
                <div className="text-lg font-bold font-mono text-magenta-400">{(totals.completion || 0).toLocaleString()}</div>
              </div>
            </>
          )}
          {view === "activity" && (
            <>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-gray-600 font-mono">Tasks</div>
                <div className="text-lg font-bold font-mono text-green-400">{taskSeries.reduce((a: number, b: number) => a + b, 0)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-gray-600 font-mono">Messages</div>
                <div className="text-lg font-bold font-mono text-cyan-400">{msgSeries.reduce((a: number, b: number) => a + b, 0)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-gray-600 font-mono">Agent Actions</div>
                <div className="text-lg font-bold font-mono text-purple-400">{actionSeries.reduce((a: number, b: number) => a + b, 0)}</div>
              </div>
            </>
          )}
        </div>

        {/* Sparkline chart */}
        <div className="flex items-end gap-2">
          {view === "cost" && (
            <div className="flex flex-col items-center gap-1">
              <Sparkline data={costSeries} color="#10b981" height={40} width={600} />
              <div className="text-[8px] text-gray-700 font-mono">24h cost ($)</div>
            </div>
          )}
          {view === "tokens" && (
            <div className="flex flex-col gap-1">
              <Sparkline data={tokenSeries} color="#06b6d4" height={40} width={600} />
              <Sparkline data={costBuckets.map((b: any) => b.prompt || 0)} color="#a855f7" height={40} width={600} />
              <div className="text-[8px] text-gray-700 font-mono">24h tokens (cyan=total, purple=prompt)</div>
            </div>
          )}
          {view === "activity" && (
            <div className="flex flex-col gap-1">
              <Sparkline data={taskSeries} color="#10b981" height={40} width={600} />
              <Sparkline data={msgSeries} color="#06b6d4" height={40} width={600} />
              <Sparkline data={actionSeries} color="#a855f7" height={40} width={600} />
              <div className="text-[8px] text-gray-700 font-mono">24h (green=tasks, cyan=msgs, purple=actions)</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Mini heatmap for hourly activity ── */
function ActivityHeatmap({ buckets }: { buckets: any[] }) {
  if (!buckets || buckets.length === 0) return null;

  const maxVal = Math.max(...buckets.map((b: any) => (b.tasks || 0) + (b.agentActions || 0) + (b.messages || 0)), 1);

  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-900/30 backdrop-blur-sm overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-gray-800/40 flex items-center gap-2">
        <TrendingUp size={14} className="text-purple-500 drop-shadow-[0_0_4px_rgba(168,85,247,0.5)]" />
        <span className="text-xs font-semibold tracking-wider text-gray-400 uppercase font-mono">Activity Heatmap</span>
      </div>
      <div className="p-4">
        <div className="flex gap-0.5">
          {buckets.map((b: any, i: number) => {
            const val = (b.tasks || 0) + (b.agentActions || 0) + (b.messages || 0);
            const intensity = val / maxVal;
            return (
              <div
                key={i}
                className="flex-1 h-8 rounded-sm transition-all"
                style={{
                  backgroundColor: intensity > 0
                    ? `rgba(168, 85, 247, ${0.15 + intensity * 0.85})`
                    : "rgba(31, 41, 55, 0.3)",
                  boxShadow: intensity > 0.5 ? `0 0 4px rgba(168, 85, 247, ${intensity * 0.5})` : "none",
                }}
                title={`${b.hour}: ${val} events`}
              />
            );
          })}
        </div>
        <div className="flex justify-between mt-1 text-[8px] text-gray-700 font-mono">
          <span>{buckets[0]?.hour?.slice(11) || ""}</span>
          <span>now</span>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [summary, setSummary] = useState<any>(null);
  const [costData, setCostData] = useState<any>(null);
  const [activityData, setActivityData] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const { lastMsg, connected } = useWebSocket() as any;
  const [events, setEvents] = useState<any[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const MAX_EVENTS = 80;

  useEffect(() => {
    fetch("/api/dashboard/summary", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setSummary)
      .catch(() => setSummary(null));
    const id = setInterval(() => {
      fetch("/api/dashboard/summary", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(setSummary)
        .catch(() => {});
    }, 10000);
    return () => clearInterval(id);
  }, []);

  // Fetch cost + activity series
  useEffect(() => {
    const fetchData = () => {
      fetch("/api/dashboard/cost-series?hours=24", { headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then(setCostData)
        .catch(() => {});
      fetch("/api/dashboard/activity-series?hours=24", { headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then(setActivityData)
        .catch(() => {});
      fetch("/api/dashboard/usage", { headers: { Authorization: `Bearer ${localStorage.getItem("token") || ""}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then(setUsage)
        .catch(() => {});
    };
    fetchData();
    const id = setInterval(fetchData, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!lastMsg || lastMsg.type === "task:log") return;
    setEvents((prev) => {
      const entry = { type: lastMsg.type, text: formatEvent(lastMsg), ts: Date.now() };
      const next = [...prev, entry];
      return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
    });
  }, [lastMsg]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [events]);

  const metrics = summary
    ? [
        { label: "Active Agents", value: summary.activeAgents, icon: Bot, glow: "border-cyan-500/30 text-cyan-400" },
        { label: "Total Tasks", value: summary.totalTasks, icon: ListTodo, glow: "border-green-500/30 text-green-400" },
        { label: "Running", value: summary.runningTasks, icon: Zap, glow: "border-amber-500/30 text-amber-400" },
        { label: "DAGs", value: summary.totalDags, icon: GitBranch, glow: "border-purple-500/30 text-purple-400" },
      ]
    : [];

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-400">
          Dashboard
        </h1>
        <span className={`flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded-full border ${
          connected
            ? "bg-green-950/40 border-green-500/30 text-green-400 shadow-[0_0_10px_rgba(16,185,129,0.1)]"
            : "bg-red-950/40 border-red-500/30 text-red-400"
        }`}>
          <Radio size={10} className={connected ? "animate-pulse" : ""} />
          {connected ? "LIVE" : "OFFLINE"}
        </span>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {metrics.map((m) => (
          <NeonCard key={m.label} {...m} />
        ))}
        {!summary && (
          <div className="col-span-full text-gray-600 text-sm py-12 text-center font-mono">
            <Activity size={20} className="inline animate-spin mr-2 text-cyan-500/40" />
            Loading metrics...
          </div>
        )}
      </div>

      {/* Cost + Activity sparklines */}
      <CostChart costData={costData} activityData={activityData} />

      {/* Activity Heatmap */}
      {activityData && <ActivityHeatmap buckets={activityData.buckets} />}

      {/* System stats row */}
      {summary && (
        <div className="flex flex-wrap gap-3 mb-6">
          <StatPill label="CPU Load" value={summary.cpuLoad} icon={Cpu} />
          <StatPill label="NPU Util" value={summary.npuUtilization} icon={HardDrive} />
          <StatPill label="WS Clients" value={summary.wsClients} icon={Radio} />
          <StatPill label="Uptime" value={`${summary.uptimeHours}h`} icon={Clock} />
          {usage && (
            <StatPill label="Total Cost" value={`$${usage.totalCost?.toFixed(4) || "0"}`} icon={DollarSign} />
          )}
          {usage && (
            <StatPill label="Total Tokens" value={(usage.totalTokens || 0).toLocaleString()} icon={TrendingUp} />
          )}
        </div>
      )}

      {/* Activity Feed */}
      <div className="rounded-xl border border-gray-800/60 bg-gray-900/30 backdrop-blur-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-cyan-500 drop-shadow-[0_0_4px_rgba(6,182,212,0.5)]" />
            <span className="text-xs font-semibold tracking-wider text-gray-400 uppercase font-mono">Activity Feed</span>
          </div>
          <button onClick={() => setEvents([])}
            className="text-[10px] text-gray-600 hover:text-gray-400 transition font-mono tracking-wide">
            CLEAR
          </button>
        </div>
        <div ref={feedRef} className="max-h-72 overflow-y-auto">
          {events.length === 0 ? (
            <div className="text-gray-700 text-xs py-12 text-center font-mono">
              Awaiting events...
            </div>
          ) : (
            events.map((ev, i) => (
              <div key={i}
                className="flex items-center gap-2.5 px-4 py-1.5 border-b border-gray-800/30 hover:bg-cyan-950/10 transition-colors">
                <div className="shrink-0">{eventIcons[ev.type] || <Activity size={12} className="text-gray-600" />}</div>
                <div className="flex-1 text-xs text-gray-400 truncate font-mono">{ev.text}</div>
                <div className="text-[9px] text-gray-700 shrink-0 font-mono tabular-nums">
                  {new Date(ev.ts).toLocaleTimeString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
