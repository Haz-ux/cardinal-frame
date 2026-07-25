/**
 * Tests for Governance Layer (permission enforcement, audit log, persona CRUD, trace_id correlation)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initGovernance, checkPermission, auditLog, canDelegateToNode } from '../src/server/routes/governance.mjs';

let tmpDir, db, stmts;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cf-gov-'));
  db = new Database(join(tmpDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  // Create agents table first — personas has FK reference to it
  db.exec(`CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT)`);
  const governance = initGovernance(db);
  // auditLog expects stmts.governance.audit
  stmts = { governance };
});

afterEach(() => {
  try { db?.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('Governance — Personas', () => {
  it('should create and retrieve a persona', () => {
    stmts.governance.personas.insert.run(
      'persona-test', null, 'Test Persona', 'A test persona',
      JSON.stringify({ identity: 'test-bot' }),
      JSON.stringify(['read', 'write']),
      JSON.stringify([])
    );

    const p = stmts.governance.personas.getById.get('persona-test');
    expect(p).toBeDefined();
    expect(p.name).toBe('Test Persona');
    expect(p.description).toBe('A test persona');
    expect(JSON.parse(p.permissions)).toEqual(['read', 'write']);
    expect(p.enabled).toBe(1);
  });

  it('should update a persona', () => {
    stmts.governance.personas.insert.run(
      'persona-update', null, 'Original', 'desc',
      JSON.stringify({}), JSON.stringify([]), JSON.stringify([])
    );

    stmts.governance.personas.update.run(
      'Updated', 'new desc',
      JSON.stringify({ identity: 'updated' }),
      JSON.stringify(['read']),
      JSON.stringify(['no-rm']),
      0, // disabled
      'persona-update'
    );

    const p = stmts.governance.personas.getById.get('persona-update');
    expect(p.name).toBe('Updated');
    expect(p.description).toBe('new desc');
    expect(p.enabled).toBe(0);
    expect(JSON.parse(p.permissions)).toEqual(['read']);
    expect(JSON.parse(p.constraints)).toEqual(['no-rm']);
  });

  it('should delete a persona', () => {
    stmts.governance.personas.insert.run(
      'persona-del', null, 'ToDelete', '', '{}', '[]', '[]'
    );
    expect(stmts.governance.personas.getById.get('persona-del')).toBeDefined();

    stmts.governance.personas.delete.run('persona-del');
    expect(stmts.governance.personas.getById.get('persona-del')).toBeUndefined();
  });

  it('should list all personas', () => {
    stmts.governance.personas.insert.run('p1', null, 'One', '', '{}', '[]', '[]');
    stmts.governance.personas.insert.run('p2', null, 'Two', '', '{}', '[]', '[]');

    const all = stmts.governance.personas.getAll.all();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.map(p => p.name)).toContain('One');
    expect(all.map(p => p.name)).toContain('Two');
  });
});

describe('Governance — checkPermission', () => {
  it('should allow all actions when no persona is set', () => {
    const result = checkPermission(null, 'rm -rf /');
    expect(result.allowed).toBe(true);
  });

  it('should allow all actions when persona is disabled', () => {
    const persona = { enabled: 0, permissions: '[]', constraints: '[]', soul: '{}' };
    expect(checkPermission(persona, 'anything').allowed).toBe(true);
  });

  it('should deny actions matching constraint patterns', () => {
    const persona = {
      enabled: 1,
      permissions: '[]',
      constraints: JSON.stringify(['rm\\s', 'sudo']),
      soul: '{}',
    };
    expect(checkPermission(persona, 'rm -rf /').allowed).toBe(false);
    expect(checkPermission(persona, 'sudo apt install').allowed).toBe(false);
    expect(checkPermission(persona, 'ls -la').allowed).toBe(true);
  });

  it('should require approval for escalation commands', () => {
    const persona = {
      enabled: 1,
      permissions: '[]',
      constraints: '[]',
      soul: JSON.stringify({
        escalation: {
          require_approval_for: ['rm', 'sudo', 'chmod'],
          auto_approve: ['echo', 'ls'],
        },
      }),
    };
    const rmResult = checkPermission(persona, 'rm file.txt');
    expect(rmResult.allowed).toBe(false);
    expect(rmResult.requiresApproval).toBe(true);

    const echoResult = checkPermission(persona, 'echo hello');
    expect(echoResult.allowed).toBe(true);
  });

  it('should deny actions not in explicit permissions list', () => {
    const persona = {
      enabled: 1,
      permissions: JSON.stringify(['read', 'write', 'execute']),
      constraints: '[]',
      soul: '{}',
    };
    expect(checkPermission(persona, 'read').allowed).toBe(true);
    expect(checkPermission(persona, 'write').allowed).toBe(true);
    expect(checkPermission(persona, 'delete').allowed).toBe(false);
  });

  it('should allow all when permissions list is empty (no restriction)', () => {
    const persona = {
      enabled: 1,
      permissions: '[]',
      constraints: '[]',
      soul: '{}',
    };
    expect(checkPermission(persona, 'any-action').allowed).toBe(true);
  });
});

describe('Governance — Audit Log', () => {
  it('should insert and retrieve audit entries', () => {
    auditLog(stmts, 'admin', 'persona:create', 'persona-1', { name: 'Test' });
    auditLog(stmts, 'admin', 'persona:update', 'persona-1', { name: 'Updated' });

    const entries = stmts.governance.audit.getAll.all(100);
    expect(entries.length).toBe(2);
    expect(entries[0].actor).toBe('admin');
    // getAll orders by ts DESC — most recent first
    const actions = entries.map(e => e.action);
    expect(actions).toContain('persona:create');
    expect(actions).toContain('persona:update');
  });

  it('should filter audit entries by actor', () => {
    auditLog(stmts, 'admin', 'action1', null, {});
    auditLog(stmts, 'user1', 'action2', null, {});
    auditLog(stmts, 'user1', 'action3', null, {});

    const adminEntries = stmts.governance.audit.getByActor.all('admin', 100);
    const userEntries = stmts.governance.audit.getByActor.all('user1', 100);
    expect(adminEntries.length).toBe(1);
    expect(userEntries.length).toBe(2);
  });

  it('should store and query by trace_id', () => {
    auditLog(stmts, 'system', 'sandbox:execute', 'python3', { code: 'print(1)' }, 'trace-abc-123');
    auditLog(stmts, 'system', 'chain:step', 'step-0', { action: 'echo' }, 'trace-abc-123');
    auditLog(stmts, 'system', 'other', null, {}, 'trace-def-456');

    const traces = stmts.governance.audit.getByTrace.all('trace-abc-123');
    expect(traces.length).toBe(2);
    expect(traces[0].trace_id).toBe('trace-abc-123');
  });

  it('should serialize details as JSON', () => {
    auditLog(stmts, 'admin', 'test', 'target', { key: 'value', nested: { num: 42 } });

    const entries = stmts.governance.audit.getAll.all(100);
    const details = JSON.parse(entries[0].details);
    expect(details.key).toBe('value');
    expect(details.nested.num).toBe(42);
  });

  it('should not throw when audit log fails (non-critical)', () => {
    // Passing invalid stmts — should not throw
    expect(() => auditLog({}, 'x', 'y', null, {})).not.toThrow();
  });
});

describe('Governance — canDelegateToNode', () => {
  it('should deny delegation when persona has no node_permissions (default: local only)', () => {
    const persona = { enabled: 1, soul: JSON.stringify({ node_permissions: [] }) };
    const result = canDelegateToNode(persona, 'IKARIS');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('local only');
  });

  it('should deny delegation when persona is null (no persona)', () => {
    const result = canDelegateToNode(null, 'IKARIS');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No persona');
  });

  it('should deny delegation when persona is disabled', () => {
    const persona = { enabled: 0, soul: JSON.stringify({ node_permissions: ['any'] }) };
    const result = canDelegateToNode(persona, 'IKARIS');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No persona');
  });

  it('should deny delegation when node_permissions is omitted from SOUL doc', () => {
    const persona = { enabled: 1, soul: JSON.stringify({ identity: 'test' }) };
    const result = canDelegateToNode(persona, 'IKARIS');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No node_permissions');
  });

  it('should allow delegation when node_permissions includes "any"', () => {
    const persona = { enabled: 1, soul: JSON.stringify({ node_permissions: ['any'] }) };
    const result = canDelegateToNode(persona, 'IKARIS');
    expect(result.allowed).toBe(true);
  });

  it('should allow delegation when node_permissions includes "*"', () => {
    const persona = { enabled: 1, soul: JSON.stringify({ node_permissions: ['*'] }) };
    const result = canDelegateToNode(persona, 'ARIES');
    expect(result.allowed).toBe(true);
  });

  it('should allow delegation when target node is listed in node_permissions', () => {
    const persona = { enabled: 1, soul: JSON.stringify({ node_permissions: ['ikaris', 'aries'] }) };
    expect(canDelegateToNode(persona, 'IKARIS').allowed).toBe(true);
    expect(canDelegateToNode(persona, 'ARIES').allowed).toBe(true);
  });

  it('should deny delegation when target node is NOT in node_permissions', () => {
    const persona = { enabled: 1, soul: JSON.stringify({ node_permissions: ['ikaris'] }) };
    const result = canDelegateToNode(persona, 'MINERVA');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('MINERVA');
    expect(result.reason).toContain('ikaris');
  });

  it('should be case-insensitive for node name matching', () => {
    const persona = { enabled: 1, soul: JSON.stringify({ node_permissions: ['ikaris'] }) };
    expect(canDelegateToNode(persona, 'IKARIS').allowed).toBe(true);
    expect(canDelegateToNode(persona, 'ikaris').allowed).toBe(true);
    expect(canDelegateToNode(persona, 'Ikaris').allowed).toBe(true);
  });

  it('should support camelCase nodePermissions as alternative key', () => {
    const persona = { enabled: 1, soul: JSON.stringify({ nodePermissions: ['ikaris'] }) };
    expect(canDelegateToNode(persona, 'IKARIS').allowed).toBe(true);
  });
});
