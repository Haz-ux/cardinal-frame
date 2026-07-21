import { useState, useCallback } from "react";
import DAGBuilder from "../components/DAGBuilder";
import NPUMonitor from "../components/NPUMonitor";
import NetworkProfiler from "../components/NetworkProfiler";
import CodeExporter from "../components/CodeExporter";
import CoreConfigManager from "../components/CoreConfigManager";
import CronScheduler from "../components/CronScheduler";
import MessengerBridge from "../components/MessengerBridge";
import GitNexusWorkspace from "../components/GitNexusWorkspace";
import WorkspaceAiChat from "../components/WorkspaceAiChat";
import type { AgentNode, NodeEdge, OrchestratorConfig, NetworkTransportType, NPUTelemetry } from "../types";
import {
  Workflow, Cpu, Radio, Terminal, Settings, Clock,
  MessageSquare, Folder, Brain, Monitor, ChevronRight, Activity, Zap
} from "lucide-react";

type WorkspaceTab = "dag" | "npu" | "network" | "code" | "config" | "cron" | "messenger" | "gitnexus" | "aichat";

const tabs: { key: WorkspaceTab; label: string; icon: any; color: string }[] = [
  { key: "dag", label: "DAG Builder", icon: Workflow, color: "text-cyan-400" },
  { key: "npu", label: "NPU Monitor", icon: Cpu, color: "text-purple-400" },
  { key: "network", label: "Net Profiler", icon: Radio, color: "text-blue-400" },
  { key: "code", label: "Code Export", icon: Terminal, color: "text-green-400" },
  { key: "config", label: "Core Config", icon: Settings, color: "text-amber-400" },
  { key: "cron", label: "Cron Scheduler", icon: Clock, color: "text-pink-400" },
  { key: "messenger", label: "Messenger", icon: MessageSquare, color: "text-teal-400" },
  { key: "gitnexus", label: "GitNexus", icon: Folder, color: "text-orange-400" },
  { key: "aichat", label: "AI Chat", icon: Brain, color: "text-indigo-400" },
];

// ── Default orchestrator config ──
const defaultConfig: OrchestratorConfig = {
  networkTransport: "GoChannels",
  npuAllocatedVramGb: 8,
  concurrencyWorkers: 4,
  highThroughputMode: false,
  pinThreadsToGoRuntime: true,
};

// ── Default NPU telemetry ──
const defaultNpus: NPUTelemetry[] = [
  {
    id: "npu-1", name: "Apple Neural Engine", type: "Apple NE",
    status: "active", temperatureC: 42, clockMhz: 1090,
    sramUtilizationPercent: 67, vramUsedGb: 4.2, vramTotalGb: 8,
    executionQueueLength: 3, opThroughputTops: 11.0,
    activePowerWatts: 7.5, tokensPerSec: 42,
  },
  {
    id: "npu-2", name: "Qualcomm Hexagon", type: "Qualcomm",
    status: "idle", temperatureC: 38, clockMhz: 850,
    sramUtilizationPercent: 12, vramUsedGb: 0.8, vramTotalGb: 6,
    executionQueueLength: 0, opThroughputTops: 8.0,
    activePowerWatts: 2.1, tokensPerSec: 28,
  },
];

export default function WorkspacePage() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("dag");
  const [logs, setLogs] = useState<string[]>(["[SYS] Cardinal Frame Workspace initialized."]);
  const [nodes, setNodes] = useState<AgentNode[]>([]);
  const [edges, setEdges] = useState<NodeEdge[]>([]);
  const [config, setConfig] = useState<OrchestratorConfig>(defaultConfig);
  const [transport, setTransport] = useState<NetworkTransportType>("GoChannels");
  const [isSimulating, setIsSimulating] = useState(false);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-200), msg]);
  }, []);

  const handleAddNode = (n: AgentNode) => { setNodes((p) => [...p, n]); addLog(`[DAG] Node added: ${n.name}`); };
  const handleDeleteNode = (id: string) => { setNodes((p) => p.filter((n) => n.id !== id)); addLog(`[DAG] Node removed: ${id}`); };
  const handleUpdateNode = (n: AgentNode) => { setNodes((p) => p.map((x) => (x.id === n.id ? n : x))); };
  const handleAddEdge = (e: NodeEdge) => { setEdges((p) => [...p, e]); addLog(`[DAG] Edge: ${e.source} → ${e.target}`); };
  const handleDeleteEdge = (id: string) => { setEdges((p) => p.filter((e) => e.id !== id)); };

  const triggerSimulation = async (query: string): Promise<void> => {
    setIsSimulating(true);
    addLog(`[SIM] Dispatching: "${query}"`);
    await new Promise((r) => setTimeout(r, 1500));
    addLog(`[SIM] Pipeline complete — ${nodes.length} nodes processed.`);
    setIsSimulating(false);
  };

  return (
    <div className="flex h-[calc(100vh-52px)]">
      {/* ── Left sidebar: tab icons ── */}
      <div className="w-14 bg-gray-950/80 border-r border-gray-800/60 flex flex-col items-center py-3 gap-1 shrink-0">
        {tabs.map(({ key, label, icon: Icon, color }) => {
          const active = activeTab === key;
          return (
            <button key={key} onClick={() => setActiveTab(key)} title={label}
              className={`relative w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-200 group ${
                active
                  ? "bg-gray-800/80 border border-cyan-500/30 shadow-[0_0_10px_rgba(6,182,212,0.12)]"
                  : "hover:bg-gray-800/40 border border-transparent"
              }`}>
              <Icon size={16} className={`${active ? color : "text-gray-600"} transition-colors`} />
              {/* Tooltip */}
              <div className="absolute left-full ml-2 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-[10px] text-gray-300 whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                {label}
              </div>
              {/* Active indicator */}
              {active && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-5 rounded-r bg-cyan-500/60 shadow-[0_0_6px_rgba(6,182,212,0.4)]" />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Main content area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Tab header bar */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/40 bg-gray-950/60">
          {(() => {
            const t = tabs.find((t) => t.key === activeTab);
            if (!t) return null;
            const Icon = t.icon;
            return (
              <div className="flex items-center gap-2">
                <Icon size={14} className={t.color} />
                <span className="text-xs font-semibold tracking-wider text-gray-300 uppercase font-mono">{t.label}</span>
              </div>
            );
          })()}
          <div className="flex-1" />
          <div className="flex items-center gap-1.5 text-[9px] font-mono text-gray-600">
            <Activity size={10} className="text-green-500/60" />
            <span>{nodes.length} nodes</span>
            <span className="text-gray-800">•</span>
            <span>{edges.length} edges</span>
          </div>
        </div>

        {/* Panel content */}
        <div className="flex-1 overflow-auto">
          {activeTab === "dag" && (
            <DAGBuilder
              nodes={nodes} edges={edges}
              onAddNode={handleAddNode} onDeleteNode={handleDeleteNode}
              onAddEdge={handleAddEdge} onDeleteEdge={handleDeleteEdge}
              onUpdateNode={handleUpdateNode}
              isSimulating={isSimulating}
            />
          )}
          {activeTab === "npu" && (
            <NPUMonitor npus={defaultNpus} config={config} onUpdateConfig={setConfig} />
          )}
          {activeTab === "network" && (
            <NetworkProfiler currentTransport={transport} onChangeTransport={setTransport} />
          )}
          {activeTab === "code" && (
            <CodeExporter nodes={nodes} edges={edges} config={config} onUpdateConfig={setConfig} onAppendLogs={(l) => l.forEach(addLog)} />
          )}
          {activeTab === "config" && (
            <CoreConfigManager onAddLog={addLog} />
          )}
          {activeTab === "cron" && (
            <CronScheduler onTriggerSimulation={triggerSimulation} onAddLog={addLog} nodesCount={nodes.length} />
          )}
          {activeTab === "messenger" && (
            <MessengerBridge />
          )}
          {activeTab === "gitnexus" && (
            <GitNexusWorkspace onAddLog={addLog} />
          )}
          {activeTab === "aichat" && (
            <WorkspaceAiChat nodesCount={nodes.length} onAddLog={addLog} />
          )}
        </div>

        {/* ── Bottom log console ── */}
        <div className="h-28 border-t border-gray-800/60 bg-gray-950/80 flex flex-col shrink-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800/40">
            <Terminal size={11} className="text-green-500/60" />
            <span className="text-[9px] font-mono uppercase tracking-widest text-gray-600">Console</span>
            <div className="flex-1" />
            <button onClick={() => setLogs([])}
              className="text-[9px] text-gray-700 hover:text-gray-400 font-mono transition">CLEAR</button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-1">
            {logs.map((l, i) => (
              <div key={i} className="text-[10px] font-mono text-gray-500 leading-relaxed">{l}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
