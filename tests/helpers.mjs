/**
 * Test helpers: create a test server instance with an isolated temp DB.
 * Each test file gets its own fresh database.
 */
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import jwt from 'jsonwebtoken';

// Set test env BEFORE importing the server module
const TEST_JWT_SECRET = 'test-secret-do-not-use-in-prod';

let _app = null;
let _db = null;
let _tmpDir = null;

export async function getTestServer() {
  if (_app) return { app: _app, db: _db, tmpDir: _tmpDir };

  // Create temp directory for test DB
  _tmpDir = mkdtempSync(join(tmpdir(), 'cf-test-'));
  process.env.DATA_DIR = _tmpDir;
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0'; // don't bind to a real port

  // Import the server module (this runs all the schema setup)
  const serverModule = await import('../src/server/server.mjs');
  _app = serverModule.app;
  _db = serverModule.db;

  return { app: _app, db: _db, tmpDir: _tmpDir };
}

export function cleanupTestServer() {
  if (_db) {
    try { _db.close(); } catch {}
  }
  if (_tmpDir) {
    try { rmSync(_tmpDir, { recursive: true, force: true }); } catch {}
  }
  _app = null;
  _db = null;
  _tmpDir = null;
}

/**
 * Generate a valid JWT token for testing.
 * @param {string} userId - The user ID
 * @param {string} username - The username
 * @param {string} role - The role (admin, user)
 */
export function makeToken(userId = 'haz-001', username = 'Haz', role = 'admin') {
  return jwt.sign(
    { id: userId, username, role },
    TEST_JWT_SECRET,
    { expiresIn: '1h' }
  );
}

/**
 * Auth header for supertest requests.
 */
export function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Admin auth header (convenience).
 */
export function adminAuth() {
  return authHeader(makeToken());
}

/**
 * Regular user auth header.
 */
export function userAuth(userId = 'user-test', username = 'testuser') {
  return authHeader(makeToken(userId, username, 'user'));
}
