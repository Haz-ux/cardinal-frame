import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';
import {
  hasSenderAllowlist,
  telegramSenderAllowed,
  resolveTriggerUserId,
  validateCommsAutomationConfig,
} from '../src/server/routes/comms.mjs';

let app, db;

beforeAll(async () => {
  ({ app, db } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Comms Engine API', () => {
  describe('Channel CRUD', () => {
    it('should create a Telegram channel', async () => {
      const res = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'test-telegram',
          config: { bot_token: 'fake-token', chat_id: '12345' },
          enabled: false, // disabled so it won't actually poll
        });
      expect(res.status).toBe(201);
      expect(res.body.platform).toBe('telegram');
      expect(res.body.name).toBe('test-telegram');
      expect(res.body.config.bot_token).toBe('fake-token');
    });

    it('should create a Discord channel', async () => {
      const res = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'discord',
          name: 'test-discord',
          config: { webhook_url: 'https://discord.com/api/webhooks/fake', bot_token: 'fake-bot' },
          enabled: false,
        });
      expect(res.status).toBe(201);
      expect(res.body.platform).toBe('discord');
    });

    it('should reject invalid platform', async () => {
      const res = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({ platform: 'slack', name: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('should require platform and name', async () => {
      const res = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({ name: 'no-platform' });
      expect(res.status).toBe(400);
    });

    it('should list all channels', async () => {
      const res = await request(app)
        .get('/api/comms/channels')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it('should update a channel', async () => {
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'update-test',
          config: { bot_token: 'original' },
          enabled: false,
        });
      const id = createRes.body.id;

      const res = await request(app)
        .put(`/api/comms/channels/${id}`)
        .set(adminAuth())
        .send({
          name: 'updated-name',
          config: { bot_token: 'changed' },
          enabled: false,
        });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('updated-name');
      expect(res.body.config.bot_token).toBe('changed');
    });

    it('should delete a channel', async () => {
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'delete-test',
          config: {},
          enabled: false,
        });
      const id = createRes.body.id;

      const res = await request(app)
        .delete(`/api/comms/channels/${id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      // Verify it's gone
      const listRes = await request(app)
        .get('/api/comms/channels')
        .set(adminAuth());
      expect(listRes.body.find(c => c.id === id)).toBeUndefined();
    });

    it('should return 404 for non-existent channel', async () => {
      const res = await request(app)
        .delete('/api/comms/channels/nonexistent-id')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('Message listing', () => {
    it('should list messages (empty initially)', async () => {
      const res = await request(app)
        .get('/api/comms/messages')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should filter messages by channel_id', async () => {
      // Create a channel first
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'msg-filter-test',
          config: {},
          enabled: false,
        });
      const channelId = createRes.body.id;

      const res = await request(app)
        .get(`/api/comms/messages?channel_id=${channelId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('Comms status', () => {
    it('should return poller status', async () => {
      const res = await request(app)
        .get('/api/comms/status')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('telegram_pollers');
      expect(res.body).toHaveProperty('discord_pollers');
      expect(res.body).toHaveProperty('channels');
      expect(Array.isArray(res.body.channels)).toBe(true);
    });
  });

  describe('Telegram webhook receiver', () => {
    it('should receive a Telegram update via webhook', async () => {
      // Create a channel with auto_reply disabled
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'webhook-test',
          config: { bot_token: 'fake', auto_reply: false, webhook_secret: 'test-secret' },
          enabled: false,
        });
      const channelId = createRes.body.id;

      const res = await request(app)
        .post(`/api/comms/telegram/webhook?channel_id=${channelId}`)
        .set('x-telegram-bot-api-secret-token', 'test-secret')
        .send({
          update_id: 99999,
          message: {
            message_id: 1,
            from: { id: 111, username: 'testuser', first_name: 'Test' },
            chat: { id: 111, type: 'private' },
            text: 'Hello from webhook test',
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Verify message was stored
      const msgRes = await request(app)
        .get(`/api/comms/messages?channel_id=${channelId}`)
        .set(adminAuth());
      expect(msgRes.status).toBe(200);
      expect(msgRes.body.length).toBeGreaterThan(0);
      expect(msgRes.body[0].content).toBe('Hello from webhook test');
      expect(msgRes.body[0].direction).toBe('inbound');
      expect(msgRes.body[0].remote_username).toBe('testuser');
    });

    it('should reject webhook with wrong secret', async () => {
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'webhook-secret-test',
          config: { bot_token: 'fake', webhook_secret: 'right-secret' },
          enabled: false,
        });
      const channelId = createRes.body.id;

      const res = await request(app)
        .post(`/api/comms/telegram/webhook?channel_id=${channelId}`)
        .set('x-telegram-bot-api-secret-token', 'wrong-secret')
        .send({ message: { text: 'x', from: { id: 1 }, chat: { id: 1 } } });
      expect(res.status).toBe(403);
    });

    describe('sender allowlist', () => {
      let channelId;
      beforeAll(async () => {
        const createRes = await request(app)
          .post('/api/comms/channels')
          .set(adminAuth())
          .send({
            platform: 'telegram',
            name: 'webhook-allowlist-test',
            config: {
              bot_token: 'fake',
              auto_reply: false,
              webhook_secret: 'allow-secret',
              allowed_user_ids: ['4242'],
            },
            enabled: false,
          });
        channelId = createRes.body.id;
      });

      const postUpdate = (fromId, text) =>
        request(app)
          .post(`/api/comms/telegram/webhook?channel_id=${channelId}`)
          .set('x-telegram-bot-api-secret-token', 'allow-secret')
          .send({
            update_id: Math.floor(Math.random() * 1e9),
            message: {
              message_id: 1,
              from: { id: fromId, username: 'u' + fromId },
              chat: { id: fromId, type: 'private' },
              text,
            },
          });

      const messageCount = async () => {
        const r = await request(app)
          .get(`/api/comms/messages?channel_id=${channelId}`)
          .set(adminAuth());
        return r.body.length;
      };

      it('acks but drops updates from non-allowlisted senders', async () => {
        const before = await messageCount();
        const res = await postUpdate(9999, 'stranger message');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(await messageCount()).toBe(before);
      });

      it('processes updates from allowlisted senders', async () => {
        const before = await messageCount();
        const res = await postUpdate(4242, 'haz message');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(await messageCount()).toBe(before + 1);
      });

      it('accepts numeric ids as strings', async () => {
        // allowed_user_ids stored as ['4242']; Telegram sends numeric 4242
        const res = await postUpdate(4242, 'numeric id ok');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      });
    });

    it('should reject webhook without channel_id', async () => {
      const res = await request(app)
        .post('/api/comms/telegram/webhook')
        .send({ message: { text: 'test' } });
      expect(res.status).toBe(400);
    });

    it('should reject webhook for non-existent channel', async () => {
      const res = await request(app)
        .post('/api/comms/telegram/webhook?channel_id=fake-id')
        .send({ message: { text: 'test' } });
      expect(res.status).toBe(404);
    });
  });

  describe('Discord webhook receiver', () => {
    it('should handle Discord PING (type 1)', async () => {
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'discord',
          name: 'discord-ping-test',
          config: { bot_token: 'fake' },
          enabled: false,
        });
      const channelId = createRes.body.id;

      const res = await request(app)
        .post(`/api/comms/discord/webhook?channel_id=${channelId}`)
        .send({ type: 1 });
      expect(res.status).toBe(200);
      expect(res.body.type).toBe(1);
    });

    it('should receive a Discord interaction', async () => {
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'discord',
          name: 'discord-msg-test',
          config: { bot_token: 'fake' },
          enabled: false,
        });
      const channelId = createRes.body.id;

      const res = await request(app)
        .post(`/api/comms/discord/webhook?channel_id=${channelId}`)
        .send({
          type: 2,
          data: { content: 'Hello from Discord' },
          member: { user: { id: '222', username: 'discorduser' } },
        });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Verify message stored
      const msgRes = await request(app)
        .get(`/api/comms/messages?channel_id=${channelId}`)
        .set(adminAuth());
      expect(msgRes.body.length).toBeGreaterThan(0);
      expect(msgRes.body[0].content).toBe('Hello from Discord');
      expect(msgRes.body[0].remote_username).toBe('discorduser');
    });
  });

  describe('Auth', () => {
    it('should require auth for channels', async () => {
      const res = await request(app)
        .get('/api/comms/channels');
      expect(res.status).toBe(401);
    });

    it('should require admin role for creating channels', async () => {
      const res = await request(app)
        .post('/api/comms/channels')
        .set(userAuth())
        .send({ platform: 'telegram', name: 'unauth' });
      expect(res.status).toBe(403);
    });

    it('should require admin for dispatch', async () => {
      const res = await request(app)
        .post('/api/comms/dispatch')
        .set(userAuth())
        .send({ channel_id: 'x', message: 'y' });
      expect(res.status).toBe(403);
    });
  });

  describe('Dispatch validation', () => {
    it('should reject dispatch without channel_id', async () => {
      const res = await request(app)
        .post('/api/comms/dispatch')
        .set(adminAuth())
        .send({ message: 'test' });
      expect(res.status).toBe(400);
    });

    it('should reject dispatch without message', async () => {
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'dispatch-validation',
          config: {},
          enabled: false,
        });

      const res = await request(app)
        .post('/api/comms/dispatch')
        .set(adminAuth())
        .send({ channel_id: createRes.body.id });
      expect(res.status).toBe(400);
    });
  });

  describe('C2 trigger_agent fail-closed (regression)', () => {
    it('hasSenderAllowlist requires a non-empty array', () => {
      expect(hasSenderAllowlist({})).toBe(false);
      expect(hasSenderAllowlist({ allowed_user_ids: [] })).toBe(false);
      expect(hasSenderAllowlist({ allowed_user_ids: '4242' })).toBe(false);
      expect(hasSenderAllowlist({ allowed_user_ids: ['4242'] })).toBe(true);
    });

    it('telegramSenderAllowed fails closed on empty/missing allowlist', () => {
      const msg = (id) => ({ from: { id } });
      expect(telegramSenderAllowed({}, msg(4242))).toBe(false);
      expect(telegramSenderAllowed({ allowed_user_ids: [] }, msg(4242))).toBe(false);
      expect(telegramSenderAllowed({ allowed_user_ids: ['4242'] }, msg(9999))).toBe(false);
      expect(telegramSenderAllowed({ allowed_user_ids: ['4242'] }, msg(4242))).toBe(true);
    });

    it('resolveTriggerUserId never defaults to an admin id', () => {
      expect(resolveTriggerUserId('user-abc-123')).toBe('user-abc-123');
      expect(resolveTriggerUserId(undefined)).toBeNull();
      expect(resolveTriggerUserId(null)).toBeNull();
      expect(resolveTriggerUserId('')).toBeNull();
    });

    it('validateCommsAutomationConfig rejects arming automation without an allowlist', () => {
      expect(validateCommsAutomationConfig({ trigger_agent: true })).toMatch(/allowed_user_ids/);
      expect(validateCommsAutomationConfig({ auto_reply: true })).toMatch(/allowed_user_ids/);
      expect(validateCommsAutomationConfig({ trigger_agent: true, allowed_user_ids: [] })).toMatch(/allowed_user_ids/);
      expect(validateCommsAutomationConfig({ trigger_agent: true, allowed_user_ids: ['4242'] })).toBeNull();
      expect(validateCommsAutomationConfig({ bot_token: 'x' })).toBeNull();
    });

    it('rejects creating a channel with trigger_agent and no allowed_user_ids', async () => {
      const res = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'c2-no-allowlist',
          config: { bot_token: 'fake', trigger_agent: true },
          enabled: false,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/allowed_user_ids/);
    });

    it('rejects creating a channel with auto_reply and no allowed_user_ids', async () => {
      const res = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'discord',
          name: 'c2-no-allowlist-discord',
          config: { bot_token: 'fake', auto_reply: true },
          enabled: false,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/allowed_user_ids/);
    });

    it('allows trigger_agent with a non-empty allowed_user_ids', async () => {
      const res = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'c2-with-allowlist',
          config: { bot_token: 'fake', trigger_agent: true, allowed_user_ids: ['4242'] },
          enabled: false,
        });
      expect(res.status).toBe(201);
    });

    it('rejects enabling trigger_agent via PUT without an allowlist', async () => {
      const createRes = await request(app)
        .post('/api/comms/channels')
        .set(adminAuth())
        .send({
          platform: 'telegram',
          name: 'c2-put-test',
          config: { bot_token: 'fake' },
          enabled: false,
        });
      expect(createRes.status).toBe(201);

      const bad = await request(app)
        .put(`/api/comms/channels/${createRes.body.id}`)
        .set(adminAuth())
        .send({ config: { bot_token: 'fake', trigger_agent: true } });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/allowed_user_ids/);

      const good = await request(app)
        .put(`/api/comms/channels/${createRes.body.id}`)
        .set(adminAuth())
        .send({ config: { bot_token: 'fake', trigger_agent: true, allowed_user_ids: ['4242'] } });
      expect(good.status).toBe(200);
    });

    it('comms.mjs contains no hardcoded admin default for trigger identity', () => {
      const commsPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..', 'src', 'server', 'routes', 'comms.mjs'
      );
      const src = readFileSync(commsPath, 'utf8');
      expect(src).not.toContain('haz-001');
    });
  });
});
