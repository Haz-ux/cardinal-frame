/**
 * Cardinal Frame — Companion — Singleton Presence (Pillar 1)
 *
 * One companion per user. It owns the name, the avatar, the voice, and the
 * shared history. Everything else — Aimi, Cipher, Ghost — is crew: specialist
 * modes the companion delegates to behind a single face.
 *
 * Position in the turn loop: after defense/policy, before the model. The
 * companion loads relationship memory, runs the model call, and writes back.
 * It never observes, authors, approves, and runs in one path — separation
 * of powers is structural.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): relationship.mjs, modes.mjs, defense/policy.mjs, memory/fastpath.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function getCompanion() {
  notImplemented('getCompanion');
}
export async function handleTurn(event) {
  notImplemented('handleTurn');
}
export async function delegateTo(mode, task) {
  notImplemented('delegateTo');
}
