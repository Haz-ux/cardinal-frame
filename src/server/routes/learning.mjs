/**
 * Learning Phase-2 routes: candidate review objects + review jobs.
 *
 * Base: /api/learning/ (mounted as app.use('/api', learningRoutes(ctx))).
 *
 * Dependencies: db, stmts, logger, audit, authMiddleware, requireRole,
 * apiLimiter, randomUUID
 *
 * stmts used (added to server.mjs):
 *   learningReviewJobs.getByUser
 *
 * SHADOW MODE: candidates are review objects, never usable skills.
 * Approve/reject only flip state flags; no promotion path executes,
 * installs, or activates anything. HIGH risk candidates can still be
 * approved by Haz's explicit tap (logged as a warning).
 *
 * Ownership: every route is owner-scoped via req.user.id; cross-user
 * access returns 404 (not 403) to avoid leaking existence. Admins may
 * pass ?user_id= on the review job endpoints to run/list for another user.
 */
import express from 'express';
import { runReviewJob } from '../learning/reviewer.mjs';
import {
  getCandidate,
  listCandidates,
  approveCandidate,
  rejectCandidate,
  getCandidateEvidence,
} from '../learning/candidates.mjs';

// API state filter → DB state. `review` is the visible untrusted queue
// (DB state 'candidate').
const STATE_MAP = {
  review: 'candidate',
  testing: 'testing',
  rejected: 'rejected',
  promoted: 'promoted',
};

// List-item projection for candidates (matches the API contract).
function toListItem(c) {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    risk_tier: c.risk_tier,
    state: c.state,
    promotion_score: c.promotion_score,
    support_verified: c.support_verified,
    support_recovered: c.support_recovered,
    support_corrections: c.support_corrections,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

// Detail projection for GET /candidates/:id (matches the API contract).
function toDetail(c) {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    draft: c.draft,
    risk_tier: c.risk_tier,
    requested_caps: c.requested_caps,
    state: c.state,
    support_verified: c.support_verified,
    support_recovered: c.support_recovered,
    support_corrections: c.support_corrections,
    quality_json: c.quality_json,
    promotion_score: c.promotion_score,
    eligibility_note: c.eligibility_note,
    reject_reason: c.reject_reason,
    cooldown_until: c.cooldown_until,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function toJob(j) {
  if (!j) return null;
  return {
    id: j.id,
    status: j.status,
    events_scanned: j.events_scanned,
    candidates_assembled: j.candidates_assembled,
    dead_lettered: j.dead_lettered,
    budget_used: j.budget_used,
    started_at: j.started_at,
    finished_at: j.finished_at,
    error: j.error,
  };
}

export default function learningRoutes(ctx) {
  const { db, stmts, logger, audit, authMiddleware, apiLimiter } = ctx;
  const router = express.Router();

  // Owner-scoped; admins may pass ?user_id= to act for another user.
  function resolveTargetUser(req) {
    if (req.query.user_id && req.user?.role === 'admin') return req.query.user_id;
    return req.user.id;
  }

  // ─── Candidates ────────────────────────────────────────────────

  // List candidates, optionally filtered by review state.
  router.get('/learning/candidates', authMiddleware, (req, res) => {
    const { state } = req.query;
    let dbState = null;
    if (state) {
      dbState = STATE_MAP[state];
      if (!dbState) {
        return res.status(400).json({ error: 'state must be one of review|testing|rejected|promoted' });
      }
    }
    const rows = listCandidates(db, req.user.id, dbState);
    res.json({ candidates: rows.map(toListItem) });
  });

  // Candidate detail with redacted evidence excerpts (never full payloads).
  router.get('/learning/candidates/:id', authMiddleware, (req, res) => {
    const c = getCandidate(db, req.params.id, req.user.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const evidence = getCandidateEvidence(db, c.id, req.user.id);
    res.json({ candidate: toDetail(c), evidence });
  });

  // Approve: state -> 'promoted'. Review object only — nothing executes.
  router.post('/learning/candidates/:id/approve', authMiddleware, apiLimiter, (req, res) => {
    const existing = getCandidate(db, req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    if (existing.risk_tier === 'high') {
      logger.warn(`learning: approving HIGH-risk candidate ${existing.id} — explicit user action, still a review object, never executed`);
    }
    const c = approveCandidate(db, req.params.id, req.user.id);
    audit('learning.candidate.approve', 'learning_candidate', c.id, req.user.id, {
      kind: c.kind, risk_tier: c.risk_tier, promotion_score: c.promotion_score,
    });
    logger.info(`Learning candidate approved: ${c.id} (${c.kind}, risk=${c.risk_tier})`);
    res.json({ candidate: toListItem(c) });
  });

  // Reject: state -> 'rejected' with reason + 30-day cooldown.
  router.post('/learning/candidates/:id/reject', authMiddleware, apiLimiter, (req, res) => {
    const existing = getCandidate(db, req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : '';
    const c = rejectCandidate(db, req.params.id, req.user.id, reason);
    audit('learning.candidate.reject', 'learning_candidate', c.id, req.user.id, {
      kind: c.kind, reason,
    });
    logger.info(`Learning candidate rejected: ${c.id} (${c.kind})`);
    res.json({ candidate: toListItem(c) });
  });

  // ─── Review jobs ───────────────────────────────────────────────

  // Run a review job synchronously for the user (admin: ?user_id=).
  router.post('/learning/review/run', authMiddleware, apiLimiter, async (req, res) => {
    const targetUser = resolveTargetUser(req);
    try {
      const job = await runReviewJob({ db, userId: targetUser, logger });
      audit('learning.review.run', 'learning_review_job', job.id, req.user.id, {
        target_user: targetUser, status: job.status,
        events_scanned: job.events_scanned, candidates_assembled: job.candidates_assembled,
        dead_lettered: job.dead_lettered,
      });
      logger.info(`Learning review run for ${targetUser} by ${req.user?.username || req.user.id}: ` +
        `${job.events_scanned} scanned, ${job.candidates_assembled} assembled, ${job.dead_lettered} dead-lettered`);
      res.json({ job: toJob(job) });
    } catch (err) {
      // runReviewJob never throws by contract; this is belt and suspenders.
      logger.error(`Learning review run failed: ${err.message}`);
      res.status(500).json({ error: 'Review run failed' });
    }
  });

  // List review jobs, most recent first, limit 20 (admin: ?user_id=).
  router.get('/learning/review/jobs', authMiddleware, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const jobs = stmts.learningReviewJobs.getByUser.all(targetUser);
    res.json({ jobs: jobs.map(toJob) });
  });

  return router;
}
