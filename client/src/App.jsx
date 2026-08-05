import React, { Suspense, lazy, useState, useCallback, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router';
import { AuthProvider, useAuth } from './AuthContext';
import { prewarm } from './dataCache';
import Login from './Login';
import PageLoader from './PageLoader';
import BootScreen from './BootScreen';
import BigBangSplash from './BigBangSplash';
// Lazy-loaded pages — each becomes its own chunk
const Dashboard = lazy(() => import('./Dashboard'));
const Tasks = lazy(() => import('./Tasks'));
const Agents = lazy(() => import('./Agents'));
const AgentGroups = lazy(() => import('./AgentGroups'));
const DAGEditor = lazy(() => import('./DAGEditor'));
const ChainsPage = lazy(() => import('./Chains'));
const Users = lazy(() => import('./Users'));
const Files = lazy(() => import('./Files'));
const MCP = lazy(() => import('./MCP'));
const Schedules = lazy(() => import('./Schedules'));
const Plugins = lazy(() => import('./Plugins'));
const AuditLog = lazy(() => import('./AuditLog'));
const LLMProviders = lazy(() => import('./LLMProviders'));
const NeuralMapPage = lazy(() => import('./NeuralMap'));
const ChatPage = lazy(() => import('./Chat'));
const SkillsToolsPage = lazy(() => import('./SkillsTools'));
const AimiLearnPage = lazy(() => import('./AimiLearn'));
const SettingsPage = lazy(() => import('./Settings'));
const AutomationPage = lazy(() => import('./Automation'));
import { ToastProvider } from './ToastContext';
import { LayoutDashboard, ListTodo, Bot, GitBranch, Users as UsersIcon, HardDrive, Plug, Clock, Puzzle, LogOut, User, ShieldCheck, UsersRound, ScrollText, Loader, Sparkles, Menu, ChevronLeft, ChevronRight, X, Cpu, Network, MessageSquare, Wrench, Activity, Brain, Link2 } from 'lucide-react';
import AimiCanvasCompanion from './AimiCanvas';
import { NEON, BG, FONTS } from './theme';
import { PersonaProvider, usePersonas } from './PersonaContext';

function PublicRoute({ children }) {
 const { user, loading } = useAuth();
 if (loading) return <div className="min-h-screen flex items-center justify-center" style={{ background: BG.void }}><Loader size={24} className="animate-spin" style={{ color: NEON.green }} /></div>;
 if (user) return <Navigate to="/" replace />;
 return children;
}
function ProtectedRoute({ children }) {
 const { user, loading } = useAuth();
 const [bootPhase, setBootPhase] = useState('none'); // 'none' | 'galaxy' | 'boot'
 const bootChecked = React.useRef(false);

 useEffect(() => {
  if (!bootChecked.current && user) {
   bootChecked.current = true;
   prewarm(['/api/dashboard/summary', '/api/llm/models', '/api/llm/providers', '/api/graph', '/api/agents', '/api/tasks', '/api/tools', '/api/skills']);
   const justLoggedIn = sessionStorage.getItem('cf_just_logged_in');
   if (justLoggedIn) {
    sessionStorage.removeItem('cf_just_logged_in');
    // Boot sequence: galaxy "big bang" splash first, then the typed boot
    // splash, then the app. On narrow screens the galaxy is skipped (the
    // explosion needs room) and we fall straight to the boot splash.
    setBootPhase(window.innerWidth >= 480 ? 'galaxy' : 'boot');
   }
  }
 }, [user]);

 if (loading) return <div className="min-h-screen flex items-center justify-center" style={{ background: BG.void }}><Loader size={24} className="animate-spin" style={{ color: NEON.green }} /></div>;
 if (!user) return <Navigate to="/login" replace />;

 if (bootPhase === 'galaxy') {
  return <BigBangSplash onDone={() => setBootPhase('boot')} />;
 }

 if (bootPhase === 'boot') {
  return <BootScreen onDone={() => setBootPhase('none')} />;
 }

 return children;
}
function Layout() {
 const { user, logout } = useAuth();
 const navigate = useNavigate();
 const { companionName } = usePersonas();
 const [mobileOpen, setMobileOpen] = useState(false);
 const [desktopCollapsed, setDesktopCollapsed] = useState(false);
 const closeMobile = useCallback(() => setMobileOpen(false), []);
 const links = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', color: NEON.green },
  { to: '/chat', icon: MessageSquare, label: 'Chat', color: NEON.cyan },
  { to: '/tasks', icon: ListTodo, label: 'Tasks', color: NEON.green },
  { to: '/agents', icon: Bot, label: 'Agents', color: NEON.blue },
  { to: '/groups', icon: UsersRound, label: 'Groups', color: NEON.teal },
  { to: '/dags', icon: GitBranch, label: 'DAGs', color: NEON.purple },
  { to: '/chains', icon: Link2, label: 'Chains', color: NEON.cyan },
  { to: '/schedules', icon: Clock, label: 'Schedules', color: NEON.yellow },
  { to: '/automation', icon: Activity, label: 'Automation', color: NEON.green },
  { to: '/files', icon: HardDrive, label: 'Files', color: NEON.orange },
  { to: '/mcp', icon: Plug, label: 'MCP', color: NEON.magenta },
  { to: '/llm', icon: Cpu, label: 'LLM Models', color: NEON.cyan },
  { to: '/neural', icon: Network, label: 'Neural Map', color: NEON.magenta },
  { to: '/skills', icon: Wrench, label: 'Skills & Tools', color: NEON.orange },
  { to: '/learn', icon: Brain, label: `${companionName} Learn`, color: NEON.purple },
  { to: '/plugins', icon: Puzzle, label: 'Plugins', color: NEON.pink },
  { to: '/settings', icon: ShieldCheck, label: 'Settings', color: NEON.cyan },
  ...(user?.role === 'admin' ? [
   { to: '/audit', icon: ScrollText, label: 'Audit', color: '#888' },
   { to: '/users', icon: UsersIcon, label: 'Users', color: '#888' },
  ] : []),
 ];

 // ── Shared sidebar body ──
 const sidebarContent = (isMobile = false) => (
  <>
   {/* Brand / collapse toggle */}
   <div
    className="px-3 mb-6 flex items-center gap-2 cursor-pointer select-none"
    onClick={() => {
     if (isMobile) closeMobile();
     else setDesktopCollapsed(c => !c);
    }}
    title={isMobile ? 'Close menu' : desktopCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
   >
    {/* HUD diamond icon */}
    <div className="relative" style={{ flexShrink: 0 }}>
     <Sparkles size={18} style={{ color: NEON.green, filter: `drop-shadow(0 0 6px ${NEON.green})` }} />
    </div>
    <span
     className={`font-bold text-sm tracking-wider whitespace-nowrap overflow-hidden transition-all duration-300 font-hud ${isMobile ? '' : (desktopCollapsed ? 'md:w-0 md:opacity-0' : 'md:w-auto md:opacity-100')} w-auto opacity-100`}
     style={{
      background: `linear-gradient(135deg, ${NEON.green}, ${NEON.cyan})`,
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
     }}
    >
     CARDINAL FRAME
    </span>
    {isMobile ? (
     <X size={18} className="ml-auto" style={{ color: '#555', flexShrink: 0 }} />
    ) : (
     <span className="hidden md:flex ml-auto items-center">
      {desktopCollapsed
       ? <ChevronRight size={14} style={{ color: '#444' }} />
       : <ChevronLeft size={14} style={{ color: '#444' }} />}
     </span>
    )}
   </div>

   {/* HUD divider */}
   <div className="mx-3 mb-3" style={{ height: 1, background: `linear-gradient(90deg, transparent, ${NEON.green}20, transparent)` }} />

   {/* Nav links — HUD style with angular hover */}
   <div className="flex-1 space-y-0.5 px-2 overflow-y-auto">
    {links.map(l => (
     <NavLink key={l.to} to={l.to} end={l.to === '/'} onClick={isMobile ? closeMobile : undefined}
      className={({ isActive }) =>
       `flex items-center gap-3 px-3 py-2.5 transition-all text-sm group`
      }
      style={({ isActive }) => ({
       background: isActive ? `${l.color}10` : 'transparent',
       border: isActive ? `1px solid ${l.color}25` : '1px solid transparent',
       borderLeft: isActive ? `2px solid ${l.color}` : '2px solid transparent',
       color: isActive ? l.color : '#555',
       boxShadow: isActive ? `0 0 12px ${l.color}08, inset 0 0 12px ${l.color}04` : 'none',
       fontFamily: isActive ? FONTS.hud : FONTS.body,
      })}
     >
      {({ isActive }) => (
       <>
        <l.icon size={16} style={{
         color: isActive ? l.color : '#444',
         filter: isActive ? `drop-shadow(0 0 4px ${l.color})` : 'none',
         transition: 'all 0.2s',
         flexShrink: 0,
        }} />
        <span className={`whitespace-nowrap overflow-hidden transition-all duration-300 text-[13px] ${isMobile ? 'opacity-100 w-auto' : (desktopCollapsed ? 'md:w-0 md:opacity-0' : 'md:w-auto md:opacity-100')} opacity-100 w-auto`}>
         {l.label}
        </span>
       </>
      )}
     </NavLink>
    ))}
   </div>

   {/* HUD divider */}
   <div className="mx-3 mt-3" style={{ height: 1, background: `linear-gradient(90deg, transparent, ${NEON.green}15, transparent)` }} />

   {/* User section */}
   <div className="px-2 pt-3">
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs" style={{ color: '#555' }}>
     <User size={14} style={{ flexShrink: 0, color: NEON.cyan + '80' }} />
     <span className={`whitespace-nowrap overflow-hidden transition-all duration-300 font-code text-[11px] ${isMobile ? 'opacity-100 w-auto' : (desktopCollapsed ? 'md:w-0 md:opacity-0' : 'md:w-auto md:opacity-100')} opacity-100 w-auto truncate`}>
      {user?.username}
     </span>
     {user?.role === 'admin' && <ShieldCheck size={12} style={{ color: NEON.red, flexShrink: 0 }} />}
    </div>
    <button onClick={() => { logout(); if (isMobile) closeMobile(); }}
     className="flex items-center gap-2 px-3 py-2 text-sm w-full transition-all font-hud text-[12px]"
     style={{ color: '#555', border: '1px solid transparent' }}
     onMouseEnter={e => {
      e.currentTarget.style.color = NEON.red;
      e.currentTarget.style.background = 'rgba(255,0,64,0.06)';
      e.currentTarget.style.borderLeft = `2px solid ${NEON.red}`;
     }}
     onMouseLeave={e => {
      e.currentTarget.style.color = '#555';
      e.currentTarget.style.background = 'transparent';
      e.currentTarget.style.borderLeft = '2px solid transparent';
     }}
    >
     <LogOut size={14} style={{ flexShrink: 0 }} />
     <span className={`whitespace-nowrap overflow-hidden transition-all duration-300 ${isMobile ? 'opacity-100 w-auto' : (desktopCollapsed ? 'md:w-0 md:opacity-0' : 'md:w-auto md:opacity-100')} opacity-100 w-auto`}>
      Logout
     </span>
    </button>
   </div>
  </>
 );

 return (
  <div className="min-h-screen flex" style={{ background: BG.void }}>
   {/* ── Mobile backdrop overlay ──────────────────────────────── */}
   {mobileOpen && (
    <div
     className="fixed inset-0 z-30 md:hidden"
     style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
     onClick={closeMobile}
    />
   )}
   {/* ── Mobile drawer ────────── */}
   <nav
    className={`fixed inset-y-0 left-0 z-40 w-52 flex flex-col py-4 transform transition-transform duration-300 ease-in-out md:hidden ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
    style={{
     background: 'linear-gradient(180deg, rgba(10,10,15,0.98) 0%, rgba(5,5,10,0.99) 100%)',
     borderRight: `1px solid ${NEON.green}08`,
     boxShadow: `inset -1px 0 0 ${NEON.green}04, 2px 0 40px rgba(0,255,136,0.03)`,
    }}
   >
    {sidebarContent(true)}
   </nav>
   {/* ── Desktop sidebar (collapsible) ── */}
   <nav
    className={`hidden md:flex flex-col py-4 shrink-0 transition-all duration-300 ease-in-out ${desktopCollapsed ? 'w-16' : 'w-52'}`}
    style={{
     background: 'linear-gradient(180deg, rgba(10,10,15,0.98) 0%, rgba(5,5,10,0.99) 100%)',
     borderRight: `1px solid ${NEON.green}08`,
     boxShadow: `inset -1px 0 0 ${NEON.green}04, 2px 0 40px rgba(0,255,136,0.03)`,
    }}
   >
    {sidebarContent(false)}
   </nav>
   {/* ── Main content ─────────────────────────────────────────── */}
   <main className={`flex-1 flex flex-col overflow-auto hex-grid-bg`} style={{
    background: `radial-gradient(ellipse at 20% 0%, rgba(0,255,136,0.02) 0%, transparent 50%), radial-gradient(ellipse at 80% 100%, rgba(176,38,255,0.015) 0%, transparent 50%), ${BG.void}`,
    position: 'relative',
   }}>
    {/* Scanline overlay */}
    <div className="scanline-overlay" />
    {/* Mobile header bar */}
    <div className="flex items-center md:hidden px-4 py-3 shrink-0" style={{ borderBottom: `1px solid ${NEON.green}06` }}>
     <button
      onClick={() => setMobileOpen(true)}
      className="p-2 transition-all"
      style={{ color: NEON.green, border: `1px solid ${NEON.green}15` }}
      onMouseEnter={e => {
       e.currentTarget.style.background = `${NEON.green}08`;
       e.currentTarget.style.borderColor = `${NEON.green}30`;
      }}
      onMouseLeave={e => {
       e.currentTarget.style.background = 'transparent';
       e.currentTarget.style.borderColor = `${NEON.green}15`;
      }}
      aria-label="Open navigation menu"
     >
      <Menu size={20} />
     </button>
     <span className="ml-3 font-bold text-sm tracking-wider font-hud"
      style={{
       background: `linear-gradient(135deg, ${NEON.green}, ${NEON.cyan})`,
       WebkitBackgroundClip: 'text',
       WebkitTextFillColor: 'transparent',
      }}
     >
      CARDINAL FRAME
     </span>
    </div>
    {/* Scrollable page content */}
    <div className="flex-1 p-6 overflow-auto">
     <Suspense fallback={<PageLoader />}>
      <Routes>
       <Route path="/" element={<Dashboard />} />
       <Route path="/tasks" element={<Tasks />} />
       <Route path="/agents" element={<Agents />} />
       <Route path="/groups" element={<AgentGroups />} />
       <Route path="/dags" element={<DAGEditor />} />
       <Route path="/chains" element={<ChainsPage />} />
       <Route path="/schedules" element={<Schedules />} />
       <Route path="/automation" element={<AutomationPage />} />
       <Route path="/files" element={<Files />} />
       <Route path="/mcp" element={<MCP />} />
       <Route path="/llm" element={<LLMProviders />} />
       <Route path="/neural" element={<NeuralMapPage />} />
       <Route path="/chat" element={<ChatPage />} />
       <Route path="/skills" element={<SkillsToolsPage />} />
       <Route path="/learn" element={<AimiLearnPage />} />
       <Route path="/plugins" element={<Plugins />} />
       <Route path="/settings" element={<SettingsPage />} />
       <Route path="/audit" element={<AuditLog />} />
       <Route path="/users" element={<Users />} />
      </Routes>
     </Suspense>
    </div>
    {/* Aimi companion */}
    <AimiCanvasCompanion />
   </main>
  </div>
 );
}
export default function App() {
 return (
  <BrowserRouter>
   <AuthProvider>
    <ToastProvider>
     <PersonaProvider>
      <Routes>
       <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
       <Route path="/*" element={<ProtectedRoute><Layout /></ProtectedRoute>} />
      </Routes>
     </PersonaProvider>
    </ToastProvider>
   </AuthProvider>
  </BrowserRouter>
 );
}
