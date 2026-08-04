/**
 * Zod input validation middleware.
 * 
 * Usage in route handlers:
 *   import { validateBody, validateQuery, validateParams } from './validate.mjs';
 *   import { z } from 'zod';
 *   
 *   const schema = z.object({
 *     username: z.string().min(1).max(50),
 *     password: z.string().min(6),
 *   });
 *   
 *   router.post('/login', validateBody(schema), handler);
 */
import { z } from 'zod';

/**
 * Validates req.body against a Zod schema.
 * On success: req.body is replaced with the validated/parsed data.
 * On failure: 400 with error details.
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validates req.query against a Zod schema.
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        details: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.query = result.data;
    next();
  };
}

/**
 * Validates req.params against a Zod schema.
 */
export function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return res.status(400).json({
        error: 'Invalid parameters',
        details: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.params = result.data;
    next();
  };
}

// ─── Common Schemas ─────────────────────────────────────────────

export const schemas = {
  // Auth
  login: z.object({
    username: z.string().min(1).max(50),
    password: z.string().min(1),
  }),
  register: z.object({
    username: z.string().min(1).max(50),
    password: z.string().min(6).max(200),
  }),
  resetConfirm: z.object({
    token: z.string().min(1),
    password: z.string().min(6).max(200),
  }),

  // Tasks
  createTask: z.object({
    name: z.string().min(1).max(200),
    command: z.string().min(1).max(1000),
    dependsOn: z.array(z.string()).optional(),
  }),
  patchTask: z.object({
    status: z.enum(['pending', 'running', 'done', 'failed', 'cancelled']).optional(),
    assigned_agent_id: z.string().optional(),
    result: z.string().optional(),
    exit_code: z.number().optional(),
  }),

  // Agents
  createAgent: z.object({
    name: z.string().min(1).max(100),
  }),

  // DAGs
  createDag: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    edges: z.array(z.object({
      source_task: z.string(),
      target_task: z.string(),
    })).optional(),
  }),

  // Chat
  chatCompletion: z.object({
    model: z.string().min(1),
    messages: z.array(z.object({
      role: z.string(),
      content: z.string(),
    })).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(32768).optional(),
  }),

  // LLM Provider
  createProvider: z.object({
    name: z.string().min(1).max(100),
    type: z.string().min(1),
    base_url: z.string().url().optional(),
    api_key: z.string().optional(),
    enabled: z.boolean().optional(),
  }),

  // Skills
  createSkill: z.object({
    name: z.string().min(1).max(100),
    handler: z.string().max(50000),
    trigger: z.string().max(500).optional(),
    type: z.enum(['template', 'hybrid', 'script']).optional(),
    model: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),

  // MCP Server
  createMcpServer: z.object({
    name: z.string().min(1).max(100),
    transport: z.enum(['stdio', 'http', 'sse']),
    command: z.string().max(500).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    enabled: z.boolean().optional(),
  }),

  // File Watcher
  createWatcher: z.object({
    path: z.string().min(1).max(1000),
  }),

  // Profile update
  profileUpdate: z.object({
    value: z.any(),
    action: z.enum(['set', 'lock', 'dismiss']).optional(),
  }),

  // Sandbox execute
  sandboxExecute: z.object({
    code: z.string().min(1).max(10000),
    language: z.enum(['javascript', 'python']).optional(),
    warden_approve: z.boolean().optional(),
  }),

  // UUID param
  uuidParam: z.object({
    id: z.string().min(1),
  }),
};
