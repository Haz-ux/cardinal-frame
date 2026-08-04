import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';

vi.mock('../src/server/llm/provider-runtime.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    detectOllama: vi.fn(async () => ({
      connected: true,
      version: '0.5.1',
      modelCount: 2,
      models: ['llama3:latest', 'mistral:latest'],
    })),
  };
});

const fetchMock = vi.fn(async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/api/tags')) {
    return { ok: true, status: 200, json: async () => ({ models: [{ name: 'llama3:latest' }, { name: 'mistral:latest' }] }) };
  }
  if (u.includes('/models')) {
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }) };
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

function modelsForProvider(providerId) {
  return db.prepare('SELECT model_id, display_name, is_default FROM llm_models WHERE provider_id = ?').all(providerId);
}

describe('LLM model auto-detection regression', () => {
  it('boot auto-detect registers the Ollama provider and its models in llm_models', () => {
    const provider = db.prepare("SELECT id, name, base_url FROM llm_providers WHERE type = 'ollama'").get();
    expect(provider).toBeTruthy();
    expect(provider.base_url).toBe('http://localhost:11434');

    const models = modelsForProvider(provider.id);
    expect(models.map((m) => m.model_id).sort()).toEqual(['llama3:latest', 'mistral:latest']);
    expect(models.find((m) => m.model_id === 'llama3:latest').display_name).toBe('llama3');
  });

  it('manual /api/ollama/detect does not duplicate models', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM llm_models').get().n;
    const res = await request(app).post('/api/ollama/detect').set(adminAuth()).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.models).toContain('llama3:latest');
    const after = db.prepare('SELECT COUNT(*) AS n FROM llm_models').get().n;
    expect(after).toBe(before);
  });

  it('exposes detected models via GET /api/llm/models', async () => {
    const res = await request(app).get('/api/llm/models').set(adminAuth());
    expect(res.status).toBe(200);
    const models = res.body.filter((m) => m.provider_name === 'Ollama (Local)');
    expect(models.length).toBe(2);
  });

  it('setup wizard detects models for keyed providers, sends auth, and sets a default', async () => {
    const res = await request(app)
      .post('/api/llm/providers/setup')
      .set(adminAuth())
      .send({ type: 'openai', name: 'Test OpenAI', api_key: 'sk-test-123' });

    expect(res.status).toBe(200);
    expect(res.body.steps.find((s) => s.step === 'test').status).toBe('passed');
    expect(res.body.steps.find((s) => s.step === 'enable').status).toBe('passed');
    expect(res.body.steps.find((s) => s.step === 'detect_models').status).toBe('passed');
    expect(res.body.steps.find((s) => s.step === 'detect_models').models_added).toBe(2);
    expect(res.body.steps.find((s) => s.step === 'set_default').status).toBe('passed');

    const provider = db.prepare("SELECT id FROM llm_providers WHERE name = 'Test OpenAI'").get();
    const models = modelsForProvider(provider.id);
    expect(models.map((m) => m.model_id).sort()).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(models.filter((m) => m.is_default === 1)).toHaveLength(1);

    const modelFetches = fetchMock.mock.calls.filter(([url, opts]) => String(url).includes('/models'));
    for (const [, opts] of modelFetches) {
      expect(opts.headers.Authorization).toBe('Bearer sk-test-123');
    }
  });

  it('per-provider detect upserts models without duplicating or clearing the default', async () => {
    const provider = db.prepare("SELECT id FROM llm_providers WHERE name = 'Test OpenAI'").get();
    const before = modelsForProvider(provider.id);
    expect(before.length).toBe(2);

    const res = await request(app).post(`/api/llm/providers/${provider.id}/detect`).set(adminAuth()).expect(200);
    expect(res.body.detected).toBe(2);

    const after = modelsForProvider(provider.id);
    expect(after.length).toBe(2);
    expect(after.filter((m) => m.is_default === 1)).toHaveLength(1);
  });

  it('detect-all covers keyed providers and local Ollama without a loopback call', async () => {
    const res = await request(app).post('/api/llm/detect-all').set(adminAuth()).expect(200);
    expect(res.body.results.length).toBeGreaterThanOrEqual(2);
    const statuses = Object.fromEntries(res.body.results.map((r) => [r.provider, r.status]));
    expect(statuses['Ollama (Local)']).toBe('ok');
    expect(statuses['Test OpenAI']).toBe('ok');

    const ollama = db.prepare("SELECT id FROM llm_providers WHERE type = 'ollama'").get();
    expect(modelsForProvider(ollama.id)).toHaveLength(2);

    const loopback = fetchMock.mock.calls.some(([url]) => String(url).includes('localhost:0') || String(url).includes('/api/llm/providers/'));
    expect(loopback).toBe(false);
  });
});
