import { useAuth } from "../components/AuthContext";
import { useState, useEffect } from "react";
import { LogIn, UserPlus, Plus, ArrowLeft, X, KeyRound } from "lucide-react";

const SAVED_KEY = "cf_saved_users";

function avatarColor(name: string) {
  const colors = [
    "from-blue-500 to-cyan-400",
    "from-purple-500 to-pink-400",
    "from-emerald-500 to-teal-400",
    "from-orange-500 to-amber-400",
    "from-red-500 to-rose-400",
    "from-indigo-500 to-violet-400",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

type Phase = "select" | "login" | "password" | "register" | "reset-request" | "reset-confirm";

export default function LoginPage() {
  const { login, register, isLoading } = useAuth();
  const [phase, setPhase] = useState<Phase>("select");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [savedUsers, setSavedUsers] = useState<string[]>([]);

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
      setSavedUsers(s);
      if (s.length === 0) setPhase("login");
    } catch { setPhase("login"); }
  }, []);

  function saveUser(u: string) {
    try {
      const s = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
      if (!s.includes(u)) { s.unshift(u); localStorage.setItem(SAVED_KEY, JSON.stringify(s.slice(0, 5))); }
    } catch {}
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    try { await login(username, password); saveUser(username); } catch (err: any) { setError(err.message); }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    try { await register(username, password); saveUser(username); } catch (err: any) { setError(err.message); }
  }

  async function handleResetRequest(e: React.FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      const r = await fetch("/api/auth/reset-request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }), cache: "no-store",
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      setMsg("Token printed to server terminal. Paste it below.");
      setPhase("reset-confirm");
    } catch (err: any) { setError(err.message); }
  }

  async function handleResetConfirm(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    try {
      const r = await fetch("/api/auth/reset-confirm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken, newPassword }), cache: "no-store",
      });
      if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
      await login(username, newPassword); saveUser(username);
    } catch (err: any) { setError(err.message); }
  }

  function selectUser(u: string) { setUsername(u); setPhase("password"); }
  function goBack() { setError(null); setMsg(null); setPassword(""); setPhase("select"); }

  const btn = "w-full py-2.5 rounded-lg font-semibold text-sm transition flex items-center justify-center gap-2 disabled:opacity-50";

  // ── User-select grid (Ubuntu-style) ──
  if (phase === "select" && savedUsers.length > 0) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <h1 className="text-3xl font-bold text-white mb-2">Cardinal Frame</h1>
        <p className="text-gray-500 text-sm mb-8">Select an account</p>
        <div className="flex flex-wrap justify-center gap-8 mb-8 max-w-md">
          {savedUsers.map((u) => (
            <button key={u} onClick={() => selectUser(u)} className="flex flex-col items-center gap-2 group">
              <div className={`w-20 h-20 rounded-full bg-gradient-to-br ${avatarColor(u)} flex items-center justify-center text-2xl font-bold text-white shadow-lg group-hover:scale-110 transition`}>
                {u[0].toUpperCase()}
              </div>
              <span className="text-gray-300 text-sm group-hover:text-white transition">{u}</span>
            </button>
          ))}
          <button onClick={() => { setUsername(""); setPhase("register"); }}
            className="flex flex-col items-center gap-2 group">
            <div className="w-20 h-20 rounded-full border-2 border-dashed border-gray-600 flex items-center justify-center group-hover:border-blue-500 transition">
              <Plus size={28} className="text-gray-500 group-hover:text-blue-400 transition" />
            </div>
            <span className="text-gray-500 text-sm group-hover:text-white transition">Add</span>
          </button>
        </div>
        <button onClick={() => { setUsername(""); setPhase("login"); }}
          className="text-gray-500 text-xs hover:text-gray-300 transition">
          Sign in with a different account
        </button>
      </div>
    );
  }

  // ── Password entry (after selecting avatar) ──
  if (phase === "password") {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <button onClick={goBack} className="absolute top-6 left-6 text-gray-500 hover:text-white transition"><ArrowLeft size={24} /></button>
        <div className={`w-24 h-24 rounded-full bg-gradient-to-br ${avatarColor(username)} flex items-center justify-center text-3xl font-bold text-white shadow-xl mb-4`}>
          {username[0].toUpperCase()}
        </div>
        <h2 className="text-xl font-semibold text-white mb-1">{username}</h2>
        <form onSubmit={handleLogin} className="w-full max-w-xs space-y-3 mt-4">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-blue-500" required
            autoFocus />
          <button type="submit" disabled={isLoading}
            className={`${btn} bg-blue-600 hover:bg-blue-500 text-white`}>
            {isLoading ? <span className="animate-pulse">Signing in…</span> : <><LogIn size={18} /> Sign In</>}
          </button>
        </form>
        <button onClick={() => setPhase("reset-request")}
          className="text-gray-500 text-xs hover:text-blue-400 transition mt-4">
          Forgot password?
        </button>
      </div>
    );
  }

  // ── Manual login form ──
  if (phase === "login") {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <h1 className="text-2xl font-bold text-white mb-6">Sign In</h1>
        <form onSubmit={handleLogin} className="w-full max-w-xs space-y-3">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-blue-500" required autoFocus />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-blue-500" required />
          <button type="submit" disabled={isLoading}
            className={`${btn} bg-blue-600 hover:bg-blue-500 text-white`}>
            {isLoading ? <span className="animate-pulse">Signing in…</span> : <><LogIn size={18} /> Sign In</>}
          </button>
        </form>
        <p className="text-gray-500 text-xs mt-4">
          Don't have an account?{" "}
          <button onClick={() => { setError(null); setPhase("register"); }} className="text-blue-400 hover:underline">Register</button>
        </p>
        <button onClick={() => { setError(null); setPhase("reset-request"); }}
          className="text-gray-500 text-xs hover:text-blue-400 transition mt-2">Forgot password?</button>
      </div>
    );
  }

  // ── Register ──
  if (phase === "register") {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <button onClick={goBack} className="absolute top-6 left-6 text-gray-500 hover:text-white transition"><ArrowLeft size={24} /></button>
        <h1 className="text-2xl font-bold text-white mb-6">Create Account</h1>
        <form onSubmit={handleRegister} className="w-full max-w-xs space-y-3">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-emerald-500" required autoFocus />
          <input type="password" placeholder="Password (6+ chars)" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-emerald-500" required minLength={6} />
          <button type="submit" disabled={isLoading}
            className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`}>
            {isLoading ? <span className="animate-pulse">Creating…</span> : <><UserPlus size={18} /> Create & Sign In</>}
          </button>
        </form>
        <p className="text-gray-500 text-xs mt-4">
          Already have an account?{" "}
          <button onClick={() => { setError(null); setPhase("login"); }} className="text-blue-400 hover:underline">Sign In</button>
        </p>
      </div>
    );
  }

  // ── Reset request ──
  if (phase === "reset-request") {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <button onClick={goBack} className="absolute top-6 left-6 text-gray-500 hover:text-white transition"><ArrowLeft size={24} /></button>
        <KeyRound size={36} className="text-amber-400 mb-4" />
        <h1 className="text-2xl font-bold text-white mb-2">Reset Password</h1>
        <p className="text-gray-500 text-sm mb-6 text-center">Enter your username. A reset token will be printed to the server terminal.</p>
        <form onSubmit={handleResetRequest} className="w-full max-w-xs space-y-3">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-amber-500" required autoFocus />
          <button type="submit" disabled={isLoading}
            className={`${btn} bg-amber-600 hover:bg-amber-500 text-white`}>
            {isLoading ? <span className="animate-pulse">Requesting…</span> : <><KeyRound size={18} /> Get Reset Token</>}
          </button>
        </form>
      </div>
    );
  }

  // ── Reset confirm ──
  if (phase === "reset-confirm") {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
        <button onClick={goBack} className="absolute top-6 left-6 text-gray-500 hover:text-white transition"><ArrowLeft size={24} /></button>
        <KeyRound size={36} className="text-amber-400 mb-4" />
        <h1 className="text-xl font-bold text-white mb-2">Enter Reset Token</h1>
        {msg && <p className="text-green-400 text-sm mb-4 text-center">{msg}</p>}
        <p className="text-gray-500 text-xs mb-6">Check the server terminal for the token.</p>
        <form onSubmit={handleResetConfirm} className="w-full max-w-xs space-y-3">
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <input type="text" placeholder="Reset token from server terminal" value={resetToken} onChange={(e) => setResetToken(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm font-mono focus:outline-none focus:border-amber-500" required autoFocus />
          <input type="password" placeholder="New password (6+ chars)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 text-sm focus:outline-none focus:border-amber-500" required minLength={6} />
          <button type="submit" disabled={isLoading}
            className={`${btn} bg-amber-600 hover:bg-amber-500 text-white`}>
            {isLoading ? <span className="animate-pulse">Resetting…</span> : <><KeyRound size={18} /> Reset & Sign In</>}
          </button>
        </form>
      </div>
    );
  }

  return null;
}
