import { useState, type FormEvent } from "react";

const API = "/api/agents";

export default function AgentForm({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const token = localStorage.getItem("cf_token");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(API, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, version }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setName("");
      setVersion("1.0");
      onCreated?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 border rounded bg-gray-900 text-gray-100">
      <h3 className="text-lg font-semibold">Register Agent</h3>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <input
        className="w-full p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-green-500"
        placeholder="Agent name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <input
        className="w-full p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-green-500"
        placeholder="Version"
        value={version}
        onChange={(e) => setVersion(e.target.value)}
      />
      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded font-medium disabled:opacity-50"
      >
        {submitting ? "Registering…" : "Register Agent"}
      </button>
    </form>
  );
}
