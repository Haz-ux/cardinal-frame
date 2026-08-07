import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('cf_token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      localStorage.setItem('cf_token', token);
      api('/api/auth/me').then(u => {
        setUser(u);
        setLoading(false);
      }).catch(() => {
        // Token invalid — clear it
        localStorage.removeItem('cf_token');
        setToken(null);
        setUser(null);
        setLoading(false);
      });
    } else {
      localStorage.removeItem('cf_token');
      setUser(null);
      setLoading(false);
    }
  }, [token]);

  const login = async (username, password) => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    localStorage.setItem('cf_token', res.token);
    sessionStorage.setItem('cf_just_logged_in', '1'); // signal for boot screen
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
    localStorage.setItem('cf_token', res.token);
    sessionStorage.setItem('cf_just_logged_in', '1'); // signal for boot screen
    setToken(res.token);
    setUser(res.user);
    saveUser(username);
    return res;
  };

  const logout = () => {
    localStorage.removeItem('cf_token');
    setToken(null);
    setUser(null);
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

export async function api(path, opts = {}) {
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
