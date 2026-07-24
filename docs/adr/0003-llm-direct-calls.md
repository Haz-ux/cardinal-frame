# ADR 0003: LLM provider integration — direct calls via fetch

Date: 2026-07-24
Status: Accepted

## Context

The gap closure plan noted "No @anthropic-ai/sdk or openai package in package.json" as a missing LLM provider integration. The plan asked us to confirm: does Cardinal Frame call models directly, or only orchestrate inference over the node architecture?

## Decision

**Cardinal Frame calls models directly** using raw `fetch()` against provider APIs. No SDK packages are needed.

**Existing infrastructure:**
- `src/server/routes/llm-helpers.mjs` — provider-agnostic adapter with 12 providers mapped (NVIDIA, OpenAI, Anthropic, Groq, OpenRouter, Together, DeepSeek, Mistral, Cerebras, SambaNova, Perplexity, xAI, Cohere)
- `buildProviderAuth(provider, url)` — handles both Bearer token and `x-api-key` (Anthropic) auth
- `buildChatUrl(baseUrl, providerType, modelId, stream)` — routes to `/chat/completions` or `/messages`
- `buildChatPayload(providerType, modelId, messages, stream)` — formats OpenAI or Anthropic message shapes
- `callAgentLLM(messages, modelOverride)` — agent loop LLM calls with automatic provider routing
- `callAgentLLMWithRetry(messages, modelOverride, maxRetries)` — retry with backoff for 429s
- `callAgentLLMWithToolsRetry(messages, toolDefs, model)` — tool-use with retry
- `chat-completions.mjs` — streaming chat with fallback provider chain
- Provider detection: auto-fetches model lists from `/models` endpoint, stores in `llm_providers` + `llm_models` tables

**Why raw fetch over SDKs:**
- 12 providers with one code path — SDKs would require 12 different packages with incompatible interfaces
- Provider-specific auth and payload formatting is ~100 lines in `llm-helpers.mjs` vs. N adapter packages
- No SDK lock-in — adding a provider is a config entry, not a dependency
- Streaming works identically across providers via the OpenAI-compatible SSE format (Anthropic has its own format, handled in the adapter)

## Consequences

- Cardinal Frame is NOT control-plane only — it directly calls model inference APIs
- The adapter layer in `llm-helpers.mjs` IS the "services/llm/ module with provider-agnostic interface" the plan asked for
- Adding a new provider: add entry to `PROVIDER_TYPES`, implement any non-standard auth/payload formatting in `buildProviderAuth` and `buildChatPayload`
- This is documented in ARCHITECTURE.md as part of the API surface

## Active provider

Default: NVIDIA NIM (`integrate.api.nvidia.com/v1`), model `z-ai/glm-5.2`
Configured via `.env` with `NVIDIA_API_KEY` — keys are never committed, stored only in `.env` (gitignored).
