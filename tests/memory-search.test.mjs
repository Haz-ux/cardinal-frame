import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Memory API', () => {
  describe('POST /api/memory — store memories', () => {
    it('should store a memory with defaults', async () => {
      const res = await request(app)
        .post('/api/memory')
        .set(adminAuth())
        .send({ content: 'User prefers concise responses' });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.category).toBe('memory');
      expect(res.body.content).toBe('User prefers concise responses');
      expect(res.body.source).toBe('manual');
      expect(res.body.confidence).toBe(1.0);
    });

    it('should store a memory with explicit category', async () => {
      const res = await request(app)
        .post('/api/memory')
        .set(adminAuth())
        .send({ content: 'Project uses React + Vite + Tailwind', category: 'project' });
      expect(res.status).toBe(201);
      expect(res.body.category).toBe('project');
    });

    it('should reject missing content', async () => {
      const res = await request(app)
        .post('/api/memory')
        .set(adminAuth())
        .send({ category: 'fact' });
      expect(res.status).toBe(400);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/memory')
        .send({ content: 'test' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/memory — list and search memories', () => {
    it('should list all memories for the user', async () => {
      // Seed some memories
      await request(app).post('/api/memory').set(adminAuth()).send({ content: 'List test memory 1' });
      await request(app).post('/api/memory').set(adminAuth()).send({ content: 'List test memory 2', category: 'project' });

      const res = await request(app)
        .get('/api/memory')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('should filter by category', async () => {
      await request(app).post('/api/memory').set(adminAuth()).send({ content: 'Category filter test', category: 'preference' });

      const res = await request(app)
        .get('/api/memory?category=preference')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      for (const m of res.body) expect(m.category).toBe('preference');
    });

    it('should search with FTS5', async () => {
      // Seed a unique memory
      await request(app).post('/api/memory').set(adminAuth()).send({ content: 'The system uses SQLite database with WAL mode' });

      const res = await request(app)
        .get('/api/memory?q=SQLite')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      const match = res.body.find(m => m.content.includes('SQLite'));
      expect(match).toBeDefined();
    });
  });

  describe('GET /api/memory/:id — get specific memory', () => {
    it('should return a memory by id', async () => {
      const createRes = await request(app)
        .post('/api/memory')
        .set(adminAuth())
        .send({ content: 'Fetch by ID test' });

      const res = await request(app)
        .get(`/api/memory/${createRes.body.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(createRes.body.id);
      expect(res.body.content).toBe('Fetch by ID test');
    });

    it('should return 404 for non-existent memory', async () => {
      const res = await request(app)
        .get('/api/memory/nonexistent-id')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/memory/:id — update memory', () => {
    it('should update memory content', async () => {
      const createRes = await request(app)
        .post('/api/memory')
        .set(adminAuth())
        .send({ content: 'Original content' });

      const res = await request(app)
        .patch(`/api/memory/${createRes.body.id}`)
        .set(adminAuth())
        .send({ content: 'Updated content', category: 'fact' });
      expect(res.status).toBe(200);
      expect(res.body.content).toBe('Updated content');
      expect(res.body.category).toBe('fact');
    });
  });

  describe('DELETE /api/memory/:id — delete memory', () => {
    it('should delete a memory', async () => {
      const createRes = await request(app)
        .post('/api/memory')
        .set(adminAuth())
        .send({ content: 'Delete me' });

      const res = await request(app)
        .delete(`/api/memory/${createRes.body.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      // Verify gone
      const getRes = await request(app)
        .get(`/api/memory/${createRes.body.id}`)
        .set(adminAuth());
      expect(getRes.status).toBe(404);
    });

    it('should return 404 for deleting non-existent memory', async () => {
      const res = await request(app)
        .delete('/api/memory/nonexistent')
        .set(adminAuth());
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/memory/stats — memory statistics', () => {
    it('should return memory counts by category', async () => {
      // Seed a few
      await request(app).post('/api/memory').set(adminAuth()).send({ content: 'Stats test 1', category: 'fact' });
      await request(app).post('/api/memory').set(adminAuth()).send({ content: 'Stats test 2', category: 'preference' });

      const res = await request(app)
        .get('/api/memory/stats')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('by_category');
      expect(typeof res.body.total).toBe('number');
      expect(typeof res.body.by_category).toBe('object');
    });
  });
});

describe('Session Search API', () => {
  describe('POST /api/search/index — index content', () => {
    it('should index a chat message', async () => {
      const res = await request(app)
        .post('/api/search/index')
        .set(adminAuth())
        .send({
          session_type: 'chat',
          ref_id: 'conv-123',
          title: 'Deploy pipeline discussion',
          content: 'We discussed the CI/CD deployment pipeline and Docker setup',
        });
      expect(res.status).toBe(201);
      expect(res.body.indexed).toBe(true);
      expect(res.body).toHaveProperty('id');
    });

    it('should index an agent session action', async () => {
      const res = await request(app)
        .post('/api/search/index')
        .set(adminAuth())
        .send({
          session_type: 'agent',
          ref_id: 'agent-456',
          title: 'Code refactoring task',
          content: 'Agent refactored the authentication module to use JWT',
        });
      expect(res.status).toBe(201);
    });

    it('should reject missing required fields', async () => {
      const res = await request(app)
        .post('/api/search/index')
        .set(adminAuth())
        .send({ session_type: 'chat' });
      expect(res.status).toBe(400);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/search/index')
        .send({ session_type: 'chat', ref_id: 'x', content: 'test' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/search — full-text search', () => {
    it('should search across indexed content', async () => {
      // Index some content
      await request(app).post('/api/search/index').set(adminAuth()).send({
        session_type: 'chat',
        ref_id: 'search-test-1',
        title: 'Database design',
        content: 'We need to design the PostgreSQL schema for the user authentication system',
      });

      const res = await request(app)
        .get('/api/search?q=PostgreSQL')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      const match = res.body.find(r => r.content && r.content.includes('PostgreSQL'));
      expect(match).toBeDefined();
    });

    it('should search for agent sessions', async () => {
      await request(app).post('/api/search/index').set(adminAuth()).send({
        session_type: 'agent',
        ref_id: 'agent-search-1',
        title: 'Bug fix task',
        content: 'Fixed the memory leak in the WebSocket handler',
      });

      const res = await request(app)
        .get('/api/search?q=WebSocket')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('should reject without query', async () => {
      const res = await request(app)
        .get('/api/search')
        .set(adminAuth());
      expect(res.status).toBe(400);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .get('/api/search?q=test');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/memory & /api/search — ?summary=true (LLM summarization)', () => {
    it('should return results with summaries array when ?summary=true on memory list', async () => {
      await request(app).post('/api/memory').set(adminAuth()).send({ content: 'Summary test memory for list endpoint' });

      const res = await request(app)
        .get('/api/memory?summary=true')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('results');
      expect(res.body).toHaveProperty('summaries');
      expect(Array.isArray(res.body.results)).toBe(true);
      expect(Array.isArray(res.body.summaries)).toBe(true);
      // Without an LLM provider configured in test env, summaries degrade to empty array
      expect(res.body.summaries.length).toBe(0);
    });

    it('should return results (not {results,summaries}) when ?summary is not set', async () => {
      const res = await request(app)
        .get('/api/memory')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.results).toBeUndefined();
    });

    it('should return memory with summary field when ?summary=true on single memory', async () => {
      const createRes = await request(app)
        .post('/api/memory')
        .set(adminAuth())
        .send({ content: 'Summary test for single memory endpoint' });

      const res = await request(app)
        .get(`/api/memory/${createRes.body.id}?summary=true`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(createRes.body.id);
      expect(res.body).toHaveProperty('summary');
      // Without LLM provider, summary is null (graceful degradation)
      expect(res.body.summary).toBeNull();
    });

    it('should return single memory without summary field when ?summary not set', async () => {
      const createRes = await request(app)
        .post('/api/memory')
        .set(adminAuth())
        .send({ content: 'No summary requested test' });

      const res = await request(app)
        .get(`/api/memory/${createRes.body.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.summary).toBeUndefined();
    });

    it('should return search results with summaries when ?summary=true', async () => {
      await request(app).post('/api/search/index').set(adminAuth()).send({
        session_type: 'chat',
        ref_id: 'summary-search-test-1',
        title: 'Summary search test',
        content: 'Testing the summary feature on the search endpoint with LLM',
      });

      const res = await request(app)
        .get('/api/search?q=Summary&summary=true')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('results');
      expect(res.body).toHaveProperty('summaries');
      expect(Array.isArray(res.body.summaries)).toBe(true);
    });

    it('should handle ?summary=true with empty search results gracefully', async () => {
      const res = await request(app)
        .get('/api/search?q=ZZNONEXISTENTZZ&summary=true')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('results');
      expect(res.body.results.length).toBe(0);
    });
  });
});
