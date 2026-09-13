# ADR 0019: Companion Pillar — One Face, Many Hands

Date: 2026-09-12
Status: Accepted

## Context

Cardinal Frame had swappable personas (Aimi, Cipher, Ghost) as operators the
user switched between. That produced a capable system with no continuous
presence — every session started from zero socially, even when memory
persisted technically. The EDI/Cortana goal needs a singular companion, not a
cast of operators.

## Decision

One companion per user. It owns the name, the avatar, the voice, and the
shared history. Aimi/Cipher/Ghost stop being personas and become **crew
modes**: specialist sub-modes the companion delegates to for
operator/analyst/code work. The user talks to one face; the work fans out
behind it.

Relationship memory (shared history) is stored separately from semantic
memory (facts about the world), loaded every turn and written back every
turn — write-first.

`src/server/personas.mjs` is reframed as the mode registry data; it is not
deleted. Cryptographic node identity (`node-identity.mjs`) is explicitly not
persona identity and stays untouched.

## Consequences

- New modules: `companion/` (companion, relationship, presence, modes).
- New routes: `routes/companion.mjs`. New migrations: `018_relationship.sql`.
- Presence (proactive interruption) is part of this pillar, not a separate
  notification system.
