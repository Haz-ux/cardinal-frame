import { useState, useEffect } from "react";
import DAGBuilder from "../components/DAGBuilder";
import type { AgentNode, NodeEdge } from "../types";
import { GitBranch, Plus, Trash2, Play, Save, Loader } from "lucide-react";

const API = "/api/dags";

export default function DagEditorPage() {
  const [dags, setDags] = useState<any[]>([]);
  const [currentDag, setCurrentDag] = useState<any | null>(null);
  const [nodes, setNodes] = useState<AgentNode[]>([]);
  const [edges, setEdges] = useState<NodeEdge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  function authFetch(path: string, opts: RequestInit = {}) {
    const token = localStorage.getItem("cf_token");
    return fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
      cache: "no-store",
    });
  }

  const loadDags = () => {
    authFetch(API)
      .then((r) => r.json())
      .then(setDags)
      .catch((err) => setError(err.message));
  };

  useEffect(loadDags, []);

  async function createDag() {
    if (!newName) return;
    const r = await authFetch(API, { method: "POST", body: JSON.stringify({ name: newName, nodes, edges }) });
    const dag = await r.json();
    setCurrentDag(dag);
    setNewName("");
    loadDags();
  }

  async function saveDag() {
    if (!currentDag) return;
    const r = await authFetch(`${API}/${currentDag.id}`, { method: "PUT", body: JSON.stringify({ nodes, edges }) });
    const updated = await r.json();
    setCurrentDag(updated);
    loadDags();
  }

  async function loadDag(id: string) {
    const r = await authFetch(`${API}/${id}`);
    const dag = await r.json();
    setCurrentDag(dag);
    setNodes(dag.nodes || []);
    setEdges(dag.edges || []);
  }

  async function runDag() {
    if (!currentDag) return;
    const r = await authFetch(`${API}/${currentDag.id}/run`, { method: "POST" });
    const result = await r.json();
    if (r.ok) {
      setError(null);
      alert(`DAG started! Node order: ${result.nodeOrder?.join(" → ")}`);
    } else {
      setError(result.error);
    }
  }

  async function deleteDag(id: string) {
    await authFetch(`${API}/${id}`, { method: "DELETE" });
    if (currentDag?.id === id) {
      setCurrentDag(null);
      setNodes([]);
      setEdges([]);
    }
    loadDags();
  }

  const handleAddNode = (node: AgentNode) => setNodes((prev) => [...prev, node]);
  const handleDeleteNode = (id: string) => setNodes((prev) => prev.filter((n) => n.id !== id));
  const handleAddEdge = (edge: NodeEdge) => setEdges((prev) => [...prev, edge]);
  const handleDeleteEdge = (id: string) => setEdges((prev) => prev.filter((e) => e.id !== id));
  const handleUpdateNode = (node: AgentNode) => setNodes((prev) => prev.map((n) => (n.id === node.id ? node : n)));

  const statusColor: Record<string, string> = {
    idle: "text-gray-500",
    running: "text-amber-400",
    completed: "text-green-400",
    failed: "text-red-400",
  };

  return (
    <div className="flex h-[calc(100vh-52px)]">
      {/* Left sidebar: DAG list */}
      <div className="w-60 border-r border-gray-800/60 bg-gray-950/80 p-4 overflow-y-auto flex-shrink-0">
        <div className="flex items-center gap-2 mb-4">
          <GitBranch size={16} className="text-cyan-400 drop-shadow-[0_0_4px_rgba(6,182,212,0.4)]" />
          <h2 className="text-sm font-bold tracking-wider text-gray-300 uppercase font-mono">DAGs</h2>
        </div>

        {error && <p className="text-red-400 text-[10px] mb-2 font-mono">{error}</p>}

        {/* Create DAG */}
        <div className="flex gap-1 mb-4">
          <input
            className="flex-1 px-2 py-1.5 text-xs rounded-lg bg-gray-800/60 border border-gray-700/60 focus:outline-none focus:border-cyan-500/50"
            placeholder="New DAG"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createDag()}
          />
          <button onClick={createDag}
            className="px-2 py-1.5 text-xs bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 rounded-lg transition">
            <Plus size={14} />
          </button>
        </div>

        {/* DAG list */}
        <ul className="space-y-1">
          {dags.map((d) => (
            <li key={d.id} className="flex items-center gap-1 group">
              <button
                onClick={() => loadDag(d.id)}
                className={`flex-1 text-left px-2 py-1.5 text-xs rounded-lg hover:bg-gray-800/60 truncate transition ${
                  currentDag?.id === d.id
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                    : "text-gray-400 border border-transparent"
                }`}
              >
                {d.name}
                <span className={`ml-1.5 text-[9px] font-mono ${statusColor[d.status] || "text-gray-600"}`}>
                  {d.nodeCount}n
                </span>
              </button>
              <button
                onClick={() => deleteDag(d.id)}
                className="opacity-0 group-hover:opacity-100 text-red-400/60 hover:text-red-400 text-xs px-1 transition"
              >
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Main canvas */}
      <div className="flex-1 flex flex-col min-w-0">
        {currentDag ? (
          <>
            <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800/40 bg-gray-950/60">
              <GitBranch size={14} className="text-cyan-400" />
              <h3 className="text-sm font-semibold text-gray-200">{currentDag.name}</h3>
              <span className={`text-[10px] font-mono uppercase ${statusColor[currentDag.status] || "text-gray-500"}`}>
                {currentDag.status}
              </span>
              <div className="ml-auto flex gap-2">
                <button onClick={saveDag}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 rounded-lg transition">
                  <Save size={12} /> Save
                </button>
                <button onClick={runDag}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 rounded-lg transition">
                  <Play size={12} /> Run
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <DAGBuilder
                nodes={nodes}
                edges={edges}
                onAddNode={handleAddNode}
                onDeleteNode={handleDeleteNode}
                onAddEdge={handleAddEdge}
                onDeleteEdge={handleDeleteEdge}
                onUpdateNode={handleUpdateNode}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-700 font-mono text-sm">
            Create or select a DAG to begin editing
          </div>
        )}
      </div>
    </div>
  );
}
