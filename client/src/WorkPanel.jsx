import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from './AuthContext';
import { usePolling } from './usePolling';
import { usePersonas } from './PersonaContext';
import { NEON, BG, GLOW } from './theme';
import { CheckCircle, XCircle, Loader, FileText, Terminal, ChevronDown, ChevronRight, Brain, Zap, Eye, Code } from 'lucide-react';

// ─── WorkPanel: Collapsible branch showing companion agent actions ─
// Shows plan steps, file diffs, terminal output, approve/reject buttons
export default function WorkPanel({ sessionId, mode, onAction }) {
  const { companionName } = usePersonas();
  const [expanded, setExpanded] = useState(true);
  const [session, setSession] = useState(null);
  const [actions, setActions] = useState([]);
  const [plan, setPlan] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Load session + actions
  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api(`/api/agent/sessions/${sessionId}`);
      setSession(data);
      setActions(data.actions || []);
      setPlan(data.plan || []);
    } catch (e) {
      // Session might not exist yet
    }
  }, [sessionId]);

  // Poll for updates when session is active (visibility-aware, 4s)
  const statuses = ['planning', 'executing', 'awaiting_approval'];
  const isPolling = !!(session && statuses.includes(session.status));
  usePolling(loadSession, 8000, isPolling);

  // Initial load on session change
  useEffect(() => { if (sessionId) loadSession(); }, [sessionId, loadSession]);

  if (!sessionId) return null;

  const stepIcon = (action) => {
    switch (action.action_type) {
      case 'read': return <FileText size={12} />;
      case 'write': return <Code size={12} />;
      case 'exec': return <Terminal size={12} />;
      case 'plan': return <Brain size={12} />;
      case 'iterate': return <Zap size={12} />;
      default: return <FileText size={12} />;
    }
  };

  const stepColor = (action) => {
    if (action.status === 'completed' || action.status === 'approved') return NEON.green;
    if (action.status === 'failed' || action.status === 'rejected') return NEON.red || '#ff4466';
    if (action.status === 'pending') return NEON.magenta;
    if (action.status === 'running') return NEON.cyan;
    return '#555';
  };

  return (
    <div style={{
      margin: '8px 0 12px',
      background: `${BG.surface}`,
      border: `1px solid ${NEON.cyan}20`,
      borderRadius: '0 12px 12px 12px',
      overflow: 'hidden',
    }}>
      {/* Header bar */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
          cursor: 'pointer', background: `${NEON.cyan}08`,
          borderBottom: expanded ? `1px solid ${NEON.cyan}10` : 'none',
        }}
      >
        {expanded ? <ChevronDown size={14} style={{ color: NEON.cyan }} /> : <ChevronRight size={14} style={{ color: NEON.cyan }} />}
        <Brain size={14} style={{ color: NEON.cyan }} />
        <span style={{ color: NEON.cyan, fontWeight: 700, fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' }}>
          {companionName} Work Panel
        </span>
        <span style={{
          color: mode === 'agent' ? NEON.green : NEON.magenta,
          fontSize: 10, fontWeight: 600,
          background: mode === 'agent' ? `${NEON.green}15` : `${NEON.magenta}15`,
          padding: '2px 6px', borderRadius: 4, marginLeft: 4,
        }}>
          {mode === 'agent' ? 'AGENT' : 'SUGGEST'}
        </span>
        {session?.status && (
          <span style={{ color: '#666', fontSize: 10, marginLeft: 'auto' }}>{session.status}</span>
        )}
        {loading && <Loader size={12} className="animate-spin" style={{ color: NEON.cyan }} />}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ padding: '8px 12px', maxHeight: 400, overflow: 'auto' }}>
          {/* Plan steps */}
          {plan.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ color: '#666', fontSize: 10, fontWeight: 700, marginBottom: 4, letterSpacing: 1 }}>PLAN</div>
              {plan.map((step, i) => {
                const matchingAction = actions.find(a => a.step_index === i);
                const isDone = matchingAction && (matchingAction.status === 'completed' || matchingAction.status === 'approved');
                const isFailed = matchingAction && matchingAction.status === 'failed';
                const isPending = matchingAction && matchingAction.status === 'pending';
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '3px 0', fontSize: 12,
                  }}>
                    <span style={{
                      width: 16, height: 16, borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, fontSize: 9,
                      background: isDone ? `${NEON.green}20` : isFailed ? `${NEON.red || '#ff4466'}20` : isPending ? `${NEON.magenta}20` : '#ffffff08',
                      color: isDone ? NEON.green : isFailed ? (NEON.red || '#ff4466') : isPending ? NEON.magenta : '#666',
                    }}>
                      {isDone ? '✓' : isFailed ? '✗' : isPending ? '…' : i + 1}
                    </span>
                    <span style={{ color: isDone ? NEON.green : '#999', flex: 1 }}>{step.description || step.action}</span>
                    {step.target && <span style={{ color: '#555', fontSize: 10 }}>{step.target}</span>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Actions log */}
          <div style={{ color: '#666', fontSize: 10, fontWeight: 700, marginBottom: 4, letterSpacing: 1 }}>ACTIONS</div>
          {actions.length === 0 && (
            <div style={{ color: '#444', fontSize: 11, padding: '4px 0' }}>No actions yet — waiting for {companionName} to start...</div>
          )}
          {actions.map((action, i) => (
            <ActionRow key={action.id || i} action={action} mode={mode} onAction={onAction} />
          ))}

          {/* Error */}
          {error && (
            <div style={{ color: NEON.red || '#ff4466', fontSize: 11, padding: '4px 0' }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Action Row: individual action with diff/terminal/approve ─────
function ActionRow({ action, mode, onAction }) {
  const [expanded, setExpanded] = useState(false);
  const color = stepColor(action);

  return (
    <div style={{
      marginBottom: 4,
      padding: '4px 8px',
      background: '#ffffff04',
      borderRadius: 6,
      border: `1px solid ${color}15`,
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
      >
        <span style={{ color, display: 'flex' }}>{action.action_type === 'read' ? <FileText size={11} /> : action.action_type === 'exec' ? <Terminal size={11} /> : action.action_type === 'write' ? <Code size={11} /> : <Zap size={11} />}</span>
        <span style={{ color: color, fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>{action.action_type}</span>
        <span style={{ color: '#999', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {action.target || ''}
        </span>
        <span style={{ color, fontSize: 9, fontWeight: 600, textTransform: 'uppercase' }}>{action.status}</span>
      </div>

      {/* Expanded view */}
      {expanded && (
        <div style={{ marginTop: 6 }}>
          {/* For write actions in suggest mode: show diff + approve/reject */}
          {action.action_type === 'write' && action.status === 'pending' && mode === 'suggest' && (
            <div style={{ marginTop: 4 }}>
              <DiffView oldContent={action.result || ''} newContent={action.content || ''} />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button
                  onClick={() => onAction?.('approve', action.id)}
                  style={{
                    background: `${NEON.green}20`, border: `1px solid ${NEON.green}40`, borderRadius: 6,
                    padding: '4px 12px', color: NEON.green, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <CheckCircle size={12} /> Approve & Write
                </button>
                <button
                  onClick={() => onAction?.('reject', action.id)}
                  style={{
                    background: `${NEON.red || '#ff4466'}15`, border: `1px solid ${NEON.red || '#ff4466'}30`, borderRadius: 6,
                    padding: '4px 12px', color: NEON.red || '#ff4466', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 4,
                  }}
                >
                  <XCircle size={12} /> Reject
                </button>
              </div>
            </div>
          )}

          {/* For exec actions: show terminal output */}
          {action.action_type === 'exec' && action.result && (
            <pre style={{
              background: '#0a0a1a', border: `1px solid ${NEON.cyan}10`, borderRadius: 6,
              padding: '6px 8px', margin: '4px 0', fontSize: 11, color: '#aaa',
              overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap',
            }}>
              {action.result.slice(0, 2000)}
            </pre>
          )}

          {/* For read actions: show file content preview */}
          {action.action_type === 'read' && action.result && (
            <pre style={{
              background: '#0a0a1a', border: `1px solid ${NEON.cyan}10`, borderRadius: 6,
              padding: '6px 8px', margin: '4px 0', fontSize: 11, color: '#aaa',
              overflow: 'auto', maxHeight: 150, whiteSpace: 'pre-wrap',
            }}>
              {action.result.slice(0, 1000)}
            </pre>
          )}

          {/* For iterate: show JSON result */}
          {action.action_type === 'iterate' && action.result && (
            <pre style={{
              background: '#0a0a1a', border: `1px solid ${NEON.purple}10`, borderRadius: 6,
              padding: '6px 8px', margin: '4px 0', fontSize: 11, color: '#aaa',
              overflow: 'auto', maxHeight: 150, whiteSpace: 'pre-wrap',
            }}>
              {action.result.slice(0, 1000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Diff View: simple line-by-line diff ──────────────────────────
function DiffView({ oldContent, newContent }) {
  const oldLines = (oldContent || '').split('\n');
  const newLines = (newContent || '').split('\n');
  const maxLines = Math.max(oldLines.length, newLines.length);

  return (
    <div style={{
      background: '#0a0a1a', border: `1px solid ${NEON.cyan}15`, borderRadius: 6,
      padding: 0, margin: '4px 0', overflow: 'auto', maxHeight: 250, fontSize: 11,
      fontFamily: 'monospace',
    }}>
      {Array.from({ length: maxLines }).map((_, i) => {
        const old = oldLines[i] || '';
        const isNew = i >= oldLines.length;
        const isModified = !isNew && old !== newLines[i];
        const line = newLines[i] || '';
        const isAdd = isNew || (isModified && !old);
        const isDel = i >= newLines.length;

        if (isDel) {
          return (
            <div key={i} style={{ display: 'flex', padding: '0 8px', background: `${NEON.red || '#ff4466'}08` }}>
              <span style={{ color: NEON.red || '#ff4466', width: 16 }}>-</span>
              <span style={{ color: '#888', whiteSpace: 'pre' }}>{old}</span>
            </div>
          );
        }
        if (isAdd || isModified) {
          return (
            <div key={i} style={{ display: 'flex', padding: '0 8px', background: `${NEON.green}08` }}>
              <span style={{ color: NEON.green, width: 16 }}>+</span>
              <span style={{ color: '#ccc', whiteSpace: 'pre' }}>{line}</span>
            </div>
          );
        }
        return (
          <div key={i} style={{ display: 'flex', padding: '0 8px' }}>
            <span style={{ color: '#444', width: 16 }}> </span>
            <span style={{ color: '#666', whiteSpace: 'pre' }}>{line}</span>
          </div>
        );
      })}
    </div>
  );
}
