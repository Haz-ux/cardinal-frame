import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Send, Sparkles, Cpu, Radio, ChevronRight, Wrench, Loader, Zap, Paperclip, Image, FileText, Code, XCircle } from 'lucide-react';

// ─── Aimi Color Palette ────────────────────────────────────────────
const AIMI = {
 core: '#00b4d8',
 shell: '#0077b6',
 accent: '#90e0ef',
 data: '#39ff14',
 alert: '#ff2a85',
 gold: '#eab308',
 dark: '#03071e',
 mid: '#0a1128',
 ring: '#023e8a',
 purple: '#b026ff',
 magenta: '#ff00ff',
};

// ─── Aimi Avatar SVG Renderer ──────────────────────────────────────
function renderAimiAvatarSVG({ eyeColor = AIMI.core, bgGlow = 'rgba(0,180,216,0.4)', expression = 'normal', currentLevel = 3 } = {}) {
 const exprEye = expression === 'thinking' ? '#ffb700'
  : expression === 'surprised' ? '#ff2a85'
  : expression === 'cheering' ? '#39ff14'
  : expression === 'sassy' ? '#a855f7'
  : expression === 'sitting' ? '#60a5fa'
  : expression === 'working' ? '#39ff14'
  : eyeColor;

 return (
  <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-[0_0_12px_rgba(0,180,216,0.4)] transition-transform group-hover:scale-105">
   <style dangerouslySetInnerHTML={{ __html: `
@keyframes aimi-core-pulse { 0%, 100% { opacity: 0.4; r: 4; } 50% { opacity: 1; r: 6; } }
@keyframes aimi-ring-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes aimi-ring-spin-r { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
@keyframes aimi-data-flow { 0% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -30; } }
@keyframes aimi-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
.aimi-core-pulse { animation: aimi-core-pulse 2s ease-in-out infinite; }
.aimi-ring-spin { animation: aimi-ring-spin 12s linear infinite; transform-origin: 50px 52px; }
.aimi-ring-spin-r { animation: aimi-ring-spin-r 9s linear infinite; transform-origin: 50px 52px; }
.aimi-data-flow { animation: aimi-data-flow 1.5s linear infinite; }
.aimi-float { animation: aimi-float 3s ease-in-out infinite; }
` }} />
   <defs>
    <radialGradient id="aimiCoreGrad" cx="50%" cy="50%" r="50%">
     <stop offset="0%" stopColor={exprEye} stopOpacity="1" />
     <stop offset="100%" stopColor={AIMI.shell} stopOpacity="0.3" />
    </radialGradient>
    <radialGradient id="aimiShellGrad" cx="50%" cy="50%" r="50%">
     <stop offset="0%" stopColor={AIMI.shell} stopOpacity="0.6" />
     <stop offset="100%" stopColor={AIMI.dark} stopOpacity="0.9" />
    </radialGradient>
    <linearGradient id="aimiDataGrad" x1="0%" y1="0%" x2="100%" y2="100%">
     <stop offset="0%" stopColor={AIMI.data} stopOpacity="0.8" />
     <stop offset="100%" stopColor={AIMI.core} stopOpacity="0.3" />
    </linearGradient>
    <linearGradient id="aimiGoldGrad" x1="0%" y1="0%" x2="100%" y2="0%">
     <stop offset="0%" stopColor={AIMI.gold} stopOpacity="0.9" />
     <stop offset="100%" stopColor={AIMI.alert} stopOpacity="0.7" />
    </linearGradient>
   </defs>
   <circle cx="50" cy="52" r="40" fill={bgGlow} opacity="0.15" />
   <polygon points="50,14 80,30 80,66 50,82 20,66 20,30" fill="url(#aimiShellGrad)" stroke={AIMI.shell} strokeWidth="1" opacity="0.8" />
   <g className="aimi-ring-spin"><ellipse cx="50" cy="52" rx="32" ry="14" fill="none" stroke={AIMI.ring} strokeWidth="0.5" opacity="0.4" /></g>
   <g className="aimi-ring-spin-r"><ellipse cx="50" cy="52" rx="28" ry="18" fill="none" stroke={AIMI.core} strokeWidth="0.3" opacity="0.3" /></g>
   <line x1="20" y1="42" x2="38" y2="48" stroke="url(#aimiDataGrad)" strokeWidth="0.5" className="aimi-data-flow" strokeDasharray="4 3" />
   <line x1="62" y1="48" x2="80" y2="42" stroke="url(#aimiDataGrad)" strokeWidth="0.5" className="aimi-data-flow" strokeDasharray="4 3" />
   <line x1="30" y1="62" x2="42" y2="56" stroke="url(#aimiDataGrad)" strokeWidth="0.4" className="aimi-data-flow" strokeDasharray="3 4" />
   <line x1="58" y1="56" x2="70" y2="62" stroke="url(#aimiDataGrad)" strokeWidth="0.4" className="aimi-data-flow" strokeDasharray="3 4" />
   <circle cx="32" cy="34" r="1.5" fill={AIMI.accent} opacity="0.6" />
   <circle cx="68" cy="34" r="1.5" fill={AIMI.accent} opacity="0.6" />
   <circle cx="50" cy="20" r="1" fill={AIMI.data} opacity="0.4" />
   <circle cx="50" cy="50" r="8" fill="url(#aimiCoreGrad)" className="aimi-core-pulse" />
   <circle cx="50" cy="50" r="3" fill={exprEye} opacity="0.9" />
   {currentLevel >= 2 && <circle cx="50" cy="52" r="22" fill="none" stroke={AIMI.gold} strokeWidth="0.8" opacity="0.3" strokeDasharray="6 4" className="aimi-ring-spin" />}
   {currentLevel >= 3 && <polygon points="50,12 82,30 82,66 50,84 18,66 18,30" fill="none" stroke={AIMI.gold} strokeWidth="0.6" opacity="0.2" />}
  </svg>
 );
}

// ─── Stage Definitions ─────────────────────────────────────────────
const STAGES = [
 { name: 'Spawn', level: 1, minXP: 0, status: 'AIMI SPAWN v0.1', color: AIMI.shell },
 { name: 'Aimi Core', level: 2, minXP: 100, status: 'AIMI CORE v2.1', color: AIMI.core },
 { name: 'Aimi Sentinel', level: 3, minXP: 500, status: 'AIMI-SENTINEL v3.0', color: AIMI.accent },
 { name: 'Omni-Aimi', level: 4, minXP: 2000, status: 'OMNI-AIMI v∞.0', color: AIMI.gold },
];

function getStage(xp) {
 for (let i = STAGES.length - 1; i >= 0; i--) {
  if (xp >= STAGES[i].minXP) return STAGES[i];
 }
 return STAGES[0];
}

function getExpression(msg, streaming) {
 if (streaming) return 'working';
 const m = (msg || '').toLowerCase();
 if (m.includes('error') || m.includes('fail')) return 'surprised';
 if (m.includes('success') || m.includes('done') || m.includes('complete')) return 'cheering';
 if (m.includes('think') || m.includes('process') || m.includes('analyz')) return 'thinking';
 if (m.includes('sassy') || m.includes('nope') || m.includes('whatever')) return 'sassy';
 return 'normal';
}

// ─── Component ─────────────────────────────────────────────────────
export default function CyberMascotCompanion() {
 const [open, setOpen] = useState(false);
 const [messages, setMessages] = useState([
  { role: 'aimi', text: 'Hello, Operator. Aimi online. I can manage agents, create tasks, check system status, and more. What do you need?' }
 ]);
 const [input, setInput] = useState('');
 const [xp, setXp] = useState(() => parseInt(localStorage.getItem('aimi_xp_points') || '0', 10));
 const [streaming, setStreaming] = useState(false);
 const [streamBuf, setStreamBuf] = useState('');
 const [expanded, setExpanded] = useState(false);
 const [showQuickActions, setShowQuickActions] = useState(true);
 const chatEndRef = useRef(null);
 const abortRef = useRef(null);

 const stage = getStage(xp);

 useEffect(() => { localStorage.setItem('aimi_xp_points', String(xp)); }, [xp]);
 useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamBuf]);

 // Quick action commands that actually call the API
 const quickActions = [
  { label: 'Status', cmd: 'Give me a system status report', icon: <Radio size={10} /> },
  { label: 'Agents', cmd: 'List all agents and their status', icon: <Cpu size={10} /> },
  { label: 'Tasks', cmd: 'List all tasks', icon: <Zap size={10} /> },
  { label: 'Models', cmd: 'What LLM models are available?', icon: <Sparkles size={10} /> },
 ];

 const handleSend = useCallback(async (overrideText) => {
  const text = (overrideText || input).trim();
  if (!text || streaming) return;

  setMessages(prev => [...prev, { role: 'user', text }]);
  setInput('');
  setStreaming(true);
  setStreamBuf('');
  setXp(prev => prev + 10);

  const controller = new AbortController();
  abortRef.current = controller;

  try {
   const token = localStorage.getItem('cf_token');
   const resp = await fetch('/api/aimi/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ message: text }),
    signal: controller.signal,
   });

   if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
    setMessages(prev => [...prev, { role: 'aimi', text: `⚠ Error: ${err.error?.message || 'Request failed'}` }]);
    setStreaming(false);
    return;
   }

   const reader = resp.body.getReader();
   const decoder = new TextDecoder();
   let fullContent = '';

   while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
     const data = line.slice(6).trim();
     if (data === '[DONE]') continue;
     try {
      const parsed = JSON.parse(data);
      if (parsed.error) { fullContent += `\n⚠ ${parsed.error.message}`; continue; }
      if (parsed.tool_result) {
       const resultStr = JSON.stringify(parsed.tool_result.result, null, 2);
       fullContent += `\n\n🔧 **${parsed.tool_result.tool}** →\n\`\`\`json\n${resultStr.slice(0, 800)}\n\`\`\``;
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) fullContent += delta;
     } catch {}
    }
    setStreamBuf(fullContent);
   }

   setMessages(prev => [...prev, { role: 'aimi', text: fullContent }]);
   setStreamBuf('');
   setXp(prev => prev + 20);
  } catch (e) {
   if (e.name !== 'AbortError') {
    setMessages(prev => [...prev, { role: 'aimi', text: `⚠ Connection error: ${e.message}` }]);
   }
  }
  setStreaming(false);
  abortRef.current = null;
 }, [input, streaming]);

 const lastMsg = messages[messages.length - 1]?.text || '';

 // ── Closed: floating orb ──
 if (!open) {
  return (
   <button
    onClick={() => setOpen(true)}
    className="fixed bottom-5 right-5 z-50 w-14 h-14 rounded-full group aimi-float"
    style={{ background: `linear-gradient(135deg, ${AIMI.shell}, ${AIMI.core})`, boxShadow: `0 0 20px ${AIMI.core}44, 0 0 40px ${AIMI.shell}22` }}
    title="Open Aimi"
   >
    <div className="w-full h-full flex items-center justify-center">
     {renderAimiAvatarSVG({ expression: getExpression(lastMsg, false), currentLevel: stage.level })}
    </div>
    <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 56 56">
     <circle cx="28" cy="28" r="26" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
     <circle cx="28" cy="28" r="26" fill="none" stroke={stage.color} strokeWidth="2"
      strokeDasharray={`${(xp % 100) * 1.63} 163`} strokeLinecap="round" />
    </svg>
    {/* Notification dot */}
    {messages.length > 1 && (
     <div style={{ position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: '50%', background: AIMI.alert, boxShadow: `0 0 6px ${AIMI.alert}` }} />
    )}
   </button>
  );
 }

 // ── Open: chat panel ──
 const panelWidth = expanded ? 420 : 340;
 const panelHeight = expanded ? 540 : 420;

 return (
  <div className="fixed bottom-5 right-5 z-50 rounded-xl overflow-hidden flex flex-col"
   style={{ background: `linear-gradient(180deg, ${AIMI.dark}, ${AIMI.mid})`, border: `1px solid ${AIMI.core}30`, boxShadow: `0 0 30px ${AIMI.core}22, 0 4px 20px rgba(0,0,0,0.5)`, width: panelWidth, height: panelHeight, transition: 'width 0.2s, height 0.2s' }}>

   {/* Header */}
   <div className="flex items-center gap-2 px-3 py-2" style={{ background: `linear-gradient(90deg, ${AIMI.shell}33, transparent)`, borderBottom: `1px solid ${AIMI.core}20` }}>
    <div className="w-8 h-8">
     {renderAimiAvatarSVG({ expression: getExpression(lastMsg, streaming), currentLevel: stage.level })}
    </div>
    <div className="flex-1 min-w-0">
     <div className="text-xs font-bold" style={{ color: AIMI.accent }}>{stage.name}</div>
     <div className="text-[10px] font-mono" style={{ color: AIMI.core }}>
      {streaming ? '⟨ PROCESSING... ⟩' : stage.status}
     </div>
    </div>
    <div className="flex items-center gap-1">
     <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: `${AIMI.gold}15`, color: AIMI.gold, border: `1px solid ${AIMI.gold}30` }}>
      {xp} XP
     </span>
     <button onClick={() => setExpanded(!expanded)} className="p-1 rounded transition-colors hover:bg-white/5" style={{ color: AIMI.accent }} title={expanded ? 'Shrink' : 'Expand'}>
      <ChevronRight size={14} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
     </button>
     <button onClick={() => setOpen(false)} className="p-1 rounded transition-colors hover:bg-white/5" style={{ color: AIMI.accent }}>
      <X size={14} />
     </button>
    </div>
   </div>

   {/* Chat messages */}
   <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2" style={{ scrollbarWidth: 'thin', scrollbarColor: `${AIMI.core}44 transparent` }}>
    {messages.map((msg, i) => (
     <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[90%] px-2.5 py-1.5 rounded-lg text-xs leading-relaxed ${msg.role === 'user' ? 'rounded-br-sm' : 'rounded-bl-sm'}`}
       style={{
        background: msg.role === 'user' ? `${AIMI.core}15` : `${AIMI.shell}22`,
        color: msg.role === 'user' ? AIMI.accent : '#bbb',
        border: `1px solid ${msg.role === 'user' ? AIMI.core + '20' : AIMI.shell + '33'}`,
        whiteSpace: 'pre-wrap',
       }}>
       {msg.role === 'aimi' && <span className="text-[10px] font-bold block mb-0.5" style={{ color: AIMI.core }}>Aimi</span>}
       {msg.text}
      </div>
     </div>
    ))}
    {/* Streaming buffer */}
    {streamBuf && (
     <div className="flex justify-start">
      <div className="max-w-[90%] px-2.5 py-1.5 rounded-lg rounded-bl-sm text-xs leading-relaxed" style={{ background: `${AIMI.shell}22`, color: '#bbb', border: `1px solid ${AIMI.shell}33`, whiteSpace: 'pre-wrap' }}>
       <span className="text-[10px] font-bold block mb-0.5" style={{ color: AIMI.core }}>Aimi</span>
       {streamBuf}
       <span className="neon-pulse" style={{ display: 'inline-block', width: 4, height: 12, background: AIMI.core, marginLeft: 2, verticalAlign: 'middle', borderRadius: 1 }} />
      </div>
     </div>
    )}
    <div ref={chatEndRef} />
   </div>

   {/* Quick actions */}
   {showQuickActions && !streaming && (
    <div className="flex gap-1 px-3 py-1.5" style={{ borderTop: `1px solid ${AIMI.core}10` }}>
     {quickActions.map(action => (
      <button key={action.label} onClick={() => handleSend(action.cmd)}
       className="px-2 py-1 text-[10px] rounded transition-colors hover:bg-white/5 flex items-center gap-1"
       style={{ background: `${AIMI.ring}22`, color: AIMI.accent, border: `1px solid ${AIMI.ring}33` }}>
       {action.icon} {action.label}
      </button>
     ))}
    </div>
   )}

   {/* Input */}
   <div className="flex items-center gap-2 px-3 py-2" style={{ borderTop: `1px solid ${AIMI.core}15` }}>
    <input
     value={input}
     onChange={e => setInput(e.target.value)}
     onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
     placeholder="Ask Aimi to do something..."
     className="flex-1 px-2 py-1.5 rounded text-xs text-white placeholder-gray-600 outline-none"
     style={{ background: `${AIMI.dark}`, border: `1px solid ${AIMI.core}20` }}
     disabled={streaming}
    />
    <button
     onClick={() => handleSend()}
     className="p-1.5 rounded transition-colors"
     style={{ background: streaming ? `${AIMI.core}10` : `${AIMI.core}22`, color: streaming ? '#555' : AIMI.core, cursor: streaming ? 'not-allowed' : 'pointer' }}
     title="Send"
     disabled={streaming}
    >
     {streaming ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
    </button>
   </div>
  </div>
 );
}
