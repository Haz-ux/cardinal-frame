/**
 * Connector framework tests: registry, secret redaction, gmail_send gate,
 * Google authorize URL shape, and the admin HTTP routes.
 *
 * Standalone harness (temp better-sqlite3 DB + migration 023 + fake ctx):
 * server.mjs integration is wired by the coordinator, so these tests mount
 * the routes factory directly rather than depending on server.mjs.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { initSecretStore } from '../src/server/routes/settings.mjs';
import connectorsRoutes from '../src/server/routes/connectors.mjs';
import {
  setConnectorDeps, getConnector, listConnectors,
  invokeConnectorAction, redactArgs, sanitizeError,
} from '../src/server/connectors/registry.mjs';
import { buildAuthorizeUrl } from '../src/server/connectors/google-oauth.mjs';

const tmpDir = mkdtempSync(join(tmpdir(), 'cf-conn-test-'));
initSecretStore(tmpDir);

const db = new Database(':memory:');
db.exec(readFileSync(join(process.cwd(), 'src/server/migrations/023_connectors.sql'), 'utf8'));

const stmts = {
  connectors: {
    upsert: db.prepare(`INSERT INTO connectors (id, connector_id, name, kind, enabled, config_json, secret_json, status, oauth_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
      ON CONFLICT(connector_id) DO UPDATE SET name=excluded.name, kind=excluded.kind, config_json=excluded.config_json, secret_json=excluded.secret_json, updated_at=datetime('now')`),
    getByConnectorId: db.prepare('SELECT * FROM connectors WHERE connector_id = ?'),
    getAll: db.prepare('SELECT * FROM connectors ORDER BY connector_id'),
    updateStatus: db.prepare("UPDATE connectors SET status = ?, last_test_at = ?, last_error = ?, updated_at = datetime('now') WHERE connector_id = ?"),
    updateEnabled: db.prepare("UPDATE connectors SET enabled = ?, updated_at = datetime('now') WHERE connector_id = ?"),
    setSecrets: db.prepare("UPDATE connectors SET secret_json = ?, updated_at = datetime('now') WHERE connector_id = ?"),
    setOauthState: db.prepare("UPDATE connectors SET oauth_state = ?, updated_at = datetime('now') WHERE connector_id = ?"),
    getByOauthState: db.prepare('SELECT * FROM connectors WHERE oauth_state = ? AND oauth_state IS NOT NULL'),
    clearOauthState: db.prepare("UPDATE connectors SET oauth_state = NULL, updated_at = datetime('now') WHERE connector_id = ?"),
  },
};

const auditCalls = [];
const logs = [];
const fakeCtx = {
  db,
  stmts,
  logger: { info: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a), debug: () => {} },
  audit: (action, resourceType, resourceId, userId, details) =>
    auditCalls.push({ action, resourceType, resourceId, userId, details }),
  authMiddleware: (req, _res, next) => { req.user = { id: 'admin-1', username: 'Haz', role: 'admin' }; next(); },
  requireRole: (_role) => (_req, _res, next) => next(),
  apiLimiter: (_req, _res, next) => next(),
  randomUUID,
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', connectorsRoutes(fakeCtx));
  return app;
}

afterAll(() => {
  try { db.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  db.exec('DELETE FROM connectors');
  auditCalls.length = 0;
  logs.length = 0;
});

// ─── Registry basics ────────────────────────────────────────────────
describe('connector registry', () => {
  it('self-registers github, gmail and google-calendar', () => {
    const ids = listConnectors().map(c => c.id);
    expect(ids).toContain('github');
    expect(ids).toContain('gmail');
    expect(ids).toContain('google-calendar');
    const gh = getConnector('github');
    expect(gh.name).toBe('GitHub');
    expect(Object.keys(gh.actions)).toContain('github_list_issues');
    expect(Object.keys(gh.actions)).toContain('github_create_issue_comment');
  });

  it('invokes a fake connector and audit-logs the invocation', async () => {
    const { registerConnector } = await import('../src/server/connectors/registry.mjs');
    const seen = [];
    registerConnector({
      id: 'fake-test-conn',
      name: 'Fake',
      testConnection: async () => ({ ok: true, message: 'ok' }),
      actions: {
        fake_echo: {
          description: 'echo',
          parameters: { type: 'object', properties: {} },
          handler: async ({ args }) => ({ echoed: args }),
        },
      },
    });
    setConnectorDeps({
      getState: () => ({ enabled: true, config: {}, secrets: {} }),
      persistSecrets: () => {},
      audit: (...a) => auditCalls.push({ action: a[0], details: a[4] }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    const out = await invokeConnectorAction('fake-test-conn', 'fake_echo', { hello: 'world' }, { actor: 'tester' });
    expect(out).toEqual({ echoed: { hello: 'world' } });
    expect(auditCalls.some(c => c.action === 'connector.invoke')).toBe(true);
    expect(seen).toEqual([]);
  });

  it('refuses invocation when the connector is disabled or unknown', async () => {
    setConnectorDeps({
      getState: (id) => (id === 'fake-test-conn' ? { enabled: false, config: {}, secrets: {} } : null),
      persistSecrets: () => {},
      audit: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    const disabled = await invokeConnectorAction('fake-test-conn', 'fake_echo', {});
    expect(disabled.error).toMatch(/not enabled/);
    const unknown = await invokeConnectorAction('nope', 'nope', {});
    expect(unknown.error).toMatch(/Unknown connector/);
  });

  it('never leaks a canary secret through invoke errors', async () => {
    const canary = 'CANARY-SECRET-zz9q8w7e6r5t4';
    setConnectorDeps({
      getState: () => ({ enabled: true, config: {}, secrets: { pat: canary } }),
      persistSecrets: () => {},
      audit: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    // Handler accidentally interpolates the secret into an error.
    const { registerConnector: reg2 } = await import('../src/server/connectors/registry.mjs');
    reg2({
      id: 'leaky-conn',
      name: 'Leaky',
      testConnection: async () => ({ ok: true, message: 'ok' }),
      actions: {
        leaky: {
          description: 'leaks',
          parameters: { type: 'object', properties: {} },
          handler: async ({ secrets }) => { throw new Error(`request failed with key ${secrets.pat} boom`); },
        },
      },
    });
    const out = await invokeConnectorAction('leaky-conn', 'leaky', {});
    expect(out.error).toBeDefined();
    expect(out.error).not.toContain(canary);
    expect(out.error).toContain('[REDACTED]');
    // sanitizeError masks Bearer headers too.
    expect(sanitizeError(new Error('got Bearer abcDEF1234567890xyz'))).toContain('Bearer [REDACTED]');
  });

  it('redactArgs masks secret-bearing keys before audit', () => {
    const redacted = redactArgs({ query: 'in:inbox', token: 'supersecretvalue', nested: { api_key: 'k' } });
    expect(redacted.query).toBe('in:inbox');
    expect(redacted.token).toBe('[REDACTED]');
    expect(redacted.nested.api_key).toBe('[REDACTED]');
  });
});

// ─── gmail_send confirmation gate ───────────────────────────────────
describe('gmail_send confirmation gate', () => {
  it('refuses to send unless confirmed === true (no network touched)', async () => {
    const gmail = getConnector('gmail');
    setConnectorDeps({
      getState: () => ({ enabled: true, config: {}, secrets: {} }),
      persistSecrets: () => {},
      audit: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    // confirmed missing → refusal, before any credential check
    const refused = await invokeConnectorAction('gmail', 'gmail_send',
      { to: 'a@b.com', subject: 'hi', body: 'x' }, { actor: 'agent' });
    expect(refused.error).toMatch(/Confirmation required/);
    // confirmed: false → refusal
    const refused2 = await invokeConnectorAction('gmail', 'gmail_send',
      { to: 'a@b.com', subject: 'hi', body: 'x', confirmed: false }, { actor: 'agent' });
    expect(refused2.error).toMatch(/Confirmation required/);
    // confirmed: true but no tokens → fails at credential stage, not the gate
    const noCreds = await invokeConnectorAction('gmail', 'gmail_send',
      { to: 'a@b.com', subject: 'hi', body: 'x', confirmed: true }, { actor: 'agent' });
    expect(noCreds.error).toMatch(/not configured|tokens/i);
    expect(gmail.actions.gmail_send.description).toMatch(/confirmed/i);
  });
});

// ─── Google OAuth helpers ───────────────────────────────────────────
describe('google oauth helpers', () => {
  it('buildAuthorizeUrl produces a well-formed consent URL', () => {
    const url = buildAuthorizeUrl({
      clientId: 'cid123',
      redirectUri: 'https://cardinal.example:8080/api/connectors/google/callback',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      state: 'statetoken',
    });
    const u = new URL(url);
    expect(u.origin).toBe('https://accounts.google.com');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid123');
    expect(u.searchParams.get('redirect_uri')).toBe('https://cardinal.example:8080/api/connectors/google/callback');
    expect(u.searchParams.get('scope')).toContain('gmail.readonly');
    expect(u.searchParams.get('state')).toBe('statetoken');
    expect(u.searchParams.get('access_type')).toBe('offline');
  });

  it('buildAuthorizeUrl requires clientId, redirectUri and state', () => {
    expect(() => buildAuthorizeUrl({ redirectUri: 'x', state: 'y' })).toThrow(/clientId/);
    expect(() => buildAuthorizeUrl({ clientId: 'x', state: 'y' })).toThrow(/redirectUri/);
    expect(() => buildAuthorizeUrl({ clientId: 'x', redirectUri: 'y' })).toThrow(/state/);
  });
});

// ─── HTTP routes ────────────────────────────────────────────────────
describe('connector admin routes', () => {
  it('GET /connectors lists registered connectors with masked status', async () => {
    const res = await request(makeApp()).get('/api/connectors');
    expect(res.status).toBe(200);
    const ids = res.body.map(c => c.id);
    expect(ids).toContain('github');
    const gh = res.body.find(c => c.id === 'github');
    expect(gh).toMatchObject({ name: 'GitHub', kind: 'service', enabled: false });
    expect(gh).not.toHaveProperty('secret_json');
    expect(gh).not.toHaveProperty('oauth_state');
  });

  it('POST /connectors/:id/configure validates config and never returns secrets', async () => {
    const app = makeApp();
    // github configSchema has additionalProperties:false — junk key rejected
    const bad = await request(app).post('/api/connectors/github/configure')
      .send({ config: { bogus_key: 'x' }, secrets: { pat: 'ghp_testtoken123' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/validation failed/i);

    const ok = await request(app).post('/api/connectors/github/configure')
      .send({ config: { default_owner: 'Haz-ux' }, secrets: { pat: 'ghp_testtoken123' } });
    expect(ok.status).toBe(200);
    expect(ok.body.config).toEqual({ default_owner: 'Haz-ux' });
    expect(ok.body.has_secrets).toBe(true);
    expect(ok.body).not.toHaveProperty('secret_json');

    // secrets at rest are encrypted, not plaintext
    const row = stmts.connectors.getByConnectorId.get('github');
    expect(row.secret_json).toBeTruthy();
    expect(row.secret_json).not.toContain('ghp_testtoken123');

    // configure audit carries keys only, never values
    const cfgAudit = auditCalls.find(c => c.action === 'connector.configure');
    expect(cfgAudit).toBeDefined();
    expect(cfgAudit.details.secrets_keys).toEqual(['pat']);
    expect(JSON.stringify(cfgAudit.details)).not.toContain('ghp_testtoken123');
  });

  it('enable/disable toggles the flag and 404s when unconfigured', async () => {
    const app = makeApp();
    const missing = await request(app).post('/api/connectors/github/enable');
    expect(missing.status).toBe(404);
    await request(app).post('/api/connectors/github/configure').send({ config: {}, secrets: { pat: 'x' } });
    const en = await request(app).post('/api/connectors/github/enable');
    expect(en.status).toBe(200);
    expect(en.body.enabled).toBe(true);
    const dis = await request(app).post('/api/connectors/github/disable');
    expect(dis.body.enabled).toBe(false);
  });

  it('unknown connector ids 404', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/connectors/nope/configure').send({ config: {} });
    expect(res.status).toBe(404);
  });

  it('GET /connectors/google/authorize requires config first', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/connectors/google/authorize?connector=gmail');
    expect(res.status).toBe(404); // not configured yet
    const badConn = await request(app).get('/api/connectors/google/authorize?connector=github');
    expect(badConn.status).toBe(400);
  });

  it('GET /connectors/google/callback rejects bad state', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/connectors/google/callback?code=abc&state=bogus');
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/Invalid or expired OAuth state/);
  });
});
