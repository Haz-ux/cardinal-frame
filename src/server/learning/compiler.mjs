/**
 * Cardinal Frame — Skill Compiler — Evidence to Candidates
 *
 * Turns validated learning evidence into skill candidates. Heavy compilations
 * are the canonical Qwen 2.5 Coder 7B workload on the compute ladder — the
 * compile step is where the big local model earns its keep.
 *
 * Output is a candidate, never an installed skill: the curator owns
 * promotion.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): learning/events.mjs, llm/provider-runtime.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function compile(evidence) {
  notImplemented('compile');
}
