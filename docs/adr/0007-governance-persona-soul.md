# ADR-0007: Governance Layer — Persona, Permissions, and SOUL Docs

**Date:** 2026-07-24  
**Status:** Accepted  
**Phase:** 3.1

## Context

Phases 1–2 established the core infrastructure: schemas, job queue, observability,
encryption, and cost tracking. Phase 3 introduces **governance** — the system that
constrains and audits what agents can do.

Without a governance layer:
- Any authenticated admin can trigger any action with no granular control
- No machine-readable behavioral rules exist for agents
- No audit trail for who did what and when
- No persona/identity system to give agents distinct behavioral profiles

## Decision

Implement a three-pillar governance layer:

### 1. Persona System (`personas` table)
- Each persona defines an agent identity, SOUL doc, permissions, and constraints
- Personas are attached to agents via `agent_id` FK
- Multiple personas can exist; disabled personas are ignored
- Default persona seeded on startup with baseline-safe permissions

### 2. Permission Checking (`checkPermission`)
- Regex-based constraint matching (deny list)
- Escalation: dangerous commands (`rm`, `sudo`, `chmod`) require approval
- Allow-list: if permissions array is non-empty, only listed actions pass
- Returns `{ allowed, reason?, requiresApproval? }`

### 3. Audit Logging (`audit_log` table)
- Every permission check, sandbox execution, and persona mutation is logged
- Stored as: actor, action, target, JSON details
- Queryable by actor or globally with pagination

### SOUL Document Format
```json
{
  "identity": "Agent name",
  "principles": ["Be helpful", "Be safe"],
  "boundaries": ["Never expose secrets"],
  "escalation": {
    "require_approval_for": ["rm", "sudo"],
    "auto_approve": ["echo", "ls", "cat"]
  }
}
```

## Consequences

- **Positive:** Fine-grained control over agent actions, full audit trail
- **Positive:** SOUL docs are machine-readable and can be exposed to the agent
  as system prompt context
- **Negative:** Permission checks add latency to every sandbox execution
- **Risk:** Regex-based constraints can be bypassed with creative command
  crafting — future work should use a proper command parser
