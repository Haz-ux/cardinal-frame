import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, makeToken, adminAuth, userAuth, getAdminCredentials } from './helpers.mjs';

let app;
let adminCreds;

beforeAll(async () => {
  ({ app } = await getTestServer());
  adminCreds = getAdminCredentials();
});

afterAll(() => {
  cleanupTestServer();
});

describe('Auth API', () => {
  describe('POST /api/auth/register', () => {
    it('should register a new user', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'newuser', password: 'testpass123' });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('user');
      expect(res.body.user.username).toBe('newuser');
      expect(res.body.user.role).toBe('user');
    });

    it('should reject duplicate username', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'newuser', password: 'testpass123' });
      expect(res.status).toBe(409);
    });

    it('should reject missing username', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ password: 'testpass123' });
      expect(res.status).toBe(400);
    });

    it('should reject missing password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'nopass' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login with correct credentials (admin)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: adminCreds.adminPassword });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body.user.username).toBe('admin');
      expect(res.body.user.role).toBe('admin');
    });

    it('should login with correct credentials (Haz)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'Haz', password: adminCreds.hazPassword });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body.user.username).toBe('Haz');
      expect(res.body.user.role).toBe('admin');
    });

    it('should reject wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'wrongpass' });
      expect(res.status).toBe(401);
    });

    it('should reject non-existent user', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'ghost', password: 'anything' });
      expect(res.status).toBe(401);
    });

    it('should reject missing fields', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return user info with valid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set(adminAuth());
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('username');
    });

    it('should reject without token', async () => {
      const res = await request(app)
        .get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('should reject invalid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer garbage-token-here');
      expect(res.status).toBe(401);
    });
  });

  describe('RBAC — requireRole middleware', () => {
    it('should allow admin to access admin-only routes', async () => {
      const res = await request(app)
        .get('/api/users')
        .set(adminAuth());
      expect(res.status).toBe(200);
    });

    it('should reject regular user from admin-only routes', async () => {
      // Register a regular user first
      await request(app)
        .post('/api/auth/register')
        .send({ username: 'regularuser', password: 'pass123' });

      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'regularuser', password: 'pass123' });

      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${loginRes.body.token}`);
      expect(res.status).toBe(403);
    });

    it('should reject unauthenticated request to admin-only routes', async () => {
      const res = await request(app)
        .get('/api/users');
      expect(res.status).toBe(401);
    });
  });

  describe('Token validity', () => {
    it('generated test token should work', async () => {
      const token = makeToken('admin-000', 'admin', 'admin');
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Refresh tokens', () => {
    it('login returns an access + refresh token pair', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: adminCreds.adminPassword });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body).toHaveProperty('refreshToken');
    });

    it('refresh rotates the token pair and invalidates the old refresh token', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: adminCreds.adminPassword });
      const oldRefresh = loginRes.body.refreshToken;

      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: oldRefresh });
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body).toHaveProperty('token');
      expect(refreshRes.body.refreshToken).toBeTruthy();
      expect(refreshRes.body.refreshToken).not.toBe(oldRefresh);

      // Old token must now be revoked → 401 on reuse
      const replay = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: oldRefresh });
      expect(replay.status).toBe(401);
    });

    it('rejects a garbage refresh token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'not-a-real-token' });
      expect(res.status).toBe(401);
    });

    it('rejects a missing refresh token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({});
      expect(res.status).toBe(400);
    });

    it('logout revokes the refresh token', async () => {
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: adminCreds.adminPassword });
      const refreshToken = loginRes.body.refreshToken;

      const logoutRes = await request(app)
        .post('/api/auth/logout')
        .send({ refreshToken });
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.success).toBe(true);

      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken });
      expect(refreshRes.status).toBe(401);
    });

    it('logout with unknown token still succeeds', async () => {
      const res = await request(app)
        .post('/api/auth/logout')
        .send({ refreshToken: 'definitely-not-a-token' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // L6: DISABLE_REGISTRATION deployment toggle.
  describe('DISABLE_REGISTRATION', () => {
    it('returns 403 on /register when set to a truthy value', async () => {
      for (const v of ['true', '1', 'yes']) {
        process.env.DISABLE_REGISTRATION = v;
        const res = await request(app)
          .post('/api/auth/register')
          .send({ username: `blocked-${v}`, password: 'testpass123' });
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/disabled/i);
      }
      delete process.env.DISABLE_REGISTRATION;
    });

    it('treats explicit falsy values as registration-open', async () => {
      process.env.DISABLE_REGISTRATION = 'false';
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'falsyflaguser', password: 'testpass123' });
      delete process.env.DISABLE_REGISTRATION;
      expect(res.status).toBe(201);
    });

    it('registers normally when unset (default unchanged)', async () => {
      delete process.env.DISABLE_REGISTRATION;
      const res = await request(app)
        .post('/api/auth/register')
        .send({ username: 'openreguser', password: 'testpass123' });
      expect(res.status).toBe(201);
    });
  });
});
