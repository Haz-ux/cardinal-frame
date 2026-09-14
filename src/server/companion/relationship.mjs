/**
 * Cardinal Frame — Relationship Memory — Shared History
 *
 * Relationship memory is NOT semantic memory. Semantic memory holds facts
 * about the world; relationship memory holds the shared history: what the
 * user and companion have been through together, what it knows without
 * asking, what it got wrong and corrected.
 *
 * Stored separately (see 018_relationship.sql), loaded every turn, written
 * back every turn — write-first, like the memory fastpath.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): memory/fastpath.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function loadRelationship(userId) {
  notImplemented('loadRelationship');
}
export async function writeBack(userId, entry) {
  notImplemented('writeBack');
}
export async function getSharedHistory(userId, limit = 50) {
  notImplemented('getSharedHistory');
}
