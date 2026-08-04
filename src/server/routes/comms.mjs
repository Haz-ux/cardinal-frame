import express from 'express';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';

/**
 * Comms Engine: Telegram + Discord integration.
 * Dependencies (via ctx): db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast
 */

export default function commsRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast, callAgentLLM, fireHook, runAgentLoop } = ctx;
  const router = express.Router();


// In-memory state
const telegramPollers = new Map(); // channelId -> { offset, timer, stopFlag }
const discordPollers = new Map();

// ── Helpers ──

async function telegramApiCall(token, method, params = {}) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Telegram API error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  if (!data.ok) throw new Error(`Telegram API returned !ok: ${JSON.stringify(data)}`);
  return data.result;
}

async function discordWebhookSend(webhookUrl, content, opts = {}) {
  const body = { content, username: opts.username || 'Cardinal Frame', ...opts.embeds ? { embeds: opts.embeds } : {} };
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord webhook error ${resp.status}: ${text}`);
  }
  return { sent: true };
}

// ── Store + broadcast a comms message ──

function storeCommsMessage(channelId, platform, direction, { remote_id, remote_username, content, raw, agentSessionId, status }) {
  const id = randomUUID();
  stmts.commsMessages.insert.run(
    id, channelId, platform, direction,
    remote_id || null, remote_username || null, content,
    raw || null, agentSessionId || null, status || 'sent'
  );
  const msg = stmts.commsMessages.getById.get(id);
  broadcast('comms:message', msg);
  fireHook('onCommsMessage', { channelId, platform, direction, message: msg });
  return msg;
}

// ── Send agent result back to the comms channel ──

async function sendCommsReply(channel, originalMsg, agentResult) {
  const config = JSON.parse(channel.config);
  const replyText = `🤖 ${agentResult.slice(0, 3000)}`;

  if (channel.platform === 'telegram') {
    if (!config.bot_token) return;
    const targetChatId = originalMsg.remote_id || config.chat_id;
    if (!targetChatId) return;
    try {
      await telegramApiCall(config.bot_token, 'sendMessage', {
        chat_id: targetChatId,
        text: replyText,
        parse_mode: 'Markdown',
      });
      storeCommsMessage(channel.id, 'telegram', 'outbound', {
        remote_id: String(targetChatId),
        remote_username: originalMsg.remote_username,
        content: replyText,
        status: 'sent',
      });
      logger.info(`Comms reply sent to Telegram (agent result for ${originalMsg.remote_username})`);
    } catch (e) {
      logger.error(`Comms reply to Telegram failed: ${e.message}`);
      storeCommsMessage(channel.id, 'telegram', 'outbound', {
        remote_id: String(targetChatId),
        remote_username: originalMsg.remote_username,
        content: replyText,
        status: 'failed',
      });
    }
  } else if (channel.platform === 'discord') {
    // Try webhook first, fall back to bot REST
    if (config.webhook_url) {
      try {
        await discordWebhookSend(config.webhook_url, replyText, { username: config.bot_name || 'Cardinal Frame Agent' });
        storeCommsMessage(channel.id, 'discord', 'outbound', {
          remote_id: originalMsg.remote_id,
          remote_username: originalMsg.remote_username,
          content: replyText,
          status: 'sent',
        });
        logger.info(`Comms reply sent to Discord via webhook (agent result for ${originalMsg.remote_username})`);
        return;
      } catch (e) { logger.error(`Discord webhook reply failed: ${e.message}`); }
    }
    if (config.bot_token && config.channel_id) {
      try {
        await fetch(`https://discord.com/api/v10/channels/${config.channel_id}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bot ${config.bot_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: replyText }),
        });
        storeCommsMessage(channel.id, 'discord', 'outbound', {
          remote_id: originalMsg.remote_id,
          remote_username: originalMsg.remote_username,
          content: replyText,
          status: 'sent',
        });
        logger.info(`Comms reply sent to Discord via bot (agent result for ${originalMsg.remote_username})`);
      } catch (e) {
        logger.error(`Comms reply to Discord bot failed: ${e.message}`);
        storeCommsMessage(channel.id, 'discord', 'outbound', {
          remote_id: originalMsg.remote_id,
          remote_username: originalMsg.remote_username,
          content: replyText,
          status: 'failed',
        });
      }
    }
  }
}

// ── Telegram long-polling ──

async function pollTelegram(channel) {
  const config = JSON.parse(channel.config);
  if (!config.bot_token) return;
  
  const state = telegramPollers.get(channel.id) || { offset: 0, stopFlag: false };
  
  try {
    stmts.commsChannels.updatePolling.run(1, new Date().toISOString(), channel.id);
    const updates = await telegramApiCall(config.bot_token, 'getUpdates', {
      offset: state.offset,
      timeout: 2,
      limit: 20,
    });
    
    for (const update of updates) {
      if (update.update_id >= state.offset) state.offset = update.update_id + 1;
      
      const msg = update.message || update.channel_post;
      if (!msg || !msg.text) continue;
      
      // Store inbound message
      const commsMsg = storeCommsMessage(channel.id, 'telegram', 'inbound', {
        remote_id: String(msg.from?.id || msg.chat?.id || ''),
        remote_username: msg.from?.username || msg.from?.first_name || '',
        content: msg.text,
        raw: JSON.stringify(update),
        status: 'received',
      });
      
      logger.info(`Telegram inbound from ${commsMsg.remote_username}: ${msg.text.slice(0, 60)}`);
      
      // Auto-respond if configured
      if (config.auto_reply) {
        try {
          const reply = await generateAutoReply(msg.text, channel);
          await telegramApiCall(config.bot_token, 'sendMessage', {
            chat_id: msg.chat?.id || msg.from?.id,
            text: reply,
            parse_mode: 'Markdown',
          });
          storeCommsMessage(channel.id, 'telegram', 'outbound', {
            remote_id: String(msg.chat?.id || msg.from?.id || ''),
            remote_username: commsMsg.remote_username,
            content: reply,
            status: 'sent',
          });
        } catch (e) {
          logger.error(`Telegram auto-reply failed: ${e.message}`);
          storeCommsMessage(channel.id, 'telegram', 'outbound', {
            remote_id: String(msg.chat?.id || msg.from?.id || ''),
            remote_username: commsMsg.remote_username,
            content: `[ERROR] ${e.message}`,
            status: 'failed',
          });
        }
      }
      
      // Trigger agent if configured
      if (config.trigger_agent && msg.text) {
        try {
          const agentSessionId = await triggerAgentFromComms(channel, commsMsg);
          if (agentSessionId) {
            stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
          }
        } catch (e) {
          logger.error(`Agent trigger from Telegram failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    logger.error(`Telegram poll error (${channel.name}): ${e.message}`);
  } finally {
    if (!state.stopFlag) {
      telegramPollers.set(channel.id, state);
      state.timer = setTimeout(() => pollTelegram(channel), 3000);
    } else {
      stmts.commsChannels.updatePolling.run(0, null, channel.id);
      telegramPollers.delete(channel.id);
    }
  }
}

// ── Discord (webhook for outbound, bot polling for inbound) ──

async function pollDiscord(channel) {
  const config = JSON.parse(channel.config);
  if (!config.bot_token) return;
  
  const state = discordPollers.get(channel.id) || { lastMsgId: null, stopFlag: false };
  
  try {
    stmts.commsChannels.updatePolling.run(1, new Date().toISOString(), channel.id);
    
    // Use Discord REST API to fetch recent messages from configured channel
    const guildId = config.guild_id;
    const channelId = config.channel_id;
    const headers = { 'Authorization': `Bot ${config.bot_token}` };
    
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=10${state.lastMsgId ? `&after=${state.lastMsgId}` : ''}`;
    const resp = await fetch(url, { headers });
    
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Discord API ${resp.status}: ${text}`);
    }
    
    const messages = await resp.json();
    for (const dm of messages) {
      if (state.lastMsgId && BigInt(dm.id) <= BigInt(state.lastMsgId)) continue;
      state.lastMsgId = dm.id;
      if (!dm.content) continue;
      
      // Store inbound
      const commsMsg = storeCommsMessage(channel.id, 'discord', 'inbound', {
        remote_id: dm.author?.id || '',
        remote_username: dm.author?.username || '',
        content: dm.content,
        raw: JSON.stringify(dm),
        status: 'received',
      });
      
      logger.info(`Discord inbound from ${commsMsg.remote_username}: ${dm.content.slice(0, 60)}`);
      
      // Auto-respond
      if (config.auto_reply) {
        try {
          const reply = await generateAutoReply(dm.content, channel);
          await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: reply }),
          });
          storeCommsMessage(channel.id, 'discord', 'outbound', {
            remote_id: dm.author?.id || '',
            remote_username: commsMsg.remote_username,
            content: reply,
            status: 'sent',
          });
        } catch (e) {
          logger.error(`Discord auto-reply failed: ${e.message}`);
        }
      }
      
      // Trigger agent
      if (config.trigger_agent && dm.content) {
        try {
          const agentSessionId = await triggerAgentFromComms(channel, commsMsg);
          if (agentSessionId) {
            stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
          }
        } catch (e) {
          logger.error(`Agent trigger from Discord failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    logger.error(`Discord poll error (${channel.name}): ${e.message}`);
  } finally {
    if (!state.stopFlag) {
      discordPollers.set(channel.id, state);
      state.timer = setTimeout(() => pollDiscord(channel), 5000);
    } else {
      stmts.commsChannels.updatePolling.run(0, null, channel.id);
      discordPollers.delete(channel.id);
    }
  }
}

// ── Auto-reply generator (uses LLM if configured, else echo) ──

async function generateAutoReply(text, channel) {
  const config = JSON.parse(channel.config);
  
  if (config.auto_reply_template) {
    return config.auto_reply_template.replace('{text}', text);
  }
  
  // Try LLM if available
  try {
    const defaultModel = stmts.models.getDefault.get();
    if (defaultModel) {
      const provider = stmts.providers.getById.get(defaultModel.provider_id);
      if (provider) {
        const response = await callAgentLLM([
          { role: 'system', content: "You are Cardinal Frame's comms assistant. Reply concisely." },
          { role: 'user', content: text },
        ], defaultModel.id);
        return response || 'Processed.';
      }
    }
  } catch {}
  
  return `✅ Received: "${text.slice(0, 100)}"`;
}

// ── Trigger an agent session from an incoming comms message ──

async function triggerAgentFromComms(channel, commsMsg, cfUserId) {
  const config = JSON.parse(channel.config);
  const userId = cfUserId || config.user_id || 'haz-001'; // default to admin
  
  // Find or create a user mapping
  if (!stmts.users.getById) {
    stmts.users.getById = db.prepare('SELECT * FROM users WHERE id = ?');
  }
  
  const sessionId = randomUUID();
  const task = `[${channel.platform}/${channel.name}] ${commsMsg.content}`;
  const scope = config.agent_scope || 'sandbox';
  const mode = config.agent_mode || 'agent';
  const model = config.agent_model || '';
  
  stmts.agentSessions.insert.run(
    sessionId, userId, null, task, mode, scope, '[]', 'planning', model
  );
  const session = stmts.agentSessions.getById.get(sessionId);
  broadcast('agent:session', { type: 'created', session, source: 'comms', channel });
  logger.info(`Agent session ${sessionId} created from ${channel.platform} message`);
  
  // Run the agent loop in the background
  runAgentLoop(sessionId, { maxSteps: 10 }).catch(e => {
    logger.error(`Agent loop from comms failed: ${e.message}`);
  });
  
  return sessionId;
}

// ── Discord WebSocket Gateway ──

const discordGateways = new Map(); // channelId -> { ws, heartbeatTimer, seq, sessionId, stopFlag }

async function connectDiscordGateway(channel) {
  const config = JSON.parse(channel.config);
  if (!config.bot_token) return;

  // Stop REST poller if running — gateway replaces it
  stopChannelPoller(channel.id);
  if (discordGateways.has(channel.id)) {
    disconnectDiscordGateway(channel.id);
  }

  const state = { ws: null, heartbeatTimer: null, seq: null, sessionId: null, stopFlag: false, channelId: channel.id, resumeUrl: null };
  discordGateways.set(channel.id, state);

  try {
    // Get gateway URL
    const gwResp = await fetch('https://discord.com/api/v10/gateway/bot', {
      headers: { 'Authorization': `Bot ${config.bot_token}` },
    });
    if (!gwResp.ok) throw new Error(`Gateway bot endpoint ${gwResp.status}`);
    const gwData = await gwResp.json();
    const wsUrl = gwData.url + '?v=10&encoding=json';

    const ws = new WebSocket(wsUrl, { headers: { 'Authorization': `Bot ${config.bot_token}` } });
    state.ws = ws;

    ws.on('open', () => {
      logger.info(`Discord gateway WebSocket connected for channel ${channel.name}`);
    });

    ws.on('message', async (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        const { op, d, s, t } = payload;
        if (s !== null) state.seq = s;

        switch (op) {
          case 10: { // HELLO — start heartbeating
            const heartbeatInterval = d.heartbeat_interval;
            state.heartbeatTimer = setInterval(() => {
              if (state.stopFlag) return;
              ws.send(JSON.stringify({ op: 1, d: state.seq }));
            }, heartbeatInterval);
            // Send IDENTIFY
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token: config.bot_token,
                intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
                properties: { os: 'linux', browser: 'cardinal-frame', device: 'cardinal-frame' },
              },
            }));
            break;
          }
          case 11: // HEARTBEAT ACK
            break;
          case 0: { // DISPATCH
            if (t === 'READY') {
              state.sessionId = d.session_id;
              logger.info(`Discord gateway READY: ${d.user?.username} (${d.user?.id})`);
              broadcast('comms:gateway', { channel_id: channel.id, type: 'ready', bot_user: d.user });
            } else if (t === 'MESSAGE_CREATE') {
              // Ignore bot's own messages
              if (d.author?.bot) return;
              // Check channel filter
              if (config.channel_id && d.channel_id !== config.channel_id) return;

              const commsMsg = storeCommsMessage(channel.id, 'discord', 'inbound', {
                remote_id: d.author?.id || '',
                remote_username: d.author?.username || '',
                content: d.content || '',
                raw: JSON.stringify(d),
                status: 'received',
              });

              logger.info(`Discord WS inbound from ${commsMsg.remote_username}: ${(d.content || '').slice(0, 60)}`);

              // Route to user session
              const cfUserId = resolveCommsUser('discord', d.author?.id || '', d.author?.username || '', config);

              // Auto-respond if configured
              if (config.auto_reply) {
                try {
                  const reply = await generateAutoReply(d.content, channel);
                  await fetch(`https://discord.com/api/v10/channels/${d.channel_id}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bot ${config.bot_token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: reply }),
                  });
                  storeCommsMessage(channel.id, 'discord', 'outbound', {
                    remote_id: d.author?.id || '',
                    remote_username: commsMsg.remote_username,
                    content: reply,
                    status: 'sent',
                  });
                } catch (e) { logger.error(`Discord WS auto-reply failed: ${e.message}`); }
              }

              // Trigger agent if configured
              if (config.trigger_agent && d.content) {
                try {
                  const agentSessionId = await triggerAgentFromComms(channel, commsMsg, cfUserId);
                  if (agentSessionId) stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
                } catch (e) { logger.error(`Agent trigger from Discord WS failed: ${e.message}`); }
              }
            } else if (t === 'RESUMED') {
              logger.info(`Discord gateway RESUMED for channel ${channel.name}`);
            }
            break;
          }
          case 7: { // RECONNECT requested by Discord
            logger.info(`Discord gateway RECONNECT requested for ${channel.name}`);
            ws.close(4000);
            // Reconnect after 2s
            setTimeout(() => { if (!state.stopFlag) connectDiscordGateway(channel); }, 2000);
            break;
          }
          case 9: { // INVALID SESSION
            const resumable = d;
            if (resumable && state.sessionId) {
              ws.send(JSON.stringify({ op: 6, d: { token: config.bot_token, session_id: state.sessionId, seq: state.seq } }));
            } else {
              // Fresh identify
              ws.send(JSON.stringify({
                op: 2,
                d: { token: config.bot_token, intents: (1 << 9) | (1 << 15), properties: { os: 'linux', browser: 'cardinal-frame', device: 'cardinal-frame' } },
              }));
            }
            break;
          }
        }
      } catch (e) { logger.error(`Discord gateway message parse error: ${e.message}`); }
    });

    ws.on('close', (code) => {
      logger.info(`Discord gateway WS closed (${code}) for ${channel.name}`);
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      if (!state.stopFlag && code !== 4000) {
        // Auto-reconnect after 5s
        setTimeout(() => { if (!state.stopFlag) connectDiscordGateway(channel); }, 5000);
      }
    });

    ws.on('error', (err) => {
      logger.error(`Discord gateway WS error for ${channel.name}: ${err.message}`);
    });

  } catch (e) {
    logger.error(`Discord gateway connection failed for ${channel.name}: ${e.message}`);
    // Fallback to REST polling after 10s
    setTimeout(() => {
      if (!state.stopFlag && !discordPollers.has(channel.id)) {
        logger.info(`Discord gateway failed — falling back to REST polling for ${channel.name}`);
        startChannelPoller(channel);
      }
    }, 10000);
  }
}

function disconnectDiscordGateway(channelId) {
  const state = discordGateways.get(channelId);
  if (state) {
    state.stopFlag = true;
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.ws) state.ws.close(1000);
    discordGateways.delete(channelId);
  }
}

// ── Session routing: map remote platform users to CF user sessions ──

function resolveCommsUser(platform, remoteId, remoteUsername, channelConfig) {
  // Check for existing mapping
  let mapping = stmts.commsUserSessions.getByPlatformRemote.get(platform, remoteId);
  if (mapping) {
    // Update last-active + username
    stmts.commsUserSessions.updateLastActive.run(remoteUsername, platform, remoteId);
    return mapping.cf_user_id;
  }

  // Create new mapping — default to admin user or configured user
  const defaultUserId = channelConfig?.user_id || 'haz-001';
  const mappingId = randomUUID();
  stmts.commsUserSessions.insert.run(mappingId, platform, remoteId, remoteUsername, defaultUserId, null);
  logger.info(`Comms session mapping created: ${platform}/${remoteUsername} → ${defaultUserId}`);
  return defaultUserId;
}

// ── Start/stop pollers for enabled channels ──

function startChannelPoller(channel) {
  if (channel.platform === 'telegram') {
    if (telegramPollers.has(channel.id)) return;
    telegramPollers.set(channel.id, { offset: 0, stopFlag: false });
    pollTelegram(channel);
  } else if (channel.platform === 'discord') {
    if (discordPollers.has(channel.id)) return;
    discordPollers.set(channel.id, { lastMsgId: null, stopFlag: false });
    pollDiscord(channel);
  }
}

function stopChannelPoller(channelId) {
  const tg = telegramPollers.get(channelId);
  if (tg) { tg.stopFlag = true; clearTimeout(tg.timer); telegramPollers.delete(channelId); }
  const dc = discordPollers.get(channelId);
  if (dc) { dc.stopFlag = true; clearTimeout(dc.timer); discordPollers.delete(channelId); }
  disconnectDiscordGateway(channelId);
  stmts.commsChannels.updatePolling.run(0, null, channelId);
}

// Start pollers for enabled channels on boot
setTimeout(() => {
  try {
    const channels = stmts.commsChannels.getEnabled.all();
    for (const ch of channels) {
      const config = JSON.parse(ch.config);
      if (ch.platform === 'telegram' && config.bot_token) startChannelPoller(ch);
      if (ch.platform === 'discord' && config.bot_token && config.channel_id) {
        if (config.gateway_mode) {
          connectDiscordGateway(ch);
        } else {
          startChannelPoller(ch);
        }
      }
    }
    logger.info(`Comms: started ${telegramPollers.size} Telegram pollers, ${discordPollers.size} Discord pollers, ${discordGateways.size} Discord gateways`);
  } catch (e) { logger.error(`Comms boot error: ${e.message}`); }
}, 3000);

// ── Comms API endpoints ──

// List all channels
router.get('/comms/channels', authMiddleware, (_req, res) => {
  try {
    const channels = stmts.commsChannels.getAll.all().map(c => ({
      ...c,
      config: JSON.parse(c.config),
      polling: c.polling,
    }));
    res.json(channels);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a channel
router.post('/comms/channels', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { platform, name, config, enabled = true } = req.body;
    if (!platform || !name) return res.status(400).json({ error: 'platform and name required' });
    if (!['telegram', 'discord'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' });
    
    const id = randomUUID();
    const configStr = JSON.stringify(config || {});
    stmts.commsChannels.insert.run(id, platform, name, configStr, enabled ? 1 : 0);
    const channel = stmts.commsChannels.getById.get(id);
    
    if (enabled) {
      const configParsed = JSON.parse(configStr);
      if (platform === 'telegram' && configParsed.bot_token) startChannelPoller(channel);
      if (platform === 'discord' && configParsed.bot_token && configParsed.channel_id) {
        if (configParsed.gateway_mode) connectDiscordGateway(channel);
        else startChannelPoller(channel);
      }
    }
    
    broadcast('comms:channel', { type: 'created', channel });
    res.status(201).json({ ...channel, config: JSON.parse(channel.config) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a channel (enable/disable, change config)
router.put('/comms/channels/:id', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const channel = stmts.commsChannels.getById.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const { name, config, enabled } = req.body;
    const newName = name ?? channel.name;
    const newConfig = config ? JSON.stringify(config) : channel.config;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : channel.enabled;
    
    stmts.commsChannels.update.run(newName, newConfig, newEnabled, channel.id);
    const updated = stmts.commsChannels.getById.get(channel.id);
    
    // Start/stop pollers
    if (newEnabled) {
      const configParsed = JSON.parse(newConfig);
      if (channel.platform === 'telegram' && configParsed.bot_token) startChannelPoller(updated);
      if (channel.platform === 'discord' && configParsed.bot_token && configParsed.channel_id) {
        if (configParsed.gateway_mode) connectDiscordGateway(updated);
        else startChannelPoller(updated);
      }
    } else {
      stopChannelPoller(channel.id);
    }
    
    broadcast('comms:channel', { type: 'updated', channel: updated });
    res.json({ ...updated, config: JSON.parse(updated.config) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a channel
router.delete('/comms/channels/:id', authMiddleware, requireRole('admin'), (req, res) => {
  try {
    const channel = stmts.commsChannels.getById.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    stopChannelPoller(channel.id);
    stmts.commsChannels.delete.run(channel.id);
    broadcast('comms:channel', { type: 'deleted', id: channel.id });
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test outbound dispatch (Telegram or Discord)
router.post('/comms/dispatch', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { channel_id, message } = req.body;
    if (!channel_id || !message) return res.status(400).json({ error: 'channel_id and message required' });
    
    const channel = stmts.commsChannels.getById.get(channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const config = JSON.parse(channel.config);
    
    if (channel.platform === 'telegram') {
      if (!config.bot_token) return res.status(400).json({ error: 'No bot_token configured' });
      const targetChatId = config.chat_id || req.body.chat_id;
      if (!targetChatId) return res.status(400).json({ error: 'No chat_id configured or provided' });
      
      try {
        await telegramApiCall(config.bot_token, 'sendMessage', {
          chat_id: targetChatId,
          text: message,
          parse_mode: 'Markdown',
        });
        const msg = storeCommsMessage(channel.id, 'telegram', 'outbound', {
          remote_id: String(targetChatId),
          content: message,
          status: 'sent',
        });
        res.json({ sent: true, mode: 'live', platform: 'telegram', message_id: msg.id });
      } catch (e) {
        storeCommsMessage(channel.id, 'telegram', 'outbound', {
          content: message, status: 'failed',
        });
        res.status(502).json({ error: e.message });
      }
    } else if (channel.platform === 'discord') {
      const webhookUrl = config.webhook_url;
      if (!webhookUrl) return res.status(400).json({ error: 'No webhook_url configured' });
      
      try {
        await discordWebhookSend(webhookUrl, message, { username: config.bot_name || 'Cardinal Frame' });
        const msg = storeCommsMessage(channel.id, 'discord', 'outbound', {
          content: message,
          status: 'sent',
        });
        res.json({ sent: true, mode: 'live', platform: 'discord', message_id: msg.id });
      } catch (e) {
        storeCommsMessage(channel.id, 'discord', 'outbound', {
          content: message, status: 'failed',
        });
        res.status(502).json({ error: e.message });
      }
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List messages (optionally filtered by channel)
router.get('/comms/messages', authMiddleware, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const channelId = req.query.channel_id;
    if (channelId) {
      res.json(stmts.commsMessages.getByChannel.all(channelId, limit));
    } else {
      res.json(stmts.commsMessages.getAll.all(limit));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get comms status (poller states, channel count)
router.get('/comms/status', authMiddleware, (_req, res) => {
  try {
    const channels = stmts.commsChannels.getAll.all();
    res.json({
      telegram_pollers: telegramPollers.size,
      discord_pollers: discordPollers.size,
      channels: channels.map(c => ({
        id: c.id,
        platform: c.platform,
        name: c.name,
        enabled: !!c.enabled,
        polling: !!c.polling,
        last_poll_at: c.last_poll_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Register Telegram webhook (one-click setup)
router.post('/comms/telegram/setup-webhook', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { channel_id, webhook_url } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    const channel = stmts.commsChannels.getById.get(channel_id);
    if (!channel || channel.platform !== 'telegram') return res.status(400).json({ error: 'Telegram channel required' });
    const config = JSON.parse(channel.config);
    if (!config.bot_token) return res.status(400).json({ error: 'No bot_token configured' });

    const baseUrl = webhook_url || req.body.base_url;
    if (!baseUrl) return res.status(400).json({ error: 'webhook_url or base_url required' });
    const fullUrl = `${baseUrl.replace(/\/$/, '')}/api/comms/telegram/webhook?channel_id=${channel_id}`;

    // Delete existing webhook, then set new one
    await telegramApiCall(config.bot_token, 'deleteWebhook', {});
    const result = await telegramApiCall(config.bot_token, 'setWebhook', { url: fullUrl, allowed_updates: ['message', 'channel_post'] });

    // Stop polling if active, switch to webhook mode
    stopChannelPoller(channel_id);
    config.webhook_mode = true;
    config.webhook_url = fullUrl;
    stmts.commsChannels.update.run(channel.name, JSON.stringify(config), channel.enabled ? 1 : 0, channel_id);

    logger.info(`Telegram webhook registered for channel ${channel.name}: ${fullUrl}`);
    res.json({ ok: true, webhook_url: fullUrl, description: result.description || 'Webhook set' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Unregister Telegram webhook (switch back to polling)
router.post('/comms/telegram/remove-webhook', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { channel_id } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    const channel = stmts.commsChannels.getById.get(channel_id);
    if (!channel || channel.platform !== 'telegram') return res.status(400).json({ error: 'Telegram channel required' });
    const config = JSON.parse(channel.config);
    if (!config.bot_token) return res.status(400).json({ error: 'No bot_token configured' });

    await telegramApiCall(config.bot_token, 'deleteWebhook', {});
    config.webhook_mode = false;
    delete config.webhook_url;
    stmts.commsChannels.update.run(channel.name, JSON.stringify(config), channel.enabled ? 1 : 0, channel_id);

    // Restart polling
    if (channel.enabled) startChannelPoller(channel);
    logger.info(`Telegram webhook removed for channel ${channel.name}`);
    res.json({ ok: true, mode: 'polling' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Register Discord slash commands (one-click setup)
router.post('/comms/discord/setup-commands', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { channel_id } = req.body;
    if (!channel_id) return res.status(400).json({ error: 'channel_id required' });
    const channel = stmts.commsChannels.getById.get(channel_id);
    if (!channel || channel.platform !== 'discord') return res.status(400).json({ error: 'Discord channel required' });
    const config = JSON.parse(channel.config);
    if (!config.bot_token) return res.status(400).json({ error: 'No bot_token configured' });

    // Register global slash commands
    const commands = [
      { name: 'ask', description: 'Ask the Cardinal Frame agent a question', options: [{ type: 3, name: 'prompt', description: 'Your question', required: true }] },
      { name: 'status', description: 'Check Cardinal Frame status' },
      { name: 'tasks', description: 'List active agent tasks' },
    ];

    const resp = await fetch('https://discord.com/api/v10/applications/' + config.application_id + '/commands', {
      method: 'PUT',
      headers: { 'Authorization': `Bot ${config.bot_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return res.json({ ok: false, error: `${resp.status} ${resp.statusText}`, detail: text.slice(0, 500) });
    }

    const registered = await resp.json();
    logger.info(`Discord slash commands registered for channel ${channel.name}: ${registered.length} commands`);
    res.json({ ok: true, commands: registered.map(c => c.name) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Telegram webhook receiver (alternative to polling)
router.post('/comms/telegram/webhook', async (req, res) => {
  try {
    const channelId = req.query.channel_id;
    if (!channelId) return res.status(400).json({ error: 'channel_id query param required' });
    const channel = stmts.commsChannels.getById.get(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const update = req.body;
    const msg = update.message || update.channel_post;
    if (msg && msg.text) {
      const commsMsg = storeCommsMessage(channel.id, 'telegram', 'inbound', {
        remote_id: String(msg.from?.id || msg.chat?.id || ''),
        remote_username: msg.from?.username || msg.from?.first_name || '',
        content: msg.text,
        raw: JSON.stringify(update),
        status: 'received',
      });
      
      const config = JSON.parse(channel.config);
      if (config.auto_reply) {
        try {
          const reply = await generateAutoReply(msg.text, channel);
          await telegramApiCall(config.bot_token, 'sendMessage', {
            chat_id: msg.chat?.id || msg.from?.id,
            text: reply,
            parse_mode: 'Markdown',
          });
          storeCommsMessage(channel.id, 'telegram', 'outbound', {
            remote_id: String(msg.chat?.id || msg.from?.id || ''),
            remote_username: commsMsg.remote_username,
            content: reply,
            status: 'sent',
          });
        } catch (e) { logger.error(`Telegram webhook reply failed: ${e.message}`); }
      }
      
      if (config.trigger_agent) {
        try {
          const agentSessionId = await triggerAgentFromComms(channel, commsMsg);
          if (agentSessionId) stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
        } catch (e) { logger.error(`Agent trigger from webhook failed: ${e.message}`); }
      }
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Discord webhook receiver (for slash commands or interactions)
router.post('/comms/discord/webhook', async (req, res) => {
  try {
    const channelId = req.query.channel_id;
    if (!channelId) return res.status(400).json({ error: 'channel_id query param required' });
    const channel = stmts.commsChannels.getById.get(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const interaction = req.body;
    if (interaction.type === 1) {
      // Discord interaction type 1 = PING
      return res.json({ type: 1 });
    }
    
    if (interaction.data?.content || interaction.content) {
      const content = interaction.data?.content || interaction.content;
      const username = interaction.member?.user?.username || interaction.author?.username || 'Unknown';
      const userId = interaction.member?.user?.id || interaction.author?.id || '';
      
      const commsMsg = storeCommsMessage(channel.id, 'discord', 'inbound', {
        remote_id: userId,
        remote_username: username,
        content,
        raw: JSON.stringify(interaction),
        status: 'received',
      });
      
      const config = JSON.parse(channel.config);
      if (config.trigger_agent) {
        try {
          const agentSessionId = await triggerAgentFromComms(channel, commsMsg);
          if (agentSessionId) stmts.commsMessages.updateAgentSession.run(agentSessionId, commsMsg.id);
        } catch (e) { logger.error(`Agent trigger from Discord webhook failed: ${e.message}`); }
      }
    }
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get comms gateway status
router.get('/comms/gateways', authMiddleware, (_req, res) => {
  try {
    const gateways = [];
    for (const [channelId, state] of discordGateways) {
      gateways.push({
        channel_id: channelId,
        connected: !!state.ws && state.ws.readyState === 1,
        session_id: state.sessionId,
        seq: state.seq,
      });
    }
    res.json({ gateways, count: gateways.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start Discord gateway for a channel
router.post('/comms/discord/:id/start-gateway', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const channel = stmts.commsChannels.getById.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.platform !== 'discord') return res.status(400).json({ error: 'Discord channel required' });
    const config = JSON.parse(channel.config);
    if (!config.bot_token || !config.channel_id) return res.status(400).json({ error: 'bot_token and channel_id required' });

    config.gateway_mode = true;
    stmts.commsChannels.update.run(channel.name, JSON.stringify(config), channel.enabled ? 1 : 0, channel.id);
    await connectDiscordGateway(stmts.commsChannels.getById.get(channel.id));
    res.json({ ok: true, mode: 'gateway', message: 'WebSocket gateway started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop Discord gateway (revert to polling)
router.post('/comms/discord/:id/stop-gateway', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const channel = stmts.commsChannels.getById.get(req.params.id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.platform !== 'discord') return res.status(400).json({ error: 'Discord channel required' });

    disconnectDiscordGateway(channel.id);
    const config = JSON.parse(channel.config);
    config.gateway_mode = false;
    stmts.commsChannels.update.run(channel.name, JSON.stringify(config), channel.enabled ? 1 : 0, channel.id);

    // Restart REST polling
    if (channel.enabled) startChannelPoller(stmts.commsChannels.getById.get(channel.id));
    res.json({ ok: true, mode: 'polling', message: 'Gateway stopped, switched to polling' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Comms Session Routing ──

// List user session mappings
router.get('/comms/sessions', authMiddleware, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const platform = req.query.platform;
    let sessions;
    if (platform) {
      sessions = stmts.commsUserSessions.getAll.all(limit).filter(s => s.platform === platform);
    } else {
      sessions = stmts.commsUserSessions.getAll.all(limit);
    }
    res.json(sessions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update session mapping (change which CF user a remote user maps to)
router.put('/comms/sessions/:id', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
  try {
    const { cf_user_id, agent_session_id } = req.body;
    const session = stmts.commsUserSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session mapping not found' });

    // We need a custom update since we don't have a generic update stmt
    if (cf_user_id) {
      db.prepare('UPDATE comms_user_sessions SET cf_user_id = ?, last_active = datetime(\'now\') WHERE id = ?').run(cf_user_id, req.params.id);
    }
    if (agent_session_id !== undefined) {
      db.prepare('UPDATE comms_user_sessions SET agent_session_id = ?, last_active = datetime(\'now\') WHERE id = ?').run(agent_session_id, req.params.id);
    }
    const updated = stmts.commsUserSessions.getById.get(req.params.id);
    broadcast('comms:session', { type: 'updated', session: updated });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete session mapping
router.delete('/comms/sessions/:id', authMiddleware, requireRole('admin'), (req, res) => {
  try {
    stmts.commsUserSessions.delete.run(req.params.id);
    broadcast('comms:session', { type: 'deleted', id: req.params.id });
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

  return router;
}
