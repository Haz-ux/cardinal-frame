# ADR-0008: Governance Enforcement in Chain Executor + Trace Correlation

**Date:** 2026-07-24  
**Status:** Accepted  
**Phase:** 3.2 + 3.3

## Context

Phase 3.1 established the governance layer (personas, permissions, audit log) as
standalone infrastructure. However, the chain executor (`chains.mjs`) and tool chain
executor had no enforcement points — any chain step could execute any skill without
permission checks. Audit log entries were also disconnected from request traces,
making it impossible to correlate "who did what" with "which request caused it."

## Decision

### 3.2 — Enforcement Points

Add a `governance` parameter to both `executeSkillChain` and `executeToolChain`:

```js
governance = {
  persona,           // persona record from DB
  checkPermission,   // imported from governance.mjs
  auditLog,          // closure: (action, details) => void
}
```

Before each step executes:
1. Build an action string (`skill:<name>` or `tool:<name>`)
2. Call `checkPermission(persona, action, step)` 
3. If denied → record `governance_denied: true` in step results, broadcast WS event,
   and abort chain (unless `continue_on_error` is set)
4. If allowed → proceed with execution, audit log the decision

The governance object is constructed at the route handler level using the
request's authenticated user and persona from the database.

### 3.3 — Trace Correlation

Add `trace_id` column to `audit_log` table. The `auditLog` function now accepts
an optional `traceId` parameter:

```sql
audit_log (id, actor, action, target, details, trace_id, ts)
```

This enables querying audit entries by trace ID:
```
GET /api/governance/audit?trace_id=<request-trace-id>
```

Which returns all governance decisions (permission checks, persona mutations,
sandbox executions) that occurred during a single HTTP request's lifecycle.

## Consequences

- **Positive:** Every chain step is now permission-checked before execution
- **Positive:** Audit trail and request traces are unified — one query shows both
  performance data (duration, status) and governance data (who approved what)
- **Negative:** Slight latency added per chain step for the permission check
- **Risk:** The default persona allows all actions — enforcement is opt-in per agent
  by assigning a more restrictive persona
