import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { redactText, redactPayload, redactEventPayload } from '../src/server/learning/redact.mjs';
import {
  record, list, buildIdempotencyKey, captureEnabled,
  getLearningTelemetry, resetLearningTelemetry,
} from '../src/server/learning/events.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

let db;

function freshDb() {
  const d = new Database(':memory:');
  // Apply the real migrations in order, like migrator.mjs does.
  d.exec(readFileSync(join(MIGRATIONS, '014_learning_events.sql'), 'utf8'));
  d.exec(readFileSync(join(MIGRATIONS, '022_learning_events.sql'), 'utf8'));
  return d;
}

beforeAll(() => {
  db = freshDb();
});

beforeEach(() => {
  resetLearningTelemetry();
  delete process.env.LEARNING_CAPTURE_ENABLED;
});

describe('redact.mjs', () => {
  it('masks emails', () => {
    const { text, redactions } = redactText('contact shane@example.com today');
    expect(text).not.toContain('shane@example.com');
    expect(text).toContain('[redacted-email]');
    expect(redactions).toContain('email');
  });

  it('masks phone numbers', () => {
    const { text } = redactText('call me at 555-123-4567');
    expect(text).not.toContain('555-123-4567');
    expect(text).toContain('[redacted-phone]');
  });

  it('masks SSNs', () => {
    const { text } = redactText('ssn 123-45-6789 on file');
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('[redacted-ssn]');
  });

  it('masks Luhn-valid card numbers but keeps other digit runs', () => {
    const { text } = redactText('card 4111111111111111 and order 12345');
    expect(text).not.toContain('4111111111111111');
    expect(text).toContain('[redacted-card]');
    expect(text).toContain('12345');
  });

  it('masks API keys, bearer tokens, and password assignments', () => {
    const { text } = redactText('key sk-abcDEF1234567890 and Bearer tok12345678, password=hunter2!');
    expect(text).not.toContain('sk-abcDEF1234567890');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[redacted-api-key]');
    expect(text).toContain('[redacted-secret]');
  });

  it('masks secret values by key name in objects', () => {
    const { payload, redacted } = redactPayload({ api_key: 'live-123', nested: { token: 'abc', safe: 'hello' } });
    expect(payload.api_key).toBe('[redacted-secret]');
    expect(payload.nested.token).toBe('[redacted-secret]');
    expect(payload.nested.safe).toBe('hello');
    expect(redacted).toBe(true);
  });

  it('reports clean for innocuous payloads', () => {
    const { json, redaction_status } = redactEventPayload({ tool: 'file_read', ok: true });
    expect(redaction_status).toBe('clean');
    expect(JSON.parse(json).tool).toBe('file_read');
  });
});

describe('learning events writer (Phase 1)', () => {
  it('writes a redacted event with ownership fields', () => {
    const res = record(db, {
      userId: 'user-a',
      conversationId: 'conv-1',
      traceId: 'trace-1',
      type: 'tool_outcome',
      payload: { tool: 'shell_exec', note: 'email shane@example.com' },
      outcome: 'completed',
      terminalVersion: 'v1',
    });
    expect(res.deduplicated).toBe(false);
    expect(res.id).toBeTruthy();
    expect(res.redactionStatus).toBe('redacted');

    const rows = list(db, 'user-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('user-a');
    expect(rows[0].conversation_id).toBe('conv-1');
    expect(rows[0].trace_id).toBe('trace-1');
    expect(rows[0].type).toBe('tool_outcome');
    expect(JSON.stringify(rows[0].payload)).not.toContain('shane@example.com');
  });

  it('deduplicates repeat writes with the same idempotency key', () => {
    const evt = {
      userId: 'user-a', conversationId: 'conv-dedupe', traceId: 't',
      type: 'turn_terminal', payload: { x: 1 }, outcome: 'completed',
      terminalVersion: 'same-version',
    };
    const first = record(db, evt);
    const second = record(db, evt);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(list(db, 'user-a', { conversationId: 'conv-dedupe' })).toHaveLength(1);
    expect(getLearningTelemetry().deduplicated).toBe(1);
  });

  it('treats different terminal versions as distinct events', () => {
    record(db, { userId: 'user-a', conversationId: 'conv-ver', type: 'turn_terminal', payload: {}, terminalVersion: 'v1' });
    record(db, { userId: 'user-a', conversationId: 'conv-ver', type: 'turn_terminal', payload: {}, terminalVersion: 'v2' });
    expect(list(db, 'user-a', { conversationId: 'conv-ver' })).toHaveLength(2);
  });

  it('enforces ownership: users only see their own events', () => {
    record(db, { userId: 'user-a', conversationId: 'conv-a', type: 'turn_terminal', payload: {}, terminalVersion: 'v1' });
    record(db, { userId: 'user-b', conversationId: 'conv-b', type: 'turn_terminal', payload: {}, terminalVersion: 'v1' });

    const aRows = list(db, 'user-a', { type: 'turn_terminal' });
    const bRows = list(db, 'user-b', { type: 'turn_terminal' });
    expect(aRows.every((r) => r.user_id === 'user-a')).toBe(true);
    expect(bRows.every((r) => r.user_id === 'user-b')).toBe(true);
    expect(aRows.some((r) => r.conversation_id === 'conv-b')).toBe(false);
    expect(bRows.some((r) => r.conversation_id === 'conv-a')).toBe(false);
  });

  it('requires userId on write and read', () => {
    const res = record(db, { type: 'turn_terminal', payload: {} });
    expect(res.error).toMatch(/userId/);
    expect(() => list(db, '')).toThrow(/userId/);
  });

  it('never throws into the caller on DB errors', () => {
    const badDb = { prepare: () => { throw new Error('boom'); } };
    const res = record(badDb, { userId: 'u', type: 't', payload: {} });
    expect(res.error).toBe('boom');
    expect(getLearningTelemetry().errors).toBe(1);
  });

  it('honors the LEARNING_CAPTURE_ENABLED kill-switch', () => {
    process.env.LEARNING_CAPTURE_ENABLED = 'false';
    expect(captureEnabled()).toBe(false);
    const res = record(db, { userId: 'user-a', conversationId: 'c', type: 't', payload: {} });
    expect(res.skipped).toBe(true);
    expect(getLearningTelemetry().written).toBe(0);
  });

  it('tracks telemetry counters', () => {
    record(db, { userId: 'u', conversationId: 'c1', type: 'turn_terminal', payload: { email: 'a@b.com' }, terminalVersion: 'v1' });
    record(db, { userId: 'u', conversationId: 'c1', type: 'turn_terminal', payload: { email: 'a@b.com' }, terminalVersion: 'v1' });
    const t = getLearningTelemetry();
    expect(t.written).toBe(1);
    expect(t.deduplicated).toBe(1);
    expect(t.redacted).toBe(1);
  });

  it('builds stable idempotency keys from (user, conversation, version)', () => {
    const k1 = buildIdempotencyKey({ userId: 'u', conversationId: 'c', terminalVersion: 'v1' });
    const k2 = buildIdempotencyKey({ userId: 'u', conversationId: 'c', terminalVersion: 'v1' });
    const k3 = buildIdempotencyKey({ userId: 'u', conversationId: 'c', terminalVersion: 'v2' });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
});
