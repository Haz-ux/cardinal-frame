import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { useToast } from './ToastContext';
import { NEON, BG, GLOW, STATUS } from './theme';
import { MessageSquare, Plus, Trash2, Send, Paperclip, X, Bot, User, Wrench, Sparkles, ChevronLeft, ChevronRight, Cpu, Settings, Image, FileText, Code, Loader, Zap, ChevronDown, BookOpen, PanelRightOpen, PanelRightClose, Brain, Eye } from 'lucide-react';
import { FTSBreadcrumbs, TerminalAccordion, SubAgentMatrix, CodeSandboxBlock } from './ChatComponents';
import { HardwareMonitor, EndpointSwitcher, ContextTrimVisualizer } from './ResilienceComponents';
import { usePersonas } from './PersonaContext';
import WorkPanel from './WorkPanel';

export default function Chat() {
 const [conversations, setConversations] = useState([]);
 const [activeConv, setActiveConv] = useState(null);
 const [messages, setMessages] = useState([]);
 const [input, setInput] = useState('');
 const [streaming, setStreaming] = useState(false);
 const [streamBuf, setStreamBuf] = useState('');
 const [tools, setTools] = useState([]);
 const [skills, setSkills] = useState([]);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [personas, setPersonas] = useState([]);
  const [selectedPersona, setSelectedPersona] = useState('aimi');
  const [showPersonaPicker, setShowPersonaPicker] = useState(false);
// Sidebar starts closed on phones (where it overlays the chat) and open on desktop.
const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
 const [attachments, setAttachments] = useState([]);
 const [showTools, setShowTools] = useState(false);
 const [showModelPicker, setShowModelPicker] = useState(false);
 const [contextUsage, setContextUsage] = useState({ used: 0, total: 32000 });
 // ─── Agent mode state ───
 const [agentMode, setAgentMode] = useState('chat'); // 'chat' | 'agent' | 'suggest'
 const [agentSessionId, setAgentSessionId] = useState(null);
 const [agentActions, setAgentActions] = useState([]);
 const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const toast = useToast();
  const { name: personaName, companionName, personas: ctxPersonas } = usePersonas();
  const chatAgentName = personaName(selectedPersona);

  // Keep the persona picker live when personas are renamed elsewhere.
  useEffect(() => {
    if (ctxPersonas.length) {
      setPersonas(prev => ctxPersonas.map(cp => ({ ...(prev.find(p => p.id === cp.id) || {}), ...cp })));
    }
  }, [ctxPersonas]);

  // Load conversations, tools, skills, models
  useEffect(() => {
    api('/api/chat/conversations').then(setConversations).catch(() => {});
    api('/api/tools/enabled').then(setTools).catch(() => {});
    api('/api/skills/enabled').then(setSkills).catch(() => {});
    cachedFetch('/api/llm/models').then(m => {
      const list = Array.isArray(m) ? m : [];
      setModels(list);
      const def = list.find(m2 => m2.is_default);
      if (def) setSelectedModel(def.model_id);
    }).catch(() => {});
    api('/api/personas').then(d => {
      const list = Array.isArray(d?.personas) ? d.personas : [];
      setPersonas(list);
      if (d?.default && list.some(p => p.id === d.default)) setSelectedPersona(d.default);
    }).catch(() => {});
  }, []);

  // Load messages for active conversation
  useEffect(() => {
    if (activeConv) {
      api(`/api/chat/conversations/${activeConv.id}/messages`).then(msgs => {
        setMessages(msgs.map(m => ({ ...m, attachments: Array.isArray(m.attachments) ? m.attachments : JSON.parse(m.attachments || '[]'), tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls : JSON.parse(m.tool_calls || '[]') })));
      }).catch(() => setMessages([]));
    } else {
      setMessages([]);
    }
  }, [activeConv]);

  // Auto-scroll
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamBuf]);

  // New conversation
  const newConv = useCallback(async () => {
    try {
      const conv = await api('/api/chat/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'New Chat', model: selectedModel }),
      });
      setConversations(prev => [conv, ...prev]);
      setActiveConv(conv);
      setMessages([]);
      toast.success('New conversation created');
    } catch (e) { toast.error('Failed to create conversation'); }
  }, [selectedModel, toast]);

  // Delete conversation
  const deleteConv = useCallback(async (id) => {
    try {
      await api(`/api/chat/conversations/${id}`, { method: 'DELETE' });
      setConversations(prev => prev.filter(c => c.id !== id));
      if (activeConv?.id === id) { setActiveConv(null); setMessages([]); }
      toast.info('Conversation deleted');
    } catch (e) { toast.error('Delete failed'); }
  }, [activeConv, toast]);

  // File attachment handler
  const handleFileAttach = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments(prev => [...prev, {
          name: file.name,
          type: file.type,
          size: file.size,
          data: reader.result, // base64
          preview: file.type.startsWith('image/') ? reader.result : null,
        }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  }, []);

  // Upload attachments to server
  const uploadAttachments = useCallback(async () => {
    const uploaded = [];
    for (const att of attachments) {
      try {
        const b64 = att.data.split(',')[1];
        const resp = await api('/api/chat/upload', {
          method: 'POST',
          body: JSON.stringify({ filename: att.name, mime_type: att.type, content_b64: b64 }),
        });
        uploaded.push({ id: resp.id, filename: resp.filename, mime_type: resp.mime_type, size: resp.size });
      } catch (e) { /* skip failed uploads */ }
    }
    return uploaded;
  }, [attachments]);

  // Send message (streaming SSE)
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && !attachments.length) return;
    if (streaming) return;

    // If no active conversation, create one
    let conv = activeConv;
    if (!conv) {
      try {
        conv = await api('/api/chat/conversations', {
          method: 'POST',
          body: JSON.stringify({ title: text.slice(0, 40) || 'New Chat', model: selectedModel }),
        });
        setConversations(prev => [conv, ...prev]);
        setActiveConv(conv);
      } catch (e) { toast.error('Failed to create conversation'); return; }
    }

    const userMsg = { role: 'user', content: text, attachments: attachments.map(a => ({ filename: a.name, mime_type: a.type, size: a.size })) };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    setStreamBuf('');

    // Upload files
    const uploaded = await uploadAttachments();
    setAttachments([]);

    // Build message history for the LLM
    const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const token = localStorage.getItem('cf_token');
      const resp = await fetch('/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          messages: history,
          model: selectedModel || undefined,
          conversation_id: conv.id,
          stream: true,
          persona: selectedPersona || 'direct',
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
        toast.error(err.error?.message || 'Chat request failed');
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
            if (parsed.error) { toast.error(parsed.error.message); continue; }
            if (parsed.tool_result) {
              // Tool result event — show inline
              fullContent += `\n\n⟨ Tool: ${parsed.tool_result.tool} ⟩\n\`\`\`json\n${JSON.stringify(parsed.tool_result.result, null, 2).slice(0, 500)}\n\`\`\``;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) fullContent += delta;
          } catch {}
        }
        setStreamBuf(fullContent);
      }

      // Add assistant message
      setMessages(prev => [...prev, { role: 'assistant', content: fullContent, model: selectedModel }]);
      setStreamBuf('');
    } catch (e) {
      if (e.name !== 'AbortError') toast.error('Stream error: ' + e.message);
    }
    setStreaming(false);
    abortRef.current = null;
  }, [input, attachments, messages, activeConv, selectedModel, streaming, uploadAttachments, toast]);

  // ─── Agent mode: handle send with autonomous/suggest flow ───
  const handleAgentSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    let conv = activeConv;
    if (!conv) {
      try {
        conv = await api('/api/chat/conversations', {
          method: 'POST',
          body: JSON.stringify({ title: text.slice(0, 40) || 'Agent Task', model: selectedModel }),
        });
        setConversations(prev => [conv, ...prev]);
        setActiveConv(conv);
      } catch (e) { toast.error('Failed to create conversation'); return; }
    }

    const userMsg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);

    try {
      // Step 1: Create agent session
      const session = await api('/api/agent/sessions', {
        method: 'POST',
        body: JSON.stringify({
          task: text,
          mode: agentMode === 'agent' ? 'agent' : 'suggest',
          scope: 'sandbox',
          conversation_id: conv.id,
          model: selectedModel || undefined,
        }),
      });
      setAgentSessionId(session.id);

      // Step 2: Generate a plan
      const planResp = await api('/api/agent/plan', {
        method: 'POST',
        body: JSON.stringify({ task: text, scope: 'sandbox', model: selectedModel || undefined }),
      });

      // Show plan to user
      const planMsg = {
        role: 'assistant',
        content: `**${chatAgentName} Plan** (${agentMode === 'agent' ? 'Agent' : 'Suggest'} mode)\n\n` +
          planResp.plan.map((s, i) => `${i + 1}. ${s.description} — \`${s.action}\` → \`${s.target}\``).join('\n') +
          '\n\n_Working through steps..._',
        model: selectedModel,
        metadata: { plan: planResp.plan },
      };
      setMessages(prev => [...prev, planMsg]);

      // Step 3: Execute plan steps (agent mode) or draft (suggest mode)
      const mode = agentMode;
      for (let i = 0; i < planResp.plan.length; i++) {
        const step = planResp.plan[i];

        let actionMsg = { role: 'tool', content: '', metadata: {} };

        if (step.action === 'read') {
          try {
            const result = await api('/api/agent/read', {
              method: 'POST',
              body: JSON.stringify({ path: step.target, scope: 'sandbox' }),
            });
            actionMsg.content = `📍 Read \`${step.target}\` (${result.size} bytes)`;
            actionMsg.metadata.fileContent = result.content;
          } catch (e) {
            actionMsg.content = `⚠️ Read failed: ${e.error || e.message}`;
          }
        } else if (step.action === 'write') {
          try {
            const result = await api('/api/agent/write', {
              method: 'POST',
              body: JSON.stringify({
                path: step.target,
                content: step.content || `// Generated by ${chatAgentName} for: ${step.description}\n// No content provided for this step.\n`,
                scope: 'sandbox',
                session_id: session.id,
                mode: mode === 'agent' ? 'agent' : 'suggest',
              }),
            });
            if (result.action === 'draft') {
              actionMsg.content = `📝 **Suggest**: Draft for \`${step.target}\` — awaiting your approval`;
              actionMsg.metadata.draft = result;
            } else {
              actionMsg.content = `✅ Wrote \`${step.target}\` (${result.size} bytes)`;
            }
          } catch (e) {
            actionMsg.content = `⚠️ Write failed: ${e.error || e.message}`;
          }
        } else if (step.action === 'exec') {
          try {
            const result = await api('/api/agent/exec', {
              method: 'POST',
              body: JSON.stringify({ command: step.target, scope: 'sandbox', session_id: session.id }),
            });
            const out = result.stdout || result.stderr || '';
            actionMsg.content = `⚙️ Exec: \`${step.target}\`\n\`\`\`\n${out.slice(0, 1000)}\n\`\`\``;
            actionMsg.metadata.exitCode = result.exitCode;
          } catch (e) {
            actionMsg.content = `⚠️ Exec blocked: ${e.error || e.message}`;
          }
        } else {
          actionMsg.content = `ℹ️ ${step.description}`;
        }

        setMessages(prev => [...prev, actionMsg]);
      }

      // Step 4: Iterate — ask LLM if done
      const iterateResp = await api('/api/agent/iterate', {
        method: 'POST',
        body: JSON.stringify({
          session_id: session.id,
          context: { message: 'Execute the plan above' },
          model: selectedModel || undefined,
        }),
      });

      const finalMsg = {
        role: 'assistant',
        content: iterateResp.done
          ? `✅ **Task complete!**\n\n${iterateResp.nextAction?.content || 'Done.'}`
          : `_(Intermediate)_ ${iterateResp.nextAction?.content || 'Continuing...'}`,
        model: selectedModel,
      };
      setMessages(prev => [...prev, finalMsg]);
    } catch (e) {
      toast.error('Agent error: ' + (e.message || e.error || 'Unknown'));
    }
    setStreaming(false);
  }, [input, activeConv, selectedModel, selectedPersona, streaming, agentMode, toast]);

  // Handle approve/reject from WorkPanel
  const handleAgentAction = useCallback(async (type, actionId) => {
    try {
      if (type === 'approve') {
        await api('/api/agent/approve', {
          method: 'POST',
          body: JSON.stringify({ action_id: actionId, scope: 'sandbox' }),
        });
        toast.success('Change approved and written');
      } else {
        await api('/api/agent/reject', {
          method: 'POST',
          body: JSON.stringify({ action_id: actionId }),
        });
        toast.info('Change rejected');
      }
      // Refresh actions
      if (agentSessionId) {
        const updated = await api(`/api/agent/sessions/${agentSessionId}`);
        setAgentActions(updated.actions || []);
      }
    } catch (e) { toast.error('Action failed: ' + e.message); }
  }, [agentSessionId, toast]);

  // File icon by type
  const fileIcon = (type) => {
    if (type?.startsWith('image/')) return <Image size={14} />;
    if (type?.includes('json') || type?.includes('javascript') || type?.includes('code')) return <Code size={14} />;
    return <FileText size={14} />;
  };

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, position: 'relative' }}>
      {/* Mobile backdrop — closes the conversation sidebar on tap */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-30 bg-black/60" onClick={() => setSidebarOpen(false)} />
      )}
      {/* ── Sidebar: Conversations ── */}
      {sidebarOpen && (
        <div className="max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:shadow-2xl" style={{ width: 240, background: BG.surface, borderRight: `1px solid ${NEON.cyan}10`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: '12px 12px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: NEON.cyan, fontWeight: 700, fontSize: 13, letterSpacing: 1 }}>CHATS</span>
            <button onClick={newConv} style={iconBtnStyle} title="New chat"><Plus size={16} /></button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '0 6px' }}>
            {conversations.map(c => (
              <div key={c.id} onClick={() => setActiveConv(c)} style={{
                padding: '8px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2,
                background: activeConv?.id === c.id ? `${NEON.cyan}12` : 'transparent',
                border: activeConv?.id === c.id ? `1px solid ${NEON.cyan}30` : '1px solid transparent',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <MessageSquare size={13} style={{ color: activeConv?.id === c.id ? NEON.cyan : '#555', flexShrink: 0 }} />
                <span style={{ flex: 1, color: activeConv?.id === c.id ? '#fff' : '#aaa', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.title}
                </span>
                <button onClick={e => { e.stopPropagation(); deleteConv(c.id); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#444', padding: 2, display: 'flex' }}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {conversations.length === 0 && (
              <div style={{ color: '#444', fontSize: 12, padding: 16, textAlign: 'center' }}>No conversations yet</div>
            )}
          </div>
          {/* Sidebar footer: tools count */}
          <div style={{ padding: '8px 12px', borderTop: `1px solid ${NEON.cyan}08`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#555', fontSize: 11 }}>{tools.length} tools · {skills.length} skills</span>
            <button onClick={() => setSidebarOpen(false)} style={iconBtnStyle}><ChevronLeft size={14} /></button>
          </div>
        </div>
      )}
      {!sidebarOpen && (
        <button onClick={() => setSidebarOpen(true)} style={{ ...iconBtnStyle, margin: 8, alignSelf: 'flex-start' }}>
          <ChevronRight size={16} />
        </button>
      )}

      {/* ── Main Chat Area ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Top bar */}
      <div style={{ padding: '8px 16px', borderBottom: `1px solid ${NEON.cyan}10`, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
      <span style={{ color: '#fff', fontWeight: 600, fontSize: 15 }}>{activeConv?.title || 'Cardinal Frame Chat'}</span>
      <div style={{ flex: 1 }} />

      {/* ─── Agent Mode Toggle (Like VS Code Copilot) ─── */}
      <div style={{
        display: 'flex', gap: 2, background: BG.surface,
        border: `1px solid ${NEON.cyan}15`, borderRadius: 20, padding: 2,
      }}>
        {['chat', 'suggest', 'agent'].map(m => {
          const active = agentMode === m;
          const colors = {
            chat: NEON.cyan,
            suggest: NEON.magenta,
            agent: NEON.green,
          };
          const labels = { chat: 'Chat', suggest: 'Suggest', agent: 'Agent' };
          return (
            <button
              key={m}
              onClick={() => setAgentMode(m)}
              style={{
                background: active ? `${colors[m]}20` : 'transparent',
                border: 'none', borderRadius: 16,
                padding: '3px 10px', fontSize: 10, fontWeight: 700,
                color: active ? colors[m] : '#666',
                cursor: 'pointer', letterSpacing: 0.5, transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', gap: 3,
              }}
            >
              {m === 'chat' && <MessageSquare size={10} />}
              {m === 'suggest' && <Eye size={10} />}
              {m === 'agent' && <Brain size={10} />}
              {labels[m]}
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
          {/* Persona picker */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowPersonaPicker(!showPersonaPicker)} style={{
              ...pillBtnStyle, background: `${NEON.purple}10`, border: `1px solid ${NEON.purple}25`,
              color: NEON.purple, display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: (personas.find(p => p.id === selectedPersona)?.color) || '#888', display: 'inline-block' }} />
              {personas.find(p => p.id === selectedPersona)?.name || 'Direct'} <ChevronDown size={12} />
            </button>
            {showPersonaPicker && (
            <div style={{ position: 'absolute', right: 0, top: '100%', width: 260, maxHeight: 320, overflow: 'auto', background: BG.card, border: `1px solid ${NEON.purple}30`, borderRadius: 8, zIndex: 60, boxShadow: `0 8px 24px rgba(0,0,0,0.5)` }}>
            {personas.map(p => (
            <div key={p.id} onClick={() => { setSelectedPersona(p.id); setShowPersonaPicker(false); }} style={{
            padding: '8px 12px', cursor: 'pointer', fontSize: 12,
            background: selectedPersona === p.id ? `${NEON.purple}15` : 'transparent',
            borderBottom: `1px solid #ffffff06`,
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
            <span style={{ fontWeight: 600, color: selectedPersona === p.id ? NEON.purple : '#fff' }}>{p.name}</span>
            {selectedPersona === p.id && <span style={{ marginLeft: 'auto', color: NEON.purple, fontSize: 10 }}>ACTIVE</span>}
            </div>
            <div style={{ color: '#888', fontSize: 10, marginTop: 2, marginLeft: 14 }}>{p.tagline}</div>
            </div>
            ))}
            <div onClick={() => { setSelectedPersona(''); setShowPersonaPicker(false); }} style={{
            padding: '8px 12px', cursor: 'pointer', fontSize: 12, color: '#888',
            background: selectedPersona === '' ? `${NEON.cyan}15` : 'transparent',
            borderTop: `1px solid #ffffff0a`,
            }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: '#666', display: 'inline-block' }} /> Direct (no persona)</span>
            </div>
            {personas.length === 0 && <div style={{ padding: 16, color: '#555', fontSize: 12, textAlign: 'center' }}>No personas available.</div>}
            </div>
            )}
          </div>
          {/* Model picker */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowModelPicker(!showModelPicker)} style={{
              ...pillBtnStyle, background: `${NEON.cyan}10`, border: `1px solid ${NEON.cyan}25`,
              color: NEON.cyan, display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <Cpu size={13} /> {selectedModel ? (selectedModel.length > 24 ? selectedModel.slice(0, 22) + '…' : selectedModel) : 'Select Model'} <ChevronDown size={12} />
            </button>
            {showModelPicker && (
            <div style={{ position: 'absolute', right: 0, top: '100%', width: 320, maxHeight: 300, overflow: 'auto', background: BG.card, border: `1px solid ${NEON.cyan}30`, borderRadius: 8, zIndex: 50, boxShadow: `0 8px 24px rgba(0,0,0,0.5)` }}>
            {models.slice(0, 20).map(m => (
            <div key={m.id} onClick={() => { setSelectedModel(m.model_id); setShowModelPicker(false); }} style={{
            padding: '6px 12px', cursor: 'pointer', fontSize: 12,
            background: selectedModel === m.model_id ? `${NEON.cyan}15` : 'transparent',
            color: selectedModel === m.model_id ? NEON.cyan : '#ccc',
            borderBottom: `1px solid #ffffff06`,
            }}>
            {m.display_name || m.model_id}
            {m.is_default && <span style={{ marginLeft: 8, color: NEON.green, fontSize: 10 }}>DEFAULT</span>}
            </div>
            ))}
            {models.length > 20 && <div style={{ padding: 8, color: '#555', fontSize: 10, textAlign: 'center' }}>{models.length - 20} more — use LLM Providers tab to browse all</div>}
            {models.length === 0 && <div style={{ padding: 16, color: '#555', fontSize: 12, textAlign: 'center' }}>No models detected. Add an LLM provider first.</div>}
            </div>
            )}
          </div>
          {/* Tools toggle */}
          <button onClick={() => setShowTools(!showTools)} style={{
            ...pillBtnStyle, background: showTools ? `${NEON.magenta}15` : `${NEON.magenta}08`,
            border: `1px solid ${NEON.magenta}${showTools ? '40' : '20'}`,
            color: NEON.magenta, display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <Wrench size={13} /> Tools
          </button>
        </div>

        {/* Hardware Monitor Overlay */}
        <HardwareMonitor contextUsage={contextUsage} streaming={streaming} />

        {/* Context Window Trim Visualizer */}
        <ContextTrimVisualizer contextUsage={contextUsage} onContextUpdate={setContextUsage} />

        {/* Tools panel (collapsible) */}
        {showTools && (
          <div style={{ padding: '8px 16px', background: `${BG.surface}`, borderBottom: `1px solid ${NEON.magenta}10`, display: 'flex', flexWrap: 'wrap', gap: 6, flexShrink: 0 }}>
            {tools.map(t => (
              <div key={t.id} style={{
                background: `${NEON.magenta}08`, border: `1px solid ${NEON.magenta}20`, borderRadius: 6,
                padding: '3px 8px', fontSize: 11, color: '#ccc', display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <Zap size={10} style={{ color: NEON.magenta }} />
                <span style={{ fontWeight: 600, color: NEON.magenta }}>{t.name}</span>
                <span style={{ color: '#666' }}>— {t.description.slice(0, 40)}</span>
              </div>
            ))}
            {skills.map(s => (
              <div key={s.id} style={{
                background: `${NEON.purple}08`, border: `1px solid ${NEON.purple}20`, borderRadius: 6,
                padding: '3px 8px', fontSize: 11, color: '#ccc', display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <Sparkles size={10} style={{ color: NEON.purple }} />
                <span style={{ fontWeight: 600, color: NEON.purple }}>{s.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Messages area */}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 14px' }}>
        {/* FTS Context Breadcrumbs — shows injected context at conversation top */}
        <FTSBreadcrumbs conversationId={activeConv?.id} />

        {messages.length === 0 && !streamBuf && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#444' }}>
              <MessageSquare size={48} style={{ marginBottom: 12, opacity: 0.2 }} />
              <div style={{ fontSize: 14, marginBottom: 4 }}>Start a conversation</div>
              <div style={{ fontSize: 12, color: '#333' }}>Select a model, type a message, or attach files</div>
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))}

          {/* Streaming buffer */}
          {streamBuf && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${NEON.cyan}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Bot size={14} style={{ color: NEON.cyan }} />
              </div>
              <div style={{ flex: 1, background: `${BG.card}`, border: `1px solid ${NEON.cyan}15`, borderRadius: '0 12px 12px 12px', padding: '10px 14px' }}>
                <div style={{ color: '#ccc', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  <MarkdownContent content={streamBuf} />
                  <span className="neon-pulse" style={{ display: 'inline-block', width: 6, height: 14, background: NEON.cyan, marginLeft: 2, verticalAlign: 'middle', borderRadius: 1 }} />
                </div>
              </div>
            </div>
          )}

          {/* Agent Work Panel */}
          {agentSessionId && agentMode !== 'chat' && (
            <WorkPanel
              sessionId={agentSessionId}
              mode={agentMode}
              onAction={handleAgentAction}
            />
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Attachments preview */}
        {attachments.length > 0 && (
          <div style={{ padding: '8px 16px', display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: `1px solid ${NEON.cyan}08` }}>
            {attachments.map((a, i) => (
              <div key={i} style={{
                background: `${BG.card}`, border: `1px solid ${NEON.cyan}20`, borderRadius: 8,
                padding: '4px 8px', fontSize: 11, color: '#ccc', display: 'flex', alignItems: 'center', gap: 6, maxWidth: 200,
              }}>
                {a.preview ? <img src={a.preview} style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 4 }} /> : fileIcon(a.type)}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{a.name}</span>
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: 0, display: 'flex' }}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input area */}
        <div style={{ padding: '12px 16px', borderTop: `1px solid ${NEON.cyan}10`, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <input type="file" ref={fileInputRef} onChange={handleFileAttach} style={{ display: 'none' }} multiple />
        <button onClick={() => fileInputRef.current?.click()} style={iconBtnStyle} title="Attach files">
        <Paperclip size={16} />
        </button>
        <textarea
        ref={inputRef}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentMode !== 'chat' ? handleAgentSend() : handleSend(); } }}
        placeholder={
          agentMode === 'agent' ? `${chatAgentName} will plan + execute autonomously...` :
          agentMode === 'suggest' ? `${chatAgentName} will draft changes for your approval...` :
          selectedModel ? `Message ${selectedModel.split('/').pop()}...` : 'Type a message...'
        }
        rows={1}
        style={{
        flex: 1, background: BG.surface, border: `1px solid ${NEON.cyan}20`, borderRadius: 10,
        padding: '10px 14px', color: '#fff', fontSize: 13, outline: 'none', resize: 'none',
        minHeight: 40, maxHeight: 120, fontFamily: 'inherit', lineHeight: 1.5,
        }}
        />
        <button onClick={() => agentMode !== 'chat' ? handleAgentSend() : handleSend()} disabled={streaming || (!input.trim() && !attachments.length)} style={{
        ...iconBtnStyle,
        background: streaming ? `${NEON.cyan}10` : `${NEON.cyan}20`,
        color: streaming ? '#555' : NEON.cyan,
        boxShadow: streaming ? 'none' : GLOW.cyan,
        cursor: streaming ? 'not-allowed' : 'pointer',
        }}>
        {streaming ? <Loader size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
        </div>

        {/* Endpoint Switcher — model picker with cost/tier info */}
        <EndpointSwitcher
        models={models}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        />
        </div>
        </div>
        </div>
        );
        }

// ─── Message Bubble ──────────────────────────────────────────────
function MessageBubble({ msg }) {
 const isUser = msg.role === 'user';
 const isSystem = msg.role === 'system';
 const isTool = msg.role === 'tool';
 const isAssistant = msg.role === 'assistant';

 if (isSystem) return null;

 // Detect structured tool execution steps in message metadata
 const execSteps = msg.metadata?.execution_steps || [];
 const subAgents = msg.metadata?.sub_agents || [];
 const sandboxCode = msg.metadata?.sandbox_code || null;

 return (
 <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexDirection: isUser ? 'row-reverse' : 'row' }}>
 <div style={{
 width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
 background: isUser ? `${NEON.purple}15` : isTool ? `${NEON.magenta}15` : `${NEON.cyan}15`,
 display: 'flex', alignItems: 'center', justifyContent: 'center',
 }}>
 {isUser ? <User size={14} style={{ color: NEON.purple }} /> : isTool ? <Wrench size={14} style={{ color: NEON.magenta }} /> : <Bot size={14} style={{ color: NEON.cyan }} />}
 </div>
 <div style={{
 flex: 1, maxWidth: '80%',
 background: isUser ? `${NEON.purple}10` : isTool ? `${NEON.magenta}08` : BG.card,
 border: `1px solid ${isUser ? NEON.purple + '20' : isTool ? NEON.magenta + '20' : NEON.cyan + '15'}`,
 borderRadius: isUser ? '12px 2px 12px 12px' : '2px 12px 12px 12px',
 padding: '10px 14px',
 }}>
 {isTool && <div style={{ color: NEON.magenta, fontSize: 10, fontWeight: 700, marginBottom: 4, letterSpacing: 1 }}>TOOL RESULT</div>}
 <div style={{ color: '#ccc', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
 <MarkdownContent content={msg.content} />
 </div>

 {/* ── Rich inline components for structured messages ── */}
 {execSteps.length > 0 && <TerminalAccordion steps={execSteps} title="Execution Log" />}
 {subAgents.length > 0 && <SubAgentMatrix agents={subAgents} parentLabel={msg.model || 'AI'} />}
 {sandboxCode && <CodeSandboxBlock initialCode={sandboxCode.code} language={sandboxCode.language || 'javascript'} title={sandboxCode.title} />}

 {/* Attachments */}
 {msg.attachments?.length > 0 && (
 <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
 {msg.attachments.map((a, i) => (
 <div key={i} style={{
 background: '#ffffff08', border: '1px solid #ffffff10', borderRadius: 6,
 padding: '3px 8px', fontSize: 11, color: '#888', display: 'flex', alignItems: 'center', gap: 4,
 }}>
 <FileText size={10} /> {a.filename || a.name}
 </div>
 ))}
 </div>
 )}
 {msg.model && <div style={{ marginTop: 6, color: '#444', fontSize: 10 }}>{msg.model}</div>}
 </div>
 </div>
 );
}

// ─── Simple Markdown-ish renderer ────────────────────────────────
function MarkdownContent({ content }) {
  if (!content) return null;
  // Split into code blocks and regular text
  const parts = content.split(/(```[\s\S]*?```)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const lang = part.match(/```(\w+)/)?.[1] || '';
          const code = part.slice(part.indexOf('\n') + 1, -3);
          return (
            <pre key={i} style={{
              background: '#0a0a1a', border: `1px solid ${NEON.cyan}10`, borderRadius: 8,
              padding: '10px 12px', margin: '8px 0', overflow: 'auto', fontSize: 12, lineHeight: 1.5,
            }}>
              {lang && <div style={{ color: NEON.cyan, fontSize: 10, marginBottom: 4, fontWeight: 700, textTransform: 'uppercase' }}>{lang}</div>}
              <code style={{ color: '#ccc' }}>{code}</code>
            </pre>
          );
        }
        // Inline code
        const inline = part.replace(/`([^`]+)`/g, '⟨CODE:$1⟩');
        const segments = inline.split(/⟨CODE:([^⟩]+)⟩/g);
        return (
          <span key={i}>
            {segments.map((seg, j) =>
              j % 2 === 1
                ? <code key={j} style={{ background: '#ffffff08', padding: '1px 4px', borderRadius: 3, fontSize: 12, color: NEON.cyan }}>{seg}</code>
                : seg
            )}
          </span>
        );
      })}
    </>
  );
}

const iconBtnStyle = {
  background: 'transparent', border: '1px solid #ffffff10', borderRadius: 8,
  padding: '6px 8px', color: '#888', cursor: 'pointer', display: 'flex', alignItems: 'center',
};

const pillBtnStyle = {
  borderRadius: 20, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: 4, letterSpacing: 0.5,
};
