import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface User {
  id: string;
  username: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("cf_token"));
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (token) {
      fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then(setUser)
        .catch(() => {
          localStorage.removeItem("cf_token");
          setToken(null);
        });
    }
  }, []);

  async function login(username: string, password: string) {
    setIsLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        cache: "no-store",
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Login failed");
      }
      const data = await r.json();
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem("cf_token", data.token);
    } finally {
      setIsLoading(false);
    }
  }

  async function register(username: string, password: string) {
    setIsLoading(true);
    try {
      const r = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        cache: "no-store",
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Registration failed");
      }
      const data = await r.json();
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem("cf_token", data.token);
    } finally {
      setIsLoading(false);
    }
  }

  function logout() {
    setUser(null);
    setToken(null);
    localStorage.removeItem("cf_token");
  }

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
