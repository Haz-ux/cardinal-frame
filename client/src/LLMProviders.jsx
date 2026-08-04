import React, { useEffect, useState, useCallback, useMemo, memo } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { usePolling } from './usePolling';
import { Cpu, Plus, Trash2, Search, Key, RefreshCw, ToggleLeft, ToggleRight, Eye, EyeOff, Star, Zap, X, Download, ChevronDown, Check, Settings, Layers, FlipHorizontal, AlertTriangle } from 'lucide-react';

const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', teal:'#14b8a6', magenta:'#ff00ff' };
const PROVIDER_COLORS = { openai: NEON.green, google: '#4285f4', nvidia: '#76b900', anthropic: NEON.orange, openrouter: NEON.magenta, groq: NEON.orange, together: NEON.blue, deepseek: NEON.blue, mistral: NEON.orange, ollama: NEON.cyan, cerebras: NEON.purple, sambanova: NEON.pink, perplexity: '#20b2aa', xai: '#888', cohere: '#39d353' };

const CARD_BG = 'rgba(10,10,20,0.95)';
const CARD_BORDER = 'rgba(0,240,255,0.12)';

// ─── AddProviderModal ──────────────────────────────────────────────
function AddProviderModal({ onClose, onCreated }) {
 const [name, setName] = useState('');
 const [type, setType] = useState('openai');
 const [apiKey, setApiKey] = useState('');
 const [baseUrl, setBaseUrl] = useState('');
 const [loading, setLoading] = useState(false);
 const types = ['openai','google','nvidia','anthropic','openrouter','groq','together','deepseek','mistral','ollama','cerebras','sambanova','perplexity','xai','cohere'];
 const defaultUrls = { openai:'https://api.openai.com/v1', google:'https://generativelanguage.googleapis.com/v1beta', nvidia:'https://integrate.api.nvidia.com/v1', anthropic:'https://api.anthropic.com/v1', openrouter:'https://openrouter.ai/api/v1', groq:'https://api.groq.com/openai/v1', together:'https://api.together.xyz/v1', deepseek:'https://api.deepseek.com/v1', mistral:'https://api.mistral.ai/v1', ollama:'http://localhost:11434', cerebras:'https://api.cerebras.ai/v1', sambanova:'https://api.sambanova.ai/v1', perplexity:'https://api.perplexity.ai', xai:'https://api.x.ai/v1', cohere:'https://api.cohere.ai/v1' };

 const handleSubmit = async (e) => {
 e.preventDefault(); if (!name.trim()) return; setLoading(true);
 try {
 await api('/api/llm/providers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, type, api_key: apiKey, base_url: baseUrl || undefined, enabled: !!apiKey }) });
 onCreated(); onClose();
 } catch (err) { console.error(err); }
 setLoading(false);
 };

 return (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
 <div className="w-full max-w-md rounded-xl p-6" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${NEON.cyan}30` }} onClick={e => e.stopPropagation()}>
 <h3 className="text-lg font-bold mb-4" style={{ color: NEON.cyan }}>Add LLM Provider</h3>
 <form onSubmit={handleSubmit} className="space-y-3">
 <div><label className="text-xs text-gray-400 mb-1 block">Provider Type</label>
 <div className="grid grid-cols-3 gap-1.5 max-h-48 overflow-y-auto p-1 rounded-lg bg-black/40" style={{ border: `1px solid ${NEON.cyan}15` }}>
 {types.map(t => (<button key={t} type="button" onClick={() => { setType(t); setBaseUrl(defaultUrls[t] || ''); }} className="px-2 py-1.5 text-xs rounded-lg transition-all capitalize hover:brightness-125" style={{ background: type === t ? `${PROVIDER_COLORS[t] || NEON.cyan}20` : 'rgba(0,0,0,0.3)', border: `1px solid ${type === t ? (PROVIDER_COLORS[t] || NEON.cyan) : '#222'}`, color: type === t ? (PROVIDER_COLORS[t] || NEON.cyan) : '#888' }}>{t}</button>))}
 </div></div>
 <div><label className="text-xs text-gray-400 mb-1 block">Display Name</label><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none" style={{ border: `1px solid ${NEON.cyan}20` }} placeholder="e.g. My OpenAI" /></div>
 <div><label className="text-xs text-gray-400 mb-1 block">API Key</label><input value={apiKey} onChange={e => setApiKey(e.target.value)} type="password" className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none font-mono" style={{ border: `1px solid ${NEON.cyan}20` }} placeholder="sk-..." /></div>
 <div><label className="text-xs text-gray-400 mb-1 block">Base URL <span className="text-gray-600">(auto-filled)</span></label><input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className="w-full px-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none font-mono" style={{ border: `1px solid ${NEON.cyan}20` }} placeholder={defaultUrls[type]} /></div>
 <div className="flex gap-2 pt-2">
 <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm bg-black/40 border border-gray-700 text-gray-400">Cancel</button>
 <button type="submit" disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${NEON.cyan}20`, border: `1px solid ${NEON.cyan}40`, color: NEON.cyan }}>{loading ? 'Adding...' : 'Add Provider'}</button>
 </div>
 </form>
 </div>
 </div>
 );
}

function EditKeyModal({ provider, onClose, onSaved }) {
 const [apiKey, setApiKey] = useState('');
 const [showKey, setShowKey] = useState(false);
 const [loading, setLoading] = useState(false);
 const handleSubmit = async (e) => {
 e.preventDefault(); setLoading(true);
 try { await api(`/api/llm/providers/${provider.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: apiKey }) }); onSaved(); onClose(); } catch (err) { console.error(err); }
 setLoading(false);
 };
 const color = PROVIDER_COLORS[provider.type] || NEON.cyan;
 return (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
 <div className="w-full max-w-sm rounded-xl p-6" style={{ background: 'rgba(10,10,20,0.98)', border: `1px solid ${color}30` }} onClick={e => e.stopPropagation()}>
 <h3 className="text-lg font-bold mb-4" style={{ color }}>{provider.name} — API Key</h3>
 <form onSubmit={handleSubmit} className="space-y-3">
 <div className="relative"><input value={apiKey} onChange={e => setApiKey(e.target.value)} type={showKey ? 'text' : 'password'} className="w-full px-3 py-2 pr-10 rounded-lg text-sm text-white bg-black/40 outline-none font-mono" style={{ border: `1px solid ${color}20` }} placeholder="Enter API key..." /><button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-300">{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></div>
 <div className="flex gap-2 pt-2"><button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg text-sm bg-black/40 border border-gray-700 text-gray-400">Cancel</button><button type="submit" disabled={loading || !apiKey} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: `${color}20`, border: `1px solid ${color}40`, color }}>{loading ? 'Saving...' : 'Save Key'}</button></div>
 </form>
 </div>
 </div>
 );
}

// ─── Model Selector Dropdown ───────────────────────────────────────
const ModelSelector = memo(function ModelSelector({ providers, models, defaultModel, onSetDefault, onDeleteModel, onDetectProvider, detecting }) {
  const [selProviderId, setSelProviderId] = useState('');
  const [selModelId, setSelModelId] = useState('');
  const [openProvider, setOpenProvider] = useState(false);
  const [openModel, setOpenModel] = useState(false);

  const selectedProvider = useMemo(() => providers.find(p => p.id === selProviderId), [providers, selProviderId]);

  const filteredModels = useMemo(() => {
  if (!selProviderId) return models;
  return models.filter(m => m.provider_id === selProviderId);
  }, [models, selProviderId]);

  const selectedModel = useMemo(() => models.find(m => m.id === selModelId), [models, selModelId]);

  useEffect(() => {
  const handler = () => { setOpenProvider(false); setOpenModel(false); };
  document.addEventListener('click', handler);
  return () => document.removeEventListener('click', handler);
  }, []);

  const handleProviderSelect = (p) => {
  setSelProviderId(p.id); setSelModelId(''); setOpenProvider(false); setOpenModel(true);
  // Auto-detect available models for the selected provider (needs a key).
  if (p?.id && p?.has_key && !detecting[p.id]) {
  onDetectProvider(p);
  }
  };
  const handleModelSelect = (m) => { setSelModelId(m.id); setOpenModel(false); };
  const clearFilter = () => { setSelProviderId(''); setSelModelId(''); };

 return (
 <div className="rounded-xl p-5" style={{ background: CARD_BG, border: `1px solid ${NEON.cyan}18` }}>
 <div className="flex items-center gap-2 mb-4">
 <Settings size={16} style={{ color: NEON.cyan, filter: `drop-shadow(0 0 4px ${NEON.cyan})` }} />
 <span className="text-sm font-bold" style={{ color: '#ccc' }}>Model Selector</span>
 {defaultModel && (
 <span className="ml-auto flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.yellow}12`, border: `1px solid ${NEON.yellow}25`, color: NEON.yellow }}>
 <Star size={10} /> Default: {defaultModel.display_name || defaultModel.model_id}
 </span>
 )}
 </div>

 <div className="flex flex-wrap items-center gap-3">
 <div className="relative flex-1 min-w-[180px]">
 <button onClick={(e) => { e.stopPropagation(); setOpenProvider(!openProvider); setOpenModel(false); }} className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm text-left" style={{ background: 'rgba(0,0,0,0.5)', border: `1px solid ${NEON.cyan}25`, color: selProviderId ? '#fff' : '#666' }}>
  <span className="flex items-center gap-2"><Cpu size={13} style={{ color: NEON.cyan }} />{selProviderId ? (providers.find(p => p.id === selProviderId)?.name || 'Provider') : 'All Providers'}</span>
 <ChevronDown size={14} style={{ color: '#555', transform: openProvider ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
 </button>
 {openProvider && (
 <div className="absolute z-20 mt-1 w-full rounded-lg py-1 overflow-hidden" style={{ background: 'rgba(8,8,18,0.98)', border: `1px solid ${NEON.cyan}25`, boxShadow: `0 8px 32px rgba(0,0,0,0.6)` }}>
  <button onClick={(e) => { e.stopPropagation(); handleProviderSelect({ id: '' }); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5 text-gray-300" style={{ borderBottom: `1px solid rgba(255,255,255,0.04)` }}><Cpu size={13} style={{ color: NEON.cyan }} /> All Providers{!selProviderId && <Check size={13} className="ml-auto" style={{ color: NEON.cyan }} />}</button>
  {providers.map(p => { const color = PROVIDER_COLORS[p.type] || NEON.cyan; return (<button key={p.id} onClick={(e) => { e.stopPropagation(); handleProviderSelect(p); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5 text-gray-200" style={{ borderBottom: `1px solid rgba(255,255,255,0.04)` }}><span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.has_key ? color : '#555', boxShadow: p.has_key ? `0 0 4px ${color}60` : 'none' }} /><span className="flex-1 text-left">{p.name}</span><span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded" style={{ background: `${color}12`, color, border: `1px solid ${color}25` }}>{p.type}</span>{!p.has_key && <span className="text-[9px] text-gray-600">no key</span>}{selProviderId === p.id && <Check size={13} style={{ color }} />}</button>); })}
 </div>
 )}
 </div>
 <div className="relative flex-[2] min-w-[260px]">
 <button onClick={(e) => { e.stopPropagation(); setOpenModel(!openModel); setOpenProvider(false); }} className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm text-left" style={{ background: 'rgba(0,0,0,0.5)', border: `1px solid ${NEON.cyan}25`, color: selModelId ? '#fff' : '#666' }}>
 <span className="flex items-center gap-2 truncate"><Star size={13} style={{ color: selectedModel?.is_default ? NEON.yellow : '#555' }} />{selectedModel ? (selectedModel.display_name || selectedModel.model_id) : 'Select a model...'}</span>
 <ChevronDown size={14} style={{ color: '#555', transform: openModel ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
 </button>
 {openModel && filteredModels.length > 0 && (
 <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg py-1" style={{ background: 'rgba(8,8,18,0.98)', border: `1px solid ${NEON.cyan}25`, boxShadow: `0 8px 32px rgba(0,0,0,0.6)`, scrollbarWidth: 'thin', scrollbarColor: `${NEON.cyan}22 transparent` }}>
 {filteredModels.map(m => { const pColor = PROVIDER_COLORS[providers.find(p => p.id === m.provider_id)?.type] || NEON.cyan; return (<button key={m.id} onClick={() => handleModelSelect(m)} className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/5 text-gray-200" style={{ borderBottom: `1px solid rgba(255,255,255,0.04)` }}>{m.is_default ? <Star size={11} style={{ color: NEON.yellow }} /> : <span className="w-3" />}<span className="flex-1 text-left truncate font-mono text-xs">{m.display_name || m.model_id}</span><span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${pColor}12`, color: pColor, border: `1px solid ${pColor}25` }}>{m.provider_name}</span>{m.context_window && <span className="text-[10px] text-gray-500">{(m.context_window/1000).toFixed(0)}k</span>}{selModelId === m.id && <Check size={13} style={{ color: NEON.cyan }} />}</button>); })}
 </div>
 )}
  {openModel && filteredModels.length === 0 && (<div className="absolute z-20 mt-1 w-full rounded-lg p-4 text-center text-xs text-gray-500" style={{ background: 'rgba(8,8,18,0.98)', border: `1px solid ${NEON.cyan}25` }}>{selProviderId && detecting[selProviderId] ? <span style={{ color: NEON.cyan }}><RefreshCw size={12} className="inline animate-spin mr-1" />Detecting models...</span> : selProviderId && !selectedProvider?.has_key ? 'Add an API key to this provider to detect models' : selProviderId ? 'No models detected yet' : 'Select a provider to detect its models'}</div>)}
 </div>
 {selectedModel && (
 <div className="flex items-center gap-2">
 {!selectedModel.is_default && (<button onClick={() => onSetDefault(selectedModel.id)} className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:brightness-125" style={{ background: `${NEON.yellow}12`, border: `1px solid ${NEON.yellow}30`, color: NEON.yellow }}><Star size={12} /> Set Default</button>)}
 {selectedModel.is_default && (<span className="flex items-center gap-1 px-3 py-2 text-xs font-semibold" style={{ color: NEON.yellow }}><Check size={12} /> Active Default</span>)}
 <button onClick={() => onDeleteModel(selectedModel.id)} className="p-2 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all"><Trash2 size={13} /></button>
 </div>
 )}
 {selProviderId && (<button onClick={clearFilter} className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1">Clear filter</button>)}
 </div>
 </div>
 );
});

// ─── Flip Card Provider (front = provider info, back = model list) ─
const FlipProviderCard = memo(function FlipProviderCard({ provider, providerModels, onToggle, onDelete, onEditKey, onDetect, isDetecting, onSetDefault, onDeleteModel }) {
 const color = PROVIDER_COLORS[provider.type] || NEON.cyan;
 const [flipped, setFlipped] = useState(false);

 return (
 <div className="relative" style={{ perspective: '1000px', minHeight: 140 }}>
 <div className="transition-transform duration-500" style={{ transformStyle: 'preserve-3d', transform: flipped ? 'rotateY(180deg)' : 'rotateY(0)', position: 'relative' }}>
  {/* Front face */}
  <div className="rounded-xl p-3.5 transition-all group" style={{ backfaceVisibility: 'hidden', background: `linear-gradient(135deg, rgba(10,10,20,0.9), rgba(${color === NEON.green ? '34,197,94' : color === NEON.blue ? '59,130,246' : color === NEON.orange ? '249,115,22' : '0,240,255'},0.03))`, border: `1px solid ${color}20` }}>
  <div className="flex items-center justify-between mb-2">
  <div className="flex items-center gap-2">
  <span className="w-2 h-2 rounded-full" style={{ background: provider.enabled && provider.has_key ? NEON.green : '#555', boxShadow: provider.enabled && provider.has_key ? `0 0 6px ${NEON.green}` : 'none' }} />
  <span className="font-semibold text-sm text-gray-200">{provider.name}</span>
  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase" style={{ background: `${color}12`, color, border: `1px solid ${color}25` }}>{provider.type}</span>
  </div>
  <div className="flex items-center gap-1">
  <button onClick={() => setFlipped(true)} title="Show models" className="p-1 rounded text-gray-500 hover:text-cyan-400 hover:bg-white/5 transition-colors"><Layers size={12} /></button>
  <button onClick={() => onToggle(provider)} title={provider.enabled ? 'Disable' : 'Enable'}>{provider.enabled ? <ToggleRight size={16} style={{ color: NEON.green }} /> : <ToggleLeft size={16} className="text-gray-500" />}</button>
  <button onClick={() => onDelete(provider.id)} title="Delete" className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-white/5"><Trash2 size={12} /></button>
  </div>
  </div>
  <div className="flex items-center gap-3 text-xs mb-2">
  <button onClick={() => onEditKey(provider)} className="flex items-center gap-1 px-2 py-0.5 rounded-lg hover:bg-white/5 transition-colors" style={{ color: provider.has_key ? NEON.green : NEON.red }}><Key size={10} />{provider.has_key ? 'Key set' : 'No key'}</button>
  <span className="text-gray-500">{providerModels.length} models</span>
  </div>
  {provider.has_key && provider.enabled && (
  <button onClick={() => onDetect(provider)} disabled={isDetecting} className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-all hover:brightness-125 w-full" style={{ background: `${color}10`, border: `1px solid ${color}25`, color }}>
  <RefreshCw size={10} className={isDetecting ? 'animate-spin' : ''} /> {isDetecting ? 'Detecting...' : 'Detect Models'}
  </button>
  )}
  </div>

  {/* Back face — models */}
  <div className="rounded-xl p-3.5 absolute inset-0" style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)', background: `linear-gradient(135deg, rgba(10,10,20,0.95), rgba(${color === NEON.green ? '34,197,94' : color === NEON.blue ? '59,130,246' : color === NEON.orange ? '249,115,22' : '0,240,255'},0.05))`, border: `1px solid ${color}30`, overflow: 'hidden' }}>
  <div className="flex items-center justify-between mb-2">
  <div className="flex items-center gap-2">
  <span className="w-2 h-2 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
  <span className="font-semibold text-xs text-gray-200 truncate">{provider.name}</span>
  <span className="text-[10px] text-gray-500">{providerModels.length} models</span>
  </div>
  <button onClick={() => setFlipped(false)} className="p-1 rounded text-gray-500 hover:text-cyan-400 hover:bg-white/5"><FlipHorizontal size={12} /></button>
  </div>
  <div className="overflow-y-auto max-h-36 space-y-0.5" style={{ scrollbarWidth: 'thin', scrollbarColor: `${color}22 transparent` }}>
  {providerModels.length === 0 ? (
  <div className="text-[10px] text-gray-600 text-center py-4">No models detected</div>
  ) : providerModels.map(m => (
  <div key={m.id} className="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-white/5 transition-colors group/model">
  {m.is_default ? <Star size={9} style={{ color: NEON.yellow, filter: `drop-shadow(0 0 3px ${NEON.yellow})` }} /> : <span className="w-[9px]" />}
  <span className="flex-1 truncate text-[11px] font-mono text-gray-300">{m.display_name || m.model_id}</span>
  {m.context_window && <span className="text-[9px] text-gray-500">{(m.context_window/1000).toFixed(0)}k</span>}
  <div className="opacity-0 group-hover/model:opacity-100 flex items-center gap-0.5 transition-opacity">
  {!m.is_default && <button onClick={() => onSetDefault(m.id)} className="p-0.5 text-gray-600 hover:text-yellow-400"><Star size={9} /></button>}
  <button onClick={() => onDeleteModel(m.id)} className="p-0.5 text-gray-600 hover:text-red-400"><Trash2 size={9} /></button>
  </div>
  </div>
  ))}
  </div>
  </div>
 </div>
 </div>
 );
});

// ─── Main LLMProviders ─────────────────────────────────────────────
export default function LLMProviders() {
 const [providers, setProviders] = useState([]);
 const [models, setModels] = useState([]);
 const [defaultModel, setDefaultModel] = useState(null);
 const [search, setSearch] = useState('');
 const [showAdd, setShowAdd] = useState(false);
  const [editKeyProvider, setEditKeyProvider] = useState(null);
  const [detecting, setDetecting] = useState({});
  const [detectError, setDetectError] = useState(null);

 const load = useCallback(() => {
 cachedFetch('/api/llm/providers').then(setProviders).catch(() => {});
 cachedFetch('/api/llm/models').then(setModels).catch(() => {});
 cachedFetch('/api/llm/models/default').then(setDefaultModel).catch(() => {});
 }, []);

 usePolling(load, 60000);

 const seedProviders = async () => {
 try { await api('/api/llm/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); load(); } catch (err) { console.error(err); }
 };

 const detectModels = async (provider) => {
 setDetecting(prev => ({ ...prev, [provider.id]: true }));
 setDetectError(null);
 try { await api(`/api/llm/providers/${provider.id}/detect`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }); load(); } catch (err) {
 const msg = err?.message || '';
 if (msg.includes('Provider API returned 401')) {
 setDetectError(`${provider.name} rejected the API key — check it's correct and active`);
 } else if (msg.includes('Provider API returned')) {
 setDetectError(`${provider.name} error: ${msg}`);
 } else if (msg.includes('timeout') || msg.includes('aborted')) {
 setDetectError(`${provider.name} is unreachable — check the base URL or network`);
 } else {
 setDetectError(msg || 'Detection failed');
 }
 }
 setDetecting(prev => ({ ...prev, [provider.id]: false }));
 };

 const detectAll = async () => {
 setDetectError(null);
 try { await api('/api/llm/detect-all', { method: 'POST', headers: { 'Content-Type': 'application/json' } }); load(); } catch (err) {
 const msg = err?.message || '';
 if (msg.includes('Provider API returned 401')) {
 setDetectError('One or more providers rejected their API key — check keys are correct');
 } else {
 setDetectError(msg || 'Detection failed for some providers');
 }
 }
 };

 const toggleProvider = async (provider) => {
 await api(`/api/llm/providers/${provider.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !provider.enabled }) }); load();
 };

 const deleteProvider = async (id) => { await api(`/api/llm/providers/${id}`, { method: 'DELETE' }); load(); };

 const setDefault = async (modelId) => { await api('/api/llm/models/set-default', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: modelId }) }); load(); };

 const deleteModel = async (id) => { await api('/api/llm/models/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: id }) }); load(); };

 const filteredProviders = useMemo(() => providers.filter(p => !search || (p.name || '').toLowerCase().includes(search.toLowerCase()) || (p.type || '').toLowerCase().includes(search.toLowerCase())), [providers, search]);
 const filteredModels = useMemo(() => models.filter(m => !search || (m.model_id || '').toLowerCase().includes(search.toLowerCase()) || (m.display_name || '').toLowerCase().includes(search.toLowerCase()) || (m.provider_name || '').toLowerCase().includes(search.toLowerCase())), [models, search]);
 const modelsByProvider = useMemo(() => {
 const map = {};
 for (const m of filteredModels) { if (!map[m.provider_id]) map[m.provider_id] = []; map[m.provider_id].push(m); }
 return map;
 }, [filteredModels]);

 return (
 <div className="space-y-5">
 {showAdd && <AddProviderModal onClose={() => setShowAdd(false)} onCreated={load} />}
 {editKeyProvider && <EditKeyModal provider={editKeyProvider} onClose={() => setEditKeyProvider(null)} onSaved={load} />}

 {/* Header */}
 <div className="flex items-center justify-between flex-wrap gap-3">
 <div className="flex items-center gap-3">
 <Cpu size={20} style={{ color: NEON.cyan, filter: `drop-shadow(0 0 6px ${NEON.cyan})` }} />
 <h2 className="text-xl font-bold" style={{ color: NEON.cyan, textShadow: `0 0 15px ${NEON.cyan}44` }}>LLM Models</h2>
 <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.cyan}12`, color: NEON.cyan, border: `1px solid ${NEON.cyan}25` }}>{models.length} models · {providers.length} providers</span>
 </div>
 <div className="flex items-center gap-2">
 {providers.length === 0 && <button onClick={seedProviders} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold hover:brightness-125 transition-all" style={{ background: `${NEON.purple}12`, border: `1px solid ${NEON.purple}25`, color: NEON.purple }}><Download size={14} /> Seed All Providers</button>}
 {providers.some(p => p.enabled && p.has_key) && <button onClick={detectAll} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold hover:brightness-125 transition-all" style={{ background: `${NEON.green}12`, border: `1px solid ${NEON.green}25`, color: NEON.green }}><RefreshCw size={14} /> Detect All</button>}
 <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold hover:brightness-125 transition-all" style={{ background: `${NEON.cyan}12`, border: `1px solid ${NEON.cyan}25`, color: NEON.cyan }}><Plus size={14} /> Add Provider</button>
 </div>
 </div>

 {/* Search */}
 <div className="relative max-w-sm">
 <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
 <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search providers & models..." className="w-full pl-9 pr-3 py-2 rounded-lg text-sm text-white bg-black/40 outline-none transition-colors" style={{ border: `1px solid ${NEON.cyan}15` }} />
 </div>

 {/* Detect Error Banner */}
 {detectError && (
 <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm" style={{ background: `${NEON.red}10`, border: `1px solid ${NEON.red}30`, color: NEON.red }}>
 <AlertTriangle size={14} /> {detectError}
 <button onClick={() => setDetectError(null)} className="ml-auto text-gray-500 hover:text-gray-300"><X size={14} /></button>
 </div>
 )}

 {/* Model Selector Dropdown */}
  <ModelSelector providers={providers} models={filteredModels} defaultModel={defaultModel} onSetDefault={setDefault} onDeleteModel={deleteModel} onDetectProvider={detectModels} detecting={detecting} />

 {/* Providers Grid — Flip Cards */}
 <div>
 <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2"><FlipHorizontal size={14} style={{ color: NEON.cyan }} />Providers <span className="text-[10px] text-gray-600 normal-case">(click layers icon to see models)</span></h3>
 {filteredProviders.length === 0 ? (
 <div className="text-center py-8 text-gray-600"><Cpu size={32} className="mx-auto mb-2 opacity-30" />No providers configured. Add one or seed defaults.</div>
 ) : (
 <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
 {filteredProviders.map(provider => (
 <FlipProviderCard
 key={provider.id}
 provider={provider}
 providerModels={modelsByProvider[provider.id] || []}
 onToggle={toggleProvider}
 onDelete={deleteProvider}
 onEditKey={setEditKeyProvider}
 onDetect={detectModels}
 isDetecting={detecting[provider.id]}
 onSetDefault={setDefault}
 onDeleteModel={deleteModel}
 />
 ))}
 </div>
 )}
 </div>
 </div>
 );
}
