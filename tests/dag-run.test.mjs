/**
 * Unit tests for the shared DAG executor's task-node execution (dag-run.mjs).
 *
 * M1 (audit 2026-09-13 v2): task nodes must run shell-free via spawnArgv
 * (shell:false), with the sanitizer's args passed through — never dropped —
 * and shell metacharacters rejected before execution.
 */
import { describe, it, expect } from 'vitest';
import { rmSync, existsSync } from 'fs';
import { runNode } from '../src/server/dag-run.mjs';
import { sanitizeCommand } from '../src/server/command-safety.mjs';

function baseCtx() {
  return {
    sanitizeCommand,
    timeoutMs: 10000,
    resultsById: new Map(),
    upstream: [],
    $: {},
  };
}

describe('dag-run task nodes (M1)', () => {
  it('passes sanitizer args through to execution (echo hello -> "hello")', async () => {
    const r = await runNode({ id: 'n1', type: 'task', name: 'Echo', command: 'echo hello' }, baseCtx());
    expect(r.status).toBe('success');
    expect(r.output).toBe('hello');
  });

  it('rejects shell metacharacters without executing anything', async () => {
    const pwn = '/tmp/pwned-dagrun-vitest';
    rmSync(pwn, { force: true });
    const r = await runNode({ id: 'n2', type: 'task', name: 'Evil', command: `echo $(touch ${pwn})` }, baseCtx());
    expect(r.status).toBe('failed');
    expect(r.error || '').toMatch(/metachar/i);
    expect(existsSync(pwn)).toBe(false);
  });

  it('rejects non-allowlisted commands', async () => {
    const r = await runNode({ id: 'n3', type: 'task', name: 'Bad', command: 'rm -rf /tmp/x' }, baseCtx());
    expect(r.status).toBe('failed');
  });

  it('skips task nodes with no command', async () => {
    const r = await runNode({ id: 'n4', type: 'task', name: 'Empty', command: '' }, baseCtx());
    expect(r.status).toBe('skipped');
  });
});
