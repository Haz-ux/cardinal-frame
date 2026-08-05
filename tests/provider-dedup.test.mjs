import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';

let app;
let db;

beforeAll(async () => {
  ({ app, db } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Duplicate LLM providers', () => {
  it('POST /llm/providers rejects a second provider with same type + base_url', async () => {
    const first = await request(app)
      .post('/api/llm/providers')
      .set(adminAuth())
      .send({ name: 'Nvidia', type: 'nvidia', api_key: 'nvapi-test', base_url: 'https://integrate.api.nvidia.com/v1' });
    expect(first.status).toBe(201);

    const dup = await request(app)
      .post('/api/llm/providers')
      .set(adminAuth())
      .send({ name: 'NVIDIA NIM', type: 'nvidia', base_url: 'https://integrate.api.nvidia.com/v1' });
    expect(dup.status).toBe(409);

    const nvidia = db.prepare("SELECT COUNT(*) n FROM llm_providers WHERE type = 'nvidia'").get();
    expect(nvidia.n).toBe(1);
  });

  it('POST /llm/seed does not create a duplicate when a same-type provider already exists', async () => {
    const existing = db.prepare("SELECT COUNT(*) n FROM llm_providers WHERE type = 'openai'").get();
    if (existing.n === 0) {
      await request(app).post('/api/llm/providers').set(adminAuth()).send({ name: 'OpenAI', type: 'openai' });
    }
    const seeded = await request(app).post('/api/llm/seed').set(adminAuth());
    expect(seeded.status).toBe(200);
    // OpenAI (already present) must not be re-created; only absent types get seeded
    const openai = db.prepare("SELECT COUNT(*) n FROM llm_providers WHERE type = 'openai'").get();
    expect(openai.n).toBe(1);
    // No two providers may share a (type, base_url)
    const dups = db.prepare(`
      SELECT type, base_url, COUNT(*) n FROM llm_providers
      WHERE base_url IS NOT NULL AND base_url != ''
      GROUP BY type, base_url HAVING COUNT(*) > 1
    `).all();
    expect(dups).toHaveLength(0);
  });

  it('POST /llm/providers/setup returns 409 for a duplicate provider', async () => {
    await request(app)
      .post('/api/llm/providers')
      .set(adminAuth())
      .send({ name: 'Groq', type: 'groq', api_key: 'x', base_url: 'https://api.groq.com/openai/v1' });
    const res = await request(app)
      .post('/api/llm/providers/setup')
      .set(adminAuth())
      .send({ type: 'groq', name: 'Another Groq', api_key: 'x' });
    expect(res.status).toBe(409);
  });
});

describe('mergeDuplicateProviders', () => {
  it('merges duplicate providers by (type, base_url) and re-homes models + usage', async () => {
    const { mergeDuplicateProviders } = await import('../src/server/server.mjs');

    // Clean slate: create two nvidia providers with the same base URL
    db.prepare("DELETE FROM llm_providers WHERE type = 'nvidia'").run();
    db.prepare("DELETE FROM llm_models WHERE provider_id LIKE '%nvidia%' OR provider_id IN (SELECT id FROM llm_providers WHERE type='nvidia')").run();
    const p1 = 'keep-provider-1';
    const p2 = 'dup-provider-2';
    db.prepare('INSERT INTO llm_providers (id, name, type, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)').run(p1, 'Nvidia', 'nvidia', 'k1', 'https://integrate.api.nvidia.com/v1', 1);
    db.prepare('INSERT INTO llm_providers (id, name, type, api_key, base_url, enabled) VALUES (?, ?, ?, ?, ?, ?)').run(p2, 'NVIDIA NIM', 'nvidia', 'k1', 'https://integrate.api.nvidia.com/v1', 1);

    // Both have the same model; p1 owns the default
    db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name, is_default) VALUES (?, ?, ?, ?, ?)').run(`${p1}:m1`, p1, 'm1', 'm1', 1);
    db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name, is_default) VALUES (?, ?, ?, ?, ?)').run(`${p2}:m1`, p2, 'm1', 'm1', 0);
    // p2 also has a unique model
    db.prepare('INSERT INTO llm_models (id, provider_id, model_id, display_name, is_default) VALUES (?, ?, ?, ?, ?)').run(`${p2}:m2`, p2, 'm2', 'm2', 0);
    // usage on p2
    db.prepare('INSERT INTO token_usage (model, provider_id, prompt_tokens, completion_tokens, category) VALUES (?, ?, ?, ?, ?)').run('m1', p2, 10, 20, 'inference');

    mergeDuplicateProviders(db, { info: () => {}, warn: () => {} });

    const providers = db.prepare("SELECT id FROM llm_providers WHERE type = 'nvidia'").all();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe(p1);

    // p2's duplicate model dropped, unique model repointed to keeper
    const models = db.prepare('SELECT id, provider_id, model_id, is_default FROM llm_models ORDER BY model_id').all();
    expect(models).toHaveLength(2);
    expect(models.find(m => m.model_id === 'm1')).toMatchObject({ provider_id: p1, is_default: 1 });
    expect(models.find(m => m.model_id === 'm2')).toMatchObject({ provider_id: p1, id: `${p1}:m2` });

    // usage repointed
    const usage = db.prepare('SELECT provider_id FROM token_usage WHERE model = ?').all('m1');
    expect(usage).toHaveLength(1);
    expect(usage[0].provider_id).toBe(p1);
  });
});
