import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { useWsResource } from './useWsResource';
import { Cable, Plus, Trash2, Search, Activity, Plug, Unplug, RefreshCw, ChevronDown, ChevronUp, X, Check } from 'lucide-react';

const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6', magenta:'#ff00ff' };
const STATUS_COLORS = { connected: NEON.green, disconnected: NEON.red, connecting: NEON.yellow, error: NEON.orange };

function ConnectModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [loading, setLoading] = useState(false);
  const handleSubmit = async (e) => {
    e.preventDefault(); if (!name.trim() || !command.trim()) return; setLoading(true);
    try { const body = { name, transport: 'stdio', command, args: JSON.stringify(args ? args.split(' ') : []), status: 'disconnected' }; await api('/api/mcp/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); onCreated(); onClose(); } catch (err) { console.error(err); }
    setLoading(false);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.purple}30` }} onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold mb-4" style={{ color: NEON.purple }}>Connect MCP Server</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div><label className="text-xs text-gray-400 mb-1 block">Name</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.purple}20` }} placeholder="e.g. filesystem" /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Command</label><input value={command} onChange={e => setCommand(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none font-mono" style={{ border: `1px solid ${NEON.purple}20` }} placeholder="e.g. npx @modelcontextprotocol/server-filesystem" /></div>
          <div><label className="text-xs text-gray-400 mb-1 block">Arguments (space-separated)</label><input value={args} onChange={e => setArgs(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none font-mono" style={{ border: `1px solid ${NEON.purple}20` }} placeholder="e.g. /home/user/documents" /></div>
          <div className="flex gap-2 pt-2"><button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm bg-black/40 border border-gray-700 text-gray-400">Cancel</button><button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.purple}20`, border: `1px solid ${NEON.purple}40`, color: NEON.purple }}>{loading ? 'Connecting...' : 'Connect'}</button></div>
        </form>
      </div>
    </div>
  );
}

export default function MCP() {
  const [servers, setServers] = useState([]);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [showConnect, setShowConnect] = useState(false);
  const load = () => api('/api/mcp/servers').then(setServers).catch(() => {});
  useWsResource(load, ['mcp:registered', 'mcp:deleted', 'mcp:connected', 'mcp:disconnected'], 30000);
  const filtered = servers.filter(s => !search || (s.name || '').toLowerCase().includes(search.toLowerCase()));
  const deleteServer = async (id) => { await api(`/api/mcp/servers/${id}`, { method: 'DELETE' }); load(); };
  const toggleConnection = async (server) => { await api(`/api/mcp/servers/${server.id}/${server.status === 'connected' ? 'disconnect' : 'connect'}`, { method: 'POST' }); load(); };
  const tools = (server) => { try { return JSON.parse(server.tools || '[]'); } catch { return []; } };

  return (
    <div className="space-y-4">
      {showConnect && <ConnectModal onClose={() => setShowConnect(false)} onCreated={load} />}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3"><Cable size={20} style={{ color: NEON.purple, filter: `drop-shadow(0 0 6px ${NEON.purple})` }} /><h2 className="text-xl font-bold" style={{ color: NEON.purple, textShadow: `0 0 15px ${NEON.purple}44` }}>MCP Servers</h2><span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.purple}15`, color: NEON.purple, border: `1px solid ${NEON.purple}30` }}>{servers.length}</span></div>
        <button onClick={() => setShowConnect(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold hover:brightness-125" style={{ background: `${NEON.purple}15`, border: `1px solid ${NEON.purple}30`, color: NEON.purple }}><Plug size={14} /> Connect Server</button>
      </div>
      <div className="relative max-w-sm"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search servers..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.purple}15` }} /></div>
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-600"><Cable size={32} className="mx-auto mb-2 opacity-30" />No MCP servers connected.</div>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.9)', border: `1px solid ${NEON.purple}15` }}>
          {filtered.map(server => {
            const isExpanded = expandedId === server.id;
            const statusColor = STATUS_COLORS[server.status] || '#555';
            const serverTools = tools(server);
            return (
              <div key={server.id}>
                <div className="flex items-center gap-3 px-4 py-3 transition-colors cursor-pointer hover:bg-purple-500/[0.02]" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor, boxShadow: `0 0 6px ${statusColor}` }} />
                  <span className="flex-1 text-sm font-semibold text-gray-200 truncate" onClick={() => setExpandedId(isExpanded ? null : server.id)}>{server.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full shrink-0" style={{ background: `${statusColor}15`, color: statusColor, border: `1px solid ${statusColor}30` }}>{server.status}</span>
                  <span className="text-xs text-gray-500 shrink-0">{serverTools.length} tools</span>
                  <button onClick={() => toggleConnection(server)} title={server.status === 'connected' ? 'Disconnect' : 'Connect'} className="p-1 rounded text-gray-500 hover:text-purple-400 hover:bg-white/5 shrink-0">{server.status === 'connected' ? <Unplug size={14} /> : <Plug size={14} />}</button>
                  <button onClick={() => deleteServer(server.id)} title="Remove" className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-white/5 shrink-0"><Trash2 size={14} /></button>
                  <button onClick={() => setExpandedId(isExpanded ? null : server.id)} className="p-1 text-gray-600 shrink-0">{isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
                </div>
                {isExpanded && (
                  <div className="px-4 py-3 bg-black/30 space-y-2" style={{ borderBottom: '1px solid rgba(168,85,247,0.06)' }}>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div><span className="text-gray-500 block">Command</span><code style={{ color: NEON.cyan }}>{server.command}</code></div>
                      <div><span className="text-gray-500 block">Arguments</span><span className="text-gray-400">{(server.args || []).join(' ') || 'None'}</span></div>
                    </div>
                    {serverTools.length > 0 && (
                      <div><span className="text-gray-500 text-xs block mb-1">Available Tools</span>
                        <div className="flex flex-wrap gap-1">{serverTools.map((tool, i) => (<span key={i} className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: `${NEON.teal}15`, color: NEON.teal, border: `1px solid ${NEON.teal}30` }}>{typeof tool === 'string' ? tool : tool.name || `tool-${i}`}</span>))}</div>
                      </div>
                    )}
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
