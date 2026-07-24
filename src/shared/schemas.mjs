/**
 * Cardinal Frame — Shared Type Schemas
 *
 * Single source of truth for API contract shapes.
 * Server validates outbound responses; client imports schemas for safety.
 *
 * Usage (server, .mjs):
 *   import { GraphResponseSchema } from '../shared/schemas.mjs';
 *   const data = GraphResponseSchema.parse(raw); // validates + strips
 *
 * Usage (client, .jsx/.tsx):
 *   import { GraphResponseSchema } from '../../src/shared/schemas.mjs';
 *   // Type is derived from schema:
 *   /** @typedef {z.infer<typeof GraphResponseSchema>} GraphResponse *\/
 *   // Or just use the schema for runtime validation.
 *
 * Drift detection: changing a field here causes a runtime validation error
 * on the other side if the payload doesn't match.
 */

import { z } from 'zod';

// ─── Primitives ───────────────────────────────────────────────────────

export const IdSchema = z.string();
export const IsoTimestampSchema = z.string();

// ─── Graph ────────────────────────────────────────────────────────────

export const NodeGroupSchema = z.enum([
  'cluster', 'user', 'provider', 'agent', 'task', 'dag',
  'skill', 'tool', 'group', 'file', 'conversation', 'plugin', 'schedule',
]);

export const ClusterSchema = z.enum([
  'runtime', 'models', 'interface', 'integrate', 'infra',
]);

export const LinkTypeSchema = z.enum([
  'hosts', 'registered', 'assigned', 'depends_on', 'uses', 'member_of',
  'connects', 'produces', 'owns', 'watches', 'scheduled_by',
]);

/** Graph node — rendered by NeuralMap / DAGEditor */
export const GraphNodeSchema = z.object({
  id: IdSchema,
  name: z.string().optional(),
  group: NodeGroupSchema,
  cluster: ClusterSchema.optional(),
  role: z.string().optional(),
  ptype: z.string().optional(),         // provider type (e.g. 'nvidia', 'openai')
  status: z.string().optional(),
  endpoint: z.string().optional(),
  lastPing: z.string().nullable().optional(),
  detectedAt: z.string().nullable().optional(),
  modelCount: z.number().optional(),
  memberCount: z.number().optional(),
  capabilities: z.array(z.string()).optional(),
  // Runtime layout coords — injected by force simulation, not persisted
  x: z.number().optional(),
  y: z.number().optional(),
  vx: z.number().optional(),
  vy: z.number().optional(),
});

/** Graph edge — source/target may be string IDs or node refs (d3 mutates) */
export const GraphLinkSchema = z.object({
  source: z.union([IdSchema, z.any()]),  // d3 replaces string with node ref
  target: z.union([IdSchema, z.any()]),
  type: LinkTypeSchema.optional().or(z.string()),
  strength: z.number().default(1),
});

/** GET /api/graph response */
export const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  links: z.array(GraphLinkSchema),
  meta: z.object({
    nodeCount: z.number(),
    linkCount: z.number(),
    generatedAt: IsoTimestampSchema,
  }).optional(),
});

/** GET /api/graph/subtree/:node_id response */
export const GraphSubtreeResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  links: z.array(GraphLinkSchema),
  parentId: IdSchema.optional(),
});

// ─── Agent ────────────────────────────────────────────────────────────

export const AgentSchema = z.object({
  id: IdSchema,
  name: z.string(),
  version: z.string().default('1.0'),
  capabilities: z.array(z.string()).default([]),
  status: z.enum(['active', 'idle', 'offline', 'error']).default('active'),
  registered_at: IsoTimestampSchema.optional(),
  last_heartbeat: IsoTimestampSchema.optional(),
});

export const AgentSessionSchema = z.object({
  id: IdSchema,
  user_id: IdSchema,
  goal: z.string(),
  status: z.enum(['planning', 'executing', 'completed', 'failed', 'stopped', 'paused']).default('planning'),
  plan: z.array(z.any()).default([]),
  max_steps: z.number().optional(),
  model: z.string().optional(),
  created_at: IsoTimestampSchema.optional(),
  updated_at: IsoTimestampSchema.optional(),
});

export const AgentActionSchema = z.object({
  id: IdSchema,
  session_id: IdSchema,
  step: z.number(),
  type: z.string(),
  target: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'executed', 'failed']).default('pending'),
  created_at: IsoTimestampSchema.optional(),
});

// ─── Task ─────────────────────────────────────────────────────────────

export const TaskSchema = z.object({
  id: IdSchema,
  name: z.string(),
  command: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'retrying']).default('pending'),
  result: z.string().nullable().optional(),
  exit_code: z.number().nullable().optional(),
  created_at: IsoTimestampSchema.optional(),
  started_at: IsoTimestampSchema.nullable().optional(),
  finished_at: IsoTimestampSchema.nullable().optional(),
  user_id: IdSchema.optional(),
  assigned_agent_id: IdSchema.optional(),
});

export const TaskLogSchema = z.object({
  id: z.number(),
  task_id: IdSchema,
  stream: z.enum(['stdout', 'stderr']),
  line: z.string(),
  ts: IsoTimestampSchema.optional(),
});

// ─── DAG ──────────────────────────────────────────────────────────────

export const DagSchema = z.object({
  id: IdSchema,
  name: z.string(),
  nodes: z.array(z.any()).default([]),   // JSON-encoded in DB, parsed on read
  edges: z.array(z.any()).default([]),
  status: z.enum(['draft', 'ready', 'running', 'completed', 'failed']).default('draft'),
  last_run_result: z.any().nullable().optional(),
  created_at: IsoTimestampSchema.optional(),
  updated_at: IsoTimestampSchema.optional(),
  user_id: IdSchema.optional(),
});

// ─── Skill ────────────────────────────────────────────────────────────

export const SkillSchema = z.object({
  id: IdSchema,
  name: z.string(),
  description: z.string().default(''),
  trigger: z.string().default(''),
  handler: z.string().default(''),       // JS code or reference
  category: z.string().default('general'),
  priority: z.number().default(0),
  enabled: z.boolean().default(true),
  validated: z.boolean().default(false),
  created_at: IsoTimestampSchema.optional(),
  updated_at: IsoTimestampSchema.optional(),
});

// ─── LLM Provider / Model ─────────────────────────────────────────────

export const LlmProviderSchema = z.object({
  id: IdSchema,
  name: z.string(),
  type: z.string(),                         // 'nvidia', 'openai', 'groq', etc.
  base_url: z.string(),
  api_key_env: z.string().optional(),       // env var name, never the key itself
  enabled: z.boolean().default(true),
  detected_at: IsoTimestampSchema.optional(),
  last_ping: IsoTimestampSchema.nullable().optional(),
});

export const LlmModelSchema = z.object({
  id: IdSchema,
  provider_id: IdSchema,
  model_id: z.string(),                    // vendor model identifier
  display_name: z.string(),
  context_window: z.number().optional(),
  cost_per_1k_input: z.number().optional(),
  cost_per_1k_output: z.number().optional(),
  enabled: z.boolean().default(true),
  detected_at: IsoTimestampSchema.optional(),
});

// ─── Token Usage / Cost ───────────────────────────────────────────────

export const TokenUsageSchema = z.object({
  id: IdSchema,
  timestamp: IsoTimestampSchema,
  provider: z.string(),
  model: z.string(),
  agent_id: IdSchema.optional(),
  task_id: IdSchema.optional(),
  session_id: IdSchema.optional(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_estimate: z.number(),
});

// ─── User ─────────────────────────────────────────────────────────────

export const UserSchema = z.object({
  id: IdSchema,
  username: z.string(),
  role: z.enum(['user', 'admin']).default('user'),
  metadata: z.record(z.string(), z.any()).default({}),
  created_at: IsoTimestampSchema.optional(),
});

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: UserSchema,           // password_hash never included in responses
});

// ─── API Envelope ─────────────────────────────────────────────────────

/** Standard error response shape */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.any().optional(),
  }),
});

/** Paginated list response factory */
export const PaginatedSchema = (item) =>
  z.object({
    items: z.array(item),
    total: z.number(),
    page: z.number().default(1),
    perPage: z.number().default(50),
  });

// ─── All exports ──────────────────────────────────────────────────────

export const Schemas = {
  GraphNode: GraphNodeSchema,
  GraphLink: GraphLinkSchema,
  GraphResponse: GraphResponseSchema,
  GraphSubtree: GraphSubtreeResponseSchema,
  Agent: AgentSchema,
  AgentSession: AgentSessionSchema,
  AgentAction: AgentActionSchema,
  Task: TaskSchema,
  TaskLog: TaskLogSchema,
  Dag: DagSchema,
  Skill: SkillSchema,
  LlmProvider: LlmProviderSchema,
  LlmModel: LlmModelSchema,
  TokenUsage: TokenUsageSchema,
  User: UserSchema,
  AuthResponse: AuthResponseSchema,
  ApiError: ApiErrorSchema,
  Paginated: PaginatedSchema,
};
