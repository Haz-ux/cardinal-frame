# ADR 0018: Convert root + client/ to an npm workspace

Date: 2026-08-03
Status: Proposed

## Context

Cardinal Frame ships two package trees: a root `package.json` (server, CLI, tests) and `client/package.json` (frontend). They share packages — `react`, `vite`, `zod`, `d3-force`, and others are declared in both or installed into separate `node_modules` trees.

This split surfaced as a CI break: `tests/graph.test.mjs` imports `client/src/graph/ClusterSimulation.js`, which imports `d3-force`. `d3-force` was declared only in `client/package.json`, so a root-only `npm ci` (as CI does) could not resolve it and the whole suite failed to load. The immediate fix (ADR-0018 source, audit Finding A) added `d3-force` to the root `package.json`, but this reintroduces the dual-dependency-tree pattern ADR-0001 was meant to avoid.

## Decision

Track converting the repo to a single npm workspace as a follow-up. The root `package.json` becomes a workspace root:

```json
{
  "workspaces": ["client"]
}
```

with shared dependencies hoisted into one root `node_modules`, and duplicate declarations removed from `client/package.json`.

## Consequences

- One resolution path for shared packages — client and server/tests resolve the same installed versions, eliminating the class of failure seen in Finding A.
- Single lockfile already exists at root; workspace migration updates it in place.
- CI unchanged (`npm ci` at root) but now installs workspace deps.
- Requires moving frontend-only deps (e.g., `react-force-graph-2d`) to the workspace so they are not hoisted into the server's install footprint unnecessarily, or accepting hoisting.

## Status

Not started. Unblocks further client/root de-duplication. Shortlist: verify `vite` workspace behavior with `client/vite.config`, run full suite after migration.
