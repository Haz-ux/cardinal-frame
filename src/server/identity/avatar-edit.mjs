/**
 * Cardinal Frame — Avatar Edit — Restyle vs Replace
 *
 * Restyle and replace are different operations with different risk. A restyle
 * is an edit of the master (same face, new treatment); a replace starts a
 * new master lineage and archives the old one.
 *
 * Every later generation is conditioned on the master — IP-Adapter,
 * character reference, or tiny LoRA depending on backend. The prompt
 * changes; the face does not. Fresh unconditioned generation is how you
 * get a stranger.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): identity.mjs, avatar-create.mjs, archive.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function restyle(params) {
  notImplemented('restyle');
}
export async function replace(params) {
  notImplemented('replace');
}
