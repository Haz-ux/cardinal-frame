/**
 * Cardinal Frame — Presence — Proactive Engine
 *
 * Presence is what makes the companion feel like EDI instead of a chatbot.
 * It consumes scheduling/crons.mjs (time) and scheduling/hooks.mjs (events)
 * and applies an interruption policy: importance x timeliness x user
 * receptivity. Most things stay quiet; the right things interrupt.
 *
 * Drives the AI on-call money loop: a hook fires, Ghost investigates in the
 * sandbox, presence decides the finding is worth interrupting the user.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): scheduling/crons.mjs, scheduling/hooks.mjs, surfaces/telegram.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function evaluateInterruption(event) {
  notImplemented('evaluateInterruption');
}
export async function surface(finding) {
  notImplemented('surface');
}
export async function setReceptivity(level) {
  notImplemented('setReceptivity');
}
