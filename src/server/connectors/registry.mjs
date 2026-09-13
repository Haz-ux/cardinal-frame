/**
 * Connector registry — framework for Cardinal Frame service connectors.
 *
 * A connector is a named service integration (GitHub, Gmail, Google Calendar,
 * ...) that self-registers here. The registry is transport-agnostic: it knows
 * nothing about Express, the database, or the route ctx. All host services
 * (state lookup, audit, logging, secret persistence) arrive via
 * setConnectorDeps(), wired once by the routes factory.
 *
 * Secrets discipline: raw secrets NEVER pass through logs or audit records.
 * invokeConnectorAction audit-logs every invocation with redacted args.
 */

const connectors = new Map();

// Host-provided dependencies. The routes factory sets these once at boot:
//   getState(connectorId)        -> { enabled, config, secrets } | null
//                                  secrets = decrypted secrets object (never raw blob)
//   persistSecrets(connectorId, secretsObject) -> void  (encrypts + stores)
//   audit(action, resourceType, resourceId, userId, details) -> void
//   logger                       -> { info, warn, error, debug }
let deps = {
  getState: () => null,
  persistSecrets: () => { throw new Error('persistSecrets not wired'); },
  audit: () => {},
  logger: console,
};

export function setConnectorDeps(d) {
  deps = { ...deps, ...(d || {}) };
}

export function getConnectorDeps() {
  return deps;
}

/**
 * Register a connector definition.
 *   { id, name, kind='service', configSchema, testConnection, actions }
 *   actions = { actionId: { description, parameters (JSON Schema), handler } }
 *   testConnection({ config, secrets }) -> { ok, message }
 *   handler({ config, secrets, args, actor, refresh }) -> plain object | { error }
 */
export function registerConnector(def) {
  if (!def || typeof def.id !== 'string' || !def.id) {
    throw new Error('registerConnector: def.id (string) is required');
  }
  if (!def.name || typeof def.testConnection !== 'function' || !def.actions) {
    throw new Error(`registerConnector('${def.id}'): name, testConnection and actions are required`);
  }
  if (connectors.has(def.id)) {
    throw new Error(`registerConnector: connector '${def.id}' is already registered`);
  }
  connectors.set(def.id, {
    id: def.id,
    name: def.name,
    kind: def.kind || 'service',
    configSchema: def.configSchema || { type: 'object', properties: {} },
    testConnection: def.testConnection,
    actions: def.actions,
  });
}

export function getConnector(id) {
  return connectors.get(id) || null;
}

export function listConnectors() {
  return [...connectors.values()];
}

// ─── Secret-safe redaction ───────────────────────────────────────────
// Redact common secret-bearing arg keys before anything is logged or audited.
// Values that merely *look* like tokens (>= 20 chars of base64-ish in a
// bearer-ish field) are also masked.
const SENSITIVE_ARG_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'api_key', 'apikey', 'secret',
  'client_secret', 'password', 'pat', 'bearer', 'authorization', 'private_key',
]);

function redactValue(key, value) {
  if (SENSITIVE_ARG_KEYS.has(String(key).toLowerCase())) return '[REDACTED]';
  if (typeof value === 'string' && value.length >= 24 && /^[A-Za-z0-9\-_+/=.]+$/.test(value)) {
    return '[REDACTED:token-like]';
  }
  if (Array.isArray(value)) return value.map((v, i) => redactValue(`${key}[${i}]`, v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v);
    return out;
  }
  return value;
}

export function redactArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) out[k] = redactValue(k, v);
  return out;
}

// Scrub anything that looks like a credential out of an error string.
// Never returns the raw error's secrets; returns a safe message instead.
export function sanitizeError(err, knownSecrets) {
  let msg = err && err.message ? String(err.message) : String(err);
  // Mask Bearer/basic auth headers and long token-ish runs.
  msg = msg
    .replace(/Bearer\s+[A-Za-z0-9\-_~+/]+=*?/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/=]{12,}/gi, 'Basic [REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED]')
    .replace(/xox[bap]- [A-Za-z0-9-]{8,}/g, '[REDACTED]');
  // Belt-and-braces: scrub the connector's own secret values verbatim.
  for (const s of collectSecretStrings(knownSecrets)) {
    if (s && msg.includes(s)) msg = msg.split(s).join('[REDACTED]');
  }
  return msg;
}

// Collect every string value inside a secrets object (nested included) so
// sanitizeError can scrub them verbatim from error messages.
function collectSecretStrings(obj, out = []) {
  if (typeof obj === 'string') {
    if (obj.length >= 4) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) { for (const v of obj) collectSecretStrings(v, out); return out; }
  if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) collectSecretStrings(v, out); }
  return out;
}

/**
 * Invoke a connector action on behalf of an actor (agent or admin user).
 * Never throws: all failures come back as { error } so agent tools and
 * HTTP handlers can forward them directly. Secrets never appear in
 * errors, logs, or audit records.
 */
export async function invokeConnectorAction(connectorId, actionId, args, opts = {}) {
  const actor = opts.actor || 'unknown';
  const conn = connectors.get(connectorId);
  if (!conn) return { error: `Unknown connector: ${connectorId}` };
  const action = conn.actions?.[actionId];
  if (!action) return { error: `Unknown action '${actionId}' on connector '${connectorId}'` };

  let state = null;
  try {
    state = deps.getState(connectorId);
  } catch (err) {
    return { error: `Connector state lookup failed: ${sanitizeError(err)}` };
  }
  if (!state || !state.enabled) {
    return { error: `Connector '${connectorId}' is not enabled` };
  }

  const redacted = redactArgs(args || {});
  const knownSecrets = state?.secrets;
  const ctx = {
    config: state.config || {},
    secrets: state.secrets || {},
    args: args || {},
    actor,
    // OAuth connectors can persist refreshed tokens through this callback.
    persistSecrets: (secretsObject) => deps.persistSecrets(connectorId, secretsObject),
  };

  try {
    const result = await action.handler(ctx);
    try {
      deps.audit('connector.invoke', 'connector', connectorId, actor, {
        action: actionId,
        args: redacted,
        outcome: result && result.error ? 'error' : 'ok',
        detail: result && result.error ? sanitizeError(result.error, knownSecrets) : undefined,
      });
    } catch { /* audit must never break invocation */ }
    return result && typeof result === 'object' ? result : { result };
  } catch (err) {
    try {
      deps.audit('connector.invoke', 'connector', connectorId, actor, {
        action: actionId,
        args: redacted,
        outcome: 'error',
        detail: sanitizeError(err, knownSecrets),
      });
    } catch { /* audit must never break invocation */ }
    deps.logger?.error?.(`[connectors] ${connectorId}.${actionId} failed: ${sanitizeError(err, knownSecrets)}`);
    return { error: sanitizeError(err, knownSecrets) };
  }
}

/** Convenience for route-level test-connection flows (uses stored creds). */
export async function testConnector(connectorId) {
  const conn = connectors.get(connectorId);
  if (!conn) return { ok: false, message: `Unknown connector: ${connectorId}` };
  let state = null;
  try {
    state = deps.getState(connectorId);
  } catch (err) {
    return { ok: false, message: `State lookup failed: ${sanitizeError(err)}` };
  }
  if (!state) return { ok: false, message: 'Connector is not configured' };
  try {
    const out = await conn.testConnection({ config: state.config || {}, secrets: state.secrets || {} });
    return { ok: !!out?.ok, message: sanitizeError(out?.message || (out?.ok ? 'OK' : 'Failed')) };
  } catch (err) {
    return { ok: false, message: sanitizeError(err) };
  }
}
