import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { usePolling } from './usePolling';
import { useWsResource } from './useWsResource';
import { ListTodo, Play, Pause, Trash2, RefreshCw, Search, Filter, ChevronDown, ChevronUp, CheckSquare, Square, XCircle, AlertCircle, Clock, Zap, Flag } from 'lucide-react';

const NEON = { cyan:'#00f0ff', green:'#22c55e', yellow:'#eab308', red:'#ef4444', blue:'#3b82f6', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6', magenta:'#ff00ff' };
const STATUS_COLORS = { pending: NEON.yellow, running: NEON.blue, completed: NEON.green, failed: NEON.red };
const PRIORITIES = ['low','medium','high','critical'];
const PRIORITY_COLORS = { low:'#666', medium:NEON.blue, high:NEON.orange, critical:NEON.red };

function getPriority(task) {
  const n = (task.name || '').toLowerCase();
  if (n.includes('critical') || n.includes('urgent')) return 'critical';
  if (n.includes('high') || n.includes('important')) return 'high';
  if (n.includes('medium')) return 'medium';
  const hash = (task.id || '').split('').reduce((a,c) => a + c.charCodeAt(0), 0);
  return PRIORITIES[hash % 4];
}

function CreateTaskModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [priority, setPriority] = useState('medium');
  const [loading, setLoading] = useState(false);
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !command.trim()) return;
    setLoading(true);
    try {
      const prefix = priority === 'critical' ? '[CRITICAL] ' : priority === 'high' ? '[HIGH] ' : '';
      await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${prefix}${name}`, command }) });
      onCreated(); onClose();
    } catch (err) { console.error(err); }
    setLoading(false);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.cyan}30` }} onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4" style={{ color: NEON.cyan }}>New Task</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div><label className="text-xs text-gray-400 mb-1 block">Task Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.cyan}20` }} placeholder="e.g. Process dataset" /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Command</label>
            <input value={command} onChange={e => setCommand(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none font-mono" style={{ border: `1px solid ${NEON.cyan}20` }} placeholder="e.g. python train.py" /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Priority</label>
            <div className="flex gap-2">{PRIORITIES.map(p => (
              <button key={p} type="button" onClick={() => setPriority(p)} className="flex-1 py-1.5 text-xs rounded-lg font-semibold transition-all"
                style={{ background: priority === p ? `${PRIORITY_COLORS[p]}20` : 'rgba(0,0,0,0.3)', border: `1px solid ${priority === p ? PRIORITY_COLORS[p] : 'transparent'}`, color: priority === p ? PRIORITY_COLORS[p] : '#666' }}>
                {p.charAt(0).toUpperCase() + p.slice(1)}</button>
            ))}</div></div>
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm bg-black/40 border border-gray-700 text-gray-400">Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.green}20`, border: `1px solid ${NEON.green}40`, color: NEON.green }}>{loading ? 'Creating...' : 'Create Task'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showCreate, setShowCreate] = useState(false);

  const load = () => api('/api/tasks').then(setTasks).catch(() => {});
  useWsResource(load, 'task:status', 10000);

  const filtered = tasks.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (search && !(t.name || '').toLowerCase().includes(search.toLowerCase()) && !(t.command || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const toggleSelect = (id) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelectedIds(selectedIds.size === filtered.length ? new Set() : new Set(filtered.map(t => t.id)));

  const bulkDelete = async () => { for (const id of selectedIds) await api(`/api/tasks/${id}`, { method: 'DELETE' }); setSelectedIds(new Set()); load(); };
  const retryTask = async (task) => { await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Retry: ${task.name}`, command: task.command }) }); load(); };
  const deleteTask = async (id) => { await api(`/api/tasks/${id}`, { method: 'DELETE' }); load(); };

  const statusTabs = ['all', 'pending', 'running', 'completed', 'failed'];
  const statusCounts = { all: tasks.length, pending: tasks.filter(t=>t.status==='pending').length, running: tasks.filter(t=>t.status==='running').length, completed: tasks.filter(t=>t.status==='completed').length, failed: tasks.filter(t=>t.status==='failed').length };

  return (
    <div className="space-y-4">
      {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} onCreated={load} />}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <ListTodo size={20} style={{ color: NEON.green, filter: `drop-shadow(0 0 6px ${NEON.green})` }} />
          <h2 className="text-xl font-bold" style={{ color: NEON.green, textShadow: `0 0 15px ${NEON.green}44` }}>Tasks</h2>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.green}15`, color: NEON.green, border: `1px solid ${NEON.green}30` }}>{tasks.length} total</span>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:brightness-125"
          style={{ background: `${NEON.green}15`, border: `1px solid ${NEON.green}30`, color: NEON.green }}>
          <Zap size={14} /> New Task
        </button>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {statusTabs.map(s => (
          <button key={s} onClick={() => setStatusFilter(s)} className="px-3 py-1.5 text-xs rounded-lg font-semibold transition-all capitalize hover:brightness-125"
            style={{ background: statusFilter === s ? `${STATUS_COLORS[s] || NEON.cyan}20` : 'rgba(0,0,0,0.3)', border: `1px solid ${statusFilter === s ? (STATUS_COLORS[s] || NEON.cyan) : 'transparent'}`, color: statusFilter === s ? (STATUS_COLORS[s] || NEON.cyan) : '#666' }}>
            {s} ({statusCounts[s]})</button>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.cyan}15` }} />
        </div>
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: NEON.orange }}>{selectedIds.size} selected</span>
            <button onClick={bulkDelete} className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg font-semibold hover:brightness-125" style={{ background: `${NEON.red}15`, border: `1px solid ${NEON.red}30`, color: NEON.red }}><Trash2 size={12} /> Delete</button>
            <button onClick={() => setSelectedIds(new Set())} className="px-2.5 py-1.5 text-xs rounded-lg bg-black/30 border border-gray-700 text-gray-400">Clear</button>
          </div>
        )}
      </div>

      <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.9)', border: '1px solid rgba(0,240,255,0.1)' }}>
        <div className="flex items-center gap-3 px-4 py-2.5 text-xs font-semibold tracking-wider uppercase text-gray-600" style={{ borderBottom: '1px solid rgba(0,240,255,0.08)' }}>
          <button onClick={toggleAll} className="shrink-0">{selectedIds.size === filtered.length && filtered.length > 0 ? <CheckSquare size={14} style={{ color: NEON.cyan }} /> : <Square size={14} className="text-gray-600" />}</button>
          <span className="w-20">Priority</span><span className="flex-1">Name</span><span className="w-20 hidden sm:block">Status</span><span className="w-24 hidden md:block font-mono">Created</span><span className="w-8"></span>
        </div>
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-600"><ListTodo size={32} className="mx-auto mb-2 opacity-30" />{tasks.length === 0 ? 'No tasks yet. Create one to get started.' : 'No tasks match your filter.'}</div>
        ) : filtered.map(task => {
          const priority = getPriority(task);
          const statusColor = STATUS_COLORS[task.status] || '#666';
          const isExpanded = expandedId === task.id;
          return (
            <div key={task.id}>
              <div className="flex items-center gap-3 px-4 py-2.5 transition-colors cursor-pointer hover:bg-cyan-500/[0.02]" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <button onClick={() => toggleSelect(task.id)} className="shrink-0">{selectedIds.has(task.id) ? <CheckSquare size={14} style={{ color: NEON.cyan }} /> : <Square size={14} className="text-gray-600" />}</button>
                <span className="w-20 text-xs font-semibold" style={{ color: PRIORITY_COLORS[priority] }}><Flag size={10} className="inline mr-1" />{priority.charAt(0).toUpperCase() + priority.slice(1)}</span>
                <span className="flex-1 text-sm truncate text-gray-200" onClick={() => setExpandedId(isExpanded ? null : task.id)}>{task.name}</span>
                <span className="w-20 hidden sm:flex items-center gap-1.5 text-xs font-semibold" style={{ color: statusColor }}><span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor, boxShadow: `0 0 6px ${statusColor}` }} />{task.status}</span>
                <span className="w-24 hidden md:block text-xs font-mono truncate text-gray-600">{task.created_at ? new Date(task.created_at).toLocaleTimeString() : '—'}</span>
                <div className="w-8 flex items-center gap-1">
                  {task.status === 'failed' && <button onClick={() => retryTask(task)} title="Retry" className="p-1 rounded text-gray-600 hover:text-green-400"><RefreshCw size={12} /></button>}
                  <button onClick={() => deleteTask(task.id)} title="Delete" className="p-1 rounded text-gray-600 hover:text-red-400"><Trash2 size={12} /></button>
                </div>
                <button onClick={() => setExpandedId(isExpanded ? null : task.id)} className="p-1 text-gray-600"><ChevronDown size={14} /></button>
              </div>
              {isExpanded && (
                <div className="px-4 py-3 space-y-2 bg-black/30" style={{ borderBottom: '1px solid rgba(0,240,255,0.06)' }}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div><span className="text-gray-500 block mb-0.5">ID</span><span className="font-mono" style={{ color: NEON.cyan }}>{task.id}</span></div>
                    <div><span className="text-gray-500 block mb-0.5">Command</span><code className="text-xs px-2 py-1 rounded bg-black/40" style={{ color: NEON.green }}>{task.command}</code></div>
                    {task.exit_code != null && <div><span className="text-gray-500 block mb-0.5">Exit Code</span><span style={{ color: task.exit_code === 0 ? NEON.green : NEON.red }}>{task.exit_code}</span></div>}
                    {task.result && <div className="sm:col-span-2"><span className="text-gray-500 block mb-0.5">Result</span><pre className="text-xs p-2 rounded overflow-auto max-h-32 bg-black/40 text-gray-400" style={{ border: '1px solid rgba(0,240,255,0.08)' }}>{task.result}</pre></div>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
