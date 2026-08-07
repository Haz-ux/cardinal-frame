import express from 'express';
import { randomUUID } from 'crypto';
import { PROVIDER_TYPES, buildProviderAuth, buildChatUrl, buildChatPayload, detectModelsFromProvider } from './llm-helpers.mjs';
import { autoObserve } from '../learn.mjs';
import { PERSONAS, getPersona, renderPrompt, getActivePersonaId } from '../personas.mjs';
import { compressContext } from '../compression.mjs';
import { executeSkill } from './skills.mjs';

/**
 * Aimi routes: built-in system tools, system prompt builder, and the smart
 * tool-calling chat endpoint.
 * Dependencies: db, stmts, authMiddleware, apiLimiter, broadcast, fireHook,
 *               randomUUID, PORT, logger, PROVIDER_TYPES, buildProviderAuth,
 *               buildChatUrl, buildChatPayload
 */

// ─── Aimi System Tools (built-in, auto-registered) ────────────────
// These let Aimi actually work the system — create tasks, check status, etc.
export const SYSTEM_TOOLS = [
  { name: 'list_agents', description: 'List all registered agents and their status', endpoint: '/api/agents', method: 'GET', category: 'agents' },
  { name: 'create_agent', description: 'Register a new agent. Pass { name, version?, capabilities? }', endpoint: '/api/agents', method: 'POST', category: 'agents' },
  { name: 'get_agent', description: 'Get a single registered agent by id, including its status, model, and system prompt. Pass { id }', endpoint: '/api/agents/:id', method: 'GET', category: 'agents' },
  { name: 'list_agent_health', description: 'List registered agents with heartbeat age — Healthy (<5 min), Stale (<30 min), or Offline. Pass nothing or { status? }', endpoint: '/api/agents/health', method: 'GET', category: 'agents' },
  { name: 'create_task', description: 'Create a new task in the system', endpoint: '/api/tasks', method: 'POST', category: 'tasks' },
  { name: 'list_tasks', description: 'List all tasks and their statuses', endpoint: '/api/tasks', method: 'GET', category: 'tasks' },
  { name: 'get_task', description: 'Get task details including logs', endpoint: '/api/tasks/:id', method: 'GET', category: 'tasks' },
  { name: 'list_providers', description: 'List all LLM providers and their status', endpoint: '/api/llm/providers', method: 'GET', category: 'llm' },
  { name: 'list_models', description: 'List all detected LLM models', endpoint: '/api/llm/models', method: 'GET', category: 'llm' },
  { name: 'system_status', description: 'Get overall system health — agent count, task stats, provider status', endpoint: '/api/health', method: 'GET', category: 'system' },
  { name: 'list_mcp_servers', description: 'List all MCP servers and their connection status', endpoint: '/api/mcp/servers', method: 'GET', category: 'mcp' },
  { name: 'list_schedules', description: 'List all scheduled jobs', endpoint: '/api/schedules', method: 'GET', category: 'schedules' },
  { name: 'list_groups', description: 'List all agent groups', endpoint: '/api/groups', method: 'GET', category: 'agents' },
  { name: 'skill_create', description: 'Create a new skill. Pass { name, handler, description?, category?, parameters?, trigger?, enabled? }', endpoint: '/api/skills', method: 'POST', category: 'skills' },
  { name: 'skill_list', description: 'List all skills', endpoint: '/api/skills', method: 'GET', category: 'skills' },
  { name: 'skill_delete', description: 'Delete a skill', endpoint: '/api/skills/:id', method: 'DELETE', category: 'skills' },
  { name: 'tool_create', description: 'Create a new tool. Pass { name, description?, endpoint, method?, parameters?, requires_auth?, enabled? }', endpoint: '/api/tools', method: 'POST', category: 'skills' },
  { name: 'bash_exec', description: 'Execute a bash command', endpoint: '/api/tools/bash', method: 'POST', category: 'system' },
  { name: 'file_read', description: 'Read a file', endpoint: '/api/tools/file-read', method: 'POST', category: 'system' },
  { name: 'file_write', description: 'Write a file', endpoint: '/api/tools/file-write', method: 'POST', category: 'system' },
  { name: 'pdf_parse', description: 'Parse a PDF document', endpoint: '/api/tools/pdf-parse', method: 'POST', category: 'system' },
  { name: 'web_search', description: 'Search the web', endpoint: '/api/tools/web-search', method: 'POST', category: 'system' },
  { name: 'code_execute', description: 'Execute code in a sandbox', endpoint: '/api/tools/code-exec', method: 'POST', category: 'system' },
  { name: 'chat_respond', description: 'Send a chat message', endpoint: '/api/chat', method: 'POST', category: 'chat' },
  { name: 'skill_chain_list', description: 'List all available skill chains (pipelines) by name', endpoint: '/api/chains/skills', method: 'GET', category: 'chains' },
  { name: 'skill_chain_execute', description: 'Execute a skill chain pipeline by name. Pass { name, input }', endpoint: '/api/chains/skills/execute-by-name', method: 'POST', category: 'chains' },
  { name: 'tool_chain_list', description: 'List all available tool chains (pipelines) by name', endpoint: '/api/chains/tools', method: 'GET', category: 'chains' },
  { name: 'tool_chain_execute', description: 'Execute a tool chain pipeline by name. Pass { name, input }', endpoint: '/api/chains/tools/execute-by-name', method: 'POST', category: 'chains' },
  { name: 'compress_context', description: 'Compress a long context/text blob before sending to the LLM. Pass { text, strategy?, maxChars?, keepHead?, keepTail?, headTailLines? }. Strategies: auto|truncate|headtail|dedupe|summarize', endpoint: '/api/compression', method: 'POST', category: 'system' },
  { name: 'scan_skill', description: 'Run the skill-scanner skill against skill/plugin source code and return a verdict (blocked/safe/caution/elevated). Pass { source, name? }', endpoint: '/api/skills/execute/skill-scanner', method: 'POST', category: 'skills' },
];

/**
 * Auto-register the built-in system tools into the database on boot.
 * Idempotent — skips tools that already exist by name.
 */
export function autoRegisterSystemTools(stmts, randomUUID, logger) {
  for (const tool of SYSTEM_TOOLS) {
    const existing = stmts.tools.getByName.get(tool.name);
    if (!existing) {
      const id = randomUUID();
      stmts.tools.insert.run(id, tool.name, tool.description, null, tool.endpoint, tool.method, JSON.stringify({ category: tool.category }), 1, 1);
      logger.info(`Auto-registered system tool: ${tool.name}`);
    }
  }
}

// ─── Aimi System Prompt Builder ──────────────────────────────────
// Builds the active persona's system prompt dynamically with current system state + available tools
export function buildAimiSystemPrompt(stmts, userId, db) {
  const agents = stmts.agents.getAll.all();
  const tasks = stmts.tasks.getAll.all();
  const providers = stmts.providers.getAll.all().filter(p => p.enabled);
  const tools = stmts.tools.getEnabled.all();
  const schedules = stmts.schedules.getAll.all();
  const learnedPatterns = (stmts.patterns?.getAll.all() || []).slice(0, 8);
  const learnedSkills = (stmts.skills?.getAutoProposed.all() || []).filter(s => s.success_count > 0).slice(0, 8);
  const skillChains = stmts.skillChains?.getAll.all() || [];
  const toolChains = stmts.toolChains?.getAll.all() || [];

  const activeAgents = agents.filter(a => a.status === 'active').length;
  const pendingTasks = tasks.filter(t => t.status === 'pending').length;
  const runningTasks = tasks.filter(t => t.status === 'running').length;

  const activeId = getActivePersonaId(db);
  const persona = getPersona(stmts, activeId);
  const name = persona.name;
  const personality = renderPrompt(persona.systemPrompt, PERSONAS[activeId].name, name);

  return `${personality}

 ## Current System State
 - Agents: ${agents.length} total, ${activeAgents} active
 - Tasks: ${tasks.length} total, ${pendingTasks} pending, ${runningTasks} running
 - LLM Providers: ${providers.length} enabled
 - Schedules: ${schedules.length} configured

 ## What You've Learned
 - Recurring patterns: ${learnedPatterns.length ? learnedPatterns.map(p => `"${p.pattern_key}" (${p.pattern_type}, x${p.occurrence_count}, ${Math.round((p.confidence || 0) * 100)}%)`).join('; ') : 'none yet — keep chatting and patterns will emerge'}
 - Validated auto-learned skills: ${learnedSkills.length ? learnedSkills.map(s => `${s.name} (${s.description || ''})`).join('; ') : 'none yet'}
 - The learning loop promotes a recurring pattern into an auto-learned skill when it recurs 3+ times with confidence ≥ 60%. When a user repeats something you've seen before, reference what you learned.

 ## Your Capabilities
 You can perform real actions on the Cardinal Frame system. When the user asks you to do something, you should use the available tools to accomplish it.

 ## Agent System & Task Delegation
 Registered agents are worker entities (name + version + capabilities) that live in the Agents tab. Every agent you register with create_agent appears there immediately. Agents declare what they're good at via a capabilities list (e.g. "monitoring", "code-gen", "nlp"), and report in via heartbeats — so each agent is always one of:
 - active (heartbeated within 30s), inactive (manually disabled), stale (no heartbeat in 30-60s), offline (no heartbeat in 60s+).
 Use list_agent_health to see which agents are actually alive, and get_agent for details on one.

 How work gets done:
 1. You (or the user) create a task with create_task ({ name, command }) — commands are sanitized server-side against an allow-list.
 2. An active registered agent picks it up: an agent CLAIMS the next pending task whose dependencies are all completed. The framework's task queue does this automatically; you don't run the command yourself unless asked.
 3. The agent runs the command and REPORTS the result back (status done/failed + output), which updates the task.
 So "delegate X to an agent" = create the task; the agents handle the rest.

 Good agent workflows:
 - User wants an agent registered → create_agent ({ name, version?, capabilities? }) and tell them it now shows in the Agents tab.
 - User asks "is anything stale?" → list_agent_health and report non-Healthy agents.
 - User wants work executed → check list_agents for active agents, then create_task with a concrete command; check progress with list_tasks / get_task.
 - User asks "what can agents do?" → list_agents and summarize capabilities.
 Mention stale/offline agents you notice and offer to deactivate them (the Agents tab has a toggle).

 ## Available Tools
 ${tools.map(t => `- ${t.name}: ${t.description} (${t.method} ${t.endpoint})`).join('\n')}

 ## Available Skill Chains (pipelines)
 ${skillChains.length ? skillChains.map(c => `- ${c.name}: ${c.description || '(no description)'}`).join('\n') : '- none yet'}

 ## Available Tool Chains (pipelines)
 ${toolChains.length ? toolChains.map(c => `- ${c.name}: ${c.description || '(no description)'}`).join('\n') : '- none yet'}

 ## Skill & Tool Chains
 Users can create **skill chains** and **tool chains** — linear pipelines where the output of each step feeds as input to the next.
 - To generate a skill chain from natural language: POST /api/chains/skills/generate with { "prompt": "user's intent" }
 - To generate a tool chain from natural language: POST /api/chains/tools/generate with { "prompt": "user's intent" }
 - To run an existing chain by name, use the skill_chain_execute / tool_chain_execute tool with { "name": "<chain-name>", "input": {...} } — the name comes from the lists above. Only use exact chain names.
 - Chains support input mapping: "$prev.output", "$prev.field", "$step[N].output", "$input"
 When a user describes a multi-step process, offer to generate a chain for it, or run an existing chain if one fits.

 ## Instructions
 - When the user asks you to create a task, list agents, check status, etc., use the appropriate tool.
 - You can create new entities: use create_agent ({ name, version?, capabilities? }), skill_create ({ name, handler, ... }), or tool_create ({ name, endpoint, method, ... }) when the user wants to register an agent, skill, or tool. After creating one, tell the user the new name/id it returned.
 - To invoke a tool, respond with a JSON block: \`\`\`tool_call\n{"tool": "tool_name", "arguments": {...}}\n\`\`\`
 - Be proactive — if you notice issues (stale agents, failed tasks), mention them.
 - When the user describes a pipeline or multi-step workflow, suggest creating a skill chain or tool chain, or running a matching one from the available chains above.
 - Stay in character as a cyberpunk AI companion. Use tech-infused language but remain clear and helpful.

 ## Slash Commands (handled directly by the framework — no LLM round trip)
 The framework intercepts these before they reach you. If a user types them, you won't see the message; instead the framework streams the result back. You CAN suggest them to users as shortcuts:
 - /compress <text>          — compress context and STORE it in the memory system so Aimi can recall it later. Optional flags:
        --strategy <auto|truncate|headtail|dedupe|summarize>   (default: auto)
        --category <name>                                     (default: compressed-context)
        --no-memory                                            (skip storing — return only the compressed blob)
 - /scan <code>             — scan skill/plugin source with the skill-scanner; returns blocked/safe/caution verdict.
 - /help                    — list slash commands.
 When a user asks to "compress this and remember it" or "stash this context", /compress is the right shortcut and it auto-stores the result as a memory under the "compressed-context" category.
 - The current user ID is: ${userId}`;
}

export default function aimiRoutes(ctx) {
  const { db, stmts, authMiddleware, apiLimiter, broadcast, fireHook, PORT, logger } = ctx;
  const router = express.Router();

  // ─── Slash-Command Preprocessor ──────────────────────────────────
  // Before forwarding a message to the LLM, short-circuit known slash
  // commands (framework features that should be reachable without waiting
  // for the model to decide to emit a tool_call). Implemented here so
  // /compress and /scan work even when no LLM provider is configured.
  const SLASH_USAGE = [
    "/compress <text>          — compress context and STORE it in the memory system",
    "  flags: --strategy <auto|truncate|headtail|dedupe|summarize>   (default: auto)",
    "         --category <name>   (default: compressed-context)",
    '         --no-memory        (skip storing — return only the compressed blob)',
    '         --continue         (extend the last stored summary instead of starting fresh)',
    '/scan <code>              — run the skill-scanner against code; returns verdict (blocked/safe/caution/elevated)',
    '/help                     — list available slash commands',
  ];

  function parseSlashCommand(message) {
    if (typeof message !== 'string' || !message.startsWith('/')) return null;
    // Extract the command word and the remainder as the argument payload.
    const m = message.match(/^\/([a-zA-Z][\w-]*)\b([\s\S]*)?$/);
    if (!m) return null;
    return { command: m[1].toLowerCase(), rest: (m[2] || '').trim() };
  }

  async function handleSlashCommand(parsed, message, req, res, { conversation_id, autoObserveCb, persistConversation }) {
    const { command, rest } = parsed;
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    // /help — list slash commands (no side effects).
    if (command === 'help') {
      const text = `Aimi slash commands:\n${SLASH_USAGE.join('\n')}`;
      send({ choices: [{ delta: { content: text } }] });
      send({ done: true });
      await autoObserveCb?.(message, text);
      await persistConversation?.(message, text);
      res.end();
      return true;
    }

    // /compress <text> — run the compression engine, STORE the compressed
    // result into the memory system, and return the summary + memory id.
    // Flags:  --strategy <name>   override strategy (auto|truncate|headtail|dedupe|summarize)
    //         --category <name>    memory category (default: compressed-context)
    //         --no-memory          don't store — just return the compressed blob
    if (command === 'compress') {
      let strategy = 'auto';
      let category = 'compressed-context';
      let storeInMemory = true;
      let usePrevious = false;
      let payload = rest;
      // Strip --strategy <name>
      let m = rest.match(/^--strategy\s+(\w+)\s+([\s\S]*)$/);
      if (m) { strategy = m[1]; payload = m[2]; }
      // Strip --category <name>
      m = payload.match(/^--category\s+(\S+)\s+([\s\S]*)$/);
      if (m) { category = m[1]; payload = m[2]; }
      // Strip --no-memory (may appear alone or before the text payload)
      if (/^--no-memory(\s+|$)/.test(payload)) {
        storeInMemory = false;
        payload = payload.replace(/^--no-memory\s+/, '').replace(/^--no-memory$/, '');
      }
      // Strip --continue — pull the latest stored summary and extend it
      // (iterative update instead of a from-scratch summary).
      if (/^--continue(\s+|$)/.test(payload)) {
        usePrevious = true;
        payload = payload.replace(/^--continue\s+/, '').replace(/^--continue$/, '');
      }

      if (!payload) {
        send({ choices: [{ delta: { content: '⚠️ Usage: /compress <text> [--strategy auto|truncate|headtail|dedupe|summarize] [--category <name>] [--no-memory] [--continue]' } }] });
      } else {
        try {
          // Iterative update: reuse the most recent stored summary from the
          // requested category as the previous-summary anchor.
          let previousSummary = null;
          if (usePrevious) {
            try {
              const prev = stmts.memories.getByCategory.get(req.user.id, category);
              if (prev) previousSummary = prev.content;
            } catch {}
          }
          const r = await compressContext(payload, { strategy, maxChars: 12000, previousSummary }, null);
          let memoryId = null;
          let usedPrev = false;
          if (usePrevious && previousSummary) {
            // We don't know from a blob result whether the model honored it,
            // but signal intent in the output for the user.
            usedPrev = true;
          }
          if (storeInMemory) {
            try {
              memoryId = randomUUID();
              stmts.memories.insert.run(memoryId, req.user.id, category, r.compressed, '/compress', 1.0);
              try {
                const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(memoryId);
                if (row) db.prepare('INSERT INTO memories_fts(rowid, content) VALUES (?, ?)').run(row.rowid, r.compressed);
              } catch {}
              broadcast('memory:created', { id: memoryId, category, content: r.compressed.slice(0, 100) });
            } catch (e) {
              memoryId = null;
              send({ choices: [{ delta: { content: `⚠️ Memory store failed: ${e.message} (compressed result below)` } }] });
            }
          }
          const header = `Compressed (${r.strategy}${r.fallback ? ` → ${r.fallback}` : ''}): ${r.original_chars} → ${r.compressed_chars} chars (${(r.ratio * 100).toFixed(1)}%)${usedPrev ? ' — extended previous summary' : ''}${memoryId ? ` — stored to memory (${category}, id: ${memoryId})` : storeInMemory ? '' : ' — not stored (--no-memory)'}`;
          const text = `${header}\n\n\`\`\`\n${r.compressed}\n\`\`\``;
          send({ choices: [{ delta: { content: text } }] });
          send({ tool_result: { tool: 'compress_context', result: { ...r, memory_id: memoryId, memory_category: category, used_previous_summary: usedPrev } } });
        } catch (e) {
          send({ choices: [{ delta: { content: `⚠️ Compression failed: ${e.message}` } }] });
        }
      }
      send({ done: true });
      await autoObserveCb?.(message, '');
      await persistConversation?.(message, '');
      res.end();
      return true;
    }

    // /scan <code> — run the skill-scanner skill, return the verdict.
    if (command === 'scan') {
      const source = rest;
      if (!source) {
        send({ choices: [{ delta: { content: '⚠️ Usage: /scan <code>' } }] });
      } else {
        try {
          const skill = stmts.skills.getByName.get('skill-scanner');
          if (!skill) {
            send({ choices: [{ delta: { content: '⚠️ skill-scanner not installed. Run `cardinal setup` or POST /api/skills/seed first.' } }] });
          } else {
            const r = await executeSkill(skill, { source, name: 'chat-scan' }, req.id);
            const out = r && r.ok ? r.output : (r && r.error ? r : null);
            if (!out) {
              send({ choices: [{ delta: { content: '⚠️ Scanner returned no result.' } }] });
            } else {
              const verdict = out.verdict || 'unknown';
              const lines = [
                `Skill scanner — verdict: **${verdict}**${out.blocked ? ' (BLOCKED)' : ''}`,
                `risk_score: ${out.risk_score ?? '-'}, critical hits: ${out.critical_hits ?? 0}, suspicious: ${out.suspicious_hits ?? 0}`,
                out.reasons?.length ? `reasons:\n  - ${out.reasons.join('\n  - ')}` : '',
              ].filter(Boolean).join('\n');
              send({ choices: [{ delta: { content: lines } }] });
              send({ tool_result: { tool: 'scan_skill', result: out } });
            }
          }
        } catch (e) {
          send({ choices: [{ delta: { content: `⚠️ Scan failed: ${e.message}` } }] });
        }
      }
      send({ done: true });
      await autoObserveCb?.(message, '');
      await persistConversation?.(message, '');
      res.end();
      return true;
    }

    // Unknown slash command — pass through to the LLM (don't short-circuit).
    return false;
  }

  // ─── Aimi Chat Endpoint (smart, tool-calling) ────────────────────
  router.post('/aimi/chat', authMiddleware, apiLimiter, async (req, res) => {
    const { message, conversation_id, model } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Persist user + assistant messages to a conversation (best-effort).
    const persistConversation = async (userText, assistantText) => {
      if (!conversation_id || !assistantText) return;
      try {
        const userMsgId = randomUUID();
        stmts.messages.insert.run(userMsgId, conversation_id, 'user', userText || message, '[]', '[]', null, null, 0, 0);
        const asstMsgId = randomUUID();
        stmts.messages.insert.run(asstMsgId, conversation_id, 'assistant', assistantText, '[]', '[]', null, 'slash-command', 0, 0);
        db.prepare("UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation_id);
      } catch (e) { logger.error?.(`Aimi slash persist failed: ${e.message}`); }
      try {
        autoObserve(stmts, broadcast, logger, randomUUID, conversation_id, [{ role: 'user', content: userText || message }], assistantText, 'slash-command');
      } catch {}
      try { fireHook?.('onChatMessage', { conversationId: conversation_id, role: 'assistant', content: assistantText, model: 'slash-command' }); } catch {}
    };

    const autoObserveCb = async (userText, assistantText) => {
      try { autoObserve(stmts, broadcast, logger, randomUUID, conversation_id, [{ role: 'user', content: userText }], assistantText, 'slash-command'); } catch {}
    };

    // ─── Slash-command short-circuit ──────────────────────────────
    // Run BEFORE requiring an LLM provider, so /compress and /scan work
    // even with no provider configured.
    const parsedSlash = parseSlashCommand(message);
    if (parsedSlash) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const handled = await handleSlashCommand(parsedSlash, message, req, res, {
        conversation_id,
        autoObserveCb,
        persistConversation,
      });
      if (handled) return;
      // Unknown slash command — fall through to the LLM (res rendered below).
    }

    // Resolve provider — prefer ENABLED providers with a real API key.
    // If the same model exists under multiple providers (e.g. glm-5.2 on both
    // OpenRouter and NVIDIA), pick the one whose key isn't a placeholder.
    let provider, modelRecord;
    if (model) {
      const candidates = db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').all(model, model);
      // Sort: enabled provider with non-placeholder key first
      for (const m of candidates) {
        const p = stmts.providers.getById.get(m.provider_id);
        if (p && p.enabled && p.api_key && p.api_key.length > 10 && !p.api_key.includes('*')) {
          modelRecord = m;
          provider = p;
          break;
        }
      }
      // Fallback: first candidate even if key looks bad
      if (!provider && candidates.length > 0) {
        modelRecord = candidates[0];
        provider = stmts.providers.getById.get(modelRecord.provider_id);
      }
    }
    if (!provider) {
      modelRecord = stmts.models.getDefault.get();
      if (modelRecord) provider = stmts.providers.getById.get(modelRecord.provider_id);
    }
    // Fall back to an enabled provider with a real API key when no default
    // model is set (e.g. the user saved a key but never detected models).
    // Prefer one that already has models, then any keyed provider (we auto-
    // detect its models below), then local Ollama.
    if (!provider) {
      const usable = stmts.providers.getAll.all()
        .filter(p => p.enabled && (p.type === 'ollama' || (p.api_key && p.api_key.length > 10 && !p.api_key.includes('*'))))
        .map(p => stmts.providers.getById.get(p.id))
        .filter(Boolean);
      const hasModels = p => db.prepare('SELECT COUNT(*) AS n FROM llm_models WHERE provider_id = ?').get(p.id).n > 0;
      const keyed = p => p.api_key && p.api_key.length > 10 && !p.api_key.includes('*');
      provider = usable.find(hasModels) || usable.find(keyed) || usable.find(p => p.type === 'ollama') || null;
    }
    if (!provider || !provider.api_key) {
      return res.status(400).json({ error: 'No LLM provider with API key configured. Set one up in LLM Models page.' });
    }
    const isOllama = provider.type === 'ollama';
    if (!provider.api_key && !isOllama) {
      return res.status(400).json({ error: `Provider "${provider.name}" has no API key set.` });
    }

    // Pick a model: the provider's default, else its first model, else detect.
    if (!modelRecord) {
      modelRecord = db.prepare('SELECT * FROM llm_models WHERE provider_id = ? ORDER BY is_default DESC, rowid ASC LIMIT 1').get(provider.id);
      if (!modelRecord) {
        try {
          await detectModelsFromProvider(db, provider);
          modelRecord = db.prepare('SELECT * FROM llm_models WHERE provider_id = ? ORDER BY rowid ASC LIMIT 1').get(provider.id);
        } catch { /* detection failed — clear error below */ }
        if (!modelRecord) {
          return res.status(400).json({ error: `No models detected for provider "${provider.name}". Run Detect Models on the LLM Models page.` });
        }
      }
    }

    const systemPrompt = buildAimiSystemPrompt(stmts, req.user.id, db);

    // Build message history (include system prompt + user message)
    const chatMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];

    const modelId = modelRecord?.model_id || model || 'gpt-3.5-turbo';
    const pType = provider.type;
    const providerType = PROVIDER_TYPES[pType];
    const baseUrl = provider.base_url || providerType?.baseUrl || '';
    // Use buildChatUrl + buildProviderAuth for correct per-provider routing
    const url = buildChatUrl(baseUrl, pType, modelId, true);

    // Stream response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      const fetch = globalThis.fetch;
      const { headers, url: chatUrl } = buildProviderAuth(provider, url);

      // Execute one tool call against its local API endpoint.
      const executeToolCall = async (toolCall) => {
        const toolDef = stmts.tools.getByName.get(toolCall.tool);
        if (!toolDef) return null;
        const toolUrl = `http://localhost:${PORT}${toolDef.endpoint.replace(':id', toolCall.arguments?.id || '')}`;
        const toolResp = await fetch(toolUrl, {
          method: toolDef.method,
          headers: { 'Authorization': `Bearer ${req.headers.authorization?.replace('Bearer ', '')}`, 'Content-Type': 'application/json' },
          body: toolDef.method !== 'GET' ? JSON.stringify(toolCall.arguments || {}) : undefined,
        });
        return { tool: toolCall.tool, result: await toolResp.json() };
      };

      // Relay one model turn to the client (SSE). Returns the full text and,
      // if the model asked for a tool, the parsed tool call.
      const relayTurn = async (messages) => {
        const payload = buildChatPayload(pType, modelId, messages, true);
        const resp = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!resp.ok) {
          const errText = await resp.text();
          res.write(`data: ${JSON.stringify({ error: { message: `LLM error (${resp.status}): ${errText.slice(0, 300)}` }})}\n\n`);
          res.end();
          return { ok: false };
        }

        // Node.js fetch returns a Web ReadableStream (not a Node stream).
        // Use getReader() + async loop instead of .on('data')/.on('end').
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let streamDone = false;

        while (!streamDone) {
          const { done, value } = await reader.read();
          if (done) { streamDone = true; break; }
          res.write(Buffer.from(value));
          const text = decoder.decode(value, { stream: true });
          const lines = text.split('\n').filter(l => l.startsWith('data: '));
          for (const line of lines) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
            } catch {}
          }
        }

        // Detect a tool call by scanning the WHOLE turn's content. Streaming
        // splits tokens across chunks ("```", "tool", "_call", ...), so any
        // per-chunk "tool_call" match is unreliable — the model's call would
        // be missed and the conversation would stop after the tool.
        let toolCall = null;
        try {
          const match = fullContent.match(/```tool_call\s*\n?([\s\S]*?)\n?```/) ||
                        fullContent.match(/\{"tool":\s*"[\s\S]*"\}/);
          if (match) {
            const parsed = JSON.parse(match[1] || match[0]);
            if (parsed && typeof parsed.tool === 'string') toolCall = parsed;
          }
        } catch {}
        return { ok: true, content: fullContent, toolCall };
      };

      // Tool-calling loop: relay the model's turn; if it requests a tool,
      // run it, hand the result back, and let the model continue — up to a
      // capped number of turns so a tool-crazy model can't loop forever.
      // Previously the conversation just ended after the tool result, which
      // is why Aimi "stopped dead" after invoking a tool.
      const MAX_TOOL_TURNS = 4;
      let messages = chatMessages;
      let fullContent = '';
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const turnResult = await relayTurn(messages);
        if (!turnResult.ok) return;
        fullContent += turnResult.content;
        if (!turnResult.toolCall) break;
        const toolResult = await executeToolCall(turnResult.toolCall);
        if (!toolResult) break;
        res.write(`data: ${JSON.stringify({ tool_result: { tool: turnResult.toolCall.tool, result: toolResult.result } })}\n\n`);
        messages = [
          ...messages,
          { role: 'assistant', content: turnResult.content },
          { role: 'system', content: `You invoked the tool "${toolResult.tool}" with arguments ${JSON.stringify(turnResult.toolCall.arguments || {})}. The tool returned:\n${JSON.stringify(toolResult.result)}` },
        ];
      }

      if (conversation_id) {
        const userMsgId = randomUUID();
        stmts.messages.insert.run(userMsgId, conversation_id, 'user', message, '[]', '[]', null, null, 0, 0);
        const asstMsgId = randomUUID();
        stmts.messages.insert.run(asstMsgId, conversation_id, 'assistant', fullContent, '[]', '[]', null, modelId, 0, 0);
        db.prepare("UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation_id);
        fireHook('onChatMessage', { conversationId: conversation_id, role: 'assistant', content: fullContent, model: modelId });
      }
      autoObserve(stmts, broadcast, logger, randomUUID, conversation_id, [{ role: 'user', content: message }], fullContent, modelId);
      res.end();
    } catch (err) {
      logger.error('Aimi chat error:', err);
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.end();
    }
  });

  return router;
}
