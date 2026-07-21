import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { Users as UsersIcon, Search, Plus, Trash2, ShieldCheck, Shield, User as UserIcon, X } from 'lucide-react';
const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', pink:'#ec4899', orange:'#f97316', teal:'#14b8a6' };
const ROLE_COLORS = { admin: NEON.red, user: NEON.blue, viewer: NEON.teal };
function CreateUserModal({ onClose, onCreated }) {
 const [username, setUsername] = useState('');
 const [password, setPassword] = useState('');
 const [role, setRole] = useState('user');
 const [loading, setLoading] = useState(false);
 const handleSubmit = async (e) => {
   e.preventDefault();
   if (!username.trim() || !password.trim()) return;
   setLoading(true);
   try {
     await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role }) });
     onCreated(); onClose();
   } catch (err) { console.error(err); }
   setLoading(false);
 };
 return (
   <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
     <div className="w-full max-w-md rounded-xl p-6" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.pink}30` }} onClick={e => e.stopPropagation()}>
       <h3 className="text-lg font-bold mb-4" style={{ color: NEON.pink }}>Create User</h3>
       <form onSubmit={handleSubmit} className="space-y-3">
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Username</label>
           <input value={username} onChange={e => setUsername(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.pink}20`, outline: 'none' }} />
         </div>
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Password</label>
           <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white" style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.pink}20`, outline: 'none' }} />
         </div>
         <div>
           <label className="text-xs text-gray-400 mb-1 block">Role</label>
           <div className="flex gap-2">
             {['user', 'viewer', 'admin'].map(r => (
               <button key={r} type="button" onClick={() => setRole(r)} className="flex-1 py-1.5 text-xs rounded-lg font-semibold capitalize transition-all"
                 style={{ background: role === r ? `${ROLE_COLORS[r]}20` : 'rgba(0,0,0,0.3)', border: `1px solid ${role === r ? ROLE_COLORS[r] : '#333'}`, color: role === r ? ROLE_COLORS[r] : '#666' }}>
                 {r}
               </button>
             ))}
           </div>
         </div>
         <div className="flex gap-2 pt-2">
           <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #333', color: '#888' }}>Cancel</button>
           <button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.pink}20`, border: `1px solid ${NEON.pink}40`, color: NEON.pink }}>{loading ? 'Creating...' : 'Create'}</button>
         </div>
       </form>
     </div>
   </div>
 );
}
export default function Users() {
 const [users, setUsers] = useState([]);
 const [search, setSearch] = useState('');
 const [showCreate, setShowCreate] = useState(false);
 const [editingId, setEditingId] = useState(null);
 const [editRole, setEditRole] = useState('');
 const load = () => api('/api/users').then(setUsers).catch(() => {});
 useEffect(() => { load(); }, []);
 const filtered = users.filter(u => {
   if (search && !(u.username || '').toLowerCase().includes(search.toLowerCase())) return false;
   return true;
 });
 const deleteUser = async (id) => {
   if (!confirm('Delete this user?')) return;
   await api(`/api/users/${id}`, { method: 'DELETE' }); load();
 };
 const startEdit = (user) => { setEditingId(user.id); setEditRole(user.role); };
 const saveRole = async (user) => {
   await api(`/api/users/${user.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: editRole }) });
   setEditingId(null); load();
 };
 return (
   <div className="space-y-4">
     {showCreate && <CreateUserModal onClose={() => setShowCreate(false)} onCreated={load} />}
     {/* Header */}
     <div className="flex items-center justify-between flex-wrap gap-3">
       <div className="flex items-center gap-3">
         <UsersIcon size={20} style={{ color: NEON.pink, filter: `drop-shadow(0 0 6px ${NEON.pink})` }} />
         <h2 className="text-xl font-bold" style={{ color: NEON.pink, textShadow: `0 0 15px ${NEON.pink}44` }}>Users</h2>
         <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.pink}15`, color: NEON.pink, border: `1px solid ${NEON.pink}30` }}>{users.length}</span>
       </div>
       <button onClick={() => setShowCreate(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold"
         style={{ background: `${NEON.pink}15`, border: `1px solid ${NEON.pink}30`, color: NEON.pink }}>
         <Plus size={14} /> Create User
       </button>
     </div>
     {/* Search */}
     <div className="relative max-w-sm">
       <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#555' }} />
       <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white"
         style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.pink}15`, outline: 'none' }} />
     </div>
     {/* User table */}
     <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.9)', border: '1px solid rgba(0,240,255,0.1)' }}>
       <div className="flex items-center gap-3 px-4 py-2.5 text-xs font-semibold tracking-wider uppercase" style={{ color: '#555', borderBottom: '1px solid rgba(0,240,255,0.08)' }}>
         <span className="w-8"></span><span className="flex-1">Username</span><span className="w-24">Role</span><span className="w-32 hidden sm:block">Created</span><span className="w-16">Actions</span>
       </div>
       {filtered.length === 0 ? (
         <div className="text-center py-12" style={{ color: '#444' }}><UsersIcon size={32} className="mx-auto mb-2 opacity-30" />No users found.</div>
       ) : filtered.map(user => (
         <div key={user.id} className="flex items-center gap-3 px-4 py-2.5 transition-colors" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}

>
           <UserIcon size={14} style={{ color: ROLE_COLORS[user.role] || '#666' }} />
           <span className="flex-1 text-sm" style={{ color: '#ddd' }}>{user.username}</span>
           {editingId === user.id ? (
             <div className="flex items-center gap-1 w-24">
               <select value={editRole} onChange={e => setEditRole(e.target.value)} className="text-xs px-1 py-0.5 rounded text-white" style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid #333', outline: 'none' }}>
                 {['user','viewer','admin'].map(r => <option key={r} value={r}>{r}</option>)}
               </select>
               <button onClick={() => saveRole(user)} className="text-xs px-1.5 py-0.5 rounded" style={{ color: NEON.green }}>✓</button>
               <button onClick={() => setEditingId(null)} className="text-xs px-1.5 py-0.5 rounded" style={{ color: NEON.red }}>✗</button>
             </div>
           ) : (
             <span className="w-24 flex items-center gap-1 text-xs font-semibold" style={{ color: ROLE_COLORS[user.role] || '#666' }}>
               {user.role === 'admin' ? <ShieldCheck size={12} /> : <Shield size={12} />}{user.role}
             </span>
           )}
           <span className="w-32 hidden sm:block text-xs font-mono" style={{ color: '#555' }}>{user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</span>
           <div className="w-16 flex items-center gap-1">
             <button onClick={() => startEdit(user)} className="p-1 rounded transition" style={{ color: '#555' }}
>
               <UserIcon size={12} />
             </button>
             <button onClick={() => deleteUser(user.id)} className="p-1 rounded transition" style={{ color: '#555' }}
>
               <Trash2 size={12} />
             </button>
           </div>
         </div>
       ))}
     </div>
   </div>
 );
}
