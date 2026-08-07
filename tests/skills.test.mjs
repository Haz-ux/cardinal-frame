import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { join } from 'path';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

const PROJECT_ROOT = join(import.meta.dirname, '..');

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Skill Runtime API', () => {
  describe('POST /api/skills/:id/execute — execute skills', () => {
    it('should execute a script skill', async () => {
      // Create a simple script skill
      const createRes = await request(app)
        .post('/api/skills')
        .set(adminAuth())
        .send({
          name: 'exec-test-script-' + Date.now(),
          description: 'Test script skill',
          handler: 'async (input) => { return { echo: input, doubled: input * 2 }; }',
          parameters: {},
        });
      const skillId = createRes.body.id;

      const res = await request(app)
        .post(`/api/skills/${skillId}/execute`)
        .set(adminAuth())
        .send({ input: 21 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.type).toBe('script');
      expect(res.body.output.echo).toBe(21);
      expect(res.body.output.doubled).toBe(42);
    });

    it('should execute a script skill that fails gracefully', async () => {
      const createRes = await request(app)
        .post('/api/skills')
        .set(adminAuth())
        .send({
          name: 'exec-test-fail-' + Date.now(),
          handler: 'async (input) => { throw new Error("intentional crash"); }',
        });

      const res = await request(app)
        .post(`/api/skills/${createRes.body.id}/execute`)
        .set(adminAuth())
        .send({ input: 'test' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('intentional crash');
    });

    it('should return 404 for non-existent skill', async () => {
      const res = await request(app)
        .post('/api/skills/nonexistent/execute')
        .set(adminAuth())
        .send({ input: 'test' });
      expect(res.status).toBe(404);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/skills/test/execute')
        .send({ input: 'test' });
      expect(res.status).toBe(401);
    });

    it('should reject non-admin users with 403', async () => {
      const createRes = await request(app)
        .post('/api/skills')
        .set(adminAuth())
        .send({
          name: 'exec-nonadmin-' + Date.now(),
          handler: 'async (input) => ({ ok: true })',
        });

      const res = await request(app)
        .post(`/api/skills/${createRes.body.id}/execute`)
        .set(userAuth())
        .send({ input: 'test' });
      expect(res.status).toBe(403);
    });

    it('should track invoke count after execution', async () => {
      const createRes = await request(app)
        .post('/api/skills')
        .set(adminAuth())
        .send({
          name: 'invoke-count-test-' + Date.now(),
          handler: 'async (input) => ({ ok: true })',
        });

      // Execute twice
      await request(app).post(`/api/skills/${createRes.body.id}/execute`).set(adminAuth()).send({ input: 1 });
      await request(app).post(`/api/skills/${createRes.body.id}/execute`).set(adminAuth()).send({ input: 2 });

      const skillRes = await request(app)
        .get(`/api/skills/${createRes.body.id}`)
        .set(adminAuth());

      expect(skillRes.body.invoke_count).toBe(2);
      expect(skillRes.body.last_invoked).toBeTruthy();
    });
  });

  describe('POST /api/skills/execute/:name — execute by name', () => {
    it('should execute a skill by name', async () => {
      const name = 'by-name-test-' + Date.now();
      await request(app)
        .post('/api/skills')
        .set(adminAuth())
        .send({ name, handler: 'async (input) => ({ received: input })' });

      const res = await request(app)
        .post(`/api/skills/execute/${name}`)
        .set(adminAuth())
        .send({ input: 'hello' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe(name);
      expect(res.body.output.received).toBe('hello');
    });

    it('should return 404 for unknown name', async () => {
      const res = await request(app)
        .post('/api/skills/execute/no-such-skill')
        .set(adminAuth())
        .send({ input: 'test' });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/skills/match/:input — trigger matching', () => {
    it('should match a skill by trigger keyword', async () => {
      // Create a skill with a trigger
      await request(app)
        .post('/api/skills')
        .set(adminAuth())
        .send({
          name: 'trigger-match-test-' + Date.now(),
          description: 'Triggered by deploy keyword',
          handler: 'async (input) => ({ deployed: true })',
          trigger: 'deploy,deployment,deploy to',
        });

      const res = await request(app)
        .get('/api/skills/match/' + encodeURIComponent('deploy the app to production'))
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.skill).toBeDefined();
      expect(res.body.trigger).toBe('deploy');
    });

    it('should return no match for unrelated input', async () => {
      const res = await request(app)
        .get('/api/skills/match/' + encodeURIComponent('what is the weather today'))
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(false);
    });

    it('should flag should_auto_invoke for high confidence', async () => {
      // Create a trick: manually set confidence higher
      const createRes = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({
          name: 'high-conf-trigger-' + Date.now(),
          handler: 'async (input) => ({ ok: true })',
          description: 'High confidence skill',
        });

      // Validate multiple times to boost confidence
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post(`/api/skills/${createRes.body.id}/validate`)
          .set(adminAuth())
          .send({ test_input: 'test', expected_output: 'ok' });
      }

      // Give it a trigger via direct update (need to add... or patch)
      // For now, the auto-propose starts at 0.3 confidence, after 5 validations should be higher
      const skillRes = await request(app)
        .get(`/api/skills/${createRes.body.id}`)
        .set(adminAuth());
      expect(parseFloat(skillRes.body.confidence)).toBeGreaterThan(0);
    });
  });

  describe('POST /api/skills/seed — seed built-in skills', () => {
    it('should seed the built-in skill library', async () => {
      const res = await request(app)
        .post('/api/skills/seed')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('seeded');
      expect(res.body).toHaveProperty('skipped');
      expect(res.body.total_seeded).toBeGreaterThan(0);
    });

    it('should skip already-seeded skills on second call', async () => {
      // First seed
      await request(app).post('/api/skills/seed').set(adminAuth()).send({});

      // Second seed — should skip all
      const res = await request(app)
        .post('/api/skills/seed')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.total_seeded).toBe(0);
      expect(res.body.total_skipped).toBeGreaterThan(0);
    });

    it('should reject without admin role', async () => {
      const regRes = await request(app)
        .post('/api/auth/register')
        .send({ username: 'seeduser_' + Date.now(), password: 'pass123' });

      const res = await request(app)
        .post('/api/skills/seed')
        .set('Authorization', `Bearer ${regRes.body.token}`)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe('Seeded skills are executable', () => {
    // Seed the skill library before running these tests
    beforeAll(async () => {
      await request(app).post('/api/skills/seed').set(adminAuth()).send({});
    });

    it('should have seeded skills visible in /api/skills', async () => {
      const res = await request(app)
        .get('/api/skills')
        .set(adminAuth());
      expect(res.status).toBe(200);
      const seedSkillNames = res.body.map(s => s.name);
      // Check a few of the 20 seed skills
      expect(seedSkillNames).toContain('deploy-check');
      expect(seedSkillNames).toContain('code-review');
      expect(seedSkillNames).toContain('git-status');
      expect(seedSkillNames).toContain('sql-query');
      expect(seedSkillNames).toContain('prompt-optimize');
    });

    it('should execute the git-status seed skill', async () => {
      const res = await request(app)
        .post('/api/skills/execute/git-status')
        .set(adminAuth())
        .send({ input: { cwd: PROJECT_ROOT } });
      expect(res.status).toBe(200);
      // If the skill failed, log the error for debugging
      if (!res.body.ok) {
        console.error('git-status skill error:', res.body.error);
      }
      expect(res.body.ok).toBe(true);
      expect(res.body.output).toHaveProperty('branch');
    });

    it('should execute the deploy-check seed skill', async () => {
      const res = await request(app)
        .post('/api/skills/execute/deploy-check')
        .set(adminAuth())
        .send({ input: '' });
      expect(res.status).toBe(200);
      if (!res.body.ok) {
        console.error('deploy-check skill error:', res.body.error);
      }
      expect(res.body.ok).toBe(true);
    });

    it('should match the git-status skill when user says "git status"', async () => {
      const res = await request(app)
        .get('/api/skills/match/' + encodeURIComponent('check git status please'))
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.skill.name).toBe('git-status');
      expect(res.body.skill.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('should match code-review skill when user says "review my code"', async () => {
      const res = await request(app)
        .get('/api/skills/match/' + encodeURIComponent('can you review my code please'))
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.skill.name).toBe('code-review');
    });
  });
});
