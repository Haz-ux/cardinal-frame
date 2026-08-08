import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

// Endpoints that must never be wrapped in the auto-refresh retry loop.
const REFRESH_EXEMPT = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
]);

// Deduplicate concurrent refresh calls (e.g. several 401s firing at once).
let refreshPromise = null;

async function refreshAuth() {
  const refreshToken = localStorage.getItem('cf_refresh_token');
  if (!refreshToken) return false;
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          cache: 'no-store',
        });
        if (!res.ok) throw new Error('refresh failed');
        const data = await res.json();
        localStorage.setItem('cf_token', data.token);
        localStorage.setItem('cf_refresh_token', data.refreshToken);
        return true;
      } catch {
        localStorage.removeItem('cf_token');
        localStorage.removeItem('cf_refresh_token');
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

function clearTokens() {
  localStorage.removeItem('cf_token');
  localStorage.removeItem('cf_refresh_token');
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('cf_token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      api('/api/auth/me').then(u => {
        setUser(u);
        setLoading(false);
      }).catch(() => {
        clearTokens();
        setToken(null);
        setUser(null);
        setLoading(false);
      });
    } else {
      clearTokens();
      setUser(null);
      setLoading(false);
    }
  }, [token]);

  const storeSession = (res) => {
    if (res.token) localStorage.setItem('cf_token', res.token);
    if (res.refreshToken) localStorage.setItem('cf_refresh_token', res.refreshToken);
    sessionStorage.setItem('cf_just_logged_in', '1'); // signal for boot screen
  };

  const login = async (username, password) => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    storeSession(res);
    setToken(res.token);
    setUser(res.user);
    saveUser(username);
    return res;
  };

  const register = async (username, password) => {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    storeSession(res);
    setToken(res.token);
    setUser(res.user);
    saveUser(username);
    return res;
  };

  const logout = async () => {
    const refreshToken = localStorage.getItem('cf_refresh_token');
    try {
      if (refreshToken) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
          cache: 'no-store',
        }).catch(() => {});
      }
    } finally {
      clearTokens();
      setToken(null);
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}

export async function api(path, opts = {}, _retried = false) {
  const token = localStorage.getItem('cf_token');
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // The phone's connection to the dev sandbox can stall on a wedged pooled
  // socket; a longer timeout plus one retry gives a fresh connection a chance.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(path, { ...opts, headers, cache: 'no-store', signal: controller.signal });

      // Expired access token → refresh once, then replay the request.
      if (res.status === 401 && !REFRESH_EXEMPT.has(path) && !_retried) {
        const refreshed = await refreshAuth();
        if (refreshed) return api(path, opts, true);
        throw new Error('Session expired — please log in again');
      }

      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Request failed: ${res.status}`);
      }
      return res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        lastErr = new Error('Request timed out — check the server connection and try again');
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function saveUser(username) {
  try {
    const saved = JSON.parse(localStorage.getItem('cf_saved_users') || '[]');
    if (!saved.includes(username)) {
      saved.unshift(username);
      localStorage.setItem('cf_saved_users', JSON.stringify(saved.slice(0, 5)));
    }
  } catch {}
}
