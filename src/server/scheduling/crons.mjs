/**
 * Cardinal Frame — Crons — Time-Based Scheduling
 *
 * Time-based scheduling. Generalizes the existing heartbeat engine: crons
 * are named schedules with cron expressions, owned jobs, and run history.
 * Presence consumes cron ticks as interruption candidates.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): heartbeat.mjs, job-queue.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function schedule(cronExpr, job) {
  notImplemented('schedule');
}
export async function cancel(id) {
  notImplemented('cancel');
}
export async function list() {
  notImplemented('list');
}
