import { useEffect, useState } from "react";

const API = "/api/agents";

interface Agent {
  id: string;
  name: string;
  status: string;
}

export default function AgentList({ refreshKey }: { refreshKey?: number }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(API)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setAgents)
      .catch((err) => setError(err.message));
  }, [refreshKey]);

  if (error) return <p className="text-red-400 text-sm">Error: {error}</p>;
  if (!agents.length) return <p className="text-gray-500 text-sm">No agents registered.</p>;

  return (
    <ul className="space-y-2">
      {agents.map((a) => (
        <li key={a.id} className="p-3 border rounded bg-gray-900 text-gray-100 flex justify-between items-center">
          <div>
            <span className="font-medium">{a.name}</span>
            <span className="ml-2 text-xs text-gray-500">{a.status}</span>
          </div>
          <span className="text-xs text-gray-600 font-mono">{a.id.slice(0, 8)}…</span>
        </li>
      ))}
    </ul>
  );
}
