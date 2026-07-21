import { useEffect, useState } from "react";
import { useAuth } from "../components/AuthContext";
import { ListTodo, Plus, Play, Pause, Trash2, Clock, Bot, AlertCircle, Loader } from "lucide-react";

interface Task {
  id: string;
  name: string;
  status: string;
  agent_id: string | null;
  created_at: string;
}

export default function TasksPage() {
  const { token } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");

  function api(path: string, opts: RequestInit = {}) {
    return fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      cache: "no-store",
    });
  }

  const load = () => {
    api("/api/tasks")
      .then((r) => (r.ok ? r.json() : []))
      .then(setTasks)
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  async function createTask() {
    if (!newName.trim()) return;
    setError(null);
    try {
      const r = await api("/api/tasks", { method: "POST", body: JSON.stringify({ name: newName }) });
      if (!r.ok) throw new Error("Create failed");
      setNewName("");
      setShowForm(false);
      load();
    } catch (e: any) { setError(e.message); }
  }

  async function updateStatus(id: string, status: string) {
    setError(null);
    try {
      const r = await api(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify({ status }) });
      if (!r.ok) throw new Error("Update failed");
      load();
    } catch (e: any) { setError(e.message); }
  }

  async function deleteTask(id: string) {
    setError(null);
    try {
      const r = await api(`/api/tasks/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Delete failed");
      load();
    } catch (e: any) { setError(e.message); }
  }

  const statusGlow: Record<string, string> = {
    pending: "text-gray-500 border-gray-700",
    queued: "text-blue-400 border-blue-500/30 shadow-[0_0_6px_rgba(59,130,246,0.1)]",
    running: "text-amber-400 border-amber-500/30 shadow-[0_0_6px_rgba(245,158,11,0.1)]",
    completed: "text-green-400 border-green-500/30 shadow-[0_0_6px_rgba(16,185,129,0.1)]",
    failed: "text-red-400 border-red-500/30 shadow-[0_0_6px_rgba(239,68,68,0.1)]",
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <ListTodo size={20} className="text-cyan-400 drop-shadow-[0_0_6px_rgba(6,182,212,0.5)]" />
        <h1 className="text-xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-400">
          Tasks
        </h1>
        <div className="flex-1" />
        <button onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 transition">
          <Plus size={14} /> New Task
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg bg-red-950/40 border border-red-500/30 text-red-400 text-xs">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* New task form */}
      {showForm && (
        <div className="flex gap-2 mb-4 p-4 rounded-xl border border-cyan-500/20 bg-gray-900/40 backdrop-blur-sm">
          <input value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="Task name"
            className="flex-1 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-cyan-500/50"
            onKeyDown={(e) => e.key === "Enter" && createTask()} />
          <button onClick={createTask}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white transition">
            Create
          </button>
        </div>
      )}

      {/* Task list */}
      {loading ? (
        <div className="text-gray-600 text-sm py-12 text-center font-mono">
          <Loader size={16} className="inline animate-spin mr-2 text-cyan-500/40" /> Loading tasks...
        </div>
      ) : tasks.length === 0 ? (
        <div className="text-gray-700 text-sm py-12 text-center font-mono border border-gray-800/40 rounded-xl">
          No tasks yet. Create one to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <div key={t.id}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-gray-800/60 bg-gray-900/30 backdrop-blur-sm hover:border-gray-700/60 transition group">
              <div className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-mono uppercase tracking-wider border ${statusGlow[t.status] || statusGlow.pending}`}>
                {t.status}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-200 truncate">{t.name}</div>
                <div className="text-[10px] text-gray-600 font-mono mt-0.5">{t.id.slice(0, 8)}</div>
              </div>
              {t.agent_id && (
                <div className="flex items-center gap-1 text-[10px] text-purple-400/60 font-mono">
                  <Bot size={10} /> {t.agent_id.slice(0, 8)}
                </div>
              )}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                {t.status === "pending" && (
                  <button onClick={() => updateStatus(t.id, "running")}
                    className="p-1.5 rounded text-amber-400 hover:bg-amber-500/10 transition" title="Run">
                    <Play size={12} />
                  </button>
                )}
                {t.status === "running" && (
                  <button onClick={() => updateStatus(t.id, "completed")}
                    className="p-1.5 rounded text-green-400 hover:bg-green-500/10 transition" title="Complete">
                    <Pause size={12} />
                  </button>
                )}
                <button onClick={() => deleteTask(t.id)}
                  className="p-1.5 rounded text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition" title="Delete">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
