/**
 * Cardinal Frame — Provenance — Source + Trust Tags
 *
 * Every input is tagged with its source and trust tier before anything else
 * touches it: user > local system > paired devices > web > third-party
 * agents. The tag travels with the event through the whole turn loop and
 * lands in the audit trail (see 019_provenance_defense.sql).
 *
 * Lower tiers provide data; they never issue instructions unless the user
 * explicitly delegates authority.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): defense/policy.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export const TRUST_TIERS = ['user', 'local-system', 'paired-devices', 'web', 'third-party-agents'];
export async function tierOf(source) {
  notImplemented('tierOf');
}
export async function tag(event) {
  notImplemented('tag');
}
