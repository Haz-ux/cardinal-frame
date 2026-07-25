/**
 * Cardinal Frame — Self-Generated Cryptographic Node Identity
 *
 * Each node generates an Ed25519 keypair on first boot. The node's ID is
 * derived as sha256(public_key_pem) — provably tied to the keypair, not
 * a chosen name. The private key never leaves this node.
 *
 * Adapted from OpenClaw's device-identity-store pattern, simplified for
 * a 3-node personal system (no coordinator/migration machinery).
 *
 * Usage:
 *   import { getOrCreateNodeIdentity, signPayload, verifyPayload } from './node-identity.mjs';
 *   const identity = getOrCreateNodeIdentity(db);
 *   const sig = signPayload(identity.private_key_pem, payload);
 *   const ok = verifyPayload(identity.public_key_pem, payload, sig);
 */

import { generateKeyPairSync, createHash, sign, verify } from 'node:crypto';

/**
 * Get the existing node identity from the DB, or generate a new one.
 * Once created, a node's identity is stable across restarts — never regenerated.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ node_id: string, public_key_pem: string, private_key_pem: string, created_at: string }}
 */
export function getOrCreateNodeIdentity(db) {
  // Ensure schema exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_identity (
      node_id TEXT PRIMARY KEY,
      public_key_pem TEXT NOT NULL,
      private_key_pem TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const existing = db.prepare('SELECT * FROM node_identity LIMIT 1').get();
  if (existing) return existing;

  // Generate Ed25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // Derive node ID from public key
  const nodeId = createHash('sha256').update(publicKeyPem).digest('hex');

  db.prepare(
    "INSERT INTO node_identity (node_id, public_key_pem, private_key_pem, created_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(nodeId, publicKeyPem, privateKeyPem);

  return { node_id: nodeId, public_key_pem: publicKeyPem, private_key_pem: privateKeyPem, created_at: new Date().toISOString() };
}

/**
 * Sign a payload with this node's private key.
 * Returns a base64url-encoded signature.
 *
 * @param {string} privateKeyPem — PEM-encoded Ed25519 private key
 * @param {*} payload — any JSON-serializable value
 * @returns {string} base64url signature
 */
export function signPayload(privateKeyPem, payload) {
  return sign(null, Buffer.from(JSON.stringify(payload)), privateKeyPem).toString('base64url');
}

/**
 * Verify a signed payload against a public key.
 *
 * @param {string} publicKeyPem — PEM-encoded Ed25519 public key
 * @param {*} payload — the original payload (will be JSON-serialized for comparison)
 * @param {string} signature — base64url-encoded signature
 * @returns {boolean} true if the signature is valid
 */
export function verifyPayload(publicKeyPem, payload, signature) {
  try {
    return verify(
      null,
      Buffer.from(JSON.stringify(payload)),
      publicKeyPem,
      Buffer.from(signature, 'base64url')
    );
  } catch {
    return false;
  }
}

/**
 * Get the node ID only (without exposing the private key).
 * Useful for logging and registry entries.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string|null} node_id or null if no identity exists yet
 */
export function getNodeId(db) {
  try {
    const row = db.prepare('SELECT node_id FROM node_identity LIMIT 1').get();
    return row?.node_id || null;
  } catch {
    // Table doesn't exist yet — no identity created
    return null;
  }
}
