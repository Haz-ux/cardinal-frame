import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { useWsResource } from './useWsResource';
import { usePolling } from './usePolling';
import { Bot, Search, Trash2, Heart, Activity, Eye, Power, PowerOff, Clock, Cpu, X } from 'lucide-react';

const NEON = { cyan:'#00f0ff', magenta:'#ff00ff', blue:'#3b82f6', purple:'#a855f7', green:'#22c55e', yellow:'#eab308', red:'#ef4444', pink:'#ec4899', orange:'#f97316', teal:'#14b8a6' };
const CAP_COLORS = [NEON.cyan, NEON.blue, NEON.purple, NEON.green, NEON.teal, NEON.orange, NEON.pink, NEON.magenta];

function healthFromHeartbeat(hb) {
  if (!hb) return { label: 'Unknown', color: '#555' };
  const ageMin = (Date.now() - new Date(hb).getTime()) / 60000;
  if (ageMin < 5) return { label: 'Healthy', color: NEON.green };
  if (ageMin < 30) return { label: 'Stale', color: NEON.yellow };
  return { label: 'Offline', color: NEON.red };
}

function RegisterModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0');
  const [caps, setCaps] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const handleSubmit = async (e) => {
    e.preventDefault(); if (!name.trim()) return; setLoading(true); setError('');
    try {
      await api('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version, capabilities: caps.split(',').map(s => s.trim()).filter(Boolean) }) });
      onCreated(); onClose();
    } catch (err) { console.error(err); setError(err.message || 'Registration failed'); }
    setLoading(false);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.blue}30` }} onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4" style={{ color: NEON.blue }}>Register Agent</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div><label className="text-xs text-gray-400 mb-1 block">Name</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.blue}20` }} placeholder="e.g. data-processor" /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Version</label><input value={version} onChange={e => setVersion(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.blue}20` }} /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Capabilities (comma-separated)</label><input value={caps} onChange={e => setCaps(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.blue}20` }} placeholder="e.g. nlp, vision, code-gen" /></div>
          {error && <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5' }}>{error}</div>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm bg-black/40 border border-gray-700 text-gray-400">Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.blue}20`, border: `1px solid ${NEON.blue}40`, color: NEON.blue }}>{loading ? 'Registering...' : 'Register'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const load = () => api('/api/agents').then(setAgents).catch(() => {});
  useWsResource(load, ['agent:deleted', 'agent:created', 'agent:updated', 'task:status'], 30000);
  // Safety poll so agents created elsewhere (e.g. by Aimi) appear promptly
  // even if the WS broadcast is missed or the tab just became visible.
  usePolling(load, 15000);
  const filtered = agents.filter(a => !search || (a.name || '').toLowerCase().includes(search.toLowerCase()));
  const deleteAgent = async (id) => { await api(`/api/agents/${id}`, { method: 'DELETE' }); load(); };
  const toggleStatus = async (agent) => { await api(`/api/agents/${agent.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: agent.status === 'active' ? 'inactive' : 'active' }) }); load(); };
  const capabilities = (agent) => { try { return JSON.parse(agent.capabilities || '[]'); } catch { return []; } };

  return (
    <div className="space-y-4">
      {showRegister && <RegisterModal onClose={() => setShowRegister(false)} onCreated={load} />}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Bot size={20} style={{ color: NEON.blue, filter: `drop-shadow(0 0 6px ${NEON.blue})` }} />
          <h2 className="text-xl font-bold" style={{ color: NEON.blue, textShadow: `0 0 15px ${NEON.blue}44` }}>Agents</h2>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.blue}15`, color: NEON.blue, border: `1px solid ${NEON.blue}30` }}>{agents.length}</span>
        </div>
        <button onClick={() => setShowRegister(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold hover:brightness-125" style={{ background: `${NEON.blue}15`, border: `1px solid ${NEON.blue}30`, color: NEON.blue }}><Bot size={14} /> Register Agent</button>
      </div>
      <div className="relative max-w-sm">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search agents..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.blue}15` }} />
      </div>
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-600"><Bot size={32} className="mx-auto mb-2 opacity-30" />No agents registered yet.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(agent => {
            const health = healthFromHeartbeat(agent.last_heartbeat);
            const caps = capabilities(agent);
            const isActive = agent.status === 'active';
            return (
              <div key={agent.id} className="rounded-xl p-4 transition-all group cursor-pointer hover:shadow-lg" style={{ background: 'linear-gradient(135deg, rgba(10,10,20,0.9), rgba(15,5,25,0.9))', border: `1px solid ${NEON.blue}20` }} onClick={() => setDetailId(detailId === agent.id ? null : agent.id)}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2 w-2">{isActive && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: health.color }} />}<span className="relative inline-flex rounded-full h-2 w-2" style={{ background: health.color }} /></span>
                    <span className="font-semibold text-sm text-gray-200">{agent.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={(e) => { e.stopPropagation(); toggleStatus(agent); }} title={isActive ? 'Deactivate' : 'Activate'} className={`p-1 rounded hover:bg-white/5 ${isActive ? 'text-green-400 hover:text-red-400' : 'text-gray-500 hover:text-green-400'}`}>{isActive ? <PowerOff size={14} /> : <Power size={14} />}</button>
                    <button onClick={(e) => { e.stopPropagation(); deleteAgent(agent.id); }} title="Delete" className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-white/5"><Trash2 size={14} /></button>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs mb-2">
                  <span className="flex items-center gap-1" style={{ color: health.color }}><Heart size={10} /> {health.label}</span>
                  <span className="text-gray-500">v{agent.version || '1.0'}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: isActive ? `${NEON.green}15` : 'rgba(0,0,0,0.3)', color: isActive ? NEON.green : '#666', border: `1px solid ${isActive ? NEON.green + '30' : '#333'}` }}>{agent.status}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {caps.map((cap, i) => (<span key={i} className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: `${CAP_COLORS[i % CAP_COLORS.length]}15`, color: CAP_COLORS[i % CAP_COLORS.length], border: `1px solid ${CAP_COLORS[i % CAP_COLORS.length]}30` }}>{cap}</span>))}
                  {caps.length === 0 && <span className="text-xs text-gray-600">No capabilities</span>}
                </div>
                {detailId === agent.id && (
                  <div className="mt-3 pt-3 space-y-2 text-xs" style={{ borderTop: '1px solid rgba(0,240,255,0.08)' }}>
                    <div className="grid grid-cols-2 gap-2">
                      <div><span className="text-gray-500 block">ID</span><span className="font-mono" style={{ color: NEON.cyan }}>{agent.id?.slice(0,12)}…</span></div>
                      <div><span className="text-gray-500 block">Registered</span><span className="text-gray-400">{agent.registered_at ? new Date(agent.registered_at).toLocaleString() : '—'}</span></div>
                      <div><span className="text-gray-500 block">Last Heartbeat</span><span style={{ color: health.color }}>{agent.last_heartbeat ? new Date(agent.last_heartbeat).toLocaleTimeString() : 'Never'}</span></div>
                      <div><span className="text-gray-500 block">Capabilities</span><span className="text-gray-400">{caps.length} defined</span></div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
