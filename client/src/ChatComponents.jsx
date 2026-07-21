import React, { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { useWebSocket } from './useWebSocket';
import { usePolling } from './usePolling';
import {
 ChevronDown, ChevronRight, Terminal, Cpu, Bot, User, Play, Square,
 Code, Eye, FileText, Clock, X, Edit3, Save, Lock, Unlock, Trash2,
 Sparkles, Zap, Activity, Network, Layers, BookOpen, Search, RefreshCw,
 ChevronLeft, AlertTriangle, CheckCircle2, XCircle, Loader2, Pause, Resume
} from 'lucide-react';

const NEON = { cyan:'#00f0ff', magenta:'#ff00ff', blue:'#3b82f6', purple:'#a855f7', green:'#22c55e', yellow:'#eab308', red:'#ef4444', pink:'#ec4899', orange:'#f97316', teal:'#14b8a6' };
const BG = { base:'#050510', card:'#0a0a1e', surface:'#0d0d22' };

// ═══════════════════════════════════════════════════════════════════
// 1. TERMINAL ACCORDION — Collapsible Thought→Action→Observation logs
// ═══════════════════════════════════════════════════════════════════
export const TerminalAccordion = memo(function TerminalAccordion({ steps = [], title = 'Execution Log', defaultOpen = false }) {
 const [open, setOpen] = useState(defaultOpen);
 const currentStep = steps.length > 0 ? steps[steps.length - 1] : null;
 const statusColor = currentStep?.status === 'completed' ? NEON.green
  : currentStep?.status === 'failed' ? NEON.red
  : currentStep?.status === 'running' ? NEON.cyan : NEON.yellow;

 return (
 <div className="rounded-xl overflow-hidden my-2" style={{ background: BG.card, border: `1px solid ${statusColor}25` }}>
  {/* Header — always visible */}
  <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.02] transition-colors" style={{ borderBottom: open ? `1px solid ${statusColor}10` : 'none' }}>
  {open ? <ChevronDown size={13} style={{ color: statusColor }} /> : <ChevronRight size={13} style={{ color: '#555' }} />}
  <Terminal size={13} style={{ color: NEON.magenta, filter: `drop-shadow(0 0 3px ${NEON.magenta})` }} />
  <span className="text-xs font-bold tracking-wider uppercase" style={{ color: '#888' }}>{title}</span>
  <span className="ml-auto flex items-center gap-2">
  <span className="text-[10px] text-gray-600">{steps.length} steps</span>
  {currentStep?.status === 'running' && <Loader2 size={11} className="animate-spin" style={{ color: NEON.cyan }} />}
  {currentStep?.status === 'completed' && <CheckCircle2 size={11} style={{ color: NEON.green }} />}
  {currentStep?.status === 'failed' && <XCircle size={11} style={{ color: NEON.red }} />}
  </span>
  </button>

  {/* Collapsed summary line */}
  {!open && currentStep && (
  <div className="px-3 py-1.5 flex items-center gap-2">
  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: statusColor, boxShadow: `0 0 4px ${statusColor}` }} />
  <span className="text-[11px] font-mono truncate" style={{ color: '#999' }}>
  {currentStep.status === 'running' ? `[Executing: ${currentStep.action}]` : `${currentStep.action} → ${currentStep.status}`}
  </span>
  </div>
  )}

  {/* Expanded — full log */}
  {open && (
  <div className="max-h-64 overflow-y-auto p-2 space-y-1" style={{ scrollbarWidth: 'thin', scrollbarColor: `${NEON.magenta}22 transparent` }}>
  {steps.map((step, i) => {
  const sColor = step.status === 'completed' ? NEON.green : step.status === 'failed' ? NEON.red : step.status === 'running' ? NEON.cyan : NEON.yellow;
  return (
  <div key={i} className="rounded-lg px-2.5 py-1.5" style={{ background: `${sColor}05`, borderLeft: `2px solid ${sColor}40` }}>
  <div className="flex items-center gap-2 mb-1">
  <span className="text-[10px] font-mono" style={{ color: '#555' }}>#{i + 1}</span>
  <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: sColor }}>{step.type || 'step'}</span>
  <span className="flex-1 text-[11px] text-gray-300 truncate">{step.action}</span>
  {step.duration && <span className="text-[9px] text-gray-600">{step.duration}ms</span>}
  </div>
  {step.observation && (
  <pre className="text-[10px] font-mono text-gray-500 whitespace-pre-wrap mt-1 pl-4 border-l border-gray-800" style={{ maxHeight: 80, overflow: 'auto' }}>{step.observation}</pre>
  )}
  </div>
  );
  })}
  {steps.length === 0 && <div className="text-[11px] text-gray-600 text-center py-3">No execution steps yet</div>}
  </div>
  )}
 </div>
 );
});

// ═══════════════════════════════════════════════════════════════════
// 2. SUB-AGENT NODE MATRIX — Mini graph for spawned children
// ═══════════════════════════════════════════════════════════════════
export const SubAgentMatrix = memo(function SubAgentMatrix({ agents = [], parentLabel = 'Parent' }) {
 const statusColors = { idle: '#444', processing: NEON.cyan, completed: NEON.green, failed: NEON.red };

 return (
 <div className="rounded-xl p-3 my-2" style={{ background: BG.card, border: `1px solid ${NEON.blue}20` }}>
  <div className="flex items-center gap-2 mb-3">
  <Network size={13} style={{ color: NEON.blue, filter: `drop-shadow(0 0 3px ${NEON.blue})` }} />
  <span className="text-xs font-bold tracking-wider uppercase" style={{ color: '#888' }}>Agent Matrix</span>
  <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: `${NEON.blue}10`, color: NEON.blue, border: `1px solid ${NEON.blue}25` }}>{agents.length} workers</span>
  </div>
  <div className="flex flex-wrap gap-2">
  {/* Parent node */}
  <div className="flex flex-col items-center gap-1 p-2 rounded-lg" style={{ background: `${NEON.magenta}10`, border: `1px solid ${NEON.magenta}30`, minWidth: 60 }}>
  <Bot size={14} style={{ color: NEON.magenta, filter: `drop-shadow(0 0 4px ${NEON.magenta})` }} />
  <span className="text-[9px] font-bold text-gray-300 truncate max-w-[60px]">{parentLabel}</span>
  </div>
  {/* Connector */}
  {agents.length > 0 && <div className="flex items-center px-1"><div style={{ width: 12, height: 1, background: `${NEON.blue}30` }} /></div>}
  {/* Child nodes */}
  {agents.map((agent, i) => {
  const color = statusColors[agent.status] || '#444';
  return (
  <div key={i} className="flex flex-col items-center gap-1 p-2 rounded-lg transition-all hover:scale-105" style={{ background: `${color}08`, border: `1px solid ${color}25`, minWidth: 50 }}>
  <div className="relative">
  <Cpu size={12} style={{ color }} />
  {agent.status === 'processing' && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: NEON.cyan }} />}
  </div>
  <span className="text-[9px] text-gray-400 truncate max-w-[50px]">{agent.name || `Worker ${i+1}`}</span>
  <span className="text-[8px] uppercase font-mono" style={{ color }}>{agent.status}</span>
  </div>
  );
  })}
  </div>
 </div>
 );
});

// ═══════════════════════════════════════════════════════════════════
// 3. CODE SANDBOX BLOCK — Editable code with Run/Console/Render tabs
// ═══════════════════════════════════════════════════════════════════
export const CodeSandboxBlock = memo(function CodeSandboxBlock({ initialCode = '', language = 'javascript', title = '' }) {
 const [code, setCode] = useState(initialCode);
 const [tab, setTab] = useState('code'); // code | console | render
 const [output, setOutput] = useState(null);
 const [running, setRunning] = useState(false);
 const textareaRef = useRef();

 const runCode = useCallback(async () => {
  setRunning(true);
  setTab('console');
  try {
  const result = await api('/api/sandbox/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, language }),
  });
  setOutput(result);
  } catch (e) {
  setOutput({ exitCode: 1, stdout: '', stderr: e.message });
  }
  setRunning(false);
 }, [code, language]);

 const tabs = [
  { id: 'code', icon: Code, label: 'Code' },
  { id: 'console', icon: Terminal, label: 'Console' },
  ...(language === 'javascript' || language === 'html' ? [{ id: 'render', icon: Eye, label: 'Render' }] : []),
 ];

 return (
 <div className="rounded-xl overflow-hidden my-2" style={{ background: BG.card, border: `1px solid ${NEON.orange}20` }}>
  {/* Title bar */}
  <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${NEON.orange}10` }}>
  <Code size={13} style={{ color: NEON.orange, filter: `drop-shadow(0 0 3px ${NEON.orange})` }} />
  <span className="text-xs font-bold tracking-wider uppercase" style={{ color: '#888' }}>{title || `${language} Sandbox`}</span>
  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: `${NEON.orange}10`, color: NEON.orange, border: `1px solid ${NEON.orange}20` }}>{language}</span>
  <div className="flex-1" />
  {/* Tabs */}
  <div className="flex gap-1">
  {tabs.map(t => (
  <button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-all" style={{ background: tab === t.id ? `${NEON.orange}15` : 'transparent', color: tab === t.id ? NEON.orange : '#555', border: `1px solid ${tab === t.id ? NEON.orange + '30' : 'transparent'}` }}>
  <t.icon size={9} /> {t.label}
  </button>
  ))}
  </div>
  <button onClick={runCode} disabled={running} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all hover:brightness-125" style={{ background: `${NEON.green}12`, border: `1px solid ${NEON.green}30`, color: NEON.green }}>
  {running ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />} {running ? 'Running' : 'Run'}
  </button>
  </div>

  {/* Code editor */}
  {tab === 'code' && (
  <textarea ref={textareaRef} value={code} onChange={e => setCode(e.target.value)} className="w-full p-3 font-mono text-xs text-gray-200 bg-transparent outline-none resize-none" style={{ minHeight: 120, tabSize: 2, lineHeight: 1.6 }} spellCheck={false} />
  )}

  {/* Console output */}
  {tab === 'console' && (
  <div className="p-3 font-mono text-xs space-y-1" style={{ minHeight: 80 }}>
  {output === null ? (
  <div className="text-gray-600 flex items-center gap-2"><Terminal size={12} /> Run code to see output</div>
  ) : (
  <>
  {output.exitCode === 0 ? <CheckCircle2 size={12} style={{ color: NEON.green }} /> : <XCircle size={12} style={{ color: NEON.red }} />}
  <span className="text-[10px]" style={{ color: output.exitCode === 0 ? NEON.green : NEON.red }}>Exit: {output.exitCode}</span>
  {output.stdout && <pre className="text-gray-300 whitespace-pre-wrap mt-1">{output.stdout}</pre>}
  {output.stderr && <pre className="text-red-400 whitespace-pre-wrap mt-1">{output.stderr}</pre>}
  </>
  )}
  </div>
  )}

  {/* Render preview (HTML) */}
  {tab === 'render' && (
  <iframe srcDoc={language === 'html' ? code : code} className="w-full bg-white" style={{ minHeight: 120, border: 'none' }} sandbox="allow-scripts" title="render" />
  )}
 </div>
 );
});

// ═══════════════════════════════════════════════════════════════════
// 4. STATE VIEWER — Tabbed MEMORY.md/PERSONA.md with live WS + FAB edit
// ═══════════════════════════════════════════════════════════════════
export const StateViewer = memo(function StateViewer() {
 const [files, setFiles] = useState([]);
 const [activeTab, setActiveTab] = useState(0);
 const [editing, setEditing] = useState(false);
 const [editContent, setEditContent] = useState('');
 const [saving, setSaving] = useState(false);
 const { lastMsg } = useWebSocket();

 const load = useCallback(() => {
  api('/api/state').then(setFiles).catch(() => {});
 }, []);

 usePolling(load, 30000);

 // WS: state file updated
 useEffect(() => {
  if (lastMsg && lastMsg.type === 'state_update') load();
 }, [lastMsg, load]);

 const activeFile = files[activeTab];

 const startEdit = () => { setEditContent(activeFile?.content || ''); setEditing(true); };
 const saveEdit = async () => {
  if (!activeFile) return;
  setSaving(true);
  try {
  await api(`/api/state/${activeFile.name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: editContent }) });
  setEditing(false);
  load();
  } catch {}
  setSaving(false);
 };

 return (
 <div className="rounded-xl overflow-hidden" style={{ background: BG.card, border: '1px solid rgba(0,240,255,0.12)' }}>
  {/* Tabs */}
  <div className="flex items-center gap-0" style={{ borderBottom: '1px solid rgba(0,240,255,0.08)' }}>
  {files.map((f, i) => (
  <button key={f.name} onClick={() => { setActiveTab(i); setEditing(false); }} className="px-3 py-2 text-[10px] font-bold tracking-wider uppercase transition-all" style={{
  background: activeTab === i ? `${NEON.cyan}10` : 'transparent',
  color: activeTab === i ? NEON.cyan : '#555',
  borderBottom: activeTab === i ? `2px solid ${NEON.cyan}` : '2px solid transparent',
  }}>
  {f.name.replace('.md', '')}
  {f.size > 0 && <span className="ml-1 text-[8px]" style={{ color: '#444' }}>{(f.size / 1024).toFixed(1)}k</span>}
  </button>
  ))}
  <div className="flex-1" />
  {/* FAB edit button */}
  {activeFile && !editing && (
  <button onClick={startEdit} className="m-1 p-1.5 rounded-lg transition-all hover:brightness-125" style={{ background: `${NEON.cyan}10`, border: `1px solid ${NEON.cyan}25`, color: NEON.cyan }}>
  <Edit3 size={11} />
  </button>
  )}
  </div>

  {/* Content */}
  <div className="p-3" style={{ minHeight: 120, maxHeight: 300, overflow: 'auto', scrollbarWidth: 'thin', scrollbarColor: `${NEON.cyan}22 transparent` }}>
  {editing ? (
  <div className="space-y-2">
  <textarea value={editContent} onChange={e => setEditContent(e.target.value)} className="w-full font-mono text-[11px] text-gray-200 bg-black/30 p-2 rounded-lg outline-none resize-none border border-cyan-900/30" style={{ minHeight: 150, lineHeight: 1.6 }} spellCheck={false} />
  <div className="flex gap-2 justify-end">
  <button onClick={() => setEditing(false)} className="px-3 py-1 rounded text-[10px] text-gray-500 hover:text-gray-300 transition-colors">Cancel</button>
  <button onClick={saveEdit} disabled={saving} className="flex items-center gap-1 px-3 py-1 rounded-lg text-[10px] font-bold transition-all hover:brightness-125" style={{ background: `${NEON.green}12`, border: `1px solid ${NEON.green}30`, color: NEON.green }}>
  {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />} Save
  </button>
  </div>
  </div>
  ) : activeFile ? (
  <pre className="text-[11px] text-gray-400 whitespace-pre-wrap font-mono leading-relaxed">{activeFile.content || '<empty>'}</pre>
  ) : (
  <div className="text-[11px] text-gray-600 text-center py-4">Loading state files...</div>
  )}
  </div>
 </div>
 );
});

// ═══════════════════════════════════════════════════════════════════
// 5. FTS EXPLORER BREADCRUMBS — Context injection timeline at chat top
// ═══════════════════════════════════════════════════════════════════
export const FTSBreadcrumbs = memo(function FTSBreadcrumbs({ conversationId }) {
 const [injections, setInjections] = useState([]);

 useEffect(() => {
  if (!conversationId) return;
  api(`/api/context/injections?conversation_id=${conversationId}`).then(setInjections).catch(() => setInjections([]));
 }, [conversationId]);

 if (injections.length === 0) return null;

 const totalTokens = injections.reduce((sum, inj) => sum + (inj.tokens || 0), 0);

 return (
 <div className="rounded-xl px-3 py-2 mb-2" style={{ background: `${BG.card}`, border: `1px solid ${NEON.purple}15` }}>
  <div className="flex items-center gap-2 mb-1.5">
  <BookOpen size={11} style={{ color: NEON.purple, filter: `drop-shadow(0 0 3px ${NEON.purple})` }} />
  <span className="text-[10px] font-bold tracking-wider uppercase" style={{ color: '#666' }}>Context Window</span>
  <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: `${NEON.purple}10`, color: NEON.purple, border: `1px solid ${NEON.purple}20` }}>{totalTokens.toLocaleString()} tokens</span>
  </div>
  <div className="flex items-center gap-1 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
  {injections.map((inj, i) => (
  <React.Fragment key={inj.id}>
  {i > 0 && <ChevronRight size={9} style={{ color: '#333', flexShrink: 0 }} />}
  <div className="flex items-center gap-1 px-2 py-1 rounded-lg shrink-0 transition-all hover:brightness-125 cursor-default" style={{
  background: inj.type === 'user_input' ? `${NEON.green}06` : `${NEON.cyan}06`,
  border: `1px solid ${inj.type === 'user_input' ? NEON.green + '15' : NEON.cyan + '15'}`,
  }} title={inj.summary}>
  {inj.type === 'user_input' ? <User size={8} style={{ color: NEON.green }} /> : <Bot size={8} style={{ color: NEON.cyan }} />}
  <span className="text-[9px] text-gray-400 truncate max-w-[80px]">{inj.summary.slice(0, 30)}</span>
  <span className="text-[8px] text-gray-600">{inj.tokens}</span>
  </div>
  </React.Fragment>
  ))}
  </div>
 </div>
 );
});

// ═══════════════════════════════════════════════════════════════════
// 6. PROFILE CARD EVOLUTION WIDGET — Per-line dismiss/lock preferences
// ═══════════════════════════════════════════════════════════════════
export const ProfileCard = memo(function ProfileCard() {
 const [profile, setProfile] = useState(null);

 const load = useCallback(() => {
  api('/api/profile').then(setProfile).catch(() => {});
 }, []);

 useEffect(() => { load(); }, [load]);

 const dismiss = async (key) => {
  await api(`/api/profile/${key}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss' }) });
  load();
 };

 const toggleLock = async (key, value) => {
  await api(`/api/profile/${key}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set', value }) });
  load();
 };

 if (!profile) return null;

 return (
 <div className="rounded-xl p-3" style={{ background: BG.card, border: `1px solid ${NEON.pink}20` }}>
  <div className="flex items-center gap-2 mb-3">
  <User size={14} style={{ color: NEON.pink, filter: `drop-shadow(0 0 4px ${NEON.pink})` }} />
  <span className="text-xs font-bold tracking-wider uppercase" style={{ color: '#888' }}>User Profile</span>
  <span className="text-[9px] text-gray-600">{profile.preferences.length} attributes</span>
  </div>
  <div className="space-y-1">
  {profile.preferences.map((pref, i) => {
  const isLocked = pref.locked;
  const color = isLocked ? NEON.yellow : NEON.cyan;
  return (
  <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-lg group transition-colors hover:bg-white/[0.02]" style={{ borderLeft: `2px solid ${color}40` }}>
  <span className="text-[10px] font-mono font-bold uppercase" style={{ color }}>{pref.key}</span>
  <span className="text-[10px] text-gray-500">→</span>
  <span className="flex-1 text-[11px] text-gray-300 truncate">{String(pref.value)}</span>
  {/* Per-line actions */}
  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
  {isLocked ? (
  <Lock size={9} style={{ color: NEON.yellow }} title="Locked" />
  ) : (
  <>
  <button onClick={() => toggleLock(pref.key, pref.value)} className="p-0.5 rounded hover:bg-white/5" title="Lock">
  <Unlock size={9} style={{ color: '#555' }} />
  </button>
  <button onClick={() => dismiss(pref.key)} className="p-0.5 rounded hover:bg-red-500/10 hover:text-red-400" title="Dismiss">
  <X size={9} style={{ color: '#555' }} />
  </button>
  </>
  )}
  </div>
  </div>
  );
  })}
  </div>
 </div>
 );
});
