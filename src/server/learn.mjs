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

const NAME_STOPWORDS = new Set([
  'aimi', 'ok', 'okay', 'please', 'can', 'could', 'would', 'should', 'will', 'want',
  'need', 'like', 'make', 'give', 'get', 'go', 'look', 'tell', 'ask', 'reply', 'answer',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'on', 'in', 'at', 'with', 'by',
  'from', 'into', 'about', 'as', 'if', 'then', 'so', 'but', 'this', 'that', 'these',
  'those', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'your', 'you', 'my',
  'me', 'we', 'our', 'i', 'what', 'how', 'why', 'when', 'where', 'who', 'does', 'do',
  'did', 'just', 'out', 'up', 'all', 'some', 'more', 'very', 'over', 'really', 'now',
]);

/** Clean a phrase into significant words (no stopwords, no punctuation). */
function cleanPhraseWords(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !NAME_STOPWORDS.has(w));
}

/**
 * Derive a human-readable skill name from recurring user phrases — i.e. name
 * the skill after what it actually does. Picks the most frequent recurring
 * phrase (tie-broken by length) and title-cases it.
 * Returns null when nothing meaningful can be derived.
 */
export function skillNameFromPhrases(phrases, { maxWords = 5 } = {}) {
  const counts = new Map();
  let bestKey = '';
  let bestScore = 0;
  for (const phrase of phrases || []) {
    const words = cleanPhraseWords(phrase);
    if (!words.length) continue;
    const key = words.slice(0, maxWords).join(' ');
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > bestScore || (n === bestScore && key.length < bestKey.length && bestKey.length > 0)) {
      bestScore = n;
      bestKey = key;
    }
  }
  if (!bestKey) return null;
  return bestKey.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Make a skill name unique against existing skills (append " 2", " 3", ...). */
export function uniqueSkillName(stmts, base, maxTries = 50) {
  const cleaned = String(base || 'Skill').trim().slice(0, 60);
  if (!stmts?.skills?.getByName) return cleaned;
  let name = cleaned;
  let n = 2;
  while (n < maxTries && stmts.skills.getByName.get(name)) {
    name = `${cleaned} ${n}`;
    n += 1;
  }
  return name;
}

// Generic/placeholder names a model might emit instead of a real skill name.
const GENERIC_NAMES = new Set([
  'skill', 'skills', 'name', 'untitled', 'unnamed', 'placeholder', 'example',
  'kebab-case', 'skill-name', 'skill-name-kebab-case', 'evolved-skill',
  'evolved-skill-name', 'new-skill', 'my-skill', 'auto-skill',
]);

function isGenericName(name) {
  const norm = String(name).toLowerCase().replace(/\s+/g, '-');
  if (GENERIC_NAMES.has(norm)) return true;
  if (/kebab[- ]case|placeholder/.test(norm)) return true;
  if (/^(new|my|auto)[- ]skill$/.test(norm)) return true;
  if (/^evolved[- ]skill/.test(norm)) return true;
  if (/^skill[- ]name/.test(norm)) return true;
  return false;
}

/**
 * Validate a candidate skill name. Returns the cleaned name, or null when it
 * is missing, too long, or a generic placeholder (so callers can fall back to
 * a name derived from what the skill actually does).
 */
export function sanitizeSkillName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60);
  if (cleaned.length < 3) return null;
  if (isGenericName(cleaned)) return null;
  return cleaned;
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
