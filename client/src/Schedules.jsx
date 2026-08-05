import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { usePolling } from './usePolling';
import { Clock, Plus, Trash2, ToggleLeft, ToggleRight, Play, Calendar, Search, X } from 'lucide-react';

const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6', magenta:'#ff00ff' };

function describeCron(cron) {
  if (!cron) return '—';
  const p = cron.trim().split(/\s+/);
  if (p.length < 5) return cron;
  const [min, hour, dom, month, dow] = p;
  if (min === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') return 'Every minute';
  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} minutes`;
  if (hour.startsWith('*/') && min === '0') return `Every ${hour.slice(2)} hours`;
  if (min !== '*' && hour !== '*' && dom === '*') return `Daily at ${hour}:${min.padStart(2,'0')}`;
  if (dow !== '*' && hour !== '*') { const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; return `${days[parseInt(dow)] || dow} at ${hour}:${min.padStart(2,'0')}`; }
  return cron;
}

function CreateScheduleModal({ onClose, onCreated, tasks }) {
  const [name, setName] = useState('');
  const [cron, setCron] = useState('*/5 * * * *');
  const [taskId, setTaskId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const handleSubmit = async (e) => {
    e.preventDefault(); if (!name.trim()) return; setLoading(true);
    try { await api('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, cron_expr: cron, command: taskId ? `run-task:${taskId}` : 'echo scheduled', enabled: enabled ? 1 : 0 }) }); onCreated(); onClose(); } catch (err) { console.error(err); }
    setLoading(false);
  };
  const presets = [{ label: 'Every 5 min', cron: '*/5 * * * *' }, { label: 'Hourly', cron: '0 * * * *' }, { label: 'Daily midnight', cron: '0 0 * * *' }, { label: 'Weekly Mon 9am', cron: '0 9 * * 1' }];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.cyan}30` }} onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4" style={{ color: NEON.cyan }}>New Schedule</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div><label className="text-xs text-gray-400 mb-1 block">Name</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.cyan}20` }} placeholder="e.g. daily-sync" /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Cron Expression</label><input value={cron} onChange={e => setCron(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none font-mono" style={{ border: `1px solid ${NEON.cyan}20` }} placeholder="*/5 * * * *" /><div className="text-xs mt-1" style={{ color: NEON.teal }}>{describeCron(cron)}</div></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Quick Presets</label><div className="flex gap-1.5 flex-wrap">{presets.map(p => (<button key={p.label} type="button" onClick={() => setCron(p.cron)} className="px-2 py-1 text-xs rounded-lg transition-all hover:brightness-125" style={{ background: cron === p.cron ? `${NEON.cyan}20` : 'rgba(0,0,0,0.3)', border: `1px solid ${cron === p.cron ? NEON.cyan : '#333'}`, color: cron === p.cron ? NEON.cyan : '#888' }}>{p.label}</button>))}</div></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Link to Task (optional)</label><select value={taskId} onChange={e => setTaskId(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.cyan}20` }}><option value="">— None —</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
          <div className="flex items-center gap-2"><button type="button" onClick={() => setEnabled(!enabled)} className="flex items-center gap-2 text-xs">{enabled ? <ToggleRight size={18} style={{ color: NEON.green }} /> : <ToggleLeft size={18} className="text-gray-500" />}<span style={{ color: enabled ? NEON.green : '#555' }}>{enabled ? 'Enabled' : 'Disabled'}</span></button></div>
          <div className="flex gap-2 pt-2"><button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm bg-black/40 border border-gray-700 text-gray-400">Cancel</button><button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.cyan}20`, border: `1px solid ${NEON.cyan}40`, color: NEON.cyan }}>{loading ? 'Creating...' : 'Create'}</button></div>
        </form>
      </div>
    </div>
  );
}

export default function Schedules() {
  const [schedules, setSchedules] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  const load = () => { api('/api/schedules').then(setSchedules).catch(() => {}); api('/api/tasks').then(setTasks).catch(() => {}); };
  usePolling(load, 30000);
  const filtered = schedules.filter(s => !search || (s.name || '').toLowerCase().includes(search.toLowerCase()));
  const toggleEnabled = async (sched) => { await api(`/api/schedules/${sched.id}/toggle`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' } }); load(); };
  const deleteSchedule = async (id) => { await api(`/api/schedules/${id}`, { method: 'DELETE' }); load(); };
  const getTaskName = (taskId) => { const t = tasks.find(t => t.id === taskId); return t ? t.name : (taskId ? taskId.slice(0,8) + '…' : '—'); };

  return (
    <div className="space-y-4">
      {showCreate && <CreateScheduleModal onClose={() => setShowCreate(false)} onCreated={load} tasks={tasks} />}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3"><Clock size={20} style={{ color: NEON.cyan, filter: `drop-shadow(0 0 6px ${NEON.cyan})` }} /><h2 className="text-xl font-bold" style={{ color: NEON.cyan, textShadow: `0 0 15px ${NEON.cyan}44` }}>Schedules</h2><span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.cyan}15`, color: NEON.cyan, border: `1px solid ${NEON.cyan}30` }}>{schedules.length}</span></div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold hover:brightness-125" style={{ background: `${NEON.cyan}15`, border: `1px solid ${NEON.cyan}30`, color: NEON.cyan }}><Plus size={14} /> New Schedule</button>
      </div>
      <div className="relative max-w-sm"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search schedules..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.cyan}15` }} /></div>
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-600"><Clock size={32} className="mx-auto mb-2 opacity-30" />No schedules configured.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map(sched => (
            <div key={sched.id} className="rounded-xl p-4 transition-all hover:shadow-lg" style={{ background: 'linear-gradient(135deg, rgba(10,10,20,0.9), rgba(15,5,25,0.9))', border: `1px solid ${sched.enabled ? NEON.cyan + '20' : '#222'}`, opacity: sched.enabled ? 1 : 0.6 }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2"><button onClick={() => toggleEnabled(sched)} title={sched.enabled ? 'Disable' : 'Enable'}>{sched.enabled ? <ToggleRight size={18} style={{ color: NEON.green }} /> : <ToggleLeft size={18} className="text-gray-500" />}</button><span className="font-semibold text-sm" style={{ color: sched.enabled ? '#ddd' : '#666' }}>{sched.name}</span></div>
                <button onClick={() => deleteSchedule(sched.id)} className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-white/5"><Trash2 size={14} /></button>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-2"><Calendar size={12} style={{ color: NEON.teal }} /><code className="px-2 py-0.5 rounded bg-black/40" style={{ color: NEON.cyan }}>{sched.cron_expr}</code><span style={{ color: NEON.teal }}>{describeCron(sched.cron_expr)}</span></div>
                <div className="flex items-center gap-4"><span className="text-gray-500">Command: <span className="text-gray-400">{sched.command || '—'}</span></span><span className="text-gray-500">Last: <span className="text-gray-400">{sched.last_run ? new Date(sched.last_run).toLocaleString() : 'Never'}</span></span></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
