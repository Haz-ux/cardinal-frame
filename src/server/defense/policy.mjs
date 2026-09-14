/**
 * Cardinal Frame — Policy — Capability Authorization (v2 defense layer)
 *
 * The central authorization boundary for V2: every executable capability
 * (agent tool, filesystem op, process execution, network egress, MCP call,
 * connector action, DAG node, learning activation, admin action) is decided
 * HERE, fail-closed. A check at the HTTP route alone is not a boundary —
 * internal code paths must not be able to bypass this module, so the real
 * execution primitives call back into decide() before acting.
 *
 * Decision model (deterministic):
 *
 *     actor (principal + role)
 *        ↓
 *     capability (one of CAPABILITIES, each with a risk level and scope)
 *        ↓
 *     provenance (trust tier the instruction originates from)
 *        ↓
 *     decide() -> { allowed, risk, reason, auditId }
 *
 * Rules:
 *  - Unknown capability            → deny  (fail closed)
 *  - Unknown/empty role            → deny
 *  - Capability not in role grants → deny
 *  - HIGH/CRITICAL-risk capability requested from non-user provenance
 *    (external content, third-party agents, learned behavior) → deny:
 *    external data is data, not an instruction, unless the user delegates.
 *  - Every denial is deterministic and carries a reason + audit id.
 *
 * External content never becomes an instruction automatically. Learned
 * behavior is never auto-trusted. A discovered capability is never
 * automatically executable.
 */

import { randomUUID } from 'crypto';

// ─── Capability classification (P1.7) ────────────────────────────────
export const CAPABILITIES = Object.freeze({
  FILESYSTEM_READ: 'FILESYSTEM_READ',
  FILESYSTEM_WRITE: 'FILESYSTEM_WRITE',
  FILESYSTEM_DELETE: 'FILESYSTEM_DELETE',

  PROCESS_EXECUTION: 'PROCESS_EXECUTION',
  CODE_EXECUTION: 'CODE_EXECUTION',

  NETWORK_INTERNAL: 'NETWORK_INTERNAL',
  NETWORK_EXTERNAL: 'NETWORK_EXTERNAL',

  CONNECTOR_READ: 'CONNECTOR_READ',
  CONNECTOR_WRITE: 'CONNECTOR_WRITE',
  CONNECTOR_EXTERNAL_SEND: 'CONNECTOR_EXTERNAL_SEND',
  CONNECTOR_DESTRUCTIVE: 'CONNECTOR_DESTRUCTIVE',
  CONNECTOR_CREDENTIAL: 'CONNECTOR_CREDENTIAL',

  MCP_DISCOVER: 'MCP_DISCOVER',
  MCP_CALL: 'MCP_CALL',
  MCP_ADMIN: 'MCP_ADMIN',

  LEARNING_OBSERVE: 'LEARNING_OBSERVE',
  LEARNING_PROPOSE: 'LEARNING_PROPOSE',
  LEARNING_REVIEW: 'LEARNING_REVIEW',
  LEARNING_APPROVE: 'LEARNING_APPROVE',
  LEARNING_ACTIVATE: 'LEARNING_ACTIVATE',

  ADMIN_CONFIG: 'ADMIN_CONFIG',
  ADMIN_CREDENTIAL: 'ADMIN_CREDENTIAL',
  ADMIN_SYSTEM: 'ADMIN_SYSTEM',
});

export const RISK = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

export const RISK_BY_CAPABILITY = Object.freeze({
  FILESYSTEM_READ: RISK.LOW,
  FILESYSTEM_WRITE: RISK.MEDIUM,
  FILESYSTEM_DELETE: RISK.HIGH,

  PROCESS_EXECUTION: RISK.MEDIUM,
  CODE_EXECUTION: RISK.CRITICAL,

  NETWORK_INTERNAL: RISK.MEDIUM,
  NETWORK_EXTERNAL: RISK.HIGH,

  CONNECTOR_READ: RISK.LOW,
  CONNECTOR_WRITE: RISK.MEDIUM,
  CONNECTOR_EXTERNAL_SEND: RISK.HIGH,
  CONNECTOR_DESTRUCTIVE: RISK.CRITICAL,
  CONNECTOR_CREDENTIAL: RISK.CRITICAL,

  MCP_DISCOVER: RISK.LOW,
  MCP_CALL: RISK.MEDIUM,
  MCP_ADMIN: RISK.CRITICAL,

  LEARNING_OBSERVE: RISK.LOW,
  LEARNING_PROPOSE: RISK.LOW,
  LEARNING_REVIEW: RISK.MEDIUM,
  LEARNING_APPROVE: RISK.HIGH,
  LEARNING_ACTIVATE: RISK.HIGH,

  ADMIN_CONFIG: RISK.HIGH,
  ADMIN_CREDENTIAL: RISK.CRITICAL,
  ADMIN_SYSTEM: RISK.CRITICAL,
});

// ─── Provenance / trust tiers ────────────────────────────────────────
export const TRUST_TIERS = ['user', 'local-system', 'paired-devices', 'web', 'third-party-agents'];

/** Only these tiers may originate INSTRUCTIONS (as opposed to data). */
export const INSTRUCTION_TIERS = new Set(['user', 'local-system']);

/** Capabilities that must NEVER be reachable from non-instruction provenance. */
export const HIGH_RISK_INTENT = new Set([
  CAPABILITIES.CODE_EXECUTION,
  CAPABILITIES.NETWORK_EXTERNAL,
  CAPABILITIES.CONNECTOR_EXTERNAL_SEND,
  CAPABILITIES.CONNECTOR_DESTRUCTIVE,
  CAPABILITIES.CONNECTOR_CREDENTIAL,
  CAPABILITIES.MCP_ADMIN,
  CAPABILITIES.LEARNING_APPROVE,
  CAPABILITIES.LEARNING_ACTIVATE,
  CAPABILITIES.ADMIN_CONFIG,
  CAPABILITIES.ADMIN_CREDENTIAL,
  CAPABILITIES.ADMIN_SYSTEM,
]);

// ─── Role grants (minimal, deterministic) ────────────────────────────
// admin: everything. user: the working set an authenticated human needs.
// Unauthenticated / unknown roles: nothing.
const ROLE_GRANTS = Object.freeze({
  admin: new Set(Object.values(CAPABILITIES)),
  user: new Set([
    CAPABILITIES.FILESYSTEM_READ,
    CAPABILITIES.FILESYSTEM_WRITE,
    CAPABILITIES.PROCESS_EXECUTION,
    CAPABILITIES.NETWORK_INTERNAL,
    CAPABILITIES.NETWORK_EXTERNAL, // explicit tool capabilities only (web_fetch/web_search, SSRF-guarded)
    CAPABILITIES.CONNECTOR_READ,
    CAPABILITIES.MCP_DISCOVER,
    CAPABILITIES.MCP_CALL,
    CAPABILITIES.LEARNING_OBSERVE,
    CAPABILITIES.LEARNING_PROPOSE,
  ]),
  // Trusted server internals (durable queue, scheduled hooks). Grants the
  // operational capabilities an already-authorized job needs to run its
  // wires — never the admin/identity/credential surface.
  system: new Set([
    CAPABILITIES.FILESYSTEM_READ,
    CAPABILITIES.FILESYSTEM_WRITE,
    CAPABILITIES.PROCESS_EXECUTION,
    CAPABILITIES.CODE_EXECUTION,
    CAPABILITIES.NETWORK_INTERNAL,
    CAPABILITIES.CONNECTOR_READ,
    CAPABILITIES.CONNECTOR_WRITE,
    CAPABILITIES.MCP_DISCOVER,
    CAPABILITIES.MCP_CALL,
    CAPABILITIES.LEARNING_OBSERVE,
    CAPABILITIES.LEARNING_PROPOSE,
    CAPABILITIES.LEARNING_REVIEW,
  ]),
});

export class PolicyError extends Error {
  constructor(decision) {
    super(decision.reason);
    this.name = 'PolicyError';
    this.auditId = decision.auditId;
    this.capability = decision.capability;
    this.allowed = false;
  }
}

/**
 * Deterministic capability decision. Fail-closed.
 *
 * @param {object} req
 * @param {object} [req.actor]          identity: { id, role, type }
 * @param {string} req.capability       one of CAPABILITIES
 * @param {string} [req.resource]       the concrete subject (path, tool, server…)
 * @param {string} [req.scope]          sandbox|home|system
 * @param {string} [req.provenance]     trust tier the instruction came from
 * @param {object} [req.context]        free-form context for reasons/audit
 * @returns {Promise<{allowed:boolean, risk:string, capability:string, reason:string, auditId:string, granted:boolean, provenanceOk:boolean}>}
 */
export async function decide(req = {}) {
  const actor = req.actor || {};
  const capability = req.capability;
  const provenance = TRUST_TIERS.includes(req.provenance) ? req.provenance : 'user';
  const auditId = randomUUID();

  // Fail closed: unknown/unsupported capability.
  if (!capability || !Object.values(CAPABILITIES).includes(capability)) {
    return denied(capability, 'unknown capability', auditId, actor, provenance, req);
  }

  const risk = RISK_BY_CAPABILITY[capability] || RISK.HIGH;

  // Fail closed: unknown/empty role grants nothing.
  const grants = ROLE_GRANTS[actor.role] || new Set();
  const granted = grants.has(capability);
  if (!granted) {
    return denied(
      capability, `role '${actor.role || 'unauthenticated'}' does not grant ${capability}`,
      auditId, actor, provenance, req, risk
    );
  }

  // Provenance gate: high-risk intent is only reachable when the instruction
  // genuinely originates from the user or the local system. External content
  // (web, third-party agents) is data — it cannot become an instruction.
  let provenanceOk = true;
  if (HIGH_RISK_INTENT.has(capability) && !INSTRUCTION_TIERS.has(provenance)) {
    provenanceOk = false;
  }
  if (!provenanceOk) {
    return denied(
      capability,
      `capability denied for provenance '${provenance}' — external content cannot become an instruction`,
      auditId, actor, provenance, req, risk
    );
  }

  return {
    allowed: true,
    granted: true,
    provenanceOk,
    risk,
    capability,
    actor: actor.id || null,
    role: actor.role || null,
    resource: req.resource || null,
    scope: req.scope || null,
    provenance,
    reason: `allowed: ${capability} (risk ${risk})`,
    auditId,
  };
}

/**
 * Throwing convenience for execution boundaries.
 * @returns {Promise<object>} the decision
 * @throws {PolicyError} when denied
 */
export async function enforce(req) {
  const decision = await decide(req);
  if (!decision.allowed) throw new PolicyError(decision);
  return decision;
}

/**
 * Whether an instruction originating from `originTier` may be treated as
 * an instruction (data from external/agent tiers never auto-becomes one).
 * @param {string} originTier  one of TRUST_TIERS
 * @param {object} [opts]      { delegatedBy?: 'user' } explicit delegation
 */
export async function isInstructionAllowed(originTier, opts = {}) {
  if (opts.delegatedBy === 'user') return true;
  return INSTRUCTION_TIERS.has(originTier);
}

/**
 * Drop/reject an instruction from a non-instruction tier. Always returns a
 * failure decision (never throws) so the turn loop can log and continue.
 */
export async function dropInstruction(event, reason = 'origin is not an instruction tier') {
  return denied(null, reason, randomUUID(), { role: 'system' }, 'external');
}

function denied(capability, reason, auditId, actor, provenance, req = {}, risk = RISK.HIGH) {
  return {
    allowed: false,
    granted: false,
    provenanceOk: false,
    risk,
    capability,
    actor: actor?.id || null,
    role: actor?.role || null,
    resource: req?.resource || null,
    scope: req?.scope || null,
    provenance,
    reason,
    auditId,
  };
}