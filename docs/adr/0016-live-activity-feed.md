# ADR-0016: Live Activity Feed — Real-time System Event Overlay

**Date:** 2026-07-24

## Context

The Neural Map reheats its force simulation on any WebSocket event, but there's no way to see **what** events are happening in real-time. Users have no visibility into the stream of task statuses, agent heartbeats, chain executions, or other system activity without checking individual pages.

## Decision

Add a **Live Activity Feed** — an in-memory ring buffer + DB-backed log of all broadcast events, surfaced on the Neural Map as a collapsible overlay panel.

### Server Side

- `activity_log` table: id, type, payload (JSON), ts
- In-memory ring buffer (200 entries) for fast polling path
- DB-backed persistent log with 24h retention + periodic cleanup
- `ctx.logActivity(type, payload)` hook wired into the `broadcast()` function — every WS event is automatically logged
- `GET /api/activity` — recent events (filter: limit, type, since)
- `GET /api/activity/stats` — event counts by type (last hour)

### Client Side

- `ActivityOverlay.jsx` — new module with:
  - `useActivityFeed()` hook — loads initial events from `/api/activity`, appends WS events in real-time, pause/clear support
  - `ActivityFeed` component — scrollable event list with color-coded icons, event type, payload摘要, timestamp
  - `useActivityPulses(graphNodes)` — generates pulse animation data for nodes matching incoming events
- Neural Map integration:
  - Activity toggle button in header toolbar (green Activity icon)
  - Floating activity panel (top-right, 72w, compact mode) over the graph canvas
  - Events appear with fadeIn animation, auto-scrolling most recent first
  - Pause/Resume button and Clear button

### Event Type Mapping

Each broadcast event type maps to a color + icon for the feed:
- `task:*` → blue (Play)
- `agent:*` → green (Cpu) / red on errors
- `dag:*` → orange
- `chain:*` → purple
- `memory:created` → cyan
- `cost:alert` → red alert
- `comms:message` → pink

## Consequences

- +6 tests (all passing, 368/370 total)
- Every `broadcast()` call now writes to activity log — minimal overhead (ring buffer append + best-effort DB insert)
- 24h retention keeps the DB small; cleanup runs every 5 minutes
- Ring buffer serves fast-path polling (no DB query for recent events)
- Frontend overlay is opt-in (toggle button), doesn't interfere with existing Neural Map functionality
- ActivityOverlay.jsx is reusable — can be mounted on any page via `useActivityFeed()` + `<ActivityFeed />`
