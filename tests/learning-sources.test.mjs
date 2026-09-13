import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseJsonl, importJsonl } from '../src/server/learning/sources/jsonl.mjs';
import {
  fetchTelegramHistory,
  importTelegram,
  listTelegramSources,
  resolveTelegramBotToken,
  FETCH_CAP,
} from '../src/server/learning/sources/telegram.mjs';
import { record, list, resetLearningTelemetry } from '../src/server/learning/events.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'src', 'server', 'migrations');

function freshDb() {
  const d = new Database(':memory:');
  d.exec(readFileSync(join(MIGRATIONS, '014_learning_events.sql'), 'utf8'));
  d.exec(readFileSync(join(MIGRATIONS, '022_learning_events.sql'), 'utf8'));
  d.exec(readFileSync(join(MIGRATIONS, '024_learning_imports.sql'), 'utf8'));
  return d;
}

let db;
const eventCount = () => db.prepare('SELECT COUNT(*) c FROM learning_events').get().c;

beforeEach(() => {
  db = freshDb();
  resetLearningTelemetry();
  delete process.env.LEARNING_CAPTURE_ENABLED;
});

const goodLine = (extra = {}) => JSON.stringify({
  conversation_id: 'conv-1',
  trace_id: 'trace-1',
  type: 'message',
  payload: { role: 'user', text: 'hello' },
  outcome: 'success',
  terminal_version: 'v1',
  ...extra,
});

describe('jsonl source', () => {
  it('parses good lines, skips blanks, reports bad lines', () => {
    const text = [
      goodLine(),
      '',
      '   ',
      '{not json',
      goodLine({ conversation_id: 'conv-2' }),
    ].join('\n');
    const { lines, errors } = parseJsonl(text);
    expect(lines).toHaveLength(2);
    expect(lines[0].conversation_id).toBe('conv-1');
    expect(lines[1].conversation_id).toBe('conv-2');
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(4);
  });

  it('dry-run reports counts without writing', () => {
    const text = [goodLine(), goodLine({ conversation_id: 'conv-2' }), '{bad'].join('\n');
    const before = eventCount();
    const stats = importJsonl(db, { userId: 'u1', text, dryRun: true });
    expect(stats.total).toBe(2);
    expect(stats.imported).toBe(2);
    expect(stats.errors).toHaveLength(1);
    expect(eventCount()).toBe(before);
  });

  it('real import writes redacted, namespaced events', () => {
    const text = goodLine({ payload: { role: 'user', text: 'reach me at shane@example.com' } });
    const stats = importJsonl(db, { userId: 'u1', text, sourceLabel: 'test' });
    expect(stats.imported).toBe(1);
    expect(stats.redacted).toBe(1);
    expect(stats.errors).toHaveLength(0);

    const events = list(db, 'u1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('import.message');
    expect(events[0].conversation_id).toBe('conv-1');
    expect(events[0].payload.text).not.toContain('shane@example.com');
    expect(events[0].payload.text).toContain('[redacted-email]');
    expect(events[0].redaction_status).toBe('redacted');
    expect(events[0].payload._import.source).toBe('jsonl');
  });

  it('unknown line type falls back to import.raw', () => {
    const stats = importJsonl(db, { userId: 'u1', text: goodLine({ type: 'whatever' }) });
    expect(stats.imported).toBe(1);
    expect(list(db, 'u1')[0].type).toBe('import.raw');
  });

  it('is idempotent: importing twice fully deduplicates', () => {
    const text = [goodLine(), goodLine({ conversation_id: 'conv-2' })].join('\n');
    const first = importJsonl(db, { userId: 'u1', text });
    expect(first.imported).toBe(2);
    expect(first.deduplicated).toBe(0);

    const second = importJsonl(db, { userId: 'u1', text });
    expect(second.imported).toBe(0);
    expect(second.deduplicated).toBe(2);
    expect(eventCount()).toBe(2);
  });

  it('rejects missing conversation_id per line', () => {
    const text = JSON.stringify({ type: 'message', payload: {} });
    const stats = importJsonl(db, { userId: 'u1', text });
    expect(stats.imported).toBe(0);
    expect(stats.errors[0].error).toMatch(/conversation_id/);
  });

  it('requires userId (ownership)', () => {
    const stats = importJsonl(db, { userId: '', text: goodLine() });
    expect(stats.errors[0].error).toMatch(/userId/);
    expect(eventCount()).toBe(0);
  });
});

describe('events.mjs ownership (source context)', () => {
  it('record() rejects missing userId without throwing', () => {
    const r = record(db, { conversationId: 'c', type: 'import.message', payload: {} });
    expect(r.error).toMatch(/userId/);
    expect(eventCount()).toBe(0);
  });
});

describe('telegram source adapter', () => {
  const fakeUpdates = [
    { update_id: 1, message: { message_id: 11, chat: { id: 555 }, from: { id: 7, username: 'haz' }, text: 'hey bot', date: 1757800000 } },
    { update_id: 2, channel_post: { message_id: 12, chat: { id: 555 }, text: 'channel post' } },
    { update_id: 3, message: { message_id: 13, chat: { id: 555 }, from: { id: 7 }, photo: [{ file_id: 'x' }] } }, // media, no caption -> skipped
    { update_id: 4, message: { message_id: 14, chat: { id: 999 }, from: { id: 9, first_name: 'Zed' }, text: 'other chat' } },
  ];
  const stubApiCall = async (token, method, params) => {
    expect(method).toBe('getUpdates'); // read-only method only
    return fakeUpdates.slice(0, params.limit);
  };

  it('normalizes messages with a stubbed fetch', async () => {
    const msgs = await fetchTelegramHistory({ botToken: 'tok', limit: 50, apiCall: stubApiCall });
    expect(msgs).toHaveLength(3); // media-without-caption skipped
    expect(msgs[0]).toMatchObject({
      external_id: '1',
      conversation_id: 'chat_555',
      author: '@haz',
      text: 'hey bot',
    });
    expect(msgs[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(msgs[1].author).toBe('user_unknown'); // channel_post has no from
    expect(msgs[2].conversation_id).toBe('chat_999');
  });

  it('filters by chatId when given', async () => {
    const msgs = await fetchTelegramHistory({ botToken: 'tok', chatId: 555, apiCall: stubApiCall });
    expect(msgs.every((m) => m.conversation_id === 'chat_555')).toBe(true);
  });

  it('caps limit at FETCH_CAP', async () => {
    let seenLimit = 0;
    await fetchTelegramHistory({
      botToken: 'tok', limit: 10_000,
      apiCall: async (t, m, p) => { seenLimit = p.limit; return []; },
    });
    expect(seenLimit).toBe(FETCH_CAP);
  });

  it('dry-run reports without writing and never leaks the token', async () => {
    const before = eventCount();
    const stats = await importTelegram(db, {
      userId: 'u1', botToken: 'SECRET-TOKEN', limit: 50, dryRun: true, apiCall: stubApiCall,
    });
    expect(stats.total).toBe(3);
    expect(stats.imported).toBe(3);
    expect(eventCount()).toBe(before);
    expect(JSON.stringify(stats)).not.toContain('SECRET-TOKEN');
  });

  it('imports messages as import.message events, idempotent on re-import', async () => {
    const opts = { userId: 'u1', botToken: 'tok', limit: 50, apiCall: stubApiCall };
    const first = await importTelegram(db, opts);
    expect(first.imported).toBe(3);
    expect(first.errors).toHaveLength(0);
    expect(first.redacted).toBe(0);

    const events = list(db, 'u1');
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === 'import.message')).toBe(true);
    expect(events[0].payload._import.source).toBe('telegram');

    const second = await importTelegram(db, opts);
    expect(second.imported).toBe(0);
    expect(second.deduplicated).toBe(3);
    expect(eventCount()).toBe(3);
  });

  it('requires userId and botToken', async () => {
    const noUser = await importTelegram(db, { userId: '', botToken: 'tok', apiCall: stubApiCall });
    expect(noUser.errors[0].error).toMatch(/userId/);
    const noToken = await importTelegram(db, { userId: 'u1', botToken: '', apiCall: stubApiCall });
    expect(noToken.errors[0].error).toMatch(/bot token/);
    expect(eventCount()).toBe(0);
  });

  it('surfaces fetch failures as errors, never throws', async () => {
    const failing = async () => { throw new Error('401 Unauthorized'); };
    const stats = await importTelegram(db, { userId: 'u1', botToken: 'tok', apiCall: failing });
    expect(stats.total).toBe(0);
    expect(stats.errors[0].error).toContain('telegram fetch failed');
    expect(eventCount()).toBe(0);
  });
});

describe('telegram channel helpers', () => {
  function fakeStmts(rows) {
    return {
      commsChannels: {
        getByPlatform: { all: () => rows },
        getById: { get: (id) => rows.find((r) => r.id === id) || null },
      },
    };
  }

  it('lists channel ids/names only — never tokens', () => {
    const rows = [{ id: 'ch1', name: 'Main', platform: 'telegram', config: JSON.stringify({ bot_token: 'SECRET' }) }];
    const sources = listTelegramSources({ stmts: fakeStmts(rows) });
    expect(sources).toEqual([{ channel_id: 'ch1', name: 'Main' }]);
    expect(JSON.stringify(sources)).not.toContain('SECRET');
  });

  it('resolves the bot token server-side from channel config', () => {
    const rows = [{ id: 'ch1', name: 'Main', platform: 'telegram', config: JSON.stringify({ bot_token: 'tok-123' }) }];
    const stmts = fakeStmts(rows);
    expect(resolveTelegramBotToken({ stmts }, 'ch1')).toBe('tok-123');
    expect(resolveTelegramBotToken({ stmts }, 'nope')).toBe(null);
    expect(resolveTelegramBotToken({ stmts: fakeStmts([]) })).toBe(null);
  });
});
