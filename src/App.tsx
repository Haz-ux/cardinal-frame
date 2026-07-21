import { BrowserRouter as Router, Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./components/AuthContext";
import CyberMascotCompanion from "./components/CyberMascotCompanion";
import Dashboard from "./pages/Dashboard";
import TasksPage from "./pages/TasksPage";
import AgentsPage from "./pages/AgentsPage";
import DagEditorPage from "./pages/DagEditorPage";
import WorkspacePage from "./pages/WorkspacePage";
import AimiLearnPage from "./pages/AimiLearnPage";
import LoginPage from "./pages/LoginPage";
import {
  LayoutDashboard, ListTodo, Bot, GitBranch, LogOut, Cpu,
  Workflow, Radio, Monitor, GitCompare, MessageSquare, Settings, Brain
} from "lucide-react";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/workspace", label: "Workspace", icon: Monitor },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/dags", label: "DAGs", icon: GitBranch },
  { to: "/learn", label: "Aimi Learn", icon: Brain },
];

function CyberNav() {
  const { user, logout } = useAuth();
  const location = useLocation();

  return (
    <nav className="relative flex items-center gap-1 px-4 py-2 bg-gray-950/95 border-b border-cyan-500/20 backdrop-blur-sm z-50"
      style={{ boxShadow: "0 2px 20px rgba(6, 182, 212, 0.08)" }}>
      {/* Neon accent line */}
      <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />

      {/* Logo */}
      <div className="flex items-center gap-2 mr-6">
        <Cpu size={20} className="text-cyan-400 drop-shadow-[0_0_6px_rgba(6,182,212,0.6)]" />
        <span className="text-sm font-bold tracking-wider text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-400">
          CARDINAL FRAME
        </span>
      </div>

      {/* Nav links */}
      {navItems.map(({ to, label, icon: Icon }) => {
        const active = location.pathname.startsWith(to);
        return (
          <NavLink key={to} to={to}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all duration-200 ${
              active
                ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 shadow-[0_0_10px_rgba(6,182,212,0.15)]"
                : "text-gray-500 hover:text-gray-300 border border-transparent hover:border-gray-800"
            }`}>
            <Icon size={14} className={active ? "drop-shadow-[0_0_4px_rgba(6,182,212,0.5)]" : ""} />
            {label}
          </NavLink>
        );
      })}

      <div className="flex-1" />

      {/* User badge */}
      {user && (
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-gray-600 tracking-wide">@{user.username}</span>
          <button onClick={logout}
            className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-red-400 transition-colors">
            <LogOut size={12} /> EXIT
          </button>
        </div>
      )}
    </nav>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppShell() {
  const { token } = useAuth();
  const location = useLocation();
  const currentTab = location.pathname.slice(1) || "dashboard";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 relative">
      {/* Scanline overlay */}
      <div className="pointer-events-none fixed inset-0 z-[100] opacity-[0.03]"
        style={{
          backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,255,0.03) 2px, rgba(0,255,255,0.03) 4px)",
          backgroundSize: "100% 4px",
        }}
      />

      <CyberNav />

      <Routes>
        <Route path="/login" element={token ? <Navigate to="/dashboard" replace /> : <LoginPage />} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/workspace" element={<ProtectedRoute><WorkspacePage /></ProtectedRoute>} />
        <Route path="/tasks" element={<ProtectedRoute><TasksPage /></ProtectedRoute>} />
        <Route path="/agents" element={<ProtectedRoute><AgentsPage /></ProtectedRoute>} />
        <Route path="/dags" element={<ProtectedRoute><DagEditorPage /></ProtectedRoute>} />
        <Route path="/learn" element={<ProtectedRoute><AimiLearnPage /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Aimi — floating cyber mascot companion */}
      {token && <CyberMascotCompanion currentTab={currentTab} nodesCount={0} />}
    </div>
  );
}

function App() {
  return (
    <Router>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </Router>
  );
}

export default App;
