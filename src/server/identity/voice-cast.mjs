/**
 * Cardinal Frame — Voice Cast — Persona to Voice
 *
 * Voice is cast per persona, not per device — the ambient equivalent of the
 * avatar. The companion gets its own persistent voice; Ikaris, Aries, and
 * Minerva each get distinct voices. When the machine speaks unprompted,
 * you know WHO is talking before a word registers.
 *
 * Follows the same activation discipline as avatars: staged, explicitly
 * selected, announced. Household rule: voices stay masculine-presenting.
 * Local TTS (Kokoro) is the default; ElevenLabs is classified overflow.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): identity.mjs, voice/tts-local.mjs, voice/tts-cloud.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export const PERSONAS = ['companion', 'ikaris', 'aries', 'minerva'];
export async function castVoice(persona) {
  notImplemented('castVoice');
}
export async function listVoices() {
  notImplemented('listVoices');
}
export async function selectVoice(persona, voiceId) {
  notImplemented('selectVoice');
}
