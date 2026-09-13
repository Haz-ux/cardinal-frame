/**
 * Cardinal Frame — TTS Cloud — ElevenLabs Overflow
 *
 * Cloud overflow for moments where maximum naturalness matters — the sev-1
 * call you really do not want sounding synthetic. Same rule as the NVIDIA
 * compute tier: voice data is classified by defense/egress.mjs before
 * leaving, and this is a fallback, not the default. Try local until local
 * visibly loses.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): defense/egress.mjs, identity/voice-cast.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function speak(text, voiceProfile) {
  notImplemented('speak');
}
