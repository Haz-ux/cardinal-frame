# ADR-0011: Provider Abstraction — Cardinal Frame Calls Models Directly

**Date:** 2026-07-24
**Status:** Accepted
**Deciders:** Architect (Shane Jordan)
**Context:** Comparative analysis flagged "no provider abstraction layer" as a P0 gap after finding no LLM SDK in `package.json`. This ADR documents the actual state and the decision going forward.

## Context

The comparative analysis (OpenClaw vs Hermes Agent vs Cardinal Frame) reported:

> Cardinal Frame currently has no LLM SDK dependency at all (confirmed via package.json audit) — this is either a deliberate boundary or an unaddressed gap.

This was **incorrect**. Direct inspection of `src/server/routes/llm-helpers.mjs` reveals Cardinal Frame already has a provider abstraction:

- **15 providers supported:** OpenAI, Google, NVIDIA NIM, Anthropic, OpenRouter, Groq, Together AI, DeepSeek, Mistral, Cerebras, SambaNova, Perplexity, xAI, Cohere, Ollama
- **Three abstraction functions:** `buildProviderAuth()`, `buildChatUrl()`, `buildChatPayload()` — provider-specific auth, URL construction, and payload formatting
- **DB-backed provider registry:** `llm_providers` and `llm_models` tables with CRUD routes, auto-detection, and per-provider configuration
- **No SDK dependency by design:** Uses raw `fetch()` instead of vendor SDKs — avoids dependency bloat and supply-chain surface
- **Three chat format families:** openai (12 providers), anthropic (1), google (1), ollama (1)

The analysis missed this because it only checked `package.json` for SDK packages (`@anthropic-ai/sdk`, `openai`). Cardinal Frame's philosophy is the opposite: no vendor SDKs, just raw HTTP.

## Decision

**Cardinal Frame calls models directly.** This is the current state and the intended direction.

The provider abstraction already exists in `llm-helpers.mjs` and is sufficient for current needs. We do NOT need OpenClaw's three-layer split (provider-runtime / llm-providers / model-catalog) because:

1. `llm-helpers.mjs` already handles provider-specific auth, URL, and payload formatting
2. `llm_providers` / `llm_models` DB tables already serve as the model catalog
3. Raw `fetch` is preferred over SDK dependencies (smaller attack surface, no version lock-in)
4. Adding a new provider is a single object entry in `PROVIDER_TYPES` + handling in the three build functions

## What's Missing (and worth doing later)

The abstraction exists but is not formally layered. If we ever need to:

- **Add streaming support per-provider** — currently streaming is a `stream: true` flag but SSE parsing is inconsistent across providers
- **Add retry/timeout per-provider** — currently no per-provider retry logic
- **Support a future MINERVA-hosted local model** — would need a new `local-server` provider type pointing to IKARIS/MINERVA endpoints

These are P2 improvements to the existing abstraction, not a new layer to build.

## Consequences

- ✅ No SDK dependencies to maintain or pin
- ✅ Adding providers is a single-file change (`llm-helpers.mjs`)
- ✅ DB-backed provider registry allows runtime configuration without code changes
- ⚠️ Must manually handle provider API changes (no SDK to update)
- ⚠️ No automatic retry/streaming — must implement per-provider if needed
- ⚠️ Comparative analysis's P2 "provider abstraction layer" item is N/A — already exists
