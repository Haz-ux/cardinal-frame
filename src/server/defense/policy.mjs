/**
 * Cardinal Frame — Policy — Instruction Hierarchy
 *
 * The hierarchy is enforced mechanically in the turn loop, not by asking the
 * model nicely. This module runs before tool calls: any instruction
 * originating below user tier is dropped and logged. No external content
 * is ever an instruction — only the user issues orders.
 *
 * This is the enforcement point for the defensive pillar; defense is not a
 * module you call, it is the shape of the loop.
 *
 * v2 scaffold — contract surface only, no logic yet.
 * Dependencies (planned): defense/provenance.mjs
 */


const SCAFFOLD = 'v2 scaffold — not implemented yet';

function notImplemented(fn) {
  throw new Error(`[v2-scaffold] ${fn}: ${SCAFFOLD}`);
}

export async function enforce(event) {
  notImplemented('enforce');
}
export async function isInstructionAllowed(origin) {
  notImplemented('isInstructionAllowed');
}
export async function dropInstruction(event, reason) {
  notImplemented('dropInstruction');
}
