import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;
let db;

beforeAll(async () => {
  ({ app, db } = await getTestServer());
});

afterAll(async () => {
  await cleanupTestServer();
});

describe('Security regression — command execution gates', () => {
  it('blocks a non-admin from creating a task with a shell-interpreter command', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(userAuth())
      .send({ name: 'Escalate', command: "bash -c 'rm -rf /tmp'" });
    expect([400, 403]).toContain(res.status);
    expect(res.body.needs_approval).toBeUndefined();
  });

  it('blocks a non-admin from creating a task with an embedded interpreter', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(userAuth())
      .send({ name: 'PyEsc', command: "python3 -c \"import os; os.system('id')\"" });
    expect([400, 403]).toContain(res.status);
  });

  it('allows a non-admin to create a benign task', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(userAuth())
      .send({ name: 'Benign', command: 'echo hello' });
    expect(res.status).toBe(201);
  });

  it('blocks a non-admin from creating a job-catalog template', async () => {
    const res = await request(app)
      .post('/api/job-catalog')
      .set(userAuth())
      .send({ name: 'Evil template', command: "bash -c 'id'" });
    expect(res.status).toBe(403);
  });

  it('allows an admin to create a job-catalog template', async () => {
    const res = await request(app)
      .post('/api/job-catalog')
      .set(adminAuth())
      .send({ name: 'Admin template', command: 'echo admin' });
    expect(res.status).toBe(201);
  });
});

describe('Security regression — chat upload & attachment access', () => {
  it('sanitizes a path-traversal filename on chat upload (no directory escape)', async () => {
    const res = await request(app)
      .post('/api/chat/upload')
      .set(userAuth('uploader-1', 'uploader'))
      .send({ filename: '../../../../etc/passwd', content_b64: Buffer.from('leak').toString('base64') });
    expect(res.status).toBe(201);
    expect(res.body.filename).not.toContain('/');
    expect(res.body.filename).not.toContain('..');
  });

  it('prevents one user from reading another user\'s attachment (IDOR)', async () => {
    // Create a conversation owned by "owner" and an attachment on it
    const convId = 'conv-owner-1';
    db.prepare('INSERT INTO chat_conversations (id, title, user_id, model, system_prompt) VALUES (?, ?, ?, ?, ?)')
      .run(convId, 'Owner conv', 'owner-user', '', '');
    const msgId = 'msg-owner-1';
    db.prepare('INSERT INTO chat_messages (id, conversation_id, role, content, attachments, tool_calls, tool_call_id, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(msgId, convId, 'user', 'hello', '[]', '[]', null, '', 0, 0);
    const attId = 'att-owner-1';
    db.prepare('INSERT INTO chat_attachments (id, message_id, file_id, filename, mime_type, size, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(attId, msgId, null, 'secret.txt', 'text/plain', 4, '/tmp/secret-owner-1.txt');
    require('fs').writeFileSync('/tmp/secret-owner-1.txt', 'data');

    // Another user (not owner, not admin) must be denied
    const other = await request(app).get(`/api/chat/attachments/${attId}`).set(userAuth('intruder', 'intruder'));
    expect(other.status).toBe(403);

    // The owner can read their own attachment
    const owner = await request(app).get(`/api/chat/attachments/${attId}`).set(userAuth('owner-user', 'owner'));
    expect(owner.status).toBe(200);

    require('fs').unlinkSync('/tmp/secret-owner-1.txt');
  });
});
