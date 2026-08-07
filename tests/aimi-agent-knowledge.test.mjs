import { describe, it, expect } from 'vitest';
import { buildAimiSystemPrompt, SYSTEM_TOOLS } from '../src/server/routes/aimi.mjs';

function stubStmts() {
  const list = { all: () => [] };
  return {
    agents: { getAll: list },
    tasks: { getAll: list },
    providers: { getAll: list },
    tools: { getEnabled: list },
    schedules: { getAll: list },
    patterns: { getAll: list },
    skills: { getAutoProposed: list },
    skillChains: { getAll: list },
    toolChains: { getAll: list },
    personaOverrides: { getAll: list, get: { get: () => null } },
  };
}

describe('Aimi agent-system knowledge', () => {
  it('exposes agent tools in SYSTEM_TOOLS', () => {
    const names = SYSTEM_TOOLS.map(t => t.name);
    expect(names).toContain('create_agent');
    expect(names).toContain('list_agents');
    expect(names).toContain('get_agent');
    expect(names).toContain('list_agent_health');
  });

  it('teaches the agent model in the system prompt', () => {
    const prompt = buildAimiSystemPrompt(stubStmts(), 'user-1', null);
    expect(prompt).toContain('Agent System & Task Delegation');
    expect(prompt).toContain('Agents tab');
    expect(prompt).toContain('create_agent');
    expect(prompt).toContain('list_agent_health');
    expect(prompt).toContain('create_task');
    const lower = prompt.toLowerCase();
    expect(lower).toContain('heartbeat');
    expect(lower).toContain('claim');
  });
});
