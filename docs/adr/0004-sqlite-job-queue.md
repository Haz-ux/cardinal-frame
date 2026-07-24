# ADR 0004: SQLite-backed durable job queue

Date: 2026-07-24
Status: Accepted

## Context

Task and DAG execution was purely in-process — `exec()` callbacks chained through `Promise.all()`. A server restart mid-execution would silently lose all state. No retry, no dead-letter queue, no persistence.

The plan proposed BullMQ backed by Redis. However, Cardinal Frame is a single-node home deployment — adding Redis as an operational dependency is disproportionate when SQLite is already the database.

## Decision

Build a SQLite-backed job queue (`src/server/job-queue.mjs`) using the existing database.

**Features:**
- Persistent job state in `jobs` + `job_steps` tables — survives restarts
- Automatic recovery: on startup, any `running` jobs are reset to `pending`
- Retry with exponential backoff (1s, 2s, 4s, 8s... capped at 30s)
- Dead-letter queue: after `max_retries` (default 3), failed jobs move to `dead` status
- Configurable concurrency (default 3), timeout (default 30s)
- Trace ID field for Phase 2.3 observability
- WebSocket broadcasts for job lifecycle events
- Admin API to retry dead jobs

**Handler registry:** extensible — `dag` and `task` handlers built-in, new types via `registerHandler(type, fn)`

**DAG execution:** When `globalThis._jobQueue` is available, DAG runs enqueue through the queue instead of executing in-process. Fallback to in-process for tests.

## Why not Redis/BullMQ

- Single-node deployment — no cluster, no multi-producer concurrency
- SQLite is already the operational database — one backup covers everything
- No new process to manage, no memory overhead, no connection pool
- better-sqlite3 synchronous queries are fine for a single-worker queue poller

## API endpoints added

- `GET /api/jobs/stats` — queue status (pending, running, completed, failed, dead counts)
- `GET /api/jobs/:id` — job details + steps
- `GET /api/jobs/dead` — dead-letter queue
- `POST /api/jobs/:id/retry` — admin retry of dead job

## Configuration (env vars)

- `JOB_CONCURRENCY` (default 3)
- `JOB_TIMEOUT_MS` (default 30000)
- `JOB_MAX_RETRIES` (default 3)

## Consequences

- Kill the server mid-DAG → on restart, incomplete jobs resume
- Failed jobs retry automatically with backoff
- Permanently failed jobs are visible in the dead-letter endpoint and can be retried
- Queue starts/stops with the server lifecycle
- Graceful shutdown drains running jobs (up to 10s) before closing
