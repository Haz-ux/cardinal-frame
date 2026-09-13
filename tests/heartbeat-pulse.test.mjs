import { describe, it, expect, vi, afterEach } from 'vitest';
import { HeartbeatDaemon, PULSE_DIRECTIVE } from '../src/server/heartbeat.mjs';
import { createTelegramNotifier } from '../src/server/routes/comms.mjs';

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

describe('pulse alert → Telegram notify', () => {
  it('calls notify with the alert message', async () => {
    const notified = [];
    const daemon = makeDaemon({
      invokeAgent: async () => JSON.stringify({
        attention_needed: true,
        summary: 'disk filling',
        actions: [{ type: 'alert', message: 'Disk at 91%' }],
      }),
    });
    daemon.notify = async (text) => { notified.push(text); };
    await daemon.pulse();
    expect(notified).toEqual(['Disk at 91%']);
  });

  it('survives notify failures', async () => {
    const daemon = makeDaemon({
      invokeAgent: async () => JSON.stringify({
        attention_needed: true,
        summary: 'x',
        actions: [{ type: 'alert', message: 'hi' }],
      }),
    });
    daemon.notify = async () => { throw new Error('telegram down'); };
    await daemon.pulse(); // must not throw
    expect(daemon.pulseStats.lastAttention).toBe(true);
    expect(daemon.pulseRunning).toBe(false);
  });

  it('skips notify when not configured', async () => {
    const daemon = makeDaemon({
      invokeAgent: async () => JSON.stringify({
        attention_needed: true,
        summary: 'x',
        actions: [{ type: 'alert', message: 'hi' }],
      }),
    });
    expect(daemon.notify).toBeNull();
    await daemon.pulse(); // must not throw
    expect(daemon._broadcastCalls.some(c => c.event === 'heartbeat:pulse-alert')).toBe(true);
  });
});

describe('createTelegramNotifier', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function stubStmts(channels) {
    return { commsChannels: { getByPlatform: { all: () => channels } } };
  }
  const quietLogger = { info: () => {}, warn: () => {}, error: () => {} };

  it('resolves unsent when no telegram channel is configured', async () => {
    const notify = createTelegramNotifier({ stmts: stubStmts([]), logger: quietLogger });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const result = await notify('hello');
    expect(result.sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends to chat_id via the Bot API', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    }));
    globalThis.fetch = fetchSpy;
    const notify = createTelegramNotifier({
      stmts: stubStmts([{
        id: 'ch1', name: 'haz-bot',
        config: JSON.stringify({ bot_token: 'TOKEN123', chat_id: '999' }),
      }]),
      logger: quietLogger,
    });
    const result = await notify('pulse: check this');
    expect(result).toEqual({ sent: true, channels: ['ch1'] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOKEN123/sendMessage');
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe('999');
    expect(body.text).toBe('pulse: check this');
  });

  it('falls back to the first allowlisted user id', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: {} }),
    }));
    globalThis.fetch = fetchSpy;
    const notify = createTelegramNotifier({
      stmts: stubStmts([{
        id: 'ch1', name: 'haz-bot',
        config: JSON.stringify({ bot_token: 'TOKEN123', allowed_user_ids: ['424242'] }),
      }]),
      logger: quietLogger,
    });
    await notify('hi');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.chat_id).toBe('424242');
  });

  it('skips channels without a bot token and never throws on send failure', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('network down'); });
    globalThis.fetch = fetchSpy;
    const notify = createTelegramNotifier({
      stmts: stubStmts([
        { id: 'ch0', name: 'no-token', config: JSON.stringify({}) },
        { id: 'ch1', name: 'bad-net', config: JSON.stringify({ bot_token: 'T', chat_id: '1' }) },
      ]),
      logger: quietLogger,
    });
    const result = await notify('hi');
    expect(result.sent).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the token-bearing channel attempted
  });
});
