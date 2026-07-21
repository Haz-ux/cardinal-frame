# Cardinal Frame – Agent Documentation

## Agent Lifecycle

1. **Registration**
   - **Endpoint**: `POST /api/agents`
   - **Request Body**: `{ "name": "<string>", "version": "<string>" }`
   - **Response**: `201 Created` with agent object containing:
     - `id` – UUID v4 unique identifier
     - `name` – human‑readable identifier
     - `version` – version string supplied by client
     - `registeredAt` – ISO‑8601 timestamp of registration
     - `lastHeartbeat` – ISO‑8601 timestamp of the most recent heartbeat
     - `status` – `"active"` (default after registration)

2. **Heartbeat**
   - **Endpoint**: `GET /api/agents/:id/heartbeat`
   - **Purpose**: Allows an agent to announce liveness and refresh its timestamp.
   - **Response**: The same agent object with updated `lastHeartbeat` and `status` set to `"active"`.

3. **Listing Agents**
   - **Endpoint**: `GET /api/agents`
   - **Response**: Array of agents `{ id, name, status }`.

4. **Task Association (optional future extension)**
   - Tasks are created independently of agents, but the API can later be extended to associate tasks with specific agents.

## Agent Data Model

| Field            | Type   | Description                                          |
|------------------|--------|------------------------------------------------------|
| `id`             | string | UUID v4 – immutable unique identifier for the agent. |
| `name`           | string | Human‑readable name of the agent (provided at registration). |
| `version`        | string | Version identifier (e.g., `"1.0"`).                 |
| `registeredAt`   | string | ISO‑8601 timestamp when the agent was first registered. |
| `lastHeartbeat`  | string | ISO‑8601 timestamp of the most recent heartbeat.    |
| `status`         | string | `"active"` while the agent is alive; could be `"inactive"` if needed. |

## Server Implementation Details

- **Agent Store**: `Map<string, Agent>` where the key is the agent `id`.
- **Registration Handler**:
  - Validates that `name` is present.
  - Generates a UUID (`randomUUID()`).
  - Creates the agent object, inserts it into the map, logs the event.
- **Heartbeat Handler**:
  - Retrieves the agent by `id`.
  - If not found, returns `404`.
  - Updates `lastHeartbeat` to `new Date().toISOString()`.
  - Sets `status` to `"active"`.
  - Returns the updated agent object.
- **Error Handling**:
  - Missing `name` → `400 Bad Request`.
  - Unknown agent ID → `404 Not Found`.

## Example Interaction

```bash
# Register a new agent
curl -X POST http://localhost:3000/api/agents \
     -H "Content-Type: application/json" \
     -d '{"name":"my‑agent","version":"1.0"}'

# => {"id":"c1a2b3c4-5678-90ab-cdef-1234567890ab","name":"my-agent","version":"1.0","registeredAt":"2026-05-29T21:30:00.123Z","lastHeartbeat":"2026-05-29T21:30:00.123Z","status":"active"}

# Agent reports heartbeat
curl http://localhost:3000/api/agents/c1a2b3c4-5678-90ab-cdef-1234567890ab/heartbeat

# => {"id":"c1a2b3c4-5678-90ab-cdef-1234567890ab","name":"my-agent","version":"1.0","registeredAt":"2026-05-29T21:30:00.123Z","lastHeartbeat":"2026-05-29T21:30:05.456Z","status":"active"}
```

## Summary

- Agents are lightweight, identified by UUIDs.
- Registration is a one‑time POST; heartbeats keep the agent marked as active.
- The API is JSON‑based, CORS‑enabled, and ready for React front‑end consumption.

*End of document.*