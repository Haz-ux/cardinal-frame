# ADR-008: Cost Tracking + Budget Alerts

**Date:** 2026-07-21
**Status:** Accepted

## Context

`costs.mjs` had a basic pricing table (12 models) and `token_usage` table
for recording spend, but no budget enforcement, no alerting, and pricing
was stale (missing o1, Claude 3.7, Grok 3, GLM-5, Nemotron, etc.).

## Decision

**Expand pricing table + add budget alert endpoint.**

### Changes

- Pricing table expanded from 12 → 25+ models across 8 providers
- New endpoint: `GET /api/costs/budget` — compares spend against
  `COST_BUDGET_USD` env var, returns utilization %, remaining budget,
  and emits `cost:alert` WebSocket event at 80% threshold
- Configurable via env: `COST_BUDGET_USD=10` enables alerts at $8
- Zero budget (default) = no alerts, just tracking

### Design Principles

- Budget is advisory, not hard-capped (agent continues running)
- Alert fires once per request that crosses threshold (not deduped —
  dashboard UI can dedup on `cost:alert` event)
- All amounts in USD with 6 decimal precision
