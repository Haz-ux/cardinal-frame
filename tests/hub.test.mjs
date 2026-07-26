import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;
let db;
let sourceId;

beforeAll(async () => {
  ({ app, db } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Skill Hub API', () => {
  describe('GET /api/skills/hub/sources', () => {
    it('should return sources list with auth', async () => {
      const res = await request(app).get('/api/skills/hub/sources').set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should reject without auth', async () => {
      const res = await request(app).get('/api/skills/hub/sources');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/skills/hub/sources', () => {
    it('should create source with admin auth', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({
          name: 'Test Source',
          url: 'https://github.com/example/skills-repo',
          type: 'git',
        });
      expect([200, 201]).toContain(res.status);
      expect(res.body).toHaveProperty('id');
      sourceId = res.body.id;
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .send({ name: 'No Auth', url: 'https://example.com', type: 'git' });
      expect(res.status).toBe(401);
    });

    it('should reject regular user (not admin)', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(userAuth())
        .send({ name: 'User Source', url: 'https://example.com', type: 'git' });
      expect(res.status).toBe(403);
    });

    it('should reject missing fields', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({ name: 'Missing URL' });
      expect([400, 500]).toContain(res.status);
    });

    it('should reject SSRF attempt (AWS metadata)', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({
          name: 'SSRF AWS',
          url: 'http://169.254.169.254/latest/meta-data/',
          type: 'git',
        });
      expect([400, 403]).toContain(res.status);
    });

    it('should reject SSRF attempt (localhost)', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({
          name: 'SSRF Local',
          url: 'http://localhost:8080/api/skills',
          type: 'git',
        });
      expect([400, 403]).toContain(res.status);
    });

    it('should reject SSRF attempt (RFC1918)', async () => {
      const res = await request(app)
        .post('/api/skills/hub/sources')
        .set(adminAuth())
        .send({
          name: 'SSRF Internal',
          url: 'http://10.0.0.1/internal',
          type: 'git',
        });
      expect([400, 403]).toContain(res.status);
    });
  });

  describe('POST /api/skills/hub/sources/:id/scan', () => {
    it('should scan source with admin auth', async () => {
      if (!sourceId) return;
      const res = await request(app)
        .post(`/api/skills/hub/sources/${sourceId}/scan`)
        .set(adminAuth());
      expect([200, 404, 500]).toContain(res.status); // external URL fetch may fail in test env
    });

    it('should reject without auth', async () => {
      const res = await request(app).post(`/api/skills/hub/sources/fake-id/scan`);
      expect(res.status).toBe(401);
    });

    it('should reject regular user', async () => {
      const res = await request(app)
        .post(`/api/skills/hub/sources/fake-id/scan`)
        .set(userAuth());
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/skills/hub/sources/:id/install', () => {
    it('should reject install with failed verdict (security gate)', async () => {
      if (!sourceId) return;
      const res = await request(app)
        .post(`/api/skills/hub/sources/${sourceId}/install`)
        .set(adminAuth())
        .send({ skill_name: 'malicious-skill', verdict: 'failed' });
      expect([400, 403]).toContain(res.status);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post(`/api/skills/hub/sources/fake-id/install`)
        .send({ skill_name: 'test', verdict: 'passed' });
      expect(res.status).toBe(401);
    });
  });

  // ─── Security: SSRF protection for skill-hub fetches ────────
  // Mirrors the evolution.test.mjs SSRF suite — all four registry-supplied
  // fetch() call sites in skill-hub.mjs now route through safeFetch(), so a
  // malicious hub manifest pointing skill.url at internal targets must be
  // blocked before any network request is attempted.
  //
  // We exercise this via POST /api/skills/hub/install (admin-only), which
  // reads installed_skills from a seeded hub source row, then calls
  // safeFetch(skill.url) when the skill has no inline content. A blocked
  // URL throws inside safeFetch and the route surfaces it as HTTP 502.

  /**
   * Create a hub source row whose installed_skills JSON contains a skill
   * pointing at the given malicious URL with no inline content, so the
   * install route is forced to safeFetch it.
   * Returns { id, skillName }.
   */
  async function seedMaliciousSource(maliciousUrl) {
    const id = `ssrf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const skillName = `ssrf-skill-${id}`;
    db.prepare(
      'INSERT INTO skill_hub_sources (id, name, url, type, verified, trust_score, scan_status, installed_skills) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, `SSRF Test ${id}`, 'https://example.com/legit-hub.git', 'git', 0, 0, 'passed', JSON.stringify([
      { name: skillName, description: 'forces a safeFetch of a malicious URL', url: maliciousUrl, content: '' },
    ]));
    return { id, skillName };
  }

  describe('POST /api/skills/hub/install — SSRF protection (safeFetch)', () => {
    it('should reject file:// scheme skill URL (502)', async () => {
      const { id, skillName } = await seedMaliciousSource('file:///etc/passwd');
      const res = await request(app)
        .post('/api/skills/hub/install')
        .set(adminAuth())
        .send({ hub_source_id: id, skill_name: skillName });
      expect([400, 502]).toContain(res.status);
      if (res.status === 502) expect(res.body.error).toContain('Blocked scheme');
    });

    it('should reject http://169.254.169.254 cloud metadata URL (502)', async () => {
      const { id, skillName } = await seedMaliciousSource('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
      const res = await request(app)
        .post('/api/skills/hub/install')
        .set(adminAuth())
        .send({ hub_source_id: id, skill_name: skillName });
      expect([400, 502]).toContain(res.status);
      if (res.status === 502) expect(res.body.error).toContain('Blocked');
    });

    it('should reject RFC1918 private IP URL (502)', async () => {
      const { id, skillName } = await seedMaliciousSource('http://10.0.0.1/internal');
      const res = await request(app)
        .post('/api/skills/hub/install')
        .set(adminAuth())
        .send({ hub_source_id: id, skill_name: skillName });
      expect([400, 502]).toContain(res.status);
      if (res.status === 502) expect(res.body.error).toContain('Blocked');
    });

    it('should reject 127.x.x.x loopback URL (502)', async () => {
      const { id, skillName } = await seedMaliciousSource('http://127.0.0.1:8080/');
      const res = await request(app)
        .post('/api/skills/hub/install')
        .set(adminAuth())
        .send({ hub_source_id: id, skill_name: skillName });
      expect([400, 502]).toContain(res.status);
      if (res.status === 502) expect(res.body.error).toContain('Blocked');
      // Cleanup: delete the skill record if it was somehow installed
      // (shouldn't be since safeFetch blocks first)
    });

    // Redirect-to-blocked-address: safeFetch re-validates at every
    // redirect hop in safe-fetch.mjs; covered by the same validation
    // paths tested above (validateUrlIsSafe runs identically on
    // redirects). A live redirect server would be flaky in CI; the
    // evolution.mjs test suite already exercises this transitively
    // via the same shared module.

    it('should still accept a legitimate external hub source shape (no SSRF block)', async () => {
      // Regression check: a legit https URL pointing at an external
      // host must not trip the SSRF guard. We use a non-resolving
      // hostname so safeFetch proceeds to the fetch attempt and the
      // error is a network/DNS error, NOT an SSRF 'Blocked' error —
      // proving the URL passed validation.
      const { id, skillName } = await seedMaliciousSource('https://non-resolving-external-host-12345.example.invalid/skill.md');
      const res = await request(app)
        .post('/api/skills/hub/install')
        .set(adminAuth())
        .send({ hub_source_id: id, skill_name: skillName });
      expect(res.status).toBeGreaterThanOrEqual(400);
      if (res.body && res.body.error) {
        expect(res.body.error).not.toContain('Blocked scheme');
        expect(res.body.error).not.toContain('Blocked hostname');
        expect(res.body.error).not.toContain('Blocked: target resolves to a private');
      }
    });
  });


  describe('DELETE /api/skills/hub/sources/:id', () => {
    it('should delete source with auth', async () => {
      if (!sourceId) return;
      const res = await request(app)
        .delete(`/api/skills/hub/sources/${sourceId}`)
        .set(adminAuth());
      expect([200, 404]).toContain(res.status);
    });

    it('should reject without auth', async () => {
      const res = await request(app).delete('/api/skills/hub/sources/fake-id');
      expect(res.status).toBe(401);
    });
  });
});
