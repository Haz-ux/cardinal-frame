# Cardinal Frame

**Governance-gated execution, multi-node-native delegation, and live visual system state** — a personal-scale AI agent orchestration platform built for the Seraphim Protocol (three-node system: IKARIS / ARIES / Cardinal Frame control plane).

**What makes it different:**

1. **Governance-gated execution** — rules are enforced *before* a step runs, not just logged after. Persona SOUL docs define `node_permissions` that control which agents can delegate to which nodes. The deny floor blocks skill self-edits from touching governance, auth, or identity files — hardcoded, non-configurable, applies even with admin approval.

2. **Multi-node-native** — delegation and node awareness are core architecture, not a plugin. Each node self-generates an Ed25519 identity (sha256 of public key = node_id). Signed heartbeats verify liveness. Delegation payloads are signed and signature-verified on receipt. Self-owned local recovery: each node runs its own durable job queue — if it crashes mid-task, it resumes on restart without the coordinator telling it to.

3. **Visual system state** — the neural map (react-force-graph-2d) shows the live shape of what's running. Nodes pulse with activity, edges highlight on data flow. It shows meaningful file/connection relationships, not exhaustive data lists.

Built with Express + SQLite (WAL) monolith backend, Vite + React 19 SPA frontend with cyberpunk/neon dark UI. 486 tests across 31 files.

## Features

- **15 LLM providers** — OpenAI, Google, NVIDIA NIM, Anthropic, OpenRouter, Groq, Together AI, DeepSeek, Mistral, Cerebras, SambaNova, Perplexity, xAI, Cohere, Ollama (raw `fetch`, no vendor SDKs)
- **Neural Map** — force-directed graph (react-force-graph-2d) showing file/connection relationships, not exhaustive data lists
- **Skills system** — sandboxed, with per-invocation outcome logging, trace correlation, and failure-rate tracking
- **DAG / Chain executor** — user-authored multi-step agent workflows with governance enforcement
- **Governance layer** — personas, permissions, SOUL docs, audit log
- **Durable job queue** — SQLite-backed with retry/backoff and resume-on-restart
- **Cost tracking** — per-token accounting with budget alerts
- **Observability** — request tracing with trace IDs and structured logs
- **Memory + session search** — FTS5 full-text search across memories and sessions, with optional LLM-powered summaries (`?summary=true`)
- **Embedding engine** — MiniLM on-demand load/unload for semantic search
- **Secrets management** — AES-256-GCM encryption with XOR backward-compat
- **CI/CD** — GitHub Actions (tests on Node 20/22, gitleaks secret scan, history check)

## Project Structure

```
cardinal-frame/
├─ client/                  # Vite + React + Tailwind frontend
│  └─ src/
├─ src/
│  ├─ server/
│  │  ├─ server.mjs         # Express server entry (~1,630 lines)
│  │  ├─ routes/            # 26 modular route files
│  │  ├─ plugins.mjs        # Plugin loader (8 lifecycle hooks)
│  │  └─ ...
│  └─ shared/
│     └─ schemas.mjs        # Shared zod schemas
├─ tests/                   # Vitest test suite (31 files, 486+ tests)
├─ docs/adr/                 # Architecture Decision Records (13 ADRs)
├─ .github/workflows/ci.yml # CI pipeline
├─ Dockerfile               # 3-stage multi-stage build
└─ docker-compose.yml
```

## Getting Started

```bash
# Install dependencies
npm install

# Start the server (port 8080 by default)
npm run dev:server

# Start the client (hot reload)
npm run dev:client

# Or run both together
npm run dev
```

The dashboard is available at `http://localhost:5173` (Vite dev server proxies API to `:8080`). Ports are fixed: client on 5173, API on 8080 (override the API with the `PORT` env var).

## Build

```bash
# Build client for production
npm run build:client

# Production server
NODE_ENV=production npm start
```

## Backend API

### Memory & Search

| Endpoint | Method | Description |
|---|---|---|
| `/api/memory` | GET | List memories (filter by `?category=`, `?q=`, `?summary=true`) |
| `/api/memory/:id` | GET | Get a memory (`?summary=true` for LLM summary) |
| `/api/memory` | POST | Store a memory |
| `/api/memory/stats` | GET | Memory counts by category |
| `/api/search` | GET | FTS5 search across sessions (`?q=`, `?summary=true`) |
| `/api/search/index` | POST | Manually index a session for search |

The `?summary=true` query parameter triggers `callAgentLLM` to generate concise 2-3 sentence summaries of returned content. If no LLM provider is configured, it degrades gracefully (returns results without summaries).

## Testing

```bash
npm test          # Run full test suite (vitest)
npx vitest run tests/memory-search.test.mjs   # Single file
```

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
1. Tests on Node 20 + 22
2. Gitleaks secret scan (full commit history)
3. History check on PRs (catches secrets before merge)

## License

MIT © 2026 Cardinal Frame Contributors
