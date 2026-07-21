# Cardinal Frame Audit & Implementation Plan

## Audit Summary (2026-07-21)

### Server: 7,448 lines, 187 endpoints, PID 2929937, 100MB RSS, ~14ms responses

---

## 🔴 Critical (Security)

### C1. No Database Indexes (0 CREATE INDEX statements)
- 30 tables, 6+ FOREIGN KEY columns, **zero indexes**
- Every `WHERE provider_id = ?`, `WHERE conversation_id = ?`, `WHERE message_id = ?`, `WHERE skill_id = ?`, `WHERE session_id = ?` does a full table scan
- As data grows, queries degrade linearly. Chat messages table will be the worst offender.

### C2. CORS Wide Open (`app.use(cors())`)
- No origin restriction — any domain can hit the API
- Should whitelist `localhost:3000`, `127.0.0.1`, and the deployed origin

### C3. eval() / new Function() with execSync (4 occurrences)
- Lines 3776, 3792, 4461, 5647 — `new Function('execSync', 'fetch', ...)` and `eval(handler)`
- These run arbitrary code from the DB (skills, plugins, task handlers) with **shell access**
- If a compromised or untrusted skill is stored, it gets RCE on the server
- Should sandbox with a VM2/isolated worker, drop `execSync` from the callable surface, or at minimum clamp the timeout and restrict the PATH

### C4. No Response Compression
- 143KB CSS sent uncompressed, 300KB vendor-react chunk uncompressed
- On any non-localhost connection, this is painfully slow
- Add `compression` middleware (gzip/brotli) — ~70% size reduction

### C5. JWT Secret Fallback to Hardcoded String
- `JWT_SECRET = process.env.JWT_SECRET || 'cardinal-frame-dev-secret-change-me'`
- In production without env var, tokens are signed with a known secret — anyone can forge JWTs
- Should refuse to start in `NODE_ENV=production` without a proper secret

---

## 🟡 High (Performance)

### H1. Background Polling Never Pauses (no visibility API)
- 13 `setInterval` loops across components — ~78 req/min when all tabs active
- **None** check `document.hidden` or `visibilitychange`
- When user switches tabs, polling continues at full rate unnecessarily
- WorkPanel.jsx polls every 2s — extremely aggressive

### H2. Polling Instead of WebSocket for Real-Time Data
- WebSocket exists and works, but only ChatComponents and ResilienceComponents subscribe to it
- Tasks (8s), Agents (15s), NeuralMap (30s), Dashboard (15s) all poll instead of using WS
- Server already has `wss.broadcast()` — just need to emit events on data changes and subscribe in components

### H3. No Static Asset Cache Headers
- `express.static(clientDist)` serves files with no `max-age` or `immutable` header
- Browser re-fetches Vue/React vendor chunks on every page load
- Hashed filenames mean content never changes — should set `Cache-Control: public, max-age=31536000, immutable`

### H4. Morgan `combined` Format in All Environments
- Every request logged in Apache combined format — high I/O on the Jetson's eMMC
- Should skip in production, or use a lighter format (or only log errors)

### H5. No DB Connection Pooling / Prepared StatementReuse Patterns
- 301 `db.prepare()` calls — many inside route handlers (prepared per-request)
- better-sqlite3 handles this OK (it caches internally), but preparing in hot paths is wasteful
- Move all `.prepare()` calls to startup, reference via `stmts.*` object (partially done already)

---

## 🟢 Medium (Code Quality / Architecture)

### M1. 7,448-line Monolithic server.mjs
- 187 endpoints all in one file — hard to navigate, hard to maintain
- Split into route modules: `routes/auth.mjs`, `routes/chat.mjs`, `routes/graph.mjs`, `routes/agents.mjs`, etc.
- Or at minimum add section markers and a table of contents

### M2. eventListener Leaks (2 found)
- `ResilienceComponents.jsx:232` — `document.addEventListener('mousedown')` 
- `LLMProviders.jsx:93` — `document.addEventListener('click')`
- Neither removed on unmount → listeners accumulate on tab switches

### M3. WorkPanel 2-second Polling
- `setInterval(loadSession, 2000)` — most aggressive poller in the app
- Should use WebSocket or at least increase to 10s+

### M4. NeuralMap.jsx.bak Left in Source Tree
- Old backup file still being scanned by tools, confuses grep
- Delete it

### M5. No Input Validation Framework
- Only 6 references to "validate" in 7,448 lines
- No Joi, Zod, or schema validation on request bodies
- Relies on inline `if (!req.body.x)` checks scattered across handlers

### M6. Docker Image Doesn't Use Multi-stage for Runtime Layer
- Stage 2 installs `python3 make g++` (build tools) in production image — adds ~200MB
- Should use a separate build stage for better-sqlite3, copy the compiled `.node` binary to a slim runtime

---

## Implementation Plan

### Phase 1: Critical Security — Estimate: ~1hr

```
Task 1.1: Add database indexes
  - CREATE INDEX on all FK columns: provider_id, conversation_id, message_id, skill_id, session_id
  - CREATE INDEX on frequently filtered columns: status, role, enabled, cluster
  - CREATE INDEX on chat_messages(conversation_id, created_at) for message ordering
  - File: src/server/server.mjs (after schema creation, ~line 460)

Task 1.2: Lock down CORS
  - Replace app.use(cors()) with origin whitelist
  - Allow: localhost:3000, 127.0.0.1:3000, and process.env.CORS_ORIGIN
  - File: src/server/server.mjs line ~37

Task 1.3: Add compression middleware
  - npm install compression
  - app.use(compression()) before static serving
  - File: src/server/server.mjs, package.json

Task 1.4: Secure JWT fallback
  - If NODE_ENV=production && !process.env.JWT_SECRET → throw Error('JWT_SECRET required in production')
  - File: src/server/server.mjs line 31

Task 1.5: Add static asset cache headers
  - express.static(clientDist, { maxAge: '1y', immutable: true })
  - File: src/server/server.mjs line 7353
```

### Phase 2: Client Performance — Estimate: ~45min

```
Task 2.1: Add visibility-based polling pause
  - Create usePolling hook that checks document.hidden
  - Pause setInterval when tab hidden, resume on visibilitychange
  - Replace setInterval in: Tasks, Plugins, Settings, AgentGroups, Schedules, AimiLearn, DAGEditor, WorkPanel
  - New file: client/src/usePolling.js

Task 2.2: Fix eventListener leaks
  - LLMProviders.jsx: add cleanup in useEffect return
  - ResilienceComponents.jsx: same
  - Files: client/src/LLMProviders.jsx, client/src/ResilienceComponents.jsx

Task 2.3: Reduce WorkPanel polling to 10s (or use WS)
  - Change setInterval(loadSession, 2000) → 10000
  - File: client/src/WorkPanel.jsx line 36

Task 2.4: Delete NeuralMap.jsx.bak
  - rm client/src/NeuralMap.jsx.bak
```

### Phase 3: Server Cleanup — Estimate: ~30min

```
Task 3.1: Move remaining db.prepare() calls to startup
  - Find inline prepare() in route handlers
  - Move to stmts object initialized at startup
  - File: src/server/server.mjs (various)

Task 3.2: Lighten Morgan logging
  - Use 'tiny' format or skip in production
  - if (NODE_ENV !== 'production') app.use(morgan('tiny'))
  - File: src/server/server.mjs line 40

Task 3.3: Remove .bak file from client source
  - Already in Task 2.4
```

### Phase 4: Deferred (Larger Refactors)

```
Task 4.1: Route modularization — split server.mjs into route files
Task 4.2: Migrate polling components to WebSocket subscriptions
Task 4.3: Add Zod input validation
Task 4.4: Sandbox eval/new Function with vm2 or worker threads
Task 4.5: Docker multi-stage runtime (remove build tools from final image)
```

---

## Priority Order
1. **C1** DB indexes (biggest perf win, prevents future slowdown)
2. **C4** Compression (instant network speedup)
3. **C5** JWT secure fallback (security guard)
4. **H3** Static cache headers (instant repeat-load speedup)
5. **C2** CORS lockdown (security)
6. **H1** Visibility polling pause (reduces battery/CPU on client)
7. **H4** Morgan logging (reduces I/O on Jetson)
8. **H5** Prepared statement cleanup (minor perf)
9. **M2** Event listener leaks (prevents memory leaks)
10. **M3+M4** Cleanup (housekeeping)
