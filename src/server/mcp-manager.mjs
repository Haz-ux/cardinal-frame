/**
 * MCP Manager — Track C: auto-connect, health loop, and tool surfacing.
 *
 * Started by the server coordinator at boot via startMcpManager(deps).
 *   - Boot: connects every mcp_servers row with auto_connect=1 (stdio only).
 *   - Surfaces each connected server's tools as agent tools
 *     (`mcp_<server>__<tool>`), unregistering them first on reconnect so
 *     there are never stale or duplicate entries.
 *   - Health loop: pings each tracked server; on failure marks it
 *     'degraded' and reconnects with in-memory exponential backoff
 *     (5s / 15s / 60s / 300s, max 4 attempts); afterwards the server is
 *     marked 'error' and left alone until a manual connect or restart.
 *   - Never spawns more than mcp-client's MAX_CONNECTIONS concurrent
 *     servers; extras are logged and skipped.
 *
 * stop() clears the health interval and pending backoff timers. It
 * deliberately does NOT kill the child processes — stopping the manager
 * is not the same as disconnecting a server; explicit disconnect remains
 * the only path that kills a server process.
 */

const BACKOFF_DELAYS = [5_000, 15_000, 60_000, 300_000];
const MAX_BACKOFF_ATTEMPTS = BACKOFF_DELAYS.length;

function sanitizeName(name) {
  return String(name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'unnamed';
}

let _manager = null;

/**
 * @param {object} deps
 * @param {object} deps.db - better-sqlite3 database (unused; kept for symmetry)
 * @param {object} deps.stmts - prepared statements (stmts.mcp.getAll, stmts.mcp.updateStatus)
 * @param {object} deps.logger
 * @param {function} deps.broadcast - (event, payload) WS push
 * @param {object} deps.mcp - mcp-client module (connectServer, disconnectServer,
 *   reconnectServer, ping, listTools, invokeTool, isConnected)
 * @param {function} deps.registerAgentTool
 * @param {function} deps.unregisterAgentTool
 * @param {number} [deps.healthIntervalMs=30000]
 * @returns {{ stop(): void, getStatus(): object[] }}
 */
export function startMcpManager(deps) {
  if (_manager) {
    deps?.logger?.warn?.('[MCP manager] already running — returning existing handle');
    return _manager.handle;
  }

  const {
    db, stmts, logger, broadcast, mcp,
    registerAgentTool, unregisterAgentTool,
    healthIntervalMs = 30_000,
  } = deps;

  const state = new Map(); // serverId -> { backoffAttempt, toolsRegistered: [], backoffTimer }
  let healthTimer = null;
  let stopped = false;

  const log = logger || console;
  const emit = broadcast || (() => {});

  function markStatus(serverId, status, { keepConnectedAt = true } = {}) {
    const now = new Date().toISOString();
    const row = stmts.mcp.getById ? stmts.mcp.getById.get(serverId) : null;
    const connectedAt = keepConnectedAt ? (row?.connected_at ?? now) : null;
    stmts.mcp.updateStatus.run(status, connectedAt, now, serverId);
    emit('mcp:status', { id: serverId, status });
  }

  function unsurfaceTools(serverId) {
    const s = state.get(serverId);
    if (!s) return;
    for (const name of s.toolsRegistered) {
      try { unregisterAgentTool(name); } catch (err) {
        log.error?.(`[MCP manager] unregisterAgentTool(${name}) failed: ${err.message}`);
      }
    }
    if (s.toolsRegistered.length) {
      log.info?.(`[MCP manager] Unsurfaced ${s.toolsRegistered.length} agent tool(s) for server ${serverId}`);
    }
    s.toolsRegistered = [];
  }

  function surfaceTools(serverId, serverName, tools) {
    unsurfaceTools(serverId); // remove stale entries before re-registering
    const s = state.get(serverId);
    const prefix = `mcp_${sanitizeName(serverName)}`;
    for (const tool of tools || []) {
      const toolName = `mcp_${sanitizeName(serverName)}__${sanitizeName(tool.name)}`;
      try {
        registerAgentTool(
          toolName,
          tool.description || `${tool.name} on ${serverName}`,
          tool.inputSchema || { type: 'object', properties: {} },
          async (args) => {
            try {
              return { result: await mcp.invokeTool(serverId, tool.name, args || {}) };
            } catch (e) {
              return { error: e.message };
            }
          }
        );
        s.toolsRegistered.push(toolName);
      } catch (err) {
        log.error?.(`[MCP manager] Failed to register agent tool ${toolName}: ${err.message}`);
      }
    }
    log.info?.(`[MCP manager] Surfaced ${s.toolsRegistered.length} tool(s) for server ${serverName} (prefix ${prefix}__)`);
  }

  function clearBackoff(serverId) {
    const s = state.get(serverId);
    if (s?.backoffTimer) {
      clearTimeout(s.backoffTimer);
      s.backoffTimer = null;
    }
  }

  async function connectTracked(row, command, args) {
    const { id, name } = row;
    const s = state.get(id);
    try {
      const result = await mcp.connectServer(id, command, args);
      const tools = result?.tools || await mcp.listTools(id).catch(() => []);
      surfaceTools(id, name, tools);
      markStatus(id, 'connected');
      s.backoffAttempt = 0;
      clearBackoff(id);
      log.info?.(`[MCP manager] Auto-connected ${name} (${id}), ${tools.length} tool(s)`);
      return true;
    } catch (err) {
      log.error?.(`[MCP manager] Auto-connect failed for ${name} (${id}): ${err.message}`);
      markStatus(id, 'degraded');
      scheduleReconnect(row, command, args);
      return false;
    }
  }

  function scheduleReconnect(row, command, args) {
    const { id, name } = row;
    const s = state.get(id);
    if (stopped) return;
    if (s.backoffTimer) return; // a retry is already queued — don't stack timers or attempts
    if (s.backoffAttempt >= MAX_BACKOFF_ATTEMPTS) {
      log.error?.(`[MCP manager] Backoff exhausted for ${name} (${id}) — marking error, will not retry until manual connect or restart`);
      markStatus(id, 'error');
      return;
    }
    const delay = BACKOFF_DELAYS[s.backoffAttempt];
    s.backoffAttempt += 1;
    log.warn?.(`[MCP manager] Reconnecting ${name} (${id}) in ${delay / 1000}s (attempt ${s.backoffAttempt}/${MAX_BACKOFF_ATTEMPTS})`);
    s.backoffTimer = setTimeout(() => {
      s.backoffTimer = null;
      if (stopped) return;
      mcp.reconnectServer(id, command, args)
        .then(async (result) => {
          const tools = result?.tools || await mcp.listTools(id).catch(() => []);
          surfaceTools(id, name, tools);
          markStatus(id, 'connected');
          s.backoffAttempt = 0;
          log.info?.(`[MCP manager] Reconnected ${name} (${id}), ${tools.length} tool(s)`);
        })
        .catch((err) => {
          log.error?.(`[MCP manager] Reconnect attempt failed for ${name} (${id}): ${err.message}`);
          markStatus(id, 'degraded');
          scheduleReconnect(row, command, args);
        });
    }, delay);
  }

  async function healthCheck() {
    if (stopped) return;
    for (const [id, s] of state) {
      try {
        const ok = await mcp.ping(id);
        if (ok) {
          const row = stmts.mcp.getById.get(id);
          if (row && row.status !== 'connected') {
            markStatus(id, 'connected');
          }
          if (s.backoffAttempt !== 0) { s.backoffAttempt = 0; clearBackoff(id); }
        } else {
          const row = stmts.mcp.getById ? stmts.mcp.getById.get(id) : null;
          if (row && row.status === 'error') continue; // backoff exhausted — leave alone until manual connect or restart
          if (!row || row.status !== 'degraded') {
            log.warn?.(`[MCP manager] Ping failed for ${row?.name || id} — marking degraded, scheduling reconnect`);
            markStatus(id, 'degraded');
            // NOTE: tools stay surfaced while degraded (best-effort); on a
            // successful reconnect surfaceTools() unregisters them first and
            // re-registers, so there are never duplicates or stale entries.
          }
          scheduleReconnect({ id, name: row?.name || id }, row?.command, JSON.parse(row?.args || '[]'));
        }
      } catch (err) {
        log.error?.(`[MCP manager] Health check error for ${id}: ${err.message}`);
      }
    }
  }

  async function boot() {
    const rows = stmts.mcp.getAll.all().filter(r => r.auto_connect === 1);
    if (!rows.length) {
      log.info?.('[MCP manager] No auto_connect servers — nothing to connect');
      return;
    }
    let connectedCount = 0;
    for (const row of rows) {
      if (stopped) break;
      if (row.transport !== 'stdio') {
        log.warn?.(`[MCP manager] Skipping ${row.name} (${row.id}): transport '${row.transport}' unsupported (stdio only)`);
        continue;
      }
      // mcp-client caps live connections at MAX_CONNECTIONS=10 (enforced
      // inside connectServer too); skip extras here with a clear log.
      if (connectedCount >= 10) {
        log.warn?.(`[MCP manager] Skipping ${row.name} (${row.id}): connection cap reached`);
        continue;
      }
      state.set(row.id, { backoffAttempt: 0, toolsRegistered: [], backoffTimer: null });
      let args = [];
      try { args = JSON.parse(row.args || '[]'); }
      catch { log.warn?.(`[MCP manager] Bad args JSON for ${row.name} (${row.id}) — using []`); }
      if (await connectTracked(row, row.command, args)) connectedCount += 1;
    }
  }

  function stop() {
    stopped = true;
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    for (const [, s] of state) {
      if (s.backoffTimer) { clearTimeout(s.backoffTimer); s.backoffTimer = null; }
    }
    _manager = null;
    log.info?.('[MCP manager] Stopped (server connections left intact)');
  }

  function getStatus() {
    return [...state.entries()].map(([id, s]) => {
      const row = stmts.mcp.getById ? stmts.mcp.getById.get(id) : null;
      let lastPing = row?.last_ping || null;
      return {
        id,
        name: row?.name || null,
        connected: Boolean(mcp.isConnected && mcp.isConnected(id)),
        autoConnect: true,
        toolsRegistered: [...s.toolsRegistered],
        backoffAttempt: s.backoffAttempt,
        lastPing,
      };
    });
  }

  healthTimer = setInterval(healthCheck, healthIntervalMs);
  if (healthTimer.unref) healthTimer.unref();

  const handle = { stop, getStatus };
  _manager = { handle };

  // Fire boot async — never block the coordinator.
  boot().catch(err => log.error?.(`[MCP manager] Boot error: ${err.message}`));

  return handle;
}

/** Stop the running manager, if any. */
export function stopMcpManager() {
  if (_manager) _manager.handle.stop();
}

export { BACKOFF_DELAYS, MAX_BACKOFF_ATTEMPTS, sanitizeName };
