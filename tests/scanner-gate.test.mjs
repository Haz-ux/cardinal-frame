import { describe, it, expect } from 'vitest';
import { runScannerGate } from '../src/server/skill-scanner-gate.mjs';

const noop = () => {};

function baseCtx(overrides = {}) {
  return {
    db: { prepare: () => ({ get: () => ('scannerRow' in overrides ? overrides.scannerRow : { id: 's', name: 'skill-scanner', enabled: 1 }) }) },
    stmts: { skills: { getByName: { get: () => overrides.scannerSkill ?? { id: 's', name: 'skill-scanner', handler: 'async () => ({})' } } } },
    executeSkill: overrides.executeSkill ?? (async () => ({ ok: true, output: { verdict: 'safe', blocked: false } })),
    logger: { warn: noop, error: noop, info: noop },
    auditLog: noop,
    ...overrides,
  };
}

describe('skill-scanner gate', () => {
  it('passes a clean scan through', async () => {
    const out = await runScannerGate(baseCtx(), 'return 1 + 1;', 'ok-skill');
    expect(out.blocked).toBe(false);
    expect(out.verdict).toBe('safe');
  });

  it('blocks on an explicit blocked verdict', async () => {
    const ctx = baseCtx({
      executeSkill: async () => ({ ok: true, output: { verdict: 'blocked', blocked: true, risk_score: 4, reasons: ['x'] } }),
    });
    const out = await runScannerGate(ctx, 'child_process', 'evil-skill');
    expect(out.blocked).toBe(true);
    expect(out.verdict).toBe('blocked');
    expect(out.details.reasons).toEqual(['x']);
  });

  it('fails open when the scanner skill is not installed', async () => {
    const ctx = baseCtx({ scannerRow: null });
    const out = await runScannerGate(ctx, 'anything', 'x');
    expect(out.blocked).toBe(false);
    expect(out.verdict).toBe('no_scanner');
  });

  it('fails open when the scanner skill is disabled', async () => {
    const ctx = baseCtx({ scannerRow: { id: 's', name: 'skill-scanner', enabled: 0 } });
    const out = await runScannerGate(ctx, 'anything', 'x');
    expect(out.blocked).toBe(false);
    expect(out.verdict).toBe('scanner_disabled');
  });

  it('FAILS CLOSED when the installed+enabled scanner errors', async () => {
    const ctx = baseCtx({
      executeSkill: async () => { throw new Error('boom'); },
    });
    const out = await runScannerGate(ctx, 'something', 'crashy-skill');
    expect(out.blocked).toBe(true);
    expect(out.verdict).toBe('scanner_error');
    expect(out.details.error).toContain('boom');
  });

  it('returns no_source verdict when source is missing', async () => {
    const out = await runScannerGate(baseCtx(), '', 'empty');
    expect(out.blocked).toBe(false);
    expect(out.verdict).toBe('no_source');
  });
});
