import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { usePolling } from './usePolling';
import {
 Clock, Play, Pause, Trash2, RefreshCw, ChevronDown, ChevronRight,
 Sparkles, Code, Zap, Activity, ToggleLeft, ToggleRight, AlertTriangle,
 CheckCircle2, XCircle, Loader2, Timer, History, Eye, EyeOff, Search
} from 'lucide-react';

const NEON = { cyan:'#00f0ff', magenta:'#ff00ff', blue:'#3b82f6', purple:'#a855f7', green:'#22c55e', yellow:'#eab308', red:'#ef4444', pink:'#ec4899', orange:'#f97316', teal:'#14b8a6' };
const BG = { base:'#050510', card:'#0a0a1e', surface:'#0d0d22' };

// ═══════════════════════════════════════════════════════════════════
// 7. BACKGROUND CRON LEDGER — Dashboard cards with goal/interval/history/toggle
// ═══════════════════════════════════════════════════════════════════
export const CronLedger = memo(function CronLedger() {
 const [schedules, setSchedules] = useState([]);
 const [search, setSearch] = useState('');

 const load = useCallback(() => {
  cachedFetch('/api/schedules').then(setSchedules).catch(() => {});
 }, []);

 usePolling(load, 30000);

 const toggleSchedule = async (sched) => {
  await api(`/api/schedules/${sched.id}/toggle`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' } });
  load();
 };

 const deleteSchedule = async (id) => {
  await api(`/api/schedules/${id}`, { method: 'DELETE' });
  load();
 };

 const filtered = useMemo(() => schedules.filter(s =>
  !search || (s.name || '').toLowerCase().includes(search.toLowerCase()) || (s.goal || '').toLowerCase().includes(search.toLowerCase())
 ), [schedules, search]);

 return (
 <div className="space-y-4">
  <div className="flex items-center justify-between flex-wrap gap-3">
  <div className="flex items-center gap-3">
  <Clock size={18} style={{ color: NEON.green, filter: `drop-shadow(0 0 5px ${NEON.green})` }} />
  <h2 className="text-lg font-bold" style={{ color: NEON.green, textShadow: `0 0 12px ${NEON.green}44` }}>Automation Ledger</h2>
  <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: `${NEON.green}10`, color: NEON.green, border: `1px solid ${NEON.green}25` }}>{schedules.length} jobs</span>
  </div>
  <div className="relative max-w-xs">
  <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter schedules..." className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.green}15` }} />
  </div>
  </div>

  {filtered.length === 0 ? (
  <div className="text-center py-8 text-gray-600"><Clock size={32} className="mx-auto mb-2 opacity-30" />No scheduled jobs. Create one to automate tasks.</div>
  ) : (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
  {filtered.map(sched => (
  <CronCard key={sched.id} schedule={sched} onToggle={toggleSchedule} onDelete={deleteSchedule} />
  ))}
  </div>
  )}
 </div>
 );
});

const CronCard = memo(function CronCard({ schedule, onToggle, onDelete }) {
 const [showHistory, setShowHistory] = useState(false);
 const enabled = schedule.enabled !== false;
 const color = enabled ? NEON.green : '#444';

 return (
 <div className="rounded-xl p-3.5 transition-all" style={{ background: `linear-gradient(135deg, rgba(10,10,20,0.9), rgba(34,197,94,0.02))`, border: `1px solid ${color}20` }}>
  {/* Header */}
  <div className="flex items-center justify-between mb-2">
  <div className="flex items-center gap-2">
  <span className="w-2 h-2 rounded-full" style={{ background: enabled ? NEON.green : '#444', boxShadow: enabled ? `0 0 6px ${NEON.green}` : 'none' }} />
  <span className="font-semibold text-sm text-gray-200">{schedule.name}</span>
  </div>
  <div className="flex items-center gap-1">
  <button onClick={() => onToggle(schedule)} title={enabled ? 'Pause' : 'Resume'}>
  {enabled ? <ToggleRight size={16} style={{ color: NEON.green }} /> : <ToggleLeft size={16} className="text-gray-500" />}
  </button>
  <button onClick={() => onDelete(schedule.id)} title="Delete" className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-white/5"><Trash2 size={11} /></button>
  </div>
  </div>

  {/* Goal translation */}
  {schedule.goal && (
  <div className="text-[11px] text-gray-400 mb-2 pl-4" style={{ borderLeft: `2px solid ${color}30` }}>{schedule.goal}</div>
  )}

  {/* Interval + metadata */}
  <div className="flex items-center gap-3 text-[10px] mb-2">
  <span className="flex items-center gap-1 px-1.5 py-0.5 rounded font-mono" style={{ background: `${NEON.blue}10`, color: NEON.blue, border: `1px solid ${NEON.blue}20` }}>
  <Timer size={9} /> {schedule.cron_expression || schedule.interval || 'on-demand'}
  </span>
  {schedule.last_run && (
  <span className="text-gray-600" title="Last run">Last: {new Date(schedule.last_run).toLocaleTimeString()}</span>
  )}
  </div>

  {/* History toggle */}
  <button onClick={() => setShowHistory(!showHistory)} className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-gray-400 transition-colors">
  {showHistory ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
  <History size={9} /> Execution history
  </button>
  {showHistory && (
  <div className="mt-2 space-y-1 pl-2" style={{ borderLeft: `1px solid ${color}15` }}>
  {(schedule.history || []).slice(0, 5).map((h, i) => (
  <div key={i} className="flex items-center gap-2 text-[10px]">
  {h.status === 'success' ? <CheckCircle2 size={9} style={{ color: NEON.green }} /> : h.status === 'failed' ? <XCircle size={9} style={{ color: NEON.red }} /> : <Loader2 size={9} className="animate-spin" style={{ color: NEON.cyan }} />}
  <span className="text-gray-500">{new Date(h.timestamp).toLocaleString()}</span>
  {h.duration && <span className="text-gray-600">{h.duration}ms</span>}
  </div>
  ))}
  {(!schedule.history || schedule.history.length === 0) && <div className="text-[10px] text-gray-700">No execution history</div>}
  </div>
  )}
 </div>
 );
});

// ═══════════════════════════════════════════════════════════════════
// 8. SKILL REGISTRY — AI-built tools with inline code inspector
// ═══════════════════════════════════════════════════════════════════
export const SkillRegistry = memo(function SkillRegistry() {
 const [skills, setSkills] = useState([]);
 const [expandedId, setExpandedId] = useState(null);

 const load = useCallback(() => {
  cachedFetch('/api/skills').then(setSkills).catch(() => {});
 }, []);

 usePolling(load, 30000);

 return (
 <div className="space-y-4">
  <div className="flex items-center gap-3">
  <Sparkles size={18} style={{ color: NEON.purple, filter: `drop-shadow(0 0 5px ${NEON.purple})` }} />
  <h2 className="text-lg font-bold" style={{ color: NEON.purple, textShadow: `0 0 12px ${NEON.purple}44` }}>Skill Registry</h2>
  <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: `${NEON.purple}10`, color: NEON.purple, border: `1px solid ${NEON.purple}25` }}>{skills.length} skills</span>
  </div>

  {skills.length === 0 ? (
  <div className="text-center py-8 text-gray-600"><Sparkles size={32} className="mx-auto mb-2 opacity-30" />No skills registered yet. The AI will build tools as it learns.</div>
  ) : (
  <div className="space-y-2">
  {skills.map(skill => (
  <SkillCard key={skill.id} skill={skill} expanded={expandedId === skill.id} onToggle={() => setExpandedId(expandedId === skill.id ? null : skill.id)} />
  ))}
  </div>
  )}
 </div>
 );
});

const SkillCard = memo(function SkillCard({ skill, expanded, onToggle }) {
 const [showCode, setShowCode] = useState(false);
 const color = NEON.purple;

 return (
 <div className="rounded-xl overflow-hidden transition-all" style={{ background: BG.card, border: `1px solid ${color}20` }}>
  <button onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.02] transition-colors">
  {expanded ? <ChevronDown size={12} style={{ color }} /> : <ChevronRight size={12} style={{ color: '#555' }} />}
  <Sparkles size={12} style={{ color, filter: `drop-shadow(0 0 3px ${color})` }} />
  <span className="text-sm font-semibold text-gray-200">{skill.name}</span>
  {skill.category && <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: `${color}08`, color: '#888', border: `1px solid ${color}15` }}>{skill.category}</span>}
  <div className="flex-1" />
  {skill.enabled !== false && <span className="w-1.5 h-1.5 rounded-full" style={{ background: NEON.green, boxShadow: `0 0 4px ${NEON.green}` }} />}
  <span className="text-[10px] text-gray-600">{skill.description?.slice(0, 50)}{(skill.description?.length || 0) > 50 ? '…' : ''}</span>
  </button>

  {expanded && (
  <div className="px-3 pb-3 space-y-2" style={{ borderTop: `1px solid ${color}08` }}>
  {/* Description */}
  <div className="pt-2 text-xs text-gray-400 leading-relaxed">{skill.description || 'No description'}</div>

  {/* Metadata */}
  <div className="flex flex-wrap gap-2 text-[10px]">
  {skill.trigger && <span className="px-1.5 py-0.5 rounded" style={{ background: `${NEON.yellow}08`, color: NEON.yellow, border: `1px solid ${NEON.yellow}15` }}>Trigger: {skill.trigger}</span>}
  {skill.tool_type && <span className="px-1.5 py-0.5 rounded" style={{ background: `${NEON.blue}08`, color: NEON.blue, border: `1px solid ${NEON.blue}15` }}>Type: {skill.tool_type}</span>}
  </div>

  {/* Code inspector toggle */}
  <button onClick={() => setShowCode(!showCode)} className="flex items-center gap-1 text-[10px] transition-colors" style={{ color: showCode ? NEON.cyan : '#555' }}>
  {showCode ? <EyeOff size={10} /> : <Eye size={10} />}
  {showCode ? 'Hide' : 'Inspect'} definition
  </button>

  {showCode && (
  <pre className="text-[10px] font-mono text-gray-400 bg-black/30 p-2.5 rounded-lg overflow-auto whitespace-pre-wrap leading-relaxed" style={{ maxHeight: 200, scrollbarWidth: 'thin', border: `1px solid ${NEON.cyan}10` }}>
  {skill.schema ? JSON.stringify(skill.schema, null, 2) : skill.content || skill.definition || '// No definition available'}
  </pre>
  )}
  </div>
  )}
 </div>
 );
});
