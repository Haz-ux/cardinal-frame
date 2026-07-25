# ADR-0013: Exact-Pin Security-Critical Dependencies

**Date:** 2026-07-24
**Status:** Accepted
**Deciders:** Architect (Shane Jordan)
**Context:** Comparative analysis (§3.6) flagged Hermes's exact-pinning rationale after a real npm supply-chain incident.

## Context

The comparative analysis noted Hermes Agent exact-pins all direct dependencies, citing a 2026 npm supply-chain incident where a compromised `mistralai` package version was published. This came shortly after Cardinal Frame's own credential-exposure incident (hardcoded API key in git history).

The analysis recommended: "adopting exact pins (at minimum for anything touching auth, encryption, or secrets) is a cheap, concrete hardening step."

## Decision

Exact-pin (no `^` or `~` prefix) all security-critical dependencies:

| Package | Pinned Version | Why Security-Critical |
|---|---|---|
| `bcryptjs` | 3.0.3 | Password hashing |
| `better-sqlite3` | 12.10.0 | Database engine (stores encrypted secrets) |
| `jsonwebtoken` | 9.0.3 | JWT token signing/verification |
| `express-rate-limit` | 8.5.2 | Auth rate limiting (brute force protection) |
| `dotenv` | 3.0.0 | Loads env vars including API keys |
| `multer` | 1.4.5-lts.2 | File upload handler (injection surface) |
| `ws` | 8.21.0 | WebSocket server (connection surface) |
| `cors` | 2.8.5 | CORS policy enforcement (access control) |

Non-security dependencies remain on semver ranges — this is a targeted hardening, not a full lock-down.

## Consequences

- ✅ Security-critical packages won't auto-upgrade to potentially compromised versions
- ✅ `npm ci` will produce reproducible installs for these packages
- ⚠️ Must manually update pinned packages to receive security patches
- ⚠️ No lockfile yet — adding `package-lock.json` to git would make this fully reproducible (future work)
- ❌ Does not address transitive dependency attacks (would need lockfile + `npm audit` in CI — future work)
