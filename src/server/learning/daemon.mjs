/**
 * Cardinal Frame — Learning Daemon — Review Loop
 *
 * The background review loop: picks up queued review jobs, runs candidates
 * through validation, and hands results to the curator. Scheduled via
 * scheduling/crons.mjs; each run is a review_jobs row (015).
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): scheduling/crons.mjs, migrations/015_review_jobs.sql
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function start() {
  notImplemented('start');
}
export async function stop() {
  notImplemented('stop');
}
export async function runOnce() {
  notImplemented('runOnce');
}
