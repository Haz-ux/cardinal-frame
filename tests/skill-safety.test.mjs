/**
 * Tests for Skill Self-Edit Safety Floor
 * Verifies that deny-listed files cannot be modified via skill proposals,
 * even with admin approval.
 */
import { describe, it, expect } from 'vitest';
import {
  SKILL_EDIT_DENY_LIST,
  isSkillEditAllowed,
  checkProposalContent,
} from '../src/server/skill-safety.mjs';

describe('Skill Safety Floor — SKILL_EDIT_DENY_LIST', () => {
  it('should include governance.mjs in the deny list', () => {
    expect(SKILL_EDIT_DENY_LIST).toContain('src/server/routes/governance.mjs');
  });

  it('should include provider-runtime.mjs in the deny list', () => {
    expect(SKILL_EDIT_DENY_LIST).toContain('src/server/llm/provider-runtime.mjs');
  });

  it('should include node-identity.mjs in the deny list', () => {
    expect(SKILL_EDIT_DENY_LIST).toContain('src/server/node-identity.mjs');
  });

  it('should include node-registry.mjs in the deny list', () => {
    expect(SKILL_EDIT_DENY_LIST).toContain('src/server/node-registry.mjs');
  });

  it('should include skill-safety.mjs itself (self-protection)', () => {
    expect(SKILL_EDIT_DENY_LIST).toContain('src/server/skill-safety.mjs');
  });

  it('should be non-empty', () => {
    expect(SKILL_EDIT_DENY_LIST.length).toBeGreaterThan(0);
  });
});

describe('Skill Safety Floor — isSkillEditAllowed', () => {
  it('should deny edits to governance.mjs', () => {
    const result = isSkillEditAllowed('src/server/routes/governance.mjs');
    expect(result.allowed).toBe(false);
    expect(result.deniedPath).toBe('src/server/routes/governance.mjs');
  });

  it('should deny edits to provider-runtime.mjs', () => {
    const result = isSkillEditAllowed('src/server/llm/provider-runtime.mjs');
    expect(result.allowed).toBe(false);
    expect(result.deniedPath).toBe('src/server/llm/provider-runtime.mjs');
  });

  it('should deny edits using partial path match', () => {
    const result = isSkillEditAllowed('./src/server/routes/governance.mjs');
    expect(result.allowed).toBe(false);
  });

  it('should allow edits to non-protected files', () => {
    const result = isSkillEditAllowed('src/server/routes/tasks.mjs');
    expect(result.allowed).toBe(true);
    expect(result.deniedPath).toBeUndefined();
  });

  it('should allow edits to skill files themselves', () => {
    const result = isSkillEditAllowed('src/skills/hello-world/handler.js');
    expect(result.allowed).toBe(true);
  });

  it('should allow edits to test files', () => {
    const result = isSkillEditAllowed('tests/skills.test.mjs');
    expect(result.allowed).toBe(true);
  });
});

describe('Skill Safety Floor — checkProposalContent', () => {
  it('should block proposal content referencing governance.mjs', () => {
    const content = 'Update src/server/routes/governance.mjs to add new permission check';
    const result = checkProposalContent(content);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain('src/server/routes/governance.mjs');
  });

  it('should block proposal content referencing multiple deny-listed files', () => {
    const content = `
      Modify src/server/routes/governance.mjs and
      also update src/server/llm/provider-runtime.mjs
    `;
    const result = checkProposalContent(content);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toHaveLength(2);
  });

  it('should allow proposal content that does not reference any protected files', () => {
    const content = 'Update skill description to be more helpful for users';
    const result = checkProposalContent(content);
    expect(result.allowed).toBe(true);
    expect(result.deniedPaths).toHaveLength(0);
  });

  it('should handle null/undefined content gracefully', () => {
    expect(checkProposalContent(null).allowed).toBe(true);
    expect(checkProposalContent(undefined).allowed).toBe(true);
  });

  it('should handle empty string content', () => {
    const result = checkProposalContent('');
    expect(result.allowed).toBe(true);
    expect(result.deniedPaths).toHaveLength(0);
  });

  it('should block proposals that embed deny-listed paths in JSON', () => {
    const content = JSON.stringify({
      target_file: 'src/server/node-identity.mjs',
      changes: ['modify key generation'],
    });
    const result = checkProposalContent(content);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain('src/server/node-identity.mjs');
  });

  it('should block proposals trying to edit the safety floor itself', () => {
    const content = 'Remove src/server/skill-safety.mjs from the deny list';
    const result = checkProposalContent(content);
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain('src/server/skill-safety.mjs');
  });
});
