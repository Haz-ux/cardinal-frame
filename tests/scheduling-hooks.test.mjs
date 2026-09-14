/**
 * v2 scaffold test — scheduling + hooks.
 * Asserts the new modules import and expose their contract surface.
 * No logic exists yet; these guard the scaffold shape.
 */
import { describe, it, expect } from 'vitest';
import * as crons from '../src/server/scheduling/crons.mjs';
import * as hooks from '../src/server/scheduling/hooks.mjs';
import * as telegram from '../src/server/surfaces/telegram.mjs';
import * as n8n from '../src/server/integrations/n8n.mjs';

describe('v2 scaffold — scheduling + hooks', () => {
  it('exposes the module contract surface', () => {
    expect(typeof crons.schedule).toBe('function');
    expect(typeof crons.cancel).toBe('function');
    expect(typeof crons.list).toBe('function');
    expect(typeof hooks.on).toBe('function');
    expect(typeof hooks.off).toBe('function');
    expect(typeof hooks.emit).toBe('function');
    expect(typeof telegram.start).toBe('function');
    expect(typeof telegram.sendMessage).toBe('function');
    expect(typeof telegram.onCallback).toBe('function');
    expect(typeof n8n.dispatch).toBe('function');
    expect(typeof n8n.handleWebhook).toBe('function');
  });
});
