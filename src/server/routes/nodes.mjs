/**
 * Cardinal Frame — Nodes API
 *
 * Exposes the node registry's state over HTTP so the dashboard
 * can surface which nodes are online, their capabilities, and
 * liveness status.
 *
 * Dependencies: ctx.nodeRegistry, ctx.authMiddleware, ctx.optionalAuth,
 *               ctx.requireRole, ctx.apiLimiter, ctx.audit, ctx.broadcast
 */

import express from 'express';

export default function nodesRoutes(ctx) {
  const { nodeRegistry, authMiddleware, optionalAuth, requireRole, apiLimiter, audit, broadcast, logger } = ctx;
  const router = express.Router();

  // GET /api/nodes/stats — summary counts (before /:id to avoid shadowing)
  router.get('/nodes/stats', optionalAuth, (_req, res) => {
    if (!nodeRegistry) {
      return res.status(503).json({ error: 'Node registry not initialized' });
    }
    const nodes = nodeRegistry.getAllNodes();
    res.json({
      total: nodes.length,
      online: nodes.filter(n => n.status === 'online').length,
      offline: nodes.filter(n => n.status === 'offline').length,
      unknown: nodes.filter(n => n.status === 'unknown').length,
    });
  });

  // GET /api/nodes — list all registered nodes with status
  router.get('/nodes', optionalAuth, (_req, res) => {
    if (!nodeRegistry) {
      return res.status(503).json({ error: 'Node registry not initialized' });
    }
    const nodes = nodeRegistry.getAllNodes();
    res.json(nodes);
  });

  // GET /api/nodes/:id — get a single node by its cryptographic ID
  router.get('/nodes/:id', optionalAuth, (req, res) => {
    if (!nodeRegistry) {
      return res.status(503).json({ error: 'Node registry not initialized' });
    }
    const node = nodeRegistry.getNodeByName(req.params.id) || nodeRegistry.getNode(req.params.id);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    const caps = typeof node.capabilities === 'string' ? JSON.parse(node.capabilities || '[]') : node.capabilities;
    res.json({ ...node, capabilities: caps });
  });

  // POST /api/nodes — register a new node (admin only)
  router.post('/nodes', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    if (!nodeRegistry) {
      return res.status(503).json({ error: 'Node registry not initialized' });
    }
    const { id, name, base_url, public_key_pem, capabilities } = req.body;
    if (!id || !name || !base_url || !public_key_pem) {
      return res.status(400).json({ error: 'id, name, base_url, and public_key_pem are required' });
    }
    try {
      const node = nodeRegistry.registerNode({
        id, name, base_url, public_key_pem,
        capabilities: capabilities || [],
      });
      audit('node_registered', 'node', id, req.user?.id, { name, base_url });
      broadcast('node:registered', { id, name });
      logger.info(`Node registered: ${name} (${id.slice(0, 12)}...)`);
      res.status(201).json(node);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}
