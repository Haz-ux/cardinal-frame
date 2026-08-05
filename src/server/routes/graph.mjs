import express from 'express';
import { GraphResponseSchema } from '../../shared/schemas.mjs';

/**
 * Graph routes: /api/graph, /api/graph/core, /api/graph/expand
 * Neural Map — clustered Obsidian-style connection graph
 * Dependencies: db, stmts, optionalAuth, logger
 */
export default function graphRoutes(ctx) {
  const { db, stmts, optionalAuth, logger, nodeRegistry } = ctx;
  const router = express.Router();

router.get('/graph', optionalAuth, async (_req, res) => {
 const nodes = [];
 const links = [];
 const nodeIndex = new Set();
 const linkSet = new Set(); // dedup: "src|tgt|type"
 const addNode = (id, props) => { if (!nodeIndex.has(id)) { nodeIndex.add(id); nodes.push({ id, ...props }); } };
 const addLink = (src, tgt, type, strength = 1) => {
  if (!nodeIndex.has(src) || !nodeIndex.has(tgt)) return;
  const key = `${src}|${tgt}|${type}`;
  if (linkSet.has(key)) return;
  linkSet.add(key);
  links.push({ source: src, target: tgt, type, strength });
 };

 // Cluster head nodes — one per functional domain. These are the local hubs.
 // Their positions seed the layout; satellites orbit them via forceRadial.
 const CLUSTERS = {
  runtime:  { name: 'Runtime',      group: 'cluster', cluster: 'runtime',  status: 'active' },
  models:   { name: 'Models',       group: 'cluster', cluster: 'models',   status: 'active' },
  interface:{ name: 'Interface',    group: 'cluster', cluster: 'interface',status: 'active' },
  integrate:{ name: 'Integrations', group: 'cluster', cluster: 'integrate',status: 'active' },
  infra:    { name: 'Infra',        group: 'cluster', cluster: 'infra',    status: 'active' },
 };
 for (const [id, props] of Object.entries(CLUSTERS)) addNode(`cluster:${id}`, props);

 // ─── Central hub — the "Cardinal" main node ───────────────────
 // This is the anchor every cluster and satellite orbits. The layout
 // engine special-cases group 'system': radial force pins it at (0,0),
 // angular force ignores it, collide keeps it small, and it freezes
 // last. Everything else is positioned relative to it.
 addNode('system', {
  name: 'Cardinal',
  group: 'system',
  cluster: 'system',
  status: 'active',
  activity: 0,
  isCore: true,
 });

// Cluster hub ring — weak links between adjacent cluster heads so the
// clusters don't float independently when they have no satellites.
// Without this, empty clusters (runtime, models, interface) drift and
// pile up at the center because forceRadial alone can't separate them.
const clusterIds = Object.keys(CLUSTERS);
for (let i = 0; i < clusterIds.length; i++) {
  const next = (i + 1) % clusterIds.length;
  addLink(`cluster:${clusterIds[i]}`, `cluster:${clusterIds[next]}`, 'bridge', 0.3);
}
 // ─── Cardinal → cluster bridges ───────────────────────────────
 // Hub links that anchor each cluster to the central node, so clusters
 // orbit Cardinal instead of floating as a disconnected ring.
 for (const id of clusterIds) addLink('system', `cluster:${id}`, 'bridge', 0.5);

 // ─── Users (Interface cluster) — exclude test-pattern users ──
 const users = db.prepare(`SELECT id, username, role FROM users
   WHERE username NOT LIKE 'boot_%' AND username NOT LIKE 'noboot_%'
     AND username NOT LIKE 'token_%' AND username NOT LIKE 'pw_%'
     AND username NOT LIKE 'chat_%' AND username NOT LIKE 'upload_%'
     AND username NOT LIKE 'uichat_%' AND username NOT LIKE 'uiskill_%'
     AND username NOT LIKE 'e2e_%' AND username NOT LIKE 'debug%'
     AND username NOT LIKE 'test%' AND username NOT LIKE 'auth%'`).all();
 for (const u of users) {
   addNode(`user:${u.id}`, { name: u.username, group: 'user', cluster: 'interface', role: u.role });
   addLink(`cluster:interface`, `user:${u.id}`, 'hosts', 2);
 }

 // ─── Providers (Models cluster) ─────────────────────────────
  const providers = stmts.providers.getAll.all();
  // usage: token_usage rows per provider — lets the client hide unused providers
  const usageMap = new Map();
  try { for (const row of (stmts.graph.providerUsageCounts?.all() || [])) usageMap.set(row.provider_id, row.c); } catch {}
  for (const p of providers) {
   addNode(`provider:${p.id}`, { name: p.name, group: 'provider', cluster: 'models',
     ptype: p.type, status: p.enabled ? 'active' : 'idle',
     endpoint: p.base_url, lastPing: p.last_ping, detectedAt: p.detected_at,
     usageCount: usageMap.get(p.id) || 0 });
   addLink(`cluster:models`, `provider:${p.id}`, 'hosts', 2);
   // count: models under provider
   let mc = 0;
   try { mc = stmts.graph.modelCountByProvider.get(p.id).c; } catch {}
   if (mc) {
     const pn = nodes[nodes.length - 1];
     pn.modelCount = mc;
   }
  }

 // ─── Models (Models cluster, attached to real providers, no individual nodes) ─
 // Per your spec, individual model nodes would be bloat. The provider node
 // carries modelCount metadata instead. If you ever want per-model nodes,
 // uncomment this block — but it will double the node count.
 /*
 try {
   const models = db.prepare('SELECT id, provider_id, display_name, context_window FROM llm_models').all();
   for (const m of models) {
     addNode(`model:${m.id}`, { name: (m.display_name || '').split('/').pop() || m.id.slice(0,8),
       group: 'model', cluster: 'models', context: m.context_window });
     if (nodeIndex.has(`provider:${m.provider_id}`)) addLink(`provider:${m.provider_id}`, `model:${m.id}`, 'provides', 1);
   }
 } catch {}
 */

 // ─── Agents (Runtime cluster) ───────────────────────────────
 try {
   const agents = stmts.agents.getAllWithHeartbeat.all();
   const now = Date.now();
   for (const a of agents) {
     let hbAge = null;
     if (a.last_heartbeat) {
       try { hbAge = Math.floor((now - new Date(a.last_heartbeat + 'Z').getTime()) / 1000); } catch {}
     }
     const activity = a.status === 'active' ? 10 : a.status === 'stale' ? 4 : 0;
     addNode(`agent:${a.id}`, { name: a.name, group: 'agent', cluster: 'runtime',
       status: a.status, capabilities: (() => { try { return JSON.parse(a.capabilities || '[]'); } catch { return []; } })(),
       hbAge, activity, isDefault: a.name === 'Aimi' ? true : undefined });
     addLink(`cluster:runtime`, `agent:${a.id}`, 'hosts', 2);

     // Agent → provider (real "uses" edge: agent.model matches provider.name or model id)
     if (a.model) {
       try {
         const model = stmts.graph.modelProvider.get(a.model, a.model);
         if (model && nodeIndex.has(`provider:${model.provider_id}`)) {
           addLink(`agent:${a.id}`, `provider:${model.provider_id}`, 'uses', 3);
         } else {
           // fallback: match by name token
           const modelLc = String(a.model).toLowerCase();
           for (const pn of nodes) {
             if (pn.group === 'provider' && modelLc.includes(pn.name.toLowerCase().split(' ')[0])) {
               addLink(`agent:${a.id}`, pn.id, 'uses', 3); break;
             }
           }
         }
       } catch {}
     }
   }
 } catch (e) { /* agents table may not exist yet */ }

 // ─── Agent Groups (Runtime cluster) ──— groups connect to their agents, not the cluster hub
 try {
   const groups = stmts.graph.agentGroups.all();
   for (const g of groups) {
     const members = stmts.graph.groupMembers.all(g.id);
     if (members.length === 0) continue; // skip empty groups (no edges = orphan)
     addNode(`group:${g.id}`, { name: g.name, group: 'group', cluster: 'runtime', memberCount: members.length });
     addLink(`cluster:runtime`, `group:${g.id}`, 'member', 1);
     for (const m of members) {
       if (nodeIndex.has(`agent:${m.agent_id}`)) addLink(`group:${g.id}`, `agent:${m.agent_id}`, 'member', 2);
     }
   }
 } catch {}

 // ─── Tasks (Runtime cluster) — assigned to agent, dependencies to other tasks ──
 try {
   const tasks = stmts.graph.recentTasks.all();
   for (const t of tasks) {
     addNode(`task:${t.id}`, { name: t.name || t.id.slice(0,8), group: 'task', cluster: 'runtime', status: t.status });
     if (t.assigned_agent_id && nodeIndex.has(`agent:${t.assigned_agent_id}`)) {
       addLink(`agent:${t.assigned_agent_id}`, `task:${t.id}`, 'assigned', 3);
     } else {
       // unassigned tasks link to the runtime cluster
       addLink(`cluster:runtime`, `task:${t.id}`, 'task', 1);
     }
   }
   // Task dependencies (real edges between tasks)
   try {
     const deps = stmts.graph.allDeps.all();
     for (const d of deps) {
       if (nodeIndex.has(`task:${d.depends_on_task_id}`) && nodeIndex.has(`task:${d.task_id}`)) {
         addLink(`task:${d.depends_on_task_id}`, `task:${d.task_id}`, 'depends', 2);
       }
     }
   } catch {}
 } catch {}

 // ─── Schedules (Runtime cluster) — real edge to the agent they schedule ──
 try {
   const schedules = stmts.graph.schedules.all();
   for (const s of schedules) {
     addNode(`schedule:${s.id}`, { name: s.name, group: 'schedule', cluster: 'runtime',
       status: s.enabled ? 'active' : 'idle', cron: s.cron_expr });
     if (s.agent_id && nodeIndex.has(`agent:${s.agent_id}`)) {
       addLink(`agent:${s.agent_id}`, `schedule:${s.id}`, 'schedule', 2);
     } else {
       addLink(`cluster:runtime`, `schedule:${s.id}`, 'schedule', 1);
     }
   }
 } catch {}

 // ─── Skills + Tools (Integrations cluster) — tool→skill (provides), skill↔cluster ──
 try {
   const skills = stmts.skills.getAll.all();
   for (const s of skills) {
     let uses = 0;
     try { uses = stmts.graph.skillUseCount?.get(s.id).c ?? 0; } catch {}
     addNode(`skill:${s.id}`, { name: s.name, group: 'skill', cluster: 'integrate',
       category: s.category, activity: uses, version: s.version,
       executionBackend: s.execution_backend || 'local' });
     addLink(`cluster:integrate`, `skill:${s.id}`, 'hosts', 1);
     // Skill ↔ plugin if the plugin hooks this skill
     try {
       const plugins = stmts.graph.pluginsByHook.all(`%${s.id}%`);
       for (const p of plugins) {
         if (!nodeIndex.has(`plugin:${p.id}`)) {
           addNode(`plugin:${p.id}`, { name: p.name, group: 'plugin', cluster: 'integrate',
             version: p.version, status: p.enabled ? 'active' : 'idle' });
           addLink(`cluster:integrate`, `plugin:${p.id}`, 'hosts', 1);
         }
         addLink(`skill:${s.id}`, `plugin:${p.id}`, 'plugin', 1);
       }
     } catch {}
   }
   try {
     const tools = stmts.graph.allTools.all();
     for (const t of tools) {
       addNode(`tool:${t.id}`, { name: t.name, group: 'tool', cluster: 'integrate',
         endpoint: t.endpoint, status: t.enabled ? 'active' : 'idle' });
       if (t.skill_id && nodeIndex.has(`skill:${t.skill_id}`)) {
         addLink(`skill:${t.skill_id}`, `tool:${t.id}`, 'provides', 2);
       } else {
         addLink(`cluster:integrate`, `tool:${t.id}`, 'tool', 1);
       }
     }
   } catch {}
 } catch {}

 // ─── MCP Servers (Integrations cluster) ──────────────────────
 try {
   const mcpServers = stmts.graph.mcpServers.all();
   for (const m of mcpServers) {
     addNode(`mcp:${m.id}`, { name: m.name, group: 'mcp', cluster: 'integrate', status: m.status, transport: m.transport });
     addLink(`cluster:integrate`, `mcp:${m.id}`, 'hosts', 1);
   }
 } catch {}

 // ─── Plugins (without skill hooks live under infra as cross-cutting)
 try {
   const allPlugins = stmts.graph.allPlugins.all();
   for (const p of allPlugins) {
     if (nodeIndex.has(`plugin:${p.id}`)) continue; // already added via skill hook
     addNode(`plugin:${p.id}`, { name: p.name, group: 'plugin', cluster: 'infra',
       version: p.version, status: p.enabled ? 'active' : 'idle' });
     addLink(`cluster:infra`, `plugin:${p.id}`, 'hosts', 1);
   }
 } catch {}

 // ─── DAGs (Infra cluster) ────────────────────────────────────
 try {
   const dags = stmts.graph.allDags.all();
   for (const d of dags) {
     addNode(`dag:${d.id}`, { name: d.name, group: 'dag', cluster: 'infra', status: d.status });
     addLink(`cluster:infra`, `dag:${d.id}`, 'workflow', 1);
   }
 } catch {}

 // ─── File Watchers (Infra cluster) ──────────────────────────
 try {
   const watchers = stmts.graph.fileWatchers.all();
   for (const w of watchers) {
     addNode(`watcher:${w.id}`, { name: w.path.split('/').pop(), group: 'watcher', cluster: 'infra',
       status: w.enabled ? 'active' : 'idle', path: w.path });
     addLink(`cluster:infra`, `watcher:${w.id}`, 'watcher', 1);
   }
 } catch {}

 // ─── Env Vars (Infra cluster — keys only, not values for security) ──
 try {
   const envVars = stmts.graph.envVars.all();
   for (const v of envVars) {
     addNode(`env:${v.key}`, { name: v.key, group: 'env', cluster: 'infra', category: v.category, encrypted: !!v.encrypted });
     // env vars don't get edges — they'd create hairball with every entity using them
   }
 } catch {}

 // ─── Remote Nodes (Infra cluster) — from node registry ──────
 try {
   if (nodeRegistry && typeof nodeRegistry.getAllNodes === 'function') {
     const remoteNodes = nodeRegistry.getAllNodes();
     for (const n of remoteNodes) {
       addNode(`node:${n.id}`, {
         name: n.name,
         group: 'node',
         cluster: 'infra',
         status: n.status,
         capabilities: n.capabilities || [],
         baseUrl: n.base_url,
         lastSeen: n.last_seen_at,
       });
       addLink(`cluster:infra`, `node:${n.id}`, 'hosts', 1);
     }
   }
 } catch (e) { /* node registry not initialized */ }

 // ─── Delegation Edges — agent→node, task→node ───────────────
 try {
   const delegations = db.prepare('SELECT id, parent_task_id, agent_id, node, status, capability FROM delegations ORDER BY created_at DESC LIMIT 50').all();
   for (const d of delegations) {
     // Find the node by name (d.node stores the node name, not id)
     let targetNodeId = null;
     if (nodeRegistry) {
       const allNodes = nodeRegistry.getAllNodes();
       const target = allNodes.find(n => n.name === d.node);
       if (target) targetNodeId = target.id;
     }
     if (targetNodeId && nodeIndex.has(`node:${targetNodeId}`)) {
       // Edge: agent → node (delegation)
       if (d.agent_id && nodeIndex.has(`agent:${d.agent_id}`)) {
         addLink(`agent:${d.agent_id}`, `node:${targetNodeId}`, 'delegates', 2);
       }
       // Edge: task → node (if parent task exists)
       if (d.parent_task_id && nodeIndex.has(`task:${d.parent_task_id}`)) {
         addLink(`task:${d.parent_task_id}`, `node:${targetNodeId}`, 'delegates', 2);
       }
     }
   }
 } catch (e) { /* delegations table may not exist */ }

 // ─── Conversations (Interface cluster) ──────────────────────
 try {
   const convs = stmts.graph.recentConvs.all();
   for (const c of convs) {
     let msgCount = 0;
     try { msgCount = stmts.graph.convMsgCount.get(c.id).c; } catch {}
     addNode(`conv:${c.id}`, { name: c.title || 'Untitled', group: 'conversation', cluster: 'interface', activity: msgCount });
     // Only include convs that have a real edge (user or provider)
     let hasEdge = false;
     if (c.user_id && nodeIndex.has(`user:${c.user_id}`)) {
       addLink(`user:${c.user_id}`, `conv:${c.id}`, 'chat', Math.max(1, Math.min(10, msgCount)));
       hasEdge = true;
     }
     if (c.model) {
       try {
         const model = stmts.graph.modelProvider.get(c.model, c.model);
         if (model && nodeIndex.has(`provider:${model.provider_id}`)) {
           addLink(`conv:${c.id}`, `provider:${model.provider_id}`, 'uses', 2);
           hasEdge = true;
         }
       } catch {}
     }
     // If no real edge, drop the node to keep graph meaningful
     if (!hasEdge) {
       const idx = nodes.findIndex(n => n.id === `conv:${c.id}`);
       if (idx >= 0) nodes.splice(idx, 1);
       nodeIndex.delete(`conv:${c.id}`);
     }
   }
 } catch {}

 // ─── Files (Interface cluster) — surfaced only if user edge exists ──
 try {
   const dbFiles = stmts.graph.dbFiles.all();
   for (const f of dbFiles) {
     let hasUser = !!(f.uploaded_by && nodeIndex.has(`user:${f.uploaded_by}`));
     if (!hasUser) continue; // orphan files don't surface — would be hairball
     addNode(`file:${f.id}`, { name: f.original_name, group: 'file', cluster: 'interface', mime: f.mime_type });
     addLink(`user:${f.uploaded_by}`, `file:${f.id}`, 'uploaded', 1);
   }
 } catch {}

 // ─── Inter-cluster bridge: weak link from runtime → models via agents that use providers ──
 // This pulls the clusters into a coherent layout: the agent→provider edges
 // serve as bridges between Runtime and Models naturally.

   // ── Server no longer assigns x/y to nodes. The client (NeuralMap.jsx)
   // is the single source of truth for layout — its targetXY() function
   // uses a deterministic per-node-ID hash and is cluster-size-aware,
   // avoiding the collision/pile-up regression caused by the old
   // index-based formula here that had only 180 distinct slots.
   // See MINERVA_HANDOFF_NEURAL_MAP_PILEUP_FIX.md for full root cause.

   // Validate response against shared schema (strips unknown keys, catches drift)
   const payload = { nodes, links, meta: {
     clusterHeads: Object.keys(CLUSTERS),
     version: 2,
     generated: Date.now(),
   }};
   const validated = GraphResponseSchema.safeParse(payload);
   if (!validated.success) {
     logger?.warn?.('Graph response schema validation failed:', validated.error.issues.slice(0, 5));
     // Still send the payload — don't break the UI for a schema mismatch
     res.json(payload);
   } else {
     res.json(validated.data);
   }
});

// ─── Graph: Core entities only (galaxy seed view) ──────────────────
router.get('/graph/core', optionalAuth, async (req, res) => {
  const nodes = [];
  const links = [];
  const nodeIndex = new Set();
  const addNode = (id, props) => { if (!nodeIndex.has(id)) { nodeIndex.add(id); nodes.push({ id, ...props }); } };
  const addLink = (src, tgt, type, strength) => { if (nodeIndex.has(src) && nodeIndex.has(tgt)) links.push({ source: src, target: tgt, type, strength: strength || 1 }); };

  // System hub
  addNode('system', { name: 'Cardinal Frame', group: 'system', status: 'active', activity: 0 });

  // Agents (key entities — always show)
  try {
    const agents = stmts.agents.getAllWithHeartbeat.all();
    let agentActivity = 0;
    for (const a of agents) {
      // Count sessions for activity score
      let sessionCount = 0;
      try { sessionCount = db.prepare('SELECT COUNT(*) as c FROM agent_sessions WHERE agent_id = ?').get(a.id).c; } catch {}
      const activity = sessionCount + (a.status === 'active' ? 10 : 0);
      agentActivity += activity;
      addNode(`agent:${a.id}`, { name: a.name, group: 'agent', status: a.status, activity });
      addLink('system', `agent:${a.id}`, 'registered', Math.max(1, activity));
    }
    // Update system activity
    const sysIdx = nodes.findIndex(n => n.id === 'system');
    if (sysIdx >= 0) nodes[sysIdx].activity = agentActivity;
  } catch {}

  // Active/recent tasks (key entities)
  try {
    const tasks = db.prepare('SELECT id, name, status, assigned_agent_id FROM tasks ORDER BY created_at DESC LIMIT 20').all();
    for (const t of tasks) {
      let taskActivity = 0;
      try { taskActivity = db.prepare('SELECT COUNT(*) as c FROM agent_sessions WHERE task_id = ?').get(t.id).c; } catch {}
      addNode(`task:${t.id}`, { name: t.name || t.id.slice(0,8), group: 'task', status: t.status, activity: taskActivity });
      if (t.assigned_agent_id && nodeIndex.has(`agent:${t.assigned_agent_id}`)) {
        addLink(`agent:${t.assigned_agent_id}`, `task:${t.id}`, 'assigned', Math.max(1, taskActivity));
      } else {
        addLink('system', `task:${t.id}`, 'task', 1);
      }
    }
    // Task dependencies
    try {
      const deps = stmts.graph.allDeps.all();
      for (const d of deps) { addLink(`task:${d.depends_on_task_id}`, `task:${d.task_id}`, 'depends', 1); }
    } catch {}
  } catch {}

  // Skills (key entities)
  try {
    const skills = stmts.skills.getAll.all();
    for (const s of skills) {
      let skillUses = 0;
      try { skillUses = db.prepare('SELECT COUNT(*) as c FROM skill_executions WHERE skill_id = ?').get(s.id).c; } catch {}
      addNode(`skill:${s.id}`, { name: s.name, group: 'skill', category: s.category, activity: skillUses });
      addLink('system', `skill:${s.id}`, 'registered', Math.max(1, skillUses));
    }
  } catch {}

  // Active conversations
  try {
    const convs = db.prepare('SELECT id, title, user_id, model FROM chat_conversations ORDER BY updated_at DESC LIMIT 10').all();
    for (const c of convs) {
      let msgCount = 0;
      try { msgCount = stmts.graph.convMsgCount.get(c.id).c; } catch {}
      addNode(`conv:${c.id}`, { name: c.title || 'Untitled', group: 'conversation', activity: msgCount });
      if (c.user_id && nodeIndex.has(`user:${c.user_id}`)) {
        addLink(`user:${c.user_id}`, `conv:${c.id}`, 'chat', Math.max(1, msgCount));
      } else {
        addLink('system', `conv:${c.id}`, 'chat', Math.max(1, msgCount));
      }
    }
  } catch {}

  // Comms channels (if any active)
  try {
    const channels = db.prepare('SELECT id, platform, enabled, trigger_agent FROM comms_channels').all();
    for (const ch of channels) {
      let msgCount = 0;
      try { msgCount = db.prepare('SELECT COUNT(*) as c FROM comms_messages WHERE channel_id = ?').get(ch.id).c; } catch {}
      addNode(`comms:${ch.id}`, { name: ch.platform, group: 'comms', status: ch.enabled ? 'active' : 'idle', activity: msgCount });
      addLink('system', `comms:${ch.id}`, 'api', Math.max(1, msgCount));
      if (ch.trigger_agent && nodeIndex.has(`agent:${ch.trigger_agent}`)) {
        addLink(`comms:${ch.id}`, `agent:${ch.trigger_agent}`, 'chat', 1);
      }
    }
  } catch {}

  res.json({ nodes, links });
});

// ─── Graph: Expand a node's neighbors on demand ───────────────────
router.get('/graph/expand', optionalAuth, async (req, res) => {
  const { node_id } = req.query;
  if (!node_id) return res.status(400).json({ error: 'node_id is required' });

  const nodes = [];
  const links = [];
  const nodeIndex = new Set([node_id]);
  const addNode = (id, props) => { if (!nodeIndex.has(id)) { nodeIndex.add(id); nodes.push({ id, ...props }); } };
  const addLink = (src, tgt, type, strength) => { if (nodeIndex.has(src) && nodeIndex.has(tgt)) links.push({ source: src, target: tgt, type, strength: strength || 1 }); };

  // Parse the node_id to determine what to expand
  const [prefix, ...rest] = node_id.split(':');
  const entityId = rest.join(':');

  switch (prefix) {
    case 'system': {
      // Expand system → show providers, models, groups, plugins, schedules, watchers, env
      try {
        const providers = stmts.providers.getAll.all();
        for (const p of providers) {
          addNode(`provider:${p.id}`, { name: p.name, group: 'provider', ptype: p.type, status: p.enabled ? 'active' : 'idle', activity: 0 });
          addLink('system', `provider:${p.id}`, 'api', 1);
        }
        const groups = db.prepare('SELECT id, name FROM agent_groups').all();
        for (const g of groups) {
          addNode(`group:${g.id}`, { name: g.name, group: 'group', activity: 0 });
          addLink('system', `group:${g.id}`, 'group', 1);
        }
        const plugins = db.prepare('SELECT id, name, version, enabled FROM plugins').all();
        for (const p of plugins) {
          addNode(`plugin:${p.id}`, { name: p.name, group: 'plugin', version: p.version, status: p.enabled ? 'active' : 'idle', activity: 0 });
          addLink('system', `plugin:${p.id}`, 'plugin', 1);
        }
        const schedules = db.prepare('SELECT id, name, agent_id, enabled FROM schedules').all();
        for (const s of schedules) {
          addNode(`schedule:${s.id}`, { name: s.name, group: 'schedule', status: s.enabled ? 'active' : 'idle', activity: 0 });
          addLink('system', `schedule:${s.id}`, 'schedule', 1);
        }
        const watchers = db.prepare('SELECT id, path, enabled FROM file_watchers').all();
        for (const w of watchers) {
          addNode(`watcher:${w.id}`, { name: w.path.split('/').pop(), group: 'watcher', status: w.enabled ? 'active' : 'idle', activity: 0 });
          addLink('system', `watcher:${w.id}`, 'watcher', 1);
        }
        const files = db.prepare('SELECT id, original_name, mime_type FROM files').all();
        for (const f of files) {
          addNode(`file:${f.id}`, { name: f.original_name, group: 'file', mime: f.mime_type, activity: 0 });
          addLink('system', `file:${f.id}`, 'uploaded', 1);
        }
      } catch {}
      break;
    }

    case 'agent': {
      // Expand agent → show its model, tasks, skills, sessions, schedules, groups
      try {
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(entityId);
        if (agent) {
          // Agent → model
          if (agent.model) {
            const model = db.prepare('SELECT id, display_name, context_window FROM llm_models WHERE model_id = ? OR display_name = ?').get(agent.model, agent.model);
            if (model) {
              addNode(`model:${model.id}`, { name: (model.display_name || agent.model).split('/').pop(), group: 'model', context: model.context_window, activity: 0 });
              addLink(node_id, `model:${model.id}`, 'uses', 2);
            }
          }
          // Agent → tasks
          const tasks = db.prepare('SELECT id, name, status FROM tasks WHERE assigned_agent_id = ?').all(entityId);
          for (const t of tasks) {
            let act = 0;
            try { act = db.prepare('SELECT COUNT(*) as c FROM agent_sessions WHERE task_id = ?').get(t.id).c; } catch {}
            addNode(`task:${t.id}`, { name: t.name || t.id.slice(0,8), group: 'task', status: t.status, activity: act });
            addLink(node_id, `task:${t.id}`, 'assigned', Math.max(1, act));
          }
          // Agent → groups
          const groups = db.prepare('SELECT g.id, g.name FROM agent_groups g JOIN agent_group_members m ON g.id = m.group_id WHERE m.agent_id = ?').all(entityId);
          for (const g of groups) {
            addNode(`group:${g.id}`, { name: g.name, group: 'group', activity: 0 });
            addLink(node_id, `group:${g.id}`, 'member', 1);
          }
          // Agent → sessions (recent 10)
          const sessions = db.prepare('SELECT id, status, started_at FROM agent_sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 10').all(entityId);
          for (const s of sessions) {
            addNode(`session:${s.id}`, { name: s.id.slice(0,8), group: 'session', status: s.status, activity: 0 });
            addLink(node_id, `session:${s.id}`, 'chat', 1);
          }
          // Agent → schedules
          const schedules = db.prepare('SELECT id, name, enabled FROM schedules WHERE agent_id = ?').all(entityId);
          for (const s of schedules) {
            addNode(`schedule:${s.id}`, { name: s.name, group: 'schedule', status: s.enabled ? 'active' : 'idle', activity: 0 });
            addLink(node_id, `schedule:${s.id}`, 'schedule', 1);
          }
        }
      } catch {}
      break;
    }

    case 'skill': {
      // Expand skill → tools, executions, dependencies
      try {
        const tools = db.prepare('SELECT id, name, endpoint FROM tools WHERE skill_id = ?').all(entityId);
        for (const t of tools) {
          addNode(`tool:${t.id}`, { name: t.name, group: 'tool', endpoint: t.endpoint, activity: 0 });
          addLink(node_id, `tool:${t.id}`, 'provides', 1);
        }
        // Recent executions
        const execs = db.prepare('SELECT id, status, created_at FROM skill_executions WHERE skill_id = ? ORDER BY created_at DESC LIMIT 10').all(entityId);
        for (const e of execs) {
          addNode(`exec:${e.id}`, { name: e.id.slice(0,8), group: 'session', status: e.status, activity: 0 });
          addLink(node_id, `exec:${e.id}`, 'task', 1);
        }
      } catch {}
      break;
    }

    case 'task': {
      // Expand task → dependencies, assigned agent, sessions
      try {
        const deps = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?').all(entityId);
        for (const d of deps) {
          const depTask = db.prepare('SELECT id, name FROM tasks WHERE id = ?').get(d.depends_on_task_id);
          if (depTask) {
            addNode(`task:${depTask.id}`, { name: depTask.name || depTask.id.slice(0,8), group: 'task', activity: 0 });
            addLink(`task:${depTask.id}`, node_id, 'depends', 1);
          }
        }
        const sessions = db.prepare('SELECT id, status FROM agent_sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 10').all(entityId);
        for (const s of sessions) {
          addNode(`session:${s.id}`, { name: s.id.slice(0,8), group: 'session', status: s.status, activity: 0 });
          addLink(node_id, `session:${s.id}`, 'chat', 1);
        }
      } catch {}
      break;
    }

    case 'provider': {
      // Expand provider → models
      try {
        const models = db.prepare('SELECT id, model_id, display_name, context_window, is_default FROM llm_models WHERE provider_id = ?').all(entityId);
        for (const m of models) {
          addNode(`model:${m.id}`, { name: (m.display_name || m.model_id).split('/').pop(), group: 'model', context: m.context_window, isDefault: m.is_default, activity: 0 });
          addLink(node_id, `model:${m.id}`, 'hosts', 1);
        }
      } catch {}
      break;
    }

    case 'group': {
      // Expand group → members (agents)
      try {
        const members = db.prepare('SELECT a.id, a.name, a.status FROM agents a JOIN agent_group_members m ON a.id = m.agent_id WHERE m.group_id = ?').all(entityId);
        for (const a of members) {
          let act = 0;
          try { act = db.prepare('SELECT COUNT(*) as c FROM agent_sessions WHERE agent_id = ?').get(a.id).c; } catch {}
          addNode(`agent:${a.id}`, { name: a.name, group: 'agent', status: a.status, activity: act });
          addLink(node_id, `agent:${a.id}`, 'member', Math.max(1, act));
        }
      } catch {}
      break;
    }

    case 'comms': {
      // Expand comms channel → recent messages, trigger agent
      try {
        const msgs = db.prepare('SELECT id, direction, platform, content FROM comms_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 10').all(entityId);
        for (const m of msgs) {
          addNode(`msg:${m.id}`, { name: m.content?.slice(0, 20) || m.id.slice(0,8), group: 'message', status: m.direction, activity: 0 });
          addLink(node_id, `msg:${m.id}`, 'chat', 1);
        }
      } catch {}
      break;
    }

    default:
      // For prefixes we don't handle, return empty
      break;
  }

  res.json({ nodes, links, parentId: node_id });
});

  return router;
}
