# Cardinal Frame — Roadmap

## Completed

### Phase 0 — Stop the bleeding (Jul 2026)
- [x] Neural Map node pile-up fix (`warmupTicks={0}` + x/y seeding)
- [x] API key test 401 fix (provider-aware routing in settings.mjs)
- [x] Server latency optimization (async telemetry, SSE compression filter, agent loop query reduction)
- [x] Repo hygiene sweep (delete dead configs, artifacts, `.bak` files)

### Phase 1 — Structural debt (Jul 2026)
- [x] 1.1 Collapse dual frontend — keep `client/` as canonical, delete dead `src/*.tsx` tree + `server.ts`
- [x] 1.2 Server split — 26 route modules, server.mjs down from 7,217 to 1,694 lines
- [x] 1.3 Shared types — zod schemas in `src/shared/schemas.mjs`, API boundary validation on `/api/graph`
- [x] 1.4 Doc consolidation — ARCHITECTURE.md updated, ADRs in `docs/adr/`

### Phase 2 — Missing infrastructure (Jul 2026)
- [x] 2.1 LLM provider integration — NVIDIA NIM (z-ai/glm-5.2) via OpenAI-compatible adapter
- [x] 2.2 Durable job queue — SQLite-backed task/DAG execution, retry + dead-letter (`job-queue.mjs`)
- [x] 2.3 Observability — trace IDs, per-request timing, structured logs (`traces.mjs`)
- [x] 2.4 Secrets management — AES-256-GCM encryption with XOR backward-compat (`settings.mjs`)
- [x] 2.5 LLM cost/token accounting — usage table + pricing table + budget alerts (`costs.mjs`)

### Phase 3 — Governance layer (Jul 2026)
- [x] 3.1 Persona system, permissions, SOUL docs, audit log (`governance.mjs`)
- [x] 3.2 Enforcement points in DAG/chain executor (`chains.mjs` governance param)
- [x] 3.3 Audit trail integration with trace system (trace_id column + query)

### Phase 4 — Post-roadmap features (Jul 2026)
- [x] 4.1 P2 memory summarization — `?summary=true` on memory/search routes (`memory.mjs`)
- [x] 4.2 Job catalog — reusable task templates + AI-suggested patterns from history (`job-catalog.mjs`)
- [x] 4.3 Live activity feed — real-time event overlay on Neural Map (`activity.mjs` + `ActivityOverlay.jsx`)
- [x] 4.4 Cross-node subagent delegation — `delegate_task` agent tool + `/api/delegate` REST API (`delegation.mjs`)

---

## Principles
- No shortcuts — every change is production-grade with tests
- One canonical tree — `client/src/` for frontend, `src/server/` for backend
- Schema-first — shared zod schemas are the source of truth for API contracts
- Single-node deployment — avoid Redis/Kafka unless the operational cost is justified
- Cyberpunk/neon UI — cyan/magenta/purple glow on dark background, no bloat
