import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';
import { PERSONAS, DEFAULT_PERSONA, getPersona, listPersonas, applyPersona } from '../src/server/personas.mjs';

vi.mock('../src/server/llm/provider-runtime.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    detectOllama: vi.fn(async () => ({
      connected: false,
      version: '0.5.1',
      modelCount: 0,
      models: [],
    })),
  };
});

const enc = new TextEncoder();

const fetchMock = vi.fn(async (url, opts) => {
  const u = String(url);
  let body;
  try { body = JSON.parse(opts?.body || '{}'); } catch {}
  if (u.includes('/api/tags')) {
    return { ok: true, status: 200, json: async () => ({ models: [] }) };
  }
  if (u.includes('/models')) {
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o' }] }) };
  }
  if (u.includes('/chat/completions')) {
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' } }] })}\n\n`));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
    };
  }
  throw new Error(`unexpected fetch: ${u}`);
});

let app;
let db;

beforeAll(async () => {
  global.fetch = fetchMock;
  const test = await getTestServer();
  app = test.app;
  db = test.db;

  await request(app)
    .post('/api/llm/providers')
    .set(adminAuth())
    .send({
      name: 'NVIDIA',
      type: 'openai',
      api_key: 'nvapi-secret-key-1234567890',
      base_url: 'https://integrate.api.nvidia.com/v1',
    });
  const list = await request(app).get('/api/llm/providers').set(adminAuth());
  const nvidia = list.body.find((p) => p.name === 'NVIDIA');
  await request(app)
    .post(`/api/llm/providers/${nvidia.id}/detect`)
    .set(adminAuth());
});

afterAll(async () => {
  await cleanupTestServer(app, db);
  delete global.fetch;
});

describe('personas module', () => {
  it('has a default persona', () => {
    expect(DEFAULT_PERSONA).toBe('aimi');
    expect(PERSONAS[DEFAULT_PERSONA]).toBeDefined();
  });

  it('getPersona returns the requested persona or the default', () => {
    expect(getPersona('cipher').name).toBe('Cipher');
    expect(getPersona('does-not-exist').name).toBe(PERSONAS[DEFAULT_PERSONA].name);
  });

  it('listPersonas returns public metadata only', () => {
    const list = listPersonas();
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const p of list) {
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('tagline');
      expect(p).toHaveProperty('color');
      expect(p).not.toHaveProperty('systemPrompt');
    }
  });

  it('applyPersona prepends a system prompt, replacing any existing system message', () => {
    const messages = [{ role: 'system', content: 'old system' }, { role: 'user', content: 'hello' }];
    const { messages: out, persona } = applyPersona(messages, 'cipher');
    expect(persona.name).toBe('Cipher');
    const systemMsgs = out.filter(m => m.role === 'system');
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain('TEST persona');
    expect(out[0]).toEqual({ role: 'system', content: persona.systemPrompt });
    expect(out[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('applyPersona passes messages through untouched when no persona id given', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const { messages: out, persona } = applyPersona(messages, null);
    expect(persona).toBeNull();
    expect(out).toEqual(messages);
  });
});

describe('persona API', () => {
  it('GET /api/personas lists personas', async () => {
    const res = await request(app).get('/api/personas');
    expect(res.status).toBe(200);
    expect(res.body.default).toBe('aimi');
    expect(res.body.personas.map(p => p.id)).toContain('cipher');
  });

  it('POST /api/chat/completions injects the persona system prompt into the LLM payload', async () => {
    fetchMock.mockClear();
    const res = await request(app)
      .post('/api/chat/completions')
      .set(adminAuth())
      .send({ messages: [{ role: 'user', content: 'who are you?' }], persona: 'cipher', model: 'gpt-4o', stream: true });
    expect(res.status).toBe(200);
    const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/chat/completions'));
    expect(call).toBeTruthy();
    const sent = JSON.parse(call[1].body);
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toContain('TEST persona');
    expect(sent.messages).toHaveLength(2);
  });

  it('POST /api/chat/completions without persona keeps messages raw', async () => {
    fetchMock.mockClear();
    const res = await request(app)
      .post('/api/chat/completions')
      .set(adminAuth())
      .send({ messages: [{ role: 'user', content: 'hi' }], model: 'gpt-4o', stream: true });
    expect(res.status).toBe(200);
    const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/chat/completions'));
    const sent = JSON.parse(call[1].body);
    expect(sent.messages[0].role).toBe('user');
    expect(sent.messages).toHaveLength(1);
  });
});
