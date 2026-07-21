# Cardinal Frame → Production Roadmap
## Surpassing Hermes Agent & Other Frameworks

*Last updated: July 18, 2026*

---

## Current State Assessment

### What's Built (Status: ✅ Working)
- 152 API endpoints across 14 feature areas
- 29 React components (8,203 LOC total)
- 30 DB tables with prepared statements
- WebSocket server (path: `/ws`) — broadcasts task status, agent events
- SSE streaming chat with provider failover (429/5xx → fallback provider)
- Self-learning loop: autoObserve → patterns → auto-propose → validate → confidence tracking
- Aimi coding agent: 11 endpoints, Suggest/Agent/Chat mode toggle, sandbox at `/home/haz/ai-workspace/`
- LLM provider system: 478 models across NVIDIA + OpenRouter, OpenAI/Anthropic/Ollama types
- Cyberpunk HUD UI: dashboard sparklines, heatmaps, cost tracking, neural map graph, DAG editor
- MCP server integration (connect/invoke tools)
- JWT auth + RBAC + rate limiting + bcrypt + audit log
- DAG orchestration (create/run/execute-chain tasks with dependencies)
- Schedules (cron-parser), file watchers, plugins system
- Agent groups with broadcast + batch task assignment

### What's Missing vs Hermes (Status: ❌ Gap)
| Feature | Hermes | Cardinal Frame |
|---|---|---|
| Test suite | ✅ extensive | ❌ 0 test files |
| Agent autonomy loop | ✅ multi-step, real | ⚠️ single iterate endpoint, no loop |
| Persistent cross-session memory | ✅ memory tool | ❌ none |
| Session search (FTS5) | ✅ full | ❌ none |
| Skill library (real) | ✅ 30+ proven | ❌ 12 stubs, 0 real skills |
| Agent delegation (subagents) | ✅ delegate_task | ❌ none |
| Error handler middleware | ✅ robust | ❌ none (unhandled errors crash) |
| Streaming reconnect/recovery | ✅ handles disconnects | ⚠️ SSE only, no client reconnect |
| CI/CD pipeline | ✅ | ❌ |
| Docker/deployment | ✅ | ❌ |
| CLI tool | ✅ full | ⚠️ exists but untested |
| Code execution sandbox | ✅ execute_code | ⚠️ basic /api/tools/code-exec |
| Image/vision support | ✅ vision tool | ❌ none |
| Multi-platform messaging | ✅ 6 platforms | ❌ web only |
| Conversation summarization | ✅ context compaction | ⚠️ compress-context exists, weak |
| Provider cost tracking (real) | ⚠️ basic | ⚠️ token_usage stored, not computed |
| Request queuing | ✅ | ❌ rate-limit errors pass through |
| Background processes | ✅ process tool | ❌ none |
| Cron-driven autonomy | ✅ cronjob tool | ⚠️ schedules exist, no auto-execute |

### What Cardinal Frame Has That Hermes Doesn't (Advantages to Amplify)
| Feature | Cardinal Frame | Hermes |
|---|---|---|
| Visual UI / cyberpunk HUD | ✅ world-class | ❌ none |
| Neural map graph (Obsidian-style) | ✅ | ❌ |
| DAG visual editor | ✅ | ❌ |
| LLM model marketplace browser | ✅ 478 models | ❌ 1 provider |
| Self-learning skill loop | ✅ autonomous | ⚠️ manual skills |
| Agent mode toggle (Copilot-style) | ✅ | ❌ all-or-nothing |
| Real-time task broadcast UI | ✅ WS + live logs | ❌ |
| Cost tracking dashboard | ✅ | ❌ |
| Telemetry bar (CPU/GPU/NPU/temp) | ✅ | ❌ |

---

## The Plan: 5 Phases to Surpass

### Phase 1: Foundation Hardening (1-2 weeks)
*Fix what's broken before adding features.*

#### 1.1 Test Framework + Critical Tests
**Goal:** Zero → meaningful test coverage on critical paths.

- [ ] Install Vitest + supertest for Express
- [ ] Test auth flow (login, token refresh, RBAC)
- [ ] Test agent endpoints (all 11 — moved past catch-all, must stay working)
- [ ] Test learn endpoints (observe, propose, validate)
- [ ] Test LLM failover logic
- [ ] Test path traversal guard + command blocklist
- [ ] Test DAG execution chain
- [ ] Test WebSocket connection + broadcast
- [ ] Target: 60% coverage on server, 80% on safety-critical paths

#### 1.2 Error Handling + Resilience
**Goal:** Server never crashes on bad input or provider failure.

- [ ] Express error handler middleware (after all routes, before static)
- [ ] Async error wrapper — catches in route handlers automatically
- [ ] Provider failure queue: on 429/5xx, queue request → retry with backoff → fallback provider
- [ ] SSE client reconnect: heartbeat ping every 15s, last-event-id resume
- [ ] Graceful shutdown: SIGTERM → close WS, drain in-flight, close DB
- [ ] Request validation middleware (zod or hand-rolled schema for every POST body)

#### 1.3 DB Migrations System
**Goal:** No more "drop table to fix schema."

- [ ] Migration runner: reads `/migrations/` folder, tracks applied in `_migrations` table
- [ ] Convert all `CREATE TABLE IF NOT EXISTS` → numbered migrations
- [ ] Migration: seed skill templates (deploy, search, create, monitor — based on existing patterns)

#### 1.4 Observability
**Goal:** Know what's happening in production.

- [ ] Structured logs (Winston → already have, add JSON format option)
- [ ] Request ID tracking — trace a request end-to-end across provider calls
- [ ] Enhanced health endpoint: `/api/health` returns DB size, WS connections, provider status, memory
- [ ] Slow query logging (>100ms SQLite queries)

---

### Phase 2: Agent Engine (2-3 weeks)
*Match and exceed Hermes' agent capabilities.*

#### 2.1 Real Agent Loop
**Goal:** Aimi autonomously completes multi-step coding tasks.

Current state: `/api/agent/iterate` is a single LLM call → one action. No loop.

- [ ] Server-side agent loop: `POST /api/agent/run` → spawns loop thread/worker
  ```js
  // Pseudocode
  while (steps < MAX_STEPS && !done) {
    action = await callAgentLLM(context + history)
    result = await executeAction(action)  // read/write/exec
    history.push(action, result)
    broadcast('agent:step', { step, action, result })
    if (action.done) break
    await sleep(RATE_LIMIT_DELAY)
  }
  ```
- [ ] Step limit: configurable (default 20, max 50)
- [ ] Rollback: track all file writes, support `POST /api/agent/sessions/:id/rollback`
- [ ] Diff generation: every write creates a unified diff, stored in `agent_actions.diff`
- [ ] Context window management: summarize action history when approaching token limit
- [ ] Agent session resume: `POST /api/agent/sessions/:id/resume` — pick up from last action

#### 2.2 Agent Tool System
**Goal:** Aimi can call real tools, not just file read/write/exec.

- [ ] Tool registry: `{ name, description, parameters, execute }` — registered server-side
- [ ] Built-in tools:
  - `web_search` — Tavily API (key available)
  - `web_fetch` — fetch URL, extract markdown
  - `file_search` — ripgrep across workspace
  - `file_read` — read with line numbers
  - `file_write` — write with diff tracking
  - `exec` — run command with timeout + blocklist
  - `code_exec` — Python sandbox (pyodide or subprocess)
  - `git` — git operations (status, diff, commit, push)
  - `mcp_invoke` — call registered MCP tools
  - `skill_invoke` — run a stored Cardinal Frame skill
- [ ] Tool calling protocol: use OpenAI function-calling format natively (not the `\`\`\`tool_call` hack)
- [ ] Tool execution results feed back into agent context automatically

#### 2.3 Multi-Agent Delegation
**Goal:** Aimi can spawn sub-agents for parallel work (match Hermes' delegate_task).

- [ ] `POST /api/agent/sessions/:id/delegate` — create child session
- [ ] Child sessions: isolated context, share parent workspace
- [ ] Parallel execution: up to N children (configurable, default 3)
- [ ] Result aggregation: child summaries merge into parent context
- [ ] Agent groups integration: delegate to a registered agent group instead of LLM
- [ ] WebSocket events: `agent:spawned`, `agent:completed`, `agent:failed`

#### 2.4 Persistent Memory
**Goal:** Aimi remembers across sessions.

- [ ] `memories` table: `{ id, user_id, category, content, created_at, last_accessed, access_count }`
- [ ] `POST /api/memory` — store a memory
- [ ] `GET /api/memory` — retrieve memories by category/query
- [ ] Memory injection: relevant memories auto-injected into system prompt
- [ ] Memory decay: old/unaccessed memories deprioritized (not deleted)
- [ ] Memory search: FTS5 across memory content
- [ ] Aimi auto-extracts memories from conversations (like Hermes' `memory` tool)
- [ ] Categories: `user` (preferences), `project` (facts), `memory` (agent notes)

#### 2.5 Session Search
**Goal:** Search past conversations and agent sessions.

- [ ] FTS5 index on `chat_messages` content
- [ ] `GET /api/search?q=...` — full-text search across messages, agent actions, memories
- [ ] Session timeline view: reconstruct any past conversation
- [ ] "What did we work on?" query → returns relevant sessions

---

### Phase 3: Skill System (1-2 weeks)
*Turn the self-learning loop into real, usable skills.*

#### 3.1 Skill Runtime
**Goal:** Skills are executable, not just metadata.

- [ ] Skill format: `{ name, trigger, template, script, parameters, validation }`
- [ ] Skill execution engine:
  - Template skills: LLM prompt template → streaming response
  - Script skills: server-side JS function → direct result
  - Hybrid: script calls LLM with template + tools
- [ ] `POST /api/skills/:id/execute` — run a skill with parameters
- [ ] Skill chaining: skill A → skill B → skill C (DAG of skills)
- [ ] Skill versioning: track skill versions, rollback

#### 3.2 Auto-Invocation
**Goal:** High-confidence skills auto-trigger on matching patterns.

- [ ] Pattern matching engine: when user input arrives, check against skill triggers
- [ ] Confidence threshold: >0.8 auto-run, 0.5-0.8 suggest, <0.5 ignore
- [ ] UI: when Aimi detects a skill match, show "Run skill X?" prompt
- [ ] Feedback loop: auto-invocation results feed back into confidence scores
- [ ] Skill marketplace: share skills between users (future: public registry)

#### 3.3 Seed Skill Library (20 skills)
**Goal:** Cardinal Frame ships with useful skills out of the box.

- [ ] **devops**: deploy-check, log-analyzer, health-probe
- [ ] **development**: code-review, debug-trace, refactor-suggest
- [ ] **research**: web-research, paper-summarize, fact-check
- [ ] **productivity**: meeting-notes, task-breakdown, status-report
- [ ] **data**: sql-query, data-profile, chart-suggest
- [ ] **ai**: prompt-optimize, model-compare, rag-search
- [ ] **system**: disk-check, process-kill, port-scan

Each skill: trigger pattern + template + validation criteria + auto-approve rules.

#### 3.4 Skill Learning Loop Enhancement
**Goal:** Aimi gets smarter from every interaction.

- [ ] Observation enrichment: track user edits to Aimi's suggestions (implicit feedback)
- [ ] Pattern clustering: group similar patterns → generalize skill triggers
- [ ] A/B testing: when two skills match, run both, compare results, update confidence
- [ ] Skill competition: similar skills compete; winner absorbs loser
- [ ] Decay: unused skills lose confidence, eventually archived

---

### Phase 4: Real-Time & Infrastructure (1-2 weeks)
*Make it production-deployable.*

#### 4.1 WebSocket Upgrade
**Goal:** Real-time everything.

Current: WS exists for task status only.

- [ ] Agent action streaming: `ws://host/ws/agent/:sessionId` — real-time agent steps
- [ ] Chat streaming over WS (instead of SSE): better reconnect, binary support
- [ ] Live collaboration cursor: show when another user is viewing same page
- [ ] Notification system: WS push for completed tasks, errors, skill suggestions
- [ ] Heartbeat + reconnect logic in frontend

#### 4.2 Background Jobs
**Goal:** Long-running tasks don't block the event loop.

- [ ] Job queue: `jobs` table — `{ id, type, status, payload, result, created_at, started_at, completed_at }`
- [ ] Worker: separate thread/process for CPU-heavy work
  - DAG execution
  - LLM inference (agent loops)
  - File processing
  - Skill validation
- [ ] `POST /api/jobs` — submit, `GET /api/jobs/:id` — poll status
- [ ] WebSocket: job status pushed to client
- [ ] Timeout: 5min max per job, configurable

#### 4.3 Cron-Driven Autonomy
**Goal:** Aimi works while you sleep.

- [ ] Schedule → agent session: cron triggers agent loop with predefined task
- [ ] Schedule → skill: cron triggers skill execution
- [ ] Example: every night at 2am, Aimi reviews new patterns → proposes skills
- [ ] Email/notification on completion (webhook integration)
- [ ] Schedule UI: drag-and-drop pipeline builder (DAG editor → schedule)

#### 4.4 Deployment
**Goal:** One command to deploy.

- [ ] Dockerfile: multi-stage build (client build → Node server)
- [ ] docker-compose.yml: Cardinal Frame + optional Ollama + reverse proxy
- [ ] `.env.example` with all required variables
- [ ] Health check endpoint → Docker HEALTHCHECK
- [ ] Automated backup: SQLite DB backup every 6h, keep 7 copies

#### 4.5 CI/CD
**Goal:** Tests run on every push.

- [ ] GitHub Actions: lint → test → build → docker push
- [ ] PR checks: coverage must not decrease
- [ ] Staged deploys: dev → staging → prod
- [ ] E2E tests with Playwright (devDependency already installed)

---

### Phase 5: Surpass — Unique Differentiators (2+ weeks)
*Features no other agent framework has.*

#### 5.1 Visual Agent Builder
**Goal:** Build agents by dragging, not coding.

- [ ] Extend DAG editor → "Agent Designer"
- [ ] Nodes: tool calls, LLM calls, conditionals, loops, skill invocations
- [ ] Visual wiring: connect nodes to define agent flow
- [ ] Live preview: run agent in sandbox, watch execution path light up
- [ ] Export: save DAG as agent template → `POST /api/agents/from-dag`

#### 5.2 Multi-Model Routing
**Goal:** Aimi picks the best model for each task.

- [ ] Model router: classify task → route to optimal model
  - Simple chat → small model (fast, cheap)
  - Code generation → coding model (deepseek-coder, etc.)
  - Analysis → reasoning model (o3-style)
  - Vision tasks → vision model
- [ ] Cost optimization: estimate cost before call, use cheaper model when confidence is high
- [ ] Model comparison: run same prompt through 3 models, show diffs in UI
- [ ] Fallback chains: provider A → B → C with cost-aware ordering

#### 5.3 Knowledge Graph + RAG
**Goal:** Aimi has deep project knowledge.

- [ ] File content indexing: each file → embedding → stored in `embeddings` table
- [ ] Code graph: AST analysis → function/class relationships as edges
- [ ] Neural Map shows: file dependencies, function call graphs, class hierarchies
- [ ] RAG: when Aimi answers, retrieve relevant code snippets from graph
- [ ] Auto-update graph on file change (file watcher → re-index)
- [ ] Embedding model: lightweight local (MiniLM) loaded on demand, unloaded to save GPU

#### 5.4 Adaptive Context Management
**Goal:** Handle 200K+ token conversations gracefully.

- [ ] Conversation compaction: summarize old messages when approaching limit
- [ ] Smart context fetch: only include relevant past messages (vector similarity)
- [ ] Context budget: allocate tokens across system prompt, history, RAG results, tool outputs
- [ ] "Memory palace": hierarchical context — working memory (recent) → short-term (session) → long-term (persistent)
- [ ] Context visualization: show what's in the context window (like Hermes' compaction summary)

#### 5.5 Voice + Mobile
**Goal:** Talk to Aimi anywhere.

- [ ] Voice: Web Speech API → speech-to-text → Aimi → text-to-speech response
- [ ] PWA: installable, offline-capable, push notifications
- [ ] Mobile-responsive: touch-friendly UI for phone/tablet
- [ ] Telegram/Discord bridge: Aimi accessible from messaging platforms (like Hermes)

#### 5.6 Self-Improvement — Aimi Improves Itself
**Goal:** Aimi uses the coding agent to improve Cardinal Frame's own codebase.

*Like Claude being used to build the next Claude, but agent-driven and visible in the UI.*

**How it works (the loop):**
```
1. SCAN — Aimi reads the codebase, identifies improvement targets:
   - Missing tests (grep for untested endpoints)
   - Code smells (duplication, long functions, missing error handling)
   - Performance (N+1 queries, blocking calls, large bundles)
   - TODOs and FIXMEs in the code
   - Roadmap items not yet implemented

2. PROPOSE — For each target, Aimi generates a plan:
   - "Add tests for /api/agent endpoints" (3 test files, ~150 LOC)
   - "Refactor server.mjs route registration into modules" (split 4500-line file)
   - "Add error handler middleware" (new middleware, 1 file)

3. EXECUTE — Agent mode runs the plan:
   - Creates a git branch: aimi/improve-{timestamp}
   - Reads the target file → writes the change → runs tests
   - If tests pass: commits to branch
   - If tests fail: iterates (fixes the change, retries up to 3x)
   - If still failing: stashes, marks as "needs human review"

4. REVIEW — Suggest mode shows the diff in the WorkPanel:
   - User sees the change with syntax-highlighted diff
   - "Approve" → merge branch to main
   - "Reject" → delete branch, log as false positive
   - Feedback feeds into Aimi's learning loop (observation + pattern)

5. LEARN — The outcome updates Aimi's confidence:
   - Approved changes → reinforce the pattern that led to the proposal
   - Rejected changes → deprioritize that pattern
   - Over time, Aimi learns what improvements you value
```

**Prerequisites (must be done first):**
- [ ] Phase 1.1 — Test suite (Aimi needs tests to validate its changes)
- [ ] Phase 2.1 — Real agent loop (multi-step, not single iterate)
- [ ] Phase 2.2 — Tool system (git, file_search, file_read, file_write, exec)

**Implementation:**
- [ ] Trusted path expansion: agent mode can target `/home/haz/cardinal-frame/cardinal-frame/` when `self_improve: true` flag is set
- [ ] Git tools:
  - `git_status` — show modified files
  - `git_diff` — show uncommitted changes
  - `git_commit` — commit with message (enforces conventional commits)
  - `git_branch` — create/switch/delete branches
  - `git_stash` — stash changes (for rollback)
  - `git_merge` — merge branch (only in Suggest mode, requires approval)
- [ ] Self-improvement scanner:
  - `POST /api/aimi/self-improve` — triggers a scan of the codebase
  - Returns list of improvement targets with confidence scores
  - Each target includes: file, line range, issue type, proposed change
- [ ] Self-improvement executor:
  - Takes a target → spawns agent session in Suggest mode
  - Agent creates branch → applies change → runs tests → reports
  - WorkPanel shows full diff with approve/reject
- [ ] Safety guardrails:
  - Never auto-merge to main (always Suggest mode for self-improvement)
  - Max 5 changes per session (prevent runaway)
  - Cannot modify its own safety guardrails (meta-protection)
  - Cannot delete files (only modify/create)
  - Must pass all existing tests before proposing merge
  - Diff size limit: 500 LOC per change
- [ ] Learning loop integration:
  - Each self-improvement attempt logged as `learn_observations`
  - Pattern: "code smell type X → proposed fix Y → approved/rejected"
  - Over time, Aimi learns which improvements you accept and proposes more of those
- [ ] UI: `Self-Improve` tab in the Learn page
  - Shows pending improvement targets
  - Shows history of self-improvements (approved/rejected/needs-review)
  - "Run scan" button to trigger a new codebase analysis
  - Diff viewer for reviewing proposed changes

**Bootstrapping scenario (the cool part):**
```
Day 1: Aimi adds tests for the 11 agent endpoints (Phase 1.1)
Day 2: Using those tests as a safety net, Aimi refactors server.mjs into modules
Day 3: Aimi adds error handler middleware (because it noticed unhandled errors)
Day 4: Aimi adds missing validation on POST endpoints (learned from test failures)
Day 5: Aimi optimizes the neural map query (it was slow, Aimi noticed in logs)
...
Day 30: Cardinal Frame has improved itself significantly, all changes human-approved
```

This is the real differentiator. No agent framework improves its own codebase autonomously.


---

## Priority Order

1. **Phase 1** (Foundation) — must do first, prevents everything else from being fragile
2. **Phase 2.1-2.2** (Agent Loop + Tools) — highest impact, makes Aimi actually useful
3. **Phase 3.1-3.2** (Skill Runtime + Auto-invoke) — closes the self-learning loop
4. **Phase 2.4** (Persistent Memory) — Aimi remembering you is table stakes
5. **Phase 4.1** (WebSocket Upgrade) — real-time UX is expected
6. **Phase 5.6** (Self-Improvement) — Aimi improves its own codebase; needs Phases 1+2 first
7. **Phase 5.3** (Knowledge Graph + RAG) — unique differentiator, leverages existing neural map
8. Everything else — accelerates quality and reach

## Success Metrics

| Metric | Current | Target (3mo) | Hermes (reference) |
|---|---|---|---|
| Test coverage | 0% | 70% | ~80% |
| Agent steps (autonomous) | 1 | 50+ | 50+ |
| Real skills | 0 | 20 | 30+ |
| Provider failover | basic | cost-aware routing | basic |
| Memory | none | FTS5 + categories | FTS5 + categories |
| Real-time updates | task status | everything | everything |
| Concurrent users | ~1 | 10+ | 10+ |
| Uptime (no crashes) | ?? | 99.9% | 99.9% |

---

## The Killer Feature

**Cardinal Frame's differentiator isn't one feature — it's the convergence:**

Hermes has power but no interface. Cursor has an editor but no self-learning. OpenDevin has agents but no visual workspace.

Cardinal Frame will have:
1. **Self-improvement** (Aimi improves its own codebase — the Claude bootstrapping loop)
2. **Visual agent builder** (drag-and-drop agent design)
3. **Self-learning skill system** (Aimi improves from every interaction)
4. **478-model marketplace** (right model for each task, auto-routed)
5. **Knowledge graph RAG** (Aimi understands your entire codebase)
6. **Cyberpunk HUD** (everything visible, nothing overwhelming)

No other framework combines all six. That's the moat.
