# ADR-0012: Skill Outcome Logging via skill_invocations Table

**Date:** 2026-07-24
**Status:** Accepted
**Deciders:** Architect (Shane Jordan)
**Context:** Comparative analysis (§3.3) flagged skill system as "write-once" with no outcome tracking.

## Context

The comparative analysis against OpenClaw and Hermes Agent identified that Cardinal Frame's skills were "write-once" — no per-execution outcome logging existed. While the `skills` table had aggregate counters (`success_count`, `failure_count`, `invoke_count`, `confidence`), there was no per-invocation log with timestamps, durations, or trace correlation.

The analysis recommended: "log every skill invocation's outcome to the same trace store, and surface a 'this skill has failed N/M times' signal on the dashboard."

## Decision

Add a `skill_invocations` table that logs every skill execution with:

- `skill_id` + `skill_name` — which skill ran
- `trace_id` — correlates with request tracing (Phase 2.3) for end-to-end observability
- `success` — 0/1 outcome
- `duration_ms` — execution time
- `skill_type` — script/template/hybrid
- `error` — failure reason if applicable
- `ts` — timestamp

### API Endpoints

- `GET /api/skills/stats/invocations?window=-7d` — failure-rate stats per skill, sorted by failures desc
- `GET /api/skills/:id/invocations?limit=20` — recent invocations for a specific skill
- `GET /api/skills/invocations/recent?limit=50` — recent invocations across all skills

### Trace Correlation

`executeSkill()` now accepts an optional `traceId` parameter. All callsites pass it:
- HTTP routes pass `req.id` (from trace middleware)
- Heartbeat passes `heartbeat:<timestamp>` for non-request-context executions

## Consequences

- ✅ Per-execution outcome data available for dashboard "failure-rate signal"
- ✅ Trace correlation: can see which skills ran during a specific request trace
- ✅ Average duration tracking per skill
- ✅ Non-fatal logging — skill execution still succeeds even if invocation log fails
- ⚠️ Table will grow — needs periodic cleanup (same pattern as trace cleanup in heartbeat)
- ❌ Does not implement full self-authoring skills (Hermes's pattern) — that's a separate, larger feature
