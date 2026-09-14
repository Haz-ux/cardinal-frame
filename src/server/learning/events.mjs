/**
 * Cardinal Frame — Learning Events — Durable Evidence Writer
 *
 * Phase 1 (durable learning events): capture-only evidence stream.
 *
 * Every agent turn terminal and every tool outcome writes one redacted,
 * user-scoped, idempotent row to learning_events (migrations 014 + 022).
 * This module NEVER triggers reviews, candidate promotion, or any change
 * to live behavior — it is the write-first layer the later phases distill.
 *
 * Idempotency: keyed on (user, conversation, terminal message/version).
 * Ownership: user_id is required on write and enforced on read.
 * Redaction: every payload passes through learning/redact.mjs first.
 * Telemetry: lightweight in-memory counters (written / deduplicated /
 * redacted / errors); failures are counted, never thrown into the caller.
 */

import { createHash, randomUUID } from 'crypto';
import { redactEventPayload } from './redact.mjs';

const telemetry = { written: 0, deduplicated: 0, redacted: 0, errors: 0 };

/** Snapshot of capture telemetry counters. */
export function getLearningTelemetry() {
  return { ...telemetry };
}

/** Reset counters (tests). */
export function resetLearningTelemetry() {
  telemetry.written = 0;
  telemetry.deduplicated = 0;
  telemetry.redacted = 0;
  telemetry.errors = 0;
}

/**
 * Capture kill-switch. Read per call so tests and operators can toggle it
 * at runtime: LEARNING_CAPTURE_ENABLED=false disables all event writes.
 */
export function captureEnabled() {
  return process.env.LEARNING_CAPTURE_ENABLED !== 'false';
}

/**
 * Deterministic idempotency key for (user, conversation, terminal version).
 * The terminal version should change when the terminal content changes
 * (e.g. a hash of the final message, or the step count).
 */
export function buildIdempotencyKey({ userId, conversationId, terminalVersion }) {
  return createHash('sha256')
    .update(`${userId || ''}|${conversationId || ''}|${terminalVersion || ''}`)
    .digest('hex')
    .slice(0, 32);
}

const INSERT_SQL = `INSERT OR IGNORE INTO learning_events
  (id, kind, user_id, conversation_id, trace_id, type, payload, outcome,
   redaction_status, idempotency_key, evidence, source_tier, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', 'pending')`;

/**
 * Write one redacted learning event. Idempotent: a repeat write with the
 * same (user, conversation, terminal version) is deduplicated via the
 * partial unique index from 022 and reported as such.
 *
 * Never throws — capture must not break the agent loop. Failures are
 * counted in telemetry and returned on the result object.
 *
 * @returns {{ id: string|null, deduplicated: boolean, redactionStatus: string,
 *            skipped?: boolean, error?: string }}
 */
export function record(db, { userId, conversationId, traceId, type, payload, outcome = 'unknown', idempotencyKey, terminalVersion } = {}) {
  try {
    if (!captureEnabled()) return { id: null, deduplicated: false, redactionStatus: 'clean', skipped: true };
    if (!userId) throw new Error('userId is required (ownership)');
    if (!type) throw new Error('type is required');

    const key = idempotencyKey
      || buildIdempotencyKey({ userId, conversationId, terminalVersion: terminalVersion ?? type });
    const { json, redaction_status } = redactEventPayload(payload ?? {});
    const id = randomUUID();

    const info = db.prepare(INSERT_SQL).run(
      id, type,
      userId, conversationId || '', traceId || '', type,
      json, outcome, redaction_status, key, json,
    );

    if (info.changes === 0) {
      telemetry.deduplicated++;
      return { id: null, deduplicated: true, redactionStatus: redaction_status };
    }
    telemetry.written++;
    if (redaction_status === 'redacted') telemetry.redacted++;
    return { id, deduplicated: false, redactionStatus: redaction_status };
  } catch (e) {
    telemetry.errors++;
    return { id: null, deduplicated: false, redactionStatus: 'clean', error: e.message };
  }
}

/** Alias with the Phase-1 plan's naming. */
export const recordLearningEvent = record;

/**
 * List events. Ownership is enforced: userId is required and always
 * filters. Cross-user reads are impossible through this API.
 */
export function list(db, userId, { conversationId, traceId, type, limit = 50 } = {}) {
  if (!userId) throw new Error('userId is required (ownership)');
  const clauses = ['user_id = ?'];
  const params = [userId];
  if (conversationId) { clauses.push('conversation_id = ?'); params.push(conversationId); }
  if (traceId) { clauses.push('trace_id = ?'); params.push(traceId); }
  if (type) { clauses.push('type = ?'); params.push(type); }
  const sql = `SELECT id, user_id, conversation_id, trace_id, type, payload,
                      outcome, redaction_status, created_at
               FROM learning_events
               WHERE ${clauses.join(' AND ')}
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?`;
  params.push(Math.min(Math.max(parseInt(limit) || 50, 1), 500));
  return db.prepare(sql).all(...params).map((r) => ({
    ...r,
    payload: safeParse(r.payload),
  }));
}

function safeParse(json) {
  try { return JSON.parse(json); } catch { return {}; }
}
