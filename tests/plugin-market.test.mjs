import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { rmSync } from 'fs';
import { join } from 'path';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

const TEST_PLUGIN = 'mktestplugin';

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// Mock safe-fetch so marketplace scans + installs run without network.
vi.mock('../src/server/safe-fetch.mjs', () => ({
  safeFetch: vi.fn(async (url) => {
    const u = String(url);
    const name = (u.match(/\/([^/]+)\/(?:manifest\.json|index\.mjs|plugins-index\.json)$/) || [])[1] || TEST_PLUGIN;
    if (u.endsWith('manifest.json')) {
      return mockResponse({
        name: u.includes('bad-manifest') ? 42 : (u.includes('bad-name') ? 'bad name!' : name),
        version: '1.2.3',
        description: 'Test plugin from marketplace',
        hooks: ['onTaskCompleted'],
      });
    }
    if (u.endsWith('index.mjs')) {
      return mockResponse('export function onTaskCompleted(data){ console.log("test"); }');
    }
    if (u.endsWith('plugins-index.json')) {
      return mockResponse({
        plugins: [
          { name: TEST_PLUGIN, version: '1.2.3', description: 'Test plugin', url: `https://registry.example.com/plugins/${TEST_PLUGIN}`, hooks: ['onTaskCompleted'] },
        ],
      });
    }
    return mockResponse({ error: 'not found' }, 404);
  }),
}));

let app;
let db;
let sourceId;

beforeAll(async () => {
  ({ app, db } = await getTestServer());
});

afterAll(async () => {
  // Clean up anything the marketplace test installed on disk
  try { rmSync(join('/home/cardinal-frame', 'plugins', TEST_PLUGIN), { recursive: true, force: true }); } catch {}
  try {
    db.prepare('DELETE FROM plugins WHERE name = ?').run(TEST_PLUGIN);
  } catch {}
  cleanupTestServer();
});

describe('Plugin Marketplace API', () => {
  describe('GET /api/plugins/market/sources', () => {
    it('should return sources list with auth', async () => {
      const res = await request(app).get('/api/plugins/market/sources').set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should reject without auth', async () => {
      const res = await request(app).get('/api/plugins/market/sources');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/plugins/market/sources', () => {
    it('should create source with admin auth', async () => {
      const res = await request(app)
        .post('/api/plugins/market/sources')
        .set(adminAuth())
        .send({ name: 'Test Market', url: 'https://github.com/example/plugin-repo', type: 'github' });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('id');
      sourceId = res.body.id;
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/plugins/market/sources')
        .send({ name: 'No Auth', url: 'https://example.com', type: 'github' });
      expect(res.status).toBe(401);
    });

    it('should reject regular user (not admin)', async () => {
      const res = await request(app)
        .post('/api/plugins/market/sources')
        .set(userAuth())
        .send({ name: 'User Source', url: 'https://example.com', type: 'github' });
      expect(res.status).toBe(403);
    });

    it('should reject internal/private URLs (SSRF)', async () => {
      const res = await request(app)
        .post('/api/plugins/market/sources')
        .set(adminAuth())
        .send({ name: 'Internal', url: 'http://127.0.0.1:8080/plugins-index.json', type: 'github' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/plugins/market/search', () => {
    it('should search across sources and find the scanned plugin', async () => {
      const res = await request(app)
        .get(`/api/plugins/market/search?q=${TEST_PLUGIN}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.results)).toBe(true);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].name).toBe(TEST_PLUGIN);
    });
  });

  describe('POST /api/plugins/market/install-url', () => {
    it('should install a plugin from a direct URL', async () => {
      const res = await request(app)
        .post('/api/plugins/market/install-url')
        .set(adminAuth())
        .send({ url: `https://registry.example.com/plugins/${TEST_PLUGIN}` });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.name).toBe(TEST_PLUGIN);
      expect(res.body).toHaveProperty('risk');
    });

    it('should reject internal/private URLs (SSRF)', async () => {
      const res = await request(app)
        .post('/api/plugins/market/install-url')
        .set(adminAuth())
        .send({ url: 'http://localhost:8080/plugins/test/manifest.json' });
      expect(res.status).toBe(403);
    });

    it('should reject missing url', async () => {
      const res = await request(app)
        .post('/api/plugins/market/install-url')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });

    it('should reject invalid manifest name', async () => {
      const res = await request(app)
        .post('/api/plugins/market/install-url')
        .set(adminAuth())
        .send({ url: 'https://registry.example.com/plugins/bad-name' });
      expect(res.status).toBe(400);
    });

    it('should reject if plugin already installed', async () => {
      const res = await request(app)
        .post('/api/plugins/market/install-url')
        .set(adminAuth())
        .send({ url: `https://registry.example.com/plugins/${TEST_PLUGIN}` });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/plugins/market/install (from source)', () => {
    it('should reject without a valid source', async () => {
      const res = await request(app)
        .post('/api/plugins/market/install')
        .set(adminAuth())
        .send({ source_id: 'missing', plugin_name: TEST_PLUGIN });
      expect(res.status).toBe(404);
    });

    it('should reject regular user (not admin)', async () => {
      const res = await request(app)
        .post('/api/plugins/market/install')
        .set(userAuth())
        .send({ source_id: sourceId, plugin_name: TEST_PLUGIN });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/plugins/market/sources/:id', () => {
    it('should delete a market source', async () => {
      const res = await request(app)
        .delete(`/api/plugins/market/sources/${sourceId}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('ok', true);
    });
  });
});
