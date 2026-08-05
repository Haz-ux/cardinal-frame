import React, { useState, useEffect, useCallback, memo, useRef, useMemo } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { useWebSocket } from './useWebSocket';
import { useToast } from './ToastContext';
import { NEON, BG, GLOW, STATUS, PROVIDER_COLORS } from './theme';
import {
  Server, HardDrive, Cpu, MemoryStick, Zap, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, AlertTriangle, Loader2, Minimize2, Maximize2,
  Shrink, ArrowRightLeft, Gauge, Sparkles, Wifi, WifiOff
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════════════
// 1. HARDWARE MONITOR OVERLAY
// Compact horizontal bar: server status, backup, RAM%, GPU/NPU TOPS,
// context tokens, inference tok/s — WebSocket live telemetry
// ═══════════════════════════════════════════════════════════════════
export const HardwareMonitor = memo(function HardwareMonitor({ contextUsage = { used: 0, total: 32000 }, streaming = false }) {
  const { lastMsg, connected } = useWebSocket();
  const toast = useToast();
  const [telemetry, setTelemetry] = useState({
    homeServer: { status: 'unknown', latency: 0 },
    localBackup: { status: 'unknown' },
    ram: { used: 0, total: 0 },
    gpu: { tops: 0, name: '' },
    tokensPerSec: 0,
  });
  const [deviceState, setDeviceState] = useState(null);
  const fetchCount = useRef(0);

  // Initial fetch from API endpoints
  useEffect(() => {
    let mounted = true;

    api('/api/telemetry').then(data => {
      if (!mounted) return;
      setTelemetry(prev => ({
        ...prev,
        homeServer: data?.home_server ? { status: data.home_server.status || 'unknown', latency: data.home_server.latency || 0 } : prev.homeServer,
        localBackup: data?.local_backup ? { status: data.local_backup.status || 'unknown' } : prev.localBackup,
        ram: data?.ram ? { used: data.ram.used || 0, total: data.ram.total || 0 } : prev.ram,
        gpu: data?.gpu ? { tops: data.gpu.tops || 0, name: data.gpu.name || '' } : prev.gpu,
        tokensPerSec: data?.tokens_per_sec || 0,
      }));
    }).catch(() => {});

    api('/api/device-state').then(data => {
      if (!mounted) return;
      setDeviceState(data);
    }).catch(() => {});

    return () => { mounted = false; };
  }, []);

  // WebSocket listener for real-time telemetry
  useEffect(() => {
    if (!lastMsg) return;
    if (lastMsg.type === 'telemetry') {
      setTelemetry(prev => ({
        ...prev,
        homeServer: lastMsg.home_server ? { status: lastMsg.home_server.status, latency: lastMsg.home_server.latency } : prev.homeServer,
        localBackup: lastMsg.local_backup ? { status: lastMsg.local_backup.status } : prev.localBackup,
        ram: lastMsg.ram ? { used: lastMsg.ram.used, total: lastMsg.ram.total } : prev.ram,
        gpu: lastMsg.gpu ? { tops: lastMsg.gpu.tops, name: lastMsg.gpu.name } : prev.gpu,
        tokensPerSec: lastMsg.tokens_per_sec ?? prev.tokensPerSec,
      }));
    }
    if (lastMsg.type === 'device-state') {
      setDeviceState(lastMsg.payload);
    }
  }, [lastMsg]);

  // Derive colors from status
  const statusDot = useCallback((status) => {
    const color = status === 'online' || status === 'ready' || status === 'active' ? NEON.green
      : status === 'degraded' || status === 'partial' ? NEON.yellow
      : status === 'offline' || status === 'unavailable' || status === 'error' ? NEON.red
      : '#444';
    const glow = status === 'online' || status === 'ready' || status === 'active'
      ? `0 0 6px ${NEON.green}80` : 'none';
    return (
      <span style={{
        display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
        background: color, boxShadow: glow, flexShrink: 0,
      }} />
    );
  }, []);

  const ramPct = telemetry.ram.total > 0
    ? Math.round((telemetry.ram.used / telemetry.ram.total) * 100) : 0;
  const ramColor = ramPct > 90 ? NEON.red : ramPct > 75 ? NEON.orange : ramPct > 50 ? NEON.yellow : NEON.cyan;

  const ctxPct = contextUsage.total > 0
    ? Math.round((contextUsage.used / contextUsage.total) * 100) : 0;

  const serverLabel = telemetry.homeServer.status === 'online' ? 'ONLINE'
    : telemetry.homeServer.status === 'degraded' ? 'DEGRADED'
    : telemetry.homeServer.status === 'offline' ? 'OFFLINE' : '—';

  const backupLabel = telemetry.localBackup.status === 'ready' ? 'READY'
    : telemetry.localBackup.status === 'unavailable' ? 'UNAVAIL'
    : telemetry.localBackup.status === 'error' ? 'ERROR' : '—';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      flexWrap: 'wrap',
      background: `${BG.card}`, borderBottom: `1px solid ${NEON.cyan}10`,
      padding: '4px 14px', fontSize: 10, color: '#888',
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      flexShrink: 0, overflow: 'hidden',
    }}>
      {/* WS connection indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingRight: 10, borderRight: `1px solid ${NEON.cyan}10`, marginRight: 10 }}>
        {connected
          ? <Wifi size={10} style={{ color: NEON.green }} />
          : <WifiOff size={10} style={{ color: NEON.red }} />}
        <span style={{ color: connected ? NEON.green : NEON.red, fontSize: 9, fontWeight: 700 }}>
          {connected ? 'WS' : '—'}
        </span>
      </div>

      {/* Home Server */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: 10, borderRight: `1px solid ${NEON.cyan}10`, marginRight: 10 }}>
        <Server size={10} style={{ color: NEON.magenta }} />
        {statusDot(telemetry.homeServer.status)}
        <span style={{ color: '#ccc', fontWeight: 600, letterSpacing: 0.5 }}>
          HOME
        </span>
        <span style={{ color: telemetry.homeServer.status === 'online' ? NEON.green : telemetry.homeServer.status === 'degraded' ? NEON.yellow : NEON.red }}>
          {serverLabel}
        </span>
        {telemetry.homeServer.latency > 0 && (
          <span style={{ color: '#666' }}>
            {telemetry.homeServer.latency}ms
          </span>
        )}
      </div>

      {/* Local Backup */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: 10, borderRight: `1px solid ${NEON.cyan}10`, marginRight: 10 }}>
        <HardDrive size={10} style={{ color: NEON.purple }} />
        {statusDot(telemetry.localBackup.status)}
        <span style={{ color: '#ccc', fontWeight: 600, letterSpacing: 0.5 }}>
          BACKUP
        </span>
        <span style={{ color: telemetry.localBackup.status === 'ready' ? NEON.green : NEON.yellow }}>
          {backupLabel}
        </span>
      </div>

      {/* RAM */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: 10, borderRight: `1px solid ${NEON.cyan}10`, marginRight: 10 }}>
        <MemoryStick size={10} style={{ color: ramColor }} />
        <span style={{ color: '#ccc', fontWeight: 600, letterSpacing: 0.5 }}>RAM</span>
        <div style={{ width: 40, height: 5, background: '#ffffff08', borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
          <div style={{
            width: `${ramPct}%`, height: '100%', background: ramColor,
            boxShadow: `0 0 4px ${ramColor}60`, borderRadius: 3,
            transition: 'width 0.5s ease',
          }} />
        </div>
        <span style={{ color: ramColor, fontWeight: 600 }}>{ramPct}%</span>
      </div>

      {/* GPU / NPU TOPS */}
      {telemetry.gpu.tops > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: 10, borderRight: `1px solid ${NEON.cyan}10`, marginRight: 10 }}>
          <Cpu size={10} style={{ color: NEON.teal }} />
          <span style={{ color: '#ccc', fontWeight: 600, letterSpacing: 0.5 }}>
            {telemetry.gpu.name || 'GPU'}
          </span>
          <span style={{ color: NEON.teal, fontWeight: 700 }}>{telemetry.gpu.tops} TOPS</span>
        </div>
      )}

      {/* Context tokens */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: 10, borderRight: `1px solid ${NEON.cyan}10`, marginRight: 10 }}>
        <Sparkles size={10} style={{ color: NEON.cyan }} />
        <span style={{ color: '#ccc', fontWeight: 600, letterSpacing: 0.5 }}>CTX</span>
        <span style={{ color: NEON.cyan }}>
          {contextUsage.used.toLocaleString()}<span style={{ color: '#555' }}>/</span>{contextUsage.total.toLocaleString()}
        </span>
      </div>

      {/* Inference tok/s — visible when streaming */}
      {streaming && telemetry.tokensPerSec > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Zap size={10} style={{ color: NEON.yellow }} />
          <span style={{ color: NEON.yellow, fontWeight: 700 }}>
            {telemetry.tokensPerSec} tok/s
          </span>
        </div>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Device state summary */}
      {deviceState && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#555', fontSize: 9 }}>
          <Gauge size={9} />
          <span>{deviceState.device_count || 0} devices</span>
        </div>
      )}
    </div>
  );
});


// ═══════════════════════════════════════════════════════════════════
// 2. DYNAMIC ENDPOINT SWITCHER
// Dropdown at bottom of chat input — model picker with cost tier,
// context window, speed tier, status dots, grouped by provider
// ═══════════════════════════════════════════════════════════════════
export const EndpointSwitcher = memo(function EndpointSwitcher({
  models = [],
  selectedModel,
  setSelectedModel,
  onFailover,
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [failoverModel, setFailoverModel] = useState(null);
  const containerRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Detect failover from response headers
  useEffect(() => {
    if (!onFailover) return;
    // onFailover is called by parent when X-Failover header detected
    setFailoverModel(onFailover);
    toast.warning(`Failover → ${onFailover}`, 5000);
  }, [onFailover, toast]);

  // Group models by provider
  const grouped = useMemo(() => {
    const groups = {};
    for (const m of models) {
      const provider = m.provider || m.type || 'other';
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(m);
    }
    return groups;
  }, [models]);

  const costLabel = (cost) => {
    const c = (cost || '').toLowerCase();
    if (c === 'free' || c === 0) return { label: 'Free', color: NEON.green };
    if (c === 'low') return { label: 'Low', color: NEON.green };
    if (c === 'medium' || c === 'med') return { label: 'Med', color: NEON.yellow };
    if (c === 'high') return { label: 'High', color: NEON.red };
    return { label: '—', color: '#555' };
  };

  const statusColor = (status) => {
    const s = (status || '').toLowerCase();
    if (s === 'available' || s === 'online' || s === 'active') return NEON.green;
    if (s === 'degraded' || s === 'partial' || s === 'slow') return NEON.yellow;
    if (s === 'offline' || s === 'error' || s === 'disabled') return NEON.red;
    return '#444';
  };

  const speedTier = (speed) => {
    const s = (speed || '').toLowerCase();
    if (s === 'fast' || s === 'turbo') return { label: '⚡', color: NEON.yellow };
    if (s === 'medium' || s === 'standard') return { label: '→', color: NEON.cyan };
    if (s === 'slow' || s === 'economy') return { label: '🐢', color: '#888' };
    return { label: '', color: '#555' };
  };

  const currentModel = models.find(m => m.model_id === selectedModel);

  const handleSelect = useCallback((modelId) => {
    setSelectedModel(modelId);
    setOpen(false);
    const m = models.find(x => x.model_id === modelId);
    toast.info(`Switched to ${m?.display_name || modelId}`, 3000);
  }, [models, setSelectedModel, toast]);

  const formatCtx = (ctx) => {
    if (!ctx) return '—';
    if (ctx >= 1000000) return `${(ctx / 1000000).toFixed(1)}M`;
    if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
    return String(ctx);
  };

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      {/* Current model summary — always visible */}
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: `${BG.surface}`, border: `1px solid ${NEON.cyan}15`,
          borderRadius: 8, padding: '6px 10px', width: '100%',
          cursor: 'pointer', color: '#aaa', fontSize: 11,
          fontFamily: 'inherit',
        }}
      >
        <Cpu size={11} style={{ color: NEON.cyan }} />
        {currentModel ? (
          <>
            <span style={{ color: '#ccc', fontWeight: 600, flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentModel.display_name || currentModel.model_id}
            </span>
            {currentModel.context_window && (
              <span style={{ color: NEON.cyan, fontSize: 10, fontWeight: 600, fontFamily: 'monospace' }}>
                {formatCtx(currentModel.context_window)}
              </span>
            )}
            {(() => {
              const c = costLabel(currentModel.cost_tier || currentModel.cost);
              return <span style={{ color: c.color, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>{c.label}</span>;
            })()}
          </>
        ) : (
          <span style={{ flex: 1, textAlign: 'left', color: '#555' }}>Select model…</span>
        )}
        {open ? <ChevronUp size={12} style={{ color: '#555' }} /> : <ChevronDown size={12} style={{ color: '#555' }} />}
      </button>

      {/* Failover indicator */}
      {failoverModel && (
        <div style={{
          marginTop: 4, padding: '4px 8px', borderRadius: 6,
          background: `${NEON.orange}10`, border: `1px solid ${NEON.orange}30`,
          fontSize: 10, color: NEON.orange, display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <AlertTriangle size={10} />
          Failover: {failoverModel}
        </div>
      )}

      {/* Dropdown list */}
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, right: 0,
          maxHeight: 280, overflow: 'auto',
          background: BG.card, border: `1px solid ${NEON.cyan}30`,
          borderRadius: 8, zIndex: 60,
          boxShadow: `0 -8px 24px rgba(0,0,0,0.6)`,
        }}>
          {Object.entries(grouped).map(([provider, providerModels]) => {
            const provColor = PROVIDER_COLORS[provider] || NEON.cyan;
            return (
              <div key={provider}>
                {/* Provider header */}
                <div style={{
                  padding: '6px 10px', fontSize: 9, fontWeight: 700,
                  color: provColor, letterSpacing: 1.2, textTransform: 'uppercase',
                  background: `${provColor}08`, borderBottom: `1px solid ${provColor}15`,
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: 2, background: provColor,
                    boxShadow: `0 0 4px ${provColor}60`,
                  }} />
                  {provider}
                  <span style={{ color: '#555', fontWeight: 400, marginLeft: 4 }}>{providerModels.length}</span>
                </div>
                {/* Models */}
                {providerModels.map(m => {
                  const isSelected = m.model_id === selectedModel;
                  const sColor = statusColor(m.status);
                  const cost = costLabel(m.cost_tier || m.cost);
                  const speed = speedTier(m.speed_tier || m.speed);
                  return (
                    <div
                      key={m.id || m.model_id}
                      onClick={() => handleSelect(m.model_id)}
                      style={{
                        padding: '5px 10px 5px 20px', cursor: 'pointer', fontSize: 11,
                        display: 'flex', alignItems: 'center', gap: 6,
                        background: isSelected ? `${provColor}12` : 'transparent',
                        borderLeft: isSelected ? `2px solid ${provColor}` : '2px solid transparent',
                        color: isSelected ? '#fff' : '#bbb',
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = `${provColor}08`; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* Status dot */}
                      <span style={{
                        width: 5, height: 5, borderRadius: '50%', background: sColor,
                        boxShadow: `0 0 3px ${sColor}80`, flexShrink: 0,
                      }} />
                      {/* Model name */}
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.display_name || m.model_id}
                      </span>
                      {/* Context window */}
                      {m.context_window && (
                        <span style={{ color: NEON.cyan, fontSize: 9, fontFamily: 'monospace', fontWeight: 600, flexShrink: 0 }}>
                          {formatCtx(m.context_window)}
                        </span>
                      )}
                      {/* Speed */}
                      {speed.label && (
                        <span style={{ fontSize: 9, flexShrink: 0 }}>{speed.label}</span>
                      )}
                      {/* Cost tier */}
                      <span style={{ color: cost.color, fontSize: 9, fontWeight: 700, flexShrink: 0, letterSpacing: 0.3 }}>
                        {cost.label}
                      </span>
                      {/* Selected indicator */}
                      {isSelected && (
                        <CheckCircle2 size={10} style={{ color: provColor, flexShrink: 0 }} />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {models.length === 0 && (
            <div style={{ padding: 16, color: '#555', fontSize: 11, textAlign: 'center' }}>
              No models available. Add an LLM provider.
            </div>
          )}
        </div>
      )}
    </div>
  );
});


// ═══════════════════════════════════════════════════════════════════
// 3. CONTEXT WINDOW TRIM VISUALIZER
// Horizontal progress bar below chat header — color-coded context
// usage, expandable detail panel, compress button
// ═══════════════════════════════════════════════════════════════════
export const ContextTrimVisualizer = memo(function ContextTrimVisualizer({
  contextUsage = { used: 0, total: 32000 },
  onContextUpdate,
}) {
  const toast = useToast();
  const [detailOpen, setDetailOpen] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [compressResult, setCompressResult] = useState(null);

  const pct = contextUsage.total > 0
    ? (contextUsage.used / contextUsage.total) * 100 : 0;
  const pctDisplay = Math.round(pct);

  // Only auto-appear when context > 60%
  if (pct < 60) return null;

  // Color shifts: cyan (0-50%), yellow (50-75%), orange (75-90%), red (90-100%)
  const barColor = pct >= 90 ? NEON.red
    : pct >= 75 ? NEON.orange
    : pct >= 50 ? NEON.yellow
    : NEON.cyan;

  const barGlow = pct >= 90 ? GLOW.red
    : pct >= 75 ? GLOW.orange
    : pct >= 50 ? `0 0 6px ${NEON.yellow}60`
    : GLOW.cyan;

  // Breakdown (from contextUsage or default)
  const breakdown = contextUsage.breakdown || {
    systemPrompt: Math.round(contextUsage.used * 0.12),
    memoryLogs: Math.round(contextUsage.used * 0.08),
    messageHistory: Math.round(contextUsage.used * 0.65),
    toolResults: Math.round(contextUsage.used * 0.15),
  };

  const handleCompress = useCallback(async () => {
    setCompressing(true);
    setCompressResult(null);
    try {
      const resp = await api('/api/chat/compress-context', { method: 'POST' });
      const savedPct = resp.saved_percent ?? resp.saved_pct ?? 0;
      setCompressResult(savedPct);
      toast.success(`Context compressed — saved ${savedPct}%`, 4000);
      if (onContextUpdate && resp.new_usage) {
        onContextUpdate(resp.new_usage);
      }
    } catch (e) {
      toast.error('Compression failed: ' + (e.message || 'unknown error'));
    } finally {
      setCompressing(false);
    }
  }, [toast, onContextUpdate]);

  const formatTokens = (n) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  const breakdownItems = [
    { label: 'System Prompt', tokens: breakdown.systemPrompt, color: NEON.magenta },
    { label: 'Memory Logs', tokens: breakdown.memoryLogs, color: NEON.purple },
    { label: 'Message History', tokens: breakdown.messageHistory, color: NEON.cyan },
    { label: 'Tool Results', tokens: breakdown.toolResults, color: NEON.yellow },
  ];

  return (
    <div style={{ flexShrink: 0 }}>
      {/* Main progress bar row */}
      <div
        onClick={() => setDetailOpen(!detailOpen)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 14px', cursor: 'pointer',
          background: `${barColor}06`,
          borderBottom: detailOpen ? `1px solid ${barColor}20` : 'none',
          transition: 'background 0.3s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = `${barColor}0c`; }}
        onMouseLeave={e => { e.currentTarget.style.background = `${barColor}06`; }}
      >
        {/* Label */}
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
          color: barColor, fontFamily: 'monospace', flexShrink: 0,
        }}>
          CTX
        </span>

        {/* Progress bar */}
        <div style={{
          flex: 1, height: 6, background: '#ffffff08', borderRadius: 3,
          overflow: 'hidden', position: 'relative',
        }}>
          <div style={{
            width: `${Math.min(pct, 100)}%`, height: '100%',
            background: barColor, borderRadius: 3,
            boxShadow: barGlow,
            transition: 'width 0.5s ease, background 0.5s ease',
          }} />
          {/* Segment markers at 50%, 75%, 90% */}
          <span style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#ffffff08' }} />
          <span style={{ position: 'absolute', left: '75%', top: 0, bottom: 0, width: 1, background: '#ffffff0a' }} />
          <span style={{ position: 'absolute', left: '90%', top: 0, bottom: 0, width: 1, background: '#ffffff0c' }} />
        </div>

        {/* Token count */}
        <span style={{
          fontSize: 10, fontFamily: 'monospace', fontWeight: 600, flexShrink: 0,
          color: barColor, whiteSpace: 'nowrap',
        }}>
          {formatTokens(contextUsage.used)} <span style={{ color: '#555' }}>/</span> {formatTokens(contextUsage.total)}
        </span>

        {/* Percentage */}
        <span style={{
          fontSize: 9, fontWeight: 700, fontFamily: 'monospace',
          color: barColor, minWidth: 32, textAlign: 'right', flexShrink: 0,
          textShadow: `0 0 6px ${barColor}40`,
        }}>
          {pctDisplay}%
        </span>

        {/* Chevron */}
        {detailOpen
          ? <ChevronUp size={10} style={{ color: '#555', flexShrink: 0 }} />
          : <ChevronDown size={10} style={{ color: '#555', flexShrink: 0 }} />}
      </div>

      {/* Detail panel */}
      {detailOpen && (
        <div style={{
          padding: '8px 14px 10px',
          background: `${BG.card}`,
          borderBottom: `1px solid ${barColor}15`,
        }}>
          {/* Breakdown bars */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
            {breakdownItems.map(item => {
              const itemPct = contextUsage.total > 0
                ? Math.round((item.tokens / contextUsage.total) * 100) : 0;
              return (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 100, fontSize: 10, color: '#888', fontWeight: 600,
                    letterSpacing: 0.3, flexShrink: 0,
                  }}>
                    {item.label}
                  </span>
                  <div style={{
                    flex: 1, height: 4, background: '#ffffff06', borderRadius: 2, overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${Math.min(itemPct, 100)}%`, height: '100%',
                      background: item.color, borderRadius: 2,
                      boxShadow: `0 0 4px ${item.color}40`,
                      transition: 'width 0.5s ease',
                    }} />
                  </div>
                  <span style={{
                    fontSize: 10, fontFamily: 'monospace', fontWeight: 600,
                    color: item.color, minWidth: 50, textAlign: 'right', flexShrink: 0,
                  }}>
                    {formatTokens(item.tokens)} <span style={{ color: '#444' }}>({itemPct}%)</span>
                  </span>
                </div>
              );
            })}
          </div>

          {/* Actions row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={e => { e.stopPropagation(); handleCompress(); }}
              disabled={compressing}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: `${NEON.cyan}10`, border: `1px solid ${NEON.cyan}30`,
                borderRadius: 6, padding: '5px 10px', cursor: 'pointer',
                color: NEON.cyan, fontSize: 10, fontWeight: 700,
                letterSpacing: 0.5, fontFamily: 'inherit',
                opacity: compressing ? 0.5 : 1,
              }}
            >
              {compressing
                ? <Loader2 size={10} className="animate-spin" />
                : <Shrink size={10} />}
              {compressing ? 'Compressing…' : 'Compress Context'}
            </button>

            {/* Compression result */}
            {compressResult !== null && (
              <span style={{
                fontSize: 10, color: NEON.green, fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                <CheckCircle2 size={10} />
                Saved {compressResult}%
              </span>
            )}

            <div style={{ flex: 1 }} />

            <span style={{ fontSize: 9, color: '#444', fontFamily: 'monospace' }}>
              {contextUsage.total.toLocaleString()} token limit
            </span>
          </div>
        </div>
      )}
    </div>
  );
});
