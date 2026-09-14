# Cardinal Frame Service Connectors

Service connectors let Cardinal Frame (and its agents) talk to external
services: GitHub, Gmail, and Google Calendar today. Each connector is a
self-registering module under `src/server/connectors/`; every action becomes
an **agent tool** automatically (tool name = action id, e.g.
`github_list_issues`).

Security model (non-negotiable):

- Secrets (PATs, OAuth client secrets, tokens) are stored **AES-256-GCM
  encrypted** in the `connectors` table (`secret_json`). Raw secrets never
  appear in logs, API responses, audit records, or error strings.
- Every connector invocation is audit-logged (`connector.invoke`) with
  **redacted** args.
- `gmail_send` refuses to send unless the caller passes `confirmed: true`.
  Agents must show the draft and get explicit user approval first — there is
  no silent sending.
- All connector admin routes require the `admin` role.

## What each connector does

### GitHub (`github`) — PAT auth, no OAuth needed

| Action | What it does |
|---|---|
| `github_list_issues` | List issues for `owner`/`repo` (`state`: open/closed/all, default open) |
| `github_get_issue` | Get one issue by `issue_number` |
| `github_list_prs` | List pull requests (`state` default open) |
| `github_create_issue_comment` | Post a comment on an issue/PR (`issue_number`, `body`) |

Optional config: `default_owner`, `default_repo` so calls can omit them.

### Gmail (`gmail`) — Google OAuth2 (offline)

| Action | What it does |
|---|---|
| `gmail_search` | Search messages (`query`, `max_results` ≤ 50); returns id/from/subject/date/snippet |
| `gmail_read` | Read full message (`message_id`); decoded text body, truncated |
| `gmail_send` | Send email (`to`, `subject`, `body`, **`confirmed: true` required**) |

### Google Calendar (`google-calendar`) — Google OAuth2 (offline)

| Action | What it does |
|---|---|
| `calendar_list_events` | List events (`time_min`, `time_max`, `max_results` ≤ 100; defaults to now) |
| `calendar_create_event` | Create event (`summary`, `start_datetime`, `end_datetime`, optional `description`, `location`, `attendees[]`) |

## Configuring via the API

All routes are under `/api/connectors`, admin only.

```bash
BASE=https://<cardinal-host>:8080
H='Authorization: Bearer <ADMIN_JWT>'

# 1. See what's registered (masked — no secrets ever returned)
curl -s $H $BASE/api/connectors | jq

# 2a. GitHub: store the PAT (encrypted) + optional defaults
curl -s -X POST $H $BASE/api/connectors/github/configure \
  -H 'Content-Type: application/json' \
  -d '{"config":{"default_owner":"Haz-ux","default_repo":"cardinal-frame"},
       "secrets":{"pat":"ghp_…"}}'

# 2b. Google connectors: store the OAuth client ID + redirect URI (NOT the
#     client secret via config — put it in secrets), then run the OAuth flow
curl -s -X POST $H $BASE/api/connectors/gmail/configure \
  -H 'Content-Type: application/json' \
  -d '{"config":{"oauth_client_id":"<CLIENT_ID>",
                 "oauth_redirect_uri":"https://<cardinal-host>:8080/api/connectors/google/callback"},
       "secrets":{"oauth_client":{"client_id":"<CLIENT_ID>","client_secret":"<CLIENT_SECRET>"}}}'

# 3. Start the OAuth flow (open in a browser while logged in as admin;
#    ?token= is accepted for browser-initiated flows)
open "$BASE/api/connectors/google/authorize?connector=gmail&token=<ADMIN_JWT>"
# → redirects to Google's consent screen → back to
#   /api/connectors/google/callback, which stores tokens encrypted.

# 4. Test stored credentials
curl -s -X POST $H $BASE/api/connectors/gmail/test

# 5. Enable / disable (agents can only use enabled connectors)
curl -s -X POST $H $BASE/api/connectors/github/enable
curl -s -X POST $H $BASE/api/connectors/github/disable
```

The OAuth callback needs no auth header (Google redirects the browser
directly); the random one-time `state` stored on the connector row is the
CSRF protection and is cleared after a single use.

Access tokens refresh automatically ~60s before expiry; refreshed tokens are
re-persisted encrypted.

## What Haz must provide for Google OAuth

Google registration **cannot** be completed by the agent — Haz does this in
the Google Cloud Console:

1. **Google Cloud project** — create (or reuse) a project at
   https://console.cloud.google.com.
2. **OAuth consent screen** — configure it (External user type is fine).
   While in **Testing** mode, add Haz's Google account under *Test users* —
   consent works only for test users until the app is published/verified.
   Publishing to **Production** removes the test-user limit but triggers
   Google's verification review for sensitive scopes (Gmail/Calendar are
   sensitive scopes).
3. **OAuth client ID credentials** — *APIs & Services → Credentials →
   Create Credentials → OAuth client ID*, application type **Web
   application**. Copy the **Client ID** and **Client secret**.
4. **Authorized redirect URI** — add EXACTLY this (it must match character
   for character, including scheme, host, port, and path):

   ```
   https://<cardinal-host>:8080/api/connectors/google/callback
   ```

   Replace `<cardinal-host>` with the real host name Cardinal Frame is
   served from. If Cardinal is behind plain HTTP on a LAN, use
   `http://<lan-ip>:8080/api/connectors/google/callback` — but Google only
   allows `http` redirect URIs for `localhost`; any other host requires
   `https`.
5. **APIs to enable** — *APIs & Services → Library*: enable **Gmail API**
   and **Google Calendar API** for the project.
6. **Required scopes** (requested automatically at authorize time):
   - Gmail: `https://www.googleapis.com/auth/gmail.readonly`,
     `https://www.googleapis.com/auth/gmail.send`
   - Calendar: `https://www.googleapis.com/auth/calendar.readonly`,
     `https://www.googleapis.com/auth/calendar.events`

Then follow the *Configuring via the API* steps above: store the client ID +
redirect URI in `config`, the client ID + **client secret** in `secrets`,
open the authorize URL, approve at Google, and the callback stores the
tokens. `POST /connectors/gmail/test` should return
`Gmail authorized as <address>`.

## Server integration (already prepared for the coordinator)

`src/server/routes/connectors.mjs` is **not** mounted yet — `server.mjs`
integration is intentionally left to the coordinator:

- Add the `stmts.connectors` entries (see the track report for the
  copy-paste block).
- `import connectorsRoutes from './routes/connectors.mjs'` and
  `app.use('/api', connectorsRoutes(ctx));`
- Migration `023_connectors.sql` runs through the existing migrator.

## Files

- `src/server/connectors/registry.mjs` — registry, invocation, redaction
- `src/server/connectors/github.mjs` — GitHub connector (PAT)
- `src/server/connectors/google-oauth.mjs` — shared OAuth2 helpers
- `src/server/connectors/gmail.mjs` — Gmail connector
- `src/server/connectors/calendar.mjs` — Google Calendar connector
- `src/server/routes/connectors.mjs` — admin routes + agent tool wiring
- `src/server/migrations/023_connectors.sql` — `connectors` table
- `tests/connectors.test.mjs` — vitest suite (CI)
