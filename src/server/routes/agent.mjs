import express from 'express';
import { randomUUID } from 'crypto';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { PROVIDER_TYPES, buildProviderAuth, buildChatUrl, buildChatPayload } from './llm-helpers.mjs';
import { getModelCost } from './costs.mjs';

/**
 * Aimi Coding Agent: sandbox agent with plan/read/write/exec/iterate loop.
 * Dependencies (via ctx): db, stmts, authMiddleware, requireRole, apiLimiter,
 *   PORT, logger, broadcast, broadcastLog, fireHook, getDevSetting, executeSkill
 *
 * Named exports:
 *   - callAgentLLM(messages, modelOverride) — shared LLM call function
 *   - callAgentLLMWithRetry(messages, modelOverride, maxRetries) — with retry + concurrency
 *   - agentTools — tool registry array
 *   - registerAgentTool(name, description, parameters, executeFn) — register a tool
 */

// ─── Aimi Coding Agent (VS Code Copilot-style) ────────────────────
// Semi-autonomous mode: plan → draft diffs → user approves → write
// Agent mode: plan → read/write/exec autonomously → report results
// Autopilot: server-side loop with native function calling
// File scope: sandbox = /home/haz/ai-workspace/, home = /home/haz/

const SANDBOX_DIR = '/home/haz/ai-workspace';
const HOME_DIR = '/home/haz';
const CMD_BLOCKLIST = [
  'rm -rf', 'sudo', 'reboot', 'shutdown', 'mkfs', 'dd if=', 'kill -9',
  'systemctl stop', 'systemctl disable', 'chmod 777 /', 'chown root',
];
const ALLOWED_READ_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.json', '.md', '.txt', '.py', '.sh', '.html', '.css', '.yaml', '.yml', '.env', '.sql', '.xml'];
const MAX_AGENT_STEPS = 20;
const AGENT_STEP_DELAY_MS = 100;

// Module-level deps — populated by agentRoutes(ctx)
// Proxy that lazily forwards to _ctx (avoids TDZ on getter properties in ctx)
let _ctxRef = null;
const _deps = new Proxy({}, {
  get(_t, prop) { return _ctxRef?.[prop]; },
});

function resolveSandboxPath(scope, targetPath) {
  const base = scope === 'home' ? HOME_DIR : SANDBOX_DIR;
  const resolved = path.resolve(base, targetPath || '.');
  if (!resolved.startsWith(base)) {
    throw new Error('Path traversal blocked: target outside scope');
  }
  return resolved;
}

function isCmdSafe(cmd) {
  const lower = (cmd || '').toLowerCase().trim();
  if (!lower || lower.length > 2000) return false;
  for (const blocked of CMD_BLOCKLIST) {
    if (lower.includes(blocked)) return false;
  }
  return true;
}

// ─── Agent Tool Registry ──────────────────────────────────────────
// Each tool has: name, description, parameters (OpenAI function format), execute function
const agentTools = [];

function registerAgentTool(name, description, parameters, executeFn) {
  agentTools.push({ name, description, parameters, execute: executeFn });
}

// OpenAI function-calling format for tool definitions
function getToolDefinitions() {
  return agentTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ─── Built-in Tools ───────────────────────────────────────────────

registerAgentTool(
  'file_read',
  'Read the contents of a file. Returns content with line numbers.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace' },
      scope: { type: 'string', enum: ['sandbox', 'home'], description: 'File scope boundary' },
    },
    required: ['path'],
  },
  async (args, ctx) => {
    const resolved = resolveSandboxPath(args.scope || ctx.scope || 'sandbox', args.path);
    const fs = await import('fs');
    const stat = await fs.promises.stat(resolved);
    if (stat.size > 500_000) return { error: 'File too large (max 500KB)' };
    const content = await fs.promises.readFile(resolved, 'utf-8');
    return { path: args.path, content: content.slice(0, 50000), size: stat.size, truncated: stat.size > 50000 };
  }
);

registerAgentTool(
  'file_write',
  'Write content to a file. Creates directories if needed.',
  {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace' },
      content: { type: 'string', description: 'File content to write' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
    },
    required: ['path', 'content'],
  },
  async (args, ctx) => {
    const resolved = resolveSandboxPath(args.scope || ctx.scope || 'sandbox', args.path);
    if (args.content.length > 500_000) return { error: 'Content too large (max 500KB)' };
    const fs = await import('fs');
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, args.content, 'utf-8');
    return { written: true, path: args.path, size: args.content.length };
  }
);

registerAgentTool(
  'file_list',
  'List files in a directory within the workspace.',
  {
    type: 'object',
    properties: {
      dir: { type: 'string', description: 'Relative directory path (default: root)' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      depth: { type: 'integer', description: 'Max depth to traverse (default: 3)' },
    },
  },
  async (args, ctx) => {
    const base = (args.scope || ctx.scope || 'sandbox') === 'home' ? HOME_DIR : SANDBOX_DIR;
    const resolved = resolveSandboxPath(args.scope || ctx.scope || 'sandbox', args.dir || '.');
    const maxDepth = args.depth || 3;
    function walk(dir, currentDepth) {
      const items = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(base, full);
          if (entry.isDirectory() && currentDepth < maxDepth) {
            items.push({ name: entry.name, path: rel, type: 'dir' });
            if (!['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
              items.push(...walk(full, currentDepth + 1));
            }
          } else if (entry.isFile()) {
            items.push({ name: entry.name, path: rel, type: 'file', size: statSync(full).size });
          }
        }
      } catch {}
      return items;
    }
    return { files: walk(resolved, 0) };
  }
);

registerAgentTool(
  'file_search',
  'Search file contents using regex patterns. Returns matching lines with file paths.',
  {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      max_results: { type: 'integer', description: 'Max results to return (default: 20)' },
    },
    required: ['pattern'],
  },
  async (args, ctx) => {
    const base = (args.scope || ctx.scope || 'sandbox') === 'home' ? HOME_DIR : SANDBOX_DIR;
    // execSync is injected by the skill runtime
    try {
      const cmd = `grep -rn --include="*.{js,jsx,ts,tsx,mjs,json,md,txt,py,sh}" --max-count=${args.max_results || 20} "${args.pattern.replace(/"/g, '\\"')}" "${base}" 2>/dev/null | head -${args.max_results || 20}`;
      const stdout = execSync(cmd, { timeout: 10000, encoding: 'utf-8', maxBuffer: 1024 * 50 });
      const results = stdout.split('\n').filter(Boolean).map(line => {
        const [file, ...rest] = line.split(':');
        const lineNum = rest[0];
        const content = rest.slice(1).join(':');
        return { file: path.relative(base, file), line: parseInt(lineNum) || 0, content: content.slice(0, 200) };
      });
      return { matches: results, count: results.length };
    } catch (e) {
      return { matches: [], count: 0, error: e.message };
    }
  }
);

registerAgentTool(
  'shell_exec',
  'Execute a shell command in the workspace. Dangerous commands are blocked.',
  {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
      cwd: { type: 'string', description: 'Working directory (relative to scope)' },
    },
    required: ['command'],
  },
  async (args, ctx) => {
    if (!isCmdSafe(args.command)) return { error: 'Command blocked by safety filter' };
    // execSync is injected by the skill runtime
    const workDir = (ctx.scope || args.scope || 'sandbox') === 'home' ? HOME_DIR : resolveSandboxPath(ctx.scope || args.scope || 'sandbox', args.cwd || '.');
    try {
      const stdout = execSync(args.command, { timeout: 30000, maxBuffer: 1024 * 100, cwd: workDir, encoding: 'utf-8' });
      return { exitCode: 0, stdout: stdout.slice(0, 5000), stderr: '' };
    } catch (e) {
      return { exitCode: e.status || 1, stdout: (e.stdout || '').toString().slice(0, 5000), stderr: (e.stderr || '').toString().slice(0, 2000) };
    }
  }
);

registerAgentTool(
  'web_search',
  'Search the web for information. Uses Tavily API.',
  {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'integer', description: 'Max results (default: 5)' },
    },
    required: ['query'],
  },
  async (args) => {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) return { error: 'Tavily API key not configured' };
    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: args.query,
          max_results: args.max_results || 5,
        }),
      });
      const data = await resp.json();
      return {
        results: (data.results || []).map(r => ({
          title: r.title,
          url: r.url,
          content: (r.content || '').slice(0, 500),
        })),
      };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'web_fetch',
  'Fetch a URL and extract text content.',
  {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
  async (args) => {
    try {
      const resp = await fetch(args.url, { timeout: 15000 });
      const text = await resp.text();
      // Strip HTML tags if it's HTML
      const stripped = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                           .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                           .replace(/<[^>]+>/g, ' ')
                           .replace(/\s+/g, ' ')
                           .trim();
      return { content: stripped.slice(0, 10000), url: args.url, status: resp.status, truncated: stripped.length > 10000 };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'git_op',
  'Perform git operations (status, diff, log, add, commit). Read-only operations are always allowed.',
  {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['status', 'diff', 'log', 'add', 'commit', 'branch'], description: 'Git operation' },
      args: { type: 'string', description: 'Arguments for the operation (e.g., commit message)' },
      scope: { type: 'string', enum: ['sandbox', 'home'] },
    },
    required: ['operation'],
  },
  async (args, ctx) => {
    const workDir = (args.scope || ctx.scope || 'sandbox') === 'home' ? HOME_DIR : SANDBOX_DIR;
    // execSync is injected by the skill runtime
    const ops = {
      status: 'git status --short',
      diff: 'git diff',
      log: 'git log --oneline -10',
      branch: 'git branch -a',
      add: 'git add -A',
      commit: `git commit -m "${(args.args || '').replace(/"/g, '\\"')}"`,
    };
    const cmd = ops[args.operation];
    if (!cmd) return { error: `Unknown git operation: ${args.operation}` };
    try {
      const stdout = execSync(cmd, { timeout: 10000, cwd: workDir, encoding: 'utf-8', maxBuffer: 1024 * 50 });
      return { output: stdout.slice(0, 5000) };
    } catch (e) {
      return { error: (e.stderr || e.message).toString().slice(0, 500) };
    }
  }
);

registerAgentTool(
  'mcp_invoke',
  'Invoke a registered MCP tool.',
  {
    type: 'object',
    properties: {
      server_id: { type: 'string', description: 'MCP server ID' },
      tool_name: { type: 'string', description: 'Tool name to invoke' },
      arguments: { type: 'object', description: 'Tool arguments' },
    },
    required: ['server_id', 'tool_name'],
  },
  async (args) => {
    try {
      const result = await mcp.invokeTool(args.server_id, args.tool_name, args.arguments || {});
      return { result };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'skill_invoke',
  'Invoke a stored Cardinal Frame skill by name.',
  {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name' },
      input: { type: 'string', description: 'Input for the skill' },
    },
    required: ['name'],
  },
  async (args) => {
    const skill = _deps.stmts.skills.getByName.get(args.name);
    if (!skill) return { error: `Skill not found: ${args.name}` };
    try {
      const { result: handlerResult } = await runSandboxed({
        code: skill.handler,
        input: args.input || '',
      });
      return { result: handlerResult };
    } catch (e) {
      return { error: e.message };
    }
  }
);

registerAgentTool(
  'delegate_task',
  'Delegate a subtask to another agent. Use this to parallelize work or leverage specialized agents. Returns the delegation result if synchronous, or a delegation ID to poll later.',
  {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name for the delegated subtask' },
      command: { type: 'string', description: 'Command to execute on the target agent' },
      capability: { type: 'string', description: 'Required capability (e.g. "build", "test", "deploy"). Finds a matching agent automatically.' },
      agentId: { type: 'string', description: 'Specific agent ID to delegate to. If omitted, auto-selects by capability.' },
      synchronous: { type: 'boolean', description: 'If true, wait for the subtask to complete and return the result. If false, returns immediately with a delegation ID.' },
      waitTimeout: { type: 'integer', description: 'Max milliseconds to wait if synchronous (default: 30000)' },
    },
    required: ['name', 'command'],
  },
  async (args) => {
    try {
      const response = await fetch(`http://localhost:${process.env.PORT || 8080}/api/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: args.name,
          command: args.command,
          capability: args.capability,
          agentId: args.agentId,
          synchronous: args.synchronous !== false,
          wait: args.synchronous !== false,
          waitTimeout: args.waitTimeout || 30000,
        }),
      });
      const result = await response.json();
      if (!response.ok) return { error: result.error || 'Delegation failed' };
      return {
        delegationId: result.id,
        status: result.status,
        childTaskId: result.childTaskId,
        agentId: result.agentId,
        result: result.result,
        childTask: result.childTask,
        message: result.message,
      };
    } catch (e) {
      return { error: `Delegation request failed: ${e.message}` };
    }
  }
);

// ─── Execute a tool by name ───────────────────────────────────────
async function executeAgentTool(toolName, args, ctx) {
  const tool = agentTools.find(t => t.name === toolName);
  if (!tool) return { error: `Unknown tool: ${toolName}` };
  try {
    const result = await tool.execute(args || {}, ctx || {});
    _deps.fireHook('onAgentStep', { sessionId: ctx?.sessionId, toolName, args, result, success: !result.error });
    return result;
  } catch (e) {
    _deps.fireHook('onAgentStep', { sessionId: ctx?.sessionId, toolName, args, result: { error: e.message }, success: false });
    return { error: e.message };
  }
}

// ─── Agent Loop ───────────────────────────────────────────────────
// Runs autonomously server-side: LLM plans → calls tools → gets results → continues
// Broadcasts progress over WebSocket. Returns final summary.

async function runAgentLoop(sessionId, options = {}) {
  const session = _deps.stmts.agentSessions.getById.get(sessionId);
  if (!session) throw new Error('Session not found');

  const ctx = { scope: session.scope, sessionId, userId: session.user_id };
  const maxSteps = options.maxSteps || MAX_AGENT_STEPS;
  const model = options.model || session.model || undefined;
  const toolDefs = getToolDefinitions();

  // Build initial system prompt
  const systemPrompt = `You are Aimi, an autonomous coding agent. You work by calling tools to accomplish tasks.

Task: ${session.task}
Mode: ${session.mode}
File scope: ${session.scope === 'sandbox' ? '/home/haz/ai-workspace (sandbox)' : '/home/haz (home dir)'}

You have access to the following tools. Call them by using function calling.
When the task is complete, respond with a summary (no tool call needed).

Remember:
- Read files before writing to understand existing code
- Use file_search to find relevant files
- Test your work with shell_exec
- Keep changes focused and minimal`;

  // Track conversation for LLM context
  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Please work on this task: ${session.task}` },
  ];

  // ─── Memory recall: inject relevant memories into context ──────
  try {
    const memResults = _deps.stmts.memories.search.all(session.task.slice(0, 50) + '*', session.user_id, 5);
    if (memResults && memResults.length > 0) {
      const memText = memResults.map(m => `- [${m.category}] ${m.content.slice(0, 200)}`).join('\n');
      messages.splice(1, 0, {
        role: 'system',
        content: `Relevant memories from past sessions:\n${memText}\n\nUse these if helpful for the current task.`,
      });
      _deps.logger.info(`Agent loop: injected ${memResults.length} memories into context`);
    }
  } catch (e) { /* FTS5 may not be ready in all envs */ }

  // ─── Index this session for future search ─────────────────────
  try {
    _deps.stmts.sessionIndex.insert.run(
      randomUUID(), 'agent', sessionId, session.user_id,
      session.task.slice(0, 100), session.task
    );
  } catch (e) { /* may already exist on resume */ }

  // Load any existing actions into context (for resumed sessions)
  const existingActions = _deps.stmts.agentActions.getBySession.all(sessionId);
  if (existingActions.length > 0) {
    for (const action of existingActions.slice(-10)) {
      messages.push({ role: 'assistant', content: `I performed ${action.action_type} on ${action.target}. Result: ${(action.result || '').slice(0, 200)}` });
    }
    messages.push({ role: 'user', content: 'Continue working on the task.' });
  }

  // Track step index in JS to avoid redundant getBySession.all() queries
  let stepCounter = existingActions.length;

  // Update session status
  _deps.stmts.agentSessions.updateStatus.run('executing', sessionId);
  _deps.broadcast('agent:loop:start', { session_id: sessionId, max_steps: maxSteps });

  let totalTokens = { prompt: 0, completion: 0 };

  for (let step = 0; step < maxSteps; step++) {
    _deps.broadcast('agent:step', { session_id: sessionId, step: step + 1, status: 'thinking' });
    _deps.stmts.agentSessions.updateStep.run(step + 1, sessionId);

    let llmResult;
    try {
      llmResult = await callAgentLLMWithToolsRetry(messages, toolDefs, model);
    } catch (e) {
      _deps.logger.error(`Agent loop LLM error at step ${step + 1}: ${e.message}`);
      _deps.broadcast('agent:loop:error', { session_id: sessionId, step: step + 1, error: e.message });
      _deps.stmts.agentSessions.updateStatus.run('failed', sessionId);

      // Record the error as an action for debugging
      const errActionId = randomUUID();
      const errStepIdx = stepCounter;
      _deps.stmts.agentActions.insert.run(errActionId, sessionId, errStepIdx, 'error', 'llm_call', e.message, JSON.stringify({ error: e.message }), 'failed');
      stepCounter++;

      return { completed: false, error: e.message, steps: step + 1, tokens: totalTokens };
    }

    totalTokens.prompt += llmResult.promptTokens || 0;
    totalTokens.completion += llmResult.completionTokens || 0;

    // If LLM returned a tool call, execute it
    if (llmResult.toolCalls && llmResult.toolCalls.length > 0) {
      for (const toolCall of llmResult.toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

        _deps.broadcast('agent:step', {
          session_id: sessionId,
          step: step + 1,
          status: 'executing_tool',
          tool: toolName,
          args: toolArgs,
        });

        // Execute the tool
        const result = await executeAgentTool(toolName, toolArgs, ctx);

        // Check if suggest mode requires approval
        if (session.mode === 'suggest' && ['file_write', 'shell_exec', 'git_op'].includes(toolName)) {
          const actionId = randomUUID();
          const stepIdx = stepCounter;
          _deps.stmts.agentActions.insert.run(
            actionId, sessionId, stepIdx, toolName === 'file_write' ? 'write' : 'exec',
            toolArgs.path || toolArgs.command || toolName,
            toolArgs.content || JSON.stringify(toolArgs),
            JSON.stringify(result),
            'pending'
          );

          _deps.broadcast('agent:approval_required', {
            session_id: sessionId,
            step: step + 1,
            action_id: actionId,
            tool: toolName,
            args: toolArgs,
            result: result.error ? result : { preview: 'Draft created' },
          });

          _deps.stmts.agentSessions.updateStatus.run('awaiting_approval', sessionId);
          stepCounter++;
          return {
            completed: false,
            paused: true,
            reason: 'approval_required',
            action_id: actionId,
            step: step + 1,
            tokens: totalTokens,
          };
        }

        // Record the action
        const actionId = randomUUID();
        const stepIdx = stepCounter;
        _deps.stmts.agentActions.insert.run(
          actionId, sessionId, stepIdx,
          toolName === 'file_read' ? 'read' :
          toolName === 'file_write' ? 'write' :
          toolName === 'shell_exec' ? 'exec' :
          toolName === 'web_search' ? 'search' : toolName,
          toolArgs.path || toolArgs.command || toolArgs.query || toolName,
          toolArgs.content || JSON.stringify(toolArgs).slice(0, 2000),
          JSON.stringify(result).slice(0, 5000),
          'completed'
        );
        stepCounter++;

        _deps.broadcast('agent:step', {
          session_id: sessionId,
          step: step + 1,
          status: 'tool_complete',
          tool: toolName,
          result_preview: JSON.stringify(result).slice(0, 200),
        });

        // Feed the result back to the LLM
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolName, arguments: toolCall.function.arguments } }],
        });
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify(result).slice(0, 4000),
        });
      }

      // Rate-limit delay between steps
      if (AGENT_STEP_DELAY_MS > 0) await new Promise(r => setTimeout(r, AGENT_STEP_DELAY_MS));
      continue;
    }

    // No tool call — LLM is either done or wants to say something
    const content = llmResult.content || '';

    // Record the final response
    const actionId = randomUUID();
    const stepIdx = stepCounter;
    _deps.stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'response', 'complete', content.slice(0, 5000), JSON.stringify({ summary: content.slice(0, 2000) }), 'completed');
    stepCounter++;

    _deps.stmts.agentSessions.updateStatus.run('completed', sessionId);
    _deps.broadcast('agent:loop:complete', {
      session_id: sessionId,
      steps: step + 1,
      summary: content.slice(0, 500),
      tokens: totalTokens,
    });

    // ── Comms reply: if this session was triggered by a comms message, send result back ──
    try {
      const commsMsg = _deps.db.prepare('SELECT * FROM comms_messages WHERE agent_session_id = ?').get(sessionId);
      if (commsMsg) {
        const channel = _deps.stmts.commsChannels.getById.get(commsMsg.channel_id);
        if (channel) {
          await sendCommsReply(channel, commsMsg, content);
        }
      }
    } catch (e) { _deps.logger.error(`Comms reply hook failed: ${e.message}`); }

    return {
      completed: true,
      summary: content,
      steps: step + 1,
      tokens: totalTokens,
    };
  }

  // Hit max steps
  _deps.stmts.agentSessions.updateStatus.run('max_steps_reached', sessionId);
  _deps.broadcast('agent:loop:complete', { session_id: sessionId, steps: maxSteps, summary: 'Max steps reached', tokens: totalTokens });

  return {
    completed: false,
    reason: 'max_steps_reached',
    steps: maxSteps,
    tokens: totalTokens,
  };
}

// ─── LLM call with native function calling ────────────────────────
async function callAgentLLMWithTools(messages, toolDefs, modelOverride) {
  let provider, modelRecord;
  if (modelOverride) {
    modelRecord = _deps.db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').get(modelOverride, modelOverride);
    if (modelRecord) provider = _deps.stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider) {
    modelRecord = _deps.stmts.models.getDefault.get();
    if (modelRecord) provider = _deps.stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider || !provider.api_key) throw new Error('No LLM provider with API key configured');

  const modelId = modelRecord?.model_id || 'gpt-3.5-turbo';
  const providerType = PROVIDER_TYPES[provider.type];
  const baseUrl = provider.base_url || providerType?.baseUrl || '';
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model: modelId,
    messages,
    max_tokens: 4096,
    stream: false,
  };

  // Include tools in the request if the provider supports function calling
  if (toolDefs && toolDefs.length > 0) {
    body.tools = toolDefs;
    body.tool_choice = 'auto';
  }

  const fetchHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.api_key}`,
    ...(provider.type === 'openrouter' ? { 'HTTP-Referer': 'https://cardinal-frame.local' } : {}),
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    throw new Error(`LLM fetch failed: ${fetchErr.message}`);
  }

  // If tools caused an error (some providers don't support function calling), retry without tools
  if (!resp.ok && toolDefs && toolDefs.length > 0) {
    const errText = await resp.text().catch(() => '');
    // Check if it's a tools-related error (400/422 with "tools" or "function" in the message)
    if ((resp.status === 400 || resp.status === 422) && /tool|function/i.test(errText)) {
      _deps.logger.warn(`Provider ${provider.name} doesn't support function calling, retrying with tool_prompt fallback`);
      // Remove tools and inject tool descriptions into system prompt instead
      const fallbackBody = { ...body };
      delete fallbackBody.tools;
      delete fallbackBody.tool_choice;
      // Enhance last system message with tool instructions
      const sysIdx = messages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        const toolList = toolDefs.map(t => `- ${t.function.name}: ${t.function.description}\n  Params: ${JSON.stringify(t.function.parameters).slice(0, 200)}`).join('\n');
        fallbackBody.messages = [...messages];
        fallbackBody.messages[sysIdx] = {
          ...messages[sysIdx],
          content: messages[sysIdx].content + `\n\n## Available Tools (use markdown format)\n${toolList}\n\nTo call a tool, respond with:\n\`\`\`tool_call\n{"tool": "tool_name", "arguments": {...}}\n\`\`\``,
        };
      }
      resp = await fetch(url, { method: 'POST', headers: fetchHeaders, body: JSON.stringify(fallbackBody) });
    }
  }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM error (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const message = data.choices?.[0]?.message;
  const toolCalls = message?.tool_calls || [];

  // If no tool calls but content has ```tool_call blocks, parse them (fallback for providers without native function calling)
  if (toolCalls.length === 0 && message?.content) {
    const toolCallMatches = message.content.matchAll(/```tool_call\s*\n?([\s\S]*?)\n?```/g);
    for (const match of toolCallMatches) {
      try {
        const parsed = JSON.parse(match[1].trim());
        toolCalls.push({
          id: randomUUID(),
          type: 'function',
          function: {
            name: parsed.tool,
            arguments: JSON.stringify(parsed.arguments || {}),
          },
        });
      } catch {}
    }
  }

  return {
    content: message?.content || '',
    toolCalls,
    model: modelId,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
  };
}

// Retry wrapper for callAgentLLMWithTools (handles 429 rate limits)
async function callAgentLLMWithToolsRetry(messages, toolDefs, modelOverride, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callAgentLLMWithTools(messages, toolDefs, modelOverride);
    } catch (err) {
      lastErr = err;
      const is429 = err.message?.includes('(429)') || err.message?.includes('Too Many Requests');
      if (is429 && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt + 1) * 1000;
        _deps.logger.warn(`Agent LLM rate limited, retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── Context window management ────────────────────────────────────
function compactAgentHistory(messages, maxMessages = 20) {
  if (messages.length <= maxMessages) return messages;
  // Keep system prompt + first user msg + last N messages
  const system = messages.filter(m => m.role === 'system');
  const firstUser = messages.find(m => m.role === 'user');
  const recent = messages.slice(-maxMessages + 2);

  // Summarize dropped messages
  const dropped = messages.slice(2, -maxMessages + 2);
  const summary = `Previous actions (summarized):\n${dropped.map(m => {
    if (m.role === 'tool') return `- Tool ${m.name}: ${m.content.slice(0, 100)}`;
    if (m.role === 'assistant') return `- Assistant: ${(m.content || 'tool call').slice(0, 100)}`;
    return `- ${m.role}: ${(m.content || '').slice(0, 100)}`;
  }).join('\n')}`;

  return [...system, { role: 'user', content: summary }, ...recent];
}

async function callAgentLLM(messages, modelOverride) {
  let provider, modelRecord;
  if (modelOverride) {
    modelRecord = _deps.db.prepare('SELECT * FROM llm_models WHERE model_id = ? OR display_name = ?').get(modelOverride, modelOverride);
    if (modelRecord) provider = _deps.stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider) {
    modelRecord = _deps.stmts.models.getDefault.get();
    if (modelRecord) provider = _deps.stmts.providers.getById.get(modelRecord.provider_id);
  }
  if (!provider || !provider.api_key) throw new Error('No LLM provider with API key configured');
  const modelId = modelRecord?.model_id || 'gpt-3.5-turbo';
  const providerType = PROVIDER_TYPES[provider.type];
  const baseUrl = provider.base_url || providerType?.baseUrl || '';
  const url = `${baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.api_key}`,
      ...(provider.type === 'openrouter' ? { 'HTTP-Referer': 'https://cardinal-frame.local' } : {}),
    },
    body: JSON.stringify({ model: modelId, messages, max_tokens: 4096, stream: false }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM error (${resp.status}): ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    model: modelId,
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
  };
}

// ─── LLM Call with Retry + Concurrency Limiting ──────────────────
const MAX_CONCURRENT_LLM = 3;
let _activeLLMCalls = 0;
const _llmQueue = [];

function _drainLLMQueue() {
  while (_llmQueue.length > 0 && _activeLLMCalls < MAX_CONCURRENT_LLM) {
    const next = _llmQueue.shift();
    _activeLLMCalls++;
    next.run().finally(() => { _activeLLMCalls--; _drainLLMQueue(); });
  }
}

async function callAgentLLMWithRetry(messages, modelOverride, maxRetries = 3) {
  // Queue if at capacity
  if (_activeLLMCalls >= MAX_CONCURRENT_LLM) {
    await new Promise(resolve => _llmQueue.push({ run: () => Promise.resolve() }));
  }
  _activeLLMCalls++;

  try {
    let lastErr;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await callAgentLLM(messages, modelOverride);
      } catch (err) {
        lastErr = err;
        const is429 = err.message?.includes('LLM error (429)') || err.message?.includes('429') || err.message?.includes('Too Many Requests');
        if (is429 && attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
          _deps.logger.warn(`LLM rate limited, retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    _activeLLMCalls--;
    _drainLLMQueue();
  }
}

// POST /api/agent/sessions — create a new agent session

export default function agentRoutes(ctx) {
  // Wire _deps to ctx so module-level functions can access ctx props lazily
  // (getters for later-declared vars would TDZ if accessed eagerly)
  _ctxRef = ctx;
  const { db, stmts, authMiddleware, requireRole, apiLimiter, PORT, logger, broadcast, broadcastLog, fireHook, getDevSetting, executeSkill } = ctx;
  const router = express.Router();

router.post('/agent/sessions', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { task, mode = 'agent', scope = 'sandbox', conversation_id, model } = req.body;
    if (!task) return res.status(400).json({ error: 'task required' });
    if (!['agent', 'suggest'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    if (!['sandbox', 'home'].includes(scope)) return res.status(400).json({ error: 'Invalid scope' });
    const id = randomUUID();
    stmts.agentSessions.insert.run(id, req.user.id, conversation_id || null, task, mode, scope, '[]', 'planning', model || '');
    const session = stmts.agentSessions.getById.get(id);
    broadcast('agent:session', { type: 'created', session });
    res.status(201).json(session);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/sessions — list user's sessions
router.get('/agent/sessions', authMiddleware, apiLimiter, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const sessions = db.prepare('SELECT * FROM agent_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.user.id, limit);
    res.json(sessions);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/sessions/:id — get session with actions
router.get('/agent/sessions/:id', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const actions = stmts.agentActions.getBySession.all(req.params.id);
    res.json({ ...session, plan: JSON.parse(session.plan || '[]'), actions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/agent/sessions/:id/mode — toggle mode (suggest ↔ agent)
router.patch('/agent/sessions/:id/mode', authMiddleware, (req, res) => {
  try {
    const { mode } = req.body;
    if (!['agent', 'suggest'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    stmts.agentSessions.updateMode.run(mode, req.params.id);
    const updated = stmts.agentSessions.getById.get(req.params.id);
    broadcast('agent:session', { type: 'mode_changed', session: updated });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/plan — generate a plan for a task using LLM
router.post('/agent/plan', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { task, scope = 'sandbox', model } = req.body;
    if (!task) return res.status(400).json({ error: 'task required' });
    const planPrompt = `You are Aimi, an autonomous coding agent. Analyze the following task and create a step-by-step plan.
Task: ${task}
File scope: ${scope === 'sandbox' ? '/home/haz/ai-workspace (sandbox)' : '/home/haz (home dir)'}

Respond as JSON:
{
  "steps": [
    { "description": "Read file X", "action": "read", "target": "path/to/file" },
    { "description": "Write code Y", "action": "write", "target": "path/to/file" },
    { "description": "Run build", "action": "exec", "target": "npm run build" }
  ]
}
Only include steps you are confident about. Keep it to max 8 steps.`;
    const result = await callAgentLLM([
      { role: 'system', content: planPrompt },
      { role: 'user', content: task }
    ], model);
    let plan;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      plan = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      plan = { steps: [{ description: result.content.slice(0, 500), action: 'response', target: 'LLM response' }] };
    }
    res.json({
      plan: plan.steps || [],
      model: result.model,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/read — read a file from sandbox/home scope
router.post('/agent/read', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { path: targetPath, scope = 'sandbox' } = req.body;
    if (!targetPath) return res.status(400).json({ error: 'path required' });
    const resolved = resolveSandboxPath(scope, targetPath);
    const fs = await import('fs');
    const stat = await fs.promises.stat(resolved);
    if (stat.size > 500_000) return res.status(400).json({ error: 'File too large (max 500KB)' });
    const content = await fs.promises.readFile(resolved, 'utf-8');
    res.json({
      path: targetPath,
      resolved,
      content: content.slice(0, 50000),
      size: stat.size,
      truncated: stat.size > 50000,
    });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    if (e.message.includes('Path traversal')) return res.status(403).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agent/workspace — list files in sandbox
router.get('/agent/workspace', authMiddleware, (req, res) => {
  try {
    const { scope = 'sandbox', depth = 3 } = req.query;
    const base = scope === 'home' ? HOME_DIR : SANDBOX_DIR;
    function walk(dir, currentDepth, maxDepth) {
      const items = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
          const full = path.join(dir, entry.name);
          const rel = path.relative(base, full);
          if (entry.isDirectory() && currentDepth < maxDepth) {
            items.push({ name: entry.name, path: rel, type: 'dir' });
            if (!['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) {
              items.push(...walk(full, currentDepth + 1, maxDepth));
            }
          } else if (entry.isFile()) {
            items.push({ name: entry.name, path: rel, type: 'file', size: statSync(full).size });
          }
        }
      } catch {}
      return items;
    }
    const tree = walk(base, 0, parseInt(depth));
    res.json(tree);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/write — write a file (agent mode) or draft a diff (suggest mode)
router.post('/agent/write', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { path: targetPath, content, scope = 'sandbox', session_id, mode = 'agent' } = req.body;
    if (!targetPath || content === undefined) return res.status(400).json({ error: 'path and content required' });
    const resolved = resolveSandboxPath(scope, targetPath);
    const fs = await import('fs');
    if (content.length > 500_000) return res.status(400).json({ error: 'Content too large (max 500KB)' });

    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;

    if (mode === 'suggest') {
      let oldContent = '';
      try { oldContent = await fs.promises.readFile(resolved, 'utf-8'); } catch {}
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'write', targetPath, content, 'awaiting approval', 'pending');
      res.json({
        action: 'draft',
        path: targetPath,
        oldContent: oldContent.slice(0, 20000),
        newContent: content,
        truncated: oldContent.length > 20000,
        action_id: actionId,
        requiresApproval: true,
      });
    } else {
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(resolved, content, 'utf-8');
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'write', targetPath, content, 'written', 'completed');
      broadcast('agent:action', { type: 'write', path: targetPath, session_id: sessionId, action_id: actionId });
      res.json({ action: 'written', path: targetPath, size: content.length, action_id: actionId });
    }
  } catch (e) {
    if (e.message.includes('Path traversal')) return res.status(403).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agent/approve — approve a pending action (suggest mode)
router.post('/agent/approve', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { action_id, scope = 'sandbox' } = req.body;
    if (!action_id) return res.status(400).json({ error: 'action_id required' });
    const action = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(action_id);
    if (!action) return res.status(404).json({ error: 'Action not found' });
    if (action.status !== 'pending') return res.status(400).json({ error: 'Action already processed' });

    const resolved = resolveSandboxPath(scope, action.target);
    const fs = await import('fs');
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, action.content || '', 'utf-8');
    stmts.agentActions.updateStatus.run('approved', req.user.id, action_id);
    broadcast('agent:action', { type: 'approved', action_id, path: action.target });
    res.json({ action: 'approved', path: action.target, action_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/reject — reject a pending action
router.post('/agent/reject', authMiddleware, (req, res) => {
  try {
    const { action_id } = req.body;
    if (!action_id) return res.status(400).json({ error: 'action_id required' });
    stmts.agentActions.updateStatus.run('rejected', req.user.id, action_id);
    broadcast('agent:action', { type: 'rejected', action_id });
    res.json({ action: 'rejected', action_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/exec — execute a shell command (agent mode only)
router.post('/agent/exec', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
  try {
    const { command, scope = 'sandbox', session_id, cwd } = req.body;
    if (!command) return res.status(400).json({ error: 'command required' });
    if (!isCmdSafe(command)) return res.status(403).json({ error: 'Command blocked by safety filter' });
    // execSync is injected by the skill runtime
    const workDir = scope === 'home' ? HOME_DIR : resolveSandboxPath(scope, cwd || '.');
    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;

    try {
      const stdout = execSync(command, {
        timeout: 30000,
        maxBuffer: 1024 * 100,
        cwd: workDir,
        encoding: 'utf-8',
      });
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'exec', command, stdout.slice(0, 5000), 'completed', 'completed');
      broadcast('agent:action', { type: 'exec', command, session_id: sessionId, action_id: actionId });
      res.json({ exitCode: 0, stdout: stdout.slice(0, 5000), stderr: '', action_id: actionId });
    } catch (e) {
      stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'exec', command, '', (e.stderr || '').slice(0, 2000), 'failed', 'failed');
      res.json({ exitCode: e.status || 1, stdout: (e.stdout || '').toString().slice(0, 5000), stderr: (e.stderr || '').toString().slice(0, 2000), action_id: actionId });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/iterate — feed results back to LLM for next action
router.post('/agent/iterate', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { session_id, context, model } = req.body;
    const session = session_id ? stmts.agentSessions.getById.get(session_id) : null;
    const task = session?.task || context?.task || 'Continue working';
    const actions = session_id ? stmts.agentActions.getBySession.all(session_id) : [];
    const actionSummary = actions.slice(-5).map(a => `[${a.action_type}] ${a.target || ''}: ${(a.result || a.content || '').slice(0, 200)}`).join('\n');

    const iteratePrompt = `You are Aimi, an autonomous coding agent. Continue working on this task.
Task: ${task}
Mode: ${session?.mode || 'agent'}

Recent actions:
${actionSummary || 'No actions yet'}

New context: ${context?.message || 'Continue'}

Respond with the NEXT action as JSON:
{ "action": "read|write|exec|response", "target": "path or command", "content": "file content if write", "done": false }
If task is complete, respond with: { "action": "response", "target": "complete", "content": "summary of what was done", "done": true }`;

    const result = await callAgentLLM([
      { role: 'system', content: iteratePrompt },
      { role: 'user', content: context?.message || 'Continue' }
    ], model || session?.model);

    let nextAction;
    try {
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      nextAction = JSON.parse(jsonMatch ? jsonMatch[0] : result.content);
    } catch {
      nextAction = { action: 'response', target: 'LLM response', content: result.content.slice(0, 1000), done: false };
    }

    const actionId = randomUUID();
    const sessionId = (session_id && stmts.agentSessions.getById.get(session_id)) ? session_id : null;
    const stepIdx = sessionId ? (stmts.agentActions.getBySession.all(sessionId).length) : 0;
    stmts.agentActions.insert.run(actionId, sessionId, stepIdx, 'iterate', nextAction.target || '', nextAction.content || '', JSON.stringify(nextAction), 'completed');

    if (nextAction.done && sessionId) {
      stmts.agentSessions.updateStatus.run('completed', sessionId);
      broadcast('agent:session', { type: 'completed', session_id: sessionId });
    }

    res.json({
      nextAction,
      model: result.model,
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
      done: nextAction.done || false,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/agent/sessions/:id — delete a session
router.delete('/agent/sessions/:id', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    db.prepare('DELETE FROM agent_actions WHERE session_id = ?').run(req.params.id);
    stmts.agentSessions.delete.run(req.params.id);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Autopilot Endpoints (server-side agent loop) ─────────────────

// POST /api/agent/run — start autonomous agent loop for a session
router.post('/agent/run', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { session_id, max_steps, model } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const session = stmts.agentSessions.getById.get(session_id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (session.status === 'executing') return res.status(409).json({ error: 'Session is already running' });

    // Start the loop (async — doesn't block the response)
    runAgentLoop(session_id, { maxSteps: max_steps, model })
      .then(result => {
        logger.info(`Agent loop completed for ${session_id}: ${result.completed ? 'done' : 'stopped'} in ${result.steps} steps`);
      })
      .catch(err => {
        logger.error(`Agent loop failed for ${session_id}: ${err.message}`);
        stmts.agentSessions.updateStatus.run('failed', session_id);
        broadcast('agent:loop:error', { session_id, error: err.message });
      });

    res.json({ started: true, session_id, max_steps: max_steps || MAX_AGENT_STEPS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/sessions/:id/resume — resume a paused/failed session
router.post('/agent/sessions/:id/resume', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (session.status === 'executing') return res.status(409).json({ error: 'Session is already running' });

    const { max_steps, model } = req.body;

    runAgentLoop(req.params.id, { maxSteps: max_steps, model })
      .then(result => {
        logger.info(`Agent loop resumed for ${req.params.id}: ${result.completed ? 'done' : 'stopped'} in ${result.steps} steps`);
      })
      .catch(err => {
        logger.error(`Agent loop resume failed for ${req.params.id}: ${err.message}`);
        stmts.agentSessions.updateStatus.run('failed', req.params.id);
        broadcast('agent:loop:error', { session_id: req.params.id, error: err.message });
      });

    res.json({ resumed: true, session_id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/agent/sessions/:id/stop — stop a running session
router.post('/agent/sessions/:id/stop', authMiddleware, (req, res) => {
  try {
    const session = stmts.agentSessions.getById.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    stmts.agentSessions.updateStatus.run('stopped', req.params.id);
    broadcast('agent:loop:stopped', { session_id: req.params.id });
    res.json({ stopped: true, session_id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/agent/tools — list available agent tools
router.get('/agent/tools', authMiddleware, (_req, res) => {
  res.json(agentTools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  })));
});


  return router;
}

export { callAgentLLM, callAgentLLMWithRetry, agentTools };
