import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { usePolling } from './usePolling';
import { Puzzle, ToggleLeft, ToggleRight, Trash2, Plus, Search, ChevronDown, ChevronUp, Package, X, RefreshCw, Store, Globe, Download, ScanLine, ShieldCheck } from 'lucide-react';
const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6', magenta:'#ff00ff' };
const STATUS_STYLES = {
 active: { color: NEON.green, bg: `${NEON.green}15`, border: `${NEON.green}30` },
 inactive: { color: '#666', bg: 'rgba(0,0,0,0.3)', border: '#333' },
 error: { color: NEON.red, bg: `${NEON.red}15`, border: `${NEON.red}30` },
};
const RISK_STYLES = {
 safe: { color: NEON.green, label: 'safe' },
 caution: { color: NEON.yellow, label: 'caution' },
 elevated: { color: NEON.red, label: 'elevated' },
};
function RiskBadge({ verdict }) {
 const s = RISK_STYLES[verdict] || RISK_STYLES.safe;
 return (
  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: `${s.color}15`, color: s.color, border: `1px solid ${s.color}30` }}>
   risk: {s.label}
  </span>
 );
}
// Like api() but keeps the response body on non-2xx so install handlers can
// read needs_approval / approval_id / risk from WARDEN-held installs.
const marketFetch = async (path, opts = {}) => {
 const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
 const token = localStorage.getItem('cf_token');
 if (token) headers['Authorization'] = `Bearer ${token}`;
 const res = await fetch(path, { ...opts, headers, cache: 'no-store' });
 const body = await res.json().catch(() => ({}));
 if (!res.ok) throw Object.assign(new Error(body.error || `Request failed: ${res.status}`), body);
 return body;
};
function InstallModal({ onClose, onInstalled }) {
 const [name, setName] = useState('');
 const [version, setVersion] = useState('1.0.0');
 const [url, setUrl] = useState('');
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState('');
 const handleSubmit = async (e) => {
   e.preventDefault();
   if (!name.trim()) return;
   setLoading(true); setError('');
   try {
     await api('/api/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version, url, status: 'active', config: JSON.stringify({ source: url || 'local' }) }) });
     onInstalled(); onClose();
   } catch (err) { setError(err.message || String(err)); }
   setLoading(false);
 };
 return (
   <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.pink}30` }} onClick={e => e.stopPropagation()}>
       <h3 className="text-lg font-bold mb-4" style={{ color: NEON.pink }}>Install Plugin</h3>
       {error && <div className="mb-3 px-3 py-2 rounded-lg text-xs" style={{ background: `${NEON.red}15`, border: `1px solid ${NEON.red}30`, color: NEON.red }}>{error}</div>}
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
function AddSourceModal({ onClose, onAdded }) {
 const [name, setName] = useState('');
 const [url, setUrl] = useState('');
 const [type, setType] = useState('github');
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState('');
 const handleSubmit = async (e) => {
   e.preventDefault();
   if (!name.trim() || !url.trim()) return;
   setLoading(true); setError('');
   try {
     await api('/api/plugins/market/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url, type }) });
     onAdded(); onClose();
   } catch (err) { setError(err.message || String(err)); }
   setLoading(false);
 };
 return (
   <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.cyan}30` }} onClick={e => e.stopPropagation()}>
       <h3 className="text-lg font-bold mb-4" style={{ color: NEON.cyan }}>Add Market Source</h3>
       {error && <div className="mb-3 px-3 py-2 rounded-lg text-xs" style={{ background: `${NEON.red}15`, border: `1px solid ${NEON.red}30`, color: NEON.red }}>{error}</div>}
       <form onSubmit={handleSubmit} className="space-y-3">
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Source Name</label>
           <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.cyan}20`, outline: 'none' }} placeholder="e.g. community-plugins" />
         </div>
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Source URL</label>
           <input value={url} onChange={e => setUrl(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.cyan}20`, outline: 'none' }} placeholder="https://github.com/user/plugin-repo" />
         </div>
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Type</label>
           <div className="flex gap-2">
             {[['github', 'GitHub repo'], ['url', 'JSON endpoint']].map(([val, label]) => (
               <button key={val} type="button" onClick={() => setType(val)} className="flex-1 py-2 rounded-lg text-sm" style={{ background: type === val ? `${NEON.cyan}20` : 'rgba(0,0,0,0.4)', border: type === val ? `1px solid ${NEON.cyan}40` : '1px solid #333', color: type === val ? NEON.cyan : '#888' }}>{label}</button>
             ))}
           </div>
         </div>
         <div className="flex gap-2 pt-2">
           <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #333', color: '#888' }}>Cancel</button>
           <button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.cyan}20`, border: `1px solid ${NEON.cyan}40`, color: NEON.cyan }}>{loading ? 'Adding...' : 'Add Source'}</button>
         </div>
       </form>
     </div>
   </div>
 );
}
function Marketplace({ onInstalled }) {
 const [sources, setSources] = useState([]);
 const [query, setQuery] = useState('');
 const [results, setResults] = useState([]);
 const [searched, setSearched] = useState(false);
 const [searching, setSearching] = useState(false);
 const [installing, setInstalling] = useState(null);
 const [directUrl, setDirectUrl] = useState('');
 const [directLoading, setDirectLoading] = useState(false);
 const [directError, setDirectError] = useState('');
 const [showAdd, setShowAdd] = useState(false);
 const [notice, setNotice] = useState(null);
 const loadSources = () => api('/api/plugins/market/sources').then(setSources).catch(() => {});
 useEffect(() => { loadSources(); }, []);
 const runSearch = async (q) => {
  setSearching(true); setSearched(true);
  try {
   const data = await api(`/api/plugins/market/search?q=${encodeURIComponent(q)}`);
   setResults(data.results || []);
  } catch { setResults([]); }
  setSearching(false);
 };
 const rescan = async (id) => {
  try { await api(`/api/plugins/market/sources/${id}/scan`, { method: 'POST' }); loadSources(); } catch (e) { console.error(e); }
 };
 const removeSource = async (id) => { await api(`/api/plugins/market/sources/${id}`, { method: 'DELETE' }); loadSources(); };
 const install = async (sourceId, name) => {
  setInstalling(name);
  setNotice(null);
  try {
   const res = await marketFetch('/api/plugins/market/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_id: sourceId, plugin_name: name }) });
   setNotice({ kind: 'installed', risk: res.risk });
   onInstalled();
  } catch (e) {
   if (e.needs_approval) setNotice({ kind: 'held', risk: e.risk, approvalId: e.approval_id });
   else setNotice({ kind: 'error', message: e.message });
  }
  setInstalling(null);
 };
 const installDirect = async (e) => {
  e.preventDefault();
  if (!directUrl.trim()) return;
  setDirectLoading(true); setDirectError(''); setNotice(null);
  try {
   const res = await marketFetch('/api/plugins/market/install-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: directUrl }) });
   setDirectUrl('');
   setNotice({ kind: 'installed', risk: res.risk });
   onInstalled();
  } catch (err) {
   if (err.needs_approval) setNotice({ kind: 'held', risk: err.risk, approvalId: err.approval_id });
   else setDirectError(err.message || String(err));
  }
  setDirectLoading(false);
 };
 return (
   <div className="space-y-4">
     {showAdd && <AddSourceModal onClose={() => setShowAdd(false)} onAdded={loadSources} />}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Store size={16} style={{ color: NEON.cyan }} />
          <h3 className="text-sm font-bold" style={{ color: NEON.cyan }}>Market Sources</h3>
        </div>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
          style={{ background: `${NEON.cyan}15`, border: `1px solid ${NEON.cyan}30`, color: NEON.cyan }}>
          <Plus size={14} /> Add Source
        </button>
      </div>
      {notice && (
         <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{
           background: 'rgba(0,0,0,0.35)',
           border: `1px solid ${notice.kind === 'error' ? `${NEON.red}30` : notice.kind === 'held' ? `${NEON.yellow}30` : `${NEON.green}30`}`,
         }}>
           {notice.kind === 'error' && <span style={{ color: NEON.red }}>{notice.message}</span>}
           {notice.kind === 'held' && (
             <span style={{ color: NEON.yellow }}>
               Install held — WARDEN approval required{notice.approvalId ? ` (#${notice.approvalId.slice(0, 8)})` : ''}. Resubmit with approval to continue.
             </span>
           )}
           {notice.kind === 'installed' && <span style={{ color: NEON.green }}>Installed.</span>}
           {notice.risk && notice.kind !== 'error' && <RiskBadge verdict={notice.risk.verdict} />}
         </div>
      )}
     {/* Sources list */}
     <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.9)', border: '1px solid rgba(0,240,255,0.1)' }}>
       {sources.length === 0 ? (
         <div className="text-center py-8" style={{ color: '#444' }}>
           <Globe size={24} className="mx-auto mb-2 opacity-30" />No market sources. Add a GitHub repo or JSON endpoint.
         </div>
       ) : sources.map(s => {
         const statusStyle = s.scan_status === 'passed' ? STATUS_STYLES.active : s.scan_status === 'failed' ? STATUS_STYLES.error : { color: NEON.yellow, bg: `${NEON.yellow}15`, border: `${NEON.yellow}30` };
         const catalogCount = (s.installed_plugins || []).length;
         return (
           <div key={s.id} className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
             <Globe size={14} style={{ color: NEON.cyan }} />
             <div className="flex-1 min-w-0">
               <div className="text-sm font-semibold" style={{ color: '#ddd' }}>{s.name}</div>
               <div className="text-[11px] font-mono truncate" style={{ color: '#555' }}>{s.url}</div>
             </div>
             <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: statusStyle.bg, color: statusStyle.color, border: `1px solid ${statusStyle.border}` }}>
               {s.scan_status}
             </span>
             {catalogCount > 0 && <span className="text-[10px] font-mono" style={{ color: '#888' }}>{catalogCount} plugins</span>}
             {s.verified > 0 && <ShieldCheck size={14} style={{ color: NEON.green }} />}
             <button onClick={() => rescan(s.id)} className="p-1 rounded transition" title="Rescan" style={{ color: NEON.cyan }}><ScanLine size={14} /></button>
             <button onClick={() => removeSource(s.id)} className="p-1 rounded transition" title="Remove source" style={{ color: '#555' }}><Trash2 size={14} /></button>
           </div>
         );
       })}
     </div>
     {/* Direct URL install */}
     <form onSubmit={installDirect} className="rounded-xl p-4" style={{ background: 'rgba(10,10,20,0.9)', border: '1px solid rgba(0,240,255,0.1)' }}>
       <label className="text-xs text-gray-400 mb-1 block">Install from URL (base URL serving manifest.json + index.mjs)</label>
       <div className="flex gap-2">
         <input value={directUrl} onChange={e => setDirectUrl(e.target.value)} placeholder="https://registry.example.com/plugins/my-plugin" className="flex-1 px-3 py-2 rounded-lg text-sm text-white"
           style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.cyan}15`, outline: 'none' }} />
         <button type="submit" disabled={directLoading} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold"
           style={{ background: `${NEON.cyan}15`, border: `1px solid ${NEON.cyan}30`, color: NEON.cyan }}>
           <Download size={14} /> {directLoading ? 'Installing...' : 'Install'}
         </button>
       </div>
       {directError && <div className="mt-2 px-3 py-2 rounded-lg text-xs" style={{ background: `${NEON.red}15`, border: `1px solid ${NEON.red}30`, color: NEON.red }}>{directError}</div>}
     </form>
     {/* Search */}
     <div className="flex items-center gap-2">
       <div className="relative flex-1 max-w-md">
         <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#555' }} />
         <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && runSearch(query)} placeholder="Search marketplace..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white"
           style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.cyan}15`, outline: 'none' }} />
       </div>
       <button onClick={() => runSearch(query)} className="px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: `${NEON.cyan}15`, border: `1px solid ${NEON.cyan}30`, color: NEON.cyan }}>
         {searching ? 'Searching...' : 'Search'}
       </button>
     </div>
     {/* Results */}
     {searched && (
       <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.9)', border: '1px solid rgba(0,240,255,0.1)' }}>
         {results.length === 0 ? (
           <div className="text-center py-8" style={{ color: '#444' }}>No plugins found.</div>
         ) : results.map(p => {
           const installed = p.installed;
           return (
             <div key={`${p.market_source_id}-${p.name}`} className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
               <Package size={14} style={{ color: NEON.pink }} />
               <div className="flex-1 min-w-0">
                 <div className="flex items-center gap-2">
                   <span className="text-sm font-semibold" style={{ color: '#ddd' }}>{p.name}</span>
                   {p.version && <span className="text-[10px] font-mono" style={{ color: '#555' }}>v{p.version}</span>}
                 </div>
                 {p.description && <div className="text-[11px] truncate" style={{ color: '#777' }}>{p.description}</div>}
                 <div className="flex items-center gap-2 mt-0.5">
                   <span className="text-[10px]" style={{ color: '#555' }}>{p.market_source}</span>
                   {p.hooks?.length > 0 && (
                     <span className="text-[10px] font-mono" style={{ color: NEON.cyan }}>
                       {p.hooks.join(', ')}
                     </span>
                   )}
                 </div>
               </div>
               <button onClick={() => install(p.market_source_id, p.name)} disabled={installing === p.name || installed}
                 className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
                 style={installed ? { background: 'rgba(0,0,0,0.4)', border: '1px solid #333', color: '#666' } : { background: `${NEON.pink}15`, border: `1px solid ${NEON.pink}30`, color: NEON.pink }}>
                 <Download size={13} /> {installing === p.name ? 'Installing...' : installed ? 'Installed' : 'Install'}
               </button>
             </div>
           );
         })}
       </div>
     )}
   </div>
 );
}
export default function Plugins() {
 const [plugins, setPlugins] = useState([]);
 const [search, setSearch] = useState('');
 const [expandedId, setExpandedId] = useState(null);
 const [showInstall, setShowInstall] = useState(false);
 const [tab, setTab] = useState('installed');
 const [marketFresh, setMarketFresh] = useState(0);
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
 const onMarketInstalled = () => { load(); setMarketFresh(f => f + 1); };
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
       {tab === 'installed' && (
         <button onClick={() => setShowInstall(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold"
           style={{ background: `${NEON.pink}15`, border: `1px solid ${NEON.pink}30`, color: NEON.pink }}>
           <Plus size={14} /> Install Plugin
         </button>
       )}
     </div>
     {/* Tabs */}
     <div className="flex gap-2">
       {[['installed', 'Installed', NEON.pink], ['market', 'Marketplace', NEON.cyan]].map(([key, label, color]) => (
         <button key={key} onClick={() => setTab(key)} className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
           style={tab === key ? { background: `${color}15`, border: `1px solid ${color}40`, color } : { background: 'rgba(0,0,0,0.4)', border: '1px solid #222', color: '#666' }}>
           {label}
         </button>
       ))}
     </div>
     {tab === 'market' ? (
       <Marketplace key={marketFresh} onInstalled={onMarketInstalled} />
     ) : (
       <>
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
       </>
     )}
   </div>
 );
}
