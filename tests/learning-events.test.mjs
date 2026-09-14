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

  it('masks compound/camelCase secret key names but not benign lookalikes', () => {
    const { payload } = redactPayload({
      db_password: 'hunter2',
      aws_secret_access_key: 'wJalrXUtnFEMI',
      smtp_password: 'pw',
      secret_key: 'k',
      dbPassword: 'camel',
      nested: { github_pat: 'github_pat_11ABCDEFG_0abcDEF1234567890' },
      monkey: 'banana',
      keyboard: 'qwerty',
      secretary: 'notes',
      safe: 'hello',
    });
    for (const k of ['db_password', 'aws_secret_access_key', 'smtp_password', 'secret_key', 'dbPassword']) {
      expect(payload[k]).toBe('[redacted-secret]');
    }
    expect(payload.nested.github_pat).toBe('[redacted-secret]');
    expect(payload.monkey).toBe('banana');
    expect(payload.keyboard).toBe('qwerty');
    expect(payload.secretary).toBe('notes');
    expect(payload.safe).toBe('hello');
  });

  it('masks extended token shapes', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const tokens = [
      `123456789:${'A'.repeat(35)}`, // Telegram bot token
      'xoxo-FAKE-TOKEN-123456789012-abcdef', // Slack org token (test fixture)
      'xoxe-1-FAKE-TOKEN-abcdef1234', // Slack external token (test fixture)
      'ASIAIOSFODNN7EXAMPLE', // AWS temp credentials
      'ghu_abcDEF1234567890', // GitHub user token
      'ghs_abcDEF1234567890', // GitHub server token
      'ghr_abcDEF1234567890', // GitHub refresh token
      'github_pat_11ABCDEFG_0abcDEF1234567890', // GitHub fine-grained PAT
      jwt,
      'whsec_abcDEF1234567890abcdef', // Stripe webhook secret
      'npm_abcDEF1234567890abcdef', // npm token
    ];
    for (const tok of tokens) {
      const { text } = redactText(`leaked ${tok} here`);
      expect(text).not.toContain(tok);
      expect(text).toContain('[redacted-api-key]');
    }
  });

  it('masks token=/session= assignments in prose', () => {
    const { text } = redactText('login with token=abc123def and session=xyz789qrs now');
    expect(text).not.toContain('abc123def');
    expect(text).not.toContain('xyz789qrs');
    expect(text).toContain('[redacted-secret]');
    const { text: plain } = redactText('the token expired yesterday, no session here');
    expect(plain).toBe('the token expired yesterday, no session here');
  });

  it('masks DB connection-string passwords', () => {
    const { text, redactions } = redactText('db=postgres://admin:s3cr3t@db.internal:5432/app');
    expect(text).not.toContain('s3cr3t');
    expect(text).toContain('postgres://admin:[redacted-secret]@');
    expect(redactions).toContain('connString');
    const { text: nopw } = redactText('db=mysql://root@db.internal:3306/shop');
    expect(nopw).not.toContain('[redacted-secret]');
  });

  it('masks PGP private-key blocks', () => {
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nxsBNBFabc\n-----END PGP PRIVATE KEY BLOCK-----';
    const { text } = redactText(`key:\n${pgp}`);
    expect(text).not.toContain('xsBNBFabc');
    expect(text).toContain('[redacted-private-key]');
  });

  it('masks dashless SSNs only with SSN context and plausible area', () => {
    const { text } = redactText('ssn 123456789 on file');
    expect(text).not.toContain('123456789');
    expect(text).toContain('[redacted-ssn]');
    expect(redactText('order 123456789 shipped').text).toContain('123456789');
    expect(redactText('ssn 900123456 on file').text).toContain('900123456');
    expect(redactText('ssn 666123456 on file').text).toContain('666123456');
  });

  it('masks numeric phone values only under phone-like keys', () => {
    const { payload } = redactPayload({ phoneNumber: 5551234567, orderId: 1234567890, hotel: 5551234567 });
    expect(payload.phoneNumber).toBe('[redacted-phone]');
    expect(payload.orderId).toBe(1234567890);
    expect(payload.hotel).toBe(5551234567);
  });

  it('partially masks IPv4 addresses but keeps dotted phones as phones', () => {
    const { text, redactions } = redactText('from 192.168.1.10 at noon');
    expect(text).not.toContain('192.168.1.10');
    expect(text).toContain('192.168.x.x');
    expect(redactions).toContain('ip');
    const { text: phone } = redactText('call me at 555.123.4567');
    expect(phone).toContain('[redacted-phone]');
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
