# ADR-006: Hardcoded API Key in Git History

**Date:** 2026-07-21
**Status:** Accepted
**Severity:** Medium (contained, key rotated)

## Context

The original `server.ts` (deleted in Phase 1.1, commit `6b8f2a8`) contained a hardcoded Gemini API key as a fallback default:

```ts
const defaultKey = "AIzaSy…c6Ik";
```

The key was used as a last-resort fallback — if `gemini_api_key.txt` didn't exist, it would write this key to disk, and if `GEMINI_API_KEY` wasn't set, it would fall back to reading that file.

## Current State

- **Live codebase is clean.** `server.ts` was deleted in commit `6b8f2a8` (Phase 1.1, 14,653 lines removed). No hardcoded keys exist in any tracked file in the current tree.
- **`.env` is not tracked** — live secrets never entered the repo.
- **`gemini_api_key.txt` was never tracked** — it was a runtime artifact.
- **Git history still contains the key.** It is recoverable via `git show dd4554d:server.ts` (and any commit that touched the file).

## Decision

**Leave the history as-is.** Rotate the key in Google Cloud Console instead of rewriting git history.

### Rationale

- The key is stale — rotation invalidates it regardless of history exposure.
- History rewriting (git-filter-repo) changes all commit SHAs, requires force-push, and breaks any existing clones/forks.
- The repo is public but the key was a personal Google AI key with limited scope.
- The cost of rewriting history outweighs the benefit when rotation achieves the same security outcome.

## Action Items

- [x] Key rotated in Google Cloud Console (user action)
- [x] `server.ts` deleted from working tree (Phase 1.1)
- [x] Pre-commit hook added — `.githooks/pre-commit` runs gitleaks on staged files (`npm run hooks:install`); CI (`secret-scan` job) enforces server-side

## Related

- Phase 1.1 cleanup commit: `6b8f2a8`
- Original commit with key: `dd4554d`
