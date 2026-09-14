/**
 * Cardinal Frame — TTS Local — Kokoro On-Box Voice
 *
 * The default voice path: Kokoro TTS (82M params, ~300MB) running on the
 * box. The natural-voice pick — intelligible AND human-sounding in short,
 * purposeful utterances. Spoken interactions are designed short: the voice
 * earns trust in bursts; long-form stays in text.
 *
 * Voice profiles come from identity/voice-cast.mjs: the companion keeps one
 * voice; crew modes use subtle variants of it.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): identity/voice-cast.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function speak(text, voiceProfile) {
  notImplemented('speak');
}
