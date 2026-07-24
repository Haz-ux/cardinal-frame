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

---

## In Progress

### Phase 2 — Missing infrastructure

- [ ] 2.1 LLM provider integration — confirm direct-call vs orchestrate-only, add adapter if needed
- [ ] 2.2 Durable job queue — task/DAG execution survives restarts, retry + dead-letter
- [ ] 2.3 Observability — trace IDs threading through agent runs and DAG steps
- [ ] 2.4 Secrets management — pre-commit hook blocking key patterns
- [ ] 2.5 LLM cost/token accounting — usage table + dashboard cost-per-agent/per-day

### Phase 3 — Governance layer

- [ ] 3.1 Machine-readable agent identity docs (scope, exit conditions, escalation rules)
- [ ] 3.2 Enforcement points in DAG/chain executor
- [ ] 3.3 Audit trail via Phase 2.3 tracing

---

## Principles
- No shortcuts — every change is production-grade with tests
- One canonical tree — `client/src/` for frontend, `src/server/` for backend
- Schema-first — shared zod schemas are the source of truth for API contracts
- Single-node deployment — avoid Redis/Kafka unless the operational cost is justified
- Cyberpunk/neon UI — cyan/magenta/purple glow on dark background, no bloat
