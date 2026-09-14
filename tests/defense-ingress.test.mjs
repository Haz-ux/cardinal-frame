/**
 * v2 scaffold test — defense ingress.
 * Asserts the new modules import and expose their contract surface.
 * No logic exists yet; these guard the scaffold shape.
 */
import { describe, it, expect } from 'vitest';
import * as provenance from '../src/server/defense/provenance.mjs';
import * as policy from '../src/server/defense/policy.mjs';
import * as ingress from '../src/server/defense/ingress.mjs';

describe('v2 scaffold — defense ingress', () => {
  it('exposes the module contract surface', () => {
    expect(typeof provenance.tierOf).toBe('function');
    expect(typeof provenance.tag).toBe('function');
    expect(typeof policy.enforce).toBe('function');
    expect(typeof policy.isInstructionAllowed).toBe('function');
    expect(typeof policy.dropInstruction).toBe('function');
    expect(typeof ingress.screen).toBe('function');
  });
});
