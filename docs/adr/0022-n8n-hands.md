# ADR 0022: n8n as the Hands Layer — Brain vs. Hands

Date: 2026-09-12
Status: **SUPERSEDED** (2026-09-13)

> Superseded: Cardinal Frame will not depend on n8n. The project builds its
> own DAG/workflow engine instead of delegating execution to n8n — no n8n
> runtime dependency, no direct n8n integration. `src/server/integrations/n8n.mjs`
> is retained only as an inert scaffold until a decision is made to remove it.
> Do not build on this ADR's direction.

## Context

Cardinal Frame needs a last mile into hundreds of integrations (Shopify,
Gmail, Stripe, …). Re-implementing workflow automation would burn the
Jetson's budget on edge cases n8n has already solved for years.

## Decision

Clean division: **Cardinal Frame is the brain, n8n is the hands.**

- CF decides what should happen and whether it is safe (judgment, companion,
  approvals, learning, defensive perimeter).
- n8n executes workflows across 500+ integrations. Self-hostable, keeping the
  local-first pillar intact.

Two touchpoints:

1. CF -> n8n: the orchestrator dispatches workflow executions by webhook —
   n8n is a fleet node type, just another worker behind the companion.
2. n8n -> CF: n8n webhooks land in `scheduling/hooks.mjs` as event sources,
   feeding presence.mjs and the AI on-call loop.

Trust boundary: n8n output enters as **third-party-tier content** — untrusted
until validated by `defense/ingress.mjs`, same as any external source. The
defensive pillar governs the brain/hands boundary; convenience never bypasses
it.

Housing (~300MB) is undecided: the Jetson is spoken for, so n8n may live on a
side machine. Either way it is *operated by* Cardinal Frame, not part of it.

## Consequences

- New module: `integrations/n8n.mjs`.
- No n8n dependency is vendored; the boundary is webhooks both directions.
