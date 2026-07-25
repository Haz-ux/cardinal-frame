/**
 * Tests for Node Identity — Ed25519 keypair generation, persistence, signing/verification
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getOrCreateNodeIdentity, signPayload, verifyPayload, getNodeId } from '../src/server/node-identity.mjs';

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
});

describe('Node Identity — getOrCreateNodeIdentity', () => {
  it('should generate a new identity on first call', () => {
    const identity = getOrCreateNodeIdentity(db);

    expect(identity.node_id).toBeTypeOf('string');
    expect(identity.node_id).toHaveLength(64); // sha256 hex
    expect(identity.public_key_pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(identity.private_key_pem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(identity.created_at).toBeTruthy();
  });

  it('should persist identity across simulated restarts (same DB)', () => {
    const first = getOrCreateNodeIdentity(db);

    // Simulate restart — same DB, new process
    const second = getOrCreateNodeIdentity(db);

    expect(second.node_id).toBe(first.node_id);
    expect(second.public_key_pem).toBe(first.public_key_pem);
    expect(second.private_key_pem).toBe(first.private_key_pem);
  });

  it('should not regenerate if identity already exists', () => {
    const first = getOrCreateNodeIdentity(db);
    const second = getOrCreateNodeIdentity(db);
    const third = getOrCreateNodeIdentity(db);

    expect(third.node_id).toBe(first.node_id);
    expect(third.public_key_pem).toBe(first.public_key_pem);
  });

  it('should produce different identities for different databases (different nodes)', () => {
    const db2 = new Database(':memory:');
    const identity1 = getOrCreateNodeIdentity(db);
    const identity2 = getOrCreateNodeIdentity(db2);

    expect(identity1.node_id).not.toBe(identity2.node_id);
    expect(identity1.public_key_pem).not.toBe(identity2.public_key_pem);

    db2.close();
  });

  it('should store exactly one identity row in node_identity table', () => {
    getOrCreateNodeIdentity(db);
    getOrCreateNodeIdentity(db);
    getOrCreateNodeIdentity(db);

    const rows = db.prepare('SELECT * FROM node_identity').all();
    expect(rows).toHaveLength(1);
  });
});

describe('Node Identity — signPayload / verifyPayload', () => {
  it('should sign a payload and verify it with the correct public key', () => {
    const identity = getOrCreateNodeIdentity(db);
    const payload = { task: 'echo hello', agentId: 'aimi', timestamp: Date.now() };

    const signature = signPayload(identity.private_key_pem, payload);
    expect(signature).toBeTypeOf('string');
    expect(signature).toHaveLength(86); // Ed25519 sig = 64 bytes, base64url = 86 chars

    const isValid = verifyPayload(identity.public_key_pem, payload, signature);
    expect(isValid).toBe(true);
  });

  it('should fail verification with a different public key', () => {
    const db2 = new Database(':memory:');
    const identity1 = getOrCreateNodeIdentity(db);
    const identity2 = getOrCreateNodeIdentity(db2);

    const payload = { task: 'echo hello' };
    const signature = signPayload(identity1.private_key_pem, payload);

    // Verify with identity2's public key — should fail
    const isValid = verifyPayload(identity2.public_key_pem, payload, signature);
    expect(isValid).toBe(false);

    db2.close();
  });

  it('should fail verification with tampered payload', () => {
    const identity = getOrCreateNodeIdentity(db);
    const originalPayload = { task: 'echo hello', agentId: 'aimi' };
    const tamperedPayload = { task: 'echo malicious', agentId: 'aimi' };

    const signature = signPayload(identity.private_key_pem, originalPayload);

    const isValid = verifyPayload(identity.public_key_pem, tamperedPayload, signature);
    expect(isValid).toBe(false);
  });

  it('should fail verification with tampered signature', () => {
    const identity = getOrCreateNodeIdentity(db);
    const payload = { task: 'echo hello' };
    const signature = signPayload(identity.private_key_pem, payload);

    // Tamper with signature
    const tamperedSig = signature.slice(0, -4) + 'AAAA';
    const isValid = verifyPayload(identity.public_key_pem, payload, tamperedSig);
    expect(isValid).toBe(false);
  });

  it('should fail verification with invalid signature format', () => {
    const identity = getOrCreateNodeIdentity(db);
    const payload = { task: 'echo hello' };

    const isValid = verifyPayload(identity.public_key_pem, payload, 'invalid-signature-not-base64url');
    expect(isValid).toBe(false);
  });

  it('should handle various payload types (string, number, array, nested object)', () => {
    const identity = getOrCreateNodeIdentity(db);

    const payloads = [
      'simple string',
      42,
      [1, 2, 3],
      { nested: { deep: { value: true } } },
      { task: 'echo', args: ['--flag', 'value'], meta: { source: 'test' } },
    ];

    for (const payload of payloads) {
      const sig = signPayload(identity.private_key_pem, payload);
      const ok = verifyPayload(identity.public_key_pem, payload, sig);
      expect(ok).toBe(true);
    }
  });

  it('should fail verification against wrong key (simulated spoofing)', () => {
    const db2 = new Database(':memory:');
    const spoofed = getOrCreateNodeIdentity(db2);
    const legitimate = getOrCreateNodeIdentity(db);

    const payload = { delegation_id: 'test-123', command: 'run task' };

    // Sign with spoofed node's key
    const spoofedSig = signPayload(spoofed.private_key_pem, payload);

    // Should fail when verified against the legitimate node's key
    const isValid = verifyPayload(legitimate.public_key_pem, payload, spoofedSig);
    expect(isValid).toBe(false);

    db2.close();
  });
});

describe('Node Identity — getNodeId', () => {
  it('should return null before identity is created', () => {
    expect(getNodeId(db)).toBeNull();
  });

  it('should return the node_id after creation', () => {
    const identity = getOrCreateNodeIdentity(db);
    const nodeId = getNodeId(db);
    expect(nodeId).toBe(identity.node_id);
  });

  it('should not return the private key', () => {
    getOrCreateNodeIdentity(db);
    const nodeId = getNodeId(db);
    expect(nodeId).not.toContain('PRIVATE KEY');
    expect(nodeId).not.toContain('PUBLIC KEY');
  });
});
