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

describe('Embedding Engine API', () => {
  describe('GET /api/embeddings/status', () => {
    it('should return model status', async () => {
      const res = await request(app)
        .get('/api/embeddings/status')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('loaded');
      expect(res.body).toHaveProperty('model_id');
      expect(res.body.model_id).toBe('Xenova/all-MiniLM-L6-v2');
    });

    it('should require auth', async () => {
      const res = await request(app)
        .get('/api/embeddings/status');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/embeddings/unload', () => {
    it('should unload model (no-op if not loaded)', async () => {
      const res = await request(app)
        .post('/api/embeddings/unload')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('unloaded');
      expect(res.body).toHaveProperty('status');
    });

    it('should require admin role', async () => {
      const res = await request(app)
        .post('/api/embeddings/unload')
        .set(userAuth());
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/embeddings/generate', () => {
    it('should reject without text', async () => {
      const res = await request(app)
        .post('/api/embeddings/generate')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });

    it('should require auth', async () => {
      const res = await request(app)
        .post('/api/embeddings/generate')
        .send({ text: 'hello' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/embeddings/similarity', () => {
    it('should reject without text1/text2', async () => {
      const res = await request(app)
        .post('/api/embeddings/similarity')
        .set(adminAuth())
        .send({ text1: 'hello' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/embeddings/search', () => {
    it('should reject without query', async () => {
      const res = await request(app)
        .post('/api/embeddings/search')
        .set(adminAuth())
        .send({ corpus: ['hello'] });
      expect(res.status).toBe(400);
    });

    it('should reject without corpus', async () => {
      const res = await request(app)
        .post('/api/embeddings/search')
        .set(adminAuth())
        .send({ query: 'hello' });
      expect(res.status).toBe(400);
    });

    it('should reject with non-array corpus', async () => {
      const res = await request(app)
        .post('/api/embeddings/search')
        .set(adminAuth())
        .send({ query: 'hello', corpus: 'not-an-array' });
      expect(res.status).toBe(400);
    });

    it('should return empty results for empty corpus', async () => {
      const res = await request(app)
        .post('/api/embeddings/search')
        .set(adminAuth())
        .send({ query: 'hello', corpus: [] });
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([]);
    });
  });

  describe('POST /api/embeddings/load', () => {
    it('should require admin role', async () => {
      const res = await request(app)
        .post('/api/embeddings/load')
        .set(userAuth());
      expect(res.status).toBe(403);
    });
  });
});

// ── Pure function tests (no model download needed) ──
describe('Embedding utility functions', () => {
  it('cosineSimilarity should return 1 for identical vectors', async () => {
    const { cosineSimilarity } = await import('../src/server/embeddings.mjs');
    const v = [1, 0, 0, 1];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('cosineSimilarity should return 0 for orthogonal vectors', async () => {
    const { cosineSimilarity } = await import('../src/server/embeddings.mjs');
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('cosineSimilarity should return 0 for mismatched lengths', async () => {
    const { cosineSimilarity } = await import('../src/server/embeddings.mjs');
    expect(cosineSimilarity([1, 0], [1, 0, 1])).toBe(0);
  });

  it('cosineSimilarity should return 0 for null inputs', async () => {
    const { cosineSimilarity } = await import('../src/server/embeddings.mjs');
    expect(cosineSimilarity(null, null)).toBe(0);
  });

  it('searchSimilar should sort by similarity descending', async () => {
    const { searchSimilar } = await import('../src/server/embeddings.mjs');
    const query = [1, 0];
    const corpus = [
      [0.9, 0.1],  // high similarity
      [0.1, 0.9],  // low similarity
      [0.8, 0.2],  // medium similarity
    ];
    const results = searchSimilar(query, corpus, 2);
    expect(results).toHaveLength(2);
    expect(results[0].index).toBe(0); // most similar
    expect(results[1].index).toBe(2); // second most
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });

  it('isModelLoaded should return boolean', async () => {
    const { isModelLoaded } = await import('../src/server/embeddings.mjs');
    expect(typeof isModelLoaded()).toBe('boolean');
  });

  it('getEmbeddingStatus should return status object', async () => {
    const { getEmbeddingStatus } = await import('../src/server/embeddings.mjs');
    const status = getEmbeddingStatus();
    expect(status).toHaveProperty('loaded');
    expect(status).toHaveProperty('loading');
    expect(status).toHaveProperty('model_id');
    expect(status.model_id).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('unloadEmbeddingModel should return false when not loaded', async () => {
    const { unloadEmbeddingModel } = await import('../src/server/embeddings.mjs');
    // Model shouldn't be loaded in test env
    expect(unloadEmbeddingModel()).toBe(false);
  });

  it('embedBatch should return empty array for empty input', async () => {
    const { embedBatch } = await import('../src/server/embeddings.mjs');
    const result = await embedBatch([]);
    expect(result).toEqual([]);
  });
});
