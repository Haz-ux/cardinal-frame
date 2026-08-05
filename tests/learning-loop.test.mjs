import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth } from './helpers.mjs';
import { detectIntent, buildPatternKey, reinforcePattern } from '../src/server/learn.mjs';
import { findPromotionCandidates, buildAutoSkillFromPattern } from '../src/server/learning-loop.mjs';
import { buildAimiSystemPrompt } from '../src/server/routes/aimi.mjs';

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

const INPUT = 'create automated inventory report please help';

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
  await request(app).post(`/api/llm/providers/${nvidia.id}/detect`).set(adminAuth());
});

afterAll(async () => {
  await cleanupTestServer(app, db);
  delete global.fetch;
});

describe('learning primitives', () => {
  it('detectIntent classifies recurring intents', () => {
    expect(detectIntent('please create a new task now')).toBe('create');
    expect(detectIntent('delete the old records')).toBe('delete');
    expect(detectIntent('what does the agent do')).toBe('query');
    expect(detectIntent('deploy the build to staging')).toBe('deploy-build');
    expect(detectIntent('random chit chat here')).toBe('general');
  });

  it('buildPatternKey uses the first four significant words', () => {
    expect(buildPatternKey(INPUT)).toBe('create automated inventory report');
    expect(buildPatternKey('   ')).toBe('');
  });

  it('buildAutoSkillFromPattern produces a deterministic, safe skill', () => {
    const pattern = { pattern_type: 'create', pattern_key: 'create automated inventory report', occurrence_count: 4, confidence: 0.6 };
    const auto = buildAutoSkillFromPattern(pattern, { now: 1000 });
    expect(auto.name).toMatch(/^auto-create-/);
    expect(auto.handler).toContain('create automated inventory report');
    expect(auto.parameters.pattern_key).toBe(pattern.pattern_key);
  });

  it('findPromotionCandidates filters immature or already-promoted patterns', () => {
    const stmts = { patterns: { getAll: { all: () => [
      { pattern_key: 'a', auto_skill_id: null, occurrence_count: 5, confidence: 0.7 },
      { pattern_key: 'b', auto_skill_id: null, occurrence_count: 2, confidence: 0.8 }, // too few
      { pattern_key: 'c', auto_skill_id: 'skill-1', occurrence_count: 9, confidence: 0.9 }, // promoted
      { pattern_key: 'd', auto_skill_id: null, occurrence_count: 4, confidence: 0.5 }, // low conf
    ] } } };
    const results = findPromotionCandidates(stmts);
    expect(results.map(p => p.pattern_key)).toEqual(['a']);
  });
});

describe('learning loop integration', () => {
  it('recurring observations grow a pattern toward the promotion threshold', async () => {
    for (let i = 0; i < 7; i++) {
      const res = await request(app)
        .post('/api/learn/observe')
        .set(adminAuth())
        .send({ user_input: INPUT, assistant_output: 'done', intent: 'create' });
      expect(res.status).toBe(201);
    }
    const patterns = await request(app).get('/api/learn/patterns').set(adminAuth());
    const match = patterns.body.find(p => p.pattern_key === 'create automated inventory report');
    expect(match).toBeTruthy();
    expect(match.occurrence_count).toBe(7);
    expect(match.confidence).toBeCloseTo(0.6, 5);
  });

  it('/learn/run-loop promotes the mature pattern into an auto-learned skill and links them', async () => {
    const res = await request(app).post('/api/learn/run-loop').set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(true);

    const pattern = db.prepare("SELECT * FROM learn_patterns WHERE pattern_key = 'create automated inventory report'").get();
    expect(pattern.auto_skill_id).toBeTruthy();
    expect(pattern.auto_skill_id).toBe(res.body.id);

    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(res.body.id);
    expect(skill).toBeTruthy();
    expect(skill.auto_proposed).toBe(1);
    expect(skill.enabled).toBe(0);
    expect(skill.name).toBe(res.body.name);
  });

  it('a second pass promotes nothing (already linked)', async () => {
    const res = await request(app).post('/api/learn/run-loop').set(adminAuth());
    expect(res.body.promoted).toBe(false);
  });

  it('successful feedback reinforces the source pattern confidence', async () => {
    const patternBefore = db.prepare("SELECT * FROM learn_patterns WHERE pattern_key = 'create automated inventory report'").get();
    const res = await request(app)
      .post(`/api/skills/${patternBefore.auto_skill_id}/feedback`)
      .set(adminAuth())
      .send({ success: true });
    expect(res.status).toBe(200);
    const patternAfter = db.prepare("SELECT * FROM learn_patterns WHERE pattern_key = 'create automated inventory report'").get();
    expect(patternAfter.confidence).toBeCloseTo(patternBefore.confidence + 0.05, 5);
  });

  it('the Chat proxy auto-observes every exchange', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM learn_observations').get().n;
    await request(app)
      .post('/api/chat/completions')
      .set(adminAuth())
      .send({ messages: [{ role: 'user', content: 'search the documentation for auth' }], model: 'gpt-4o', stream: true });
    const after = db.prepare('SELECT COUNT(*) AS n FROM learn_observations').get().n;
    expect(after).toBe(before + 1);
  });

  it('the Aimi companion auto-observes too', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM learn_observations').get().n;
    const res = await request(app)
      .post('/api/aimi/chat')
      .set(adminAuth())
      .send({ message: 'monitor the system status please' });
    expect(res.status).toBe(200);
    const after = db.prepare('SELECT COUNT(*) AS n FROM learn_observations').get().n;
    expect(after).toBe(before + 1);
    const aimiObs = db.prepare("SELECT * FROM learn_observations WHERE user_input = 'monitor the system status please'").get();
    expect(aimiObs).toBeTruthy();
    expect(aimiObs.intent).toBe('monitor');
  });

  it('Aimi system prompt surfaces what it learned', () => {
    const stmts = {
      agents: { getAll: { all: () => [] } },
      tasks: { getAll: { all: () => [] } },
      providers: { getAll: { all: () => [] } },
      tools: { getEnabled: { all: () => [] } },
      schedules: { getAll: { all: () => [] } },
      patterns: { getAll: { all: () => [{ pattern_key: 'create automated inventory report', pattern_type: 'create', occurrence_count: 7, confidence: 0.65 }] } },
      skills: { getAutoProposed: { all: () => [{ name: 'auto-create-x', description: 'desc', success_count: 1 }] } },
    };
    const prompt = buildAimiSystemPrompt(stmts, 'user-1');
    expect(prompt).toContain('## What You\'ve Learned');
    expect(prompt).toContain('create automated inventory report');
    expect(prompt).toContain('auto-create-x');
  });

  it('reinforcePattern is a no-op when no pattern links the skill', () => {
    const stmts = {
      patterns: {
        getByAutoSkill: { get: () => undefined },
        updateConfidence: { run: () => { throw new Error('should not be called'); } },
      },
    };
    expect(() => reinforcePattern(stmts, 'no-link', true)).not.toThrow();
  });
});
