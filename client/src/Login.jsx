import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { LogIn, UserPlus, Plus, ArrowLeft, X, KeyRound, Eye, EyeOff } from 'lucide-react';

const SAVED_USERS_KEY = 'cf_saved_users';

function getSavedUsers() {
  try { return JSON.parse(localStorage.getItem(SAVED_USERS_KEY) || '[]'); } catch { return []; }
}

function saveUser(username) {
  const users = getSavedUsers();
  if (!users.includes(username)) {
    users.unshift(username);
    localStorage.setItem(SAVED_USERS_KEY, JSON.stringify(users.slice(0, 5)));
  }
}

function removeSavedUser(username) {
  const users = getSavedUsers().filter(u => u !== username);
  localStorage.setItem(SAVED_USERS_KEY, JSON.stringify(users));
}

const AVATAR_COLORS = [
  'from-blue-500 to-cyan-400',
  'from-purple-500 to-pink-400',
  'from-green-500 to-emerald-400',
  'from-orange-500 to-amber-400',
  'from-red-500 to-rose-400',
  'from-teal-500 to-sky-400',
  'from-indigo-500 to-violet-400',
];

function avatarColor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatarInitial(username) {
  return username.charAt(0).toUpperCase();
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error || `Request failed: ${res.status}`); }
  return res.json();
}

export default function Login() {
  const { login, register } = useAuth();
  const savedUsers = getSavedUsers();

  // Phases: 'select' | 'password' | 'login' | 'register' | 'reset' | 'reset-confirm'
  const [phase, setPhase] = useState(savedUsers.length > 0 ? 'select' : 'login');
  const [selectedUser, setSelectedUser] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0); // seconds until retry allowed
 const [showPwd, setShowPwd] = useState(false);

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleRateLimit = (err) => {
    // Parse retry-after from error message or default to 60s
    const match = err.message?.match(/(\d+)\s*(?:minute|second)/i);
    const secs = match ? (match[1] * (err.message.includes('minute') ? 60 : 1)) : 60;
    setCooldown(secs);
    setError(`Too many attempts. Try again in ${secs}s.`);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
      await login(selectedUser || username, password);
      saveUser(selectedUser || username);
    } catch (err) {
      if (err.message?.includes('Too many')) handleRateLimit(err);
      else setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
      await register(username, password);
      saveUser(username);
    } catch (err) {
    if (err.message?.includes('Too many')) handleRateLimit(err);
    else setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleResetRequest = async (e) => {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
      const res = await api('/api/auth/reset-request', { method: 'POST', body: JSON.stringify({ username }) });
      setSuccess(res.message);
      setPhase('reset-confirm');
    } catch (err) {
    if (err.message?.includes('Too many')) handleRateLimit(err);
    else setError(err.message || 'Reset request failed');
    } finally {
    setLoading(false);
    }
    };

    const handleResetConfirm = async (e) => {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
    const res = await api('/api/auth/reset-confirm', { method: 'POST', body: JSON.stringify({ token: resetToken, password: newPassword }) });
    // Auto-login after reset
    saveUser(res.user.username);
    login(res.user.username, newPassword).catch(() => {
    setSuccess('Password reset! You can now sign in.');
    setPhase('login');
    });
    } catch (err) {
    if (err.message?.includes('Too many')) handleRateLimit(err);
    else setError(err.message || 'Reset failed');
    } finally {
    setLoading(false);
    }
  };

  const selectUser = (u) => {
    setSelectedUser(u);
    setPhase('password');
    setError(''); setSuccess(''); setPassword('');
  };

  const goBack = () => {
    const users = getSavedUsers();
    setPhase(users.length > 0 ? 'select' : 'login');
    setSelectedUser(null); setUsername(''); setPassword('');
    setError(''); setSuccess(''); setResetToken(''); setNewPassword(''); setCooldown(0);
  };

  const handleRemoveUser = (e, u) => {
    e.stopPropagation();
    removeSavedUser(u);
    if (getSavedUsers().length === 0) setPhase('login');
  };

  // ═══ SELECT USER (Ubuntu grid) ═══
  if (phase === 'select') {
    const users = getSavedUsers();
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
        <h1 className="text-3xl font-bold text-white mb-2">Cardinal Frame</h1>
        <p className="text-gray-400 mb-10 text-sm">Select an account</p>

        {error && <div className="bg-red-900/50 text-red-300 text-sm p-3 rounded-lg mb-6 max-w-xs w-full">{error}</div>}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8 max-w-md">
          {users.map(u => (
            <button key={u} onClick={() => selectUser(u)}
              className="group relative flex flex-col items-center gap-3 p-5 rounded-xl bg-gray-900 border border-gray-800 hover:border-blue-500/50 hover:bg-gray-800/80 transition">
              <span onClick={(e) => handleRemoveUser(e, u)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition text-gray-500 hover:text-red-400">
                <X size={14} />
              </span>
              <div className={`w-16 h-16 rounded-full bg-gradient-to-br ${avatarColor(u)} flex items-center justify-center text-white text-2xl font-bold shadow-lg`}>
                {avatarInitial(u)}
              </div>
              <span className="text-gray-200 text-sm font-medium truncate max-w-[100px]">{u}</span>
            </button>
          ))}
          <button onClick={() => { setPhase('register'); setUsername(''); setPassword(''); setError(''); setSuccess(''); }}
            className="flex flex-col items-center gap-3 p-5 rounded-xl bg-gray-900/50 border-2 border-dashed border-gray-700 hover:border-blue-500/50 hover:bg-gray-800/40 transition">
            <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center text-gray-500"><Plus size={28} /></div>
            <span className="text-gray-400 text-sm">Add Account</span>
          </button>
        </div>

        <button onClick={() => { setPhase('login'); setUsername(''); setPassword(''); setError(''); setSuccess(''); }}
          className="text-gray-500 hover:text-gray-300 text-sm transition">
          Sign in with a different account
        </button>
      </div>
    );
  }

  // ═══ PASSWORD (clicked saved user) ═══
  if (phase === 'password' && selectedUser) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
        <button onClick={goBack} className="absolute top-6 left-6 text-gray-400 hover:text-white transition flex items-center gap-2 text-sm">
          <ArrowLeft size={18} /> Back
        </button>

        <div className={`w-24 h-24 rounded-full bg-gradient-to-br ${avatarColor(selectedUser)} flex items-center justify-center text-white text-4xl font-bold shadow-xl mb-4`}>
          {avatarInitial(selectedUser)}
        </div>
        <h2 className="text-xl font-semibold text-white mb-1">{selectedUser}</h2>
        <p className="text-gray-400 text-sm mb-6">Enter your password</p>

        {error && <div className="bg-red-900/50 text-red-300 text-sm p-3 rounded-lg mb-4 max-w-xs w-full">{error}</div>}

        <form onSubmit={handleLogin} className="w-full max-w-xs space-y-4">
          <div className="relative w-full">
          <input type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
          className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white text-center focus:outline-none focus:border-blue-500 placeholder-gray-500 pr-11"
          placeholder="Password" required minLength={6} autoFocus autoComplete="current-password" />
          <button type="button" onClick={() => setShowPwd(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition">
          {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          </div>
          <button type="submit" disabled={loading || cooldown > 0}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white font-semibold rounded-lg flex items-center justify-center gap-2 transition">
            {cooldown > 0 ? <span>🔒 Wait {cooldown}s</span> : loading ? <span className="animate-pulse">Signing in...</span> : <><LogIn size={18} /> Sign In</>}
          </button>
        </form>

        <button onClick={() => { setUsername(selectedUser); setPhase('reset'); setError(''); setSuccess(''); }}
          className="mt-4 text-gray-500 hover:text-amber-400 text-sm transition flex items-center gap-1">
          <KeyRound size={14} /> Forgot password?
        </button>
      </div>
    );
  }

  // ═══ LOGIN (manual) ═══
  if (phase === 'login') {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
        {savedUsers.length > 0 && (
          <button onClick={goBack} className="absolute top-6 left-6 text-gray-400 hover:text-white transition flex items-center gap-2 text-sm">
            <ArrowLeft size={18} /> Back
          </button>
        )}

        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center text-white shadow-xl mb-4">
          <LogIn size={32} />
        </div>
        <h2 className="text-xl font-semibold text-white mb-1">Sign In</h2>
        <p className="text-gray-400 text-sm mb-6">Enter your credentials</p>

        {error && <div className="bg-red-900/50 text-red-300 text-sm p-3 rounded-lg mb-4 max-w-xs w-full">{error}</div>}

        <form onSubmit={handleLogin} className="w-full max-w-xs space-y-4">
          <div>
            <label className="block text-gray-300 text-sm mb-1">Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)}
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
              required autoComplete="username" autoFocus />
          </div>
          <div>
          <label className="block text-gray-300 text-sm mb-1">Password</label>
          <div className="relative">
          <input type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
          className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500 pr-11"
          required minLength={6} autoComplete="current-password" />
          <button type="button" onClick={() => setShowPwd(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition">
          {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          </div>
          </div>
          <button type="submit" disabled={loading || cooldown > 0}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white font-semibold rounded-lg flex items-center justify-center gap-2 transition">
            {cooldown > 0 ? <span>🔒 Wait {cooldown}s</span> : loading ? <span className="animate-pulse">Signing in...</span> : <><LogIn size={18} /> Sign In</>}
          </button>
        </form>

        <button onClick={() => { setPhase('reset'); setError(''); setSuccess(''); }}
          className="mt-3 text-gray-500 hover:text-amber-400 text-sm transition flex items-center gap-1">
          <KeyRound size={14} /> Forgot password?
        </button>
        <button onClick={() => { setPhase('register'); setUsername(''); setPassword(''); setError(''); setSuccess(''); }}
          className="mt-2 text-gray-400 hover:text-white text-sm transition">
          Don't have an account? Register
        </button>
      </div>
    );
  }

  // ═══ RESET REQUEST ═══
  if (phase === 'reset') {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
        <button onClick={goBack} className="absolute top-6 left-6 text-gray-400 hover:text-white transition flex items-center gap-2 text-sm">
          <ArrowLeft size={18} /> Back
        </button>

        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-500 to-orange-400 flex items-center justify-center text-white shadow-xl mb-4">
          <KeyRound size={32} />
        </div>
        <h2 className="text-xl font-semibold text-white mb-1">Reset Password</h2>
        <p className="text-gray-400 text-sm mb-6">A reset token will be printed to the server terminal</p>

        {error && <div className="bg-red-900/50 text-red-300 text-sm p-3 rounded-lg mb-4 max-w-xs w-full">{error}</div>}

        <form onSubmit={handleResetRequest} className="w-full max-w-xs space-y-4">
          <div>
            <label className="block text-gray-300 text-sm mb-1">Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)}
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-amber-500"
              required autoFocus autoComplete="username" />
          </div>
          <button type="submit" disabled={loading || cooldown > 0}
            className="w-full py-3 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-700 text-white font-semibold rounded-lg flex items-center justify-center gap-2 transition">
            {cooldown > 0 ? <span>🔒 Wait {cooldown}s</span> : loading ? <span className="animate-pulse">Requesting...</span> : <><KeyRound size={18} /> Get Reset Token</>}
          </button>
        </form>
      </div>
    );
  }

  // ═══ RESET CONFIRM (enter token + new password) ═══
  if (phase === 'reset-confirm') {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
        <button onClick={goBack} className="absolute top-6 left-6 text-gray-400 hover:text-white transition flex items-center gap-2 text-sm">
          <ArrowLeft size={18} /> Back
        </button>

        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-amber-500 to-orange-400 flex items-center justify-center text-white shadow-xl mb-4">
          <KeyRound size={32} />
        </div>
        <h2 className="text-xl font-semibold text-white mb-1">Enter Reset Token</h2>
        <p className="text-gray-400 text-sm mb-1">Check the server terminal for the token</p>
        <p className="text-amber-400/70 text-xs mb-6">Token expires in 10 minutes</p>

        {success && <div className="bg-green-900/50 text-green-300 text-sm p-3 rounded-lg mb-4 max-w-xs w-full">{success}</div>}
        {error && <div className="bg-red-900/50 text-red-300 text-sm p-3 rounded-lg mb-4 max-w-xs w-full">{error}</div>}

        <form onSubmit={handleResetConfirm} className="w-full max-w-xs space-y-4">
          <div>
            <label className="block text-gray-300 text-sm mb-1">Reset Token</label>
            <input type="text" value={resetToken} onChange={e => setResetToken(e.target.value)}
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-amber-500 placeholder-gray-600"
              placeholder="Paste token from server terminal" required autoFocus />
          </div>
          <div>
          <label className="block text-gray-300 text-sm mb-1">New Password</label>
          <div className="relative">
          <input type={showPwd ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)}
          className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-amber-500 pr-11"
          required minLength={6} autoComplete="new-password" />
          <button type="button" onClick={() => setShowPwd(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition">
          {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          </div>
          </div>
          <button type="submit" disabled={loading || cooldown > 0}
            className="w-full py-3 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-700 text-white font-semibold rounded-lg flex items-center justify-center gap-2 transition">
            {cooldown > 0 ? <span>🔒 Wait {cooldown}s</span> : loading ? <span className="animate-pulse">Resetting...</span> : <><KeyRound size={18} /> Reset & Sign In</>}
          </button>
        </form>
      </div>
    );
  }

  // ═══ REGISTER ═══
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
      {savedUsers.length > 0 && (
        <button onClick={goBack} className="absolute top-6 left-6 text-gray-400 hover:text-white transition flex items-center gap-2 text-sm">
          <ArrowLeft size={18} /> Back
        </button>
      )}

      <div className="w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-400 flex items-center justify-center text-white shadow-xl mb-4">
        <UserPlus size={32} />
      </div>
      <h2 className="text-xl font-semibold text-white mb-1">Create Account</h2>
      <p className="text-gray-400 text-sm mb-6">Set up a new profile</p>

      {error && <div className="bg-red-900/50 text-red-300 text-sm p-3 rounded-lg mb-4 max-w-xs w-full">{error}</div>}

      <form onSubmit={handleRegister} className="w-full max-w-xs space-y-4">
        <div>
          <label className="block text-gray-300 text-sm mb-1">Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500"
            required autoComplete="username" autoFocus />
        </div>
        <div>
        <label className="block text-gray-300 text-sm mb-1">Password</label>
        <div className="relative">
        <input type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
        className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-blue-500 pr-11"
        required minLength={6} autoComplete="new-password" />
        <button type="button" onClick={() => setShowPwd(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition">
        {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        </div>
        </div>
        <button type="submit" disabled={loading || cooldown > 0}
          className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 text-white font-semibold rounded-lg flex items-center justify-center gap-2 transition">
          {cooldown > 0 ? <span>🔒 Wait {cooldown}s</span> : loading ? <span className="animate-pulse">Creating...</span> : <><UserPlus size={18} /> Create & Sign In</>}
        </button>
      </form>

      <button onClick={() => { setPhase('login'); setUsername(''); setPassword(''); setError(''); setSuccess(''); }}
        className="mt-4 text-gray-400 hover:text-white text-sm transition">
        Already have an account? Sign In
      </button>
    </div>
  );
}
