/**
 * Cardinal Frame — Canaries — Extraction Detection
 *
 * Unique tokens planted in memory stores. If a canary appears in outbound
 * content, that is a compromise signal — straight to the audit log. Turns
 * extraction attempts into detection events instead of silent leaks.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): defense/egress.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function plant(store) {
  notImplemented('plant');
}
export async function scan(outbound) {
  notImplemented('scan');
}
export async function listCanaries() {
  notImplemented('listCanaries');
}
