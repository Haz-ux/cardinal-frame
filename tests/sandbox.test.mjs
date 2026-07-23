import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'child_process';
import { getTestServer, cleanupTestServer, adminAuth, userAuth } from './helpers.mjs';

let app;

beforeAll(async () => {
  ({ app } = await getTestServer());
});

afterAll(() => {
  cleanupTestServer();
});

function hasPython3() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('Sandbox API — POST /api/sandbox/execute', () => {
  describe('Admin auth + valid input', () => {
    it('should execute valid JS code and return 200', async () => {
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(adminAuth())
        .send({ code: 'console.log(1 + 2)', language: 'javascript' });
      expect(res.status).toBe(200);
      const output = res.body.output || res.body.stdout || '';
      expect(String(output)).toContain('3');
    });

    it('should execute multi-statement JS code', async () => {
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(adminAuth())
        .send({ code: 'const x = 10; const y = 20; console.log(x + y)', language: 'javascript' });
      expect(res.status).toBe(200);
      const output = res.body.output || res.body.stdout || '';
      expect(String(output)).toContain('30');
    });
  });

  describe('Auth / RBAC', () => {
    it('should reject without auth → 401', async () => {
      const res = await request(app)
        .post('/api/sandbox/execute')
        .send({ code: '1 + 1' });
      expect(res.status).toBe(401);
    });

    it('should reject regular user (non-admin) → 403', async () => {
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(userAuth())
        .send({ code: '1 + 1' });
      expect(res.status).toBe(403);
    });
  });

  describe('Validation', () => {
    it('should reject empty code → 400', async () => {
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(adminAuth())
        .send({ code: '' });
      expect(res.status).toBe(400);
    });

    it('should reject missing code field → 400', async () => {
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(adminAuth())
        .send({});
      expect(res.status).toBe(400);
    });

    it('should reject code exceeding 10000 chars → 400', async () => {
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(adminAuth())
        .send({ code: 'x'.repeat(10001) });
      expect(res.status).toBe(400);
    });

    it('should accept code at exactly 10000 chars (boundary)', async () => {
      const boundary = '0' + ';'.repeat(9999);
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(adminAuth())
        .send({ code: boundary });
      expect(res.status).toBe(200);
    });
  });

  describe('Python language', () => {
    it('should execute python code if python3 is available', async () => {
      if (!hasPython3()) return;
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(adminAuth())
        .send({ code: 'print(2 + 2)', language: 'python' });
      expect(res.status).toBe(200);
      const output = res.body.output || res.body.stdout || '';
      expect(String(output)).toContain('4');
    });
  });

  describe('Timeout handling', () => {
    it('should handle infinite-loop code gracefully', async () => {
      const res = await request(app)
        .post('/api/sandbox/execute')
        .set(adminAuth())
        .send({ code: 'while (true) {}' });
      // execSync kills the process on timeout — exitcode is non-zero
      // The key requirement: it should NOT hang the test runner
      expect([200, 400, 408, 500, 504]).toContain(res.status);
      if (res.status === 200) {
        // Non-zero exit code indicates the process was killed
        const exitCode = res.body.exitCode ?? res.body.exitcode ?? 0;
        expect(exitCode).not.toBe(0);
      }
    });
  });
});
