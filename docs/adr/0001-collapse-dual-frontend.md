# ADR 0001: Collapse dual frontend to client/ tree

Date: 2026-07-24
Status: Accepted

## Context

Cardinal Frame had two competing frontend source trees:

- `client/src/*.jsx` — 40+ files, Vite-built via `client/build.mjs`, Docker-deployed. The live, feature-complete tree with NeuralMap, DAGEditor, Chat, Agents, Skills, LLMProviders, Automation, etc.
- `src/*.tsx` — 25 files (7 pages, 17 components), wired via root `index.html` → `/src/main.tsx`. Not referenced by Dockerfile or package.json scripts.

Additionally, `server.ts` (1,465 lines) existed at repo root but was never referenced in `package.json` scripts — `src/server/server.mjs` is the live server entry point.

## Decision

Keep `client/src/*.jsx` as the single canonical frontend. Delete the dead TypeScript tree.

**Rationale:** The plan recommended migrating to the TypeScript tree for "stronger type safety." However, `client/src/` is the live, deployed, feature-complete tree with 40+ components. Rewriting working features in TypeScript just to collapse to one tree is optimizing the wrong variable — it's a 3-5 day risk with no user-facing benefit. The goal is one canonical tree, not type purity.

## What was deleted

- `src/pages/` (7 .tsx files)
- `src/components/` (17 .tsx files)
- `src/main.tsx` (entry point)
- `src/assets/` (images)
- `src/data/` (seed JSONL files)
- `server.ts` (1,465 lines, dead)
- Root `index.html` (wired to dead src/main.tsx)
- Root `vite.config.mjs` (orphaned by index.html)
- Duplicate configs: `vite.config.cjs`, `playwright.config.js`, `playwright.config.mjs`, `tailwind.config.js`, `client/vite.config.js`
- Dead artifacts: `jest.config.cjs.bak`, `check_tables.js`

Total: 40 files, ~14,653 lines removed.

## Consequences

- Single frontend tree in `client/src/` — no component name duplication
- `src/` now contains only `src/server/` (backend) and `src/cli/` (CLI tool)
- Type safety is addressed via Phase 1.3 (zod schemas in `src/shared/schemas.mjs`) — runtime validation at API boundaries rather than compile-time type checking across a rewritten tree
- Shared types live in `src/shared/schemas.mjs`, imported by both server and client
