/**
 * Cardinal Frame — n8n — Hands Layer
 *
 * Cardinal Frame is the brain; n8n is the hands. CF dispatches workflow
 * executions by webhook (a fleet node type — n8n is just another worker
 * behind the companion); n8n webhooks land in scheduling/hooks.mjs as
 * event sources feeding presence and the on-call loop.
 *
 * Trust boundary: n8n output enters as third-party-tier content, untrusted
 * until validated by defense/ingress.mjs. The defensive pillar governs the
 * brain/hands boundary; convenience never bypasses it.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): scheduling/hooks.mjs, defense/ingress.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function dispatch(workflowId, payload) {
  notImplemented('dispatch');
}
export async function handleWebhook(event) {
  notImplemented('handleWebhook');
}
