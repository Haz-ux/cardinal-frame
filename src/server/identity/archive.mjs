/**
 * Cardinal Frame — Identity Archive — History + Restore
 *
 * Every retired avatar, restyle, and identity edit is archived with its
 * lineage. The user can browse history and restore any version — including
 * restore-to-default. Nothing about the companion face is ever truly lost.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): identity.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function archiveIdentity(snapshot) {
  notImplemented('archiveIdentity');
}
export async function listHistory() {
  notImplemented('listHistory');
}
export async function restore(versionId) {
  notImplemented('restore');
}
