/**
 * Cardinal Frame — Avatar Activation — Explicit User Pick
 *
 * No candidate goes live without the user choosing it. Activation is a
 * separate, deliberate step: the user picks from staged candidates, the
 * pick is recorded, and announce.mjs tells the story in first person.
 *
 * This is the consent gate for the companion face — the machine never
 * re-faces itself unprompted.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): identity.mjs, avatar-create.mjs, announce.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function getPending() {
  notImplemented('getPending');
}
export async function getActive() {
  notImplemented('getActive');
}
export async function activate(candidateId) {
  notImplemented('activate');
}
