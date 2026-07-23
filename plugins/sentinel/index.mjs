// Sentinel — Agent Safety Monitor Plugin
// Watches agent tool calls for dangerous patterns, infinite loops, and scope violations.

// --- State tracking ---
// sessionId -> [{ tool, ts }] for rate-limit detection
const callHistory = new Map();
// sessionId -> { dangerous: [], blocked: [], warnings: [] }
const sessionAlerts = new Map();

// --- Dangerous shell command patterns ---
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//i,       // rm -rf /
  /\bdd\s+.*of=\/dev\//i,    // dd to disk
  /\bmkfs\b/i,               // format
  /\bchmod\s+777\s+\//i,     // chmod 777 root
  /\bnc\s+-l\b/i,            // netcat listener
  /\bbash\s+-i\b/i,          // reverse shell
  /\b:()\s*\{\s*:\s*\|\s*&\s*\};\s*:/i, // fork bomb
];

// Safe git operations (only these are allowed on main/master in non-agent mode)
const SAFE_GIT_OPS = ['status', 'diff', 'log'];

function getAlerts(sessionId) {
  if (!sessionAlerts.has(sessionId)) {
    sessionAlerts.set(sessionId, { dangerous: [], blocked: [], warnings: [] });
  }
  return sessionAlerts.get(sessionId);
}

function alert(broadcast, type, severity, message, data) {
  const event = { type: 'sentinel:alert', payload: { severity, message, ...data, ts: Date.now() } };
  if (broadcast && typeof broadcast === 'function') {
    broadcast('sentinel:alert', event.payload);
  }
  // Also log to console for server logs
  console.error(`[sentinel:${severity}] ${message}`, data);
}

// --- Hook: onAgentStep ---
// Fires after every agent tool execution. This is the main monitoring point.
export async function onAgentStep(data, config) {
  const { sessionId, toolName, args, result, success } = data;
  const sid = sessionId || 'unknown';
  const cfg = config || {};
  const alerts = getAlerts(sid);

  // 1. Rate limiting — detect infinite loops
  const maxRate = cfg.maxToolCallsPer30s || 10;
  const now = Date.now();
  if (!callHistory.has(sid)) callHistory.set(sid, []);
  const history = callHistory.get(sid);
  history.push({ tool: toolName, ts: now });
  // Keep only last 30 seconds
  while (history.length > 0 && history[0].ts < now - 30000) history.shift();

  if (history.length > maxRate) {
    const msg = `Rate limit: ${history.length} tool calls in 30s (max ${maxRate})`;
    alerts.dangerous.push(msg);
    alert(cfg.alertWebSocket !== false, 'rate', 'danger', msg, { sessionId: sid, count: history.length });
    if (cfg.autoStop) {
      // Attempt to stop the session via internal API
      try {
        await fetch(`http://localhost:${process.env.PORT || 8080}/api/agent/sessions/${sid}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        alerts.blocked.push(`Auto-stopped session ${sid} (rate limit)`);
      } catch (e) {
        // fetch not available or server unreachable — just log
        console.error('[sentinel] Auto-stop failed:', e.message);
      }
    }
    return;
  }

  // 2. Dangerous shell commands
  if (cfg.blockDangerousShell !== false && toolName === 'shell_exec') {
    const cmd = args?.command || '';
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        const msg = `Dangerous shell command blocked: ${cmd}`;
        alerts.dangerous.push(msg);
        alert(cfg.alertWebSocket !== false, 'shell', 'danger', msg, { sessionId: sid, command: cmd });
        return;
      }
    }
  }

  // 3. File write outside scope
  const scope = cfg.scope || '/home/haz/ai-workspace';
  if (toolName === 'file_write' && args?.path) {
    const filePath = args.path;
    if (!filePath.startsWith(scope)) {
      const msg = `File write outside sandbox scope: ${filePath} (scope: ${scope})`;
      alerts.warnings.push(msg);
      alert(cfg.alertWebSocket !== false, 'scope', 'warning', msg, { sessionId: sid, path: filePath, scope });
      return;
    }
  }

  // 4. Git operations on main/master
  if (cfg.blockMainBranch !== false && toolName === 'git_op') {
    const op = args?.operation || '';
    const branch = args?.branch || '';
    const isProtectedBranch = branch === 'main' || branch === 'master';
    if (isProtectedBranch && !SAFE_GIT_OPS.includes(op)) {
      const msg = `Git operation on protected branch: ${op} on ${branch}`;
      alerts.dangerous.push(msg);
      alert(cfg.alertWebSocket !== false, 'git', 'danger', msg, { sessionId: sid, operation: op, branch });
      return;
    }
  }

  // 5. Tool errors — collect for pattern detection
  if (!success && result?.error) {
    alerts.warnings.push(`${toolName} error: ${result.error}`);
  }
}

// --- Hook: onChatMessage ---
// Tracks token consumption for cost-related alerts
export async function onChatMessage(data, config) {
  const cfg = config || {};
  const { conversationId, model, content } = data;

  // Estimate token count (rough: 1 token ~ 4 chars)
  const estTokens = Math.ceil((content || '').length / 4);

  // Alert on unusually large responses (>8K tokens estimated)
  if (estTokens > 8000) {
    alert(cfg.alertWebSocket !== false, 'tokens', 'warning',
      `Large response: ~${estTokens} tokens from ${model}`, { conversationId, model, estTokens });
  }
}

// --- Hook: onTaskCompleted ---
// Clears rate-limit history when a task finishes
export async function onTaskCompleted(data, config) {
  // General task cleanup — remove stale call history
  const now = Date.now();
  for (const [sid, history] of callHistory) {
    if (history.length === 0 || (now - history[history.length - 1].ts) > 60000) {
      callHistory.delete(sid);
      sessionAlerts.delete(sid);
    }
  }
}
