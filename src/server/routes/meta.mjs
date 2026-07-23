import express from 'express';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

/**
 * Meta routes: MCP, Groups, Schedules, Plugins, Audit Log
 * Dependencies: db, stmts, logger, audit, authMiddleware, optionalAuth, requireRole, apiLimiter, broadcast, randomUUID
 */
export default function metaRoutes(ctx) {
  const { db, stmts, logger, audit, authMiddleware, optionalAuth, requireRole, apiLimiter, broadcast, randomUUID, mcp } = ctx;
  const router = express.Router();

// ─── MCP Server Management API ─────────────────────────────────────
// Register a new MCP server
router.post('/mcp/servers', authMiddleware, apiLimiter, async (req, res) => {
  const { name, transport, command, args, url } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!transport || !['stdio', 'http'].includes(transport)) {
    return res.status(400).json({ error: 'Transport must be "stdio" or "http"' });
  }
  if (transport === 'stdio' && !command) {
    return res.status(400).json({ error: 'Command is required for stdio transport' });
  }
  if (transport === 'http' && !url) {
    return res.status(400).json({ error: 'URL is required for http transport' });
  }

  const id = randomUUID();
  const argsJson = JSON.stringify(args || []);
  stmts.mcp.insert.run(id, name, transport, command || null, argsJson, url || null, 'disconnected');
  const server = stmts.mcp.getById.get(id);
  server.args = JSON.parse(server.args);
  logger.info(`MCP server registered: ${name} (${id}, ${transport})`);
  broadcast('mcp:registered', server);
  res.status(201).json(server);
});

// List all MCP servers
router.get('/mcp/servers', optionalAuth, (_req, res) => {
  const rows = stmts.mcp.getAll.all();
  res.json(rows.map(s => ({ ...s, args: JSON.parse(s.args), connected: mcp.isConnected(s.id) })));
});

// Delete an MCP server (admin only)
router.delete('/mcp/servers/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const server = stmts.mcp.getById.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'MCP server not found' });

  // Disconnect if connected
  mcp.disconnectServer(req.params.id);

  const info = stmts.mcp.delete.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'MCP server not found' });
  broadcast('mcp:deleted', { id: req.params.id });
  logger.info(`MCP server deleted: ${server.name} (${req.params.id})`);
  res.json({ deleted: true });
});

// Connect to an MCP server
router.post('/mcp/servers/:id/connect', authMiddleware, apiLimiter, async (req, res) => {
  const server = stmts.mcp.getById.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'MCP server not found' });
  if (mcp.isConnected(req.params.id)) return res.status(409).json({ error: 'Already connected' });

  if (server.transport !== 'stdio') {
    return res.status(400).json({ error: 'Only stdio transport is supported currently' });
  }

  try {
    const args = JSON.parse(server.args || '[]');
    const result = await mcp.connectServer(server.id, server.command, args);
    const now = new Date().toISOString();
    stmts.mcp.updateStatus.run('connected', now, now, server.id);
    broadcast('mcp:connected', { id: server.id, status: 'connected', tools: result.tools });
    logger.info(`MCP server connected: ${server.name} (${server.id}), ${result.tools?.length || 0} tools`);
    res.json({ id: server.id, status: 'connected', tools: result.tools, serverInfo: result.serverInfo });
  } catch (err) {
    stmts.mcp.updateStatus.run('disconnected', null, null, server.id);
    logger.error(`MCP connect failed: ${server.name} (${server.id}): ${err.message}`);
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Disconnect from an MCP server
router.post('/mcp/servers/:id/disconnect', authMiddleware, apiLimiter, (req, res) => {
  const server = stmts.mcp.getById.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'MCP server not found' });

  mcp.disconnectServer(req.params.id);
  stmts.mcp.updateStatus.run('disconnected', null, null, server.id);
  broadcast('mcp:disconnected', { id: server.id, status: 'disconnected' });
  res.json({ id: server.id, status: 'disconnected' });
});

// List tools from a specific MCP server
router.get('/mcp/servers/:id/tools', optionalAuth, (req, res) => {
  const server = stmts.mcp.getById.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'MCP server not found' });

  // Return cached tools if connected, otherwise empty
  const tools = mcp.getTools(req.params.id);
  res.json({ serverId: req.params.id, connected: mcp.isConnected(req.params.id), tools });
});

// Invoke a tool on an MCP server
router.post('/mcp/servers/:id/tools/:toolName/invoke', authMiddleware, apiLimiter, async (req, res) => {
  const server = stmts.mcp.getById.get(req.params.id);
  if (!server) return res.status(404).json({ error: 'MCP server not found' });
  if (!mcp.isConnected(req.params.id)) {
    return res.status(409).json({ error: 'MCP server is not connected' });
  }

  const { arguments: toolArgs } = req.body;
  try {
    const result = await mcp.invokeTool(req.params.id, req.params.toolName, toolArgs || {});
    const now = new Date().toISOString();
    stmts.mcp.updateStatus.run('connected', server.connected_at, now, server.id);
    logger.info(`MCP tool invoked: ${req.params.toolName} on ${server.name}`);
    res.json({ serverId: req.params.id, tool: req.params.toolName, result });
  } catch (err) {
    logger.error(`MCP tool invocation failed: ${req.params.toolName} on ${server.name}: ${err.message}`);
    res.status(500).json({ error: `Tool invocation failed: ${err.message}` });
  }
});


// ─── Agent Groups API ──────────────────────────────────────────────
// Create a new agent group
router.post('/groups', authMiddleware, apiLimiter, (req, res) => {
 const { name, description } = req.body;
 if (!name) return res.status(400).json({ error: 'Name is required' });
 const id = randomUUID();
 stmts.groups.insert.run(id, name, description || '', req.user?.id || null);
 const group = stmts.groups.getById.get(id);
 broadcast('group:created', group);
 logger.info(`Agent group created: ${name} (${id})`);
 res.status(201).json(group);
});

// List all groups
router.get('/groups', optionalAuth, (_req, res) => {
 const groups = stmts.groups.getAll.all();
 const enriched = groups.map(g => {
  const memberIds = stmts.groupMembers.getByGroup.all(g.id).map(m => m.agent_id);
  return { ...g, memberIds, memberCount: memberIds.length };
 });
 res.json(enriched);
});

// Get a single group with members
router.get('/groups/:id', optionalAuth, (req, res) => {
 const group = stmts.groups.getById.get(req.params.id);
 if (!group) return res.status(404).json({ error: 'Group not found' });
 const memberIds = stmts.groupMembers.getByGroup.all(req.params.id).map(m => m.agent_id);
 const members = memberIds.map(aid => {
  const agent = stmts.agents.getById.get(aid);
  return agent ? { id: agent.id, name: agent.name, status: agent.status, capabilities: JSON.parse(agent.capabilities) } : { id: aid, name: 'Unknown', status: 'deleted' };
 });
 res.json({ ...group, memberIds, members, memberCount: members.length });
});

// Delete a group
router.delete('/groups/:id', authMiddleware, requireRole('admin'), (req, res) => {
 const group = stmts.groups.getById.get(req.params.id);
 if (!group) return res.status(404).json({ error: 'Group not found' });
 stmts.groupMembers.deleteByGroup.run(req.params.id);
 stmts.groups.delete.run(req.params.id);
 broadcast('group:deleted', { id: req.params.id });
 logger.info(`Agent group deleted: ${group.name} (${req.params.id})`);
 res.json({ deleted: true });
});

// Add an agent to a group
router.post('/groups/:id/members', authMiddleware, apiLimiter, (req, res) => {
 const { agentId } = req.body;
 if (!agentId) return res.status(400).json({ error: 'agentId is required' });
 const group = stmts.groups.getById.get(req.params.id);
 if (!group) return res.status(404).json({ error: 'Group not found' });
 const agent = stmts.agents.getById.get(agentId);
 if (!agent) return res.status(404).json({ error: 'Agent not found' });
 try {
  stmts.groupMembers.add.run(req.params.id, agentId);
 } catch (err) {
  if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Agent already in group' });
  throw err;
 }
 broadcast('group:memberAdded', { groupId: req.params.id, agentId });
 logger.info(`Agent ${agent.name} added to group ${group.name}`);
 const memberIds = stmts.groupMembers.getByGroup.all(req.params.id).map(m => m.agent_id);
 res.json({ groupId: req.params.id, memberIds, memberCount: memberIds.length });
});

// Remove an agent from a group
router.delete('/groups/:id/members/:agentId', authMiddleware, (req, res) => {
 const group = stmts.groups.getById.get(req.params.id);
 if (!group) return res.status(404).json({ error: 'Group not found' });
 stmts.groupMembers.remove.run(req.params.id, req.params.agentId);
 broadcast('group:memberRemoved', { groupId: req.params.id, agentId: req.params.agentId });
 const memberIds = stmts.groupMembers.getByGroup.all(req.params.id).map(m => m.agent_id);
 res.json({ groupId: req.params.id, memberIds, memberCount: memberIds.length });
});

// Broadcast a task to all agents in a group
router.post('/groups/:id/broadcast', authMiddleware, apiLimiter, (req, res) => {
 const { name, command } = req.body;
 if (!name || !command) return res.status(400).json({ error: 'Name and command are required' });
 const check = sanitizeCommand(command);
 if (!check.safe) return res.status(400).json({ error: check.error });

 const group = stmts.groups.getById.get(req.params.id);
 if (!group) return res.status(404).json({ error: 'Group not found' });

 const memberIds = stmts.groupMembers.getByGroup.all(req.params.id).map(m => m.agent_id);
 if (memberIds.length === 0) return res.status(400).json({ error: 'Group has no members' });

 const batchId = randomUUID();
 const taskIds = [];

 const createTasks = db.transaction(() => {
  for (const agentId of memberIds) {
   const taskId = randomUUID();
   stmts.tasks.insert.run(taskId, name, command, 'pending', req.user?.id || null, agentId);
   taskIds.push(taskId);
  }
  stmts.batches.insert.run(batchId, req.params.id, JSON.stringify(taskIds), 'dispatched');
 });

 try {
  createTasks();
 } catch (err) {
  logger.error(`Broadcast failed for group ${group.name}: ${err.message}`);
  return res.status(500).json({ error: 'Broadcast failed: ' + err.message });
 }

 // Execute all tasks in parallel
 for (const taskId of taskIds) {
  executeTask(taskId, command);
 }

 broadcast('group:broadcast', { batchId, groupId: req.params.id, taskIds });
 logger.info(`Broadcast to group ${group.name}: ${taskIds.length} tasks (batch ${batchId})`);
 res.status(201).json({
  batchId,
  groupId: req.params.id,
  groupName: group.name,
  taskIds,
  taskCount: taskIds.length,
  status: 'dispatched',
 });
});

// List all batches
router.get('/batches', optionalAuth, (_req, res) => {
 const batches = stmts.batches.getAll.all();
 res.json(batches.map(b => ({ ...b, task_ids: JSON.parse(b.task_ids) })));
});

// Get batches for a group
router.get('/groups/:id/batches', optionalAuth, (req, res) => {
 const group = stmts.groups.getById.get(req.params.id);
 if (!group) return res.status(404).json({ error: 'Group not found' });
 const batches = stmts.batches.getByGroup.all(req.params.id);
 res.json(batches.map(b => ({ ...b, task_ids: JSON.parse(b.task_ids) })));
});

// Get a single batch with task statuses
router.get('/batches/:id', optionalAuth, (req, res) => {
 const batch = stmts.batches.getById.get(req.params.id);
 if (!batch) return res.status(404).json({ error: 'Batch not found' });
 const taskIds = JSON.parse(batch.task_ids);
 const tasks = taskIds.map(tid => {
  const t = stmts.tasks.getById.get(tid);
  return t ? { id: t.id, name: t.name, status: t.status, exit_code: t.exit_code, assigned_agent_id: t.assigned_agent_id } : { id: tid, status: 'deleted' };
 });
 const completedCount = tasks.filter(t => t.status === 'done').length;
 const failedCount = tasks.filter(t => t.status === 'failed').length;
 const runningCount = tasks.filter(t => t.status === 'running').length;
 const pendingCount = tasks.filter(t => t.status === 'pending').length;
 let batchStatus = batch.status;
 if (completedCount + failedCount === taskIds.length) batchStatus = 'completed';
 else if (runningCount > 0) batchStatus = 'running';
 else if (pendingCount === taskIds.length) batchStatus = 'pending';

 if (batchStatus !== batch.status) {
  stmts.batches.updateStatus.run(batchStatus, req.params.id);
 }

 res.json({ ...batch, task_ids: taskIds, tasks, stats: { completed: completedCount, failed: failedCount, running: runningCount, pending: pendingCount, total: taskIds.length }, status: batchStatus });
});

// ─── Schedules API ──────────────────────────────────────────────────
// Create a new schedule
router.post('/schedules', authMiddleware, apiLimiter, (req, res) => {
 const { name, cron_expr, command, agent_id } = req.body;
 if (!name || !cron_expr || !command) return res.status(400).json({ error: 'name, cron_expr, and command are required' });
 try {
  const interval = parseCronExpression(cron_expr);
  const nextRun = interval.next().toISOString();
  const id = randomUUID();
  stmts.schedules.insert.run(id, name, cron_expr, command, agent_id || null, 1, nextRun, req.user?.id || null);
  const schedule = stmts.schedules.getById.get(id);
  broadcast('schedule:created', schedule);
  logger.info(`Schedule created: ${name} (${id}, cron: ${cron_expr})`);
  res.status(201).json(schedule);
 } catch (err) {
  return res.status(400).json({ error: `Invalid cron expression: ${err.message}` });
 }
});

// List all schedules
router.get('/schedules', optionalAuth, (_req, res) => {
 const schedules = stmts.schedules.getAll.all();
 // Compute next_run for enabled schedules
 const enriched = schedules.map(s => {
  if (s.enabled) {
   try {
    const next = parseCronExpression(s.cron_expr).next();
    return { ...s, next_run: next.toISOString() };
   } catch { return s; }
  }
  return s;
 });
 res.json(enriched);
});

// Get single schedule
router.get('/schedules/:id', optionalAuth, (req, res) => {
 const schedule = stmts.schedules.getById.get(req.params.id);
 if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
 res.json(schedule);
});

// Enable/disable schedule
router.patch('/schedules/:id/toggle', authMiddleware, (req, res) => {
 const schedule = stmts.schedules.getById.get(req.params.id);
 if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
 const newEnabled = schedule.enabled ? 0 : 1;
 let nextRun = null;
 if (newEnabled) {
  try { nextRun = parseCronExpression(schedule.cron_expr).next().toISOString(); } catch {}
 }
 stmts.schedules.updateEnabled.run(newEnabled, req.params.id);
 if (nextRun) stmts.schedules.updateLastRun.run(schedule.last_run, req.params.id); // preserve last_run
 const updated = stmts.schedules.getById.get(req.params.id);
 broadcast('schedule:toggled', updated);
 logger.info(`Schedule ${schedule.name} ${newEnabled ? 'enabled' : 'disabled'}`);
 res.json(updated);
});

// Delete schedule
router.delete('/schedules/:id', authMiddleware, requireRole('admin'), (req, res) => {
 const schedule = stmts.schedules.getById.get(req.params.id);
 if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
 stmts.schedules.delete.run(req.params.id);
 broadcast('schedule:deleted', { id: req.params.id });
 logger.info(`Schedule deleted: ${schedule.name} (${req.params.id})`);
 res.json({ deleted: true });
});

// Cron evaluator — runs every 30s
setInterval(() => {
 try {
  const now = new Date();
  const schedules = stmts.schedules.getAll.all().filter(s => s.enabled);
  for (const s of schedules) {
   try {
    const interval = parseCronExpression(s.cron_expr);
    const next = interval.next();
    if (next <= now) {
     // Fire the scheduled task
     const taskId = randomUUID();
     stmts.tasks.insert.run(taskId, `[Sched] ${s.name}`, s.command, 'pending', s.created_by || null, s.agent_id || null);
     executeTask(taskId, s.command);
     const newNext = interval.next().toISOString();
     stmts.schedules.updateLastRun.run(newNext, s.id);
     broadcast('schedule:fired', { scheduleId: s.id, taskId, name: s.name });
     logger.info(`Schedule fired: ${s.name} → task ${taskId}`);
    }
   } catch (err) {
    logger.error(`Schedule ${s.name} cron error: ${err.message}`);
   }
  }
 } catch (err) {
  logger.error('Cron evaluator error:', err);
 }
}, 30_000);

// ─── Plugins API ────────────────────────────────────────────────────
// PluginLoader is imported from ctx — handles discovery, loading, unloading, reload, hook dispatch
const { pluginLoader } = ctx;

// Auto-discover + load plugins from plugins/ directory on startup
pluginLoader.discover();

// List plugins
router.get('/plugins', optionalAuth, (_req, res) => {
 const plugins = stmts.plugins.getAll.all();
 res.json(plugins.map(p => ({
   ...p,
   config: JSON.parse(p.config || '{}'),
   hooks: JSON.parse(p.hooks || '[]'),
   loaded: pluginLoader.loaded.has(p.id),
 })));
});

// Toggle plugin (syncs with in-memory loader)
router.patch('/plugins/:id/toggle', authMiddleware, requireRole('admin'), async (req, res) => {
 const plugin = stmts.plugins.getById.get(req.params.id);
 if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
 const newEnabled = plugin.enabled ? 0 : 1;
 stmts.plugins.updateEnabled.run(newEnabled, req.params.id);

 // Sync with in-memory loader
 if (newEnabled === 1 && !pluginLoader.loaded.has(req.params.id)) {
   // Load the plugin from disk
   await pluginLoader.loadById(req.params.id);
 } else if (newEnabled === 0 && pluginLoader.loaded.has(req.params.id)) {
   // Unload from memory
   pluginLoader.unload(req.params.id);
 }

 broadcast('plugin:toggled', { id: req.params.id, enabled: newEnabled });
 res.json({ id: req.params.id, enabled: newEnabled });
});

// Hot-reload a single plugin
router.post('/plugins/:id/reload', authMiddleware, requireRole('admin'), async (req, res) => {
 const result = await pluginLoader.reload(req.params.id);
 if (result.error) return res.status(404).json(result);
 res.json(result);
});

// Reload all plugins
router.post('/plugins/reload-all', authMiddleware, requireRole('admin'), async (_req, res) => {
 const results = await pluginLoader.reloadAll();
 res.json({ reloaded: results.length, results });
});

// Delete plugin
router.delete('/plugins/:id', authMiddleware, requireRole('admin'), (req, res) => {
 const plugin = stmts.plugins.getById.get(req.params.id);
 if (!plugin) return res.status(404).json({ error: 'Plugin not found' });
 pluginLoader.unload(req.params.id);
 stmts.plugins.delete.run(req.params.id);
 broadcast('plugin:deleted', { id: req.params.id });
 res.json({ deleted: true });
});

// Register a plugin in DB (for manual install — no download yet)
router.post('/plugins', authMiddleware, requireRole('admin'), (req, res) => {
 const { name, version, url, status, config } = req.body;
 if (!name?.trim()) return res.status(400).json({ error: 'Plugin name required' });
 const existing = db.prepare('SELECT id FROM plugins WHERE name = ?').get(name);
 if (existing) return res.status(409).json({ error: 'Plugin with this name already exists' });
 const id = randomUUID();
 const enabled = status === 'active' ? 1 : 1;
 stmts.plugins.insert.run(id, name.trim(), version || '1.0.0', url || 'manual', enabled, JSON.stringify(config || { source: url || 'local' }), '[]');
 broadcast('plugin:installed', { id, name });
 res.status(201).json({ id, name, version: version || '1.0.0', enabled: true });
});

// ─── Audit Log API ────────────────────────────────────────────────
router.get('/audit', authMiddleware, requireRole('admin'), (_req, res) => {
 const rows = stmts.audit.getAll.all();
 res.json(rows.map(r => ({ ...r, details: JSON.parse(r.details) })));
});

router.get('/audit/:resourceType/:resourceId', authMiddleware, optionalAuth, (req, res) => {
 const rows = stmts.audit.getByResource.all(req.params.resourceType, req.params.resourceId);
 res.json(rows.map(r => ({ ...r, details: JSON.parse(r.details) })));
});


  return router;
}
