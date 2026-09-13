/**
 * v2 scaffold test — defense egress + canaries + learning/memory.
 * Asserts the new modules import and expose their contract surface.
 * No logic exists yet; these guard the scaffold shape.
 */
import { describe, it, expect } from 'vitest';
import * as egress from '../src/server/defense/egress.mjs';
import * as canaries from '../src/server/defense/canaries.mjs';
import * as events from '../src/server/learning/events.mjs';
import * as compiler from '../src/server/learning/compiler.mjs';
import * as curator from '../src/server/learning/curator.mjs';
import * as daemon from '../src/server/learning/daemon.mjs';
import * as fastpath from '../src/server/memory/fastpath.mjs';

describe('v2 scaffold — defense egress + canaries + learning/memory', () => {
  it('exposes the module contract surface', () => {
    expect(typeof egress.classify).toBe('function');
    expect(typeof egress.authorize).toBe('function');
    expect(typeof canaries.plant).toBe('function');
    expect(typeof canaries.scan).toBe('function');
    expect(typeof events.record).toBe('function');
    expect(typeof events.list).toBe('function');
    expect(typeof compiler.compile).toBe('function');
    expect(typeof curator.review).toBe('function');
    expect(typeof curator.promote).toBe('function');
    expect(typeof curator.reject).toBe('function');
    expect(typeof daemon.start).toBe('function');
    expect(typeof daemon.runOnce).toBe('function');
    expect(typeof fastpath.commitFact).toBe('function');
    expect(typeof fastpath.confirm).toBe('function');
  });
});
