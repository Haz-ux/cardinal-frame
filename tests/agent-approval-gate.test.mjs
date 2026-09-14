import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';
import { sanitizeFtsQuery } from '../src/server/routes/memory.mjs';

let app;
let db;

beforeAll(async () => {
  ({ app, db } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

// Insert a pending action in the exact shape runAgentLoop now writes:
// the gated tool call sits in `content` as { tool, args } and NOTHING
// has executed yet.
function insertGatedAction(sessionId, tool, args) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agent_actions (id, session_id, step_index, action_type, target, content, result, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    0,
    tool === 'file_write' ? 'write' : 'exec',
    args.path || args.command || tool,
    JSON.stringify({ tool, args }),
    'awaiting approval',
    'pending'
  );
  return id;
}

async function createSuggestSession() {
  const res = await request(app)
    .post('/api/agent/sessions')
    .set(adminAuth())
    .send({ task: 'gate test task', mode: 'suggest', scope: 'sandbox' });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('Approval gate — approval precedes execution (Muse pattern)', () => {
  it('file_write does NOT execute before approval, and DOES on approval', async () => {
    const sessionId = await createSuggestSession();
    const fileName = `gate-test-${randomUUID().slice(0, 8)}.txt`;
    const filePath = join('/home/haz/ai-workspace', fileName);
    const actionId = insertGatedAction(sessionId, 'file_write', {
      path: fileName,
      content: 'written only after approval',
      scope: 'sandbox',
    });

    // Nothing has run yet: the file must not exist before approval.
    expect(existsSync(filePath)).toBe(false);

    const res = await request(app)
      .post('/api/agent/approve')
      .set(adminAuth())
      .send({ action_id: actionId });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('approved');
    expect(res.body.tool).toBe('file_write');

    // Now the tool has executed.
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('written only after approval');

    const action = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(actionId);
    expect(action.status).toBe('approved');
    expect(action.result).toContain('written');

    rmSync(filePath, { force: true });
  });

  it('shell_exec does NOT execute before approval, and DOES on approval', async () => {
    const sessionId = await createSuggestSession();
    const actionId = insertGatedAction(sessionId, 'shell_exec', {
      command: 'echo gate-exec-ok',
      scope: 'sandbox',
    });

    const res = await request(app)
      .post('/api/agent/approve')
      .set(adminAuth())
      .send({ action_id: actionId });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('approved');

    const action = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(actionId);
    expect(action.status).toBe('approved');
    expect(action.result).toContain('gate-exec-ok');
  });

  it('rejecting a gated action never executes it', async () => {
    const sessionId = await createSuggestSession();
    const fileName = `gate-reject-${randomUUID().slice(0, 8)}.txt`;
    const filePath = join('/home/haz/ai-workspace', fileName);
    const actionId = insertGatedAction(sessionId, 'file_write', {
      path: fileName,
      content: 'should never be written',
      scope: 'sandbox',
    });

    const res = await request(app)
      .post('/api/agent/reject')
      .set(adminAuth())
      .send({ action_id: actionId });
    expect(res.status).toBe(200);

    expect(existsSync(filePath)).toBe(false);
    const action = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(actionId);
    expect(action.status).toBe('rejected');
  });

  it('legacy suggest-mode drafts (raw content) still approve', async () => {
    // POST /api/agent/write in suggest mode stores raw file content —
    // the approve endpoint must keep handling that shape.
    const draftRes = await request(app)
      .post('/api/agent/write')
      .set(adminAuth())
      .send({ path: `gate-legacy-${randomUUID().slice(0, 8)}.txt`, content: 'legacy draft', scope: 'sandbox', mode: 'suggest' });
    expect(draftRes.status).toBe(200);

    const res = await request(app)
      .post('/api/agent/approve')
      .set(adminAuth())
      .send({ action_id: draftRes.body.action_id });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('approved');

    rmSync(join('/home/haz/ai-workspace', draftRes.body.path), { force: true });
  });

  it('approve is forbidden for another non-admin user\'s session', async () => {
    const sessionId = await createSuggestSession();
    const actionId = insertGatedAction(sessionId, 'shell_exec', { command: 'echo nope', scope: 'sandbox' });

    // A different non-admin user must not be able to approve (or trigger)
    // someone else's gated tool call.
    const res = await request(app)
      .post('/api/agent/approve')
      .set(userAuth('other-user', 'otheruser'))
      .send({ action_id: actionId });
    expect(res.status).toBe(403);

    const action = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(actionId);
    expect(action.status).toBe('pending');
  });
});

describe('sanitizeFtsQuery — shared FTS sanitizer', () => {
  it('quotes tokens so FTS5 special chars cannot break MATCH', () => {
    const q = sanitizeFtsQuery('fix the "login" bug (urgent) OR bypass:all');
    expect(q).toContain('"login"');
    expect(q).toContain('"(urgent)"');
    expect(q).toContain('"OR"');
    expect(q).toContain('"bypass:all"');
  });

  it('returns null when there are no searchable tokens', () => {
    expect(sanitizeFtsQuery('!!! ...')).toBe(null);
    expect(sanitizeFtsQuery('')).toBe(null);
    expect(sanitizeFtsQuery(null)).toBe(null);
  });
});
