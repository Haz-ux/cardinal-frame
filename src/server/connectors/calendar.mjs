/**
 * Google Calendar service connector — self-registers as 'google-calendar'
 * (shares google-oauth.mjs).
 *
 * Auth: Google OAuth2 (offline). Tokens auto-refresh via getValidAccessToken
 * and are persisted encrypted by the routes layer.
 */
import { registerConnector, sanitizeError } from './registry.mjs';
import { getValidAccessToken } from './google-oauth.mjs';

export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const FETCH_TIMEOUT_MS = 15000;

async function calRequest(state, path, { method = 'GET', body } = {}) {
  // Token refresh persistence is wired by the registry (encrypted storage).
  const accessToken = await getValidAccessToken(state, { save: state.persistSecrets });
  let res;
  try {
    res = await fetch(CAL_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Calendar request failed: ${sanitizeError(err)}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message ? sanitizeError(data.error.message) : `HTTP ${res.status}`;
    throw new Error(`Calendar API error (${res.status}): ${detail}`);
  }
  return data;
}

function pickEvent(e) {
  return {
    id: e.id,
    summary: e.summary,
    description: e.description ? String(e.description).slice(0, 500) : null,
    location: e.location || null,
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    attendees: (e.attendees || []).map(a => a.email),
    htmlLink: e.htmlLink || null,
    status: e.status || null,
  };
}

function isoOrThrow(value, name) {
  if (!value || typeof value !== 'string') throw new Error(`${name} is required (ISO 8601)`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${name} is not a valid date/time: ${value}`);
  return d.toISOString();
}

registerConnector({
  id: 'google-calendar',
  name: 'Google Calendar',
  kind: 'service',
  configSchema: {
    type: 'object',
    properties: {
      oauth_client_id: { type: 'string', description: 'Google OAuth client ID' },
      oauth_redirect_uri: { type: 'string', description: 'Authorized redirect URI (must match Google Cloud Console exactly)' },
      calendar_id: { type: 'string', description: 'Calendar to use (default: primary)' },
    },
    required: ['oauth_client_id'],
    additionalProperties: false,
  },
  testConnection: async (state) => {
    const data = await calRequest(state, '/users/me/calendarList?maxResults=1');
    return { ok: true, message: `Calendar authorized (${data.items?.length ?? 0} calendar(s) visible)` };
  },
  actions: {
    calendar_list_events: {
      description: 'List upcoming events on the primary (or configured) calendar.',
      parameters: {
        type: 'object',
        properties: {
          time_min: { type: 'string', description: 'Start of window (ISO 8601, default: now)' },
          time_max: { type: 'string', description: 'End of window (ISO 8601, optional)' },
          max_results: { type: 'integer', default: 10 },
        },
        required: [],
      },
      handler: async (state) => {
        const { args, config } = state;
        const calendarId = encodeURIComponent(config.calendar_id || 'primary');
        const maxResults = Math.min(Math.max(parseInt(args.max_results, 10) || 10, 1), 100);
        const params = new URLSearchParams({
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: String(maxResults),
          timeMin: args.time_min ? isoOrThrow(args.time_min, 'time_min') : new Date().toISOString(),
        });
        if (args.time_max) params.set('timeMax', isoOrThrow(args.time_max, 'time_max'));
        const data = await calRequest(state, `/calendars/${calendarId}/events?${params.toString()}`);
        return { events: (data.items || []).map(pickEvent) };
      },
    },

    calendar_create_event: {
      description: 'Create an event on the primary (or configured) calendar.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Event title' },
          start_datetime: { type: 'string', description: 'Start (ISO 8601)' },
          end_datetime: { type: 'string', description: 'End (ISO 8601)' },
          description: { type: 'string' },
          location: { type: 'string' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses' },
        },
        required: ['summary', 'start_datetime', 'end_datetime'],
      },
      handler: async (state) => {
        const { args, config } = state;
        const calendarId = encodeURIComponent(config.calendar_id || 'primary');
        const summary = String(args.summary || '').trim();
        if (!summary) throw new Error('summary is required');
        const start = isoOrThrow(args.start_datetime, 'start_datetime');
        const end = isoOrThrow(args.end_datetime, 'end_datetime');
        if (new Date(end) <= new Date(start)) throw new Error('end_datetime must be after start_datetime');
        const attendees = Array.isArray(args.attendees) ? args.attendees : [];
        for (const a of attendees) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(a))) throw new Error(`Invalid attendee email: ${a}`);
        }
        const body = {
          summary,
          start: { dateTime: start },
          end: { dateTime: end },
        };
        if (args.description) body.description = String(args.description);
        if (args.location) body.location = String(args.location);
        if (attendees.length) body.attendees = attendees.map(email => ({ email }));
        const data = await calRequest(state, `/calendars/${calendarId}/events`, { method: 'POST', body });
        return { created: true, event: pickEvent(data) };
      },
    },
  },
});
