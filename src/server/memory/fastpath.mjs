/**
 * Cardinal Frame — Memory Fastpath — Synchronous Fact Commit
 *
 * Write-first memory, borrowed from the Muse framework: facts are committed
 * synchronously (flagged provisional) BEFORE the reply goes out, and a
 * background daemon confirms them. The companion never "forgets what just
 * happened" because the write raced the response.
 *
 * Relationship write-back follows the same discipline via
 * companion/relationship.mjs.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): companion/relationship.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function commitFact(fact) {
  notImplemented('commitFact');
}
export async function confirm(id) {
  notImplemented('confirm');
}
export async function getPending() {
  notImplemented('getPending');
}
