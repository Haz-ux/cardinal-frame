/**
 * Cardinal Frame — Learning Sources — JSONL Import Adapter
 *
 * Imports external conversations into the Phase-1 learning pipeline
 * (src/server/learning/events.mjs). Capture-only: this adapter only writes
 * learning_events rows via record() — it never triggers reviews, candidate
 * promotion, or any change to live behavior.
 *
 * ─── JSONL LINE FORMAT (one JSON object per line) ───
 *
 *   {
 *     "conversation_id": "conv-123",        // required — groups the event
 *     "trace_id":        "trace-abc",       // optional — pass-through
 *     "type":            "message",         // message | tool_outcome | terminal_turn
 *     "payload":         { "role": "user", "text": "hello" },
 *     "outcome":         "success",         // optional — free string
 *     "terminal_version":"v3"               // optional — see idempotency below
 *   }
 *
 * Idempotency: each line's event key is built with buildIdempotencyKey from
 * (userId, line.conversation_id, line.terminal_version || line.trace_id ||
 * the line index). Re-importing the same file deduplicates instead of
 * double-counting; changing terminal_version (e.g. a hash of new content)
 * creates a new version of the same conversation.
 *
 * Event types: the line's `type` is namespaced to `import.<type>` so imported
 * evidence is always distinguishable from live agent capture. Lines with a
 * missing/unknown type fall back to `import.raw`.
 *
 * Limits: parseJsonl caps input at MAX_LINES (10k). Routes add their own
 * request body cap (the import route rejects data > 1MB).
 */

import { record, buildIdempotencyKey, resetLearningTelemetry, getLearningTelemetry } from '../events.mjs';

const MAX_LINES = 10_000;
const VALID_TYPES = new Set(['message', 'tool_outcome', 'terminal_turn']);

/**
 * Parse JSONL text into line objects.
 *
 * @returns {{ lines: object[], errors: { line: number, error: string }[] }}
 *          lines carry their 1-based `__line` number for error reporting.
 */
export function parseJsonl(text) {
  const errors = [];
  const lines = [];
  if (typeof text !== 'string' || text.length === 0) return { lines, errors };

  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const trimmed = raw[i].trim();
    if (!trimmed) continue; // skip blank lines
    if (lines.length >= MAX_LINES) {
      errors.push({ line: i + 1, error: `line cap exceeded (${MAX_LINES}) — remaining lines ignored` });
      break;
    }
    try {
      const obj = JSON.parse(trimmed);
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        errors.push({ line: i + 1, error: 'line is not a JSON object' });
        continue;
      }
      lines.push({ ...obj, __line: i + 1 });
    } catch (e) {
      errors.push({ line: i + 1, error: `invalid JSON: ${e.message}` });
    }
  }
  return { lines, errors };
}

/** Validate one parsed line; returns an error string or null. */
function validateLine(line) {
  if (!line.conversation_id || typeof line.conversation_id !== 'string') {
    return 'missing or invalid conversation_id';
  }
  if (line.payload !== undefined && (line.payload === null || typeof line.payload !== 'object' || Array.isArray(line.payload))) {
    return 'payload must be an object when present';
  }
  return null;
}

function namespacedType(line) {
  return VALID_TYPES.has(line.type) ? `import.${line.type}` : 'import.raw';
}

/**
 * Import parsed JSONL into learning_events.
 *
 * @param db better-sqlite3 handle (migrations 014 + 022 applied)
 * @param {object} opts
 * @param {string} opts.userId     required — ownership scoping; record() enforces it
 * @param {string} opts.text       raw JSONL text
 * @param {string} [opts.sourceLabel] free-form label for provenance in payload
 * @param {boolean} [opts.dryRun]  parse + validate + report counts, write nothing
 * @returns {{ total, imported, deduplicated, errors: {line, error}[], redacted }}
 */
export function importJsonl(db, { userId, text, sourceLabel = '', dryRun = false }) {
  const result = { total: 0, imported: 0, deduplicated: 0, errors: [], redacted: 0 };
  if (!userId) {
    result.errors.push({ line: 0, error: 'userId is required (ownership)' });
    return result;
  }

  const { lines, errors } = parseJsonl(text);
  result.errors.push(...errors);
  result.total = lines.length;
  let valid = 0;

  for (const line of lines) {
    const lineNo = line.__line;
    const validationError = validateLine(line);
    if (validationError) {
      result.errors.push({ line: lineNo, error: validationError });
      continue;
    }
    valid++;
    if (dryRun) continue;

    const key = buildIdempotencyKey({
      userId,
      conversationId: line.conversation_id,
      terminalVersion: line.terminal_version || line.trace_id || String(lineNo),
    });

    const rec = record(db, {
      userId,
      conversationId: line.conversation_id,
      traceId: line.trace_id || '',
      type: namespacedType(line),
      payload: {
        ...(line.payload || {}),
        _import: { source: 'jsonl', label: sourceLabel, line: lineNo },
      },
      outcome: line.outcome || 'unknown',
      idempotencyKey: key,
    });

    if (rec.error) {
      result.errors.push({ line: lineNo, error: rec.error });
    } else if (rec.deduplicated) {
      result.deduplicated++;
    } else if (!rec.skipped) {
      result.imported++;
      if (rec.redactionStatus === 'redacted') result.redacted++;
    }
  }

  // dryRun: imported counts the lines that would be written (valid ones).
  if (dryRun) result.imported = valid;
  return result;
}

export { MAX_LINES, resetLearningTelemetry, getLearningTelemetry };
