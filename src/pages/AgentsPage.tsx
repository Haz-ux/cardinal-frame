import { useEffect, useState } from "react";
import { useAuth } from "../components/AuthContext";
import { Bot, Plus, Trash2, Radio, Activity, AlertCircle, Loader, Cpu } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  status: string;
  capabilities: string[];
  created_at: string;
}

export default function AgentsPage() {
  const { token } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCaps, setNewCaps] = useState("");

  function api(path: string, opts: RequestInit = {}) {
    return fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      cache: "no-store",
    });
  }

  const load = () => {
    api("/api/agents")
      .then((r) => (r.ok ? r.json() : []))
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  async function registerAgent() {
    if (!newName.trim()) return;
    setError(null);
    try {
      const caps = newCaps.split(",").map((c) => c.trim()).filter(Boolean);
      const r = await api("/api/agents", { method: "POST", body: JSON.stringify({ name: newName, capabilities: caps }) });
      if (!r.ok) throw new Error("Register failed");
      setNewName(""); setNewCaps("");
      setShowForm(false);
      load();
    } catch (e: any) { setError(e.message); }
  }

  async function deleteAgent(id: string) {
    setError(null);
    try {
      const r = await api(`/api/agents/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
      load();
    } catch (e: any) { setError(e.message); }
  }

  const statusGlow: Record<string, string> = {
    idle: "text-gray-500 border-gray-700",
    active: "text-green-400 border-green-500/30 shadow-[0_0_6px_rgba(16,185,129,0.1)]",
    busy: "text-amber-400 border-amber-500/30 shadow-[0_0_6px_rgba(245,158,11,0.1)]",
    offline: "text-red-400 border-red-500/30 shadow-[0_0_6px_rgba(239,68,68,0.1)]",
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Bot size={20} className="text-purple-400 drop-shadow-[0_0_6px_rgba(168,85,247,0.5)]" />
        <h1 className="text-xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400">
          Agents
        </h1>
        <div className="flex-1" />
        <button onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500/20 transition">
          <Plus size={14} /> Register Agent
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg bg-red-950/40 border border-red-500/30 text-red-400 text-xs">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* New agent form */}
      {showForm && (
        <div className="flex flex-col gap-2 mb-4 p-4 rounded-xl border border-purple-500/20 bg-gray-900/40 backdrop-blur-sm">
          <input value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="Agent name"
            className="px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500/50" />
          <input value={newCaps} onChange={(e) => setNewCaps(e.target.value)}
            placeholder="Capabilities (comma separated)"
            className="px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500/50" />
          <button onClick={registerAgent}
            className="self-end px-4 py-2 rounded-lg text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white transition">
            Register
          </button>
        </div>
      )}

      {/* Agent grid */}
      {loading ? (
        <div className="text-gray-600 text-sm py-12 text-center font-mono">
          <Loader size={16} className="inline animate-spin mr-2 text-purple-500/40" /> Loading agents...
        </div>
      ) : agents.length === 0 ? (
        <div className="text-gray-700 text-sm py-12 text-center font-mono border border-gray-800/40 rounded-xl">
          No agents registered yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {agents.map((a) => (
            <div key={a.id}
              className="group relative p-4 rounded-xl border border-gray-800/60 bg-gray-900/30 backdrop-blur-sm hover:border-purple-500/30 transition">
              {/* Status indicator */}
              <div className="absolute top-3 right-3">
                <div className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border ${statusGlow[a.status] || statusGlow.idle}`}>
                  {a.status}
                </div>
              </div>

              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/20 flex items-center justify-center">
                  <Cpu size={16} className="text-purple-400" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-200">{a.name}</div>
                  <div className="text-[10px] text-gray-600 font-mono">{a.id.slice(0, 8)}</div>
                </div>
              </div>

              {a.capabilities?.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {a.capabilities.map((c, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-gray-800/60 border border-gray-700/40 text-gray-500">
                      {c}
                    </span>
                  ))}
                </div>
              )}

              {/* Delete on hover */}
              <button onClick={() => deleteAgent(a.id)}
                className="absolute bottom-3 right-3 p-1.5 rounded text-red-400/40 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition" title="Delete">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
