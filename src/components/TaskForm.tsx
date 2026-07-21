import { useState, type FormEvent } from "react";

const API = "/api/tasks";

export default function TaskForm({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
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
      body: JSON.stringify({ name, command }),
      });
      if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || `HTTP ${res.status}`);
      }
      setName("");
      setCommand("");
      onCreated?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 border rounded bg-gray-900 text-gray-100">
      <h3 className="text-lg font-semibold">New Task</h3>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <input
        className="w-full p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
        placeholder="Task name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <input
        className="w-full p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
        placeholder="Command"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        required
      />
      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded font-medium disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create Task"}
      </button>
    </form>
  );
}
