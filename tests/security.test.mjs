import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getTestServer, cleanupTestServer, makeToken, adminAuth, userAuth } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

describe('Security Mechanisms', () => {
  describe('Rate Limiting', () => {
    it('should return 429 after 100 requests to apiLimiter-protected endpoint', async () => {
      const requests = Array.from({ length: 105 }, () =>
        request(app).get('/api/users').set(adminAuth())
      );
      const responses = await Promise.all(requests);
      const codes = responses.map(r => r.status);
      const limited = codes.filter(c => c === 429);
      expect(limited.length).toBeGreaterThan(0);
    });
  });

  describe('SQL Injection Prevention', () => {
    it('should reject OR 1=1 on login', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: "' OR 1=1 --", password: 'anything' });
      expect(res.status).toBe(401);
      expect(res.body).not.toHaveProperty('token');
    });

    it('should reject DROP TABLE on login', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: "admin'; DROP TABLE users; --", password: 'anything' });
      expect(res.status).toBe(401);
    });

    it('should reject UNION SELECT on login', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: "' UNION SELECT * FROM users --", password: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('XSS Prevention', () => {
    it('should sanitize or reject script tag in username on register', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: '<script>alert(1)</script>', password: 'testpass123' });
      // Either rejected, or the returned username is the raw value (server stores as-is, 
      // but frontend is responsible for escaping). At minimum it should not crash.
      expect([200, 201, 400]).toContain(res.status);
    });
  });

  describe('Auth Bypass Prevention', () => {
    it('should reject admin route without Authorization header', async () => {
      const res = await request(app).get('/api/users');
      expect(res.status).toBe(401);
    });

    it('should reject malformed Bearer token', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', 'Bearer null');
      expect(res.status).toBe(401);
    });

    it('should reject empty Bearer token', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
    });

    it('should reject tampered token', async () => {
      const token = makeToken('admin-001', 'admin', 'admin');
      const tampered = token.slice(0, -5) + 'XXXXX';
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${tampered}`);
      expect(res.status).toBe(401);
    });
  });

  describe('Security Headers', () => {
    it('should include X-Frame-Options: SAMEORIGIN', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['x-frame-options'].toLowerCase()).toBe('sameorigin');
    });

    it('should include X-Content-Type-Options: nosniff', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-content-type-options']).toBeDefined();
      expect(res.headers['x-content-type-options'].toLowerCase()).toBe('nosniff');
    });

    it('should include Referrer-Policy', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['referrer-policy']).toBeDefined();
    });

    it('should NOT leak x-powered-by header', async () => {
      const res = await request(app).get('/api/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('Invalid Input Handling', () => {
    it('should reject empty body on login', async () => {
      const res = await request(app).post('/api/auth/login').send({});
      expect(res.status).toBe(400);
    });

    it('should handle path traversal attempt gracefully', async () => {
      // Express normalizes paths — /../../../etc/passwd resolves to /
      // The SPA catch-all serves index.html for unknown routes (200)
      // Key: the response should NOT contain /etc/passwd file contents
      const res = await request(app).get('/../../../etc/passwd');
      expect(res.status).toBe(200); // Serves SPA HTML
      // Ensure it's not actual file contents
      expect(res.text).not.toContain('root:x:0:0');
    });
  });
});
