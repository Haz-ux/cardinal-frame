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

describe('Learn API', () => {
  describe('POST /api/learn/observe — record observations', () => {
    it('should create an observation with user_input', async () => {
      const res = await request(app)
        .post('/api/learn/observe')
        .set(adminAuth())
        .send({
          user_input: 'deploy the application to production server',
          assistant_output: 'Running deployment pipeline...',
          intent: 'deployment',
          entities: ['production', 'server'],
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('pattern_detected');
    });

    it('should reject missing user_input', async () => {
      const res = await request(app)
        .post('/api/learn/observe')
        .set(adminAuth())
        .send({ intent: 'test' });
      expect(res.status).toBe(400);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .post('/api/learn/observe')
        .send({ user_input: 'test' });
      expect(res.status).toBe(401);
    });

    it('should detect patterns on repeated similar inputs', async () => {
      // Send the same/similar input 3 times to trigger pattern deduplication
      const input = 'search for error logs in the system';
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/api/learn/observe')
          .set(adminAuth())
          .send({ user_input: input, intent: 'search' });
        expect(res.status).toBe(201);
      }

      // Check patterns were created
      const patternsRes = await request(app)
        .get('/api/learn/patterns')
        .set(adminAuth());
      expect(patternsRes.status).toBe(200);
      // Should have at least one pattern matching our input
      const matchingPattern = patternsRes.body.find(p =>
        p.pattern_key && p.pattern_key.includes('search') && p.pattern_key.includes('error')
      );
      expect(matchingPattern).toBeDefined();
      expect(matchingPattern.occurrence_count).toBeGreaterThanOrEqual(2);
    });
  });

  describe('GET /api/learn/patterns — list patterns', () => {
    it('should return patterns array', async () => {
      const res = await request(app)
        .get('/api/learn/patterns')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const res = await request(app)
        .get('/api/learn/patterns?limit=5')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.length).toBeLessThanOrEqual(5);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .get('/api/learn/patterns');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/learn/observations — list observations', () => {
    it('should return observations array', async () => {
      const res = await request(app)
        .get('/api/learn/observations')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .get('/api/learn/observations');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/learn/stats — learning dashboard stats', () => {
    it('should return stats object with correct fields', async () => {
      const res = await request(app)
        .get('/api/learn/stats')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('total_observations');
      expect(res.body).toHaveProperty('total_patterns');
      expect(res.body).toHaveProperty('high_confidence_patterns');
      expect(res.body).toHaveProperty('auto_proposed_skills');
      expect(res.body).toHaveProperty('validated_skills');
      expect(res.body).toHaveProperty('avg_pattern_confidence');
      expect(typeof res.body.total_observations).toBe('number');
      expect(typeof res.body.avg_pattern_confidence).toBe('number');
    });

    it('should reflect observations made', async () => {
      const beforeRes = await request(app)
        .get('/api/learn/stats')
        .set(adminAuth());
      const before = beforeRes.body.total_observations;

      await request(app)
        .post('/api/learn/observe')
        .set(adminAuth())
        .send({ user_input: 'stats test observation input here' });

      const afterRes = await request(app)
        .get('/api/learn/stats')
        .set(adminAuth());
      expect(afterRes.body.total_observations).toBeGreaterThan(before);
    });

    it('should reject without auth', async () => {
      const res = await request(app)
        .get('/api/learn/stats');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/skills/auto-propose — propose skills from patterns', () => {
    it('should propose a skill explicitly with name + handler', async () => {
      const res = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({
          name: 'test-skill-deploy-' + Date.now(),
          description: 'Test deployment skill',
          handler: 'async (input) => { return { handled: true }; }',
          category: 'devops',
          parameters: { env: 'production' },
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.auto_proposed).toBe(true);
      expect(res.body.confidence).toBe(0.3);
    });

    it('should reject duplicate skill name', async () => {
      const name = 'dup-skill-' + Date.now();
      await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({ name, handler: 'async () => ({})' });

      const res = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({ name, handler: 'async () => ({})' });
      expect(res.status).toBe(409);
    });

    it('should auto-analyze observations when no explicit name provided', async () => {
      // Seed enough observations with same intent
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/api/learn/observe')
          .set(adminAuth())
          .send({
            user_input: `create a new ${['component', 'file', 'module'][i % 3]} for the project number ${i}`,
            intent: 'create',
          });
      }

      const res = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({});
      // Should either propose (201) or say not enough (200 with proposed: false)
      expect([200, 201]).toContain(res.status);
      if (res.status === 201) {
        expect(res.body.auto_proposed).toBe(true);
        expect(res.body.based_on.intent).toBe('create');
      }
    });

    it('should reject without admin role', async () => {
      const regRes = await request(app)
        .post('/api/auth/register')
        .send({ username: 'learnuser_' + Date.now(), password: 'pass123' });

      const res = await request(app)
        .post('/api/skills/auto-propose')
        .set('Authorization', `Bearer ${regRes.body.token}`)
        .send({ name: 'test', handler: 'async () => ({})' });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/skills/:id/validate — validate a skill', () => {
    it('should validate a skill and update confidence', async () => {
      // First create a skill
      const createRes = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({
          name: 'validate-test-' + Date.now(),
          handler: 'async (input) => { return { handled: true, input }; }',
        });
      const skillId = createRes.body.id;

      const res = await request(app)
        .post(`/api/skills/${skillId}/validate`)
        .set(adminAuth())
        .send({
          test_input: 'test input data',
          expected_output: 'handled',
        });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('validation_id');
      expect(res.body).toHaveProperty('passed');
      expect(typeof res.body.passed).toBe('boolean');
      expect(res.body).toHaveProperty('confidence');
      expect(res.body).toHaveProperty('total_validations');
    });

    it('should detect failed validation', async () => {
      const createRes = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({
          name: 'fail-test-' + Date.now(),
          handler: 'async (input) => { throw new Error("intentional failure"); }',
        });

      const res = await request(app)
        .post(`/api/skills/${createRes.body.id}/validate`)
        .set(adminAuth())
        .send({ test_input: 'test' });
      expect(res.status).toBe(200);
      expect(res.body.passed).toBe(false);
    });

    it('should return 404 for non-existent skill', async () => {
      const res = await request(app)
        .post('/api/skills/nonexistent/validate')
        .set(adminAuth())
        .send({ test_input: 'test' });
      expect(res.status).toBe(404);
    });

    it('should reject missing test_input', async () => {
      const createRes = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({ name: 'noinput-test-' + Date.now(), handler: 'async () => ({})' });

      const res = await request(app)
        .post(`/api/skills/${createRes.body.id}/validate`)
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/skills/:id/feedback — feedback adjusts confidence', () => {
    it('should adjust confidence on positive feedback', async () => {
      const createRes = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({ name: 'feedback-test-' + Date.now(), handler: 'async () => ({ handled: true })' });

      const res = await request(app)
        .post(`/api/skills/${createRes.body.id}/feedback`)
        .set(adminAuth())
        .send({ success: true });
      expect(res.status).toBe(200);
      expect(res.body.confidence).toBeGreaterThan(0);
      expect(res.body.success_count).toBeGreaterThanOrEqual(1);
    });

    it('should adjust confidence on negative feedback', async () => {
      const createRes = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({ name: 'neg-feedback-' + Date.now(), handler: 'async () => ({})' });

      const res = await request(app)
        .post(`/api/skills/${createRes.body.id}/feedback`)
        .set(adminAuth())
        .send({ success: false });
      expect(res.status).toBe(200);
      expect(res.body.failure_count).toBeGreaterThanOrEqual(1);
    });

    it('should reject missing success field', async () => {
      const createRes = await request(app)
        .post('/api/skills/auto-propose')
        .set(adminAuth())
        .send({ name: 'nofb-' + Date.now(), handler: 'async () => ({})' });

      const res = await request(app)
        .post(`/api/skills/${createRes.body.id}/feedback`)
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/learn/patterns/:id — delete pattern', () => {
    it('should delete an existing pattern', async () => {
      // Make an observation to create a pattern
      await request(app)
        .post('/api/learn/observe')
        .set(adminAuth())
        .send({ user_input: 'delete pattern test unique unique unique' });

      const patternsRes = await request(app)
        .get('/api/learn/patterns')
        .set(adminAuth());
      const pattern = patternsRes.body[0];
      if (!pattern) return; // skip if no patterns exist

      const res = await request(app)
        .delete(`/api/learn/patterns/${pattern.id}`)
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
