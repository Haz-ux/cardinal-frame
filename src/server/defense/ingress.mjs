/**
 * Cardinal Frame — Ingress — Input Boundary
 *
 * The input boundary. Secrets are dropped by pattern BEFORE the event object
 * is constructed — redaction-after-capture leaves raw payloads in buffers
 * and logs. learning/events.mjs then only ever sees clean evidence.
 *
 * Third-party agents, web content, pasted text, files: all untrusted until
 * proven otherwise. n8n output enters here as third-party-tier content.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): defense/provenance.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export const SECRET_PATTERNS = ['api-key', 'bearer-token', 'private-key', 'password-field'];
export async function screen(rawInput) {
  notImplemented('screen');
}
