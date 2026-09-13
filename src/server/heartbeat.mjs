// ─── Heartbeat Daemon ────────────────────────────────────────
// Proactive system monitoring — checks system state on interval
// and auto-triggers chains, skills, or alerts based on rules.

import vm from 'node:vm';

/**
 * Evaluate a heartbeat condition against current system state.
 * Conditions are simple expressions like:
 *   "agents.stale > 2"
 *   "tasks.pending > 5 && tasks.running == 0"
 *   "chains.failed >= 3"
 *
 * SECURITY: Uses vm.runInNewContext with a locked-down sandbox.
 * No access to process, require, globalThis, Function constructor, etc.
 * The condition string is first validated to contain ONLY safe
 * comparison/boolean characters after state substitution.
 */
function evaluateCondition(condition, state) {
  if (!condition || typeof condition !== 'string') return false;

  // Reject multi-line conditions (prevents regex bypass via /m flag)
  if (condition.includes('\n') || condition.includes('\r')) {
    console.warn('[heartbeat] Multi-line condition rejected:', JSON.stringify(condition));
    return false;
  }

  // Replace state references with actual values
  let expr = condition;

  // Replace dotted accessors like agents.stale, tasks.pending
  const stateRefs = condition.match(/\b(\w+)\.(\w+)\b/g) || [];
  for (const ref of stateRefs) {
    const [category, key] = ref.split('.');
    const value = state[category]?.[key];
    if (value !== undefined) {
      expr = expr.replace(ref, String(value));
    }
  }

  // Normalize boolean literals
  expr = expr.replace(/\btrue\b/g, '1').replace(/\bfalse\b/g, '0');

  // Strict allowlist — only digits, whitespace, comparison/boolean operators, parens
  // NO /m flag — the entire string must match on a single line
  if (!/^[\d\s<>=!&|().]+$/.test(expr)) {
    console.warn('[heartbeat] Unsafe condition rejected:', condition);
    return false;
  }

  // Additional guard: reject if any word remains (state ref wasn't resolved)
  if (/\b[a-zA-Z_]\w*\b/.test(expr)) {
    console.warn('[heartbeat] Unresolved identifier in condition:', condition);
    return false;
  }

  try {
    // Use VM sandbox with no global access — codeGeneration blocked
    const sandbox = { __result: undefined };
    const context = vm.createContext(sandbox);
    const script = new vm.Script(`__result = (${expr});`);
    const result = script.runInContext(context, {
      timeout: 100,
      displayErrors: false,
    });
    return Boolean(result);
  } catch {
    return false;
  }
}

/** Valid action types for heartbeat rules */
export const VALID_ACTION_TYPES = ['chain', 'skill', 'alert'];

/**
 * Instructions appended to Aimi's persona prompt on every agent pulse.
 * The pulse is a periodic check-in, not a user message: she reviews system
 * state and decides whether anything needs attention. Same trust level as
 * heartbeat rules — skill/chain actions run through the existing executors;
 * anything uncertain becomes an alert for Haz to decide.
 */
export const PULSE_DIRECTIVE = `## Agent pulse
You are being pulsed — this is a periodic check-in, not a user message.
Review the system state below and decide whether anything needs attention.
"Attention" means: something is broken, degrading, or needs a human decision.
Routine healthy state needs nothing — stay quiet.

Reply with exactly one JSON object and no other text:
{"attention_needed": false}
or
{"attention_needed": true, "summary": "<1-2 sentences for Haz>", "actions": [...]}
Allowed actions (max 5, each one object):
- {"type": "alert", "message": "<tell Haz what's wrong and what you recommend>"}
- {"type": "skill", "name": "<skill name>", "input": {}}
- {"type": "chain", "id": "<chain id>", "input": {}}
Only request skill/chain actions for routine, low-risk remediation you have evidence for in the state above.
Anything destructive, irreversible, or uncertain → use "alert" and let Haz decide.`;

/** Wrap an async action in a timeout to prevent indefinite blocking */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Action timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export class HeartbeatDaemon {
  constructor(stmts, broadcastFn, executeChainFn, executeSkillFn, logger, opts = {}) {
    this.stmts = stmts;
    this.broadcast = broadcastFn || (() => {});
    this.executeChain = executeChainFn;
    this.executeSkill = executeSkillFn;
    this.logger = logger || console;
    this.intervalHandle = null;
    this.intervalMs = 60000; // 60 seconds default
    // Agent pulse (optional): periodic LLM check-in. Provided via opts so the
    // daemon never imports route modules directly.
    this.invokeAgent = opts.invokeAgent || null;   // async (messages) => assistant text
    this.personaPrompt = opts.personaPrompt || null; // () => system prompt string
    this.pulseUserId = opts.pulseUserId || 'system';
    this.pulseHandle = null;
    this._pulseTimer = null;
    this.pulseMs = 0;
    this.pulseRunning = false;
    this.pulseStats = { runs: 0, lastAt: null, lastAttention: false, lastSummary: '' };
  }

  start(intervalMs) {
    if (intervalMs) this.intervalMs = intervalMs;
    if (this.intervalHandle) return;
    this.logger.info(`[heartbeat] Started — checking every ${this.intervalMs / 1000}s`);
    this.intervalHandle = setInterval(() => this.tick(), this.intervalMs);
    this.intervalHandle.unref(); // Don't block graceful shutdown
    // Run first tick immediately
    this.tick();
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info('[heartbeat] Stopped');
    }
  }

  // ─── Agent pulse ─────────────────────────────────────────────

  /** True when the daemon has everything it needs to pulse the agent. */
  pulseReady() {
    return !!(this.invokeAgent && this.personaPrompt);
  }

  startPulse(intervalMs) {
    if (!this.pulseReady()) {
      this.logger.warn('[pulse] Not started — no agent invoker configured');
      return;
    }
    if (intervalMs) this.pulseMs = intervalMs;
    if (this.pulseHandle || this._pulseTimer) return;
    this.logger.info(`[pulse] Started — agent check-in every ${this.pulseMs / 1000}s`);
    // First pulse after a short settle delay, not immediately (cold-start noise).
    this._pulseTimer = setTimeout(() => {
      this._pulseTimer = null;
      this.pulseHandle = setInterval(() => this.pulse(), this.pulseMs);
      if (this.pulseHandle.unref) this.pulseHandle.unref();
      this.pulse();
    }, Math.min(this.pulseMs, 60000));
    if (this._pulseTimer.unref) this._pulseTimer.unref();
  }

  stopPulse() {
    if (this._pulseTimer) { clearTimeout(this._pulseTimer); this._pulseTimer = null; }
    if (this.pulseHandle) {
      clearInterval(this.pulseHandle);
      this.pulseHandle = null;
      this.logger.info('[pulse] Stopped');
    }
  }

  /** One pulse — ask the agent to review system state and act if needed. */
  async pulse() {
    if (this.pulseRunning) return; // never overlap pulses
    if (!this.pulseReady()) return;
    this.pulseRunning = true;
    try {
      const messages = this.buildPulseMessages();
      const text = await withTimeout(this.invokeAgent(messages), 120000);
      const parsed = HeartbeatDaemon.parsePulseResponse(text);
      this.pulseStats.runs++;
      this.pulseStats.lastAt = new Date().toISOString();
      if (!parsed || parsed.attention_needed !== true) {
        this.pulseStats.lastAttention = false;
        this.pulseStats.lastSummary = '';
        this.logger.info('[pulse] Quiet — nothing needs attention');
        return;
      }
      const summary = String(parsed.summary || 'Pulse flagged attention').slice(0, 500);
      const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 5) : [];
      this.pulseStats.lastAttention = true;
      this.pulseStats.lastSummary = summary;
      this.logger.info(`[pulse] Attention needed: ${summary} (${actions.length} action(s))`);
      this.broadcast('heartbeat:pulse', { summary, actionCount: actions.length, at: this.pulseStats.lastAt });
      for (const action of actions) {
        try { await this.runPulseAction(action); }
        catch (e) { this.logger.error('[pulse] Action failed:', e.message); }
      }
    } catch (e) {
      this.logger.error('[pulse] Pulse failed:', e.message);
    } finally {
      this.pulseRunning = false;
    }
  }

  buildPulseMessages() {
    return [
      { role: 'system', content: `${this.personaPrompt()}\n\n${PULSE_DIRECTIVE}` },
      { role: 'user', content: this.buildPulseContext() },
    ];
  }

  /** Compact, human-readable state snapshot for the pulse prompt. Best-effort. */
  buildPulseContext() {
    const state = this.collectState();
    const lines = [`## Agent pulse — ${new Date().toISOString()}`, 'System state:'];
    lines.push(`- Agents: ${state.agents.total} total, ${state.agents.active} active, ${state.agents.stale} stale`);
    lines.push(`- Tasks: ${state.tasks.total} total, ${state.tasks.pending} pending, ${state.tasks.running} running, ${state.tasks.failed} failed`);
    lines.push(`- Skills: ${state.skills.total} total, ${state.skills.enabled} enabled`);
    lines.push(`- Providers: ${state.providers.enabled} enabled`);
    lines.push(`- Heartbeat rules: ${state.schedules.total} configured`);
    lines.push(`- Heap: ${state.memory.heap_usage_pct}% used`);
    try {
      const failed = this.stmts.tasks.getAll.all()
        .filter(t => t.status === 'failed').slice(0, 5).map(t => t.name);
      if (failed.length) lines.push(`- Failed tasks: ${failed.map(n => `"${n}"`).join(', ')}`);
      const stale = this.stmts.agents.getAllWithHeartbeat.all().filter(a => {
        if (!a.last_heartbeat) return true;
        return Date.now() - new Date(a.last_heartbeat + 'Z').getTime() > 300000;
      }).slice(0, 5).map(a => a.name);
      if (stale.length) lines.push(`- Stale agents: ${stale.map(n => `"${n}"`).join(', ')}`);
      const hourAgo = Date.now() - 3600000;
      const fired = this.stmts.heartbeat.getAll.all().filter(r => {
        if (!r.last_fired_at) return false;
        return new Date(r.last_fired_at + 'Z').getTime() > hourAgo;
      }).map(r => r.name);
      if (fired.length) lines.push(`- Rules fired in the last hour: ${fired.map(n => `"${n}"`).join(', ')}`);
    } catch { /* context is best-effort; counts above already landed */ }
    return lines.join('\n');
  }

  /** Extract the pulse JSON from the agent's reply (tolerates code fences and prose). */
  static parsePulseResponse(text) {
    if (!text || typeof text !== 'string') return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = (fenced ? fenced[1] : text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(candidate.slice(start, end + 1)); }
    catch { return null; }
  }

  /** Execute one pulse-requested action. Unknown types are ignored, never executed. */
  async runPulseAction(action) {
    if (!action || typeof action !== 'object') return;
    const type = action.type;
    if (type === 'alert') {
      const message = String(action.message || '').slice(0, 1000);
      if (!message) return;
      this.broadcast('heartbeat:pulse-alert', { message, at: new Date().toISOString() });
      this.logger.info(`[pulse] Alert: ${message}`);
    } else if (type === 'skill') {
      if (!this.executeSkill || !action.name) return;
      const result = await withTimeout(this.executeSkill(String(action.name), action.input || {}), 30000);
      this.logger.info(`[pulse] Skill "${action.name}" ran — ${result && result.ok === false ? 'failed' : 'ok'}`);
    } else if (type === 'chain') {
      if (!this.executeChain || !action.id) return;
      const result = await withTimeout(this.executeChain(String(action.id), action.input || {}), 30000);
      this.logger.info(`[pulse] Chain "${action.id}" ran — ${result && result.ok === false ? 'failed' : 'ok'}`);
    } else {
      this.logger.warn(`[pulse] Ignored unknown action type: ${type}`);
    }
  }

  /** Observability for the status endpoint and CLI. */
  status() {
    return {
      running: !!this.intervalHandle,
      tickIntervalS: this.intervalMs / 1000,
      pulse: {
        enabled: !!(this.pulseHandle || this._pulseTimer),
        ready: this.pulseReady(),
        intervalS: this.pulseMs / 1000,
        runs: this.pulseStats.runs,
        lastAt: this.pulseStats.lastAt,
        lastAttention: this.pulseStats.lastAttention,
        lastSummary: this.pulseStats.lastSummary,
      },
    };
  }

  /**
   * Collect current system state for condition evaluation.
   */
  collectState() {
    const state = {
      agents: { total: 0, active: 0, stale: 0 },
      tasks: { total: 0, pending: 0, running: 0, failed: 0 },
      chains: { total: 0, failed: 0, running: 0 },
      skills: { total: 0, enabled: 0 },
      providers: { total: 0, enabled: 0 },
      schedules: { total: 0, enabled: 0 },
      messages: { pending: 0 },
      memory: {
        rss_mb: 0,
        heap_used_mb: 0,
        heap_total_mb: 0,
        heap_usage_pct: 0,
        alert_threshold_pct: 85,
      },
      uptime_seconds: 0,
    };

    try {
      // Agents
      const agents = this.stmts.agents.getAllWithHeartbeat.all();
      state.agents.total = agents.length;
      state.agents.active = agents.filter(a => a.status === 'active').length;
      const now = Date.now();
      state.agents.stale = agents.filter(a => {
        if (!a.last_heartbeat) return true;
        const age = now - new Date(a.last_heartbeat + 'Z').getTime();
        return age > 300000; // 5 min
      }).length;

      // Tasks
      const tasks = this.stmts.tasks.getAll.all();
      state.tasks.total = tasks.length;
      state.tasks.pending = tasks.filter(t => t.status === 'pending').length;
      state.tasks.running = tasks.filter(t => t.status === 'running').length;
      state.tasks.failed = tasks.filter(t => t.status === 'failed').length;

      // Chains
      const skillChains = this.stmts.skillChains.getAll.all();
      state.chains.total = skillChains.length;
      state.chains.failed = skillChains.filter(c => c.status === 'failed').length;

      // Skills
      const skills = this.stmts.skills.getAll.all();
      state.skills.total = skills.length;
      state.skills.enabled = skills.filter(s => s.enabled).length;

      // Providers
      state.providers.total = this.stmts.dashboard.providerCount.get().c;
      state.providers.enabled = state.providers.total; // dashboard count is all providers

      // Schedules
      const schedules = this.stmts.schedules.getAll.all();
      state.schedules.total = schedules.length;
      state.schedules.enabled = schedules.filter(s => s.enabled).length;

      // Messages
      const msgs = this.stmts.commsMessages.getPending.all();
      state.messages.pending = msgs.length;

      // Memory monitoring
      const mem = process.memoryUsage();
      const heapUsed = mem.heapUsed;
      const heapTotal = mem.heapTotal;
      state.memory.rss_mb = Math.round(mem.rss / 1024 / 1024 * 100) / 100;
      state.memory.heap_used_mb = Math.round(heapUsed / 1024 / 1024 * 100) / 100;
      state.memory.heap_total_mb = Math.round(heapTotal / 1024 / 1024 * 100) / 100;
      state.memory.heap_usage_pct = heapTotal > 0 ? Math.round((heapUsed / heapTotal) * 100 * 100) / 100 : 0;
      state.uptime_seconds = Math.round(process.uptime());

      // Memory alert
      if (state.memory.heap_usage_pct > state.memory.alert_threshold_pct) {
        this.broadcast('heartbeat:alert', {
          rule: 'memory_high',
          message: `Heap usage at ${state.memory.heap_usage_pct}% (${state.memory.heap_used_mb}MB / ${state.memory.heap_total_mb}MB)`,
          state,
        });
        this.logger.warn(`[heartbeat] Memory alert: heap at ${state.memory.heap_usage_pct}% (${state.memory.heap_used_mb}MB / ${state.memory.heap_total_mb}MB)`);
      }
    } catch (e) {
      this.logger.error('[heartbeat] State collection error:', e.message);
    }

    return state;
  }

  /**
   * One tick — collect state, evaluate rules, fire actions.
   */
  async tick() {
    const state = this.collectState();
    this.broadcast('heartbeat:tick', { state });

    let rules = [];
    try {
      rules = this.stmts.heartbeat.getEnabled.all();
    } catch {
      return;
    }

    for (const rule of rules) {
      try {
        // Check cooldown
        if (rule.last_fired_at) {
          const elapsed = (Date.now() - new Date(rule.last_fired_at + 'Z').getTime()) / 1000;
          if (elapsed < rule.cooldown_seconds) continue;
        }

        // Evaluate condition
        if (!evaluateCondition(rule.condition, state)) continue;

        // Fire action
        const inputData = JSON.parse(rule.action_input || '{}');
        this.broadcast('heartbeat:fired', { rule: rule.name, action: rule.action_type, target: rule.action_target });
        this.stmts.heartbeat.updateLastFired.run(rule.id);

        if (rule.action_type === 'chain') {
          // Execute a skill chain with timeout
          if (this.executeChain) {
            try {
              const result = await withTimeout(this.executeChain(rule.action_target, inputData), 30000);
              this.logger.info(`[heartbeat] Chain "${rule.action_target}" triggered by rule "${rule.name}" — ${result.ok ? 'ok' : 'failed'}`);
            } catch (e) {
              this.logger.error(`[heartbeat] Chain action error for rule "${rule.name}":`, e.message);
            }
          }
        } else if (rule.action_type === 'skill') {
          if (this.executeSkill) {
            try {
              const result = await withTimeout(this.executeSkill(rule.action_target, inputData), 30000);
              this.logger.info(`[heartbeat] Skill "${rule.action_target}" triggered by rule "${rule.name}"`);
            } catch (e) {
              this.logger.error(`[heartbeat] Skill action error for rule "${rule.name}":`, e.message);
            }
          }
        } else if (rule.action_type === 'alert') {
          this.broadcast('heartbeat:alert', { rule: rule.name, message: rule.description, state });
        } else if (rule.action_type === 'webhook') {
          // POST alert data to an external URL
          try {
            const payload = {
              rule: rule.name,
              description: rule.description || '',
              condition: rule.condition || '',
              state,
              timestamp: new Date().toISOString(),
              input: inputData,
            };
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const resp = await fetch(rule.action_target, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
            clearTimeout(timeout);
            this.logger.info(`[heartbeat] Webhook "${rule.action_target}" triggered by rule "${rule.name}" — ${resp.status}`);
          } catch (e) {
            this.logger.error(`[heartbeat] Webhook action error for rule "${rule.name}":`, e.message);
          }
        }
      } catch (e) {
        this.logger.error(`[heartbeat] Rule "${rule.name}" error:`, e.message);
      }
    }
  }
}
