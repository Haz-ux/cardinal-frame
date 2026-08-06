# Security Audit & Remediation Plan

**Project:** Cardinal Frame
**Audit focus:** Secrets at rest, key handling, auth, and incidental secrets in the data plane
**Status:** Active — findings tracked below; remediation verified by test suite (635/635 passing)

This document is the working record of security reviews performed on Cardinal Frame's
own codebase. It is linked from the [README](./README.md#security--audit) so findings
are not buried. Related architecture decisions live in [`docs/adr/`](./docs/adr/)
(notably [ADR-006](./docs/adr/0006-hardcoded-api-key-in-git-history.md) and
[ADR-007](./docs/adr/0007-aes-encryption-secrets.md)).

---

## Findings

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| 1 | High | Secrets at rest | `llm_providers.api_key` was stored **plaintext** in SQLite | **Fixed** — AES-256-GCM at rest |
| 2 | High | Secrets at rest | Stored env vars used XOR cipher with hardcoded fallback key `cf-default-secret-v1` | **Fixed** — AES-256-GCM (ADR-007) |
| 3 | Medium | Key handling | `ENCRYPT_SECRET` was loaded **after** the AES key was derived at module import — on a fresh boot secrets would be encrypted under a random throwaway key and become undecryptable after restart | **Fixed** — `preload-env.mjs` loads `.env` before route modules |
| 4 | Medium | Git history | Hardcoded Gemini API key existed in deleted `server.ts`, still recoverable via git history | **Mitigated** — key rotated, gitleaks in CI + pre-commit hook (ADR-006) |
| 5 | Low | Data hygiene | Garbage `NVIDIA_API_KEY` row in `env_vars`, encrypted under a previous boot's random key (pre-fix) and unrecoverable | **Fixed** — row deleted; working key lives in the encrypted provider row |
| 6 | Info | Verification | No hardcoded secrets in tracked source; no secrets leaked in server logs, DB chat/memory/request content, or `audit_log` | **Verified** — only false positives (skill names, dashboard summary text) |

## Finding Details

### 1. `llm_providers.api_key` plaintext at rest — FIXED

**Before:** provider API keys were written to the `llm_providers` table verbatim.

**Fix:**
- Added `encrypted INTEGER DEFAULT 0` column (schema + boot migration).
- Writes now encrypt via `encryptSecret()` → `iv:tag:enc` (base64, colon-delimited) and set `encrypted=1`. Seed/Ollama entries store an empty key with `encrypted=0`.
- Reads decrypt only at runtime chokepoints via `decryptProvider()` (`src/server/routes/settings.mjs`), applied in `provider-runtime.mjs`, `routes/llm-helpers.mjs`, and both `callAgentLLM` paths in `routes/agent.mjs`.
- A boot-time migration encrypted any legacy plaintext rows (logged as `Encrypted at-rest api_key for llm_provider <id> (legacy plaintext migration)`).
- The Settings → API Keys UI is admin-only and returns decrypted values by design.

**Verified:** provider rows return `encrypted=1` from `GET /api/llm/providers`; a stored value round-trips (138-char ciphertext → original 70-char key).

### 2. XOR "encryption" of stored env vars — FIXED (ADR-007)

**Before:** `decryptValue()` fell back to a XOR cipher using a hardcoded key (`cf-default-secret-v1`). XOR is trivially reversible.

**Fix:** AES-256-GCM. The key is derived from the `ENCRYPT_SECRET` env var via SHA-256 (`openssl rand -base64 48`). If unset, a random key is generated — secrets will **not** survive restart, and there is **no hardcoded fallback**. Legacy XOR rows decrypt transparently via the `decryptValue` fallback.

### 3. Env load-order bug — FIXED

**Root cause:** `settings.mjs` derives its AES key at module import time. Route modules were imported before `dotenv.config()` ran, so a fresh boot could encrypt secrets under a random key and fail to decrypt them later.

**Fix:** new `src/server/preload-env.mjs` calls `dotenv.config()` and is imported **first** in `server.mjs`, before any route module. Verified by restarting the server and confirming encrypted secrets survive.

### 4. Hardcoded API key in git history — MITIGATED (ADR-006)

A hardcoded Gemini key existed in `server.ts` (deleted, 14,653 lines removed). It is still recoverable from history, but was rotated in Google Cloud Console, which invalidates it regardless. CI runs gitleaks with full history scan; a pre-commit hook (`.githooks/pre-commit`, install via `npm run hooks:install`) scans staged files. Decision: leave history as-is (rewriting breaks clones/forks) rather than force-pushing a rewritten history.

### 5. Garbage env var row — FIXED

The old `env_vars` row for `NVIDIA_API_KEY` was unrecoverable (encrypted under a pre-fix random key) and was deleted. `GET /api/settings/env` returns 0 rows. Consequence: `env_vars` no longer injects `NVIDIA_API_KEY` into `process.env`, so the Settings key-test mapping and skills env-var injection report no NVIDIA key. If needed again, add it via Settings → API Keys → NVIDIA NIM (now stored properly under the stable `ENCRYPT_SECRET`).

### 6. Source/log sweep — VERIFIED

No hardcoded keys in tracked source. No secrets in server logs, DB chat/memory/request content, or `audit_log` (matches were false positives: skill names, dashboard summary text).

---

## Open Items

| Area | Item | Priority |
|------|------|----------|
| Auth | JWT is long-lived (24h) with **no refresh or logout endpoint** (`POST /api/auth/logout` absent). Logout is client-side token discard. Consider short-lived access tokens + refresh flow for production multi-user deployments. | Medium |
| Docs | `ARCHITECTURE.md` states "API 100/min" rate limit and "5s timeout / 100KB maxBuffer" sandbox — actual values are 50/min (`apiLimiter = writeLimiter`) and the skill VM sandbox uses 30s (configurable via `sandboxTimeout`) with a 1MB `execSync` buffer. Only `POST /api/sandbox/execute` uses 5s/100KB. | Low |
| Schema | `skill_hub_sources.type` CHECK constraint declares `('git','tarball','http')` but routes insert `'github'`/`'url'`. Constraint predates actual usage. | Low |

## Resolved

| Area | Item | Priority |
|------|------|----------|
| Auth | `POST /api/skills/proposals/:id/accept` passed bare `requireRole` (no role argument) — empty `roles` array meant the endpoint always returned `403` and never called `next()`. Fixed to `requireRole('admin')` (`src/server/routes/skills.mjs:460`). Audited all route modules for the same misuse — no other occurrences. | High |

## Verification

- `npm test` — 635/635 passing across 41 files (`NODE_ENV=test`).
- Manual: login, token issuance, provider CRUD with encrypted-at-rest keys, DAG execution via durable queue, plugin load/toggle/reload, skill execution with invocation logging.
- CI (`.github/workflows/ci.yml`): tests on Node 20 + 22, gitleaks secret scan, PR history check.

## Recurring Reviews

- [x] 2026-07-21 — ADR-006 (hardcoded key) / ADR-007 (AES-256-GCM) written
- [x] Secrets-at-rest pass — `llm_providers` encryption, env-load-order fix, garbage row cleanup
- [ ] Next scheduled review — prior to next tagged release
