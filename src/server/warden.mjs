/**
 * WARDEN — Cardinal Frame risk gate.
 *
 * Scores actions (sandbox code, plugin installs, delegation commands,
 * agent tool calls) and enforces a verdict policy:
 *   - score 0–1  → low    → allow
 *   - score 2–3  → medium → require explicit approval
 *   - score 4+   → high   → block
 *
 * Thresholds are module-level constants so they are easy to tune, and an
 * optional `policy` argument can tighten (block medium) or loosen (allow
 * medium) behavior per caller.
 */

const PATTERNS = {
  // ─── Shell command patterns (delegation / shell_exec / git) ───
  destructive: [
    { re: /\brm\s+-rf\s+\//i, reason: 'Recursive delete of filesystem root' },
    { re: /\bdd\b.*\bof=\/dev\//i, reason: 'Raw write to device' },
    { re: /\bmkfs\b/i, reason: 'Filesystem formatting' },
    { re: /\bchmod\s+777\s+\//i, reason: 'World-writable root permissions' },
    { re: /\b:\(\)\s*\{\s*:\s*\|\s*&\s*\};\s*:/i, reason: 'Fork bomb' },
    { re: /\b(reboot|shutdown|halt|poweroff)\b/i, reason: 'System shutdown' },
    { re: /\bparted\b|\bfdisk\b/i, reason: 'Disk partitioning' },
  ],
  reverseShell: [
    { re: /\bnc\s+-[a-z]*l/i, reason: 'Network listener (netcat)' },
    { re: /\bbash\s+-i\b/i, reason: 'Interactive shell (potential reverse shell)' },
    { re: /\bnetcat\s+-e\b|\bnc\s+-e\b/i, reason: 'Netcat shell bind' },
    { re: /\bsocat\b/i, reason: 'Bidirectional pipe tool' },
    { re: /\bmknod\b/i, reason: 'Device node creation' },
  ],
  remoteExec: [
    { re: /(curl|wget|lynx|fetch)\b[^;&|]*\|\s*(sh|bash|zsh|python3?|perl)\b/i, reason: 'Remote script piped to interpreter' },
    { re: /(curl|wget)\b[^;&]*\|\s*base64\s*-\s*d/i, reason: 'Remote content decoded and executed' },
    { re: /\b(base64|xxd|openssl)\s+-(d|decode)[^|;]*\|/i, reason: 'Decoded payload piped to another command' },
  ],
  privilege: [
    { re: /\bsudo\b/i, reason: 'Privilege escalation (sudo)' },
    { re: /\bsu\s+-/i, reason: 'Login as another user' },
    { re: /\busermod\b|\buseradd\b/i, reason: 'User account modification' },
    { re: /\bchown\b.*\b(root|0)\b/i, reason: 'Ownership change to root' },
  ],
  exfil: [
    { re: /\bcurl\b.*-d\b/i, reason: 'POST data exfiltration (curl -d)' },
    { re: /\bwget\b.*--post/i, reason: 'POST via wget' },
  ],
  systemWrites: [
    { re: />\s*\/etc\//i, reason: 'Write to /etc' },
    { re: />\s*\/var\//i, reason: 'Write to /var' },
    { re: />\s*\/usr\/|>\s*\/opt\//i, reason: 'Write to system install path' },
    { re: /\brm\s+-rf\s+\/home\b|\brm\s+-rf\s+~(\/|$)/i, reason: 'Deletes user home directory' },
  ],

  // ─── Code patterns (sandbox: javascript / python) ───────────
  codeExec: [
    { re: /child_process|\bexec\(|\bspawn\(|\bexecFile\(/i, reason: 'Spawns a child process' },
    { re: /os\.system|os\.popen|subprocess|Popen/i, reason: 'Executes OS commands' },
    { re: /eval\(|new Function\(|__import__\(/i, reason: 'Dynamic code evaluation' },
  ],
  codeNetwork: [
    { re: /\bfetch\(|\baxios\b|\brequest\(|require\(['"]https?['"]\)|import\s+.*['"]https?['"]|import\s+socket|import\s+requests|new WebSocket/i, reason: 'Network access' },
  ],
  codeFiles: [
    { re: /require\(['"]fs['"]\)|import\s+.*\bfrom\s+['"]fs['"]|open\([^)]*['"]w['"]|writeFile|unlinkSync|rmdir|import\s+shutil/i, reason: 'Filesystem write/delete access' },
  ],
  codeEnv: [
    { re: /process\.env|os\.environ/i, reason: 'Environment variable access' },
  ],
};

function runPatterns(reasons, patterns, target, weight = 1) {
  let count = 0;
  for (const { re, reason } of patterns) {
    if (re.test(target)) {
      count += weight;
      reasons.push(reason);
    }
  }
  return count;
}

function levelForScore(score) {
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function verdictForLevel(level, policy = 'standard') {
  if (policy === 'off') return 'allow';
  if (level === 'high') return 'block';
  if (level === 'medium') return policy === 'strict' ? 'block' : 'approve';
  return 'allow';
}

/**
 * Score a shell command (delegation, shell_exec, git hooks, etc).
 * @param {string} command
 * @param {{policy?: string}} [opts]
 */
export function scoreCommand(command, opts = {}) {
  const reasons = [];
  let score = 0;
  score += runPatterns(reasons, PATTERNS.destructive, command, 2);
  score += runPatterns(reasons, PATTERNS.reverseShell, command, 2);
  score += runPatterns(reasons, PATTERNS.remoteExec, command, 2);
  score += runPatterns(reasons, PATTERNS.privilege, command, 1);
  score += runPatterns(reasons, PATTERNS.exfil, command, 1);
  score += runPatterns(reasons, PATTERNS.systemWrites, command, 1);

  const level = levelForScore(score);
  return {
    score,
    level,
    verdict: verdictForLevel(level, opts.policy),
    reasons,
  };
}

/**
 * Score code to be executed in the sandbox.
 * @param {string} code
 * @param {string} language
 * @param {{policy?: string}} [opts]
 */
export function scoreCode(code, language = 'javascript', opts = {}) {
  const reasons = [];
  let score = 0;
  score += runPatterns(reasons, PATTERNS.codeExec, code);
  score += runPatterns(reasons, PATTERNS.codeNetwork, code);
  score += runPatterns(reasons, PATTERNS.codeFiles, code);
  score += runPatterns(reasons, PATTERNS.codeEnv, code);
  // Shell-ish patterns also apply if the code shells out
  score += runPatterns(reasons, PATTERNS.destructive, code, 2);
  score += runPatterns(reasons, PATTERNS.reverseShell, code, 2);
  score += runPatterns(reasons, PATTERNS.remoteExec, code, 2);

  const level = levelForScore(score);
  return {
    score,
    level,
    verdict: verdictForLevel(level, opts.policy),
    reasons,
    language,
  };
}

/**
 * Generic evaluate — pick the right scorer for a scope.
 * @param {string} scope — 'sandbox' | 'plugin_install' | 'command' | 'delegate'
 * @param {object} payload — { code?, language?, command? }
 * @param {{policy?: string}} [opts]
 */
export function evaluate(scope, payload = {}, opts = {}) {
  if (scope === 'sandbox' || scope === 'plugin_install') {
    return scoreCode(payload.code || '', payload.language || 'javascript', opts);
  }
  return scoreCommand(payload.command || payload.code || '', opts);
}
