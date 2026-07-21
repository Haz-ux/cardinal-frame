#!/usr/bin/env node
/**
 * MCP Client — connects to MCP servers via stdio transport,
 * discovers tools, and invokes them using JSON-RPC 2.0.
 *
 * Protocol spec: https://modelcontextprotocol.io/specification
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';

// ─── In-memory state ────────────────────────────────────────────────
// Map<serverId, { process, tools[], pending: Map<id, {resolve,reject,timeout}>, initialized }>
const connections = new Map();

// ─── JSON-RPC helpers ───────────────────────────────────────────────
function makeRequest(method, params, id) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function makeNotification(method, params) {
  return JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
}

// ─── Connect to an MCP server via stdio ─────────────────────────────
export function connectServer(serverId, command, args = []) {
  return new Promise((resolve, reject) => {
    if (connections.has(serverId)) {
      disconnectServer(serverId); // clean up old connection
    }

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        shell: false,
      });
    } catch (err) {
      return reject(new Error(`Failed to spawn MCP server: ${err.message}`));
    }

    const conn = {
      process: child,
      tools: [],
      pending: new Map(),
      initialized: false,
      buffer: '',
    };
    connections.set(serverId, conn);

    // ─── stdout: line-delimited JSON-RPC ───────────────────────────
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        handleResponse(serverId, msg);
      } catch (err) {
        console.error(`[MCP ${serverId}] Failed to parse stdout line:`, line, err.message);
      }
    });

    // ─── stderr: log for debugging ─────────────────────────────────
    child.stderr.on('data', (data) => {
      console.error(`[MCP ${serverId} stderr]`, data.toString().trim());
    });

    // ─── process lifecycle ─────────────────────────────────────────
    child.on('close', (code, signal) => {
      console.log(`[MCP ${serverId}] Process exited (code=${code}, signal=${signal})`);
      const c = connections.get(serverId);
      if (c) {
        // Reject all pending requests
        for (const [id, p] of c.pending) {
          clearTimeout(p.timeout);
          p.reject(new Error(`MCP server process exited (code=${code})`));
        }
        c.pending.clear();
        c.initialized = false;
      }
    });

    child.on('error', (err) => {
      console.error(`[MCP ${serverId}] Process error:`, err.message);
      reject(err);
    });

    // ─── Initialize handshake ──────────────────────────────────────
    const initId = randomUUID();
    const initTimeout = setTimeout(() => {
      conn.pending.delete(initId);
      reject(new Error('MCP initialize handshake timed out (10s)'));
    }, 10_000);

    conn.pending.set(initId, {
      resolve: (result) => {
        clearTimeout(initTimeout);
        conn.pending.delete(initId);
        conn.initialized = true;

        // Now discover tools
        listTools(serverId)
          .then((tools) => {
            resolve({ initialized: true, tools, serverInfo: result?.serverInfo });
          })
          .catch((err) => {
            // Initialized but tool discovery failed — still connected
            resolve({ initialized: true, tools: [], serverInfo: result?.serverInfo, toolsError: err.message });
          });
      },
      reject: (err) => {
        clearTimeout(initTimeout);
        conn.pending.delete(initId);
        reject(err);
      },
      timeout: initTimeout,
    });

    // Send initialize request per MCP spec
    const initReq = makeRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cardinal-frame', version: '1.0.0' },
    }, initId);
    child.stdin.write(initReq);

    // After initialize, send initialized notification
    // We'll send it once we get the initialize response back
  });
}

// ─── Handle incoming JSON-RPC response ──────────────────────────────
function handleResponse(serverId, msg) {
  const conn = connections.get(serverId);
  if (!conn) return;

  if (msg.id && conn.pending.has(msg.id)) {
    const p = conn.pending.get(msg.id);
    clearTimeout(p.timeout);
    conn.pending.delete(msg.id);

    if (msg.error) {
      p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      p.resolve(msg.result);

      // After initialize response, send initialized notification
      if (!conn._initializedNotified) {
        conn._initializedNotified = true;
        conn.process.stdin.write(makeNotification('notifications/initialized', {}));
      }
    }
  } else if (msg.method) {
    // Server-initiated notification or request — log for now
    console.log(`[MCP ${serverId}] Server notification:`, msg.method, msg.params || '');
  }
}

// ─── Send a JSON-RPC request and wait for response ──────────────────
function sendRequest(serverId, method, params = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const conn = connections.get(serverId);
    if (!conn || !conn.process || conn.process.killed) {
      return reject(new Error(`MCP server ${serverId} is not connected`));
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`Request '${method}' timed out (${timeoutMs}ms)`));
    }, timeoutMs);

    conn.pending.set(id, { resolve, reject, timeout: timer });
    conn.process.stdin.write(makeRequest(method, params, id));
  });
}

// ─── List tools from a server ───────────────────────────────────────
export async function listTools(serverId) {
  const result = await sendRequest(serverId, 'tools/list', {});
  const tools = result?.tools || [];
  const conn = connections.get(serverId);
  if (conn) conn.tools = tools;
  return tools;
}

// ─── Invoke a tool on a server ──────────────────────────────────────
export async function invokeTool(serverId, toolName, arguments_ = {}) {
  return sendRequest(serverId, 'tools/call', {
    name: toolName,
    arguments: arguments_,
  }, 30_000); // longer timeout for tool invocation
}

// ─── Disconnect from a server ───────────────────────────────────────
export function disconnectServer(serverId) {
  const conn = connections.get(serverId);
  if (!conn) return;

  // Reject all pending
  for (const [id, p] of conn.pending) {
    clearTimeout(p.timeout);
    p.reject(new Error('Server disconnected'));
  }
  conn.pending.clear();

  try {
    conn.process.kill('SIGTERM');
    // Give it a moment, then force kill
    setTimeout(() => {
      try { conn.process.kill('SIGKILL'); } catch {}
    }, 3000);
  } catch {}

  connections.delete(serverId);
}

// ─── Get cached tools for a server ──────────────────────────────────
export function getTools(serverId) {
  const conn = connections.get(serverId);
  return conn?.tools || [];
}

// ─── Check if a server is connected ─────────────────────────────────
export function isConnected(serverId) {
  const conn = connections.get(serverId);
  return conn && !conn.process.killed && conn.process.exitCode === null && conn.initialized;
}

// ─── Reconnect helper: disconnect then connect ──────────────────────
export async function reconnectServer(serverId, command, args) {
  disconnectServer(serverId);
  return connectServer(serverId, command, args);
}

// ─── Heartbeat ping ─────────────────────────────────────────────────
export async function ping(serverId) {
  try {
    await sendRequest(serverId, 'ping', {}, 5_000);
    return true;
  } catch {
    return false;
  }
}
