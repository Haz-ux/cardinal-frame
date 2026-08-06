# Cardinal Frame

**Governance-gated execution, multi-node-native delegation, and live visual system state** — a personal-scale AI agent orchestration platform built for the Seraphim Protocol (three-node system: IKARIS / ARIES / Cardinal Frame control plane).

**What makes it different:**

1. **Governance-gated execution** — rules are enforced *before* a step runs, not just logged after. Persona SOUL docs define `node_permissions` that control which agents can delegate to which nodes. The deny floor blocks skill self-edits from touching governance, auth, or identity files — hardcoded, non-configurable, applies even with admin approval.

2. **Multi-node-native** — delegation and node awareness are core architecture, not a plugin. Each node self-generates an Ed25519 identity (sha256 of public key = node_id). Signed heartbeats verify liveness. Delegation payloads are signed and signature-verified on receipt. Self-owned local recovery: each node runs its own durable job queue — if it crashes mid-task, it resumes on restart without the coordinator telling it to.

3. **Visual system state** — the neural map (react-force-graph-2d) shows the live shape of what's running. Nodes pulse with activity, edges highlight on data flow. It shows meaningful file/connection relationships, not exhaustive data lists.

Built with Express + SQLite (WAL) monolith backend, Vite + React 19 SPA frontend with cyberpunk/neon dark UI. **635 tests across 41 files.**

## Features

- **DAG executor** — user-authored multi-step workflows with parallel layers, cycle detection, durable job queue (retry/backoff/dead-letter, resume-on-restart)
- **Chain executor** — linear skill/tool pipelines with per-step governance gating and `$prev.output` input wiring
- **Skills registry** — 40+ sandboxed skills (script / template / hybrid), trigger matching, failure-rate tracking, LLM self-improvement proposals, skill hub
- **Plugin system** — 8 lifecycle hooks, hot-reload, plugin market with static risk scanning and WARDEN approval gate
- **15 LLM providers** — OpenAI, Google, NVIDIA NIM, Anthropic, OpenRouter, Groq, Together AI, DeepSeek, Mistral, Cerebras, SambaNova, Perplexity, xAI, Cohere, Ollama (raw `fetch`, no vendor SDKs)
- **RBAC / JWT auth** — bcrypt password hashing, `admin` / `user` / `viewer` roles, per-route `requireRole`
- **Governance layer** — personas, permissions, SOUL docs, audit log
- **Neural Map** — force-directed graph showing file/connection relationships
- **Durable job queue** — SQLite-backed with retry/backoff and resume-on-restart
- **Cost tracking** — per-token accounting with budget alerts
- **Observability** — request tracing with trace IDs and structured logs
- **Memory + session search** — FTS5 full-text search with optional LLM-powered summaries (`?summary=true`)
- **Embedding engine** — MiniLM on-demand load/unload for semantic search
- **Secrets management** — AES-256-GCM encryption at rest (see [Security & Audit](#security--audit))
- **CI/CD** — GitHub Actions (tests on Node 20/22, gitleaks secret scan, history check)

## Architecture

The orchestration layer is a small set of engines that all run inside the Express
monolith and share one SQLite (WAL) database. Every request enters through the HTTP
layer, is authenticated by JWT middleware, and — depending on the route — is gated by
`requireRole` and validated by Zod before reaching an engine.

```
                        ┌──────────────────────────────────────────────┐
   HTTP (Express :8080) │  routes/ (33 modules) · rate-limited          │
   ───────────────────► │  Zod validation · trace IDs                   │
                        └───────┬──────────────────┬───────────────────┘
                          auth  │ JWT              │ requireRole('admin')
                       ┌────────▼────────┐   ┌─────▼──────────────────────┐
                       │  DAG engine     │   │  Chain engine              │
                       │  topoSortLayers │   │  executeSkillChain /       │
                       │  Kahn's algo →  │   │  executeToolChain          │
                       │  parallel layers│   │  per-step governance gate  │
                       │  └─ job queue   │   │  (checkPermission)         │
                       │     (durable)   │   └─────┬──────────────────────┘
                       └───────┬─────────┘         │
                               │                   │
                    ┌──────────▼───────────────────▼───────────┐
                    │           Skills sandbox (VM)            │
                    │  exec allow/blocklist · Docker backend   │
                    └──────────┬──────────────────┬────────────┘
                               │                  │
                    ┌──────────▼───┐   ┌──────────▼────────────┐
                    │ Agent loop   │   │ Plugin system         │
                    │ sessions,    │   │ fireHook() →          │
                    │ approve/     │   │ onTaskCompleted,      │
                    │ reject, tools│   │ onSkillExecuted, …    │
                    └──────────┬───┘   └──────────┬────────────┘
                               └────────┬─────────┘
                                        │
                    ┌───────────────────▼─────────────────────────┐
                    │  SQLite (WAL): governance audit_log ·       │
                    │  skill_invocations · jobs/job_steps ·       │
                    │  memories · sessions · nodes · plugins      │
                    └─────────────────────────────────────────────┘
```

Key facts:

- **DAGs and chains are distinct.** DAGs are general directed graphs of command nodes run in topologically-sorted parallel layers through the durable job queue. Chains are linear pipelines of skills/tools where each step's output feeds the next, and **every step passes a governance `checkPermission` gate before it runs**.
- **Governance is at the orchestration layer**, not in the sandbox. Persona SOUL docs, `node_permissions`, and the hardcoded deny floor are consulted before delegation and chain steps execute.
- **Everything is observable.** Every engine emits to the audit log, fires plugin hooks, and writes trace-correlated rows (`skill_invocations`, `job_steps`).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full deep-dive, and
[`docs/adr/`](./docs/adr/) (18 ADRs) for the decision history.

## Security & Audit

Cardinal Frame runs a documented security audit of its own codebase in
**[`AUDIT_AND_PLAN.md`](./AUDIT_AND_PLAN.md)** — findings, remediation, and verification.

Highlights:

- **Secrets at rest** — LLM provider API keys and stored env vars are AES-256-GCM
  encrypted (`ENCRYPT_SECRET` → SHA-256 key, `iv:tag:enc`), decrypted only at runtime
  chokepoints. Legacy XOR rows decrypt transparently. A previous plaintext-at-rest
  issue and an `ENCRYPT_SECRET` load-order bug are fixed and covered by the audit.
- **Auth** — JWT (24h, `JWT_SECRET`), bcrypt (cost 10). Roles: `admin`, `user`, `viewer`.
  `requireRole(...)` middleware on admin routes. Auth endpoints rate-limited 20/min.
- **No hardcoded keys** — CI runs gitleaks with full history scan; a pre-commit hook
  scans staged files (see [ADR-006](./docs/adr/0006-hardcoded-api-key-in-git-history.md)).

### Auth & RBAC endpoints

All under `/api/auth`, all public routes rate-limited (20/min):

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/register` | public | Register a user (role `user`), returns JWT |
| `POST` | `/api/auth/login` | public | Login, returns JWT + user |
| `GET` | `/api/auth/me` | JWT | Current user profile |
| `POST` | `/api/auth/reset-request` | public | Request password reset (token printed to server console) |
| `POST` | `/api/auth/reset-confirm` | public | Confirm reset, returns fresh JWT |
| `GET` | `/api/users` | admin | List all users |
| `PATCH` | `/api/users/:id/role` | admin | Change a user's role (`admin`/`user`/`viewer`) |
| `GET` | `/api/profile` | JWT | Current profile (same as `/me`) |
| `PATCH` | `/api/profile/:key` | JWT | Update an own profile field |

```bash
curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"Haz","password":"cardinal"}'
# => { "token": "<jwt>", "user": { "id": "haz-001", "username": "Haz", "role": "admin" } }

curl -s http://localhost:8080/api/users \
  -H "Authorization: Bearer <jwt>"          # admin only → 403 for role "user"
```

## Project Structure

```
cardinal-frame/
├─ client/                   # Vite + React 19 SPA (35 page/component files)
│  ├─ src/
│  │  ├─ App.jsx             # Root — lazy-loads all pages
│  │  ├─ DAGEditor.jsx       # Visual DAG builder (11 node types)
│  │  ├─ NeuralMap.jsx       # Force-graph relationship map
│  │  ├─ Chains.jsx          # Skill/tool chain builder
│  │  ├─ SkillsTools.jsx     # Skills registry + tool manager
│  │  ├─ Plugins.jsx         # Plugin lifecycle UI
│  │  ├─ AuditLog.jsx        # Governance audit viewer
│  │  ├─ Chat.jsx, Dashboard.jsx, Settings.jsx, …
│  │  └─ dist/               # Production build (served by Express)
│  └─ vite.config.mjs
├─ src/                      # Server (Node ESM)
│  ├─ server/
│  │  ├─ server.mjs          # Express bootstrap — DB init, migrations, middleware, mounts
│  │  ├─ preload-env.mjs     # Loads .env before route modules (ENCRYPT_SECRET ordering)
│  │  ├─ chains.mjs          # Chain execution engine (skill + tool)
│  │  ├─ job-queue.mjs       # Durable SQLite job queue (retry/backoff/dead-letter)
│  │  ├─ plugins.mjs         # Plugin loader (8 lifecycle hooks, hot-reload)
│  │  ├─ skill-safety.mjs    # Deny-floor for skill self-edits (non-configurable)
│  │  ├─ warden.mjs          # Approval gate for risky operations
│  │  ├─ evolution.mjs       # Skill auto-authoring, chain promotion, 15-pattern scanner
│  │  ├─ node-identity.mjs   # Ed25519 node identities + signed heartbeats
│  │  ├─ node-registry.mjs   # Multi-node registry
│  │  ├─ learn.mjs / learning-loop.mjs   # Aimi self-learning
│  │  ├─ mcp-client.mjs / safe-fetch.mjs / validate.mjs / migrator.mjs
│  │  ├─ migrations/         # 010 versioned .sql files
│  │  ├─ routes/             # 33 route modules (one per domain)
│  │  │  ├─ auth.mjs         # Register/login/me/reset + JWT
│  │  │  ├─ tasks.mjs        # DAGs, tasks, agents, files
│  │  │  ├─ skills.mjs       # Skills registry + execution + proposals
│  │  │  ├─ chains.mjs       # Chain CRUD + execute + AI generate
│  │  │  ├─ meta.mjs         # Plugins, audit, MCP, groups, batches, schedules
│  │  │  ├─ plugin-market.mjs # Plugin marketplace (sources, scan, install)
│  │  │  ├─ skill-hub.mjs    # Skill hub marketplace
│  │  │  ├─ governance.mjs   # Personas, permissions, checkPermission, audit
│  │  │  ├─ agent.mjs        # Agent loop, sessions, approve/reject
│  │  │  ├─ llm.mjs / llm-helpers.mjs # Providers, models, detect
│  │  │  ├─ sandbox.mjs      # VM sandbox for skill handlers
│  │  │  └─ … (33 total)
│  │  └─ llm/
│  │     └─ provider-runtime.mjs  # Unified 15-provider chat/stream runtime
│  ├─ shared/
│  │  └─ schemas.mjs         # Shared Zod schemas (API contract)
│  └─ cli/
│     └─ cardinal.mjs        # CLI tool
├─ plugins/                  # Bundled plugins (manifest.json + index.mjs)
│  ├─ hello-world/           # Hook-wiring demo (onTaskCompleted/Failed)
│  └─ sentinel/              # Agent safety monitor (rate limits, dangerous shell, scope)
├─ tests/                    # 41 Vitest test files (635 tests)
├─ e2e/                      # Playwright end-to-end specs
├─ docs/
│  └─ adr/                   # 18 Architecture Decision Records
├─ scripts/                  # setup-hooks, cleanup, verify helpers
├─ .github/workflows/ci.yml  # Tests (Node 20/22) + gitleaks + history check
├─ .githooks/                # Pre-commit secret-scan hook
├─ Dockerfile                # 3-stage build · docker-compose.yml
├─ ARCHITECTURE.md           # Deep-dive architecture doc
└─ AUDIT_AND_PLAN.md         # Security audit & remediation plan
```

## Getting Started

```bash
# Install dependencies
npm install

# Configure secrets (required for production)
cp .env.example .env
#  - JWT_SECRET:   openssl rand -base64 48
#  - ENCRYPT_SECRET: openssl rand -base64 48
# The server refuses to boot with the default JWT_SECRET in production.

# Start the server (port 8080 by default)
npm run dev:server

# Start the client (hot reload)
npm run dev:client

# Or run both together
npm run dev
```

The dashboard is available at `http://localhost:5173` (Vite dev server proxies API to `:8080`). Ports are fixed: client on 5173, API on 8080 (override the API with the `PORT` env var).

## Core Subsystems

### DAG executor

DAGs are directed graphs of command nodes. Execution topologically sorts them into
**parallel layers** (Kahn's algorithm, cycle detection → `400`), then runs each layer's
nodes concurrently. In production each run is enqueued on the **durable job queue**
(`type: 'dag'`, priority 5) — jobs retry with exponential backoff (`1s, 2s, 4s, 8s…`,
capped 30s), exhaust into a dead-letter queue, and **resume on restart**
(`recoverStale` flips interrupted `running` jobs back to `pending`).

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/dags` | JWT | Create a DAG (`{ name, nodes, edges }`) |
| `GET` | `/api/dags` | optional | List all DAGs |
| `GET` | `/api/dags/:id` | optional | Get one DAG + last run result |
| `PUT` | `/api/dags/:id` | JWT | Update name/nodes/edges |
| `DELETE` | `/api/dags/:id` | JWT | Delete a DAG |
| `POST` | `/api/dags/:id/run` | JWT | Execute — parallel layers via durable queue |

Editor node types: `trigger`, `task`, `condition`, `parallel`, `output`, `delay`,
`webhook`, `transform`, `branch`, `loop`, `notify`. Any node with a `command` runs as a
shell command (`/bin/sh`, 30s timeout, `sanitizeCommand` gate); nodes without one are
recorded as `skipped`.

```bash
# Create a 2-node sequential DAG
curl -s -X POST http://localhost:8080/api/dags \
  -H "Authorization: Bearer <jwt>" -H 'Content-Type: application/json' \
  -d '{
    "name": "Echo Pipeline",
    "nodes": [
      { "id": "n1", "name": "Echo Step", "command": "echo hello" },
      { "id": "n2", "name": "Echo Step 2", "command": "echo world" }
    ],
    "edges": [ { "source": "n1", "target": "n2" } ]
  }'
# => 201 { "id": "<uuid>", "name": "Echo Pipeline", "status": "draft", … }

# Execute it
curl -s -X POST http://localhost:8080/api/dags/<id>/run -H "Authorization: Bearer <jwt>"
# => { "dagId": "<uuid>", "jobId": "<uuid>", "status": "running", "layers": 2, "totalNodes": 2 }

# A cyclic DAG is rejected at run time
# => 400 { "error": "Cycle detected in DAG" }
```

### Chain executor

Chains are **linear pipelines** — each step's output feeds the next via `input_mapping`
(`$input`, `$prev.output`, `$step[N].output`). Unlike DAGs, chains are
**governance-gated per step**: `checkPermission(persona, action, step)` runs before
each step; on denial the step is recorded with `governance_denied: true` and an audit
log entry, and the chain halts unless `continue_on_error` is set.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/chains/skills` · `/api/chains/tools` | JWT | List chains |
| `POST` | `/api/chains/skills` · `/api/chains/tools` | JWT | Create a chain |
| `GET`/`PUT`/`DELETE` | `/api/chains/skills/:id` · `/api/chains/tools/:id` | JWT | Manage one chain |
| `POST` | `/api/chains/skills/:id/execute` · `/api/chains/tools/:id/execute` | JWT | Execute a chain |
| `POST` | `/api/chains/skills/generate` · `/api/chains/tools/generate` | JWT | Aimi generates a chain from a prompt |

```json
{
  "name": "research-and-summarize",
  "description": "Research a topic and summarize the findings",
  "steps": [
    { "skill_name": "web-research",   "name": "Research",  "input_mapping": { "query": "$input" } },
    { "skill_name": "paper-summarize","name": "Summarize", "input_mapping": { "text": "$prev.output" } }
  ]
}
```

### Skills registry

A **skill** is an executable capability: a JS handler string `async (input) => {...}`
plus metadata (`description`, `category`, `parameters`, `trigger`, `confidence`).
Three types, distinguished by handler prefix:

| Type | Prefix | Runs as |
|---|---|---|
| Script | `(input) =>` | Pure JS in the VM sandbox |
| Template | `template:` | LLM system prompt; invoked via `callAgentLLM` |
| Hybrid | `hybrid:` | Raw JS with `llmCall()`, `execSync`, `fetch` |

40 skills are seeded (`POST /api/skills/seed`). Execution is **sandboxed**: a
restricted `vm` context (no `process`/`require`/outer scope, `codeGeneration` disabled),
an `exec` allow/blocklist, capped `setTimeout`, and an optional Docker backend
(`--network none --read-only`, graceful fallback to local VM). Every invocation is
logged to `skill_invocations` with a trace ID, updates success/failure counts and
confidence, fires the `onSkillExecuted` plugin hook, and feeds the learning loop.
The skill hub adds a marketplace with SSRF-protected sources and a
15-pattern dangerous-code scanner (`evolution.mjs`) gating installs.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/skills` · `/api/skills/enabled` · `/api/skills/:id` | optional | List / get skills |
| `POST` | `/api/skills` | admin | Register a skill |
| `PUT`/`DELETE` | `/api/skills/:id` | admin | Update / delete a skill |
| `POST` | `/api/skills/:id/execute` · `/api/skills/execute/:name` | JWT | Execute a skill |
| `GET` | `/api/skills/stats/invocations` · `/api/skills/stats/failure-rates` | JWT | Invocation + failure-rate stats |
| `GET` | `/api/skills/invocations/recent` · `/api/skills/:id/invocations` | JWT | Invocation history |
| `GET` | `/api/skills/match/:input` | JWT | Trigger matching |
| `GET/POST/DELETE` | `/api/skills/hub/sources*` | auth/admin | Skill hub sources |
| `POST` | `/api/skills/hub/search` · `/install` · `/publish` | auth/admin | Skill hub search/install/publish |

```bash
# Execute a skill by name (fact-check is a seeded hybrid skill using Tavily + LLM)
curl -s -X POST http://localhost:8080/api/skills/execute/fact-check \
  -H "Authorization: Bearer <jwt>" -H 'Content-Type: application/json' \
  -d '{"input": "The Earth is flat"}'
# => { "skill_id": "<uuid>", "name": "fact-check", "ok": true, "type": "hybrid",
#      "output": { "claim": "The Earth is flat",
#                  "verdict": "FALSE — scientific consensus and direct observation contradict this claim",
#                  "sources": ["https://en.wikipedia.org/wiki/Spherical_Earth"] },
#      "duration_ms": 1843, "confidence": 0.61 }
```

### Plugin system

Plugins are directories under `plugins/` with a `manifest.json` and an `index.mjs`
entry that exports lifecycle hook functions. The loader (`plugins.mjs`) discovers,
imports, hot-reloads (`?t=timestamp` cache-busting), and fires hooks to every enabled
plugin; errors are isolated per plugin.

**Lifecycle hooks** (each `async (data, config) => {}`):

| Hook | Fired on |
|---|---|
| `onTaskCompleted` | `{ taskId, command, result, exitCode }` |
| `onTaskFailed` | `{ taskId, command, stderr, exitCode }` |
| `onChatMessage` | `{ conversationId, role, content, model, provider }` |
| `onAgentStep` | `{ sessionId, step, toolName, result, success }` |
| `onSkillExecuted` | `{ skillId, skillName, input, output, success, durationMs }` |
| `onServerStart` | `{ port, version }` |
| `onServerStop` | `{ signal, port }` |
| `onCommsMessage` | `{ channelId, platform, direction, message }` |

```json
{
  "name": "hello-world",
  "version": "1.0.0",
  "description": "Demo plugin that logs task completions",
  "hooks": ["onTaskCompleted", "onTaskFailed"]
}
```

```js
export async function onTaskCompleted(data, config) {
  console.log(`[hello-world] Task ${data.taskId} → exit ${data.exitCode}`);
}
```

The plugin market (sources, scan, install) is SSRF-protected (`isInternalUrl` blocks
metadata/localhost/RFC1918), caps source code at 2 MB, runs a static risk scan
(shell / eval / network / fs / env → `safe` / `caution` / `elevated`), and routes
`elevated` installs through the **WARDEN approval gate**. Bundled plugins:
`hello-world` (hook demo) and `sentinel` (agent safety monitor: 30s tool-call rate
limiting with auto-stop, dangerous-shell blocklist, scope checks, protected-branch
guard).

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/plugins` | optional | List installed plugins + loaded state |
| `POST` | `/api/plugins` | admin | Register a plugin manually |
| `PATCH` | `/api/plugins/:id/toggle` | admin | Enable/disable (syncs in-memory loader) |
| `POST` | `/api/plugins/:id/reload` | admin | Hot-reload one plugin |
| `POST` | `/api/plugins/reload-all` | admin | Reload all plugins |
| `DELETE` | `/api/plugins/:id` | admin | Unload + delete |
| `GET/POST/DELETE` | `/api/plugins/market/sources*` | auth/admin | Marketplace sources |
| `POST` | `/api/plugins/market/search` · `/install` · `/install-url` | auth/admin | Marketplace search/install |

## Backend API — More

### Memory & Search

| Endpoint | Method | Description |
|---|---|---|
| `/api/memory` | GET/POST | List / store memories (`?category=`, `?q=`, `?summary=true`) |
| `/api/memory/:id` | GET/PATCH/DELETE | Get / update / delete a memory |
| `/api/memory/stats` | GET | Memory counts by category |
| `/api/search` | GET | FTS5 search across sessions (`?q=`, `?summary=true`) |
| `/api/search/index` | POST | Manually index a session for search |
| `/api/embeddings/*` | GET/POST | Embedding model status, load/unload, generate, vector search |

`?summary=true` triggers `callAgentLLM` to generate 2–3 sentence summaries. If no LLM
provider is configured, it degrades gracefully.

### Governance

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/governance/personas` | GET/POST | auth/admin | Persona CRUD (SOUL docs, `node_permissions`) |
| `/api/governance/personas/:id` | GET/PUT/DELETE | auth/admin | Persona operations |
| `/api/governance/check` | POST | auth | Check an action against permissions |
| `/api/governance/audit` · `/api/audit` | GET | admin | Audit log |
| `/api/audit/actor/:actor` · `/api/audit/trace/:traceId` | GET | admin | Audit by actor / trace |

### Jobs

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/jobs/stats` | GET | auth | Queue status |
| `/api/jobs/:id` | GET | auth | Get a job |
| `/api/jobs/dead` | GET | auth | Dead-letter queue |
| `/api/jobs/:id/retry` | POST | admin | Retry a dead job |

## Testing

```bash
npm test          # Run full suite (Vitest) — 635 tests, 41 files
npx vitest run tests/dags.test.mjs        # Single file
npx vitest run tests/dags.test.mjs tests/skills.test.mjs   # Multiple files
```

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
1. **Tests** on Node 20 + 22 (`NODE_ENV=test`)
2. **Gitleaks secret scan** (full commit history)
3. **History check** on PRs (catches secrets before merge)

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — deep dive: orchestration, API surface, security model, database
- [`AUDIT_AND_PLAN.md`](./AUDIT_AND_PLAN.md) — security audit & remediation plan
- [`docs/adr/`](./docs/adr/) — 18 Architecture Decision Records
- [`ROADMAP.md`](./ROADMAP.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## License

MIT © 2026 Cardinal Frame Contributors
