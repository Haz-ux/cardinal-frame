/**
 * Cardinal Frame — Learning Sources — Telegram Import Adapter (READ-ONLY)
 *
 * Imports Telegram chat history into the Phase-1 learning pipeline
 * (src/server/learning/events.mjs) as `import.message` events. Capture-only:
 * it only writes learning_events rows via record() — never triggers reviews,
 * candidate promotion, or any change to live behavior.
 *
 * SECURITY:
 *  - Read-only by design. This adapter only ever calls the Telegram
 *    getUpdates method. It never calls sendMessage or any mutating method.
 *  - The bot token is accepted as a function parameter and is NEVER logged,
 *    persisted, or echoed in errors/results. The route layer resolves it
 *    server-side from the comms channel config; clients can never supply it.
 *    (Audit 2026-09-13: bot tokens are stored in plaintext in comms channel
 *    config — treat the token as a hot potato: use it for the API call and
 *    drop it.)
 *  - getUpdates with no offset returns the most recent ~100 updates; this
 *    is a windowed pull, not full chat history.
 *
 * Reuses `telegramApiCall` from ../../routes/comms.mjs (the real Telegram
 * implementation) rather than duplicating the Bot API HTTP call.
 *
 * STUBBED / OUT OF SCOPE:
 *  - Full-history pagination: Telegram's getUpdates only returns the last
 *    ~100 updates; older history requires offset bookkeeping across calls
 *    (a cursor store) or the Bot API's export-style flows — not implemented.
 *  - Media attachments: only text/caption-bearing messages are imported;
 *    photos, voice, documents, and stickers are skipped (noted, not stored).
 *  - Edited messages are not merged with their originals (each update_id
 *    is one event); reactions, polls, and service messages are skipped.
 */

import { telegramApiCall, decryptCommsSecrets } from '../../routes/comms.mjs';
import { record, buildIdempotencyKey } from '../events.mjs';

const FETCH_CAP = 100; // hard cap: one getUpdates call returns at most ~100 updates

/**
 * List configured Telegram sources. Returns channel ids/names only —
 * NEVER bot tokens.
 *
 * @param {object} ctx { stmts } — needs stmts.commsChannels.getByPlatform
 * @returns {{ channel_id: string, name: string }[]}
 */
export function listTelegramSources({ stmts }) {
  const rows = stmts.commsChannels.getByPlatform.all('telegram');
  return rows.map((r) => ({ channel_id: r.id, name: r.name || r.id }));
}

/**
 * Read the bot token for a Telegram channel from server-side config.
 * The token is returned transiently for the API call and must not be
 * stored or logged by the caller.
 *
 * @returns {string|null} bot_token or null when absent/invalid
 */
export function resolveTelegramBotToken({ stmts }, channelId) {
  let channel = null;
  if (channelId) {
    channel = stmts.commsChannels.getById.get(channelId);
  } else {
    const rows = stmts.commsChannels.getByPlatform.all('telegram');
    channel = rows[0] || null;
  }
  if (!channel || channel.platform !== 'telegram') return null;
  try {
    const config = decryptCommsSecrets(JSON.parse(channel.config || '{}'));
    return typeof config.bot_token === 'string' && config.bot_token ? config.bot_token : null;
  } catch {
    return null;
  }
}

/** Pull one normalized message field from a raw Telegram message object. */
function normalizeMessage(update, chatIdFilter) {
  const msg = update.message || update.channel_post;
  if (!msg) return null;
  const text = msg.text || msg.caption;
  if (!text || typeof text !== 'string') return null; // media without caption: skipped (stubbed)

  const chatId = msg.chat && msg.chat.id;
  if (chatIdFilter != null && String(chatId) !== String(chatIdFilter)) return null;

  const from = msg.from || {};
  const author = from.username ? `@${from.username}` : (from.first_name || `user_${from.id || 'unknown'}`);

  return {
    external_id: String(update.update_id),
    conversation_id: `chat_${chatId}`,
    author,
    text,
    timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : null,
  };
}

/**
 * Read-only Telegram history pull via getUpdates, normalized to the
 * learning-source shape.
 *
 * @param {object} opts
 * @param {string} opts.botToken  resolved server-side; never logged
 * @param {string|number} [opts.chatId]  when set, only messages from this chat
 * @param {number} [opts.limit]  desired max messages; capped at FETCH_CAP
 * @param {function} [opts.apiCall] injectable for tests (defaults to the real telegramApiCall)
 * @returns {Promise<{ external_id, conversation_id, author, text, timestamp }[]>}
 */
export async function fetchTelegramHistory({ botToken, chatId = null, limit = 50, apiCall = telegramApiCall }) {
  if (!botToken) throw new Error('botToken is required');
  const capped = Math.min(Math.max(parseInt(limit) || 50, 1), FETCH_CAP);

  // Read-only: getUpdates with timeout 0 is a single non-blocking pull.
  // No offset tracking — this is the most recent ~100-update window.
  const updates = await apiCall(botToken, 'getUpdates', { limit: capped, timeout: 0 });
  if (!Array.isArray(updates)) return [];

  const out = [];
  for (const update of updates) {
    if (out.length >= capped) break;
    const normalized = normalizeMessage(update, chatId);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Import Telegram history into learning_events.
 *
 * @param db better-sqlite3 handle (migrations 014 + 022 applied)
 * @param {object} opts
 * @param {string} opts.userId   required — ownership scoping
 * @param {string} opts.botToken resolved server-side; never logged or persisted
 * @param {string|number} [opts.chatId]
 * @param {number} [opts.limit]
 * @param {boolean} [opts.dryRun] report counts, write nothing
 * @param {function} [opts.apiCall] injectable for tests
 * @returns {Promise<{ total, imported, deduplicated, errors: {line, error}[], redacted }>}
 */
export async function importTelegram(db, { userId, botToken, chatId = null, limit = 50, dryRun = false, apiCall }) {
  const result = { total: 0, imported: 0, deduplicated: 0, errors: [], redacted: 0 };
  if (!userId) {
    result.errors.push({ line: 0, error: 'userId is required (ownership)' });
    return result;
  }
  if (!botToken) {
    result.errors.push({ line: 0, error: 'no Telegram bot token configured (connect a Telegram channel first)' });
    return result;
  }

  let messages;
  try {
    messages = await fetchTelegramHistory({ botToken, chatId, limit, apiCall });
  } catch (e) {
    result.errors.push({ line: 0, error: `telegram fetch failed: ${e.message}` });
    return result;
  }
  result.total = messages.length;
  if (dryRun) {
    result.imported = messages.length; // would-be writes
    return result;
  }

  for (const m of messages) {
    // Idempotency: one event per (user, chat, message id). Re-imports of the
    // same window deduplicate instead of double-counting.
    const key = buildIdempotencyKey({
      userId,
      conversationId: m.conversation_id,
      terminalVersion: `msg_${m.external_id}`,
    });

    const rec = record(db, {
      userId,
      conversationId: m.conversation_id,
      traceId: `telegram:${m.external_id}`,
      type: 'import.message',
      payload: {
        role: 'user',
        text: m.text,
        author: m.author,
        external_id: m.external_id,
        timestamp: m.timestamp,
        _import: { source: 'telegram', chat: m.conversation_id },
      },
      outcome: 'received',
      idempotencyKey: key,
    });

    if (rec.error) {
      result.errors.push({ line: m.external_id, error: rec.error });
    } else if (rec.deduplicated) {
      result.deduplicated++;
    } else if (!rec.skipped) {
      result.imported++;
      if (rec.redactionStatus === 'redacted') result.redacted++;
    }
  }
  return result;
}

export { FETCH_CAP };
