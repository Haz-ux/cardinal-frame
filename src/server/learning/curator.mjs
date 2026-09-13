/**
 * Cardinal Frame — Curator — Promotion Gate
 *
 * The promotion gate: candidate -> validated -> installed. Nothing reaches
 * the skill set without passing review, validation runs, and an explicit
 * promotion decision. This is where "the machine improves itself" stays
 * auditable instead of feral.
 *
 * The neural map renders this lifecycle live: a skill being born is a node
 * appearing on the map.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): learning/events.mjs, skill-safety.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function review(candidate) {
  notImplemented('review');
}
export async function promote(id) {
  notImplemented('promote');
}
export async function reject(id, reason) {
  notImplemented('reject');
}
