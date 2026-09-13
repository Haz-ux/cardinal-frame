/**
 * Connector routes: admin CRUD + test + OAuth for service connectors.
 * Dependencies: db, stmts, logger, audit, authMiddleware, requireRole, apiLimiter, randomUUID
 *
 * Importing this module self-registers the connector definitions (github,
 * gmail, google-calendar) via the connector modules' side effects, wires the
 * registry's host dependencies, and publishes every connector action as an
 * agent tool (name = action id, e.g. 'github_list_issues').
 */
import express from 'express';
import { randomBytes } from 'crypto';

import {
  setConnectorDeps, getConnector, listConnectors,
  invokeConnectorAction, testConnector, sanitizeError,
} from '../connectors/registry.mjs';
// Side-effect imports: each self-registers its connector with the registry.
import '../connectors/github.mjs';
import '../connectors/gmail.mjs';
import '../connectors/calendar.mjs';
import { GMAIL_SCOPES } from '../connectors/gmail.mjs';
import { CALENDAR_SCOPES } from '../connectors/calendar.mjs';
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../connectors/google-oauth.mjs';

import { encryptSecret, decryptSecret } from './settings.mjs';
import { registerAgentTool } from './agent.mjs';

// Which Google scopes each OAuth connector needs.
const GOOGLE_SCOPES = {
  'gmail': GMAIL_SCOPES,
  'google-calendar': CALENDAR_SCOPES,
};

export default function connectorsRoutes(ctx) {
  const { db, stmts, logger, audit, authMiddleware, requireRole, apiLimiter, randomUUID } = ctx;
  const router = express.Router();

  // ─── Registry host wiring (once, at factory time) ─────────────────
  setConnectorDeps({
    logger,
    audit: (action, resourceType, resourceId, userId, details) => {
      try { audit(action, resourceType, resourceId, userId, details); } catch { /* never break */ }
    },
    getState: (connectorId) => {
      const row = stmts.connectors.getByConnectorId.get(connectorId);
      if (!row) return null;
      let config = {};
      let secrets = {};
      try { config = JSON.parse(row.config_json || '{}'); } catch { /* keep {} */ }
      if (row.secret_json) {
        try {
          const dec = decryptSecret(row.secret_json);
          secrets = dec ? JSON.parse(dec) : {};
        } catch { secrets = {}; }
      }
      return { enabled: row.enabled === 1, config, secrets };
    },
    persistSecrets: (connectorId, secretsObject) => {
      // Used by OAuth connectors after a token refresh. Always encrypted.
      stmts.connectors.setSecrets.run(encryptSecret(JSON.stringify(secretsObject || {})), connectorId);
    },
  });

  // ─── Helpers ──────────────────────────────────────────────────────
  function maskedRow(connectorId) {
    const reg = getConnector(connectorId);
    const row = stmts.connectors.getByConnectorId.get(connectorId);
    return {
      id: connectorId,
      name: reg?.name || row?.name || connectorId,
      kind: reg?.kind || row?.kind || 'service',
      enabled: row ? row.enabled === 1 : false,
      status: row?.status || 'unconfigured',
      last_test_at: row?.last_test_at || null,
      last_error: row?.last_error || null,
      config: row ? safeParse(row.config_json) : {},
      has_secrets: !!(row && row.secret_json),
      // NEVER: secret_json, oauth_state, raw tokens — never leave the server.
    };
  }

  function safeParse(s) {
    try { return JSON.parse(s || '{}'); } catch { return {}; }
  }

  // Minimal JSON-Schema validator for connector configSchema
  // (objects, strings, integers, booleans, arrays, enums, required,
  // additionalProperties:false). Returns an array of error strings.
  function validateAgainstSchema(schema, value, path = 'config') {
    const errors = [];
    if (!schema || typeof schema !== 'object') return errors;
    const type = schema.type;
    const actual = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
    if (type && actual !== type) {
      // Allow numeric strings for 'integer' from sloppy clients.
      if (!(type === 'integer' && actual === 'string' && /^-?\d+$/.test(value))) {
        errors.push(`${path}: expected ${type}, got ${actual}`);
        return errors;
      }
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
    }
    if (type === 'object' && schema.properties) {
      for (const req of schema.required || []) {
        if (value[req] === undefined || value[req] === null || value[req] === '') {
          errors.push(`${path}.${req}: required`);
        }
      }
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (value[k] !== undefined) errors.push(...validateAgainstSchema(sub, value[k], `${path}.${k}`));
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!schema.properties[k]) errors.push(`${path}.${k}: not allowed`);
        }
      }
    }
    if (type === 'array' && schema.items && Array.isArray(value)) {
      value.forEach((v, i) => errors.push(...validateAgainstSchema(schema.items, v, `${path}[${i}]`)));
    }
    return errors;
  }

  // Admin auth that also accepts ?token= for browser-initiated flows
  // (dashboard opens the authorize URL in a new tab; query token is consumed
  // server-side and never logged). Falls through to normal authMiddleware.
  function adminAuthBrowser(req, res, next) {
    if (!req.headers.authorization && req.query && req.query.token) {
      req.headers.authorization = `Bearer ${req.query.token}`;
      delete req.query.token;
    }
    authMiddleware(req, res, (err) => {
      if (err) return next(err);
      requireRole('admin')(req, res, next);
    });
  }

  function requireRegistered(req, res) {
    const reg = getConnector(req.params.id);
    if (!reg) {
      res.status(404).json({ error: `Unknown connector: ${req.params.id}` });
      return null;
    }
    return reg;
  }

  // ─── GET /connectors — masked list (admin) ────────────────────────
  router.get('/connectors', authMiddleware, requireRole('admin'), (_req, res) => {
    try {
      res.json(listConnectors().map(c => maskedRow(c.id)));
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // ─── POST /connectors/:id/configure — validate + encrypt + upsert ─
  router.post('/connectors/:id/configure', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const reg = requireRegistered(req, res);
      if (!reg) return;
      const { config = {}, secrets = {} } = req.body || {};
      if (typeof config !== 'object' || Array.isArray(config) || config === null) {
        return res.status(400).json({ error: 'config must be an object' });
      }
      if (typeof secrets !== 'object' || Array.isArray(secrets) || secrets === null) {
        return res.status(400).json({ error: 'secrets must be an object' });
      }
      const schemaErrors = validateAgainstSchema(reg.configSchema, config);
      if (schemaErrors.length) {
        return res.status(400).json({ error: 'Config validation failed', details: schemaErrors });
      }

      // Merge with existing secrets so partial updates (e.g. adding a PAT)
      // don't wipe stored OAuth tokens.
      const existing = stmts.connectors.getByConnectorId.get(req.params.id);
      let mergedSecrets = { ...secrets };
      if (existing?.secret_json) {
        try {
          const dec = decryptSecret(existing.secret_json);
          mergedSecrets = { ...(dec ? JSON.parse(dec) : {}), ...secrets };
        } catch { /* start from provided secrets */ }
      }
      const hasSecrets = Object.keys(mergedSecrets).length > 0;

      stmts.connectors.upsert.run(
        randomUUID(), req.params.id, reg.name, reg.kind,
        existing ? existing.enabled : 0,
        JSON.stringify(config),
        hasSecrets ? encryptSecret(JSON.stringify(mergedSecrets)) : '',
        existing?.status || 'unconfigured',
      );
      audit('connector.configure', 'connector', req.params.id, req.user?.id, {
        config: { ...config }, // config holds no secrets by contract
        secrets_keys: Object.keys(mergedSecrets), // keys only, never values
      });
      logger.info(`[connectors] ${req.params.id} configured by ${req.user?.username || req.user?.id}`);
      res.json(maskedRow(req.params.id));
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // ─── POST /connectors/:id/test — live credential check ────────────
  router.post('/connectors/:id/test', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    try {
      const reg = requireRegistered(req, res);
      if (!reg) return;
      const result = await testConnector(req.params.id);
      const now = new Date().toISOString();
      stmts.connectors.updateStatus.run(
        result.ok ? 'ok' : 'error', now, result.ok ? null : result.message, req.params.id
      );
      audit('connector.test', 'connector', req.params.id, req.user?.id, { ok: result.ok });
      res.json({ ok: result.ok, message: result.message });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // ─── POST /connectors/:id/enable + /disable ───────────────────────
  router.post('/connectors/:id/enable', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const reg = requireRegistered(req, res);
      if (!reg) return;
      const info = stmts.connectors.updateEnabled.run(1, req.params.id);
      if (!info.changes) return res.status(404).json({ error: 'Connector is not configured yet — configure it first' });
      audit('connector.enable', 'connector', req.params.id, req.user?.id, {});
      logger.info(`[connectors] ${req.params.id} enabled by ${req.user?.username || req.user?.id}`);
      res.json(maskedRow(req.params.id));
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  router.post('/connectors/:id/disable', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    try {
      const reg = requireRegistered(req, res);
      if (!reg) return;
      const info = stmts.connectors.updateEnabled.run(0, req.params.id);
      if (!info.changes) return res.status(404).json({ error: 'Connector is not configured yet' });
      audit('connector.disable', 'connector', req.params.id, req.user?.id, {});
      res.json(maskedRow(req.params.id));
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // ─── Google OAuth: authorize (browser start) ──────────────────────
  // GET /connectors/google/authorize?connector=gmail|google-calendar
  // Admin-gated (Authorization header or ?token=; dashboard opens this in a
  // new tab). Generates a random `state`, stores it on the connector row,
  // and 302-redirects to Google's consent screen. The state value is the
  // CSRF protection for the callback below.
  router.get('/connectors/google/authorize', adminAuthBrowser, (req, res) => {
    try {
      const connectorId = req.query.connector;
      const reg = getConnector(connectorId);
      if (!reg || !GOOGLE_SCOPES[connectorId]) {
        return res.status(400).json({ error: 'connector must be gmail or google-calendar' });
      }
      const row = stmts.connectors.getByConnectorId.get(connectorId);
      if (!row) return res.status(404).json({ error: 'Connector is not configured yet — configure it first' });
      const config = safeParse(row.config_json);
      const clientId = config.oauth_client_id;
      const redirectUri = config.oauth_redirect_uri;
      if (!clientId || !redirectUri) {
        return res.status(400).json({
          error: 'oauth_client_id and oauth_redirect_uri must be set in the connector config first',
        });
      }
      const state = randomBytes(32).toString('hex');
      stmts.connectors.setOauthState.run(state, connectorId);
      const url = buildAuthorizeUrl({
        clientId,
        redirectUri,
        scopes: GOOGLE_SCOPES[connectorId],
        state,
      });
      audit('connector.oauth.authorize', 'connector', connectorId, req.user?.id, {});
      res.redirect(302, url);
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err) });
    }
  });

  // ─── Google OAuth: callback (Google → us) ─────────────────────────
  // GET /connectors/google/callback?code=...&state=...
  // NOTE: no auth header here — Google redirects the user's browser directly
  // to this URL, so there is no JWT to check. The `state` token (random,
  // single-use, stored on the connector row at authorize time) is the CSRF
  // protection: it is verified before any code exchange, then cleared.
  router.get('/connectors/google/callback', async (req, res) => {
    try {
      const { code, state, error: oauthError } = req.query;
      if (oauthError) {
        return res.status(400).send(failurePage(`Google refused authorization: ${sanitizeError(String(oauthError))}`));
      }
      if (!code || !state) {
        return res.status(400).send(failurePage('Missing code or state in OAuth callback.'));
      }
      const row = stmts.connectors.getByOauthState.get(String(state));
      if (!row) {
        return res.status(400).send(failurePage('Invalid or expired OAuth state. Please start the flow again from the dashboard.'));
      }
      const connectorId = row.connector_id;
      const config = safeParse(row.config_json);
      let secrets = {};
      if (row.secret_json) {
        try {
          const dec = decryptSecret(row.secret_json);
          secrets = dec ? JSON.parse(dec) : {};
        } catch { /* keep {} */ }
      }
      const client = secrets.oauth_client || {};
      const clientId = client.client_id || config.oauth_client_id;
      const clientSecret = client.client_secret;
      const redirectUri = config.oauth_redirect_uri;
      if (!clientId || !clientSecret || !redirectUri) {
        return res.status(400).send(failurePage('OAuth client credentials are incomplete — reconfigure the connector.'));
      }

      const tokens = await exchangeCodeForTokens({
        clientId, clientSecret, redirectUri, code: String(code),
      });
      // Clear the one-time state BEFORE storing tokens (single-use).
      stmts.connectors.clearOauthState.run(connectorId);
      stmts.connectors.setSecrets.run(
        encryptSecret(JSON.stringify({ ...secrets, oauth_client: client, tokens })),
        connectorId
      );
      stmts.connectors.updateStatus.run('ok', new Date().toISOString(), null, connectorId);
      audit('connector.oauth.callback', 'connector', connectorId, 'oauth-flow', {});
      logger.info(`[connectors] Google OAuth completed for ${connectorId}`);
      res.send(successPage(getConnector(connectorId)?.name || connectorId));
    } catch (err) {
      res.status(500).send(failurePage(sanitizeError(err)));
    }
  });

  // ─── Agent tools: every connector action becomes an agent tool ────
  // Tool name = action id (e.g. 'github_list_issues'). The agent's own
  // identity becomes the audit actor. gmail_send's confirmation gate lives
  // in the connector handler itself, so the tool cannot bypass it.
  for (const conn of listConnectors()) {
    for (const [actionId, action] of Object.entries(conn.actions || {})) {
      registerAgentTool(
        actionId,
        `[${conn.name}] ${action.description}`,
        action.parameters || { type: 'object', properties: {} },
        async (args, agentCtx) => {
          return invokeConnectorAction(conn.id, actionId, args || {}, {
            actor: agentCtx?.userId || agentCtx?.username || 'agent',
          });
        }
      );
    }
  }

  return router;
}

function successPage(connectorName) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:420px;text-align:center}
h1{font-size:20px;margin:0 0 12px}.ok{color:#3fb950;font-size:40px}</style></head>
<body><div class="card"><div class="ok">✓</div><h1>${escapeHtml(connectorName)} connected</h1>
<p>Google authorization succeeded. You can close this tab and return to Cardinal Frame.</p></div></body></html>`;
}

function failurePage(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorization failed</title>
<style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:420px;text-align:center}
h1{font-size:20px;margin:0 0 12px}.bad{color:#f85149;font-size:40px}</style></head>
<body><div class="card"><div class="bad">✕</div><h1>Authorization failed</h1>
<p>${escapeHtml(message)}</p></div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
