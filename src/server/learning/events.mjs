/**
 * Cardinal Frame — Learning Events — Redacted Evidence
 *
 * The learning pipeline only ever sees clean evidence: ingress.mjs has
 * already dropped secrets before the event object was constructed. This
 * module records redacted turn evidence for the review loop.
 *
 * Eventual home of the learn.mjs / learning-loop.mjs migration — the old
 * loop stays disabled until this pipeline replaces it.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): defense/ingress.mjs, migrations/014_learning_events.sql
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export async function record(event) {
  notImplemented('record');
}
export async function list(filters = {}) {
  notImplemented('list');
}
