import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { usePolling } from './usePolling';
import { Network, Plus, Trash2, Search, Users, Radio, ChevronDown, ChevronUp, X, Check, UserPlus } from 'lucide-react';

const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6', magenta:'#ff00ff' };

function CreateGroupModal({ onClose, onCreated, agents }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedAgents, setSelectedAgents] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const handleSubmit = async (e) => {
    e.preventDefault(); if (!name.trim()) return; setLoading(true);
    try {
      const res = await api('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) });
      const groupId = res.id;
      for (const agentId of selectedAgents) {
        await api(`/api/groups/${groupId}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }) });
      }
      onCreated(); onClose();
    } catch (err) { console.error(err); }
    setLoading(false);
  };
  const toggleAgent = (id) => setSelectedAgents(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.teal}30` }} onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4" style={{ color: NEON.teal }}>Create Agent Group</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div><label className="text-xs text-gray-400 mb-1 block">Group Name</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.teal}20` }} placeholder="e.g. data-pipeline" /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Description</label><input value={description} onChange={e => setDescription(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.teal}20` }} placeholder="Optional description" /></div>
          {agents.length > 0 && (
            <div><label className="text-xs text-gray-400 mb-1 block">Add Agents</label>
              <div className="max-h-32 overflow-y-auto space-y-1 p-2 rounded-lg bg-black/40" style={{ border: `1px solid ${NEON.teal}15` }}>
                {agents.map(a => (
                  <button key={a.id} type="button" onClick={() => toggleAgent(a.id)} className="flex items-center gap-2 w-full px-2 py-1 rounded text-xs text-left hover:bg-white/5 transition-colors">
                    {selectedAgents.has(a.id) ? <Check size={12} style={{ color: NEON.green }} /> : <span className="w-3" />}
                    <span className="text-gray-300">{a.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm bg-black/40 border border-gray-700 text-gray-400">Cancel</button>
            <button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.teal}20`, border: `1px solid ${NEON.teal}40`, color: NEON.teal }}>{loading ? 'Creating...' : 'Create Group'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AgentGroups() {
  const [groups, setGroups] = useState([]);
  const [agents, setAgents] = useState([]);
  const [members, setMembers] = useState({});
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    try {
      const g = await api('/api/groups');
      const a = await api('/api/agents');
      setGroups(g);
      setAgents(a);
      // Load members for each group
      const mems = {};
      for (const group of g) {
        try {
          const detail = await api(`/api/groups/${group.id}`);
          mems[group.id] = detail.members || [];
        } catch { mems[group.id] = []; }
      }
      setMembers(mems);
    } catch {}
  };
  usePolling(load, 30000);

  const filtered = groups.filter(g => !search || (g.name || '').toLowerCase().includes(search.toLowerCase()));
  const deleteGroup = async (id) => { await api(`/api/groups/${id}`, { method: 'DELETE' }); load(); };
  const removeMember = async (groupId, agentId) => { await api(`/api/groups/${groupId}/members/${agentId}`, { method: 'DELETE' }); load(); };

  return (
    <div className="space-y-4">
      {showCreate && <CreateGroupModal onClose={() => setShowCreate(false)} onCreated={load} agents={agents} />}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Network size={20} style={{ color: NEON.teal, filter: `drop-shadow(0 0 6px ${NEON.teal})` }} />
          <h2 className="text-xl font-bold" style={{ color: NEON.teal, textShadow: `0 0 15px ${NEON.teal}44` }}>Agent Groups</h2>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.teal}15`, color: NEON.teal, border: `1px solid ${NEON.teal}30` }}>{groups.length}</span>
        </div>
        <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold hover:brightness-125" style={{ background: `${NEON.teal}15`, border: `1px solid ${NEON.teal}30`, color: NEON.teal }}><Plus size={14} /> New Group</button>
      </div>
      <div className="relative max-w-sm"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search groups..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.teal}15` }} /></div>
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-600"><Network size={32} className="mx-auto mb-2 opacity-30" />No agent groups created.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(group => {
            const isExpanded = expandedId === group.id;
            const groupMembers = members[group.id] || [];
            return (
              <div key={group.id} className="rounded-xl p-4 transition-all hover:shadow-lg cursor-pointer" style={{ background: 'linear-gradient(135deg, rgba(10,10,20,0.9), rgba(5,15,25,0.9))', border: `1px solid ${NEON.teal}20` }} onClick={() => setExpandedId(isExpanded ? null : group.id)}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2"><Users size={14} style={{ color: NEON.teal }} /><span className="font-semibold text-sm text-gray-200">{group.name}</span></div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.teal}15`, color: NEON.teal, border: `1px solid ${NEON.teal}30` }}>{groupMembers.length} agents</span>
                    <button onClick={(e) => { e.stopPropagation(); deleteGroup(group.id); }} className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-white/5"><Trash2 size={14} /></button>
                  </div>
                </div>
                {group.description && <p className="text-xs text-gray-500 mb-2">{group.description}</p>}
                {isExpanded && groupMembers.length > 0 && (
                  <div className="mt-2 pt-2 space-y-1" style={{ borderTop: `1px solid ${NEON.teal}15` }}>
                    {groupMembers.map(m => (
                      <div key={m.agent_id || m.id} className="flex items-center justify-between px-2 py-1 rounded bg-black/20">
                        <span className="text-xs text-gray-300 flex items-center gap-1.5"><Radio size={10} style={{ color: NEON.green }} />{m.name || m.agent_id?.slice(0,8)}</span>
                        <button onClick={(e) => { e.stopPropagation(); removeMember(group.id, m.agent_id || m.id); }} className="p-0.5 text-gray-600 hover:text-red-400"><X size={10} /></button>
                      </div>
                    ))}
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
