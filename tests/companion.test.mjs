/**
 * v2 scaffold test — companion pillar.
 * Asserts the new modules import and expose their contract surface.
 * No logic exists yet; these guard the scaffold shape.
 */
import { describe, it, expect } from 'vitest';
import * as companion from '../src/server/companion/companion.mjs';
import * as relationship from '../src/server/companion/relationship.mjs';
import * as presence from '../src/server/companion/presence.mjs';
import * as modes from '../src/server/companion/modes.mjs';

describe('v2 scaffold — companion pillar', () => {
  it('exposes the module contract surface', () => {
    expect(typeof companion.getCompanion).toBe('function');
    expect(typeof companion.handleTurn).toBe('function');
    expect(typeof companion.delegateTo).toBe('function');
    expect(typeof relationship.loadRelationship).toBe('function');
    expect(typeof relationship.writeBack).toBe('function');
    expect(typeof presence.evaluateInterruption).toBe('function');
    expect(typeof presence.surface).toBe('function');
    expect(typeof modes.listModes).toBe('function');
    expect(typeof modes.getMode).toBe('function');
    expect(typeof modes.delegate).toBe('function');
  });
});
