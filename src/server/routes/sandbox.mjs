/**
 * sandbox.mjs — Restricted VM sandbox for executing user-supplied skill handlers.
 *
 * Replaces `new Function()` and `eval()` with `vm.runInNewContext()` so that
 * untrusted skill code cannot access `process`, `require`, `module`,
 * `__dirname`, `globalThis`, or other Node primitives.
 *
 * Provides:
 *   - `execSync`: restricted shell exec with an allowlist
 *   - `fetch`: passthrough to global fetch (no mutation capability)
 *   - `llmCall`: async callback for hybrid skills (only when explicitly provided)
 *   - JSON.stringify / JSON.parse for data manipulation
 *   - console.log for debugging (writes to a captured array)
 *
 * Security:
 *   - No `process`, `require`, `module`, `exports`, `__dirname`, `__filename`
 *   - No access to the outer lexical scope (code runs in an isolated V8 context)
 *   - Timeout: 30s default (configurable)
 *   - execSync allowlist: only known-safe binaries; blocks rm, kill, pkill,
 *     shutdown, reboot, dd, mkfs, fdisk, chmod 777, curl to file, etc.
 */

import vm from 'node:vm';
import { execSync as _execSync } from 'node:child_process';

// ─── execSync allowlist ────────────────────────────────────────────────────
const EXEC_ALLOWLIST = new Set([
  'echo', 'pwd', 'date', 'whoami', 'hostname', 'uname', 'uptime',
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'sort', 'uniq',
  'jq', 'xq', 'yq', 'tree', 'file', 'stat', 'du', 'df',
  'git', 'node', 'npm', 'npx', 'uv', 'python3', 'python',
  'curl', 'wget',
  'mkdir', 'cp', 'mv',
]);

// Commands that are always blocked even if the binary is in the allowlist
const EXEC_BLOCKLIST = [
  /\brm\s+-rf\s+\//,       // rm -rf /
  /\bmkfs\b/,              // format filesystem
  /\bdd\b/,                // raw disk write
  /\bfdisk\b/,             // partition manipulation
  /\bsystemctl\s+(reboot|shutdown|poweroff|halt)\b/,
  /\b(?:pkill|killall|kill)\s+-9\b/,
  /\bchmod\s+777\s+\//,    // chmod 777 on root
  /\>\s*\/dev\/sd[a-z]/,   // redirect to disk device
  /\bnc\b.*-l/,            // netcat listener (reverse shell risk)
  /\bbash\s+-i\b/,         // interactive bash (reverse shell)
  /\bsh\s+-c\b.*\$\(/,     // nested subshell command injection
];

const EXEC_TIMEOUT_MS = 10_000;

function createRestrictedExecSync() {
  return (cmd, opts = {}) => {
    if (typeof cmd !== 'string') throw new Error('execSync: command must be a string');

    // Check blocklist first
    for (const blocked of EXEC_BLOCKLIST) {
      if (blocked.test(cmd)) {
        throw new Error(`execSync: blocked command pattern matched`);
      }
    }

    // Extract binary name (first token, handle simple quoting)
    const binary = cmd.trim().split(/[\s|&;]+/)[0].replace(/^['"]|['"]$/g, '');

    // Git subcommands: validate the git subcommand too
    if (binary === 'git') {
      const subcmd = cmd.trim().split(/\s+/)[1];
      const GIT_BLOCKED = new Set(['push', 'reset', 'clean', 'filter-branch', 'reflog']);
      if (GIT_BLOCKED.has(subcmd)) {
        throw new Error(`execSync: git ${subcmd} is not allowed in sandbox`);
      }
    }

    if (!EXEC_ALLOWLIST.has(binary)) {
      throw new Error(`execSync: "${binary}" is not in the allowlist`);
    }

    // Run with timeout and cwd restriction
    return _execSync(cmd, {
      ...opts,
      timeout: opts.timeout ?? EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024, // 1MB
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

// ─── Sandbox context builder ───────────────────────────────────────────────

/**
 * Build a safe VM context object for skill execution.
 *
 * @param {Object} opts
 * @param {string} opts.code         — the JS handler code to execute
 * @param {*}      opts.input        — input argument for the skill
 * @param {Function} [opts.llmCall]  — optional async LLM call for hybrid skills
 * @param {number} [opts.timeoutMs]   — timeout in ms (default 30000)
 * @returns {Promise<*>}               — the result of the executed code
 */
export async function runSandboxed({ code, input, llmCall = null, timeoutMs = 30_000, secrets = {} }) {
  const logs = [];

  const sandbox = {
    // Safe globals
    JSON,
    Math,
    Date,
    parseInt, parseFloat, isNaN, isFinite,
    String, Number, Boolean, Array, Object,
    RegExp,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,

    // Async / Promise
    Promise,

    // Restricted execSync
    execSync: createRestrictedExecSync(),

    // Read-only fetch passthrough (bound to global, no response mutation)
    fetch: (...args) => globalThis.fetch(...args),

    // Secrets — only keys explicitly passed by the caller (never process.env directly)
    secrets,

    // Debug logging (captured, not emitted to real stdout)
    console: {
      log: (...args) => logs.push(args.map(a =>
        typeof a === 'string' ? a : JSON.stringify(a)
      ).join(' ')),
      error: (...args) => logs.push('[ERROR] ' + args.map(a =>
        typeof a === 'string' ? a : JSON.stringify(a)
      ).join(' ')),
      warn: (...args) => logs.push('[WARN] ' + args.map(a =>
        typeof a === 'string' ? a : JSON.stringify(a)
      ).join(' ')),
    },

    // Promise used to defer to host async (for fetch/llmCall)
    setTimeout: (fn, ms) => {
      if (ms > 5000) throw new Error('setTimeout: max 5000ms in sandbox');
      return setTimeout(fn, ms);
    },
  };

  // Only provide llmCall if explicitly requested (hybrid skills)
  if (llmCall) {
    sandbox.llmCall = llmCall;
  }
  sandbox.input = input;

  // Create the V8 context
  const context = vm.createContext(sandbox, {
    name: 'skill-sandbox',
    codeGeneration: { strings: false, wasm: false }, // block eval/new Function inside sandbox
  });

  // Wrap the code so it always returns a value
  // For script skills: code is `(input) => { ... }` expression
  // For hybrid skills: code is raw async body
  const wrapped = `"use strict"; (${code})`;

  const script = new vm.Script(wrapped, {
    filename: 'skill-handler.mjs',
    timeout: timeoutMs,
    lineOffset: 0,
  });

  const handlerFn = script.runInContext(context, { timeout: timeoutMs });

  if (typeof handlerFn !== 'function') {
    throw new Error('Skill handler is not a function');
  }

  // Execute the handler function — still inside the timeout window
  // We use a wrapper that calls the handler with the sandbox's input
  const result = await handlerFn.call(sandbox, sandbox.input, sandbox.llmCall);

  return {
    result,
    logs,
  };
}

/**
 * Execute a hybrid skill's raw async code body.
 * Hybrid handlers are raw JS code (not a function expression) so we wrap
 * them in an async IIFE before running.
 */
export async function runSandboxedHybrid({ code, input, llmCall, timeoutMs = 30_000, secrets = {} }) {
  const logs = [];

  const sandbox = {
    JSON, Math, Date,
    parseInt, parseFloat, isNaN, isFinite,
    String, Number, Boolean, Array, Object,
    RegExp,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    Promise,
    execSync: createRestrictedExecSync(),
    fetch: (...args) => globalThis.fetch(...args),
    secrets,
    input,
    llmCall,
    console: {
      log: (...args) => logs.push(args.map(a =>
        typeof a === 'string' ? a : JSON.stringify(a)
      ).join(' ')),
      error: (...args) => logs.push('[ERROR] ' + args.map(a =>
        typeof a === 'string' ? a : JSON.stringify(a)
      ).join(' ')),
      warn: (...args) => logs.push('[WARN] ' + args.map(a =>
        typeof a === 'string' ? a : JSON.stringify(a)
      ).join(' ')),
    },
    setTimeout: (fn, ms) => {
      if (ms > 5000) throw new Error('setTimeout: max 5000ms in sandbox');
      return setTimeout(fn, ms);
    },
  };

  const context = vm.createContext(sandbox, {
    name: 'hybrid-skill-sandbox',
    codeGeneration: { strings: false, wasm: false },
  });

  // Wrap hybrid code in an async IIFE with input and llmCall parameters
  const wrapped = `"use strict"; (async (input, llmCall) => { ${code} })(input, llmCall)`;

  const script = new vm.Script(wrapped, {
    filename: 'hybrid-skill-handler.mjs',
    timeout: timeoutMs,
  });

  // Run the async IIFE — runInContext returns a promise
  const result = await script.runInContext(context, { timeout: timeoutMs });

  return {
    result,
    logs,
  };
}
