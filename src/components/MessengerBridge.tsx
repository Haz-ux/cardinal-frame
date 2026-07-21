import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  MessageSquare,
  Send,
  CheckCircle2,
  AlertTriangle,
  Bot,
  Hash,
  Settings,
  ToggleLeft,
  ToggleRight,
  ShieldCheck,
  RefreshCw,
  Trash2,
  Radio,
} from 'lucide-react';

interface Channel {
  id: string;
  platform: 'telegram' | 'discord';
  name: string;
  config: any;
  enabled: boolean;
  polling: boolean;
  last_poll_at: string | null;
}

interface CommsMessage {
  id: string;
  channel_id: string;
  platform: string;
  direction: 'inbound' | 'outbound';
  remote_id: string | null;
  remote_username: string | null;
  content: string;
  agent_session_id: string | null;
  status: string;
  created_at: string;
}

export default function MessengerBridge() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [messages, setMessages] = useState<CommsMessage[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // New channel form
  const [newPlatform, setNewPlatform] = useState<'telegram' | 'discord'>('telegram');
  const [newName, setNewName] = useState('');
  const [newBotToken, setNewBotToken] = useState('');
  const [newChatId, setNewChatId] = useState('');
  const [newWebhookUrl, setNewWebhookUrl] = useState('');
  const [newAutoReply, setNewAutoReply] = useState(true);
  const [newTriggerAgent, setNewTriggerAgent] = useState(false);

  // Outbound dispatch
  const [dispatchChannelId, setDispatchChannelId] = useState('');
  const [dispatchMessage, setDispatchMessage] = useState('');
  const [sending, setSending] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  // ── Fetch data ──
  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch('/api/comms/channels', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
      });
      if (res.ok) setChannels(await res.json());
    } catch {}
  }, []);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/comms/messages?limit=50', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
      });
      if (res.ok) setMessages(await res.json());
    } catch {}
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/comms/status', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token') || ''}` },
      });
      if (res.ok) setStatus(await res.json());
    } catch {}
  }, []);

  const refreshAll = useCallback(() => {
    fetchChannels();
    fetchMessages();
    fetchStatus();
  }, [fetchChannels, fetchMessages, fetchStatus]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // ── WebSocket for live updates ──
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'comms:message') {
          setMessages((prev) => [msg.payload, ...prev].slice(0, 100));
        } else if (msg.type === 'comms:channel') {
          fetchChannels();
        }
      } catch {}
    };

    return () => ws.close();
  }, [fetchChannels]);

  const getToken = () => localStorage.getItem('token') || '';
  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
  });

  // ── Create channel ──
  const handleCreate = async () => {
    setError(null);
    setSuccess(null);
    if (!newName) return setError('Name required');
    setLoading(true);
    try {
      const config: any = {};
      if (newPlatform === 'telegram') {
        if (!newBotToken) { setError('Bot token required'); setLoading(false); return; }
        config.bot_token = newBotToken;
        config.chat_id = newChatId;
        config.auto_reply = newAutoReply;
        config.trigger_agent = newTriggerAgent;
      } else {
        if (!newBotToken && !newWebhookUrl) { setError('Bot token or webhook URL required'); setLoading(false); return; }
        config.bot_token = newBotToken;
        config.webhook_url = newWebhookUrl;
        config.auto_reply = newAutoReply;
        config.trigger_agent = newTriggerAgent;
      }

      const res = await fetch('/api/comms/channels', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ platform: newPlatform, name: newName, config, enabled: false }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Create failed');
      }
      setSuccess(`Channel "${newName}" created`);
      setNewName('');
      setNewBotToken('');
      setNewChatId('');
      setNewWebhookUrl('');
      refreshAll();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Toggle channel enabled ──
  const toggleChannel = async (ch: Channel) => {
    try {
      const res = await fetch(`/api/comms/channels/${ch.id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ enabled: !ch.enabled }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      refreshAll();
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Delete channel ──
  const deleteChannel = async (id: string) => {
    if (!confirm('Delete this channel?')) return;
    try {
      const res = await fetch(`/api/comms/channels/${id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error('Delete failed');
      refreshAll();
    } catch (e: any) {
      setError(e.message);
    }
  };

  // ── Dispatch outbound message ──
  const handleDispatch = async () => {
    setError(null);
    setSuccess(null);
    if (!dispatchChannelId || !dispatchMessage) return;
    setSending(true);
    try {
      const res = await fetch('/api/comms/dispatch', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ channel_id: dispatchChannelId, message: dispatchMessage }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Dispatch failed');
      }
      setSuccess('Message sent');
      setDispatchMessage('');
      refreshAll();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  const platformColor = (p: string) =>
    p === 'telegram' ? 'text-cyan-400' : 'text-indigo-400';
  const dirColor = (d: string) =>
    d === 'inbound' ? 'text-emerald-400' : 'text-magenta-400';
  const statusColor = (s: string) =>
    s === 'sent' || s === 'received' ? 'text-emerald-400'
    : s === 'failed' ? 'text-red-400'
    : 'text-gray-400';

  return (
    <div className="space-y-3 text-xs">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-cyan-400" />
          <span className="text-white font-semibold uppercase tracking-widest">Messenger Bridge</span>
          {status && (
            <span className="text-gray-500">
              {status.telegram_pollers || 0}TG · {status.discord_pollers || 0}DC
            </span>
          )}
        </div>
        <button
          onClick={refreshAll}
          className="text-gray-400 hover:text-cyan-400 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="flex items-center gap-2 text-red-400 bg-red-950/30 border border-red-800/40 rounded px-3 py-1.5">
          <AlertTriangle className="w-3 h-3" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-red-600">×</button>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 text-emerald-400 bg-emerald-950/30 border border-emerald-800/40 rounded px-3 py-1.5">
          <CheckCircle2 className="w-3 h-3" />
          <span>{success}</span>
          <button onClick={() => setSuccess(null)} className="ml-auto text-emerald-600">×</button>
        </div>
      )}

      {/* Channel Grid */}
      <div className="grid grid-cols-2 gap-3">
        {/* ── LEFT: Channels ── */}
        <div className="space-y-2">
          <div className="text-gray-500 uppercase tracking-widest text-[9px]">Channels</div>

          {/* Existing channels */}
          {channels.length === 0 && (
            <div className="text-gray-600 text-[10px] italic">No channels configured</div>
          )}
          {channels.map((ch) => (
            <div
              key={ch.id}
              className="border border-gray-800/60 rounded bg-gray-950/60 p-2 space-y-1"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className={`font-bold ${platformColor(ch.platform)}`}>
                    {ch.platform === 'telegram' ? 'TG' : 'DC'}
                  </span>
                  <span className="text-white">{ch.name}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => toggleChannel(ch)} className="transition-colors">
                    {ch.enabled
                      ? <ToggleRight className="w-4 h-4 text-emerald-400" />
                      : <ToggleLeft className="w-4 h-4 text-gray-600" />}
                  </button>
                  <button onClick={() => deleteChannel(ch.id)} className="text-gray-600 hover:text-red-400">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[9px] text-gray-500">
                {ch.polling && <span className="text-cyan-400 animate-pulse">● polling</span>}
                {ch.last_poll_at && <span>last: {new Date(ch.last_poll_at).toLocaleTimeString()}</span>}
              </div>
            </div>
          ))}

          {/* Create new channel form */}
          <div className="border border-cyan-800/30 rounded bg-cyan-950/10 p-2 space-y-1.5">
            <div className="text-cyan-400 uppercase tracking-widest text-[9px]">+ New Channel</div>
            <div className="flex gap-1">
              {(['telegram', 'discord'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setNewPlatform(p)}
                  className={`px-2 py-0.5 rounded text-[10px] ${
                    newPlatform === p
                      ? p === 'telegram' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-600/40'
                      : 'bg-indigo-500/20 text-indigo-300 border border-indigo-600/40'
                    : 'text-gray-600 border border-transparent'
                  }`}
                >
                  {p === 'telegram' ? 'Telegram' : 'Discord'}
                </button>
              ))}
            </div>
            <input
              type="text"
              placeholder="Channel name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full bg-gray-900/60 border border-gray-800 rounded px-2 py-1 text-white text-[10px] focus:border-cyan-600/50 outline-none"
            />
            <input
              type="password"
              placeholder={`${newPlatform} bot token`}
              value={newBotToken}
              onChange={(e) => setNewBotToken(e.target.value)}
              className="w-full bg-gray-900/60 border border-gray-800 rounded px-2 py-1 text-white text-[10px] focus:border-cyan-600/50 outline-none"
            />
            {newPlatform === 'telegram' ? (
              <input
                type="text"
                placeholder="Chat ID (default target)"
                value={newChatId}
                onChange={(e) => setNewChatId(e.target.value)}
                className="w-full bg-gray-900/60 border border-gray-800 rounded px-2 py-1 text-white text-[10px] focus:border-cyan-600/50 outline-none"
              />
            ) : (
              <input
                type="text"
                placeholder="Discord webhook URL"
                value={newWebhookUrl}
                onChange={(e) => setNewWebhookUrl(e.target.value)}
                className="w-full bg-gray-900/60 border border-gray-800 rounded px-2 py-1 text-white text-[10px] focus:border-cyan-600/50 outline-none"
              />
            )}
            <label className="flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer">
              <input type="checkbox" checked={newAutoReply} onChange={(e) => setNewAutoReply(e.target.checked)} className="accent-cyan-500" />
              Auto-reply
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer">
              <input type="checkbox" checked={newTriggerAgent} onChange={(e) => setNewTriggerAgent(e.target.checked)} className="accent-cyan-500" />
              Trigger agent on message
            </label>
            <button
              onClick={handleCreate}
              disabled={loading}
              className="w-full bg-cyan-600/20 hover:bg-cyan-600/30 text-cyan-300 border border-cyan-700/40 rounded px-2 py-1 text-[10px] transition-colors disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Channel'}
            </button>
          </div>
        </div>

        {/* ── RIGHT: Messages + Dispatch ── */}
        <div className="space-y-2">
          <div className="text-gray-500 uppercase tracking-widest text-[9px]">Message Feed</div>

          {/* Outbound dispatch */}
          <div className="border border-gray-800/60 rounded bg-gray-950/60 p-2 space-y-1.5">
            <select
              value={dispatchChannelId}
              onChange={(e) => setDispatchChannelId(e.target.value)}
              className="w-full bg-gray-900/60 border border-gray-800 rounded px-2 py-1 text-white text-[10px] focus:border-cyan-600/50 outline-none"
            >
              <option value="">Select channel...</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.platform === 'telegram' ? 'TG' : 'DC'} · {ch.name}
                </option>
              ))}
            </select>
            <div className="flex gap-1">
              <input
                type="text"
                placeholder="Message to send..."
                value={dispatchMessage}
                onChange={(e) => setDispatchMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !sending) handleDispatch(); }}
                className="flex-1 bg-gray-900/60 border border-gray-800 rounded px-2 py-1 text-white text-[10px] focus:border-cyan-600/50 outline-none"
              />
              <button
                onClick={handleDispatch}
                disabled={sending || !dispatchChannelId || !dispatchMessage}
                className="text-cyan-400 hover:text-cyan-300 disabled:opacity-30 transition-colors px-1"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Live message feed */}
          <div className="border border-gray-800/60 rounded bg-gray-950/60 max-h-64 overflow-y-auto">
            {messages.length === 0 ? (
              <div className="text-gray-600 text-[10px] italic text-center py-4">No messages yet</div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`border-b border-gray-900/40 px-2 py-1.5 ${
                    msg.direction === 'inbound' ? 'bg-emerald-950/10' : 'bg-magenta-950/10'
                  }`}
                >
                  <div className="flex items-center justify-between text-[9px]">
                    <div className="flex items-center gap-1.5">
                      <span className={`font-bold ${platformColor(msg.platform)}`}>
                        {msg.platform === 'telegram' ? 'TG' : 'DC'}
                      </span>
                      <span className={dirColor(msg.direction)}>
                        {msg.direction === 'inbound' ? '←' : '→'}
                      </span>
                      <span className="text-gray-400">{msg.remote_username || 'unknown'}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {msg.agent_session_id && (
                        <span className="text-purple-400 flex items-center gap-0.5">
                          <Bot className="w-2 h-2" />
                        </span>
                      )}
                      <span className={statusColor(msg.status)}>{msg.status}</span>
                      <span className="text-gray-600">{new Date(msg.created_at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                  <div className="text-gray-300 text-[10px] mt-0.5 truncate">
                    {msg.content}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
