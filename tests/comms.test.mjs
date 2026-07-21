import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

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
          config: { bot_token: 'fake', auto_reply: false },
          enabled: false,
        });
      const channelId = createRes.body.id;

      const res = await request(app)
        .post(`/api/comms/telegram/webhook?channel_id=${channelId}`)
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
});
