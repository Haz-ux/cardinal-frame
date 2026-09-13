/**
 * Cardinal Frame — Identity — Singleton Companion Record
 *
 * One server-managed identity, shared across all clients. Carries the name,
 * character anchor, vibe, color language, style anchors, the active avatar
 * reference, and the voice profile.
 *
 * Kept strictly separate from src/server/node-identity.mjs: cryptographic
 * node identity is not persona identity, and the two must never merge.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): migrations/017_identity.sql
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function getIdentity() {
  notImplemented('getIdentity');
}
export async function updateIdentity(patch) {
  notImplemented('updateIdentity');
}
export async function resetToDefault() {
  notImplemented('resetToDefault');
}
