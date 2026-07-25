/**
 * Cardinal Frame — Skill Self-Edit Safety Floor
 *
 * Hardcoded, non-configurable deny-list that no skill proposal can ever touch,
 * regardless of human approval. This is a floor, not a review step — it applies
 * even if a human clicks "accept."
 *
 * Modeled on Hermes's agent/file_safety.py pattern.
 * Intentionally not overridable by config flag — same reason Hermes hardcodes theirs.
 */

/**
 * Files that skill proposals are NEVER allowed to modify.
 * Adding to this list is fine. Removing from it requires a code change
 * that gets reviewed by a human who understands why each entry is here.
 */
export const SKILL_EDIT_DENY_LIST = [
  'src/server/routes/governance.mjs',
  'src/server/routes/meta.mjs',           // audit log read endpoints
  'src/server/llm/provider-runtime.mjs',  // auth handling lives here
  'src/server/node-identity.mjs',         // cryptographic identity — Task 0
  'src/server/node-registry.mjs',         // node registry — Task 1
  'src/server/skill-safety.mjs',          // this file — can't edit the safety floor itself
];

/**
 * Check if a proposed skill edit targets a denied file.
 *
 * @param {string} targetFilePath — the file path the proposal wants to modify
 * @returns {{ allowed: boolean, deniedPath?: string }}
 */
export function isSkillEditAllowed(targetFilePath) {
  for (const denied of SKILL_EDIT_DENY_LIST) {
    if (targetFilePath.includes(denied)) {
      return { allowed: false, deniedPath: denied };
    }
  }
  return { allowed: true };
}

/**
 * Check if a proposal's content references any denied file paths.
 * Scans the proposal content string for deny-listed paths.
 *
 * @param {string} proposalContent — the proposal body/diff/content
 * @returns {{ allowed: boolean, deniedPaths: string[] }}
 */
export function checkProposalContent(proposalContent) {
  if (!proposalContent || typeof proposalContent !== 'string') {
    return { allowed: true, deniedPaths: [] };
  }

  const deniedPaths = [];
  for (const denied of SKILL_EDIT_DENY_LIST) {
    if (proposalContent.includes(denied)) {
      deniedPaths.push(denied);
    }
  }

  return {
    allowed: deniedPaths.length === 0,
    deniedPaths,
  };
}
