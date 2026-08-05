/**
 * Learning loop driver.
 *
 * Closes the self-learning loop: recurring patterns that have matured past the
 * occurrence/confidence thresholds are promoted into auto-learned skills (which
 * ship disabled until an admin enables them). A daemon runs this on an interval;
 * POST /learn/run-loop triggers a pass on demand.
 */
import { LEARN_MIN_OCCURRENCES, LEARN_MIN_CONFIDENCE } from './learn.mjs';

/** Patterns eligible for promotion: mature, recurring, and not yet promoted. */
export function findPromotionCandidates(stmts, { minOccurrences = LEARN_MIN_OCCURRENCES, minConfidence = LEARN_MIN_CONFIDENCE } = {}) {
  return stmts.patterns.getAll.all()
    .filter(p => !p.auto_skill_id && p.occurrence_count >= minOccurrences && p.confidence >= minConfidence)
    .sort((a, b) => (b.confidence - a.confidence) || (b.occurrence_count - a.occurrence_count));
}

/** Build a deterministic auto-learned skill definition from a pattern. */
export function buildAutoSkillFromPattern(pattern, { now = Date.now() } = {}) {
  const slug = (pattern.pattern_type || 'general').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const name = `auto-${slug}-${now.toString(36)}`;
  const handler = `async (input) => {\n  // Auto-learned by Cardinal Frame from a recurring pattern\n  // Pattern: ${pattern.pattern_key}\n  return { handled: true, intent: '${pattern.pattern_type || 'general'}', learned_pattern: ${JSON.stringify(pattern.pattern_key)} };\n}`;
  const description = `Auto-learned skill for recurring intent "${pattern.pattern_type}" (pattern seen ${pattern.occurrence_count}x, confidence ${Math.round((pattern.confidence || 0) * 100)}%).`;
  return {
    name,
    description,
    handler,
    patternKey: pattern.pattern_key,
    parameters: { auto_generated: true, pattern_key: pattern.pattern_key, occurrence_count: pattern.occurrence_count },
  };
}

/**
 * Run one learning pass: promote the single highest-priority eligible pattern
 * into an auto-learned skill and link them. Returns the promotion or null.
 */
export async function runLearnLoop(ctx, opts = {}) {
  const { stmts, logger, randomUUID, broadcast, audit } = ctx;
  try {
    const candidate = findPromotionCandidates(stmts, opts)[0];
    if (!candidate) return null;
    const auto = buildAutoSkillFromPattern(candidate, opts);
    const id = randomUUID();
    stmts.skills.insertWithConfidence.run(
      id, auto.name, auto.description, 'auto-learned',
      auto.handler, JSON.stringify(auto.parameters), 0, 0.3, 1
    );
    stmts.patterns.updateConfidence.run(candidate.confidence, id, candidate.id);
    if (audit) audit('auto-promote', 'skill', id, null, {
      name: auto.name, pattern_id: candidate.id, pattern_key: candidate.pattern_key, occurrences: candidate.occurrence_count,
    });
    if (broadcast) broadcast('learn:promoted', {
      id, name: auto.name, pattern_id: candidate.id, pattern_key: candidate.pattern_key, confidence: 0.3,
    });
    if (logger?.info) logger.info(`[learn-loop] Promoted pattern "${candidate.pattern_key}" -> skill "${auto.name}"`);
    return { id, name: auto.name, pattern: candidate };
  } catch (err) {
    if (logger?.error) logger.error('[learn-loop] Promotion error:', err.message);
    return null;
  }
}

/**
 * Periodic driver. Runs a single promotion per tick, capped per rolling hour so
 * a burst of similar patterns can't flood the skill catalog.
 */
export class LearnLoopDaemon {
  constructor(ctx, { intervalMs = 5 * 60 * 1000, maxPerHour = 6 } = {}) {
    this.ctx = ctx;
    this.intervalMs = intervalMs;
    this.maxPerHour = maxPerHour;
    this.intervalHandle = null;
    this.hourKey = null;
    this.hourCount = 0;
  }

  start(intervalMs) {
    if (intervalMs) this.intervalMs = intervalMs;
    if (this.intervalHandle) return;
    const logger = this.ctx.logger;
    if (logger?.info) logger.info(`[learn-loop] Started — promoting at most ${this.maxPerHour}/hr every ${Math.round(this.intervalMs / 1000)}s`);
    this.intervalHandle = setInterval(() => this.tick(), this.intervalMs);
    this.intervalHandle.unref();
    this.tick();
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async tick() {
    const nowHour = Math.floor(Date.now() / 3600000);
    if (this.hourKey !== nowHour) {
      this.hourKey = nowHour;
      this.hourCount = 0;
    }
    if (this.hourCount >= this.maxPerHour) return;
    const result = await runLearnLoop(this.ctx);
    if (result) this.hourCount += 1;
  }
}
