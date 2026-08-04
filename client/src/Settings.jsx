import React, { useEffect, useState, useCallback, memo, useMemo } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { usePolling } from './usePolling';
import { Shield, Key, Eye, EyeOff, Plus, Trash2, RefreshCw, Save, AlertTriangle, CheckCircle, Zap, Server, Globe, Cpu, Bot, Search, Wifi, WifiOff, ChevronDown, Terminal, ToggleLeft, ToggleRight } from 'lucide-react';

const NEON = { cyan:'#00f0ff', blue:'#3b82f6', green:'#22c55e', yellow:'#eab308', red:'#ef4444', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', magenta:'#ff00ff', teal:'#14b8a6' };

const CATEGORIES = [
  { key: 'llm', label: 'LLM Providers', icon: Cpu, color: NEON.cyan },
  { key: 'api', label: 'API Keys', icon: Key, color: NEON.yellow },
  { key: 'system', label: 'System', icon: Server, color: NEON.purple },
  { key: 'web', label: 'Web & Search', icon: Globe, color: NEON.green },
  { key: 'agent', label: 'Agent Config', icon: Bot, color: NEON.blue },
];

// ─── Known LLM provider presets ────────────────────────────────────
const LLM_PRESETS = [
  { type: 'openai',     label: 'OpenAI',         color: NEON.green,   envKey: 'OPENAI_API_KEY',       baseUrl: 'https://api.openai.com/v1' },
  { type: 'anthropic',  label: 'Anthropic',      color: NEON.orange,  envKey: 'ANTHROPIC_API_KEY',    baseUrl: 'https://api.anthropic.com/v1' },
  { type: 'google',     label: 'Google AI',      color: '#4285f4',    envKey: 'GOOGLE_API_KEY',       baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { type: 'nvidia',     label: 'NVIDIA NIM',     color: '#76b900',    envKey: 'NVIDIA_API_KEY',       baseUrl: 'https://integrate.api.nvidia.com/v1' },
  { type: 'openrouter', label: 'OpenRouter',     color: NEON.magenta, envKey: 'OPENROUTER_API_KEY',   baseUrl: 'https://openrouter.ai/api/v1' },
  { type: 'groq',       label: 'Groq',           color: NEON.orange,  envKey: 'GROQ_API_KEY',         baseUrl: 'https://api.groq.com/openai/v1' },
  { type: 'together',   label: 'Together AI',    color: NEON.blue,    envKey: 'TOGETHER_API_KEY',     baseUrl: 'https://api.together.xyz/v1' },
  { type: 'deepseek',   label: 'DeepSeek',       color: NEON.blue,    envKey: 'DEEPSEEK_API_KEY',     baseUrl: 'https://api.deepseek.com/v1' },
  { type: 'mistral',    label: 'Mistral',        color: NEON.orange,  envKey: 'MISTRAL_API_KEY',      baseUrl: 'https://api.mistral.ai/v1' },
  { type: 'xai',        label: 'xAI (Grok)',     color: '#888',       envKey: 'XAI_API_KEY',          baseUrl: 'https://api.x.ai/v1' },
  { type: 'perplexity', label: 'Perplexity',     color: '#20b2aa',    envKey: 'PERPLEXITY_API_KEY',   baseUrl: 'https://api.perplexity.ai' },
  { type: 'cohere',     label: 'Cohere',         color: '#39d353',    envKey: 'COHERE_API_KEY',       baseUrl: 'https://api.cohere.ai/v1' },
  { type: 'ollama',     label: 'Ollama (Local)', color: NEON.cyan,    envKey: '',                     baseUrl: 'http://localhost:11434', local: true },
];

// ─── Provider Key Card ─────────────────────────────────────────────
const ProviderKeyCard = memo(function ProviderKeyCard({ preset, existingKeys, onSave, onTest, ollamaStatus }) {
  const isLocal = preset.local;
  const existingKey = existingKeys.find(k => k.key === preset.envKey);
  const hasKey = !!existingKey || isLocal;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [showVal, setShowVal] = useState(false);
  const [testing, setTesting] = useState(false);

  if (isLocal) {
    // Ollama card — show connection status
    const connected = ollamaStatus?.connected;
    const modelCount = ollamaStatus?.modelCount ?? 0;
    return (
      <div className="rounded-xl p-3.5 flex items-center gap-3 transition-all hover:brightness-110" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${connected ? NEON.cyan + '30' : '#333'}` }}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-lg" style={{ background: `${preset.color}15`, border: `1px solid ${preset.color}30` }}>🦙</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{preset.label}</span>
            {connected ? (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: `${NEON.green}15`, color: NEON.green, border: `1px solid ${NEON.green}30` }}><Wifi size={8} /> Connected</span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: `${NEON.red}15`, color: NEON.red, border: `1px solid ${NEON.red}30` }}><WifiOff size={8} /> Offline</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {connected ? `${modelCount} model${modelCount !== 1 ? 's' : ''} available · Plug & Play` : 'Not detected — install Ollama to enable'}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onTest('ollama')} disabled={testing} className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors" style={{ color: NEON.cyan }}>
            {testing ? <RefreshCw size={10} className="animate-spin" /> : <Zap size={10} />} Detect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl p-3.5 transition-all hover:brightness-110" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${hasKey ? preset.color + '25' : '#333'}` }}>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold" style={{ background: `${preset.color}15`, color: preset.color, border: `1px solid ${preset.color}30` }}>
          {preset.label.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{preset.label}</span>
            {hasKey ? (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: `${NEON.green}12`, color: NEON.green, border: `1px solid ${NEON.green}25` }}><Key size={8} /> Key set</span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: `${NEON.red}10`, color: NEON.red, border: `1px solid ${NEON.red}20` }}>No key</span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">{preset.envKey}</div>
        </div>
        <div className="flex items-center gap-1">
          {!editing ? (
            <>
              <button onClick={() => { setEditing(true); setVal(''); }} className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors" style={{ color: hasKey ? NEON.green : NEON.yellow }}>
                {hasKey ? 'Replace' : 'Add Key'}
              </button>
              {hasKey && <button onClick={() => { setTesting(true); onTest(preset.envKey).finally(() => setTesting(false)); }} disabled={testing} className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors" style={{ color: NEON.cyan }}>{testing ? <RefreshCw size={10} className="animate-spin" /> : <Zap size={10} />} Test</button>}
            </>
          ) : (
            <div className="flex items-center gap-1.5">
              <input value={val} onChange={e => setVal(e.target.value)} type={showVal ? 'text' : 'password'} placeholder="sk-..." className="w-44 px-2 py-1 rounded text-xs font-mono bg-black/50 text-white outline-none" style={{ border: `1px solid ${preset.color}30` }} autoFocus />
              <button onClick={() => setShowVal(!showVal)} className="p-1 text-gray-500 hover:text-gray-300">{showVal ? <EyeOff size={11} /> : <Eye size={11} />}</button>
              <button onClick={() => { onSave(preset.envKey, val, 1, 'llm'); setEditing(false); }} disabled={!val} className="px-2 py-1 rounded text-xs font-semibold" style={{ background: `${NEON.green}15`, border: `1px solid ${NEON.green}30`, color: NEON.green, opacity: val ? 1 : 0.4 }}><Save size={10} /></button>
              <button onClick={() => setEditing(false)} className="px-2 py-1 rounded text-xs text-gray-500 hover:text-gray-300">✕</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// ─── VarRow for non-LLM vars ───────────────────────────────────────
const CATEGORY_META = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

const VarRow = memo(function VarRow({ v, onSave, onDelete, onTest }) {
 const [editing, setEditing] = useState(false);
 const [val, setVal] = useState(v.value || '');
 const [showVal, setShowVal] = useState(false);
 const [testing, setTesting] = useState(false);
 const isSecret = v.encrypted || v.key.toLowerCase().includes('key') || v.key.toLowerCase().includes('secret') || v.key.toLowerCase().includes('token') || v.key.toLowerCase().includes('password');
 const catMeta = CATEGORY_META[v.category];
 const catColor = catMeta?.color || NEON.purple;
 const CatIcon = catMeta?.icon || Key;
 const displayVal = isSecret && !showVal ? '••••••••••••••••' : v.value;

 return (
 <div className="group px-4 py-3 hover:bg-white/[0.02] transition-all" style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
 <div className="flex items-center gap-3">
 {/* Category icon */}
 <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ background: `${catColor}10`, border: `1px solid ${catColor}20` }}>
 <CatIcon size={12} style={{ color: catColor }} />
 </div>
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2">
 <span className="font-mono text-sm text-gray-200 truncate">{v.key}</span>
 {isSecret && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: `${NEON.yellow}10`, color: NEON.yellow, border: `1px solid ${NEON.yellow}20` }}>🔒 secret</span>}
 {v.category && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: `${catColor}10`, color: catColor, border: `1px solid ${catColor}20` }}>{v.category}</span>}
 </div>
 {editing ? (
 <div className="flex items-center gap-2 mt-2">
 <input value={val} onChange={e => setVal(e.target.value)} type={isSecret && !showVal ? 'password' : 'text'} className="flex-1 px-2.5 py-1.5 rounded-lg text-xs font-mono bg-black/40 text-white outline-none focus:ring-1 focus:ring-cyan-500/30 transition-all" style={{ border: `1px solid ${NEON.cyan}30` }} autoFocus />
 {isSecret && <button onClick={() => setShowVal(!showVal)} className="p-1.5 rounded text-gray-500 hover:text-gray-300 hover:bg-white/5">{showVal ? <EyeOff size={12} /> : <Eye size={12} />}</button>}
 <button onClick={() => { onSave(v.key, val, v.encrypted, v.category); setEditing(false); }} className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all" style={{ background: `${NEON.green}15`, border: `1px solid ${NEON.green}30`, color: NEON.green }}><Save size={10} className="inline mr-1" />Save</button>
 <button onClick={() => setEditing(false)} className="px-2 py-1.5 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:bg-white/5">Cancel</button>
 </div>
 ) : (
 <div className="flex items-center gap-2 mt-0.5">
 <span className="text-xs font-mono text-gray-500 truncate max-w-[300px]">{displayVal}</span>
 {isSecret && <button onClick={() => setShowVal(!showVal)} className="p-0.5 text-gray-600 hover:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">{showVal ? <EyeOff size={10} /> : <Eye size={10} />}</button>}
 </div>
 )}
 </div>
 <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
 {!editing && <button onClick={() => { setEditing(true); setVal(v.value || ''); }} className="text-xs text-gray-500 hover:text-cyan-400 px-2 py-1 rounded hover:bg-white/5 transition-colors">Edit</button>}
 {isSecret && <button onClick={() => { setTesting(true); onTest(v.key).finally(() => setTesting(false)); }} disabled={testing} className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors" style={{ color: NEON.cyan }}>{testing ? <RefreshCw size={10} className="animate-spin" /> : <Zap size={10} />} Test</button>}
 <button onClick={() => onDelete(v.key)} className="p-1.5 rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"><Trash2 size={12} /></button>
 </div>
 </div>
 </div>
 );
});

// ─── Dev Settings (port, log level, debug, etc.) ───────────────────
const DevSettings = memo(function DevSettings({ showToast }) {
  const [settings, setSettings] = useState(null);
  const [editing, setEditing] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api('/api/settings/dev').then(setSettings).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!settings) return (
    <div className="rounded-xl p-5 text-center text-gray-600" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.green}10` }}>
      <Terminal size={24} className="mx-auto mb-2 opacity-30 animate-pulse" />
      Loading dev settings...
    </div>
  );

  const startEdit = (key) => setEditing(prev => ({ ...prev, [key]: true }));
  const cancelEdit = (key) => setEditing(prev => { const n = { ...prev }; delete n[key]; return n; });

  const handleSave = async (updates) => {
    setSaving(true);
    try {
      const r = await api('/api/settings/dev', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
      showToast(r.note || 'Dev settings saved', 'success');
      setEditing({});
      load();
    } catch (err) { showToast(err.message || 'Save failed', 'error'); }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      {/* Port Setting — read-only, fixed to 8080 */}
      <div className="rounded-xl p-4 flex items-center gap-4" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.green}15` }}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${NEON.green}10`, border: `1px solid ${NEON.green}20` }}>
          <Server size={16} style={{ color: NEON.green }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">Server Port</div>
          <div className="text-xs text-gray-500 mt-0.5">
            Current: <span className="font-mono" style={{ color: NEON.green }}>{settings.port}</span> ·
            Fixed to 8080 — set the PORT env var to override
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm font-mono font-bold" style={{ color: NEON.green }}>{settings.port}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.3)', color: '#666', border: '1px solid #1a1a1a' }}>LOCKED</span>
        </div>
      </div>

      {/* Log Level Setting */}
      <div className="rounded-xl p-4 flex items-center gap-4" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.purple}15` }}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${NEON.purple}10`, border: `1px solid ${NEON.purple}20` }}>
          <Terminal size={16} style={{ color: NEON.purple }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">Log Level</div>
          <div className="text-xs text-gray-500 mt-0.5">Controls server console verbosity</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {['error', 'warn', 'info', 'debug'].map(level => (
            <button
              key={level}
              onClick={() => handleSave({ logLevel: level })}
              className="px-2.5 py-1.5 rounded-lg text-xs font-mono font-semibold transition-all"
              style={{
                background: settings.logLevel === level ? `${NEON.purple}15` : 'transparent',
                border: `1px solid ${settings.logLevel === level ? NEON.purple + '40' : '#222'}`,
                color: settings.logLevel === level ? NEON.purple : '#555',
              }}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      {/* Debug Mode Toggle */}
      <div className="rounded-xl p-4 flex items-center gap-4" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.yellow}15` }}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${NEON.yellow}10`, border: `1px solid ${NEON.yellow}20` }}>
          {settings.debugMode ? <ToggleRight size={20} style={{ color: NEON.yellow }} /> : <ToggleLeft size={20} style={{ color: '#555' }} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">Debug Mode</div>
          <div className="text-xs text-gray-500 mt-0.5">Enables verbose logging + stack traces in error responses</div>
        </div>
        <button
          onClick={() => handleSave({ debugMode: !settings.debugMode })}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
          style={{
            background: settings.debugMode ? `${NEON.yellow}15` : 'rgba(0,0,0,0.3)',
            border: `1px solid ${settings.debugMode ? NEON.yellow + '30' : '#333'}`,
            color: settings.debugMode ? NEON.yellow : '#555',
          }}
        >
          {settings.debugMode ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Sandbox Timeout */}
      <div className="rounded-xl p-4 flex items-center gap-4" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.orange}15` }}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${NEON.orange}10`, border: `1px solid ${NEON.orange}20` }}>
          <Zap size={16} style={{ color: NEON.orange }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">Sandbox Timeout</div>
          <div className="text-xs text-gray-500 mt-0.5">Seconds before sandboxed code execution is killed</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {editing.sandboxTimeout !== undefined ? (
            <>
              <input
                type="number"
                value={editing.sandboxTimeout}
                onChange={e => setEditing(prev => ({ ...prev, sandboxTimeout: e.target.value }))}
                min="1" max="300"
                className="w-20 px-2.5 py-1.5 rounded-lg text-sm font-mono text-white bg-black/40 outline-none"
                style={{ border: `1px solid ${NEON.orange}30` }}
                autoFocus
              />
              <button onClick={() => handleSave({ sandboxTimeout: editing.sandboxTimeout })} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: `${NEON.green}15`, border: `1px solid ${NEON.green}30`, color: NEON.green }}>
                <Save size={10} className="inline" />
              </button>
              <button onClick={() => cancelEdit('sandboxTimeout')} className="px-2 py-1.5 rounded-lg text-xs text-gray-500">✕</button>
            </>
          ) : (
            <>
              <span className="text-sm font-mono font-bold" style={{ color: NEON.orange }}>{settings.sandboxTimeout}s</span>
              <button onClick={() => startEdit('sandboxTimeout')} className="text-xs px-2 py-1 rounded hover:bg-white/5" style={{ color: NEON.cyan }}>Edit</button>
            </>
          )}
        </div>
      </div>

      {/* Max Concurrent Agents */}
      <div className="rounded-xl p-4 flex items-center gap-4" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.blue}15` }}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${NEON.blue}10`, border: `1px solid ${NEON.blue}20` }}>
          <Bot size={16} style={{ color: NEON.blue }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">Max Concurrent Agents</div>
          <div className="text-xs text-gray-500 mt-0.5">Maximum simultaneous agent executions</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {editing.maxConcurrentAgents !== undefined ? (
            <>
              <input
                type="number"
                value={editing.maxConcurrentAgents}
                onChange={e => setEditing(prev => ({ ...prev, maxConcurrentAgents: e.target.value }))}
                min="1" max="100"
                className="w-20 px-2.5 py-1.5 rounded-lg text-sm font-mono text-white bg-black/40 outline-none"
                style={{ border: `1px solid ${NEON.blue}30` }}
                autoFocus
              />
              <button onClick={() => handleSave({ maxConcurrentAgents: editing.maxConcurrentAgents })} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: `${NEON.green}15`, border: `1px solid ${NEON.green}30`, color: NEON.green }}>
                <Save size={10} className="inline" />
              </button>
              <button onClick={() => cancelEdit('maxConcurrentAgents')} className="px-2 py-1.5 rounded-lg text-xs text-gray-500">✕</button>
            </>
          ) : (
            <>
              <span className="text-sm font-mono font-bold" style={{ color: NEON.blue }}>{settings.maxConcurrentAgents}</span>
              <button onClick={() => startEdit('maxConcurrentAgents')} className="text-xs px-2 py-1 rounded hover:bg-white/5" style={{ color: NEON.cyan }}>Edit</button>
            </>
          )}
        </div>
      </div>

      {/* Embedding Model */}
      <div className="rounded-xl p-4 flex items-center gap-4" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.teal}15` }}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${NEON.teal}10`, border: `1px solid ${NEON.teal}20` }}>
          <Cpu size={16} style={{ color: NEON.teal }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white">Embedding Model</div>
          <div className="text-xs text-gray-500 mt-0.5 truncate">Model used for semantic search & similarity</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {editing.embeddingModel !== undefined ? (
            <>
              <input
                type="text"
                value={editing.embeddingModel}
                onChange={e => setEditing(prev => ({ ...prev, embeddingModel: e.target.value }))}
                className="w-56 px-2.5 py-1.5 rounded-lg text-xs font-mono text-white bg-black/40 outline-none"
                style={{ border: `1px solid ${NEON.teal}30` }}
                autoFocus
              />
              <button onClick={() => handleSave({ embeddingModel: editing.embeddingModel })} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-semibold" style={{ background: `${NEON.green}15`, border: `1px solid ${NEON.green}30`, color: NEON.green }}>
                <Save size={10} className="inline" />
              </button>
              <button onClick={() => cancelEdit('embeddingModel')} className="px-2 py-1.5 rounded-lg text-xs text-gray-500">✕</button>
            </>
          ) : (
            <>
              <span className="text-xs font-mono truncate max-w-[200px]" style={{ color: NEON.teal }}>{settings.embeddingModel}</span>
              <button onClick={() => startEdit('embeddingModel')} className="text-xs px-2 py-1 rounded hover:bg-white/5" style={{ color: NEON.cyan }}>Edit</button>
            </>
          )}
        </div>
      </div>

      {/* Rate Limit Tiers */}
      <div className="rounded-xl p-4" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.magenta}15` }}>
        <div className="flex items-center gap-4 mb-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${NEON.magenta}10`, border: `1px solid ${NEON.magenta}20` }}>
            <Shield size={16} style={{ color: NEON.magenta }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white">Rate Limit Tiers</div>
            <div className="text-xs text-gray-500 mt-0.5">Requests per minute, per tier</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: 'Auth', value: '20/min', color: NEON.cyan },
            { label: 'Writes', value: '50/min', color: NEON.blue },
            { label: 'Reads', value: '200/min', color: NEON.green },
            { label: 'Sandbox', value: '10/min', color: NEON.orange },
          ].map(t => (
            <div key={t.label} className="text-center px-2 py-1.5 rounded-lg" style={{ background: `${t.color}08`, border: `1px solid ${t.color}15` }}>
              <div className="text-[10px] uppercase tracking-wider text-gray-500">{t.label}</div>
              <div className="text-sm font-mono font-bold" style={{ color: t.color }}>{t.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Restart Server Button */}
      {settings.port && (
        <div className="rounded-xl p-4 flex items-center gap-4" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.red}15` }}>
          <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${NEON.red}10`, border: `1px solid ${NEON.red}20` }}>
            <RefreshCw size={16} style={{ color: NEON.red }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white">Restart Server</div>
            <div className="text-xs text-gray-500 mt-0.5">Apply port change and reload all settings</div>
          </div>
          <button
            onClick={async () => {
              if (!confirm('Restart the server? This will briefly disconnect all clients.')) return;
              showToast('Restarting server...', 'info');
              try {
                await api('/api/settings/dev/restart', { method: 'POST' });
                showToast('Server restarting — reconnect in a few seconds', 'success');
              } catch (e) { showToast(e.message || 'Restart failed (server may already be restarting)', 'error'); }
            }}
            className="px-4 py-2 rounded-lg text-xs font-semibold transition-all"
            style={{ background: `${NEON.red}15`, border: `1px solid ${NEON.red}40`, color: NEON.red }}
          >
            <RefreshCw size={12} className="inline mr-1" />Restart
          </button>
        </div>
      )}
    </div>
  );
});

// ─── Main Settings ─────────────────────────────────────────────────
export default function Settings() {
  const [vars, setVars] = useState([]);
  const [providers, setProviders] = useState([]);
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [newCat, setNewCat] = useState('api');
  const [newEncrypted, setNewEncrypted] = useState(false);
  const [filter, setFilter] = useState('all');
  const [toast, setToast] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  const load = useCallback(() => {
    api('/api/settings/env').then(setVars).catch(() => {});
    cachedFetch('/api/llm/providers').then(setProviders).catch(() => {});
    // Check Ollama status
    api('/api/ollama/status').then(setOllamaStatus).catch(() => setOllamaStatus({ connected: false }));
  }, []);

  usePolling(load, 60000);

  const showToast = (msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSave = async (key, value, encrypted, category) => {
    try {
      await api('/api/settings/env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value, encrypted: encrypted ? 1 : 0, category }) });
      load(); showToast('Saved', 'success');
    } catch (err) { showToast(err.message || 'Save failed', 'error'); }
  };

  const handleDelete = async (key) => {
    try {
      await api(`/api/settings/env/${encodeURIComponent(key)}`, { method: 'DELETE' });
      load(); showToast('Deleted', 'success');
    } catch (err) { showToast(err.message || 'Delete failed', 'error'); }
  };

  const handleTest = async (key) => {
    try {
      const endpoint = key === 'ollama' ? '/api/ollama/detect' : `/api/settings/env/${encodeURIComponent(key)}/test`;
      const r = await api(endpoint, { method: 'POST' });
      showToast(r.success ? `✓ ${r.message}` : `✗ ${r.message}`, r.success ? 'success' : 'error');
      load();
    } catch (err) { showToast(err.message || 'Test failed', 'error'); }
  };

  const handleAdd = (e) => {
    e.preventDefault();
    if (!newKey.trim()) return;
    handleSave(newKey.trim(), newVal, newEncrypted, newCat);
    setNewKey(''); setNewVal(''); setNewEncrypted(false);
  };

  // Filter out LLM keys (they're shown in provider cards)
  const llmEnvKeys = new Set(LLM_PRESETS.filter(p => p.envKey).map(p => p.envKey));
  const nonLlmVars = vars.filter(v => !llmEnvKeys.has(v.key));
  const filtered = filter === 'all' ? nonLlmVars : nonLlmVars.filter(v => v.category === filter);
  const filteredBySearch = searchQuery
    ? filtered.filter(v => v.key.toLowerCase().includes(searchQuery.toLowerCase()) || (v.value || '').toLowerCase().includes(searchQuery.toLowerCase()))
    : filtered;

  const keySetCount = LLM_PRESETS.filter(p => !p.local && vars.some(v => v.key === p.envKey)).length;

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold animate-pulse" style={{ background: toast.type === 'success' ? `${NEON.green}15` : toast.type === 'error' ? `${NEON.red}15` : `${NEON.cyan}15`, border: `1px solid ${toast.type === 'success' ? NEON.green : toast.type === 'error' ? NEON.red : NEON.cyan}40`, color: toast.type === 'success' ? NEON.green : toast.type === 'error' ? NEON.red : NEON.cyan }}>
          {toast.type === 'success' ? <CheckCircle size={14} /> : toast.type === 'error' ? <AlertTriangle size={14} /> : <Zap size={14} />}
          {toast.msg}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Shield size={20} style={{ color: NEON.cyan, filter: `drop-shadow(0 0 6px ${NEON.cyan})` }} />
        <h2 className="text-xl font-bold" style={{ color: NEON.cyan, textShadow: `0 0 15px ${NEON.cyan}44` }}>Settings</h2>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `${NEON.cyan}12`, color: NEON.cyan, border: `1px solid ${NEON.cyan}25` }}>{keySetCount}/{LLM_PRESETS.filter(p => !p.local).length} providers · {vars.length} vars</span>
      </div>

      {/* ─── LLM Provider Keys Section ───────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Cpu size={16} style={{ color: NEON.cyan }} />
          <h3 className="text-sm font-bold" style={{ color: NEON.cyan }}>LLM Provider Keys</h3>
          <span className="text-[10px] text-gray-600">Set API keys by provider — dropdown shows provider name, not raw key</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
          {LLM_PRESETS.map(preset => (
            <ProviderKeyCard
              key={preset.type}
              preset={preset}
              existingKeys={vars}
              onSave={handleSave}
              onTest={handleTest}
              ollamaStatus={preset.type === 'ollama' ? ollamaStatus : null}
            />
          ))}
        </div>
      </div>

      {/* ─── Dev Settings Section ─────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Terminal size={16} style={{ color: NEON.green }} />
          <h3 className="text-sm font-bold" style={{ color: NEON.green }}>Dev Settings</h3>
          <span className="text-[10px] text-gray-600">Server port, log level, debug mode & runtime config</span>
        </div>
        <DevSettings showToast={showToast} />
      </div>

      {/* ─── Custom Env Vars ──────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Server size={16} style={{ color: NEON.purple }} />
          <h3 className="text-sm font-bold" style={{ color: NEON.purple }}>Environment Variables</h3>
          <span className="text-[10px] text-gray-600">Custom keys and config values</span>
        </div>

        {/* Add new var form — dead simple: paste key, auto-detect */}
             <form onSubmit={handleAdd} className="rounded-xl p-5" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid ${NEON.purple}20` }}>
               <div className="flex items-center gap-2 mb-3">
                 <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${NEON.green}10`, border: `1px solid ${NEON.green}20` }}><Plus size={14} style={{ color: NEON.green }} /></div>
                 <span className="text-sm font-semibold text-white">Add API Key</span>
               </div>

               <div className="flex items-center gap-2">
                 {/* Single paste input */}
                 <div className="flex-1 relative">
                   <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
                   <input
                     value={newKey}
                     onChange={e => {
                       const v = e.target.value;
                       // Auto-detect provider from key format
                       let detected = newCat;
                       let detectedKey = newKey;
                       let detectedVal = newVal;
                       let autoEnc = newEncrypted;
                       // If pasting a full "KEY=value" or "KEY: value"
                       if (v.includes('=') || v.includes(': ')) {
                         const sep = v.includes('=') ? '=' : ': ';
                         const parts = v.split(sep);
                         detectedKey = parts[0].trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
                         detectedVal = parts.slice(1).join(sep).trim();
                         autoEnc = true;
                       } else if (newVal === '' && v.match(/^(sk-|key-|pk-|ak-|xai-|pplx-|dsk-|tpi-|hf_)/i)) {
                         // Looks like a raw API key pasted directly
                         detectedVal = v;
                         detectedKey = '';
                         autoEnc = true;
                       } else {
                         detectedKey = v.toUpperCase().replace(/[^A-Z0-9_]/g, '');
                       }
                       setNewKey(detectedKey);
                       setNewVal(prev => detectedVal || prev);
                       setNewEncrypted(autoEnc);
                     }}
                     placeholder="Paste key (sk-..., key-...) or type KEY_NAME"
                     className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm font-mono text-white bg-black/40 outline-none focus:ring-1 focus:ring-green-500/20 transition-all"
                     style={{ border: `1px solid ${newKey ? NEON.green + '30' : '#333'}` }}
                     autoFocus
                   />
                 </div>

                 {/* Value field — only shown when key name is set but no value yet */}
                 {newKey && !newVal && (
                   <input
                     value={newVal}
                     onChange={e => setNewVal(e.target.value)}
                     placeholder="Value"
                     type={newEncrypted ? 'password' : 'text'}
                     className="flex-1 px-3 py-2.5 rounded-lg text-sm font-mono text-white bg-black/40 outline-none focus:ring-1 focus:ring-purple-500/20 transition-all"
                     style={{ border: `1px solid #333` }}
                   />
                 )}

                 {/* Encrypt toggle */}
                 <button type="button" onClick={() => setNewEncrypted(!newEncrypted)} className="p-2.5 rounded-lg transition-all" style={{ background: newEncrypted ? `${NEON.purple}10` : 'rgba(0,0,0,0.3)', border: `1px solid ${newEncrypted ? NEON.purple + '30' : '#222'}`, color: newEncrypted ? NEON.purple : '#555' }} title={newEncrypted ? 'Encrypted' : 'Not encrypted — click to encrypt'}>
                   <Key size={14} />
                 </button>

                 {/* Category quick-select */}
                 <select value={newCat} onChange={e => setNewCat(e.target.value)} className="px-2 py-2.5 rounded-lg text-xs bg-black/40 text-gray-400 outline-none" style={{ border: '1px solid #222' }}>
                   {CATEGORIES.filter(c => c.key !== 'llm').map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                 </select>

                 {/* Add button */}
                 <button type="submit" disabled={!newKey.trim() || !newVal.trim()} className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all whitespace-nowrap" style={{ background: newKey.trim() && newVal.trim() ? `${NEON.green}15` : 'rgba(255,255,255,0.02)', border: `1px solid ${newKey.trim() && newVal.trim() ? NEON.green + '40' : '#222'}`, color: newKey.trim() && newVal.trim() ? NEON.green : '#333' }}>
                   Add
                 </button>
               </div>

               {/* Auto-detected feedback */}
               {newEncrypted && newVal && (
                 <div className="text-[10px] text-gray-600 mt-1.5 flex items-center gap-1">
                   <span style={{ color: NEON.purple }}>🔒</span> Encrypted · key name: <span className="font-mono text-gray-500">{newKey || '(auto)'}</span>
                 </div>
               )}
             </form>

        {/* Search + Category filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-[260px]">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-600" />
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search vars..." className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-black/40 text-gray-300 outline-none" style={{ border: '1px solid #333' }} />
          </div>
          <button onClick={() => setFilter('all')} className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all" style={{ background: filter === 'all' ? `${NEON.purple}15` : 'transparent', border: `1px solid ${filter === 'all' ? NEON.purple + '40' : '#222'}`, color: filter === 'all' ? NEON.purple : '#666' }}>All</button>
          {CATEGORIES.filter(c => c.key !== 'llm').map(c => (
            <button key={c.key} onClick={() => setFilter(c.key)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all" style={{ background: filter === c.key ? `${c.color}15` : 'transparent', border: `1px solid ${filter === c.key ? c.color + '40' : '#222'}`, color: filter === c.key ? c.color : '#666' }}>
              <c.icon size={11} /> {c.label}
            </button>
          ))}
        </div>

        {/* Variables list */}
        <div className="rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,20,0.95)', border: `1px solid rgba(168,85,247,0.12)` }}>
          <div className="flex items-center gap-3 px-4 py-2.5 text-xs font-semibold tracking-wider uppercase text-gray-600" style={{ borderBottom: `1px solid rgba(168,85,247,0.12)` }}>
            <span className="flex-1">Variable</span><span className="w-20">Actions</span>
          </div>
          {filteredBySearch.length === 0 ? (
            <div className="text-center py-12 text-gray-600"><Key size={32} className="mx-auto mb-2 opacity-30" />No environment variables yet.</div>
          ) : filteredBySearch.map(v => (
            <VarRow key={v.key} v={v} onSave={handleSave} onDelete={handleDelete} onTest={handleTest} />
          ))}
        </div>
      </div>
    </div>
  );
}
