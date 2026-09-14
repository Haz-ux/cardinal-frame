# ADR 0020: Defensive Pillar — Trust Tiers and the Turn Loop

Date: 2026-09-12
Status: Accepted

## Context

The existing warden/sandbox/governance guard the *system* against bad *code*.
Nothing guarded the user's *information* against other *agents*: pasted text,
web content, third-party agent output, and workflow results all entered the
context as if they were instructions.

## Decision

New rule: **no external content is ever an instruction** — only the user
issues orders. Enforced mechanically, not by prompting:

- Trust tiers: user > local system > paired devices > web > third-party agents.
- `defense/provenance.mjs` tags every input with source + tier.
- `defense/policy.mjs` runs before tool calls; sub-user-tier instructions are
  dropped and logged.
- `defense/ingress.mjs` drops secrets by pattern *before* the event object is
  constructed (not redaction-after-capture).
- `defense/egress.mjs` classifies anything carrying user data that leaves the
  box; silent exfiltration becomes structurally impossible.
- `defense/canaries.mjs` plants unique tokens in memory stores; an outbound
  canary is a compromise signal.

Defense is not a module you call — it is the *shape of the turn loop*:
ingress -> policy -> companion -> model -> egress -> approval -> tools ->
redacted write-back. The fleet, curator, learning, n8n, and external models
never bypass it.

## Consequences

- New modules: `defense/`. New routes: `routes/defense.mjs` (read-oriented).
- New migrations: `019_provenance_defense.sql`.
- The machine's own output (including sandbox-generated fixes) is treated as
  untrusted until validated — this is what makes the AI on-call loop sellable.
