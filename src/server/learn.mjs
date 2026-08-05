/**
 * Aimi self-learning primitives.
 *
 * The learning loop: chat exchanges are captured as observations (autoObserve),
 * recurring inputs become patterns, the learning loop promotes mature patterns
 * into auto-learned skills, and successful use of those skills reinforces the
 * source pattern's confidence (reinforcePattern). Learned context is injected
 * back into Aimi's system prompt so behavior closes the loop.
 */

export const LEARN_MIN_OCCURRENCES = 3;
export const LEARN_MIN_CONFIDENCE = 0.6;
export const LEARN_CONFIDENCE_DELTA = 0.05;
export const LEARN_CONFIDENCE_PENALTY = 0.08;

/** Classify an observation's intent from the raw user input. */
export function detectIntent(inputLower) {
  if (/deploy|build|stag|prod/.test(inputLower)) return 'deploy-build';
  if (/search|find|look for|where/.test(inputLower)) return 'search';
  if (/create|make|new|add/.test(inputLower)) return 'create';
  if (/delete|remove|clean/.test(inputLower)) return 'delete';
  if (/status|health|check|monitor/.test(inputLower)) return 'monitor';
  if (/explain|what|how|why|describe/.test(inputLower)) return 'query';
  return 'general';
}

/** Recurring-input key: the first four significant words, lowercased. */
export function buildPatternKey(text) {
  const inputLower = String(text || '').toLowerCase();
  const words = inputLower.split(/\s+/).filter(w => w.length > 3);
  return words.slice(0, 4).join(' ');
}

/**
 * Record an observation for a chat exchange and grow/increment any matching
 * recurring pattern. Shared by the Chat proxy and the Aimi companion so both
 * surfaces feed the learning loop.
 */
export function autoObserve(stmts, broadcast, logger, randomUUID, conversationId, messages, assistantContent, modelId) {
  try {
    const lastUserMsg = messages?.filter(m => m.role === 'user').pop();
    if (!lastUserMsg || !assistantContent) return;
    const userInput = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : JSON.stringify(lastUserMsg.content || '');
    const inputLower = userInput.toLowerCase();
    const intent = detectIntent(inputLower);
    const obsId = randomUUID();
    stmts.observations.insert.run(obsId, conversationId || null, userInput, assistantContent, intent, '[]', null, 0);
    const patternKey = buildPatternKey(userInput);
    if (patternKey.length > 10) {
      const existing = stmts.patterns.getByKey.get(patternKey);
      if (existing) {
        const newCount = existing.occurrence_count + 1;
        const newConfidence = Math.min(0.99, existing.confidence + LEARN_CONFIDENCE_DELTA);
        stmts.patterns.increment.run(newConfidence, existing.id);
        broadcast('learn:pattern', { id: existing.id, pattern_key: patternKey, occurrence_count: newCount, confidence: newConfidence });
      } else {
        const patternId = randomUUID();
        stmts.patterns.insert.run(patternId, patternKey, intent, `Recurring: "${patternKey}"`, 0.3);
        broadcast('learn:pattern', { id: patternId, pattern_key: patternKey, pattern_type: intent, occurrence_count: 1, confidence: 0.3 });
      }
    }
    broadcast('learn:observation', { id: obsId, intent, conversation_id: conversationId });
    if (logger?.info) logger.info(`Aimi observed: intent=${intent}, pattern="${patternKey}"`);
  } catch (err) {
    if (logger?.error) logger.error('Auto-observe error:', err.message);
  }
}

/**
 * Reinforce the pattern that produced an auto-learned skill based on whether
 * that skill was used successfully. Success raises confidence, failure decays
 * it — closing the reinforcement half of the loop.
 */
export function reinforcePattern(stmts, skillId, success) {
  try {
    if (!stmts.patterns.getByAutoSkill) return;
    const pattern = stmts.patterns.getByAutoSkill.get(skillId);
    if (!pattern) return;
    const delta = success ? LEARN_CONFIDENCE_DELTA : -LEARN_CONFIDENCE_PENALTY;
    const next = Math.max(0.1, Math.min(0.99, (pattern.confidence || 0.3) + delta));
    stmts.patterns.updateConfidence.run(next, skillId, pattern.id);
  } catch { /* non-fatal */ }
}
