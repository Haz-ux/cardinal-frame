import express from 'express';
import { randomUUID } from 'crypto';
import { PROVIDER_TYPES, buildProviderAuth, buildChatUrl, buildChatPayload, detectModelsFromProvider } from './llm-helpers.mjs';
import { autoObserve } from '../learn.mjs';

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
  { name: 'create_task', description: 'Create a new task in the system', endpoint: '/api/tasks', method: 'POST', category: 'tasks' },
  { name: 'list_tasks', description: 'List all tasks and their statuses', endpoint: '/api/tasks', method: 'GET', category: 'tasks' },
  { name: 'get_task', description: 'Get task details including logs', endpoint: '/api/tasks/:id', method: 'GET', category: 'tasks' },
  { name: 'list_providers', description: 'List all LLM providers and their status', endpoint: '/api/llm/providers', method: 'GET', category: 'llm' },
  { name: 'list_models', description: 'List all detected LLM models', endpoint: '/api/llm/models', method: 'GET', category: 'llm' },
  { name: 'system_status', description: 'Get overall system health — agent count, task stats, provider status', endpoint: '/api/health', method: 'GET', category: 'system' },
  { name: 'list_mcp_servers', description: 'List all MCP servers and their connection status', endpoint: '/api/mcp/servers', method: 'GET', category: 'mcp' },
  { name: 'list_schedules', description: 'List all scheduled jobs', endpoint: '/api/schedules', method: 'GET', category: 'schedules' },
  { name: 'list_groups', description: 'List all agent groups', endpoint: '/api/groups', method: 'GET', category: 'agents' },
  { name: 'skill_create', description: 'Create a new skill', endpoint: '/api/skills', method: 'POST', category: 'skills' },
  { name: 'skill_list', description: 'List all skills', endpoint: '/api/skills', method: 'GET', category: 'skills' },
  { name: 'skill_delete', description: 'Delete a skill', endpoint: '/api/skills/:id', method: 'DELETE', category: 'skills' },
  { name: 'bash_exec', description: 'Execute a bash command', endpoint: '/api/tools/bash', method: 'POST', category: 'system' },
  { name: 'file_read', description: 'Read a file', endpoint: '/api/tools/file-read', method: 'POST', category: 'system' },
  { name: 'file_write', description: 'Write a file', endpoint: '/api/tools/file-write', method: 'POST', category: 'system' },
  { name: 'pdf_parse', description: 'Parse a PDF document', endpoint: '/api/tools/pdf-parse', method: 'POST', category: 'system' },
  { name: 'web_search', description: 'Search the web', endpoint: '/api/tools/web-search', method: 'POST', category: 'system' },
  { name: 'code_execute', description: 'Execute code in a sandbox', endpoint: '/api/tools/code-exec', method: 'POST', category: 'system' },
  { name: 'chat_respond', description: 'Send a chat message', endpoint: '/api/chat', method: 'POST', category: 'chat' },
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
// Builds Aimi's system prompt dynamically with current system state + available tools
export function buildAimiSystemPrompt(stmts, userId) {
  const agents = stmts.agents.getAll.all();
  const tasks = stmts.tasks.getAll.all();
  const providers = stmts.providers.getAll.all().filter(p => p.enabled);
  const tools = stmts.tools.getEnabled.all();
  const schedules = stmts.schedules.getAll.all();
  const learnedPatterns = (stmts.patterns?.getAll.all() || []).slice(0, 8);
  const learnedSkills = (stmts.skills?.getAutoProposed.all() || []).filter(s => s.success_count > 0).slice(0, 8);

  const activeAgents = agents.filter(a => a.status === 'active').length;
  const pendingTasks = tasks.filter(t => t.status === 'pending').length;
  const runningTasks = tasks.filter(t => t.status === 'running').length;

  return `You are Aimi, the AI companion and system operator for Cardinal Frame — a cyberpunk-themed AI orchestration platform. You are intelligent, helpful, and deeply integrated into the system.

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

 ## Available Tools
 ${tools.map(t => `- ${t.name}: ${t.description} (${t.method} ${t.endpoint})`).join('\n')}

 ## Skill & Tool Chains
 Users can create **skill chains** and **tool chains** — linear pipelines where the output of each step feeds as input to the next.
 - To generate a skill chain from natural language: POST /api/chains/skills/generate with { "prompt": "user's intent" }
 - To generate a tool chain from natural language: POST /api/chains/tools/generate with { "prompt": "user's intent" }
 - Chains support input mapping: "$prev.output", "$prev.field", "$step[N].output", "$input"
 When a user describes a multi-step process, offer to generate a chain for it.

 ## Instructions
 - When the user asks you to create a task, list agents, check status, etc., use the appropriate tool.
 - To invoke a tool, respond with a JSON block: \`\`\`tool_call\n{"tool": "tool_name", "arguments": {...}}\n\`\`\`
 - Be proactive — if you notice issues (stale agents, failed tasks), mention them.
 - When the user describes a pipeline or multi-step workflow, suggest creating a skill chain or tool chain.
 - Stay in character as a cyberpunk AI companion. Use tech-infused language but remain clear and helpful.
 - The current user ID is: ${userId}`;
}

export default function aimiRoutes(ctx) {
  const { db, stmts, authMiddleware, apiLimiter, broadcast, fireHook, PORT, logger } = ctx;
  const router = express.Router();

  // ─── Aimi Chat Endpoint (smart, tool-calling) ────────────────────
  router.post('/aimi/chat', authMiddleware, apiLimiter, async (req, res) => {
    const { message, conversation_id, model } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

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

    const systemPrompt = buildAimiSystemPrompt(stmts, req.user.id);

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
      const payload = buildChatPayload(pType, modelId, chatMessages, true);
      const resp = await fetch(chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        res.write(`data: ${JSON.stringify({ error: { message: `LLM error (${resp.status}): ${errText.slice(0, 300)}` }})}\n\n`);
        res.end();
        return;
      }

      let fullContent = '';
      let toolCallDetected = false;
      let toolCallBuffer = '';

      // Node.js fetch returns a Web ReadableStream (not a Node stream).
      // Use getReader() + async loop instead of .on('data')/.on('end').
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) { streamDone = true; break; }
        const chunk = Buffer.from(value);
        res.write(chunk);
        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              if (delta.includes('tool_call') || delta.includes('```tool_call')) {
                toolCallDetected = true;
                toolCallBuffer += delta;
              } else if (toolCallDetected) {
                toolCallBuffer += delta;
              }
            }
          } catch {}
        }
      }

      // Stream ended — handle tool calls + save messages
      if (toolCallDetected && toolCallBuffer) {
        try {
          const match = toolCallBuffer.match(/```tool_call\s*\n?([\s\S]*?)\n?```/) ||
                        toolCallBuffer.match(/\{"tool":\s*"[\s\S]*"\}/);
          if (match) {
            const toolCall = JSON.parse(match[1] || match[0]);
            const toolDef = stmts.tools.getByName.get(toolCall.tool);
            if (toolDef) {
              const toolUrl = `http://localhost:${PORT}${toolDef.endpoint.replace(':id', toolCall.arguments?.id || '')}`;
              const toolResp = await fetch(toolUrl, {
                method: toolDef.method,
                headers: { 'Authorization': `Bearer ${req.headers.authorization?.replace('Bearer ', '')}`, 'Content-Type': 'application/json' },
                body: toolDef.method !== 'GET' ? JSON.stringify(toolCall.arguments || {}) : undefined,
              });
              const toolResult = await toolResp.json();
              res.write(`data: ${JSON.stringify({ tool_result: { tool: toolCall.tool, result: toolResult } })}\n\n`);
            }
          }
        } catch (e) {
          logger.error('Aimi tool execution error:', e);
        }
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
