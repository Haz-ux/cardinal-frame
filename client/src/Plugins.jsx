import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { usePolling } from './usePolling';
import { Puzzle, ToggleLeft, ToggleRight, Trash2, Plus, Search, ChevronDown, ChevronUp, Package, X, RefreshCw } from 'lucide-react';
const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6', magenta:'#ff00ff' };
const STATUS_STYLES = {
 active: { color: NEON.green, bg: `${NEON.green}15`, border: `${NEON.green}30` },
 inactive: { color: '#666', bg: 'rgba(0,0,0,0.3)', border: '#333' },
 error: { color: NEON.red, bg: `${NEON.red}15`, border: `${NEON.red}30` },
};
function InstallModal({ onClose, onInstalled }) {
 const [name, setName] = useState('');
 const [version, setVersion] = useState('1.0.0');
 const [url, setUrl] = useState('');
 const [loading, setLoading] = useState(false);
 const handleSubmit = async (e) => {
   e.preventDefault();
   if (!name.trim()) return;
   setLoading(true);
   try {
     await api('/api/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version, url, status: 'active', config: JSON.stringify({ source: url || 'local' }) }) });
     onInstalled(); onClose();
   } catch (err) { console.error(err); }
   setLoading(false);
 };
 return (
   <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
     <div className="w-full max-w-md rounded-xl p-6" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.pink}30` }} onClick={e => e.stopPropagation()}>
       <h3 className="text-lg font-bold mb-4" style={{ color: NEON.pink }}>Install Plugin</h3>
       <form onSubmit={handleSubmit} className="space-y-3">
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Plugin Name</label>
           <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.pink}20`, outline: 'none' }} placeholder="e.g. sentiment-analyzer" />
         </div>
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Version</label>
           <input value={version} onChange={e => setVersion(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.pink}20`, outline: 'none' }} />
         </div>
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Source URL (optional)</label>
           <input value={url} onChange={e => setUrl(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.pink}20`, outline: 'none' }} placeholder="https://registry.example.com/plugin" />
         </div>
         <div className="flex gap-2 pt-2">
           <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #333', color: '#888' }}>Cancel</button>
           <button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.pink}20`, border: `1px solid ${NEON.pink}40`, color: NEON.pink }}>{loading ? 'Installing...' : 'Install'}</button>
         </div>
       </form>
     </div>
   </div>
 );
}
export default function Plugins() {
 const [plugins, setPlugins] = useState([]);
 const [search, setSearch] = useState('');
 const [expandedId, setExpandedId] = useState(null);
 const [showInstall, setShowInstall] = useState(false);
 const load = () => api('/api/plugins').then(setPlugins).catch(() => {});
 usePolling(load, 30000);
 const filtered = plugins.filter(p => {
   if (search && !(p.name || '').toLowerCase().includes(search.toLowerCase())) return false;
   return true;
 });
 const toggleStatus = async (plugin) => {
   try {
     await api(`/api/plugins/${plugin.id}/toggle`, { method: 'PATCH' });
     load();
   } catch (err) { console.error('Toggle failed:', err); }
 };
 const reloadPlugin = async (id) => {
   try {
     await api(`/api/plugins/${id}/reload`, { method: 'POST' });
     load();
   } catch (err) { console.error('Reload failed:', err); }
 };
 const deletePlugin = async (id) => { await api(`/api/plugins/${id}`, { method: 'DELETE' }); load(); };
 const parseConfig = (plugin) => {
   try { return JSON.parse(plugin.config || '{}'); } catch { return {}; }
 };
 return (
   <div className="space-y-4">
     {showInstall && <InstallModal onClose={() => setShowInstall(false)} onInstalled={load} />}
     {/* Header */}
     <div className="flex items-center justify-between flex-wrap gap-3">
       <div className="flex items-center gap-3">
         <Puzzle size={20} style={{ color: NEON.pink, filter: `drop-shadow(0 0 6px ${NEON.pink})` }} />
         <h2 className="text-xl font-bold" style={{ color: NEON.pink, textShadow: `0 0 15px ${NEON.pink}44` }}>Plugins</h2>
         <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.pink}15`, color: NEON.pink, border: `1px solid ${NEON.pink}30` }}>{plugins.length}</span>
       </div>
       <button onClick={() => setShowInstall(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold"
         style={{ background: `${NEON.pink}15`, border: `1px solid ${NEON.pink}30`, color: NEON.pink }}>
         <Plus size={14} /> Install Plugin
       </button>
     </div>
     {/* Search */}
     <div className="relative max-w-sm">
       <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#555' }} />
       <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search plugins..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white"
         style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.pink}15`, outline: 'none' }} />
     </div>
     {/* Plugin list */}
     <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.9)', border: '1px solid rgba(0,240,255,0.1)' }}>
       {filtered.length === 0 ? (
         <div className="text-center py-12" style={{ color: '#444' }}>
           <Puzzle size={32} className="mx-auto mb-2 opacity-30" />No plugins installed.
         </div>
       ) : filtered.map(plugin => {
         const isEnabled = plugin.enabled === 1 || plugin.enabled === true;
         const s = isEnabled ? STATUS_STYLES.active : STATUS_STYLES.inactive;
         const isExpanded = expandedId === plugin.id;
         const config = parseConfig(plugin);
         return (
           <div key={plugin.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
             <div className="flex items-center gap-3 px-4 py-3 transition-colors cursor-pointer"
               onClick={() => setExpandedId(isExpanded ? null : plugin.id)}>
               <Package size={14} style={{ color: s.color }} />
               <span className="flex-1 text-sm font-semibold" style={{ color: '#ddd' }}>{plugin.name}</span>
               {plugin.loaded && <span className="text-[10px] font-semibold" style={{ color: NEON.green }}>● loaded</span>}
               <span className="text-xs" style={{ color: '#555' }}>v{plugin.version || '0.0.0'}</span>
               <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
                 {isEnabled ? 'active' : 'inactive'}
               </span>
               <button onClick={(e) => { e.stopPropagation(); toggleStatus(plugin); }} title={isEnabled ? 'Disable' : 'Enable'}>
                 {isEnabled ? <ToggleRight size={18} style={{ color: NEON.green }} /> : <ToggleLeft size={18} style={{ color: '#555' }} />}
               </button>
               <button onClick={(e) => { e.stopPropagation(); reloadPlugin(plugin.id); }} title="Reload" className="p-1 rounded transition" style={{ color: NEON.cyan }}>
                 <RefreshCw size={13} />
               </button>
               <button onClick={(e) => { e.stopPropagation(); deletePlugin(plugin.id); }} className="p-1 rounded transition" style={{ color: '#555' }}>
                 <Trash2 size={14} />
               </button>
               {isExpanded ? <ChevronUp size={14} style={{ color: '#555' }} /> : <ChevronDown size={14} style={{ color: '#555' }} />}
             </div>
             {isExpanded && (
              <div className="px-4 py-3 text-xs" style={{ background: 'rgba(0,0,0,0.3)' }}>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div><span className="text-gray-500 block">ID</span><span className="font-mono" style={{ color: NEON.cyan }}>{plugin.id?.slice(0,12)}…</span></div>
                  <div><span className="text-gray-500 block">Created</span><span style={{ color: '#888' }}>{plugin.created_at ? new Date(plugin.created_at).toLocaleString() : '—'}</span></div>
                </div>
                {plugin.hooks && plugin.hooks.length > 0 && (
                  <div className="mb-2">
                    <span className="text-gray-500 block mb-1">Hooks</span>
                    <div className="flex flex-wrap gap-1">
                      {plugin.hooks.map(h => (
                        <span key={h} className="px-2 py-0.5 rounded-full text-[10px] font-mono" style={{ background: `${NEON.cyan}10`, color: NEON.cyan, border: `1px solid ${NEON.cyan}20` }}>{h}</span>
                      ))}
                    </div>
                  </div>
                )}
                 {Object.keys(config).length > 0 && (
                   <div>
                     <span className="text-gray-500 block mb-1">Config</span>
                     <pre className="p-2 rounded overflow-auto max-h-32 text-xs" style={{ background: 'rgba(0,0,0,0.4)', color: '#bbb', border: '1px solid rgba(0,240,255,0.08)' }}>
                       {JSON.stringify(config, null, 2)}
                     </pre>
                   </div>
                 )}
               </div>
             )}
           </div>
         );
       })}
     </div>
   </div>
 );
}
