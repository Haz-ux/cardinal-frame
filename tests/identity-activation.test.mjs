/**
 * v2 scaffold test — identity activation.
 * Asserts the new modules import and expose their contract surface.
 * No logic exists yet; these guard the scaffold shape.
 */
import { describe, it, expect } from 'vitest';
import * as identity from '../src/server/identity/identity.mjs';
import * as activation from '../src/server/identity/activation.mjs';
import * as archive from '../src/server/identity/archive.mjs';
import * as announce from '../src/server/identity/announce.mjs';

describe('v2 scaffold — identity activation', () => {
  it('exposes the module contract surface', () => {
    expect(typeof identity.getIdentity).toBe('function');
    expect(typeof identity.updateIdentity).toBe('function');
    expect(typeof activation.getPending).toBe('function');
    expect(typeof activation.getActive).toBe('function');
    expect(typeof activation.activate).toBe('function');
    expect(typeof archive.listHistory).toBe('function');
    expect(typeof archive.restore).toBe('function');
    expect(typeof announce.announce).toBe('function');
  });
});
