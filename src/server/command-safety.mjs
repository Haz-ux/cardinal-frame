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

export function sanitizeCommand(cmd) {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return { safe: false, error: 'Empty command' };
  // Shell metacharacters are never allowed: execution is shell-free, so
  // `;`, `|`, `$()`, backticks, etc. can only be injection attempts.
  if (/[;&|><$`\\!{}()\[\]*?~#\n\r]/.test(trimmed)) {
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
