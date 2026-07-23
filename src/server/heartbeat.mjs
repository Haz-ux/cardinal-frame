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
  constructor(stmts, broadcastFn, executeChainFn, executeSkillFn, logger) {
    this.stmts = stmts;
    this.broadcast = broadcastFn || (() => {});
    this.executeChain = executeChainFn;
    this.executeSkill = executeSkillFn;
    this.logger = logger || console;
    this.intervalHandle = null;
    this.intervalMs = 60000; // 60 seconds default
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
        }
      } catch (e) {
        this.logger.error(`[heartbeat] Rule "${rule.name}" error:`, e.message);
      }
    }
  }
}
