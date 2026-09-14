import express from 'express';
import { randomUUID, createHash } from 'crypto';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync, mkdirSync } from 'fs';
import path from 'path';
import { PROVIDER_TYPES, buildProviderAuth, buildChatUrl, buildChatPayload } from './llm-helpers.mjs';
import { sanitizeFtsQuery } from './memory.mjs';
import { decryptProvider } from './settings.mjs';
import { getModelCost } from './costs.mjs';
import { record as recordLearningEvent } from '../learning/events.mjs';
import { shadowRoute } from '../learning/retrieval.mjs';
import { sanitizeCommand, sanitizeAgentCommand, spawnArgv } from '../command-safety.mjs';
import { safeFetch } from '../safe-fetch.mjs';
import { decide as policyDecide, CAPABILITIES } from '../defense/policy.mjs';

/**
 * Aimi Coding Agent: sandbox agent with plan/read/write/exec/iterate loop.
 * Dependencies (via ctx): db, stmts, authMiddleware, requireRole, apiLimiter,
 *   PORT, logger, broadcast, broadcastLog, fireHook, getDevSetting, executeSkill
 *
 * Named exports:
 *   - callAgentLLM(messages, modelOverride) — shared LLM call function
 *   - callAgentLLMWithRetry(messages, modelOverride, maxRetries) — with retry + concurrency
 *   - agentTools — tool registry array
 *   - registerAgentTool(name, description, parameters, executeFn) — register a tool
 */

// ─── Aimi Coding Agent (VS Code Copilot-style) ────────────────────
// Semi-autonomous mode: plan → draft diffs → user approves → write
// Agent mode: plan → read/write/exec autonomously → report results
// Autopilot: server-side loop with native function calling
// File scope: sandbox = /home/haz/ai-workspace/, home = /home/haz/

const SANDBOX_DIR = process.env.AGENT_SANDBOX_DIR || '/home/haz/ai-workspace';
const HOME_DIR = process.env.AGENT_HOME_DIR || '/home/haz';
const ALLOWED_READ_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.json', '.md', '.txt', '.py', '.sh', '.html', '.css', '.yaml', '.yml', '.env', '.sql', '.xml'];
const MAX_AGENT_STEPS = 20;
const AGENT_STEP_DELAY_MS = 100;

// Module-level deps — populated by agentRoutes(ctx)
// Proxy that lazily forwards to _ctx (avoids TDZ on getter properties in ctx)
let _ctxRef = null;
const _deps = new Proxy({}, {
  get(_t, prop) { return _ctxRef?.[prop]; },
});

// ─── Filesystem containment (P0: realpath + relative gate) ─────────
// The old lexical `resolved.startsWith(base)` check is NOT a filesystem
// boundary: `..` traversal, sibling-prefix collisions (`/x-secret` vs `/x`),
// and symlink escapes all defeat it. This resolver:
//   1. rejects `..` / absolute escapes lexically (fast first gate),
//   2. realpath()s the configured scope root (its true identity),
//   3. realpath()s the deepest EXISTING ancestor of the target (so a
//      symlinked parent directory is resolved to what it actually points at),
//   4. joins the remaining "new" path components to that real ancestor, then
//   5. requires the result to remain inside the real scope root via
//      path.relative(). Sibling-prefix attacks fail here because the real
//      root `/srv/ws` and `/srv/ws-secret` differ by more than a path prefix.
// Fail closed: any resolution that escapes is rejected with a traversal error.

function ensureBaseExists(base) {
  try { mkdirSync(base, { recursive: true }); return realpathSync(base); }
  catch { throw new Error('Path traversal blocked: cannot access scope root'); }
}

function deepestExistingAncestor(candidate) {
  let cur = candidate;
  while (true) {
    if (existsSync(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function resolveSandboxPath(scope, targetPath, options = {}) {
  const base = scope === 'home' ? HOME_DIR : SANDBOX_DIR;
  const candidate = path.resolve(base, String(targetPath || '.'));

  // Gate 1 — lexical containment (fast reject of obvious escapes).
  const relLex = path.relative(base, candidate);
  if (relLex === '..' || relLex.startsWith(`..${path.sep}`) || path.isAbsolute(relLex)) {
    throw new Error('Path traversal blocked: target outside scope');
  }

  const realBase = ensureBaseExists(base);

  // Gate 2 — real containment. Resolve symlinks for every EXISTING part of
  // the target; only the final "not yet created" components stay unresolved
  // (they are plain names under an already-contained real ancestor).
  const existingAncestor = deepestExistingAncestor(candidate);
  let realTarget;
  if (existingAncestor) {
    const realAncestor = realpathSync(existingAncestor);
    const tail = path.relative(existingAncestor, candidate);
    if (tail === '..' || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) {
      throw new Error('Path traversal blocked: target outside scope');
    }
    realTarget = tail ? path.join(realAncestor, tail) : realAncestor;
  } else {
    realTarget = path.join(realBase, path.relative(base, candidate));
  }

  const relReal = path.relative(realBase, realTarget);
  if (relReal === '..' || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal)) {
    throw new Error('Path traversal blocked: target resolves outside scope (symlink escape)');
  }
  return realTarget;
}

// ─── Shared shell-free command runner (C1 fix + P0.2 agent policy) ──
// The agent's shell_exec tool and POST /api/agent/exec both run through
// here: the AGENT-restricted sanitizeAgentCommand allowlist (no code
// interpreters, no network binaries) + spawn(shell:false) — the same path
// as executeTask minus the interpreter/egress primitives. No shell ever
// interprets the command string, so shell metacharacters are rejected,
// never executed. Path-like arguments are additionally resolved against
// the agent scope so the shell cannot be used to read or write outside the
// workspace (e.g. `cat /etc/passwd` or `ls ../..`). Returns a result object
// (never throws for bad input) so agent loops stay alive.

function isAgentPathToken(tok) {
  return tok === '.' || tok === '..' || tok.startsWith('./') || tok.startsWith('../') || tok.startsWith('/');
}

async function runAgentCommand(command, workDir, scope = 'sandbox') {
  const check = sanitizeAgentCommand(command);
  if (!check.safe) return { error: `Command blocked by agent safety filter: ${check.error}` };
  for (const arg of [check.command, ...(check.args || [])]) {
    if (isAgentPathToken(arg)) {
      try { resolveSandboxPath(scope, arg); }
      catch { return { error: `Command blocked by agent safety filter: target path outside sandbox (${arg})` }; }
    }
  }
  try { (await import('fs')).mkdirSync(workDir, { recursive: true }); }
  catch (e) { return { error: `Cannot create working directory: ${e.message}` }; }
  return new Promise((resolve) => {
    const child = spawn(check.command, check.args, {
      timeout: 30000,
      shell: false,
      env: { PATH: process.env.PATH },
      cwd: workDir,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => resolve({ error: `Execution failed: ${e.message}` }));
    child.on('close', (code) => resolve({
      exitCode: code ?? 0,
      stdout: stdout.slice(0, 10000),
      stderr: stderr.slice(0, 2000),
      truncated: stdout.length > 10000,
    }));
  });
}

// ─── Agent Tool Registry ──────────────────────────────────────────
// Each tool has: name, description, parameters (OpenAI function format), execute function
const agentTools = [];

function registerAgentTool(name, description, parameters, executeFn) {
  agentTools.push({ name, description, parameters, execute: executeFn });
}

// Remove a tool from the registry by name. Returns true when a tool was
// removed, false when no tool with that name was registered. Used by the
// MCP manager (Track C) to un-surface stale MCP tools on disconnect.
export function unregisterAgentTool(name) {
  const idx = agentTools.findIndex(t => t.name === name);
  if (idx === -1) return false;
  agentTools.splice(idx, 1);
  return true;
}

// OpenAI function-calling format for tool definitions
function getToolDefinitions() {
  return agentTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ─── Built-in Tools ───────────────────────────────────────────────

registerAgentTool(
  'file_read',
  'Read the contents of a file. Returns content with line numbers.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace' },
      scope: { type: 'string', enum: ['sandbox', 'home'], description: 'File scope boundary' },
    },
    required: ['path'],
  },
  async (args, ctx) => {
    const resolved = resolveSandboxPath(args.scope || ctx.scope || 'sandbox', args.path);
    const fs = await import('fs');
    const stat = await fs.promises.stat(resolved);
    if (stat.size > 500_000) return { error: 'File too large (max 500KB)' };
    const content = await fs.promises.readFile(resolved, 'utf-8');
    return { path: args.path, content: content.slice(0, 50000), size: stat.size, truncated: stat.size > 50000 };
  }
);

registerAgentTool(
  'file_write',
  'Write content to a file. Creates directories if needed.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace' },
      content: { type: 'string', description: 'File content to write' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
    },
    required: ['path', 'content'],
  },
  async (args, ctx) => {
    const resolved = resolveSandboxPath(args.scope || ctx.scope || 'sandbox', args.path);
    if (args.content.length > 500_000) return { error: 'Content too large (max 500KB)' };
    const fs = await import('fs');
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, args.content, 'utf-8');
    return { written: true, path: args.path, size: args.content.length };
  }
);

registerAgentTool(
  'file_list',
  'List files in a directory within the workspace.',
  {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Relative directory path (default: root)' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      depth: { type: 'integer', description: 'Max depth to traverse (default: 3)' },
    },
  },
  async (args, ctx) => {
    const scope = args.scope || ctx.scope || 'sandbox';
    const realBase = ensureBaseExists(scope === 'home' ? HOME_DIR : SANDBOX_DIR);
    const resolved = resolveSandboxPath(scope, args.dir || '.');
    const maxDepth = args.depth || 3;
    function walk(dir, currentDepth) {
      const items = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(realBase, full);
          if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
          if (entry.isDirectory() && currentDepth < maxDepth) {
            items.push({ name: entry.name, path: rel, type: 'dir' });
            if (!['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
              items.push(...walk(full, currentDepth + 1));
            }
          } else if (entry.isFile()) {
            items.push({ name: entry.name, path: rel, type: 'file', size: statSync(full).size });
          }
        }
      } catch {}
      return items;
    }
    return { files: walk(resolved, 0) };
  }
);

registerAgentTool(
  'file_search',
  'Search file contents using regex patterns. Returns matching lines with file paths.',
  {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      max_results: { type: 'integer', description: 'Max results to return (default: 20)' },
    },
    required: ['pattern'],
  },
  async (args, ctx) => {
    const scope = args.scope || ctx.scope || 'sandbox';
    const realBase = ensureBaseExists(scope === 'home' ? HOME_DIR : SANDBOX_DIR);
    const maxResults = Math.min(Math.max(parseInt(args.max_results, 10) || 20, 1), 200);
    const pattern = String(args.pattern || '');
    if (!pattern) return { matches: [], count: 0, error: 'Search pattern is required' };
    // Command-injection fix: shell-free argv execution via the shared
    // spawnArgv helper. The pattern is an argv element (data), never
    // interpolated into a shell string. Brace expansion and pipes are
    // shell features, so --include flags are passed separately and the
    // head(1) truncation is done in JS instead.
    const check = sanitizeCommand('grep');
    if (!check.safe) return { matches: [], count: 0, error: check.error };
    try { (await import('fs')).mkdirSync(realBase, { recursive: true }); }
    catch (e) { return { matches: [], count: 0, error: `Cannot access directory: ${e.message}` }; }
    const grepArgs = [
      '-rn',
      ...['js', 'jsx', 'ts', 'tsx', 'mjs', 'json', 'md', 'txt', 'py', 'sh'].map((e) => `--include=*.${e}`),
      `--max-count=${maxResults}`,
      pattern,
      realBase,
    ];
    try {
      const stdout = await spawnArgv('grep', grepArgs, { timeout: 10000, cwd: realBase });
      const results = stdout.split('\n').filter(Boolean).slice(0, maxResults).map(line => {
        const [file, ...rest] = line.split(':');
        const lineNum = rest[0];
        const content = rest.slice(1).join(':');
        return { file: path.relative(realBase, file), line: parseInt(lineNum) || 0, content: content.slice(0, 200) };
      });
      return { matches: results, count: results.length };
    } catch (e) {
      // grep exits 1 when nothing matches — not an error.
      if (/exit code 1/.test(e.message)) return { matches: [], count: 0 };
      return { matches: [], count: 0, error: e.message };
    }
  }
);

registerAgentTool(
  'shell_exec',
  'Execute a command in the workspace through the restricted agent allowlist with no shell: only read-only inspection commands (echo, ls, cat, pwd, date, whoami, hostname, uname, df, free, uptime, ps, wc, head, tail, grep, sort, uniq) and no shell metacharacters (; | & > < $ ` \\ ! {} () [] * ? ~ #). Code interpreters (node, python3, bash) are disabled — writing a script and invoking it is not possible. Network binaries (curl, wget) are disabled — use the web_fetch/web_search tools for network access. Chained commands, pipes, redirects, and command substitution are rejected.',
  {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Single command to execute (no shell syntax: no pipes, redirects, or command substitution)' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      cwd: { type: 'string', description: 'Working directory (relative to scope)' },
    },
    required: ['command'],
  },
  async (args, ctx) => {
    // C1 fix + P0.2 agent policy: sanitizeAgentCommand (interpreters and
    // network binaries removed for the agent) + shell:false argv execution
    // (see runAgentCommand above). No shell ever interprets this string.
    const workDir = (ctx.scope || args.scope || 'sandbox') === 'home' ? HOME_DIR : resolveSandboxPath(ctx.scope || args.scope || 'sandbox', args.cwd || '.');
    return runAgentCommand(args.command, workDir, ctx.scope || args.scope || 'sandbox');
  }
);

registerAgentTool(
  'web_search',
  'Search the web for information. Uses Tavily API.',
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'integer', description: 'Max results (default: 5)' },
    },
    required: ['query'],
  },
  async (args) => {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) return { error: 'Tavily API key not configured' };
    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: args.query,
          max_results: args.max_results || 5,
        }),
      });
      const data = await resp.json();
      return {
        results: (data.results || []).map(r => ({
          title: r.title,
          url: r.url,
          content: (r.content || '').slice(0, 500),
        })),
      };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'web_fetch',
  'Fetch a URL and extract text content. Server-side request (SSRF-safe): private/loopback/metadata addresses are blocked; 15s timeout.',
  {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
  async (args) => {
    try {
      // H1 fix: route through safeFetch (blocks private/link-local/169.254.169.254,
      // re-validates redirects) with a real timeout via AbortSignal.timeout.
      const resp = await safeFetch(args.url, { signal: AbortSignal.timeout(15000) });
      const text = await resp.text();
      // Strip HTML tags if it's HTML
      const stripped = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                           .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                           .replace(/<[^>]+>/g, ' ')
                           .replace(/\s+/g, ' ')
                           .trim();
      return { content: stripped.slice(0, 10000), url: args.url, status: resp.status, truncated: stripped.length > 10000 };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'git_op',
  'Perform git operations (status, diff, log, add, commit). Read-only operations are always allowed.',
  {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['status', 'diff', 'log', 'add', 'commit', 'branch'], description: 'Git operation' },
      args: { type: 'string', description: 'Arguments for the operation (e.g., commit message)' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
    },
    required: ['operation'],
  },
  async (args, ctx) => {
    const workDir = (args.scope || ctx.scope || 'sandbox') === 'home' ? HOME_DIR : SANDBOX_DIR;
    // Command-injection fix: fixed operation→argv allowlist + shell-free
    // argv execution via the shared spawnArgv helper. The commit message is
    // an argv element (data) — never interpolated into a shell string, so
    // quotes/semicolons/substitutions in it are harmless. 'git' is
    // deliberately NOT added to the generic sanitizeCommand allowlist
    // (that would widen shell_exec); this tool's allowlist is the map below.
    const ops = {
      status: ['status', '--short'],
      diff: ['diff'],
      log: ['log', '--oneline', '-10'],
      branch: ['branch', '-a'],
      add: ['add', '-A'],
    };
    let gitArgs = ops[args.operation];
    if (args.operation === 'commit') {
      const message = String(args.args || '').trim();
      if (!message) return { error: 'Commit operation requires a message in args' };
      gitArgs = ['commit', '-m', message];
    }
    if (!gitArgs) return { error: `Unknown git operation: ${args.operation}` };
    try { (await import('fs')).mkdirSync(workDir, { recursive: true }); }
    catch (e) { return { error: `Cannot create working directory: ${e.message}` }; }
    try {
      const stdout = await spawnArgv('git', gitArgs, { timeout: 10000, cwd: workDir });
      return { output: stdout.slice(0, 5000) };
    } catch (e) {
      return { error: e.message.toString().slice(0, 500) };
    }
  }
);

registerAgentTool(
  'mcp_invoke',
  'Invoke a registered MCP tool.',
  {
    type: 'object',
    properties: {
      server_id: { type: 'string', description: 'MCP server ID' },
      tool_name: { type: 'string', description: 'Tool name to invoke' },
      arguments: { type: 'object', description: 'Tool arguments' },
    },
    required: ['server_id', 'tool_name'],
  },
  async (args) => {
    try {
      const result = await mcp.invokeTool(args.server_id, args.tool_name, args.arguments || {});
      return { result };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'skill_invoke',
  'Invoke a stored Cardinal Frame skill by name.',
  {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name' },
      input: { type: 'string', description: 'Input for the skill' },
    },
    required: ['name'],
  },
  async (args) => {
    const skill = _deps.stmts.skills.getByName.get(args.name);
    if (!skill) return { error: `Skill not found: ${args.name}` };
    try {
      const { result: handlerResult } = await runSandboxed({
        code: skill.handler,
        input: args.input || '',
        allowNetwork: skill.network_access === 1,
      });
      return { result: handlerResult };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'delegate_task',
  'Delegate a subtask to another agent. Use this to parallelize work or leverage specialized agents. Returns the delegation result if synchronous, or a delegation ID to poll later.',
  {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name for the delegated subtask' },
      command: { type: 'string', description: 'Command to execute on the target agent' },
      capability: { type: 'string', description: 'Required capability (e.g. "build", "test", "deploy"). Finds a matching agent automatically.' },
      agentId: { type: 'string', description: 'Specific agent ID to delegate to. If omitted, auto-selects by capability.' },
      synchronous: { type: 'boolean', description: 'If true, wait for the subtask to complete and return the result. If false, returns immediately with a delegation ID.' },
      waitTimeout: { type: 'integer', description: 'Max milliseconds to wait if synchronous (default: 30000)' },
    },
    required: ['name', 'command'],
  },
  async (args) => {
    try {
      const response = await fetch(`http://localhost:${process.env.PORT || 8080}/api/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: args.name,
          command: args.command,
          capability: args.capability,
          agentId: args.agentId,
          synchronous: args.synchronous !== false,
          wait: args.synchronous !== false,
          waitTimeout: args.waitTimeout || 30000,
        }),
      });
      const result = await response.json();
      if (!response.ok) return { error: result.error || 'Delegation failed' };
      return {
        delegationId: result.id,
        status: result.status,
        childTaskId: result.childTaskId,
        agentId: result.agentId,
        result: result.result,
        childTask: result.childTask,
        message: result.message,
      };
    } catch (e) {
      return { error: `Delegation request failed: ${e.message}` };
    }
  }
);

// ─── Execute a tool by name ───────────────────────────────────────
// Policy boundary: every agent tool maps to a capability and is decided
// fail-closed before execution (P1.6). `actNoPolicy`/`policyProvenance` are
// internal escape hatches for trusted, already-authorized callers only; the
// default is enforcement on every agent tool call reaching the funnel.
const AGENT_TOOL_CAPABILITY = {
  file_read: CAPABILITIES.FILESYSTEM_READ,
  file_list: CAPABILITIES.FILESYSTEM_READ,
  file_search: CAPABILITIES.FILESYSTEM_READ,
  file_write: CAPABILITIES.FILESYSTEM_WRITE,
  shell_exec: CAPABILITIES.PROCESS_EXECUTION,
  git_op: CAPABILITIES.PROCESS_EXECUTION,
  web_fetch: CAPABILITIES.NETWORK_EXTERNAL,
  web_search: CAPABILITIES.NETWORK_EXTERNAL,
  mcp_invoke: CAPABILITIES.MCP_CALL,
  skill_invoke: CAPABILITIES.CODE_EXECUTION,
  delegate_task: CAPABILITIES.PROCESS_EXECUTION,
};

async function executeAgentTool(toolName, args, ctx) {
  const tool = agentTools.find(t => t.name === toolName);
  if (!tool) return { error: `Unknown tool: ${toolName}` };
  try {
    const capability = AGENT_TOOL_CAPABILITY[toolName];
    if (capability && !(ctx && ctx.actNoPolicy)) {
      const decision = await policyDecide({
        actor: { id: ctx?.userId || null, role: ctx?.role || 'user' },
        capability,
        resource: toolName,
        scope: ctx?.scope || 'sandbox',
        provenance: (ctx && ctx.policyProvenance) || 'user',
      });
      if (!decision.allowed) {
        _deps.fireHook('onAgentStep', {
          sessionId: ctx?.sessionId, toolName, args,
          result: { error: `Policy denied ${toolName}: ${decision.reason}` },
          success: false, policyDenied: true, auditId: decision.auditId,
        });
        return { error: `Policy denied ${toolName}: ${decision.reason}`, policyDenied: true };
      }
    }
    const result = await tool.execute(args || {}, ctx || {});
    _deps.fireHook('onAgentStep', { sessionId: ctx?.sessionId, toolName, args, result, success: !result.error });
    return result;
  } catch (e) {
    _deps.fireHook('onAgentStep', { sessionId: ctx?.sessionId, toolName, args, result: { error: e.message }, success: false });
    return { error: e.message };
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────
// Runs autonomously server-side: LLM plans → calls tools → gets results → continues
// Broadcasts progress over WebSocket. Returns final summary.

// ─── Memory write-back (Muse pattern) ─────────────────────────────
// The agent recalls memories before acting; it also records what the
// session taught it. One episodic memory per terminal session, redacted,
// with the session id as provenance. The learning pipeline can distill
// these into procedures later — this is the fast write-first layer.
function redactForMemory(text) {
  return String(text || '')
    .replace(/(api[_-]?key|secret|password|passwd|token|bearer)\s*[:=]\s*['"]?[^\s'"]+/gi, '$1=[redacted]')
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[redacted private key]');
}

function writeSessionMemory(session, outcome, detail) {
  try {
    const actions = _deps.stmts.agentActions.getBySession.all(session.id);
    const keyActions = actions
      .filter(a => ['write', 'exec', 'response'].includes(a.action_type))
      .slice(-8)
      .map(a => `- ${a.action_type} ${a.target || ''}: ${String(a.result || a.content || '').slice(0, 160)}`)
      .join('\n');
    const content = redactForMemory(
      `[agent session ${session.id}] Task: ${session.task}\n` +
      `Outcome: ${outcome}\n` +
      (detail ? `Detail: ${String(detail).slice(0, 500)}\n` : '') +
      (keyActions ? `Key actions:\n${keyActions}` : 'No actions recorded.')
    ).slice(0, 4000);
    _deps.stmts.memories.insert.run(randomUUID(), session.user_id, 'episodic', content, `agent:${session.id}`, 0.7);
    _deps.logger.info(`Agent loop: wrote session memory for ${session.id} (${outcome})`);
  } catch (e) { _deps.logger.error(`Agent loop memory write-back failed: ${e.message}`); }
}

// ─── Phase 1: durable learning events (capture-only) ─────────────
// Writes one redacted, user-scoped, idempotent evidence row per tool
// outcome and per terminal turn. recordLearningEvent() never throws and
// never triggers reviews, candidates, or skill changes — the loop's
// behavior is unchanged when capture is disabled or fails.
function captureLearningEvent(session, { type, payload, outcome, terminalVersion }) {
  try {
    recordLearningEvent(_deps.db, {
      userId: session.user_id,
      conversationId: session.conversation_id || session.id,
      traceId: session.id,
      type,
      payload,
      outcome,
      terminalVersion,
    });
  } catch { /* record() is already never-throw; belt and suspenders */ }
}

function terminalVersionFor(text, step) {
  return createHash('sha256').update(`${step}|${String(text || '').slice(0, 2000)}`).digest('hex').slice(0, 16);
}

async function runAgentLoop(sessionId, options = {}) {
  const session = _deps.stmts.agentSessions.getById.get(sessionId);
  if (!session) throw new Error('Session not found');

  // ─── Phase 5: shadow retrieval routing (never affects the loop) ────
  // Fire-and-forget: shadowRoute() never throws internally and this call
  // is not awaited, returns nothing the loop consumes, and cannot change
  // agent behavior. It only records what skill version WOULD have been
  // routed for the review UI.
  try {
    shadowRoute({ db: _deps.db, userId: session.user_id, requestText: session.task, context: { sessionId } })
      .then(r => { try { _deps.logger.debug(`shadow route ${r.decisionId ?? 'n/a'}: ${r.decision}`); } catch { /* never throws */ } })
      .catch(() => { /* fire-and-forget: swallow */ });
  } catch { /* the call itself must not disturb the loop */ }

  const ctx = { scope: session.scope, sessionId, userId: session.user_id, role: 'user' };
  try {
    const userRec = _deps.stmts?.users?.getById?.get(session.user_id);
    if (userRec?.role) ctx.role = userRec.role;
  } catch { /* default to 'user' on lookup failure */ }
  const maxSteps = options.maxSteps || MAX_AGENT_STEPS;
  const model = options.model || session.model || undefined;
  const toolDefs = getToolDefinitions();

  // Build initial system prompt
  const systemPrompt = `You are Aimi, an autonomous coding agent. You work by calling tools to accomplish tasks.

Task: ${session.task}
Mode: ${session.mode}
File scope: ${session.scope === 'sandbox' ? '/home/haz/ai-workspace (sandbox)' : '/home/haz (home dir)'}

You have access to the following tools. Call them by using function calling.
When the task is complete, respond with a summary (no tool call needed).

Remember:
- Read files before writing to understand existing code
- Use file_search to find relevant files
- Test your work with shell_exec
- Keep changes focused and minimal`;

  // Track conversation for LLM context
  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Please work on this task: ${session.task}` },
  ];

  // ─── Memory recall: inject relevant memories into context ──────
  // Uses the shared FTS sanitizer (same as the memory search API) so task
  // text with quotes/parens can't break the MATCH query.
  try {
    const ftsQuery = sanitizeFtsQuery(session.task);
    const memResults = ftsQuery ? _deps.stmts.memories.search.all(ftsQuery, session.user_id, 5) : [];
    if (memResults && memResults.length > 0) {
      const memText = memResults.map(m => `- [${m.category}] ${m.content.slice(0, 200)}`).join('\n');
      messages.splice(1, 0, {
        role: 'system',
        content: `Relevant memories from past sessions:\n${memText}\n\nUse these if helpful for the current task.`,
      });
      _deps.logger.info(`Agent loop: injected ${memResults.length} memories into context`);
    }
  } catch (e) { /* FTS5 may not be ready in all envs */ }

  // ─── Index this session for future search ─────────────────────
  try {
    _deps.stmts.sessionIndex.insert.run(
      randomUUID(), 'agent', sessionId, session.user_id,
      session.task.slice(0, 100), session.task
    );
  } catch (e) { /* may already exist on resume */ }

  // Load any existing actions into context (for resumed sessions)
  const existingActions = _deps.stmts.agentActions.getBySession.all(sessionId);
  if (existingActions.length > 0) {
    for (const action of existingActions.slice(-10)) {
      messages.push({ role: 'assistant', content: `I performed ${action.action_type} on ${action.target}. Result: ${(action.result || '').slice(0, 200)}` });
    }
    messages.push({ role: 'user', content: 'Continue working on the task.' });
  }

  // Track step index in JS to avoid redundant getBySession.all() queries
  let stepCounter = existingActions.length;

  // Update session status
  _deps.stmts.agentSessions.updateStatus.run('executing', sessionId);
  _deps.broadcast('agent:loop:start', { session_id: sessionId, max_steps: maxSteps });

  let totalTokens = { prompt: 0, completion: 0 };

  for (let step = 0; step < maxSteps; step++) {
    _deps.broadcast('agent:step', { session_id: sessionId, step: step + 1, status: 'thinking' });
    _deps.stmts.agentSessions.updateStep.run(step + 1, sessionId);

    let llmResult;
    try {
      llmResult = await callAgentLLMWithToolsRetry(messages, toolDefs, model);
    } catch (e) {
      _deps.logger.error(`Agent loop LLM error at step ${step + 1}: ${e.message}`);
      _deps.broadcast('agent:loop:error', { session_id: sessionId, step: step + 1, error: e.message });
      _deps.stmts.agentSessions.updateStatus.run('failed', sessionId);

      // Record the error as an action for debugging
      const errActionId = randomUUID();
      const errStepIdx = stepCounter;
      _deps.stmts.agentActions.insert.run(errActionId, sessionId, errStepIdx, 'error', 'llm_call', e.message, JSON.stringify({ error: e.message }), 'failed');
      stepCounter++;

      writeSessionMemory(session, 'failed', e.message);
      // Phase 1 capture: terminal turn (LLM failure)
      captureLearningEvent(session, {
        type: 'turn_terminal',
        outcome: 'failed',
        terminalVersion: terminalVersionFor(e.message, step + 1),
        payload: { step: step + 1, errorPreview: String(e.message).slice(0, 500) },
      });
      return { completed: false, error: e.message, steps: step + 1, tokens: totalTokens };
    }

    totalTokens.prompt += llmResult.promptTokens || 0;
    totalTokens.completion += llmResult.completionTokens || 0;

    // If LLM returned a tool call, execute it
    if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
      for (const toolCall of llmResult.toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

        _deps.broadcast('agent:step', {
          session_id: sessionId,
          step: step + 1,
          status: 'executing_tool',
          tool: toolName,
          args: toolArgs,
        });

        // Suggest mode: consequential tools need approval BEFORE they run
        // (Muse pattern — the approval card gates the action; it never
        // reviews something that already executed). The gated call is stored
        // on the pending action and runs only when POST /agent/approve fires.
        if (session.mode === 'suggest' && ['file_write', 'shell_exec', 'git_op'].includes(toolName)) {
          const actionId = randomUUID();
          const stepIdx = stepCounter;
          _deps.stmts.agentActions.insert.run(
            actionId, sessionId, stepIdx, toolName === 'file_write' ? 'write' : 'exec',
            toolArgs.path || toolArgs.command || toolName,
            JSON.stringify({ tool: toolName, args: toolArgs }),
            'awaiting approval',
            'pending'
          );

          _deps.broadcast('agent:approval_required', {
            session_id: sessionId,
            step: step + 1,
            action_id: actionId,
            tool: toolName,
            args: toolArgs,
            preview: toolName === 'file_write'
              ? { path: toolArgs.path, content: String(toolArgs.content || '').slice(0, 2000) }
              : { command: toolArgs.command },
          });

          _deps.stmts.agentSessions.updateStatus.run('awaiting_approval', sessionId);
          stepCounter++;
          // Phase 1 capture: terminal turn (paused for approval)
          captureLearningEvent(session, {
            type: 'turn_terminal',
            outcome: 'awaiting_approval',
            terminalVersion: actionId,
            payload: { step: step + 1, tool: toolName, actionId },
          });
          return {
            completed: false,
            paused: true,
            reason: 'approval_required',
            action_id: actionId,
            step: step + 1,
            tokens: totalTokens,
          };
        }

        // Execute the tool
        const result = await executeAgentTool(toolName, toolArgs, ctx);

        // Record the action
        const actionId = randomUUID();
        const stepIdx = stepCounter;
        _deps.stmts.agentActions.insert.run(
          actionId, sessionId, stepIdx,
          toolName === 'file_read' ? 'read' :
          toolName === 'file_write' ? 'write' :
          toolName === 'shell_exec' ? 'exec' :
          toolName === 'web_search' ? 'search' : toolName,
          toolArgs.path || toolArgs.command || toolArgs.query || toolName,
          toolArgs.content || JSON.stringify(toolArgs).slice(0, 2000),
          JSON.stringify(result).slice(0, 5000),
          'completed'
        );
        stepCounter++;

        // Phase 1 capture: tool outcome evidence (redacted, idempotent on actionId)
        captureLearningEvent(session, {
          type: 'tool_outcome',
          outcome: result && result.error ? 'failed' : 'completed',
          terminalVersion: actionId,
          payload: {
            tool: toolName,
            target: toolArgs.path || toolArgs.command || toolArgs.query || toolName,
            step: step + 1,
            success: !(result && result.error),
            resultPreview: JSON.stringify(result).slice(0, 500),
          },
        });

        _deps.broadcast('agent:step', {
          session_id: sessionId,
          step: step + 1,
          status: 'tool_complete',
          tool: toolName,
          result_preview: JSON.stringify(result).slice(0, 200),
        });

        // Feed the result back to the LLM
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolName, arguments: toolCall.function.arguments } }],
        });
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify(result).slice(0, 4000),
        });
      }

      // Rate-limit delay between steps
      if (AGENT_STEP_DELAY_MS > 0) await new Promise(r => setTimeout(r, AGENT_STEP_DELAY_MS));
      continue;
    }

    // No tool call — LLM is either done or wants to say something
    const content = llmResult.content || '';

    // Record the final response
    const actionId = randomUUID();
    const stepIdx = stepCounter;
    _deps.stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'response', 'complete', content.slice(0, 5000), JSON.stringify({ summary: content.slice(0, 2000) }), 'completed');
    stepCounter++;

    _deps.stmts.agentSessions.updateStatus.run('completed', sessionId);
    _deps.broadcast('agent:loop:complete', {
      session_id: sessionId,
      steps: step + 1,
      summary: content.slice(0, 500),
      tokens: totalTokens,
    });

    // ── Comms reply: if this session was triggered by a comms message, send result back ──
    try {
      const commsMsg = _deps.db.prepare('SELECT * FROM comms_messages WHERE agent_session_id = ?').get(sessionId);
      if (commsMsg) {
        const channel = _deps.stmts.commsChannels.getById.get(commsMsg.channel_id);
        if (channel) {
          await sendCommsReply(channel, commsMsg, content);
        }
      }
    } catch (e) { _deps.logger.error(`Comms reply hook failed: ${e.message}`); }

    writeSessionMemory(session, 'completed', content);
    // Phase 1 capture: terminal turn (final response)
    captureLearningEvent(session, {
      type: 'turn_terminal',
      outcome: 'completed',
      terminalVersion: terminalVersionFor(content, step + 1),
      payload: {
        step: step + 1,
        tokens: totalTokens,
        summaryPreview: content.slice(0, 500),
      },
    });
    return {
      completed: true,
      summary: content,
      steps: step + 1,
      tokens: totalTokens,
    };
  }

  // Hit max steps
  _deps.stmts.agentSessions.updateStatus.run('max_steps_reached', sessionId);
  _deps.broadcast('agent:loop:complete', { session_id: sessionId, steps: maxSteps, summary: 'Max steps reached', tokens: totalTokens });

  writeSessionMemory(session, 'max_steps_reached', `Stopped after ${maxSteps} steps without a final summary.`);
  // Phase 1 capture: terminal turn (max steps)
  captureLearningEvent(session, {
    type: 'turn_terminal',
    outcome: 'max_steps_reached',
    terminalVersion: terminalVersionFor('max_steps', maxSteps),
    payload: { steps: maxSteps, tokens: totalTokens },
  });
  return {
    completed: false,
    reason: 'max_steps_reached',
    steps: maxSteps,
    tokens: totalTokens,
  };
}

// ─── LLM call with native function calling ────────────────────────
async function callAgentLLMWithTools(messages, toolDefs, modelOverride) {
  let provider, modelRecord;
  if (modelOverride) {
    modelRecord = _deps.db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').get(modelOverride, modelOverride);
    if (modelRecord) provider = _deps.stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider) {
    modelRecord = _deps.stmts.models.getDefault.get();
    if (modelRecord) provider = _deps.stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider || !provider.api_key) throw new Error('No LLM provider with API key configured');
  decryptProvider(provider); // api_key is encrypted at rest in llm_providers

  const modelId = modelRecord?.model_id || 'gpt-3.5-turbo';
  const providerType = PROVIDER_TYPES[provider.type];
  const baseUrl = provider.base_url || providerType?.baseUrl || '';
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model: modelId,
    messages,
    max_tokens: 4096,
    stream: false,
  };

  // Include tools in the request if the provider supports function calling
  if (toolDefs && toolDefs.length > 0) {
    body.tools = toolDefs;
    body.tool_choice = 'auto';
  }

  const fetchHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.api_key}`,
    ...(provider.type === 'openrouter' ? { 'HTTP-Referer': 'https://cardinal-frame.local' } : {}),
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    throw new Error(`LLM fetch failed: ${fetchErr.message}`);
  }

  // If tools caused an error (some providers don't support function calling), retry without tools
  if (!resp.ok && toolDefs && toolDefs.length > 0) {
    const errText = await resp.text().catch(() => '');
    // Check if it's a tools-related error (400/422 with "tools" or "function" in the message)
    if ((resp.status === 400 || resp.status === 422) && /tool|function/i.test(errText)) {
      _deps.logger.warn(`Provider ${provider.name} doesn't support function calling, retrying with tool_prompt fallback`);
      // Remove tools and inject tool descriptions into system prompt instead
      const fallbackBody = { ...body };
      delete fallbackBody.tools;
      delete fallbackBody.tool_choice;
      // Enhance last system message with tool instructions
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        const toolList = toolDefs.map(t => `- ${t.function.name}: ${t.function.description}\n  Params: ${JSON.stringify(t.function.parameters).slice(0, 200)}`).join('\n');
        fallbackBody.messages = [...messages];
        fallbackBody.messages[sysIdx] = {
          ...messages[sysIdx],
          content: messages[sysIdx].content + `\n\n## Available Tools (use markdown format)\n${toolList}\n\nTo call a tool, respond with:\n\`\`\`tool_call\n{"tool": "tool_name", "arguments": {...}}\n\`\`\``,
        };
      }
      resp = await fetch(url, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(fallbackBody) });
    }
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM error (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const message = data.choices?.[0]?.message;
  const toolCalls = message?.tool_calls || [];

  // If no tool calls but content has ```tool_call blocks, parse them (fallback for providers without native function calling)
  if (toolCalls.length === 0 && message?.content) {
    const toolCallMatches = message.content.matchAll(/```tool_call\s*\n?([\s\S]*?)\n?```/g);
    for (const match of toolCallMatches) {
      try {
        const parsed = JSON.parse(match[1].trim());
        toolCalls.push({
          id: randomUUID(),
          type: 'function',
          function: {
            name: parsed.tool,
            arguments: JSON.stringify(parsed.arguments || {}),
          },
        });
      } catch {}
    }
  }

  return {
    content: message?.content || '',
    toolCalls,
    model: modelId,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
  };
}

// Retry wrapper for callAgentLLMWithTools (handles 429 rate limits)
async function callAgentLLMWithToolsRetry(messages, toolDefs, modelOverride, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callAgentLLMWithTools(messages, toolDefs, modelOverride);
    } catch (err) {
      lastErr = err;
      const is429 = err.message?.includes('(429)') || err.message?.includes('Too Many Requests');
      if (is429 && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        _deps.logger.warn(`Agent LLM rate limited, retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── Context window management ────────────────────────────────────
function compactAgentHistory(messages, maxMessages = 20) {
  if (messages.length <= maxMessages) return messages;
  // Keep system prompt + first user msg + last N messages
  const system = messages.filter(m => m.role === 'system');
  const firstUser = messages.find(m => m.role === 'user');
  const recent = messages.slice(-maxMessages + 2);

  // Summarize dropped messages
  const dropped = messages.slice(2, -maxMessages + 2);
  const summary = `Previous actions (summarized):\n${dropped.map(m => {
    if (m.role === 'tool') return `- Tool ${m.name}: ${m.content.slice(0, 100)}`;
    if (m.role === 'assistant') return `- Assistant: ${(m.content || 'tool call').slice(0, 100)}`;
    return `- ${m.role}: ${(m.content || '').slice(0, 100)}`;
  }).join('\n')}`;

  return [...system, { role: 'user', content: summary }, ...recent];
}

async function callAgentLLM(messages, modelOverride) {
  let provider, modelRecord;
  if (modelOverride) {
    modelRecord = _deps.db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').get(modelOverride, modelOverride);
    if (modelRecord) provider = _deps.stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider) {
    modelRecord = _deps.stmts.models.getDefault.get();
    if (modelRecord) provider = _deps.stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider || !provider.api_key) throw new Error('No LLM provider with API key configured');
  decryptProvider(provider); // api_key is encrypted at rest in llm_providers
  const modelId = modelRecord?.model_id || 'gpt-3.5-turbo';
  const providerType = PROVIDER_TYPES[provider.type];
  const baseUrl = provider.base_url || providerType?.baseUrl || '';
  const url = `${baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.api_key}`,
      ...(provider.type === 'openrouter' ? { 'HTTP-Referer': 'https://cardinal-frame.local' } : {}),
    },
    body: JSON.stringify({ model: modelId, messages, max_tokens: 4096, stream: false }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM error (${resp.status}): ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model: modelId,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
  };
}

// ─── LLM Call with Retry + Concurrency Limiting ──────────────────
const MAX_CONCURRENT_LLM = 3;
let _activeLLMCalls = 0;
const _llmQueue = [];

function _drainLLMQueue() {
  while (_llmQueue.length > 0 && _activeLLMCalls < MAX_CONCURRENT_LLM) {
    const next = _llmQueue.shift();
    _activeLLMCalls++;
    next.run().finally(() => { _activeLLMCalls--; _drainLLMQueue(); });
  }
}

async function callAgentLLMWithRetry(messages, modelOverride, maxRetries = 3) {
  // Queue if at capacity
  if (_activeLLMCalls >= MAX_CONCURRENT_LLM) {
    await new Promise(resolve => _llmQueue.push({ run: () => Promise.resolve() }));
  }
  _activeLLMCalls++;

  try {
    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await callAgentLLM(messages, modelOverride);
      } catch (err) {
        lastErr = err;
        const is429 = err.message?.includes('LLM error (429)') || err.message?.includes('429') || err.message?.includes('Too Many Requests');
        if (is429 && attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          _deps.logger.warn(`LLM rate limited, retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    _activeLLMCalls--;
    _drainLLMQueue();
  }
}

// POST /api/agent/sessions — create a new agent session

export default function agentRoutes(ctx) {
  // Wire _deps to ctx so module-level functions can access ctx props lazily
  // (getters for later-declared vars would TDZ if accessed eagerly)
  _ctxRef = ctx;
  const { db, stmts, authMiddleware, requireRole, apiLimiter, PORT, logger, broadcast, broadcastLog, fireHook, getDevSetting, executeSkill } = ctx;
  const router = express.Router();

router.post('/agent/sessions', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { task, mode = 'agent', scope = 'sandbox', conversation_id, model } = req.body;
    if (!task) return res.status(400).json({ error: 'task required' });
    if (!['agent', 'suggest'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    if (!['sandbox', 'home'].includes(scope)) return res.status(400).json({ error: 'Invalid scope' });
    const id = randomUUID();
    stmts.agentSessions.insert.run(id, req.user.id, conversation_id || null, task, mode, scope, '[]', 'planning', model || '');
    const session = stmts.agentSessions.getById.get(id);
    broadcast('agent:session', { type: 'created', session });
    res.status(201).json(session);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/sessions — list user's sessions
router.get('/agent/sessions', authMiddleware, apiLimiter, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const sessions = db.prepare('SELECT * FROM agent_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.user.id, limit);
    res.json(sessions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/sessions/:id — get session with actions
router.get('/agent/sessions/:id', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const actions = stmts.agentActions.getBySession.all(req.params.id);
    res.json({ ...session, plan: JSON.parse(session.plan || '[]'), actions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/agent/sessions/:id/mode — toggle mode (suggest ↔ agent)
router.patch('/agent/sessions/:id/mode', authMiddleware, (req, res) => {
  try {
    const { mode } = req.body;
    if (!['agent', 'suggest'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.agentSessions.updateMode.run(mode, req.params.id);
    const updated = stmts.agentSessions.getById.get(req.params.id);
    broadcast('agent:session', { type: 'mode_changed', session: updated });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/plan — generate a plan for a task using LLM
router.post('/agent/plan', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { task, scope = 'sandbox', model } = req.body;
    if (!task) return res.status(400).json({ error: 'task required' });
    const planPrompt = `You are Aimi, an autonomous coding agent. Analyze the following task and create a step-by-step plan.
Task: ${task}
File scope: ${scope === 'sandbox' ? '/home/haz/ai-workspace (sandbox)' : '/home/haz (home dir)'}

Respond as JSON:
{
  "steps": [
    { "description": "Read file X", "action": "read", "target": "path/to/file" },
    { "description": "Write code Y", "action": "write", "target": "path/to/file" },
    { "description": "Run build", "action": "exec", "target": "npm run build" }
  ]
}
Only include steps you are confident about. Keep it to max 8 steps.`;
    const result = await callAgentLLM([
      { role: 'system', content: planPrompt },
      { role: 'user', content: task }
    ], model);
    let plan;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      plan = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      plan = { steps: [{ description: result.content.slice(0, 500), action: 'response', target: 'LLM response' }] };
    }
    res.json({
      plan: plan.steps || [],
      model: result.model,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/read — read a file from sandbox/home scope
router.post('/agent/read', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { path: targetPath, scope = 'sandbox' } = req.body;
    if (!targetPath) return res.status(400).json({ error: 'path required' });
    const resolved = resolveSandboxPath(scope, targetPath);
    const fs = await import('fs');
    const stat = await fs.promises.stat(resolved);
    if (stat.size > 500_000) return res.status(400).json({ error: 'File too large (max 500KB)' });
    const content = await fs.promises.readFile(resolved, 'utf-8');
    res.json({
      path: targetPath,
      resolved,
      content: content.slice(0, 50000),
      size: stat.size,
      truncated: stat.size > 50000,
    });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    if (e.message.includes('Path traversal')) return res.status(403).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/workspace — list files in sandbox
router.get('/agent/workspace', authMiddleware, (req, res) => {
  try {
    const { scope = 'sandbox', depth = 3 } = req.query;
    const realBase = ensureBaseExists(scope === 'home' ? HOME_DIR : SANDBOX_DIR);
    function walk(dir, currentDepth, maxDepth) {
      const items = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(realBase, full);
          if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
          if (entry.isDirectory() && currentDepth < maxDepth) {
            items.push({ name: entry.name, path: rel, type: 'dir' });
            if (!['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
              items.push(...walk(full, currentDepth + 1, maxDepth));
            }
          } else if (entry.isFile()) {
            items.push({ name: entry.name, path: rel, type: 'file', size: statSync(full).size });
          }
        }
      } catch {}
      return items;
    }
    const tree = walk(realBase, 0, parseInt(depth));
    res.json(tree);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/write — write a file (agent mode) or draft a diff (suggest mode)
router.post('/agent/write', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { path: targetPath, content, scope = 'sandbox', session_id, mode = 'agent' } = req.body;
    if (!targetPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const resolved = resolveSandboxPath(scope, targetPath);
    const fs = await import('fs');
    if (content.length > 500_000) return res.status(400).json({ error: 'Content too large (max 500KB)' });

    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;

    if (mode === 'suggest') {
      let oldContent = '';
      try { oldContent = await fs.promises.readFile(resolved, 'utf-8'); } catch {}
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'write', targetPath, content, 'awaiting approval', 'pending');
      res.json({
        action: 'draft',
        path: targetPath,
        oldContent: oldContent.slice(0, 20000),
        newContent: content,
        truncated: oldContent.length > 20000,
        action_id: actionId,
        requiresApproval: true,
      });
    } else {
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(resolved, content, 'utf-8');
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'write', targetPath, content, 'written', 'completed');
      broadcast('agent:action', { type: 'write', path: targetPath, session_id: sessionId, action_id: actionId });
      res.json({ action: 'written', path: targetPath, size: content.length, action_id: actionId });
    }
  } catch (e) {
    if (e.message.includes('Path traversal')) return res.status(403).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/approve — approve a pending action (suggest mode).
// The gated tool call executes HERE, after approval — never before.
// The result is recorded on the action so a resumed loop sees what happened.
router.post('/agent/approve', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ error: 'action_id required' });
    const action = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(action_id);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.status !== 'pending') return res.status(400).json({ error: 'Action already processed' });

    const session = action.session_id ? stmts.agentSessions.getById.get(action.session_id) : null;
    if (session && session.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Recover the gated tool call. New pending actions store { tool, args };
    // legacy 'write' drafts stored raw file content.
    const GATED_TOOLS = ['file_write', 'shell_exec', 'git_op', 'gmail_send'];
    let toolName = null;
    let toolArgs = {};
    try {
      const parsed = JSON.parse(action.content || '');
      if (parsed && GATED_TOOLS.includes(parsed.tool)) { toolName = parsed.tool; toolArgs = parsed.args || {}; }
    } catch {}
    if (!toolName && action.action_type === 'write') {
      toolName = 'file_write';
      toolArgs = { path: action.target, content: action.content || '' };
    }
    if (!toolName) return res.status(400).json({ error: 'Cannot determine gated tool for this action' });

    const result = await executeAgentTool(toolName, toolArgs, {
      scope: session?.scope || 'sandbox',
      sessionId: session?.id,
      userId: req.user.id,
      role: req.user.role,
      // M5: this call was approved by a human via this endpoint — lets
      // gated tools (e.g. gmail_send) treat the approval as satisfying
      // their confirmation gate instead of creating another pending action.
      humanApproved: true,
    });
    const status = result.error ? 'failed' : 'approved';
    stmts.agentActions.updateResult.run(JSON.stringify(result).slice(0, 5000), status, action_id);
    stmts.agentActions.updateStatus.run(status, req.user.id, action_id);
    broadcast('agent:action', { type: status, action_id, tool: toolName, session_id: session?.id });
    logger.info(`Agent action ${action_id} ${status} by ${req.user.id}: ${toolName}`);
    res.json({ action: status, tool: toolName, action_id, error: result.error || undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/reject — reject a pending action
router.post('/agent/reject', authMiddleware, (req, res) => {
  try {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ error: 'action_id required' });
    stmts.agentActions.updateStatus.run('rejected', req.user.id, action_id);
    broadcast('agent:action', { type: 'rejected', action_id });
    res.json({ action: 'rejected', action_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/exec — execute a command (admin only). Same restricted
// agent allowlist (interpreters/network removed) + shell-free execution as
// the shell_exec tool (see runAgentCommand).
router.post('/agent/exec', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { command, scope = 'sandbox', session_id, cwd } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    const check = sanitizeAgentCommand(command);
    if (!check.safe) return res.status(403).json({ error: `Command blocked by agent safety filter: ${check.error}` });
    const workDir = scope === 'home' ? HOME_DIR : resolveSandboxPath(scope, cwd || '.');
    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;

    try {
      const { mkdirSync } = await import('fs');
      mkdirSync(workDir, { recursive: true });
      const result = await runAgentCommand(command, workDir, scope);
      if (result.error) {
        stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'exec', command, '', result.error.slice(0, 2000), 'failed');
        return res.json({ exitCode: 1, stdout: '', stderr: result.error.slice(0, 2000), action_id: actionId });
      }
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'exec', command, result.stdout.slice(0, 5000), 'completed', 'completed');
      broadcast('agent:action', { type: 'exec', command, session_id: sessionId, action_id: actionId });
      res.json({ exitCode: result.exitCode, stdout: result.stdout.slice(0, 5000), stderr: result.stderr.slice(0, 2000), action_id: actionId });
    } catch (e) {
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'exec', command, '', (e.stderr || e.message || '').toString().slice(0, 2000), 'failed');
      res.json({ exitCode: e.status || 1, stdout: (e.stdout || '').toString().slice(0, 5000), stderr: (e.stderr || e.message).toString().slice(0, 2000), action_id: actionId });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/iterate — feed results back to LLM for next action
router.post('/agent/iterate', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { session_id, context, model } = req.body;
    const session = session_id ? stmts.agentSessions.getById.get(session_id) : null;
    const task = session?.task || context?.task || 'Continue working';
    const actions = session_id ? stmts.agentActions.getBySession.all(session_id) : [];
    const actionSummary = actions.slice(-5).map(a => `[${a.action_type}] ${a.target || ''}: ${(a.result || a.content || '').slice(0, 200)}`).join('\n');

    const iteratePrompt = `You are Aimi, an autonomous coding agent. Continue working on this task.
Task: ${task}
Mode: ${session?.mode || 'agent'}

Recent actions:
${actionSummary || 'No actions yet'}

New context: ${context?.message || 'Continue'}

Respond with the NEXT action as JSON:
{ "action": "read|write|exec|response", "target": "path or command", "content": "file content if write", "done": false }
If task is complete, respond with: { "action": "response", "target": "complete", "content": "summary of what was done", "done": true }`;

    const result = await callAgentLLM([
      { role: 'system', content: iteratePrompt },
      { role: 'user', content: context?.message || 'Continue' }
    ], model || session?.model);

    let nextAction;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      nextAction = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      nextAction = { action: 'response', target: 'LLM response', content: result.content.slice(0, 1000), done: false };
    }

    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;
    stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'iterate', nextAction.target || '', nextAction.content || '', JSON.stringify(nextAction), 'completed');

    if (nextAction.done && sessionId) {
      stmts.agentSessions.updateStatus.run('completed', sessionId);
      broadcast('agent:session', { type: 'completed', session_id: sessionId });
    }

    res.json({
      nextAction,
      model: result.model,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
      done: nextAction.done || false,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/agent/sessions/:id — delete a session
router.delete('/agent/sessions/:id', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    db.prepare('DELETE FROM agent_actions WHERE session_id = ?').run(req.params.id);
    stmts.agentSessions.delete.run(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Autopilot Endpoints (server-side agent loop) ─────────────────

// POST /api/agent/run — start autonomous agent loop for a session
router.post('/agent/run', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { session_id, max_steps, model } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const session = stmts.agentSessions.getById.get(session_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (session.status === 'executing') return res.status(409).json({ error: 'Session is already running' });

    // Start the loop (async — doesn't block the response)
    runAgentLoop(session_id, { maxSteps: max_steps, model })
      .then(result => {
        logger.info(`Agent loop completed for ${session_id}: ${result.completed ? 'done' : 'stopped'} in ${result.steps} steps`);
      })
      .catch(err => {
        logger.error(`Agent loop failed for ${session_id}: ${err.message}`);
        stmts.agentSessions.updateStatus.run('failed', session_id);
        broadcast('agent:loop:error', { session_id, error: err.message });
      });

    res.json({ started: true, session_id, max_steps: max_steps || MAX_AGENT_STEPS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/sessions/:id/resume — resume a paused/failed session
router.post('/agent/sessions/:id/resume', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (session.status === 'executing') return res.status(409).json({ error: 'Session is already running' });

    const { max_steps, model } = req.body;

    runAgentLoop(req.params.id, { maxSteps: max_steps, model })
      .then(result => {
        logger.info(`Agent loop resumed for ${req.params.id}: ${result.completed ? 'done' : 'stopped'} in ${result.steps} steps`);
      })
      .catch(err => {
        logger.error(`Agent loop resume failed for ${req.params.id}: ${err.message}`);
        stmts.agentSessions.updateStatus.run('failed', req.params.id);
        broadcast('agent:loop:error', { session_id: req.params.id, error: err.message });
      });

    res.json({ resumed: true, session_id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/sessions/:id/stop — stop a running session
router.post('/agent/sessions/:id/stop', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    stmts.agentSessions.updateStatus.run('stopped', req.params.id);
    broadcast('agent:loop:stopped', { session_id: req.params.id });
    res.json({ stopped: true, session_id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/tools — list available agent tools
router.get('/agent/tools', authMiddleware, (_req, res) => {
  res.json(agentTools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  })));
});


  return router;
}

export { callAgentLLM, callAgentLLMWithRetry, agentTools, runAgentLoop, registerAgentTool };
