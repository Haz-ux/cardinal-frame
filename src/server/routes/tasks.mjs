import express from 'express';
import { randomUUID } from 'crypto';
import path from 'path';
import multer from 'multer';
import { unlinkSync, createReadStream, mkdirSync, existsSync } from 'fs';

/**
 * Task + DAG + File routes
 * Dependencies: db, stmts, logger, audit, authMiddleware, optionalAuth, requireRole, apiLimiter, broadcast, broadcastLog, executeTask, sanitizeCommand
 */
export default function taskRoutes(ctx) {
  const { db, stmts, logger, audit, authMiddleware, optionalAuth, requireRole, apiLimiter, broadcast, broadcastLog, executeTask, sanitizeCommand, fireHook } = ctx;
  const router = express.Router();

  // Multer config for file uploads
  const UPLOADS_DIR = path.join(path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', '..', 'data')), 'uploads');
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'));
    },
  });
  const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/agents', authMiddleware, apiLimiter, (req, res) => {
  const { name, version, capabilities } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = randomUUID();
  stmts.agents.insert.run(id, name, version || '1.0', JSON.stringify(capabilities || []), 'active');
  const agent = stmts.agents.getById.get(id);
  broadcast('agent:created', { ...agent, capabilities: JSON.parse(agent.capabilities) });
  logger.info(`Agent registered: ${name} (${id})`);
  audit('create', 'agent', id, req.user?.id, { name, version: version || '1.0' });
  res.status(201).json({ ...agent, capabilities: JSON.parse(agent.capabilities) });
});

router.get('/agents', apiLimiter, optionalAuth, (req, res) => {
 let agents = stmts.agents.getAll.all();
 const { status, search } = req.query;
 if (status) agents = agents.filter(a => a.status === status);
 if (search) {
  const q = search.toLowerCase();
  agents = agents.filter(a => (a.name || '').toLowerCase().includes(q) || (a.capabilities || '').toLowerCase().includes(q));
 }
 res.json(agents.map(a => ({ ...a, capabilities: JSON.parse(a.capabilities) })));
});

// Agent health endpoint (MUST be before /:id to avoid "health" being treated as an ID)
router.get('/agents/health', optionalAuth, (_req, res) => {
 try {
  const agents = stmts.agents.getAllWithHeartbeat.all();
  const now = Date.now();
  const health = agents.map(a => {
   const hbMs = new Date(a.last_heartbeat + 'Z').getTime();
   const secondsSinceHeartbeat = Math.floor((now - hbMs) / 1000);
   return {
    id: a.id,
    name: a.name,
    status: a.status,
    capabilities: JSON.parse(a.capabilities),
    lastHeartbeat: a.last_heartbeat,
    secondsSinceHeartbeat,
    registeredAt: a.registered_at,
   };
  });
  res.json(health);
 } catch (err) {
  res.status(500).json({ error: 'Failed to fetch agent health' });
 }
});

router.get('/agents/:id', optionalAuth, (req, res) => {
  const agent = stmts.agents.getById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ...agent, capabilities: JSON.parse(agent.capabilities) });
});

router.get('/agents/:id/heartbeat', optionalAuth, (req, res) => {
  stmts.agents.updateHeartbeat.run(req.params.id);
  const agent = stmts.agents.getById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  broadcast('agent:heartbeat', { ...agent, capabilities: JSON.parse(agent.capabilities) });
  res.json({ ...agent, capabilities: JSON.parse(agent.capabilities) });
});

// Agent claims a pending task
router.post('/agents/:id/claim', authMiddleware, apiLimiter, (req, res) => {
  const agent = stmts.agents.getById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (agent.status !== 'active') return res.status(409).json({ error: 'Agent is not active' });

  // Find next pending task whose dependencies are all completed
  const pendingTasks = stmts.tasks.getPending.all();
  let task = null;
  for (const t of pendingTasks) {
    const depIds = stmts.deps.getByTask.all(t.id).map(d => d.depends_on_task_id);
    const allDone = depIds.every(depId => {
      const depTask = stmts.tasks.getById.get(depId);
      return depTask && depTask.status === 'done';
    });
    if (allDone) { task = t; break; }
  }
  if (!task) return res.status(404).json({ error: 'No pending tasks with satisfied dependencies available' });

  stmts.tasks.assignAgent.run(req.params.id, task.id);
  executeTask(task.id, task.command);

  broadcast('task:assigned', { taskId: task.id, agentId: req.params.id });
  res.json({ taskId: task.id, name: task.name, command: task.command, message: 'Task claimed and executing' });
});

// Agent reports task result
router.post('/agents/:id/report/:taskId', authMiddleware, apiLimiter, (req, res) => {
  const { status, result, exitCode } = req.body;
  const task = stmts.tasks.getById.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.assigned_agent_id !== req.params.id) return res.status(403).json({ error: 'Task not assigned to this agent' });

  const finishedAt = new Date().toISOString();
  stmts.tasks.updateStatus.run(status || 'done', null, finishedAt, result || '', exitCode ?? 0, req.params.taskId);
  broadcast('task:status', { id: req.params.taskId, status, exitCode, result });
  res.json({ taskId: req.params.taskId, status, message: 'Result recorded' });
});

router.delete('/agents/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const info = stmts.agents.delete.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Agent not found' });
  broadcast('agent:deleted', { id: req.params.id });
  res.json({ deleted: true });
});

// Agent task history
router.get('/agents/:id/tasks', optionalAuth, (req, res) => {
  const agent = stmts.agents.getById.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const tasks = db.prepare('SELECT id, name, command, status, exit_code, created_at, started_at, finished_at FROM tasks WHERE assigned_agent_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id);
  res.json(tasks);
});

// ─── Task CRUD + Execution ─────────────────────────────────────────
router.post('/tasks', authMiddleware, apiLimiter, (req, res) => {
const { name, command, dependsOn } = req.body;
if (!name || !command) return res.status(400).json({ error: 'Name and command are required' });
const check = sanitizeCommand(command);
if (!check.safe) return res.status(400).json({ error: check.error });
const id = randomUUID();
stmts.tasks.insert.run(id, name, command, 'pending', req.user?.id || null, null);

// Insert task dependencies if provided
if (Array.isArray(dependsOn) && dependsOn.length > 0) {
const insertDep = db.transaction((deps) => {
for (const depId of deps) {
const depTask = stmts.tasks.getById.get(depId);
if (!depTask) throw new Error(`Dependency task ${depId} not found`);
stmts.deps.insert.run(id, depId);
}
});
try { insertDep(dependsOn); } catch (err) {
stmts.tasks.delete.run(id);
return res.status(400).json({ error: err.message });
}
}

const task = stmts.tasks.getById.get(id);
const deps = stmts.deps.getByTask.all(id).map(d => d.depends_on_task_id);
broadcast('task:created', { ...task, dependsOn: deps });
logger.info(`Task created: ${name} (${id})`);
audit('create', 'task', id, req.user?.id, { name, command });
res.status(201).json({ ...task, dependsOn: deps });
});

router.get('/tasks', optionalAuth, (req, res) => {
 let tasks = stmts.tasks.getAll.all();
 const { status, search } = req.query;
 if (status) tasks = tasks.filter(t => t.status === status);
 if (search) {
  const q = search.toLowerCase();
  tasks = tasks.filter(t => (t.name || '').toLowerCase().includes(q) || (t.command || '').toLowerCase().includes(q));
 }
 const tasksWithDeps = tasks.map(t => {
  const deps = stmts.deps.getByTask.all(t.id).map(d => d.depends_on_task_id);
  return { ...t, dependsOn: deps };
 });
 res.json(tasksWithDeps);
});

router.get('/tasks/:id', optionalAuth, (req, res) => {
  const task = stmts.tasks.getById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const deps = stmts.deps.getByTask.all(req.params.id).map(d => d.depends_on_task_id);
  res.json({ ...task, dependsOn: deps });
});

// Get full dependency chain for a task (recursively resolves all transitive deps)
router.get('/tasks/:id/dependencies', optionalAuth, (req, res) => {
  const task = stmts.tasks.getById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const visited = new Set();
  const chain = [];
  const queue = [req.params.id];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const depIds = stmts.deps.getByTask.all(currentId).map(d => d.depends_on_task_id);
    for (const depId of depIds) {
      const depTask = stmts.tasks.getById.get(depId);
      if (depTask) chain.push({ id: depTask.id, name: depTask.name, status: depTask.status, dependedBy: currentId });
      if (!visited.has(depId)) queue.push(depId);
    }
  }

  res.json({ taskId: req.params.id, taskName: task.name, dependencies: chain });
});

// Get task logs
router.get('/tasks/:id/logs', optionalAuth, (req, res) => {
  const task = stmts.tasks.getById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(stmts.logs.getByTask.all(req.params.id));
});

router.patch('/tasks/:id/execute', authMiddleware, apiLimiter, (req, res) => {
  const task = stmts.tasks.getById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status === 'running') return res.status(409).json({ error: 'Task already running' });

  // Check that all dependencies are completed
  const depIds = stmts.deps.getByTask.all(req.params.id).map(d => d.depends_on_task_id);
  const unmetDeps = [];
  for (const depId of depIds) {
    const depTask = stmts.tasks.getById.get(depId);
    if (!depTask || (depTask.status !== 'done')) {
      unmetDeps.push({ id: depId, name: depTask?.name || depId, status: depTask?.status || 'missing' });
    }
  }
  if (unmetDeps.length > 0) {
    return res.status(409).json({ error: 'Task has unmet dependencies', unmetDependencies: unmetDeps });
  }

  executeTask(req.params.id, task.command);
  res.json({ id: req.params.id, status: 'running', message: 'Execution started' });
});

// Cancel a running task
router.patch('/tasks/:id/cancel', authMiddleware, apiLimiter, (req, res) => {
  const task = stmts.tasks.getById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'running') return res.status(409).json({ error: 'Only running tasks can be cancelled' });
  stmts.tasks.updateStatus.run('cancelled', null, new Date().toISOString(), 'Cancelled by user', -1, req.params.id);
  broadcast('task:status', { id: req.params.id, status: 'cancelled', exitCode: -1, result: 'Cancelled by user' });
  logger.info(`Task cancelled: ${task.name} (${req.params.id})`);
  fireHook('onTaskFailed', { taskId: req.params.id, command: task.command, stderr: 'Cancelled by user', exitCode: -1 });
  res.json({ id: req.params.id, status: 'cancelled', message: 'Task cancelled' });
});

// Retry a failed/cancelled/done task — resets to pending and re-executes
router.post('/tasks/:id/retry', authMiddleware, apiLimiter, (req, res) => {
  const task = stmts.tasks.getById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status === 'running') return res.status(409).json({ error: 'Cannot retry a running task' });

  // Clear old logs
  stmts.logs.deleteByTask.run(req.params.id);
  // Reset status to pending, then execute
  stmts.tasks.updateStatus.run('pending', null, null, null, null, req.params.id);
  executeTask(req.params.id, task.command);
  broadcast('task:status', { id: req.params.id, status: 'running', message: 'Retried' });
  logger.info(`Task retried: ${task.name} (${req.params.id})`);
  res.json({ id: req.params.id, status: 'running', message: 'Task retried' });
});

// Assign task to agent
router.patch('/tasks/:id/assign', authMiddleware, apiLimiter, (req, res) => {
  const { agentId } = req.body;
  const task = stmts.tasks.getById.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (agentId) {
    const agent = stmts.agents.getById.get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
  }
  stmts.tasks.assignAgent.run(agentId || null, req.params.id);
  broadcast('task:assigned', { taskId: req.params.id, agentId });
  res.json({ id: req.params.id, assigned_agent_id: agentId });
});

router.delete('/tasks/:id', authMiddleware, requireRole('admin'), (req, res) => {
  const info = stmts.tasks.delete.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Task not found' });
  stmts.logs.deleteByTask.run(req.params.id);
  broadcast('task:deleted', { id: req.params.id });
  res.json({ deleted: true });
});

// ─── DAG CRUD ──────────────────────────────────────────────────────
router.post('/dags', authMiddleware, apiLimiter, (req, res) => {
  const { name, nodes, edges } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = randomUUID();
  stmts.dags.insert.run(id, name, JSON.stringify(nodes || []), JSON.stringify(edges || []), 'draft', req.user?.id || null);
  const dag = stmts.dags.getById.get(id);
  broadcast('dag:created', dag);
  logger.info(`DAG created: ${name} (${id})`);
  audit('create', 'dag', id, req.user?.id, { name });
  res.status(201).json(dag);
});

router.get('/dags', optionalAuth, (_req, res) => {
  const rows = stmts.dags.getAll.all();
  res.json(rows.map((d) => ({
    ...d,
    nodes: JSON.parse(d.nodes),
    edges: JSON.parse(d.edges),
  })));
});

router.get('/dags/:id', optionalAuth, (req, res) => {
  const dag = stmts.dags.getById.get(req.params.id);
  if (!dag) return res.status(404).json({ error: 'DAG not found' });
  res.json({ ...dag, nodes: JSON.parse(dag.nodes), edges: JSON.parse(dag.edges), last_run_result: dag.last_run_result ? JSON.parse(dag.last_run_result) : null });
});

router.put('/dags/:id', authMiddleware, (req, res) => {
  const existing = stmts.dags.getById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'DAG not found' });
  const { name, nodes, edges } = req.body;
  const newName = name !== undefined ? name : existing.name;
  const newNodes = nodes !== undefined ? JSON.stringify(nodes) : existing.nodes;
  const newEdges = edges !== undefined ? JSON.stringify(edges) : existing.edges;
  stmts.dags.update.run(newName, newNodes, newEdges, existing.status, existing.last_run_result, req.params.id);
  const dag = stmts.dags.getById.get(req.params.id);
  broadcast('dag:updated', { id: req.params.id });
  res.json({ ...dag, nodes: JSON.parse(dag.nodes), edges: JSON.parse(dag.edges) });
});

router.delete('/dags/:id', authMiddleware, (req, res) => {
  const info = stmts.dags.delete.run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'DAG not found' });
  broadcast('dag:deleted', { id: req.params.id });
  res.json({ deleted: true });
});

// ─── DAG Execution with Parallel Fan-Out ───────────────────────────
function topoSortLayers(nodes, edges) {
  // Returns array of layers — each layer is an array of node IDs that can run in parallel
  const inDeg = new Map();
  const adj = new Map();
  for (const n of nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    adj.get(e.source).push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
  }
  const layers = [];
  let current = [];
  for (const [id, deg] of inDeg) if (deg === 0) current.push(id);

  while (current.length) {
    layers.push([...current]);
    const next = [];
    for (const cur of current) {
      for (const nxt of adj.get(cur) || []) {
        inDeg.set(nxt, inDeg.get(nxt) - 1);
        if (inDeg.get(nxt) === 0) next.push(nxt);
      }
    }
    current = next;
  }

  const totalSorted = layers.reduce((s, l) => s + l.length, 0);
  if (totalSorted !== nodes.length) throw new Error('Cycle detected in DAG');
  return layers;
}

router.post('/dags/:id/run', authMiddleware, apiLimiter, (req, res) => {
  const dag = stmts.dags.getById.get(req.params.id);
  if (!dag) return res.status(404).json({ error: 'DAG not found' });
  if (dag.status === 'running') return res.status(409).json({ error: 'DAG already running' });

  const nodes = JSON.parse(dag.nodes);
  const edges = JSON.parse(dag.edges);

  try {
    const layers = topoSortLayers(nodes, edges);
    stmts.dags.update.run(dag.name, dag.nodes, dag.edges, 'running', dag.last_run_result, req.params.id);
    broadcast('dag:status', { id: req.params.id, status: 'running', layers: layers.length });

    const steps = [];
    let currentLayer = 0;

    const runLayer = () => {
      if (currentLayer >= layers.length) {
        const result = JSON.stringify({ steps, totalNodes: nodes.length, layers: layers.length, completedAt: new Date().toISOString() });
        stmts.dags.update.run(dag.name, dag.nodes, dag.edges, 'completed', result, req.params.id);
        broadcast('dag:status', { id: req.params.id, status: 'completed', steps });
        logger.info(`DAG completed: ${dag.name} (${dag.id})`);
        return;
      }

      const layer = layers[currentLayer];
      const layerPromises = layer.map(nodeId => new Promise((resolve) => {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node || !node.command) {
          steps.push({ nodeId, nodeName: node?.name || nodeId, status: 'skipped', durationMs: 0, timestamp: new Date().toISOString(), layer: currentLayer });
          resolve();
          return;
        }
        const check = sanitizeCommand(node.command);
        if (!check.safe) {
          steps.push({ nodeId, nodeName: node.name || nodeId, status: 'failed', error: check.error, durationMs: 0, timestamp: new Date().toISOString(), layer: currentLayer });
          resolve();
          return;
        }
        const start = Date.now();
        exec(check.command, { timeout: 30000, shell: '/bin/sh', env: { PATH: process.env.PATH }, cwd: '/tmp' }, (error, stdout, stderr) => {
          const durationMs = Date.now() - start;
          if (error) {
            steps.push({ nodeId, nodeName: node.name || nodeId, status: 'failed', exitCode: error.killed ? -1 : (error.code ?? 1), output: (stderr || error.message).slice(0, 500), durationMs, timestamp: new Date().toISOString(), layer: currentLayer });
          } else {
            steps.push({ nodeId, nodeName: node.name || nodeId, status: 'success', exitCode: 0, output: stdout.trim().slice(0, 500), durationMs, timestamp: new Date().toISOString(), layer: currentLayer });
          }
          resolve();
        });
      }));

      Promise.all(layerPromises).then(() => {
        broadcast('dag:layer', { id: req.params.id, layer: currentLayer, completed: true });
        currentLayer++;
        runLayer();
      });
    };

    runLayer();

    res.json({ dagId: dag.id, status: 'running', layers: layers.length, totalNodes: nodes.length });
  } catch (err) {
    stmts.dags.update.run(dag.name, dag.nodes, dag.edges, 'failed', JSON.stringify({ error: err.message }), req.params.id);
    broadcast('dag:status', { id: req.params.id, status: 'failed', error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// ─── File Upload/Download API ────────────────────────────────────

// POST /api/files/upload - upload a file (auth required)
router.post('/files/upload', authMiddleware, apiLimiter, upload.single('file'), (req, res) => {
 if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

 const id = path.basename(req.file.filename, path.extname(req.file.filename));
 // Use the UUID portion (without extension) as the DB id for simplicity
 // Actually use the full stored filename as the `filename` field
 const fileId = id;
 stmts.files.insert.run(fileId, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, req.user?.id || null);

 const meta = stmts.files.getById.get(fileId);
 logger.info(`File uploaded: ${req.file.originalname} (${fileId})`);
 res.status(201).json(meta);
});

// GET /api/files - list all files (optional auth)
router.get('/files', optionalAuth, (_req, res) => {
 res.json(stmts.files.getAll.all());
});

// GET /api/files/:id/download - download a file (optional auth)
router.get('/files/:id/download', optionalAuth, (req, res) => {
 const file = stmts.files.getById.get(req.params.id);
 if (!file) return res.status(404).json({ error: 'File not found' });

 const filePath = path.join(UPLOADS_DIR, file.filename);
 if (!existsSync(filePath)) return res.status(404).json({ error: 'File data missing on disk' });

 res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
 res.setHeader('Content-Disposition', `attachment; filename="${file.original_name}"`);
 createReadStream(filePath).pipe(res);
});

// DELETE /api/files/:id - delete a file (auth + admin required)
router.delete('/files/:id', authMiddleware, requireRole('admin'), (req, res) => {
 const file = stmts.files.getById.get(req.params.id);
 if (!file) return res.status(404).json({ error: 'File not found' });

 const filePath = path.join(UPLOADS_DIR, file.filename);
 if (existsSync(filePath)) {
   try { unlinkSync(filePath); } catch (e) { logger.warn(`Failed to delete file from disk: ${filePath}`, e); }
 }

 stmts.files.delete.run(req.params.id);
 broadcast('file:deleted', { id: req.params.id });
 logger.info(`File deleted: ${file.original_name} (${req.params.id})`);
 res.json({ deleted: true });
});

// Add dependencies to a task (POST endpoint — GET already defined above)
router.post('/tasks/:id/dependencies', authMiddleware, apiLimiter, (req, res) => {
 const { dependsOn } = req.body;
 if (!Array.isArray(dependsOn) || dependsOn.length === 0) {
  return res.status(400).json({ error: 'dependsOn must be a non-empty array of task IDs' });
 }
 const task = stmts.tasks.getById.get(req.params.id);
 if (!task) return res.status(404).json({ error: 'Task not found' });

 const added = [];
 const errors = [];
 for (const depId of dependsOn) {
  if (depId === req.params.id) { errors.push({ id: depId, error: 'Cannot depend on itself' }); continue; }
  const dep = stmts.tasks.getById.get(depId);
  if (!dep) { errors.push({ id: depId, error: 'Task not found' }); continue; }
  try {
   stmts.deps.insert.run(req.params.id, depId);
   added.push(depId);
  } catch (err) {
   if (err.message.includes('UNIQUE')) { errors.push({ id: depId, error: 'Dependency already exists' }); }
   else { errors.push({ id: depId, error: err.message }); }
  }
 }
 if (added.length > 0) broadcast('task:deps', { taskId: req.params.id, added });
 res.json({ added, errors });
});

// Remove a dependency
router.delete('/tasks/:id/dependencies/:depId', authMiddleware, (req, res) => {
 db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?').run(req.params.id, req.params.depId);
 broadcast('task:deps', { taskId: req.params.id, removed: req.params.depId });
 res.json({ removed: true });
});

// Execute a task chain (task + all its dependencies in topological order)
router.post('/tasks/:id/execute-chain', authMiddleware, apiLimiter, async (req, res) => {
 const rootTask = stmts.tasks.getById.get(req.params.id);
 if (!rootTask) return res.status(404).json({ error: 'Task not found' });

 // Build dependency graph from DB
 const allDeps = stmts.deps.getAll.all();
 const depMap = new Map(); // taskId -> [depTaskIds]
 for (const d of allDeps) {
  if (!depMap.has(d.task_id)) depMap.set(d.task_id, []);
  depMap.get(d.task_id).push(d.depends_on_task_id);
 }

 // Collect all tasks in the chain (BFS from root)
 const visited = new Set();
 const chain = [];
 const queue = [req.params.id];

 while (queue.length > 0) {
  const current = queue.shift();
  if (visited.has(current)) continue;
  visited.add(current);
  const t = stmts.tasks.getById.get(current);
  if (t) chain.push(t);
  const deps = depMap.get(current) || [];
  for (const depId of deps) {
   if (!visited.has(depId)) queue.push(depId);
  }
 }

 // Topological sort
 const inDeg = new Map();
 const adj = new Map();
 for (const t of chain) {
  inDeg.set(t.id, 0);
  adj.set(t.id, []);
 }
 for (const t of chain) {
  const deps = depMap.get(t.id) || [];
  for (const depId of deps) {
   if (adj.has(depId)) {
    adj.get(depId).push(t.id);
    inDeg.set(t.id, (inDeg.get(t.id) || 0) + 1);
   }
  }
 }

 const layers = [];
 let current = [];
 for (const [id, deg] of inDeg) { if (deg === 0) current.push(id); }

 while (current.length > 0) {
  layers.push([...current]);
  const next = [];
  for (const cur of current) {
   for (const nxt of adj.get(cur) || []) {
    inDeg.set(nxt, inDeg.get(nxt) - 1);
    if (inDeg.get(nxt) === 0) next.push(nxt);
   }
  }
  current = next;
 }

 // Check for cycles
 const totalSorted = layers.reduce((s, l) => s + l.length, 0);
 if (totalSorted !== chain.length) {
  return res.status(400).json({ error: 'Cycle detected in task dependency chain' });
 }

 // Execute layer by layer
 const results = [];
 for (const layer of layers) {
  const layerPromises = layer.map(taskId => new Promise((resolve) => {
   const t = stmts.tasks.getById.get(taskId);
   if (!t || t.status === 'done') {
    results.push({ taskId, status: t?.status || 'skipped', message: 'Already done or not found' });
    resolve(); return;
   }
   if (t.status === 'running') {
    results.push({ taskId, status: 'running', message: 'Already running' });
    resolve(); return;
   }
   // Check deps in this chain are done
   const deps = depMap.get(taskId) || [];
   const pendingDeps = deps.filter(d => {
    const dt = stmts.tasks.getById.get(d);
    return dt && dt.status !== 'done';
   });
   if (pendingDeps.length > 0) {
    results.push({ taskId, status: 'blocked', pendingDeps });
    resolve(); return;
   }
   executeTask(taskId, t.command);
   results.push({ taskId, status: 'started', command: t.command });
   resolve();
  }));
  await Promise.all(layerPromises);
  // Wait a moment for each layer to process
  await new Promise(r => setTimeout(r, 500));
 }

 broadcast('task:chain', { rootTaskId: req.params.id, results });
 res.json({ rootTaskId: req.params.id, layers: layers.length, tasks: chain.length, results });
});

// ─── MCP Server Management API ─────────────────────────────────────
// Register a new MCP server

  return router;
}
