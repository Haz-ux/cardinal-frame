/**
 * Cardinal Frame — Avatar Create — Prompt Builder + Staged Candidates
 *
 * The quality gap in generated avatars is the prompt, not the pipeline.
 * This module turns sanitized identity traits into art direction: character
 * as portrait subject, vibe mapped to a lighting brief, palette lock from
 * colorLanguage, style anchors appended verbatim, a fixed negative prompt,
 * and fixed square head-and-shoulders composition.
 *
 * The master is generated on the best reachable model; candidates are
 * STAGED, never auto-activated — activation.mjs owns going live.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): identity.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function buildPrompt(traits) {
  notImplemented('buildPrompt');
}
export async function stageCandidates(count = 4) {
  notImplemented('stageCandidates');
}
export async function getStaged() {
  notImplemented('getStaged');
}
