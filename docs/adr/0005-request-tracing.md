# ADR-005: Request Tracing via SQLite

**Date:** 2026-07-21
**Status:** Accepted

## Context

Cardinal Frame had Winston logging and per-request IDs, but no persistent
request traces. Debugging latency or error patterns required grepping logs
with no ability to aggregate by path, find slow requests, or query errors.

## Decision

**SQLite-backed request tracing.** No external dependency (OpenTelemetry,
Jaeger, etc.) — just a `request_traces` table + lightweight middleware.

### Design

- `traceMiddleware` attaches on every request, logs `finish` with hrtime
- Persists to `request_traces` table: id, method, path, status, duration_ms, user_id, error
- 7-day retention with hourly cleanup interval
- Skips SSE and WebSocket upgrades
- Admin-only REST endpoints: `/api/traces/summary`, `/api/traces/slowest`,
  `/api/traces/errors`, `/api/traces/paths`

### Why not OpenTelemetry?

- Single-node deployment on edge hardware (Jetson)
- OTel collector adds ~50MB+ overhead
- SQLite is already available, queries are simple
- If distributed tracing is needed later, the middleware format is
  compatible — trace ID is already propagated via `X-Request-Id`
