# Cardinal Frame Architecture

## Overview
AI agent orchestration platform with neural map, task automation, skill sandbox, and real-time dashboard.

## Stack
- **Server:** Node.js + Express, single `server.mjs` entry point
- **Database:** SQLite with WAL mode, 50 tables, better-sqlite3 (synchronous)
- **Client:** Vite + React + Tailwind, code-split with lazy loading
- **Bundle:** 810KB total, 51.8KB entry, code-split with lazy loading

## Shared Types
- `src/shared/schemas.mjs` — Zod schemas for all API contract shapes (Node, Link, Agent, Task, DAG, Skill, LlmProvider, TokenUsage, User, etc.)
- Single source of truth — server validates outbound responses, client imports for runtime validation
- API boundary validation catches field drift without compile-time coupling

## Server Architecture
```
src/
├── shared/
│   └── schemas.mjs     # Zod schemas — single source of truth for API types
├── server/
│   ├── server.mjs      # Lean bootstrap — Express app, DB init, route mounts
│   ├── migrator.mjs    # Lightweight SQL migration runner
│   ├── migrations/     # Versioned .sql files (001–004)
│   ├── chains.mjs      # Skill/tool chain execution engine
│   ├── evolution.mjs   # Auto-skill authoring, chain promotion, 15-pattern scanner
│   ├── heartbeat.mjs   # Heartbeat daemon with vm sandbox condition eval
│   ├── plugins.mjs     # Plugin loader
│   ├── validate.mjs    # Zod input validation middleware
│   └── routes/         # 26 route modules (one per domain)
│       ├── _ctx.mjs    # Shared ctx deps proxy
│       ├── auth.mjs    # Login, register, JWT
│       ├── dashboard.mjs   # Telemetry, summary, usage, cost-series
│       ├── graph.mjs   # Neural map graph data (validates via shared schemas)
│       ├── tasks.mjs   # Tasks, agents, DAGs
│       ├── agent.mjs   # Agent loop, sessions, actions
│       ├── comms.mjs   # Telegram/Discord channels, dispatch, webhooks
│       └── ...         # skills, chains, evolution, llm, memory, etc.
└── cli/
    └── cardinal.mjs    # CLI tool
```

## Client Architecture
```
client/src/
├── App.jsx             # Root — lazy-loads all pages
├── AimiCanvas.jsx      # Canvas2D animated mascot (8 layers, 6 expressions)
├── NeuralMap.jsx       # Force-graph + clustering + pathfinding + export
├── DAGEditor.jsx       # DAG builder with mini-map + node inspector
├── Dashboard.jsx        # Sparklines, heatmaps, cost tracking, live feeds
├── Chains.jsx          # Skill/tool chain builder UI
└── ...                 # Settings, SkillsTools, Plugins, etc.
```

## API Surface
| Route Group | Auth | Rate Limit | Description |
|---|---|---|---|
| `/api/auth/*` | Public/required | 20/min | Login, register, token refresh |
| `/api/health` | Public | None | Health check |
| `/api/graph/*` | optionalAuth | 100/min | Neural map graph data |
| `/api/sandbox/execute` | admin | 100/min | Sandboxed code execution |
| `/api/chains/*` | required | 100/min | Skill/tool chain CRUD + execution |
| `/api/evolution/*` | admin | 100/min | Skill evolution, chain promotion |
| `/api/heartbeat/*` | required/admin | 100/min | Heartbeat rules, daemon state |
| `/api/skills/hub/*` | required/admin | 100/min | Skill hub sources, scan, install |
| `/api/dags/*` | required | 100/min | DAG CRUD + execution |
| `/api/chat/*` | required | 100/min | Chat completions, conversations |

## Security Model
- **Auth:** JWT (24h expiry), bcrypt password hashing
- **RBAC:** `admin` and `user` roles, `requireRole('admin')` middleware
- **Rate Limiting:** Auth 20/min, API 100/min (express-rate-limit)
- **Input Validation:** Zod schemas on all POST/PUT routes (`validateBody`)
- **Security Headers:** X-Frame-Options, X-Content-Type-Options, Referrer-Policy
- **Sandbox:** isolated process execution with 5s timeout, 100KB maxBuffer
- **Skill Hub Scanner:** 15 dangerous patterns (eval, prototype pollution, etc.)
- **SSRF Protection:** blocks AWS metadata, localhost, RFC1918 on hub sources
- **Heartbeat:** vm sandbox for condition eval (no `new Function()`)

## Database
- **50 tables** in SQLite with WAL mode
- **Migration system:** versioned SQL files in `src/server/migrations/`
- **Tracked in** `_migrations` table (id, applied_at)
- **Idempotent:** all CREATE TABLE use IF NOT EXISTS, ALTER TABLE wrapped in try/catch

## Deployment
- **Docker:** 3-stage build (client → server deps → clean runtime)
- **Runtime:** dumb-init for signal handling, non-root user
- **Port:** API fixed to 8080 (override via PORT env), client dev fixed to 5173 (strictPort)
- **Data:** `/app/data` volume for SQLite + uploads
- **Resource limits:** 512MB memory, 1.0 CPU (recommended)
