import React, { useEffect, useState, useMemo } from 'react';
import { api } from './AuthContext';
import { usePolling } from './usePolling';
import { ScrollText, Search, Download, ChevronDown, ChevronUp, Filter, Calendar, User as UserIcon } from 'lucide-react';

const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6', magenta:'#ff00ff' };

const EVENT_TYPES = ['all', 'task:created', 'task:status', 'task:deleted', 'agent:created', 'agent:heartbeat', 'agent:status', 'dag:created', 'dag:status', 'schedule:created', 'schedule:fired', 'user:login'];
const TYPE_COLORS = { task: NEON.green, agent: NEON.blue, dag: NEON.purple, schedule: NEON.cyan, user: NEON.pink, mcp: NEON.magenta, group: NEON.teal };

function getTypeColor(type) {
  const prefix = (type || '').split(':')[0];
  return TYPE_COLORS[prefix] || '#666';
}

export default function AuditLog() {
  const [entries, setEntries] = useState([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [userFilter, setUserFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const load = () => api('/api/audit').then(setEntries).catch(() => {});
  usePolling(load, 30000);

  const filtered = useMemo(() => entries.filter(e => {
    if (typeFilter !== 'all' && e.action !== typeFilter && !e.action?.startsWith(typeFilter.split(':')[0])) return false;
    if (userFilter && !(e.user_id || '').toLowerCase().includes(userFilter.toLowerCase())) return false;
    if (dateFrom && new Date(e.timestamp || e.created_at) < new Date(dateFrom)) return false;
    if (dateTo && new Date(e.timestamp || e.created_at) > new Date(dateTo + 'T23:59:59')) return false;
    if (search && !(e.action || '').toLowerCase().includes(search.toLowerCase()) && !(e.target_type || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [entries, typeFilter, userFilter, dateFrom, dateTo, search]);

  const exportCSV = () => {
    const header = 'timestamp,action,user_id,target_type,target_id\n';
    const rows = filtered.map(e => `"${e.timestamp || e.created_at}","${e.action}","${e.user_id || ''}","${e.target_type || ''}","${e.target_id || ''}"`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `audit-log-${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const parsePayload = (entry) => {
    try { return JSON.parse(entry.payload || '{}'); } catch { return {}; }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <ScrollText size={20} style={{ color: '#888', filter: `drop-shadow(0 0 6px #888)` }} />
          <h2 className="text-xl font-bold" style={{ color: '#ccc', textShadow: `0 0 15px #888444` }}>Audit Log</h2>
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: '#888', border: '1px solid #333' }}>{filtered.length} entries</span>
        </div>
        <button onClick={exportCSV} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #333', color: '#888' }}>
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-40 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#555' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search actions..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white"
            style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #222', outline: 'none' }} />
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="px-3 py-2 rounded-lg text-sm text-white"
          style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #222', outline: 'none' }}>
          {EVENT_TYPES.map(t => <option key={t} value={t}>{t === 'all' ? 'All Events' : t}</option>)}
        </select>
        <div className="relative max-w-xs">
          <UserIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#555' }} />
          <input value={userFilter} onChange={e => setUserFilter(e.target.value)} placeholder="Filter user..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white"
            style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #222', outline: 'none' }} />
        </div>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="px-3 py-2 rounded-lg text-sm text-white"
          style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #222', outline: 'none', colorScheme: 'dark' }} />
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="px-3 py-2 rounded-lg text-sm text-white"
          style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #222', outline: 'none', colorScheme: 'dark' }} />
        {(typeFilter !== 'all' || userFilter || dateFrom || dateTo) && (
          <button onClick={() => { setTypeFilter('all'); setUserFilter(''); setDateFrom(''); setDateTo(''); }} className="text-xs px-2 py-1 rounded" style={{ color: NEON.red }}>
            Clear filters
          </button>
        )}
      </div>

      {/* Log list */}
      <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.9)', border: '1px solid rgba(0,240,255,0.08)' }}>
        {filtered.length === 0 ? (
          <div className="text-center py-12" style={{ color: '#444' }}>
            <ScrollText size={32} className="mx-auto mb-2 opacity-30" />No audit entries found.
          </div>
        ) : filtered.map(entry => {
          const color = getTypeColor(entry.action);
          const isExpanded = expandedId === entry.id;
          const payload = parsePayload(entry);
          return (
            <div key={entry.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
              <div className="flex items-center gap-3 px-4 py-2.5 transition-colors cursor-pointer"


                onClick={() => setExpandedId(isExpanded ? null : entry.id)}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 4px ${color}` }} />
                <span className="text-xs font-semibold w-28 truncate" style={{ color }}>{entry.action}</span>
                <span className="flex-1 text-xs truncate" style={{ color: '#888' }}>{entry.target_type} {entry.target_id ? `→ ${entry.target_id.slice(0,8)}` : ''}</span>
                <span className="text-xs hidden sm:block" style={{ color: '#555' }}>{entry.user_id || 'system'}</span>
                <span className="text-[10px] font-mono shrink-0" style={{ color: '#444' }}>{entry.timestamp || entry.created_at ? new Date(entry.timestamp || entry.created_at).toLocaleString() : '—'}</span>
                {isExpanded ? <ChevronUp size={12} style={{ color: '#555' }} /> : <ChevronDown size={12} style={{ color: '#555' }} />}
              </div>
              {isExpanded && (
                <div className="px-4 py-3 text-xs" style={{ background: 'rgba(0,0,0,0.3)' }}>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                    <div><span className="text-gray-500 block">ID</span><span className="font-mono" style={{ color: NEON.cyan }}>{entry.id?.slice(0,12)}…</span></div>
                    <div><span className="text-gray-500 block">User</span><span style={{ color: '#888' }}>{entry.user_id || 'system'}</span></div>
                    <div><span className="text-gray-500 block">Target</span><span style={{ color: '#888' }}>{entry.target_type}/{entry.target_id?.slice(0,8)}</span></div>
                    <div><span className="text-gray-500 block">Time</span><span style={{ color: '#888' }}>{entry.timestamp || entry.created_at}</span></div>
                  </div>
                  {Object.keys(payload).length > 0 && (
                    <div>
                      <span className="text-gray-500 block mb-1">Payload</span>
                      <pre className="p-2 rounded overflow-auto max-h-32" style={{ background: 'rgba(0,0,0,0.4)', color: '#bbb', border: '1px solid rgba(0,240,255,0.06)' }}>
                        {JSON.stringify(payload, null, 2)}
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
