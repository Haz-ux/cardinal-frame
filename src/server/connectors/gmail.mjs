/**
 * Gmail service connector — self-registers as 'gmail' (shares google-oauth.mjs).
 *
 * Auth: Google OAuth2 (offline). Tokens auto-refresh via getValidAccessToken
 * and are persisted encrypted by the routes layer.
 *
 * gmail_send is a WRITE action: it refuses to send unless the caller passes
 * confirmed === true. Agents must surface the draft and get explicit
 * confirmation before sending.
 */
import { registerConnector, sanitizeError } from './registry.mjs';
import { getValidAccessToken } from './google-oauth.mjs';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

const GMAIL_API = 'https://www.googleapis.com/gmail/v1';
const FETCH_TIMEOUT_MS = 15000;
const MAX_BODY_CHARS = 8000;

async function gmailRequest(state, path, { method = 'GET', body } = {}) {
  // Token refresh persistence is wired by the registry (encrypted storage).
  const accessToken = await getValidAccessToken(state, { save: state.persistSecrets });
  let res;
  try {
    res = await fetch(GMAIL_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Gmail request failed: ${sanitizeError(err)}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message ? sanitizeError(data.error.message) : `HTTP ${res.status}`;
    throw new Error(`Gmail API error (${res.status}): ${detail}`);
  }
  return data;
}

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function headerValue(headers, name) {
  const h = (headers || []).find(h => String(h.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

// Walk the MIME tree depth-first, preferring text/plain.
function extractText(payload) {
  if (!payload) return '';
  const texts = [];
  const visit = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    if (part.body?.data && (mime === 'text/plain' || (!mime.startsWith('text/html') && mime.startsWith('text/')))) {
      try { texts.push(b64urlDecode(part.body.data)); } catch { /* skip undecodable part */ }
    }
    for (const p of part.parts || []) visit(p);
  };
  visit(payload);
  return texts.join('\n').slice(0, MAX_BODY_CHARS);
}

registerConnector({
  id: 'gmail',
  name: 'Gmail',
  kind: 'service',
  configSchema: {
    type: 'object',
    properties: {
      oauth_client_id: { type: 'string', description: 'Google OAuth client ID' },
      oauth_redirect_uri: { type: 'string', description: 'Authorized redirect URI (must match Google Cloud Console exactly)' },
    },
    required: ['oauth_client_id'],
    additionalProperties: false,
  },
  testConnection: async (state) => {
    const data = await gmailRequest(state, '/users/me/profile');
    return { ok: true, message: `Gmail authorized as ${data.emailAddress}` };
  },
  actions: {
    gmail_search: {
      description: 'Search Gmail messages. Returns message ids with from/subject/date headers.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query (e.g. "from:boss subject:invoice newer_than:7d")' },
          max_results: { type: 'integer', default: 10 },
        },
        required: ['query'],
      },
      handler: async (state) => {
        const { args } = state;
        if (!args.query || typeof args.query !== 'string') throw new Error('query is required');
        const maxResults = Math.min(Math.max(parseInt(args.max_results, 10) || 10, 1), 50);
        const data = await gmailRequest(state, `/users/me/messages?q=${encodeURIComponent(args.query)}&maxResults=${maxResults}`);
        const messages = data.messages || [];
        // Enrich with headers (metadata) in one batch — bounded by maxResults.
        const enriched = [];
        for (const m of messages) {
          try {
            const full = await gmailRequest(state, `/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
            enriched.push({
              id: full.id,
              threadId: full.threadId,
              from: headerValue(full.payload?.headers, 'From'),
              subject: headerValue(full.payload?.headers, 'Subject'),
              date: headerValue(full.payload?.headers, 'Date'),
              snippet: full.snippet,
            });
          } catch (err) {
            enriched.push({ id: m.id, threadId: m.threadId, error: sanitizeError(err) });
          }
        }
        return { messages: enriched, resultSizeEstimate: data.resultSizeEstimate };
      },
    },

    gmail_read: {
      description: 'Read a full Gmail message by id. Returns headers and decoded text body (truncated).',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Gmail message id' },
        },
        required: ['message_id'],
      },
      handler: async (state) => {
        const { args } = state;
        if (!args.message_id || typeof args.message_id !== 'string') throw new Error('message_id is required');
        if (!/^[A-Za-z0-9_-]+$/.test(args.message_id)) throw new Error('Invalid message_id');
        const full = await gmailRequest(state, `/users/me/messages/${args.message_id}?format=full`);
        const headers = full.payload?.headers || [];
        return {
          id: full.id,
          threadId: full.threadId,
          from: headerValue(headers, 'From'),
          to: headerValue(headers, 'To'),
          subject: headerValue(headers, 'Subject'),
          date: headerValue(headers, 'Date'),
          snippet: full.snippet,
          body_text: extractText(full.payload),
          truncated: true,
        };
      },
    },

    gmail_send: {
      description: 'Send an email via Gmail. REQUIRES confirmed=true — the caller must show the draft to the user and get explicit confirmation first. Never send silently.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain-text email body' },
          confirmed: { type: 'boolean', description: 'MUST be true. Confirms the user explicitly approved sending this email.' },
        },
        required: ['to', 'subject', 'body', 'confirmed'],
      },
      handler: async (state) => {
        const { args } = state;
        // Two-step confirmation gate: refuse unless explicitly confirmed.
        if (args.confirmed !== true) {
          return {
            error: 'Confirmation required: gmail_send refused. Show the draft (to, subject, body) to the user and re-invoke with confirmed=true only after they explicitly approve.',
          };
        }
        const to = String(args.to || '').trim();
        const subject = String(args.subject || '').trim();
        const body = String(args.body || '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('to must be a valid email address');
        if (!subject) throw new Error('subject is required');
        if (!body) throw new Error('body is required');
        const raw = Buffer.from(
          `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
          'utf8'
        ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const data = await gmailRequest(state, '/users/me/messages/send', { method: 'POST', body: { raw } });
        return { sent: true, id: data.id, threadId: data.threadId };
      },
    },
  },
});
