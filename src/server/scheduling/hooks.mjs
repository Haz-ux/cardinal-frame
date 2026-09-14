/**
 * Cardinal Frame — Hooks — Event-Based Scheduling
 *
 * Event-based scheduling: named events with subscribed handlers. n8n
 * webhooks land here as event sources; CI failures, error spikes, and
 * cert expiries arrive as hook events feeding presence.mjs and the AI
 * on-call loop.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): integrations/n8n.mjs, companion/presence.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function on(eventName, handler) {
  notImplemented('on');
}
export async function off(eventName, handler) {
  notImplemented('off');
}
export async function emit(eventName, payload) {
  notImplemented('emit');
}
