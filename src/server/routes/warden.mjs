/**
 * Cardinal Frame — WARDEN Risk Gate Routes
 *
 * Approval queue for medium-risk actions flagged by the WARDEN scorer
 * (sandbox code execution, delegation commands). High-risk actions are
 * blocked outright by the calling routes; this module only manages the
 * approval lifecycle for actions that require a human decision.
 *
 * Dependencies: db, stmts, authMiddleware, requireRole, logger, broadcast, randomUUID
 */

import express from 'express';

export default function wardenRoutes(ctx) {
  const { stmts, authMiddleware, requireRole, logger, broadcast } = ctx;
  const router = express.Router();

  // List approvals (optionally filter by status)
  router.get('/warden/approvals', authMiddleware, requireRole('admin'), (req, res) => {
    try {
      const { status } = req.query;
      const rows = status
        ? stmts.warden.getByStatus.all(status)
        : stmts.warden.getAll.all();
      res.json(rows.map(r => ({
        ...r,
        payload: JSON.parse(r.payload || '{}'),
        warden: JSON.parse(r.warden || '{}'),
      })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Approve a pending action
  router.post('/warden/approve', authMiddleware, requireRole('admin'), (req, res) => {
    try {
      const { approval_id } = req.body;
      if (!approval_id) return res.status(400).json({ error: 'approval_id required' });

      const approval = stmts.warden.getById.get(approval_id);
      if (!approval) return res.status(404).json({ error: 'Approval not found' });
      if (approval.status !== 'pending') return res.status(409).json({ error: `Approval already ${approval.status}` });

      stmts.warden.updateStatus.run('approved', req.user.username, approval_id);
      broadcast('warden:approved', { approval_id, scope: approval.scope });
      logger.info(`WARDEN: approved ${approval.scope} action ${approval_id} by ${req.user.username}`);
      res.json({ approved: true, approval_id, scope: approval.scope });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Reject a pending action
  router.post('/warden/reject', authMiddleware, requireRole('admin'), (req, res) => {
    try {
      const { approval_id } = req.body;
      if (!approval_id) return res.status(400).json({ error: 'approval_id required' });

      const approval = stmts.warden.getById.get(approval_id);
      if (!approval) return res.status(404).json({ error: 'Approval not found' });
      if (approval.status !== 'pending') return res.status(409).json({ error: `Approval already ${approval.status}` });

      stmts.warden.updateStatus.run('rejected', req.user.username, approval_id);
      broadcast('warden:rejected', { approval_id, scope: approval.scope });
      logger.info(`WARDEN: rejected ${approval.scope} action ${approval_id} by ${req.user.username}`);
      res.json({ rejected: true, approval_id, scope: approval.scope });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}
