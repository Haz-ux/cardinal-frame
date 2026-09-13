/**
 * Cardinal Frame — Companion API Routes
 *
 * HTTP surface for Pillar 1: companion status, the turn entrypoint,
 * relationship read/write-back, presence surfacings, and crew-mode delegation.
 * The chat client and Telegram surface both talk to the same companion
 * through these routes.
 *
 * v2 scaffold — status endpoints only, no logic yet.
 *
 * Dependencies (planned): ctx.{ db, stmts, authMiddleware, requireRole, logger, broadcast }
 */

import express from 'express';

export default function companionRoutes(ctx) {
  const router = express.Router();

  // Scaffold status — proves the mount is live without any behavior yet.
  router.get('/companion/status', (req, res) => {
    res.json({
      scaffold: true,
      module: 'companion',
      message: 'v2 scaffold — Companion API not implemented yet',
    });
  });

  return router;
}
