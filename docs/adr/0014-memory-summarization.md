# ADR-0014: Memory Session-Search Summarization

**Date:** 2026-07-24
**Status:** Accepted
**Deciders:** Architect (Shane Jordan)
**Context:** Comparative analysis (§3.4 / §4.4) flagged that Cardinal Frame's memory-search route existed but didn't include LLM summarization of search results.

## Context

The comparative analysis against Hermes Agent noted that Hermes pairs full-text search with an LLM-generated summary of what a past session was about — making memory retrieval useful for a human skimming results, not just for agent context injection. Cardinal Frame's `/api/memory` and `/api/search` routes returned raw FTS5 results with no summarization.

## Decision

Add an optional `?summary=true` query parameter to three routes:
- `GET /api/memory?summary=true` — list/search memories with summaries
- `GET /api/memory/:id?summary=true` — single memory with summary
- `GET /api/search?summary=true&q=...` — session search with summaries

### Implementation

- A shared `generateSummaries(callAgentLLM, items)` helper at module level handles all LLM calls
- Uses `callAgentLLM` from `agent.mjs` — routes through whatever provider is configured (NVIDIA NIM by default)
- System prompt identifies as "Aimi, the Cardinal Frame AI assistant" (not Hermes)
- **Graceful degradation**: if `callAgentLLM` throws (no provider, network error), the helper catches and returns an empty summaries array — the caller still gets results, just without summaries
- Response shape with `?summary=true`: `{ results: [...], summaries: [{ id, summary }] }`
- Response shape without: bare array (backward-compatible)

### Response format

```json
{
  "results": [{ "id": "...", "content": "..." }],
  "summaries": [{ "id": "...", "summary": "Concise 2-3 sentence summary." }]
}
```

## Consequences

- ✅ Memory search results are now human-consumable, not just machine-readable
- ✅ Backward-compatible — `?summary` is opt-in
- ✅ Graceful degradation — no provider = no summaries, but results still return
- ⚠️ N+1 LLM calls — each result gets its own summary call (could batch in future)
- ⚠️ Adds latency to summary-enabled requests (proportional to result count)
