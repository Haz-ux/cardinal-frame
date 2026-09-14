/**
 * v2 scaffold test — voice casting.
 * Asserts the new modules import and expose their contract surface.
 * No logic exists yet; these guard the scaffold shape.
 */
import { describe, it, expect } from 'vitest';
import * as voiceCast from '../src/server/identity/voice-cast.mjs';
import * as ttsLocal from '../src/server/voice/tts-local.mjs';
import * as ttsCloud from '../src/server/voice/tts-cloud.mjs';
import * as wakeword from '../src/server/voice/wakeword.mjs';
import * as stt from '../src/server/voice/stt.mjs';

describe('v2 scaffold — voice casting', () => {
  it('exposes the module contract surface', () => {
    expect(typeof voiceCast.castVoice).toBe('function');
    expect(typeof voiceCast.listVoices).toBe('function');
    expect(typeof voiceCast.selectVoice).toBe('function');
    expect(typeof ttsLocal.speak).toBe('function');
    expect(typeof ttsCloud.speak).toBe('function');
    expect(typeof wakeword.start).toBe('function');
    expect(typeof wakeword.onWake).toBe('function');
    expect(typeof stt.transcribe).toBe('function');
  });
});
