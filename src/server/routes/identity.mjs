/**
 * Cardinal Frame — Identity API Routes
 *
 * HTTP surface for the identity subsystem: the singleton identity record,
 * avatar candidate staging / activation / variants / archive, and voice
 * casting per persona. Activation endpoints require explicit user selection
 * — the machine never re-faces itself unprompted.
 *
 * v2 scaffold — status endpoints only, no logic yet.
 *
 * Dependencies (planned): ctx.{ db, stmts, authMiddleware, requireRole, logger, broadcast }
 */

import express from 'express';

export default function identityRoutes(ctx) {
  const router = express.Router();

  // Scaffold status — proves the mount is live without any behavior yet.
  // TODO(v2): attach authMiddleware when real endpoints land here.
  router.get('/identity/status', (req, res) => {
    res.json({
      scaffold: true,
      module: 'identity',
      message: 'v2 scaffold — Identity API not implemented yet',
    });
  });

  return router;
}
