import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Send, Sparkles, Cpu, Radio, ChevronRight, Wrench, Loader, Zap, Paperclip, Image, FileText, Code, XCircle } from 'lucide-react';
import { usePersonas } from './PersonaContext';

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
 green: '#22c55e',
 red: '#ef4444',
};

const EXPR_MAP = {
 idle:      { eye: AIMI.core,   mouth: 'smile',  aura: 0.3, glow: 0.4 },
 thinking:  { eye: AIMI.gold,   mouth: 'flat',   aura: 0.2, glow: 0.6 },
 speaking:  { eye: AIMI.core,   mouth: 'cycle',  aura: 0.6, glow: 0.5 },
 happy:     { eye: AIMI.green,  mouth: 'grin',   aura: 0.9, glow: 0.7 },
 error:     { eye: AIMI.red,    mouth: 'x',      aura: 0.4, glow: 0.3 },
 alert:     { eye: AIMI.magenta,mouth: 'small',  aura: 0.8, glow: 0.5 },
 surprised: { eye: AIMI.alert,  mouth: 'o',      aura: 0.7, glow: 0.6 },
 sassy:     { eye: AIMI.purple, mouth: 'smirk',  aura: 0.5, glow: 0.4 },
 working:   { eye: AIMI.data,   mouth: 'flat',   aura: 0.7, glow: 0.6 },
};

function getExpression(msg, streaming) {
 if (streaming) return 'speaking';
 const m = (msg || '').toLowerCase();
 if (m.includes('error') || m.includes('fail')) return 'error';
 if (m.includes('success') || m.includes('done') || m.includes('complete')) return 'happy';
 if (m.includes('think') || m.includes('process') || m.includes('analyz')) return 'thinking';
 if (m.includes('sassy') || m.includes('nope') || m.includes('whatever')) return 'sassy';
 if (m.includes('alert') || m.includes('warn')) return 'alert';
 if (m.includes('surprise') || m.includes('wow')) return 'surprised';
 return 'idle';
}

// ─── Stage Definitions ─────────────────────────────────────────────
function buildStages(name) {
 const n = name || 'Aimi';
 const up = n.toUpperCase();
 return [
  { name: 'Spawn', level: 1, minXP: 0, status: `${up} SPAWN v0.1`, color: AIMI.shell },
  { name: `${n} Core`, level: 2, minXP: 100, status: `${up} CORE v2.1`, color: AIMI.core },
  { name: `${n} Sentinel`, level: 3, minXP: 500, status: `${up}-SENTINEL v3.0`, color: AIMI.accent },
  { name: `Omni-${n}`, level: 4, minXP: 2000, status: `OMNI-${up} v∞.0`, color: AIMI.gold },
 ];
}
const STAGES = buildStages('Aimi');

function getStage(xp, name) {
 const stages = buildStages(name);
 for (let i = stages.length - 1; i >= 0; i--) {
  if (xp >= stages[i].minXP) return stages[i];
 }
 return stages[0];
}

// ─── Canvas2D Skeletal Renderer ────────────────────────────────────
const MOUTH_FRAMES = ['smile', 'half', 'open'];
const MOUTH_SHAPES = {
 smile:  { w: 6, h: 1.5, arc: 0.25 },
 grin:   { w: 8, h: 4, arc: 0.45 },
 flat:   { w: 5, h: 0.5, arc: 0 },
 small:  { w: 3, h: 1, arc: 0.1 },
 o:      { w: 3, h: 3, arc: 0.5 },
 x:      { w: 5, h: 3, arc: -0.3 },
 smirk:  { w: 5, h: 1.5, arc: 0.15, tilt: 0.2 },
 half:   { w: 4, h: 2, arc: 0.3 },
 open:   { w: 5, h: 4, arc: 0.5 },
};

function AimiCanvas({ expression = 'idle', stage = 1, streaming = false, size = 120 }) {
 const canvasRef = useRef(null);
 const rafRef = useRef(null);
 const blinkRef = useRef(0);
 const mouthFrameRef = useRef(0);
 const lastBlinkRef = useRef(Date.now());
 const nextBlinkRef = useRef(3000 + Math.random() * 2000);

 useEffect(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  ctx.scale(dpr, dpr);

  // Particle state
  const particles = [];
  for (let i = 0; i < 8; i++) {
   particles.push({
    angle: (i / 8) * Math.PI * 2,
    radius: 38 + Math.random() * 6,
    speed: 0.0003 + Math.random() * 0.0002,
    size: 0.8 + Math.random() * 0.6,
    trail: [],
   });
  }

  const expr = EXPR_MAP[expression] || EXPR_MAP.idle;

  function draw(now) {
   const t = now || 0;
   ctx.clearRect(0, 0, size, size);
   const cx = size / 2, cy = size / 2;

   // Blink logic
   if (t - lastBlinkRef.current > nextBlinkRef.current) {
    blinkRef.current = 1;
    lastBlinkRef.current = t;
    nextBlinkRef.current = 3000 + Math.random() * 2000;
   }
   const blink = blinkRef.current > 0 ? Math.max(0, blinkRef.current - 0.1) : 0;
   blinkRef.current = blink;

   // Mouth frame cycling for speaking
   if (expression === 'speaking' || streaming) {
    mouthFrameRef.current = Math.floor(t / 120) % 3;
   }

   // 1. Ambient glow field (breathes)
   const breathe = 0.5 + 0.2 * Math.sin(t * 0.002);
   const glowR = size * 0.48;
   const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
   bgGrad.addColorStop(0, `${expr.eye}${Math.floor(expr.glow * 60).toString(16).padStart(2,'0')}`);
   bgGrad.addColorStop(1, `${AIMI.dark}00`);
   ctx.fillStyle = bgGrad;
   ctx.beginPath();
   ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
   ctx.fill();

   // 2. Outer hex ring (level 3+) — rotating gold dash
   if (stage >= 3) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.000083);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
     const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
     const r = 42;
     if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
     else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.strokeStyle = `${AIMI.gold}40`;
    ctx.lineWidth = 0.8;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
   }

   // 3. Shell hexagon (back)
   ctx.save();
   ctx.translate(cx, cy);
   ctx.beginPath();
   for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const r = 32;
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
   }
   ctx.closePath();
   const shellGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 32);
   shellGrad.addColorStop(0, `${AIMI.shell}66`);
   shellGrad.addColorStop(1, `${AIMI.dark}cc`);
   ctx.fillStyle = shellGrad;
   ctx.fill();
   ctx.strokeStyle = `${AIMI.shell}80`;
   ctx.lineWidth = 1;
   ctx.stroke();
   ctx.restore();

   // 4. Counter-rotating inner ring (level 2+)
   if (stage >= 2) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t * 0.000111);
    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 14, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `${AIMI.core}50`;
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.restore();

    // 5. Data pulse lines (level 2+)
    const dashOff = (t * 0.05) % 30;
    const lines = [[-18, 14, -8, 18], [8, 18, 18, 14], [-18, 4, -12, 2], [12, 2, 18, 4]];
    for (const [x1, y1, x2, y2] of lines) {
     ctx.save();
     ctx.translate(cx, cy);
     ctx.beginPath();
     ctx.moveTo(x1, y1);
     ctx.lineTo(x2, y2);
     ctx.strokeStyle = `${AIMI.data}80`;
     ctx.lineWidth = 0.6;
     ctx.setLineDash([3, 4]);
     ctx.lineDashOffset = -dashOff;
     ctx.stroke();
     ctx.setLineDash([]);
     ctx.restore();
    }
   }

   // 6. Particle aura (level 3+)
   if (stage >= 3) {
    for (const p of particles) {
     p.angle += p.speed * (t > 0 ? 16 : 0);
     const px = cx + Math.cos(p.angle) * p.radius;
     const py = cy + Math.sin(p.angle) * p.radius;
     // Trail
     p.trail.push({ x: px, y: py });
     if (p.trail.length > 6) p.trail.shift();
     for (let i = 0; i < p.trail.length; i++) {
      const tp = p.trail[i];
      const alpha = (i / p.trail.length) * expr.aura * 0.4;
      ctx.beginPath();
      ctx.arc(tp.x, tp.y, p.size * (i / p.trail.length + 0.3), 0, Math.PI * 2);
      ctx.fillStyle = `${AIMI.accent}${Math.floor(alpha * 255).toString(16).padStart(2,'0')}`;
      ctx.fill();
     }
     // Head
     ctx.beginPath();
     ctx.arc(px, py, p.size, 0, Math.PI * 2);
     const pGrad = ctx.createRadialGradient(px, py, 0, px, py, p.size * 2);
     pGrad.addColorStop(0, `${AIMI.accent}cc`);
     pGrad.addColorStop(1, `${AIMI.accent}00`);
     ctx.fillStyle = pGrad;
     ctx.fill();
    }
   }

   // 7. Core orb (pulsing)
   const corePulse = 0.5 + 0.3 * Math.sin(t * 0.003);
   const coreR = 7 + corePulse * 1.5;
   const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
   coreGrad.addColorStop(0, `${expr.eye}ee`);
   coreGrad.addColorStop(0.6, `${AIMI.shell}88`);
   coreGrad.addColorStop(1, `${AIMI.shell}00`);
   ctx.beginPath();
   ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
   ctx.fillStyle = coreGrad;
   ctx.fill();

   // 8. Eyes (two glowing dots with blink)
   const eyeY = cy - 2;
   const eyeSpacing = 4.5;
   const eyeBlinkH = blink > 0 ? Math.max(0.3, 1 - blink) : 1;
   for (const side of [-1, 1]) {
    const ex = cx + side * eyeSpacing;
    // Glow
    const eyeGrad = ctx.createRadialGradient(ex, eyeY, 0, ex, eyeY, 3);
    eyeGrad.addColorStop(0, `${expr.eye}ff`);
    eyeGrad.addColorStop(1, `${expr.eye}00`);
    ctx.beginPath();
    ctx.arc(ex, eyeY, 3, 0, Math.PI * 2);
    ctx.fillStyle = eyeGrad;
    ctx.fill();
    // Core dot
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, 1.2, 1.2 * eyeBlinkH, 0, 0, Math.PI * 2);
    ctx.fillStyle = expr.eye;
    ctx.fill();
   }

   // 9. Mouth
   let mouthType = expr.mouth;
   if (mouthType === 'cycle') {
    mouthType = MOUTH_FRAMES[mouthFrameRef.current];
   }
   const ms = MOUTH_SHAPES[mouthType] || MOUTH_SHAPES.smile;
   const mouthY = cy + 5;
   ctx.save();
   ctx.translate(cx, mouthY);
   if (ms.tilt) ctx.rotate(ms.tilt);
   ctx.beginPath();
   if (mouthType === 'x') {
    // X mouth — two crossing lines
    ctx.moveTo(-ms.w/2, -ms.h/2); ctx.lineTo(ms.w/2, ms.h/2);
    ctx.moveTo(ms.w/2, -ms.h/2); ctx.lineTo(-ms.w/2, ms.h/2);
    ctx.strokeStyle = `${expr.eye}cc`;
    ctx.lineWidth = 1;
    ctx.stroke();
   } else if (ms.h < 1) {
    // Flat-ish line
    ctx.moveTo(-ms.w/2, 0); ctx.lineTo(ms.w/2, 0);
    ctx.strokeStyle = `${expr.eye}aa`;
    ctx.lineWidth = 0.8;
    ctx.stroke();
   } else {
    // Arc mouth
    ctx.arc(0, 0, ms.w/2, 0, Math.PI * (0.5 + ms.arc), false);
    // Adjust arc based on smile frown
    ctx.strokeStyle = `${expr.eye}cc`;
    ctx.lineWidth = 1;
    ctx.stroke();
   }
   ctx.restore();

   // 10. Level 4 — dual particle streams + overlay
   if (stage >= 4) {
    for (const p of particles) {
     p.angle += 0.0002;
     const px = cx + Math.cos(p.angle) * (p.radius + 8);
     const py = cy + Math.sin(p.angle) * (p.radius + 8);
     ctx.beginPath();
     ctx.arc(px, py, 0.5, 0, Math.PI * 2);
     ctx.fillStyle = `${AIMI.gold}80`;
     ctx.fill();
    }
    // Faint rainbow shimmer overlay
    const shimmer = ctx.createLinearGradient(cx - 30, cy, cx + 30, cy);
    const shimOff = (t * 0.0002) % 1;
    shimmer.addColorStop(Math.max(0, shimOff - 0.2), `${AIMI.core}10`);
    shimmer.addColorStop(shimOff, `${AIMI.magenta}15`);
    shimmer.addColorStop(Math.min(1, shimOff + 0.2), `${AIMI.data}10`);
    ctx.fillStyle = shimmer;
    ctx.beginPath();
    ctx.arc(cx, cy, 32, 0, Math.PI * 2);
    ctx.fill();
   }

   rafRef.current = requestAnimationFrame(draw);
  }

  rafRef.current = requestAnimationFrame(draw);
  return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
 }, [expression, stage, streaming, size]);

 return (
  <canvas
   ref={canvasRef}
   style={{ width: size, height: size }}
   className="aimi-canvas"
  />
 );
}

export { AimiCanvas, getExpression, getStage, buildStages, STAGES, AIMI };

// ─── Aimi Chat Panel (uses AimiCanvas) ─────────────────────────────
export default function AimiCanvasCompanion() {
 const { companionName } = usePersonas();
 const [open, setOpen] = useState(false);
 const [messages, setMessages] = useState([
  { role: 'aimi', text: `Hello, Operator. ${companionName} online. I can manage agents, create tasks, check system status, and more. What do you need?` }
 ]);
 const [input, setInput] = useState('');
 const [xp, setXp] = useState(() => parseInt(localStorage.getItem('aimi_xp_points') || '0', 10));
  const [streaming, setStreaming] = useState(false);
  const [streamBuf, setStreamBuf] = useState('');
  const [thinking, setThinking] = useState('');
  const recvRef = useRef('');        // full received content (from delta.content)
  const commitRef = useRef(false);   // stream ended, typewriter should commit soon
  const lenRef = useRef(0);          // chars of recvRef shown in streamBuf
  const typewriterRef = useRef(null);
 const [expanded, setExpanded] = useState(false);
 const [showQuickActions, setShowQuickActions] = useState(true);
  const chatEndRef = useRef(null);
  const abortRef = useRef(null);

  // ─── Draggable position (persisted across reloads) ──────────────
  const MASCOT_POS_KEY = 'aimi_mascot_pos';
  const ORB_SIZE = 56;
  // Keep the orb on-screen for the current viewport. clampPos is safe to
  // call during render/init because it only reads window dimensions.
  const clampPos = (left, top) => ({
    left: Math.max(0, Math.min(left, Math.max(0, window.innerWidth - ORB_SIZE))),
    top: Math.max(0, Math.min(top, Math.max(0, window.innerHeight - ORB_SIZE))),
  });

  const [mascotPos, setMascotPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(MASCOT_POS_KEY));
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') return clampPos(saved.left, saved.top);
    } catch {}
    return { left: window.innerWidth - 20 - ORB_SIZE, top: window.innerHeight - 20 - ORB_SIZE };
  });
  const mascotPosRef = useRef(mascotPos);
  useEffect(() => { mascotPosRef.current = mascotPos; }, [mascotPos]);
  // Re-clamp when the viewport changes (desktop ↔ mobile view toggle,
  // rotation, zoom). A position saved in the desktop-width coordinate
  // space would otherwise leave the orb off-screen and unrecoverable.
  useEffect(() => {
    const onViewportChange = () => {
      setMascotPos(prev => {
        const next = clampPos(prev.left, prev.top);
        if (next.left !== prev.left || next.top !== prev.top) {
          try { localStorage.setItem(MASCOT_POS_KEY, JSON.stringify(next)); } catch {}
        }
        return next;
      });
    };
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
    };
  }, []);
  const dragRef = useRef(null); // { startX, startY, left, top }
  const movedRef = useRef(false);

  const onDragStart = useCallback((e) => {
    movedRef.current = false;
    dragRef.current = { startX: e.clientX, startY: e.clientY, left: mascotPos.left, top: mascotPos.top };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [mascotPos]);

  const onDragMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
    setMascotPos(clampPos(d.left + dx, d.top + dy));
  }, []);

  const onDragEnd = useCallback((e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch {}
    try { localStorage.setItem(MASCOT_POS_KEY, JSON.stringify(mascotPosRef.current)); } catch {}
  }, []);


 const stage = getStage(xp, companionName);

 useEffect(() => { localStorage.setItem('aimi_xp_points', String(xp)); }, [xp]);
 useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamBuf, thinking]);

  // ─── Typewriter: reveal received tokens a few chars at a time so it is
  // always visually obvious Aimi is responding, even when the provider
  // returns the whole reply in one chunk. When the stream ends it keeps
  // running until the buffer catches up, then commits the message.
  useEffect(() => {
    if (!streaming && !commitRef.current) return;
    if (typewriterRef.current) return;
    typewriterRef.current = setInterval(() => {
      const target = recvRef.current;
      const shown = lenRef.current;
      if (shown < target.length) {
        const remaining = target.length - shown;
        const step = remaining > 120 ? 6 : remaining > 40 ? 3 : 1;
        lenRef.current = shown + step;
        setStreamBuf(target.slice(0, lenRef.current));
      } else if (commitRef.current) {
        clearInterval(typewriterRef.current);
        typewriterRef.current = null;
        commitRef.current = false;
        lenRef.current = 0;
        const final = target.trim() ? target : `⚠ ${companionName} received your message but returned an empty response.`;
        setStreamBuf('');
        setThinking('');
        setMessages(prev => [...prev, { role: 'aimi', text: final }]);
      }
    }, 24);
    return () => { clearInterval(typewriterRef.current); typewriterRef.current = null; };
  }, [streaming, companionName]);

 const quickActions = [
  { label: 'Status', cmd: 'Give me a system status report', icon: <Radio size={10} /> },
  { label: 'Agents', cmd: 'List all agents and their status', icon: <Cpu size={10} /> },
  { label: 'Tasks', cmd: 'List all tasks', icon: <Zap size={10} /> },
  { label: 'Models', cmd: 'What LLM models are available?', icon: <Sparkles size={10} /> },
 ];

  const handleSend = useCallback(async (overrideText) => {
   const text = (overrideText || input).trim();
   if (!text || streaming) return;

   // Flush any pending typewriter buffer before starting a new send.
   if (typewriterRef.current) { clearInterval(typewriterRef.current); typewriterRef.current = null; }
   if (commitRef.current && recvRef.current.trim()) {
    setMessages(prev => [...prev, { role: 'aimi', text: recvRef.current }]);
   }


  setMessages(prev => [...prev, { role: 'user', text }]);
  setInput('');
  setStreaming(true);
  setStreamBuf('');
  setThinking('');
  recvRef.current = '';
  commitRef.current = false;
  lenRef.current = 0;
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
     const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
     const errMsg = (typeof err.error === 'string' ? err.error : err.error?.message) || err.message || 'Request failed';
     setMessages(prev => [...prev, { role: 'aimi', text: `⚠ Error: ${errMsg}` }]);
     setStreaming(false);
     return;
    }

   const reader = resp.body.getReader();
   const decoder = new TextDecoder();

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
      if (parsed.error) { recvRef.current += `\n⚠ ${parsed.error.message}`; continue; }
      if (parsed.tool_result) {
       const resultStr = JSON.stringify(parsed.tool_result.result, null, 2);
       recvRef.current += `\n\n🔧 **${parsed.tool_result.tool}** →\n\`\`\`json\n${resultStr.slice(0, 800)}\n\`\`\``;
       continue;
      }
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.reasoning_content) setThinking(prev => (prev + delta.reasoning_content).slice(-900));
      if (delta?.content) recvRef.current += delta.content;
     } catch {}
    }
   }

   // Stream ended — let the typewriter catch up, then commit.
   commitRef.current = true;
   setStreaming(false);
  } catch (e) {
   if (e.name !== 'AbortError') {
    if (recvRef.current.trim()) {
     setStreamBuf('');
     setThinking('');
     lenRef.current = 0;
     setMessages(prev => [...prev, { role: 'aimi', text: recvRef.current + '\n\n⚠ Connection interrupted: ' + e.message }]);
    } else {
     setMessages(prev => [...prev, { role: 'aimi', text: `⚠ Connection error: ${e.message}` }]);
    }
   }
   setStreaming(false);
  }
  abortRef.current = null;
  setXp(prev => prev + 20);
 }, [input, streaming]);

 const lastMsg = messages[messages.length - 1]?.text || '';
 const currentExpr = getExpression(lastMsg, streaming);

  // ── Closed: floating orb ──
  if (!open) {
   return (
    <button
     onClick={() => { if (movedRef.current) { movedRef.current = false; return; } setOpen(true); }}
     onPointerDown={onDragStart}
     onPointerMove={onDragMove}
     onPointerUp={onDragEnd}
     onPointerCancel={onDragEnd}
     className="fixed z-50 w-14 h-14 rounded-full group aimi-float flex items-center justify-center"
     style={{ left: mascotPos.left, top: mascotPos.top, background: `linear-gradient(135deg, ${AIMI.shell}, ${AIMI.core})`, boxShadow: `0 0 20px ${AIMI.core}44, 0 0 40px ${AIMI.shell}22`, touchAction: 'none', cursor: 'move' }}
     title={`Open ${companionName}`}
    >
     <AimiCanvas expression={currentExpr} stage={stage.level} streaming={streaming} size={56} />
     <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 56 56">
      <circle cx="28" cy="28" r="26" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
      <circle cx="28" cy="28" r="26" fill="none" stroke={stage.color} strokeWidth="2"
       strokeDasharray={`${(xp % 100) * 1.63} 163`} strokeLinecap="round" />
     </svg>
     {messages.length > 1 && (
      <div style={{ position: 'absolute', top: 2, right: 2, width: 8, height: 8, borderRadius: '50%', background: AIMI.alert, boxShadow: `0 0 6px ${AIMI.alert}` }} />
     )}
    </button>
   );
  }

  // ── Open: chat panel ──
  const panelWidth = Math.min(expanded ? 420 : 340, window.innerWidth - 8);
  const panelHeight = Math.min(expanded ? 540 : 420, window.innerHeight - 8);
  const panelLeft = Math.max(0, Math.min(mascotPos.left, window.innerWidth - panelWidth));
  const panelTop = Math.max(0, Math.min(mascotPos.top, window.innerHeight - panelHeight));

  return (
   <div className="fixed z-50 rounded-xl overflow-hidden flex flex-col"
    style={{ left: panelLeft, top: panelTop, background: `linear-gradient(180deg, ${AIMI.dark}, ${AIMI.mid})`, border: `1px solid ${AIMI.core}30`, boxShadow: `0 0 30px ${AIMI.core}22, 0 4px 20px rgba(0,0,0,0.5)`, width: panelWidth, height: panelHeight, transition: 'width 0.2s, height 0.2s' }}>

   {/* Header — draggable (except over its buttons) */}
   <div
    onPointerDown={e => { if (!e.target.closest('button, input, select, textarea')) onDragStart(e); }}
    onPointerMove={onDragMove}
    onPointerUp={onDragEnd}
    onPointerCancel={onDragEnd}
    className="flex items-center gap-2 px-3 py-2 select-none"
    style={{ background: `linear-gradient(90deg, ${AIMI.shell}33, transparent)`, borderBottom: `1px solid ${AIMI.core}20`, touchAction: 'none', cursor: 'move' }}>
    <div className="w-10 h-10 shrink-0">
     <AimiCanvas expression={currentExpr} stage={stage.level} streaming={streaming} size={40} />
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
        overflowWrap: 'anywhere',
       }}>
        {msg.role === 'aimi' && <span className="text-[10px] font-bold block mb-0.5" style={{ color: AIMI.core }}>{companionName}</span>}
       {msg.text}
      </div>
     </div>
    ))}
    {(streaming || streamBuf || thinking) && (
     <div className="flex justify-start">
      <div className="max-w-[90%] px-2.5 py-1.5 rounded-lg rounded-bl-sm text-xs leading-relaxed" style={{ background: `${AIMI.shell}22`, color: '#bbb', border: `1px solid ${AIMI.shell}33`, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        <span className="text-[10px] font-bold block mb-0.5" style={{ color: AIMI.core }}>{companionName}</span>
       {thinking && (
        <div className="mb-1 text-[11px] italic opacity-70" style={{ color: '#7c9ab8', borderLeft: `2px solid ${AIMI.shell}`, paddingLeft: 6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>▸ {thinking}{thinking.length >= 900 ? '…' : ''}</div>
       )}
       {streamBuf ? (
        <>{streamBuf}<span className="neon-pulse" style={{ display: 'inline-block', width: 4, height: 12, background: AIMI.core, marginLeft: 2, verticalAlign: 'middle', borderRadius: 1 }} /></>
       ) : streaming ? (
        <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: AIMI.accent }}>
         <span className="cf-dot">●</span><span className="cf-dot" style={{ animationDelay: '0.2s' }}>●</span><span className="cf-dot" style={{ animationDelay: '0.4s' }}>●</span>
         <span className="ml-1 opacity-60">thinking</span>
        </span>
       ) : null}
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
      placeholder={`Ask ${companionName} to do something...`}
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
