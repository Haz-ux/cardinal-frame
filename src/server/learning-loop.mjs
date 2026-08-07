/**
 * Learning loop driver.
 *
 * Closes the self-learning loop: recurring patterns that have matured past the
 * occurrence/confidence thresholds are promoted into auto-learned skills (which
 * ship disabled until an admin enables them). A daemon runs this on an interval;
 * POST /learn/run-loop triggers a pass on demand.
 */
import { LEARN_MIN_OCCURRENCES, LEARN_MIN_CONFIDENCE, skillNameFromPhrases, uniqueSkillName, sanitizeSkillName } from './learn.mjs';

/** Patterns eligible for promotion: mature, recurring, and not yet promoted. */
export function findPromotionCandidates(stmts, { minOccurrences = LEARN_MIN_OCCURRENCES, minConfidence = LEARN_MIN_CONFIDENCE } = {}) {
  return stmts.patterns.getAll.all()
    .filter(p => !p.auto_skill_id && p.occurrence_count >= minOccurrences && p.confidence >= minConfidence)
    .sort((a, b) => (b.confidence - a.confidence) || (b.occurrence_count - a.occurrence_count));
}

/**
 * Build a deterministic auto-learned skill definition from a pattern.
 * Named after the recurring phrase (what the user keeps asking to do),
 * not the coarse intent category.
 */
export function buildAutoSkillFromPattern(pattern, { now = Date.now() } = {}) {
  const phrase = pattern.pattern_key || pattern.pattern_type || 'general';
  const name = skillNameFromPhrases([phrase], { maxWords: 5 }) || `Auto ${pattern.pattern_type || 'Skill'}`;
  const handler = `async (input) => {\n  // Auto-learned by Cardinal Frame from a recurring pattern\n  // Pattern: ${pattern.pattern_key}\n  return { handled: true, intent: '${pattern.pattern_type || 'general'}', learned_pattern: ${JSON.stringify(pattern.pattern_key)} };\n}`;
  const description = `Auto-learned skill for the recurring request "${phrase}" (seen ${pattern.occurrence_count}x, confidence ${Math.round((pattern.confidence || 0) * 100)}%).`;
  return {
    name,
    description,
    handler,
    patternKey: pattern.pattern_key,
    parameters: { auto_generated: true, pattern_key: pattern.pattern_key, occurrence_count: pattern.occurrence_count },
  };
}

/**
 * Best-effort: ask Aimi (LLM) to name a skill from the recurring phrase.
 * Returns null when no LLM is available or it fails — caller falls back
 * to the deterministic name.
 */
async function llmSkillName(ctx, phrase) {
  if (!ctx?.callAgentLLM) return null;
  try {
    const result = await ctx.callAgentLLM([
      { role: 'system', content: 'You are Aimi, naming a reusable skill for Cardinal Frame. Based on the recurring user request below, reply with ONLY a concise human-readable skill name, 2-5 words, no quotes, no punctuation, no "skill" suffix. Example: for "check cardinal frame system health" reply "Check System Health".' },
      { role: 'user', content: `Recurring request: "${String(phrase || '').slice(0, 200)}"` },
    ]);
    return sanitizeSkillName(result?.content);
  } catch { /* fall back to deterministic name */ }
  return null;
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
    let name = auto.name;
    const llmName = await llmSkillName(ctx, candidate.pattern_key || auto.name);
    if (llmName) name = llmName;
    name = uniqueSkillName(stmts, name);
    const id = randomUUID();
    stmts.skills.insertWithConfidence.run(
      id, name, auto.description, 'auto-learned',
      auto.handler, JSON.stringify(auto.parameters), 0, 0.3, 1
    );
    stmts.patterns.updateConfidence.run(candidate.confidence, id, candidate.id);
    if (audit) audit('auto-promote', 'skill', id, null, {
      name, pattern_id: candidate.id, pattern_key: candidate.pattern_key, occurrences: candidate.occurrence_count,
    });
    if (broadcast) broadcast('learn:promoted', {
      id, name, pattern_id: candidate.id, pattern_key: candidate.pattern_key, confidence: 0.3,
    });
    if (logger?.info) logger.info(`[learn-loop] Promoted pattern "${candidate.pattern_key}" -> skill "${name}"`);
    return { id, name, pattern: candidate };
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
