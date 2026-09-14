/**
 * Cardinal Frame — shared command-safety helpers
 *
 * sanitizeCommand() is the single source of truth for shell command
 * validation across the server: executeTask (server.mjs), the job queue,
 * DAG task nodes (via ctx), group broadcasts, and the agent shell_exec tool.
 *
 * It lives here — not in server.mjs — because server.mjs imports the route
 * modules, so importing server.mjs from a route would be circular. Both
 * server.mjs and routes/agent.mjs import from this module instead.
 */

import { spawn } from 'child_process';

export const ALLOWED_COMMANDS = [
  'echo', 'ls', 'cat', 'pwd', 'date', 'whoami', 'hostname', 'uname',
  'df', 'free', 'uptime', 'ps', 'wc', 'head', 'tail', 'grep', 'sort',
  'uniq', 'curl', 'wget', 'python3', 'node', 'bash',
];

// ─── Agent-restricted command policy ─────────────────────────────────
// The shared allowlist above is used by admin-controlled task execution
// (executeTask, DAG task nodes, the job queue). The AGENT surface is a
// different trust boundary: an autonomous agent driving shell_exec must not
// be able to escalate to arbitrary code / exfiltration. General-purpose
// interpreters (node/python/bash/…) are REMOVED because the agent can write
// a payload with file_write then invoke it — a shell filter cannot stop that
// capability escalation. Network binaries are REMOVED so a compromised agent
// cannot silently exfiltrate workspace contents.
export const AGENT_FORBIDDEN = new Set([
  'node', 'nodejs', 'npm', 'npx', 'deno', 'bun',
  'python', 'python2', 'python3', 'pip', 'pip3', 'pypy',
  'bash', 'sh', 'dash', 'zsh', 'fish', 'ksh', 'csh',
  'perl', 'ruby', 'php', 'lua', 'tclsh', 'pwsh',
]);

export const AGENT_NETWORK_FORBIDDEN = new Set([
  'curl', 'wget', 'nc', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'ftp', 'socat',
]);

// Everything in the shared allowlist minus interpreters minus network tools.
// Net effect: read-only inspection utilities only — the agent cannot spawn a
// code interpreter or open an arbitrary network channel through shell_exec.
export const AGENT_ALLOWED_COMMANDS = ALLOWED_COMMANDS.filter(
  (c) => !AGENT_FORBIDDEN.has(c) && !AGENT_NETWORK_FORBIDDEN.has(c)
);

/**
 * Whether a command name is a network-capable binary (egress classification).
 * Used by the agent policy and the egress gate to keep NETWORK_NONE the
 * default for agent execution.
 */
export function isNetworkCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  const base = cmd.trim().split(/\s+/)[0].split('/').pop();
  return AGENT_NETWORK_FORBIDDEN.has(base) || base === 'git';
}

// Shell metacharacters rejected across EVERY execution path. All execution
// is shell-free, so `;`, `|`, `$()`, backticks, etc. can only be injection
// attempts. Unicode line separators are included: some shells/PATH tools
// treat them as terminators.
export const SHELL_METACHAR_RE = /[;&|><$`\\!{}()\[\]*?~#\n\r\u2028\u2029]/;

/** True if the string contains any shell metacharacter (rejection helper). */
export function hasShellMetachars(cmd) {
  return SHELL_METACHAR_RE.test(String(cmd || ''));
}

export function sanitizeCommand(cmd) {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return { safe: false, error: 'Empty command' };
  // Shell metacharacters are never allowed: execution is shell-free, so
  // `;`, `|`, `$()`, backticks, etc. can only be injection attempts.
  if (hasShellMetachars(trimmed)) {
    return { safe: false, error: 'Shell metacharacters are not allowed; use a single simple command' };
  }
  const parts = trimmed.split(/\s+/);
  const baseName = parts[0].split('/').pop();
  if (!ALLOWED_COMMANDS.includes(baseName)) {
    return { safe: false, error: `Command '${baseName}' not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}` };
  }
  // argv0 + args: executed with shell:false, so no shell ever interprets this.
  return { safe: true, command: parts[0], args: parts.slice(1), display: trimmed };
}

/**
 * Agent-command sanitizer: same shell-free contract as sanitizeCommand, but
 * against the RESTRICTED agent allowlist (no interpreters, no network
 * binaries). This is the ONLY sanitizer the agent shell_exec tool and
 * POST /api/agent/exec may use — a "safe" generic command is not a safe
 * agent command when it can fork arbitrary code or open egress.
 */
export function sanitizeAgentCommand(cmd) {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return { safe: false, error: 'Empty command' };
  if (hasShellMetachars(trimmed)) {
    return { safe: false, error: 'Shell metacharacters are not allowed; use a single simple command' };
  }
  const parts = trimmed.split(/\s+/);
  const baseName = parts[0].split('/').pop();
  if (!AGENT_ALLOWED_COMMANDS.includes(baseName)) {
    if (AGENT_FORBIDDEN.has(baseName)) {
      return { safe: false, error: `Command '${baseName}' is not allowed for the agent (code interpreter execution is disabled)` };
    }
    if (AGENT_NETWORK_FORBIDDEN.has(baseName)) {
      return { safe: false, error: `Command '${baseName}' is not allowed for the agent (network egress is disabled; use the web_fetch/web_search tools)` };
    }
    return { safe: false, error: `Command '${baseName}' not allowed for the agent. Allowed: ${AGENT_ALLOWED_COMMANDS.join(', ')}` };
  }
  return { safe: true, command: parts[0], args: parts.slice(1), display: trimmed };
}

/**
 * Shell-free argv executor for tools whose allowlist is NOT the generic
 * command list (git_op, file_search). The caller is responsible for
 * validating `cmd`/`args` against its own fixed allowlist; argv elements
 * are passed as data — no shell ever interprets them, so metacharacters
 * in arguments (e.g. `;` in a commit message or regex) are harmless.
 * Resolves with stdout on exit 0; rejects otherwise (grep's "no matches"
 * exit 1 included — callers should handle it).
 */
export function spawnArgv(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      timeout: opts.timeout ?? 30000,
      cwd: opts.cwd,
      env: { PATH: process.env.PATH },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => reject(new Error(`Execution failed: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(((stderr || `exit code ${code}`).toString()).slice(0, 500)));
    });
  });
}
