import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';

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

const fetchMock = vi.fn(async (url) => {
  const u = String(url);
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
  ({ app, db } = await getTestServer());
  vi.stubGlobal('fetch', fetchMock);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

afterAll(() => {
  vi.unstubAllGlobals();
  cleanupTestServer();
});

function detectCalls() {
  return fetchMock.mock.calls.filter(([u]) => String(u).includes('/models')).length;
}

describe('Aimi chat falls back to a keyed provider with no detected models', () => {
  it('boot starts with no providers or models when Ollama is unreachable', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_models').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_providers').get().n).toBe(0);
  });

  it('creates a keyed provider without detecting models', async () => {
    const res = await request(app)
      .post('/api/llm/providers')
      .set(adminAuth())
      .send({
        name: 'NVIDIA',
        type: 'openai',
        api_key: 'nvapi-secret-key-1234567890',
        base_url: 'https://integrate.api.nvidia.com/v1',
      });
    expect(res.status).toBe(201);

    const list = await request(app).get('/api/llm/providers').set(adminAuth());
    expect(list.body.find((p) => p.name === 'NVIDIA').has_key).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM llm_models').get().n).toBe(0);
  });

  it('aimi/chat auto-detects models and replies instead of "No LLM provider configured"', async () => {
    const res = await request(app)
      .post('/api/aimi/chat')
      .set(adminAuth())
      .send({ message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('pong');
    expect(res.text).not.toContain('No LLM provider');

    const provider = db.prepare("SELECT id FROM llm_providers WHERE name = 'NVIDIA'").get();
    const models = db.prepare('SELECT model_id FROM llm_models WHERE provider_id = ?').all(provider.id);
    expect(models.map((m) => m.model_id)).toEqual(['gpt-4o']);
    expect(detectCalls()).toBe(1);
  });

  it('subsequent chats reuse the detected model without re-detecting', async () => {
    const res = await request(app)
      .post('/api/aimi/chat')
      .set(adminAuth())
      .send({ message: 'again' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('pong');
    expect(detectCalls()).toBe(1);
  });
});
