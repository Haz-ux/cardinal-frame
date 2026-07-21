import React, { useEffect, useState } from 'react';
import { api } from './AuthContext';
import { Folder, Upload, Trash2, Search, File as FileIcon, Eye, ChevronDown, ChevronUp, FileText, Image, Code } from 'lucide-react';
const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6' };
function formatSize(bytes) {
 if (!bytes || bytes === 0) return '—';
 const k = 1024;
 const sizes = ['B', 'KB', 'MB', 'GB'];
 const i = Math.floor(Math.log(bytes) / Math.log(k));
 return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
function getFileIcon(name) {
 const ext = (name || '').split('.').pop()?.toLowerCase();
 if (['jpg','png','gif','webp','svg'].includes(ext)) return <Image size={14} style={{ color: NEON.pink }} />;
 if (['js','jsx','ts','tsx','py','mjs','json','yaml','yml'].includes(ext)) return <Code size={14} style={{ color: NEON.blue }} />;
 if (['txt','md','log','csv'].includes(ext)) return <FileText size={14} style={{ color: NEON.teal }} />;
 return <FileIcon size={14} style={{ color: '#555' }} />;
}
export default function Files() {
 const [files, setFiles] = useState([]);
 const [search, setSearch] = useState('');
 const [previewName, setPreviewName] = useState(null);
 const [previewContent, setPreviewContent] = useState('');
 const [uploading, setUploading] = useState(false);
 const fileInputRef = React.useRef(null);
 const load = () => api('/api/files').then(setFiles).catch(() => {});
 useEffect(() => { load(); }, []);
 const filtered = files.filter(f => {
   if (search && !(f.name || '').toLowerCase().includes(search.toLowerCase())) return false;
   return true;
 });
 const deleteFile = async (name) => {
   if (!confirm(`Delete "${name}"?`)) return;
   await api(`/api/files/${name}`, { method: 'DELETE' }); load();
   if (previewName === name) { setPreviewName(null); setPreviewContent(''); }
 };
 const previewFile = async (name) => {
   if (previewName === name) { setPreviewName(null); setPreviewContent(''); return; }
   try {
     const resp = await fetch(`/api/files/${name}`);
     const text = await resp.text();
     setPreviewName(name);
     setPreviewContent(text.slice(0, 5000));
   } catch { setPreviewName(name); setPreviewContent('[Preview unavailable]'); }
 };
 const handleUpload = async (e) => {
   const file = e.target.files?.[0];
   if (!file) return;
   setUploading(true);
   try {
     const formData = new FormData();
     formData.append('file', file);
     await fetch('/api/files/upload', { method: 'POST', body: formData });
     load();
   } catch (err) { console.error(err); }
   setUploading(false);
   if (fileInputRef.current) fileInputRef.current.value = '';
 };
 return (
   <div className="space-y-4">
     {/* Header */}
     <div className="flex items-center justify-between flex-wrap gap-3">
       <div className="flex items-center gap-3">
         <Folder size={20} style={{ color: NEON.teal, filter: `drop-shadow(0 0 6px ${NEON.teal})` }} />
         <h2 className="text-xl font-bold" style={{ color: NEON.teal, textShadow: `0 0 15px ${NEON.teal}44` }}>Files</h2>
         <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.teal}15`, color: NEON.teal, border: `1px solid ${NEON.teal}30` }}>{files.length}</span>
       </div>
       <div>
         <input type="file" ref={fileInputRef} onChange={handleUpload} className="hidden" />
         <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold"
           style={{ background: `${NEON.teal}15`, border: `1px solid ${NEON.teal}30`, color: NEON.teal }}>
           <Upload size={14} /> {uploading ? 'Uploading...' : 'Upload File'}
         </button>
       </div>
     </div>
     {/* Search */}
     <div className="relative max-w-sm">
       <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#555' }} />
       <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search files..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white"
         style={{ background: 'rgba(0,0,0,0.4)', border: `1px solid ${NEON.teal}15`, outline: 'none' }} />
     </div>
     {/* File list */}
     <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.9)', border: '1px solid rgba(0,240,255,0.1)' }}>
       {filtered.length === 0 ? (
         <div className="text-center py-12" style={{ color: '#444' }}><Folder size={32} className="mx-auto mb-2 opacity-30" />No files uploaded.</div>
       ) : filtered.map(file => (
         <div key={file.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
           <div className="flex items-center gap-3 px-4 py-2.5 transition-colors cursor-pointer"


             onClick={() => previewFile(file.name)}>
             {getFileIcon(file.name)}
             <span className="flex-1 text-sm truncate" style={{ color: '#ddd' }}>{file.name}</span>
             <span className="text-xs hidden sm:block" style={{ color: '#555' }}>{formatSize(file.size)}</span>
             <span className="text-[10px] font-mono hidden md:block" style={{ color: '#444' }}>{file.modified ? new Date(file.modified).toLocaleDateString() : '—'}</span>
             <button onClick={(e) => { e.stopPropagation(); previewFile(file.name); }} className="p-1 rounded transition" style={{ color: '#555' }}
>
               <Eye size={14} />
             </button>
             <button onClick={(e) => { e.stopPropagation(); deleteFile(file.name); }} className="p-1 rounded transition" style={{ color: '#555' }}
>
               <Trash2 size={14} />
             </button>
           </div>
           {previewName === file.name && (
             <div className="px-4 py-3" style={{ background: 'rgba(0,0,0,0.3)' }}>
               <pre className="text-xs p-3 rounded overflow-auto max-h-64 font-mono" style={{ background: 'rgba(0,0,0,0.4)', color: '#bbb', border: '1px solid rgba(0,240,255,0.08)' }}>
                 {previewContent}
               </pre>
             </div>
           )}
         </div>
       ))}
     </div>
   </div>
 );
}
