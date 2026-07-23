import express from 'express';
import { randomUUID } from 'crypto';

/**
 * Comms Engine: Telegram + Discord integration.
 * Dependencies (via ctx): db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast
 */

export default function commsRoutes(ctx) {
  const { db, stmts, authMiddleware, requireRole, apiLimiter, logger, broadcast, callAgentLLM, fireHook } = ctx;
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
    const defaultModel = stmts.llmModels.getDefault.get();
    if (defaultModel) {
      const provider = stmts.llmProviders.getById.get(defaultModel.provider_id);
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

async function triggerAgentFromComms(channel, commsMsg) {
  const config = JSON.parse(channel.config);
  const userId = config.user_id || 'haz-001'; // default to admin
  
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
  stmts.commsChannels.updatePolling.run(0, null, channelId);
}

// Start pollers for enabled channels on boot
setTimeout(() => {
  try {
    const channels = stmts.commsChannels.getEnabled.all();
    for (const ch of channels) {
      const config = JSON.parse(ch.config);
      if (ch.platform === 'telegram' && config.bot_token) startChannelPoller(ch);
      if (ch.platform === 'discord' && config.bot_token && config.channel_id) startChannelPoller(ch);
    }
    logger.info(`Comms: started ${telegramPollers.size} Telegram + ${discordPollers.size} Discord pollers`);
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
      if (platform === 'discord' && configParsed.bot_token && configParsed.channel_id) startChannelPoller(channel);
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
      if (channel.platform === 'discord' && configParsed.bot_token && configParsed.channel_id) startChannelPoller(updated);
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

  return router;
}
