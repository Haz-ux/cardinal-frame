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
