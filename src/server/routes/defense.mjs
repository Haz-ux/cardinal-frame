/**
 * Cardinal Frame — Defense API Routes
 *
 * HTTP surface for Pillar 2: provenance audit views, policy status, and
 * canary trip alerts. Read-oriented — the enforcement itself lives in the
 * turn loop (defense/ingress.mjs, defense/policy.mjs, defense/egress.mjs),
 * not behind these endpoints.
 *
 * v2 scaffold — status endpoints only, no logic yet.
 *
 * Dependencies (planned): ctx.{ db, stmts, authMiddleware, requireRole, logger, broadcast }
 */

import express from 'express';

export default function defenseRoutes(ctx) {
  const router = express.Router();

  // Scaffold status — proves the mount is live without any behavior yet.
  // TODO(v2): attach authMiddleware when real endpoints land here.
  router.get('/defense/status', (req, res) => {
    res.json({
      scaffold: true,
      module: 'defense',
      message: 'v2 scaffold — Defense API not implemented yet',
    });
  });

  return router;
}
