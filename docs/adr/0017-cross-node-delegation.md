# ADR-0017: Cross-Node Subagent Delegation

**Date:** 2026-07-24

## Context

The agent system has 11 tools (file_read, file_write, file_list, file_search, shell_exec, web_search, web_fetch, git_op, mcp_invoke, skill_invoke) but no way to delegate subtasks to other agents. When the LLM agent needs to parallelize work or leverage a specialized agent, it has no mechanism to do so.

## Decision

Add a **delegation system** — a new `delegate_task` agent tool + REST API for creating and tracking delegated subtasks.

### Schema

- `delegations` table: id, parent_task_id, parent_session_id, child_task_id, agent_id, node, status, capability, priority, synchronous, result, error, created_at, completed_at
- Links parent tasks to child tasks, tracks which agent was assigned, and stores the result when completed

### API

| Endpoint | Purpose |
|----------|---------|
| `POST /api/delegate` | Create a delegation (async or synchronous with wait) |
| `GET /api/delegations` | List delegations (filter: parentId, agentId, status) |
| `GET /api/delegations/:id` | Delegation details + child task |
| `POST /api/delegations/:id/wait` | Long-poll for delegation completion |
| `POST /api/delegations/:id/cancel` | Cancel a pending delegation |

### Agent Tool

`delegate_task` — registered in the agent tool registry, callable by the LLM during agent loops:
- Parameters: name, command, capability, agentId, synchronous, waitTimeout
- Calls `POST /api/delegate` internally via fetch
- Returns delegationId, status, childTaskId, result (if synchronous)
- Synchronous mode waits for the subtask to complete (default)
- Async mode returns immediately with a delegation ID to poll later

### Capability Matching

When `agentId` is not specified, the system auto-selects an agent by matching the `capability` parameter against agent capabilities (JSON array in the agents table). Falls back to any active agent if no match is found.

### Synchronous vs Async

- **Synchronous** (default): The `/api/delegate` endpoint polls the child task status every 500ms up to `waitTimeout` (default 30s). Returns the result if completed, or 202 with "still pending" if timeout.
- **Async**: Returns immediately with 201 + delegation ID. Client polls `/api/delegations/:id/wait` or checks status.

## Consequences

- +10 tests (all passing, 378/380 total)
- The `delegate_task` tool is the 12th agent tool — the LLM can now delegate work
- Delegations integrate with the existing task system — child tasks use the same `executeTask` path
- `syncDelegationStatus()` automatically updates the delegation record when the child task completes
- WS broadcasts: `delegation:created`, `delegation:completed`, `delegation:failed`, `delegation:cancelled`
- Remote node support: the `node` field is stored but currently always 'local' — future work could dispatch to remote Cardinal Frame instances via their agent API
