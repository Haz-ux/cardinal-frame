import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestServer, cleanupTestServer, makeToken, adminAuth, userAuth } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
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
        .send({ username: 'admin', password: 'admin123' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body.user.username).toBe('admin');
      expect(res.body.user.role).toBe('admin');
    });

    it('should login with correct credentials (Haz)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'Haz', password: 'cardinal' });
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
});
