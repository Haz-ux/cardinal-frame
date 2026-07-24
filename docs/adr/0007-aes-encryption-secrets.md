# ADR-007: AES-256-GCM for Secret Encryption

**Date:** 2026-07-21
**Status:** Accepted

## Context

Stored secrets (env vars) were encrypted with XOR cipher using a hardcoded
fallback key (`cf-default-secret-v1`). XOR is trivially reversible and
provides no real security — it's obfuscation, not encryption.

## Decision

**Replace XOR with AES-256-GCM.** Key derived from `ENCRYPT_SECRET` env var
via SHA-256. If unset, a random key is generated (secrets won't survive
restart, but no hardcoded fallback).

### Design

- `encryptSecret(plaintext)` → `iv:tag:ciphertext` (base64, colon-delimited)
- `decryptSecret(packed)` → plaintext (or original value on failure)
- `decryptValue(val, isEncrypted)` — smart decrypt: tries AES-GCM first
  (contains `:`), falls back to XOR for legacy rows
- XOR functions kept for backward compatibility with existing DB rows
- New writes always use AES-GCM; old rows decrypt transparently

### Migration

Existing XOR-encrypted rows remain readable via the `decryptValue` fallback.
No data migration needed — new writes use AES-GCM, old reads handle both.
