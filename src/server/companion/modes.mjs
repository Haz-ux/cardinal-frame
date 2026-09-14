/**
 * Cardinal Frame — Crew Modes — Aimi / Cipher / Ghost
 *
 * Modes, not personas. Aimi (operator), Cipher (analyst), Ghost (code) are
 * specialist modes the one companion delegates to. The user talks to one
 * face; the work fans out behind it.
 *
 * Existing src/server/personas.mjs becomes the mode registry data — this
 * module is the delegation surface over it.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): personas.mjs (mode data)
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export const MODES = ['aimi', 'cipher', 'ghost'];
// NOTE(v2): identity/voice-cast.mjs keeps a separate PERSONAS list.
// Unify on a single cast roster when implementing — do not let these drift.
export async function listModes() {
  notImplemented('listModes');
}
export async function getMode(name) {
  notImplemented('getMode');
}
export async function delegate(mode, task) {
  notImplemented('delegate');
}
