/**
 * Cardinal Frame — Egress — Output Boundary
 *
 * Anything carrying user data that leaves the box must pass this gate:
 * classified, justified, tier-approved. Silent exfiltration becomes
 * structurally impossible, not just policy-forbidden.
 *
 * Covers third-party messages, API calls (including the NVIDIA overflow
 * tier and ElevenLabs voice overflow), and posts. The machine own output —
 * including sandbox-generated fixes in the on-call loop — is treated as
 * untrusted until it passes validation and approval.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): defense/provenance.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${{fn}}: ${{SCAFFOLD}}`);
}

export const CLASSIFICATIONS = ['public', 'internal', 'sensitive', 'secret'];
export async function classify(payload) {
  notImplemented('classify');
}
export async function authorize(payload) {
  notImplemented('authorize');
}
