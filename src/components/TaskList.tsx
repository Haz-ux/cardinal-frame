import { useEffect, useState, useCallback } from "react";
import { useTaskStatusWS } from "../components/useWebSocket";

const API = "/api/tasks";

interface Task {
  id: string;
  name: string;
  command?: string;
  status: string;
  result?: string | null;
  exit_code?: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
}

const statusColor: Record<string, string> = {
  pending: "text-gray-400",
  running: "text-yellow-400 animate-pulse",
  done: "text-green-400",
  failed: "text-red-400",
};

const statusBg: Record<string, string> = {
  pending: "bg-gray-800",
  running: "bg-gray-800 border-yellow-600",
  done: "bg-gray-800 border-green-900",
  failed: "bg-gray-800 border-red-900",
};

export default function TaskList({ refreshKey }: { refreshKey?: number }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState<string | null>(null);
  const { taskUpdates, connected: wsConnected } = useTaskStatusWS();

  const load = useCallback(() => {
    fetch(API)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setTasks)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [refreshKey, load]);

  // Apply WS updates to local task list
  useEffect(() => {
    if (Object.keys(taskUpdates).length === 0) return;
    setTasks((prev) =>
      prev.map((t) => {
        const update = taskUpdates[t.id];
        if (!update) return t;
        if (update.type === "task:deleted") return null;
        return { ...t, status: update.status || t.status, exitCode: update.exitCode ?? t.exitCode };
      }).filter(Boolean) as Task[]
    );
  }, [taskUpdates]);

  async function executeTask(id: string) {
    setExecuting(id);
    try {
      const token = localStorage.getItem("cf_token");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const r = await fetch(`${API}/${id}/execute`, { method: "PATCH", headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(null);
    }
  }

  if (error) return <p className="text-red-400 text-sm">Error: {error}</p>;
  if (!tasks.length) return <p className="text-gray-500 text-sm">No tasks yet.</p>;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-500">{tasks.length} tasks</span>
        {wsConnected && <span className="text-xs text-green-500">● WS live</span>}
      </div>
      <ul className="space-y-2">
        {tasks.map((t) => (
          <li
            key={t.id}
            className={`p-3 border rounded text-gray-100 flex justify-between items-center gap-3 ${statusBg[t.status] || "bg-gray-800"}`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{t.name}</span>
                <span className={`text-xs ${statusColor[t.status] || "text-gray-500"}`}>
                  {t.status}
                </span>
              </div>
              {t.command && <div className="text-xs text-gray-600 font-mono mt-0.5">{t.command}</div>}
              <div className="text-xs text-gray-600 mt-1">
                {t.exitCode !== null && t.exitCode !== undefined && <span>exit={t.exitCode} </span>}
                {t.startedAt && <span>started {new Date(t.startedAt).toLocaleTimeString()} </span>}
                {t.finishedAt && <span>→ {new Date(t.finishedAt).toLocaleTimeString()}</span>}
              </div>
              {t.result && (
                <div className="text-xs text-gray-400 font-mono mt-1 truncate max-w-md">
                  {t.result}
                </div>
              )}
            </div>
            {t.status === "pending" && (
              <button
                onClick={() => executeTask(t.id)}
                disabled={executing === t.id}
                className="px-3 py-1 text-xs bg-yellow-600 hover:bg-yellow-500 rounded font-medium disabled:opacity-50 whitespace-nowrap"
              >
                {executing === t.id ? "Starting…" : "▶ Run"}
              </button>
            )}
            <span className="text-xs text-gray-600">{new Date(t.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
