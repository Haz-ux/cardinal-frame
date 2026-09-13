/**
 * Track C — MCP manager tests.
 * The manager is exercised with a fake mcp object (no child processes).
 * Run: vitest tests/mcp-manager.test.mjs
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  agentTools,
  registerAgentTool,
  unregisterAgentTool,
} from '../src/server/routes/agent.mjs';
import { startMcpManager } from '../src/server/mcp-manager.mjs';

// ─── Fakes ──────────────────────────────────────────────────────────
function makeFakeMcp() {
  const calls = [];
  const state = {
    connected: new Set(),
    tools: {
      'srv-1': [
        { name: 'read File', description: 'Reads a file', inputSchema: { type: 'object', properties: { p: { type: 'string' } } } },
        { name: 'weird!name#2', description: '', inputSchema: null },
      ],
      'srv-2': [{ name: 'lookup', description: 'Looks things up', inputSchema: { type: 'object', properties: {} } }],
    },
    pingFails: new Set(),     // ids whose ping returns false
    connectFails: new Set(),  // ids whose connectServer rejects
    invokeFails: new Set(),   // tool names whose invokeTool rejects
  };
  const mcp = {
    async connectServer(id, command, args) {
      calls.push(['connectServer', id, command, args]);
      if (state.connectFails.has(id)) throw new Error('spawn failed');
      state.connected.add(id);
      return { initialized: true, tools: state.tools[id] || [] };
    },
    disconnectServer(id) { calls.push(['disconnectServer', id]); state.connected.delete(id); },
    async reconnectServer(id, command, args) {
      calls.push(['reconnectServer', id, command, args]);
      if (state.connectFails.has(id)) throw new Error('reconnect failed');
      state.connected.add(id);
      return { initialized: true, tools: state.tools[id] || [] };
    },
    async ping(id) { calls.push(['ping', id]); return !state.pingFails.has(id); },
    async listTools(id) { calls.push(['listTools', id]); return state.tools[id] || []; },
    async invokeTool(id, name, args) {
      calls.push(['invokeTool', id, name, args]);
      if (state.invokeFails.has(name)) throw new Error('boom');
      return { ok: true, name, args };
    },
    isConnected(id) { return state.connected.has(id); },
  };
  return { mcp, calls, state };
}

function makeFakeDb(servers) {
  const rows = servers.map(s => ({
    id: s.id, name: s.name,
    transport: s.transport || 'stdio',
    command: s.command ?? 'node',
    args: JSON.stringify(s.args || []),
    url: s.url || null,
    status: 'disconnected', connected_at: null, last_ping: null,
    auto_connect: s.auto_connect ? 1 : 0,
  }));
  const stmts = {
    mcp: {
      getAll: { all: () => rows },
      getById: { get: (id) => rows.find(r => r.id === id) },
      updateStatus: { run: (status, connected_at, last_ping, id) => {
        const r = rows.find(r => r.id === id);
        if (r) { r.status = status; r.connected_at = connected_at; r.last_ping = last_ping; }
      } },
      insert: { run: () => {} },
      delete: { run: () => ({ changes: 1 }) },
    },
  };
  return { rows, stmts };
}

function makeDeps(servers, extra = {}) {
  const { mcp, calls, state } = makeFakeMcp();
  const { rows, stmts } = makeFakeDb(servers);
  return {
    deps: {
      db: {}, stmts,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      broadcast: vi.fn(),
      mcp, registerAgentTool, unregisterAgentTool,
      healthIntervalMs: 60_000,
      ...extra,
    },
    calls, state, rows,
  };
}

const trackedTools = () => agentTools.filter(t => t.name.startsWith('mcp_') && t.name.includes('__'));

// ─── Tests ──────────────────────────────────────────────────────────
describe('unregisterAgentTool', () => {
  afterEach(() => {
    // leave no test residue in the real registry
    for (const t of [...agentTools]) if (t.name.startsWith('ut_probe')) unregisterAgentTool(t.name);
  });

  it('removes a tool from the real agentTools array and returns true', () => {
    registerAgentTool('ut_probe_one', 'probe', { type: 'object', properties: {} }, async () => ({}));
    expect(agentTools.some(t => t.name === 'ut_probe_one')).toBe(true);
    expect(unregisterAgentTool('ut_probe_one')).toBe(true);
    expect(agentTools.some(t => t.name === 'ut_probe_one')).toBe(false);
  });

  it('returns false for an unknown name', () => {
    expect(unregisterAgentTool('ut_probe_missing')).toBe(false);
  });
});

describe('startMcpManager boot', () => {
  let handle;
  afterEach(() => { if (handle) { handle.stop(); handle = null; } });

  it('connects auto_connect stdio rows and surfaces sanitized tools', async () => {
    const { deps, calls, rows } = makeDeps([
      { id: 'srv-1', name: 'File Svc', auto_connect: true },
      { id: 'srv-2', name: 'LookUp', auto_connect: false },
      { id: 'srv-3', name: 'Web API', transport: 'http', auto_connect: true },
    ]);
    handle = startMcpManager(deps);
    await new Promise(r => setTimeout(r, 50));

    const connects = calls.filter(c => c[0] === 'connectServer').map(c => c[1]);
    expect(connects).toContain('srv-1');
    expect(connects).not.toContain('srv-2'); // not flagged
    expect(connects).not.toContain('srv-3'); // http skipped

    expect(rows.find(r => r.id === 'srv-1').status).toBe('connected');
    expect(deps.broadcast).toHaveBeenCalledWith('mcp:status', { id: 'srv-1', status: 'connected' });
    expect(deps.logger.warn).toHaveBeenCalled(); // http skip warning

    const names = trackedTools().map(t => t.name);
    expect(names).toContain('mcp_file_svc__read_file');
    expect(names).toContain('mcp_file_svc__weird_name_2'); // sanitized
    expect(names.some(n => n.includes('lookup'))).toBe(false);

    // tool execute path proxies to mcp.invokeTool
    const tool = agentTools.find(t => t.name === 'mcp_file_svc__read_file');
    expect(await tool.execute({ p: '/x' })).toEqual({ result: { ok: true, name: 'read File', args: { p: '/x' } } });

    // sanity: status getter reflects state
    const status = handle.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ id: 'srv-1', name: 'File Svc', connected: true, autoConnect: true, backoffAttempt: 0 });
    expect(status[0].toolsRegistered).toContain('mcp_file_svc__read_file');
  });

  it('tool execute returns {error} when invokeTool throws', async () => {
    const { deps, state } = makeDeps([{ id: 'srv-1', name: 'File Svc', auto_connect: true }]);
    state.invokeFails.add('read File');
    handle = startMcpManager(deps);
    await new Promise(r => setTimeout(r, 50));
    const tool = agentTools.find(t => t.name === 'mcp_file_svc__read_file');
    expect(await tool.execute({})).toEqual({ error: 'boom' });
  });

  it('does nothing when no auto_connect rows', async () => {
    const { deps, calls } = makeDeps([{ id: 'srv-1', name: 'File Svc', auto_connect: false }]);
    handle = startMcpManager(deps);
    await new Promise(r => setTimeout(r, 50));
    expect(calls.filter(c => c[0] === 'connectServer')).toHaveLength(0);
    expect(handle.getStatus()).toHaveLength(0);
  });
});

describe('health loop + backoff', () => {
  let handle;
  afterEach(() => { if (handle) { handle.stop(); handle = null; } });
  afterEach(() => { vi.restoreAllMocks(); });

  it('ping failure marks degraded and retries reconnect', async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls, state, rows } = makeDeps(
        [{ id: 'srv-1', name: 'File Svc', auto_connect: true }],
        { healthIntervalMs: 1_000 }
      );
      handle = startMcpManager(deps);
      await vi.advanceTimersByTimeAsync(50); // boot
      expect(rows.find(r => r.id === 'srv-1').status).toBe('connected');

      state.pingFails.add('srv-1');
      await vi.advanceTimersByTimeAsync(1_000); // health tick → ping false → degraded, backoff timer (5s)
      const row = rows.find(r => r.id === 'srv-1');
      expect(row.status).toBe('degraded');
      expect(deps.broadcast).toHaveBeenCalledWith('mcp:status', { id: 'srv-1', status: 'degraded' });
      expect(trackedTools().map(t => t.name)).toContain('mcp_file_svc__read_file'); // tools stay surfaced while degraded

      await vi.advanceTimersByTimeAsync(5_000); // backoff fires → reconnectServer (pings still fail)
      expect(calls.some(c => c[0] === 'reconnectServer')).toBe(true);
      await vi.runOnlyPendingTimersAsync();

      state.pingFails.delete('srv-1'); // heal
      await vi.advanceTimersByTimeAsync(1_000); // health tick → ping ok → connected
      expect(row.status).toBe('connected');
      const names = trackedTools().map(t => t.name);
      expect(names).toContain('mcp_file_svc__read_file');
      expect(new Set(names).size).toBe(names.length); // no duplicates
    } finally {
      vi.useRealTimers();
    }
  });

  it('backoff exhausts after 4 attempts and marks error', async () => {
    vi.useFakeTimers();
    try {
      const { deps, state, rows } = makeDeps(
        [{ id: 'srv-1', name: 'File Svc', auto_connect: true }],
        { healthIntervalMs: 1_000 }
      );
      state.connectFails.add('srv-1'); // every reconnect fails
      handle = startMcpManager(deps);
      await vi.advanceTimersByTimeAsync(50); // boot fails → backoff attempt 1 scheduled (5s)
      state.pingFails.add('srv-1');
      for (const delay of [5_000, 15_000, 60_000, 300_000]) {
        await vi.advanceTimersByTimeAsync(delay);
        await vi.runOnlyPendingTimersAsync();
      }
      const row = rows.find(r => r.id === 'srv-1');
      expect(row.status).toBe('error');
      const status = handle.getStatus();
      expect(status[0].backoffAttempt).toBe(4);
      // no more timers pending — exhausted
      const before = row.status;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(rows.find(r => r.id === 'srv-1').status).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() clears timers and does not kill connections', async () => {
    vi.useFakeTimers();
    try {
      const { deps, calls, state } = makeDeps(
        [{ id: 'srv-1', name: 'File Svc', auto_connect: true }],
        { healthIntervalMs: 1_000 }
      );
      handle = startMcpManager(deps);
      await vi.advanceTimersByTimeAsync(50);
      const timerCount = vi.getTimerCount();
      expect(timerCount).toBeGreaterThan(0);
      handle.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(calls.some(c => c[0] === 'disconnectServer')).toBe(false);
      expect(state.connected.has('srv-1')).toBe(true); // connection left intact
      handle = null; // already stopped
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reconnect unsurfaces before re-registering', () => {
  let handle;
  afterEach(() => { if (handle) { handle.stop(); handle = null; } });

  it('no duplicate tool entries across reconnects', async () => {
    vi.useFakeTimers();
    try {
      const { deps, state } = makeDeps(
        [{ id: 'srv-1', name: 'File Svc', auto_connect: true }],
        { healthIntervalMs: 1_000 }
      );
      handle = startMcpManager(deps);
      await vi.advanceTimersByTimeAsync(50);
      state.pingFails.add('srv-1');
      await vi.advanceTimersByTimeAsync(1_000);  // degrade (tools stay surfaced)
      expect(trackedTools().map(t => t.name)).toContain('mcp_file_svc__read_file');
      await vi.advanceTimersByTimeAsync(5_000);  // backoff fires → reconnect → unsurface-first + re-register
      await vi.runOnlyPendingTimersAsync();
      state.pingFails.delete('srv-1');
      await vi.advanceTimersByTimeAsync(1_000);
      const names = trackedTools().map(t => t.name);
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dupes).toHaveLength(0);
      expect(names).toContain('mcp_file_svc__read_file');
    } finally {
      vi.useRealTimers();
    }
  });
});
