# ADR 0002: Shared type schemas via zod

Date: 2026-07-24
Status: Accepted

## Context

Cardinal Frame's frontend (`client/src/*.jsx`) and backend (`src/server/`) share no type definitions. API contract shapes (graph nodes/links, agents, tasks, DAGs) were duplicated by hand — frontend assumed the shape, server produced it, and drift was only discovered at runtime when something broke.

The "no shortcuts" standard requires that changing a field on one side breaks the other side explicitly, not silently.

## Decision

Create `src/shared/schemas.mjs` as the single source of truth for API contract shapes, using **zod** (already a dependency).

**Why zod over plain TypeScript interfaces:**
- The canonical frontend is `.jsx` (JavaScript), not `.tsx` — TS interfaces can't be imported by `.jsx` files
- zod provides **runtime validation** at the API boundary, not just compile-time type checking
- zod is already in the dependency tree
- Both client and server can import from the same `.mjs` file — no monorepo tooling needed

**Implementation choice:** Lightweight (single schemas.mjs via relative import) rather than rigorous (full monorepo with zod-as-source-of-truth package). The rigorous approach was evaluated but rejected for proportionality — this is a single-repo, single-node deployment, not a distributed team.

## What was built

`src/shared/schemas.mjs` exports zod schemas for:
- **Graph:** GraphNode, GraphLink, GraphResponse, GraphSubtree
- **Agent:** Agent, AgentSession, AgentAction
- **Task:** Task, TaskLog
- **DAG:** Dag
- **Skill:** Skill
- **LLM:** LlmProvider, LlmModel
- **Cost:** TokenUsage
- **Auth:** User, AuthResponse
- **Envelope:** ApiError, Paginated factory

The graph endpoint (`/api/graph`) validates its response with `GraphResponseSchema.safeParse()` — strips unknown keys and logs validation failures without breaking the UI.

## Consequences

- Changing a field in `schemas.mjs` that doesn't match the server's actual output will produce a logged validation failure (not a silent mismatch)
- Client-side imports can use `z.infer<typeof GraphResponseSchema>` in `.tsx` files or just use the schema for runtime validation in `.jsx` files
- Subsequent endpoints should import and validate against the relevant schema
- No new tooling or build steps needed
