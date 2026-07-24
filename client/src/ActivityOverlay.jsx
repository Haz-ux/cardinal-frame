import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import { Activity, Zap, Clock, Cpu, Play, AlertCircle, CheckCircle, Sparkles } from 'lucide-react';

const NEON = { cyan:'#00f0ff', green:'#22c55e', yellow:'#eab308', red:'#ef4444', blue:'#3b82f6', purple:'#a855f7', orange:'#f97316', pink:'#ec4899', magenta:'#ff00ff' };

// Event type → color + icon mapping
const EVENT_META = {
  'task:status':      { color: NEON.blue,   icon: Play,        label: 'Task' },
  'task:created':    { color: NEON.blue,   icon: Play,        label: 'Task' },
  'task:assigned':   { color: NEON.cyan,   icon: Cpu,         label: 'Assign' },
  'task:deleted':    { color: NEON.red,    icon: AlertCircle, label: 'Delete' },
  'agent:created':   { color: NEON.green,  icon: Cpu,         label: 'Agent' },
  'agent:heartbeat': { color: NEON.green,  icon: Activity,    label: 'Heartbeat' },
  'agent:status':    { color: NEON.green,  icon: Cpu,         label: 'Agent' },
  'agent:step':      { color: NEON.purple, icon: Zap,         label: 'Step' },
  'agent:loop:start':{ color: NEON.purple, icon: Zap,         label: 'Loop Start' },
  'agent:loop:complete': { color: NEON.green,  icon: CheckCircle,label: 'Loop Done' },
  'agent:loop:error':{ color: NEON.red,    icon: AlertCircle, label: 'Loop Error' },
  'dag:status':      { color: NEON.orange, icon: Activity,    label: 'DAG' },
  'dag:layer':      { color: NEON.orange, icon: Activity,    label: 'DAG Layer' },
  'chain:executed':  { color: NEON.purple, icon: Zap,         label: 'Chain' },
  'memory:created':  { color: NEON.cyan,   icon: Sparkles,    label: 'Memory' },
  'cost:alert':      { color: NEON.red,    icon: AlertCircle, label: 'Cost Alert' },
  'comms:message':   { color: NEON.pink,   icon: Activity,    label: 'Comms' },
  'default':         { color: NEON.cyan,   icon: Activity,    label: 'Event' },
};

const MAX_FEED_ITEMS = 50;

export function useActivityFeed() {
  const { lastMsg, connected } = useWebSocket();
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // Load initial activity on mount
  useEffect(() => {
    fetch('/api/activity?limit=30')
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        if (Array.isArray(data) && data.length) {
          setEvents(data.slice(0, MAX_FEED_ITEMS));
        }
      })
      .catch(() => {});
  }, []);

  // Append new WS events
  useEffect(() => {
    if (!lastMsg || lastMsg.type === 'connected' || pausedRef.current) return;
    const event = {
      id: lastMsg.id || Math.random().toString(36),
      type: lastMsg.type,
      payload: lastMsg.payload || {},
      ts: lastMsg.ts || Date.now(),
    };
    setEvents(prev => [event, ...prev].slice(0, MAX_FEED_ITEMS));
  }, [lastMsg]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, connected, paused, setPaused, clear };
}

function formatTime(ts) {
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts + 'Z');
    return d.toLocaleTimeString([], { hour12: false });
  } catch { return '—'; }
}

function getEventMeta(type) {
  return EVENT_META[type] || EVENT_META.default;
}

// ─── Activity Feed Panel ────────────────────────────────────────────
export function ActivityFeed({ events, connected, paused, setPaused, clear, compact = false }) {
  return (
    <div className="rounded-xl overflow-hidden flex flex-col" style={{
      background: 'rgba(10,10,20,0.95)',
      border: `1px solid ${NEON.cyan}15`,
    }}>
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${NEON.cyan}10` }}>
        <div className="flex items-center gap-2">
          <Activity size={14} style={{ color: NEON.cyan }} />
          <span className="text-xs font-bold tracking-wider uppercase" style={{ color: NEON.cyan }}>Live Activity</span>
          <span className="w-1.5 h-1.5 rounded-full" style={{
            background: connected ? NEON.green : NEON.red,
            boxShadow: `0 0 6px ${connected ? NEON.green : NEON.red}`,
          }} />
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setPaused(!paused)} className="px-2 py-1 text-xs rounded transition-all"
            style={{ background: paused ? `${NEON.yellow}15` : 'transparent', border: `1px solid ${paused ? NEON.yellow + '30' : 'transparent'}`, color: paused ? NEON.yellow : '#666' }}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={clear} className="px-2 py-1 text-xs text-gray-600 hover:text-gray-400">Clear</button>
        </div>
      </div>

      <div className="overflow-auto" style={{ maxHeight: compact ? '200px' : '400px' }}>
        {events.length === 0 ? (
          <div className="text-center py-8 text-gray-700 text-xs">No activity yet. Events will appear here in real-time.</div>
        ) : events.map((event, i) => {
          const meta = getEventMeta(event.type);
          const Icon = meta.icon;
          const isFresh = i === 0 && !paused;
          return (
            <div key={event.id + '-' + i} className="flex items-start gap-2 px-3 py-2 transition-colors hover:bg-cyan-500/[0.02]"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.02)', animation: isFresh ? 'fadeIn 0.3s ease' : 'none' }}>
              <Icon size={12} className="shrink-0 mt-0.5" style={{ color: meta.color, filter: `drop-shadow(0 0 4px ${meta.color}80)` }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                  <code className="text-xs text-gray-600 font-mono truncate">{event.type}</code>
                </div>
                {event.payload && Object.keys(event.payload).length > 0 && (
                  <div className="text-xs text-gray-500 mt-0.5 truncate">
                    {event.payload.id ? `id: ${event.payload.id.slice(0, 8)}…` : ''}
                    {event.payload.status ? ` · ${event.payload.status}` : ''}
                    {event.payload.name ? ` · ${event.payload.name}` : ''}
                  </div>
                )}
              </div>
              <span className="text-xs text-gray-700 font-mono shrink-0">{formatTime(event.ts)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Activity Overlay for NeuralMap ─────────────────────────────────
// Returns pulse animation data for nodes that recently had activity.
// Used by NeuralMap to render pulse rings on active nodes.
export function useActivityPulses(graphNodes) {
  const { lastMsg } = useWebSocket();
  const [pulses, setPulses] = useState([]);

  useEffect(() => {
    if (!lastMsg || !graphNodes?.length) return;

    // Map event types to node IDs based on event payload
    let targetId = null;
    let color = NEON.cyan;

    if (lastMsg.type.startsWith('task:') && lastMsg.payload?.id) {
      // Find a node that matches the task (e.g., a node with this task ID or a 'tasks' cluster node)
      targetId = lastMsg.payload.id;
      color = lastMsg.type === 'task:status' && lastMsg.payload.status === 'failed' ? NEON.red : NEON.blue;
    } else if (lastMsg.type.startsWith('agent:') && lastMsg.payload?.id) {
      targetId = lastMsg.payload.id;
      color = lastMsg.type.includes('error') ? NEON.red : NEON.green;
    } else if (lastMsg.type.startsWith('dag:') && lastMsg.payload?.id) {
      targetId = lastMsg.payload.id;
      color = NEON.orange;
    } else if (lastMsg.type === 'memory:created') {
      // Pulse the memory cluster
      targetId = 'cluster:memory';
      color = NEON.cyan;
    } else if (lastMsg.type === 'cost:alert') {
      targetId = 'cluster:infra';
      color = NEON.red;
    } else if (lastMsg.type === 'chain:executed') {
      targetId = 'cluster:runtime';
      color = NEON.purple;
    }

    if (!targetId) return;

    // Find matching node(s) — exact match or cluster match
    const matchingNodes = graphNodes.filter(n =>
      n.id === targetId ||
      (targetId.startsWith('cluster:') && (n.cluster === targetId.split(':')[1] || n.id === targetId))
    );

    for (const node of matchingNodes) {
      const pulse = {
        id: `${node.id}-${Date.now()}`,
        nodeId: node.id,
        x: node.x,
        y: node.y,
        color,
        startTime: Date.now(),
        duration: 1500,
      };
      setPulses(prev => [...prev, pulse].slice(-20)); // max 20 concurrent pulses
    }
  }, [lastMsg, graphNodes]);

  // Cleanup expired pulses
  useEffect(() => {
    if (pulses.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setPulses(prev => prev.filter(p => now - p.startTime < p.duration));
    }, 500);
    return () => clearInterval(interval);
  }, [pulses.length]);

  return pulses;
}
