import { describe, it, expect, vi } from 'vitest';
import { HeartbeatDaemon, PULSE_DIRECTIVE } from '../src/server/heartbeat.mjs';

// Unit tests for the agent pulse — the periodic LLM check-in where Aimi
// reviews system state and decides whether anything needs attention.

function makeDaemon(overrides = {}) {
  const broadcastCalls = [];
  const daemon = new HeartbeatDaemon(
    {},
    (event, data) => broadcastCalls.push({ event, data }),
    overrides.executeChain !== undefined ? overrides.executeChain : (async () => ({ ok: true })),
    overrides.executeSkill !== undefined ? overrides.executeSkill : (async () => ({ ok: true })),
    { info: () => {}, warn: () => {}, error: () => {} },
    {
      invokeAgent: overrides.invokeAgent || (async () => '{"attention_needed": false}'),
      personaPrompt: () => 'test persona',
      pulseUserId: 'test-user',
    }
  );
  // Stub state collection — this is a unit test of pulse logic, not integration.
  daemon.collectState = () => ({
    agents: { total: 1, active: 1, stale: 0 },
    tasks: { total: 2, pending: 0, running: 0, failed: 0 },
    chains: { total: 0, failed: 0, running: 0 },
    skills: { total: 3, enabled: 3 },
    providers: { total: 1, enabled: 1 },
    schedules: { total: 0, enabled: 0 },
    messages: { pending: 0 },
    memory: { heap_usage_pct: 42 },
  });
  daemon.stmts = {
    tasks: { getAll: { all: () => [] } },
    agents: { getAllWithHeartbeat: { all: () => [] } },
    heartbeat: { getAll: { all: () => [] } },
  };
  daemon._broadcastCalls = broadcastCalls;
  return daemon;
}

describe('parsePulseResponse', () => {
  it('parses plain JSON', () => {
    expect(HeartbeatDaemon.parsePulseResponse('{"attention_needed": false}'))
      .toEqual({ attention_needed: false });
  });

  it('parses fenced JSON', () => {
    const text = '```json\n{"attention_needed": true, "summary": "x"}\n```';
    expect(HeartbeatDaemon.parsePulseResponse(text))
      .toEqual({ attention_needed: true, summary: 'x' });
  });

  it('extracts JSON embedded in prose', () => {
    const text = 'Here is my assessment: {"attention_needed": false} that is all.';
    expect(HeartbeatDaemon.parsePulseResponse(text))
      .toEqual({ attention_needed: false });
  });

  it('returns null for garbage', () => {
    expect(HeartbeatDaemon.parsePulseResponse('nothing to see here')).toBeNull();
    expect(HeartbeatDaemon.parsePulseResponse('')).toBeNull();
    expect(HeartbeatDaemon.parsePulseResponse(null)).toBeNull();
    expect(HeartbeatDaemon.parsePulseResponse('{"broken": true')).toBeNull();
  });
});

describe('PULSE_DIRECTIVE', () => {
  it('defines the JSON protocol and allowed actions', () => {
    expect(PULSE_DIRECTIVE).toContain('attention_needed');
    expect(PULSE_DIRECTIVE).toContain('"type": "alert"');
    expect(PULSE_DIRECTIVE).toContain('"type": "skill"');
    expect(PULSE_DIRECTIVE).toContain('"type": "chain"');
  });
});

describe('pulse()', () => {
  it('stays quiet when nothing needs attention', async () => {
    const daemon = makeDaemon();
    await daemon.pulse();
    expect(daemon.pulseStats.runs).toBe(1);
    expect(daemon.pulseStats.lastAttention).toBe(false);
    expect(daemon.pulseStats.lastAt).toBeTruthy();
    const pulseEvents = daemon._broadcastCalls.filter(c => c.event === 'heartbeat:pulse');
    expect(pulseEvents).toHaveLength(0);
    expect(daemon.pulseRunning).toBe(false);
  });

  it('stays quiet on unparseable replies (fail-safe: no actions)', async () => {
    const daemon = makeDaemon({ invokeAgent: async () => 'just some words' });
    await daemon.pulse();
    expect(daemon.pulseStats.runs).toBe(1);
    expect(daemon.pulseStats.lastAttention).toBe(false);
    expect(daemon._broadcastCalls.filter(c => c.event === 'heartbeat:pulse')).toHaveLength(0);
  });

  it('broadcasts and runs actions when attention is needed', async () => {
    const skillCalls = [];
    const daemon = makeDaemon({
      invokeAgent: async () => JSON.stringify({
        attention_needed: true,
        summary: 'Two tasks failed',
        actions: [
          { type: 'alert', message: 'Two tasks failed — recommend review' },
          { type: 'skill', name: 'my-skill', input: { q: 1 } },
        ],
      }),
      executeSkill: async (name, input) => { skillCalls.push({ name, input }); return { ok: true }; },
    });
    await daemon.pulse();
    expect(daemon.pulseStats.lastAttention).toBe(true);
    expect(daemon.pulseStats.lastSummary).toBe('Two tasks failed');
    const pulse = daemon._broadcastCalls.find(c => c.event === 'heartbeat:pulse');
    expect(pulse.data.summary).toBe('Two tasks failed');
    expect(pulse.data.actionCount).toBe(2);
    const alert = daemon._broadcastCalls.find(c => c.event === 'heartbeat:pulse-alert');
    expect(alert.data.message).toContain('Two tasks failed');
    expect(skillCalls).toEqual([{ name: 'my-skill', input: { q: 1 } }]);
  });

  it('caps actions at 5', async () => {
    const daemon = makeDaemon({
      invokeAgent: async () => JSON.stringify({
        attention_needed: true,
        summary: 'many',
        actions: Array.from({ length: 9 }, (_, i) => ({ type: 'alert', message: `m${i}` })),
      }),
    });
    await daemon.pulse();
    const alerts = daemon._broadcastCalls.filter(c => c.event === 'heartbeat:pulse-alert');
    expect(alerts).toHaveLength(5);
  });

  it('ignores unknown action types instead of executing them', async () => {
    const daemon = makeDaemon({
      invokeAgent: async () => JSON.stringify({
        attention_needed: true,
        summary: 'sneaky',
        actions: [{ type: 'exec', command: 'rm -rf /' }, { type: 'alert', message: 'ok' }],
      }),
    });
    await daemon.pulse();
    const alerts = daemon._broadcastCalls.filter(c => c.event === 'heartbeat:pulse-alert');
    expect(alerts).toHaveLength(1);
  });

  it('survives LLM failures without crashing or hanging', async () => {
    const daemon = makeDaemon({ invokeAgent: async () => { throw new Error('No LLM provider'); } });
    await daemon.pulse();
    expect(daemon.pulseRunning).toBe(false);
    expect(daemon.pulseStats.runs).toBe(0);
  });

  it('never overlaps pulses', async () => {
    const invokeAgent = vi.fn(async () => '{"attention_needed": false}');
    const daemon = makeDaemon({ invokeAgent });
    daemon.pulseRunning = true;
    await daemon.pulse();
    expect(invokeAgent).not.toHaveBeenCalled();
  });
});

describe('startPulse', () => {
  it('refuses to start without an agent invoker', () => {
    const warn = vi.fn();
    const daemon = new HeartbeatDaemon({}, () => {}, null, null, { info: () => {}, warn, error: () => {} });
    expect(daemon.pulseReady()).toBe(false);
    daemon.startPulse(1000);
    expect(warn).toHaveBeenCalled();
    expect(daemon.pulseHandle).toBeNull();
  });

  it('reports status for the CLI', () => {
    const daemon = makeDaemon();
    const s = daemon.status();
    expect(s.running).toBe(false);
    expect(s.pulse.ready).toBe(true);
    expect(s.pulse.enabled).toBe(false);
    expect(s.pulse.runs).toBe(0);
  });
});

describe('buildPulseMessages', () => {
  it('combines persona, directive, and state context', () => {
    const daemon = makeDaemon();
    const messages = daemon.buildPulseMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('test persona');
    expect(messages[0].content).toContain('attention_needed');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Agent pulse');
  });
});
