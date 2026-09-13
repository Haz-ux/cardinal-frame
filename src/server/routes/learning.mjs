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
import { randomUUID } from 'crypto';
import { runReviewJob } from '../learning/reviewer.mjs';
import {
  getCandidate,
  listCandidates,
  approveCandidate,
  rejectCandidate,
  updateCandidateFields,
  getCandidateEvidence,
} from '../learning/candidates.mjs';
import {
  runClustering,
  backfillLegacyClusters,
  MERGEABLE_STATES,
} from '../learning/cluster.mjs';

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

  // Edit: update title/draft/eligibility_note while the candidate is still
  // in review. Persisted server-side; audit-logged like approve/reject.
  router.patch('/learning/candidates/:id', authMiddleware, apiLimiter, (req, res) => {
    const existing = getCandidate(db, req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    if (existing.state !== 'candidate') {
      return res.status(400).json({ error: 'only candidates in review can be edited' });
    }
    const fields = {};
    if (typeof req.body?.title === 'string' && req.body.title.trim()) {
      fields.title = req.body.title.trim().slice(0, 200);
    }
    if (Array.isArray(req.body?.draft)) {
      fields.draft = req.body.draft
        .filter(s => typeof s === 'string')
        .map(s => s.trim().slice(0, 500))
        .filter(Boolean)
        .slice(0, 50);
    }
    if (typeof req.body?.eligibility_note === 'string') {
      fields.eligibilityNote = req.body.eligibility_note.slice(0, 2000);
    }
    const c = updateCandidateFields(db, req.params.id, req.user.id, fields);
    if (!c) return res.status(404).json({ error: 'not found' });
    audit('learning.candidate.edit', 'learning_candidate', c.id, req.user.id, {
      fields: Object.keys(fields),
    });
    logger.info(`Learning candidate edited: ${c.id} (${Object.keys(fields).join(',') || 'no-op'})`);
    res.json({ candidate: toDetail(c) });
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

  // ─── Clusters (Phase 3, shadow mode) ──────────────────────────────

  function clusterMemberRows(db, clusterId, userId) {
    return db.prepare(`SELECT m.candidate_id, m.similarity, m.is_centroid,
        lc.title, lc.kind, lc.state
      FROM candidate_cluster_members m
      JOIN learning_candidates lc ON lc.id = m.candidate_id
      WHERE m.cluster_id = ? AND lc.user_id = ?
      ORDER BY m.is_centroid DESC, m.similarity DESC`)
      .all(clusterId, userId);
  }

  // List clusters with members, biggest first. avg_similarity is the mean
  // similarity of non-centroid members (the centroid stores 1.0).
  router.get('/learning/clusters', authMiddleware, (req, res) => {
    const clusters = db.prepare(`SELECT * FROM learning_clusters
      WHERE user_id = ? ORDER BY member_count DESC, created_at DESC`)
      .all(req.user.id);
    res.json({
      clusters: clusters.map(c => {
        const members = clusterMemberRows(db, c.id, req.user.id);
        const nonCentroid = members.filter(m => !m.is_centroid);
        const avg = nonCentroid.length
          ? nonCentroid.reduce((a, m) => a + m.similarity, 0) / nonCentroid.length
          : 0;
        return {
          id: c.id,
          label: c.label,
          member_count: c.member_count,
          avg_similarity: avg,
          is_legacy_readonly: c.is_legacy_readonly === 1,
          state: c.state,
          created_at: c.created_at,
          members: members.map(m => ({
            candidate_id: m.candidate_id,
            title: m.title,
            kind: m.kind,
            state: m.state,
            similarity: m.similarity,
            is_centroid: m.is_centroid === 1,
          })),
        };
      }),
    });
  });

  // List merge proposals, defaulting to the open ('proposed') queue.
  router.get('/learning/merge-proposals', authMiddleware, (req, res) => {
    const valid = ['proposed', 'approved', 'dismissed'];
    const state = req.query.state || 'proposed';
    if (!valid.includes(state)) {
      return res.status(400).json({ error: 'state must be one of proposed|approved|dismissed' });
    }
    const rows = db.prepare(`SELECT p.*, c.label AS cluster_label
      FROM learning_merge_proposals p
      JOIN learning_clusters c ON c.id = p.cluster_id
      WHERE p.user_id = ? AND p.state = ?
      ORDER BY p.created_at DESC`)
      .all(req.user.id, state);
    res.json({
      proposals: rows.map(p => {
        let fromIds = [];
        try { fromIds = JSON.parse(p.from_candidate_ids); } catch { fromIds = []; }
        const memberTitles = fromIds.map(id => {
          const c = getCandidate(db, id, req.user.id);
          return c ? { id: c.id, title: c.title } : { id, title: '(deleted)' };
        });
        let combined = {};
        try { combined = JSON.parse(p.combined_support); } catch { combined = {}; }
        return {
          id: p.id,
          cluster_id: p.cluster_id,
          cluster_label: p.cluster_label,
          from_candidate_ids: fromIds,
          member_titles: memberTitles,
          combined_support: combined,
          state: p.state,
          created_at: p.created_at,
          decided_at: p.decided_at,
        };
      }),
    });
  });

  // Dismiss a merge proposal — nothing changes but the proposal state.
  router.post('/learning/merge-proposals/:id/dismiss', authMiddleware, apiLimiter, (req, res) => {
    const p = db.prepare('SELECT * FROM learning_merge_proposals WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.state !== 'proposed') {
      return res.status(400).json({ error: 'only proposed merges can be dismissed' });
    }
    const decidedAt = new Date().toISOString();
    db.prepare(`UPDATE learning_merge_proposals SET state = 'dismissed', decided_at = ?
      WHERE id = ? AND user_id = ?`).run(decidedAt, p.id, req.user.id);
    audit('learning.merge.dismiss', 'learning_merge_proposal', p.id, req.user.id, {
      cluster_id: p.cluster_id,
    });
    logger.info(`Learning merge proposal dismissed: ${p.id} (cluster ${p.cluster_id})`);
    const updated = db.prepare('SELECT * FROM learning_merge_proposals WHERE id = ?').get(p.id);
    res.json({ proposal: { ...updated, from_candidate_ids: JSON.parse(updated.from_candidate_ids || '[]') } });
  });

  // Approve a merge proposal. Survivor = the mergeable member with the
  // highest promotion_score (re-fetched at approve time). Losers are
  // ARCHIVED (rows stay, state='archived'); their evidence rows are
  // re-pointed at the survivor. One transaction — all or nothing.
  router.post('/learning/merge-proposals/:id/approve', authMiddleware, apiLimiter, (req, res) => {
    const p = db.prepare('SELECT * FROM learning_merge_proposals WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.state !== 'proposed') {
      return res.status(400).json({ error: 'only proposed merges can be approved' });
    }
    let fromIds = [];
    try { fromIds = JSON.parse(p.from_candidate_ids); } catch { fromIds = []; }
    if (fromIds.length < 2) {
      return res.status(400).json({ error: 'proposal has fewer than two members' });
    }

    const now = new Date().toISOString();
    const mergeableMembers = [];
    for (const id of fromIds) {
      const c = getCandidate(db, id, req.user.id);
      if (!c) {
        return res.status(400).json({ error: `member candidate ${id} no longer exists` });
      }
      if (!MERGEABLE_STATES.has(c.state)) {
        return res.status(400).json({ error: `member candidate ${id} is no longer mergeable (state=${c.state})` });
      }
      if (c.cooldown_until && c.cooldown_until > now) {
        return res.status(400).json({ error: `member candidate ${id} is in cooldown` });
      }
      mergeableMembers.push(c);
    }
    mergeableMembers.sort((a, b) => (b.promotion_score ?? 0) - (a.promotion_score ?? 0));
    const survivor = mergeableMembers[0];
    const losers = mergeableMembers.slice(1);

    const addVerified = losers.reduce((a, c) => a + (c.support_verified ?? 0), 0);
    const addRecovered = losers.reduce((a, c) => a + (c.support_recovered ?? 0), 0);
    const addCorrections = losers.reduce((a, c) => a + (c.support_corrections ?? 0), 0);

    const tx = db.transaction(() => {
      const insEvidence = db.prepare(`INSERT OR IGNORE INTO candidate_evidence
        (id, candidate_id, event_id, role, weight, excerpt_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const loser of losers) {
        const rows = db.prepare(`SELECT event_id, role, weight, excerpt_hash
          FROM candidate_evidence WHERE candidate_id = ?`).all(loser.id);
        for (const r of rows) {
          // INSERT OR IGNORE: skip events the survivor already links —
          // UNIQUE(candidate_id, event_id) stays intact.
          insEvidence.run(randomUUID(), survivor.id, r.event_id, r.role, r.weight, r.excerpt_hash, now);
        }
        db.prepare('DELETE FROM candidate_evidence WHERE candidate_id = ?').run(loser.id);
        db.prepare(`UPDATE learning_candidates SET state = 'archived', updated_at = ?
          WHERE id = ? AND user_id = ?`).run(now, loser.id, req.user.id);
      }
      db.prepare(`UPDATE learning_candidates
        SET support_verified = support_verified + ?, support_recovered = support_recovered + ?,
            support_corrections = support_corrections + ?, updated_at = ?
        WHERE id = ? AND user_id = ?`)
        .run(addVerified, addRecovered, addCorrections, now, survivor.id, req.user.id);
      db.prepare(`UPDATE learning_merge_proposals
        SET state = 'approved', into_candidate_id = ?, decided_at = ?
        WHERE id = ? AND user_id = ?`).run(survivor.id, now, p.id, req.user.id);
    });
    tx();

    audit('learning.merge.approve', 'learning_merge_proposal', p.id, req.user.id, {
      cluster_id: p.cluster_id, into_candidate_id: survivor.id,
      merged_count: losers.length, members: mergeableMembers.length,
    });
    logger.info(`Learning merge approved: ${p.id} — ${losers.length} archived into ${survivor.id}`);

    const survivorRow = getCandidate(db, survivor.id, req.user.id);
    res.json({ proposal: { ...p, state: 'approved', into_candidate_id: survivor.id, decided_at: now }, survivor: toListItem(survivorRow) });
  });

  // Run the clustering pipeline for the user (admin: ?user_id=).
  router.post('/learning/cluster/run', authMiddleware, apiLimiter, async (req, res) => {
    const targetUser = resolveTargetUser(req);
    let threshold;
    const raw = req.body?.threshold;
    if (raw !== undefined && raw !== null) {
      const f = parseFloat(raw);
      if (Number.isFinite(f) && f > 0 && f < 1) threshold = f;
    }
    try {
      const result = await runClustering({ db, userId: targetUser, logger, threshold });
      audit('learning.cluster.run', 'learning_cluster', targetUser, req.user.id, {
        target_user: targetUser, ok: result.ok, stats: result.ok ? result.stats : undefined,
        error: result.ok ? undefined : result.error,
      });
      if (!result.ok) {
        logger.error(`Learning cluster run failed for ${targetUser}: ${result.error}`);
        return res.status(500).json({ error: 'Cluster run failed', detail: result.error });
      }
      res.json({ stats: result.stats });
    } catch (err) {
      // runClustering never throws by contract; belt and suspenders.
      logger.error(`Learning cluster run threw: ${err.message}`);
      res.status(500).json({ error: 'Cluster run failed' });
    }
  });

  // Backfill read-only legacy clusters from the old learn_patterns table.
  router.post('/learning/cluster/backfill-legacy', authMiddleware, apiLimiter, async (req, res) => {
    const targetUser = resolveTargetUser(req);
    try {
      const result = backfillLegacyClusters({ db, userId: targetUser, logger });
      audit('learning.cluster.backfill-legacy', 'learning_cluster', targetUser, req.user.id, {
        target_user: targetUser, imported: result.imported, skipped: result.skipped,
      });
      logger.info(`Learning legacy backfill for ${targetUser}: imported=${result.imported}, skipped=${result.skipped}`);
      res.json({ result });
    } catch (err) {
      logger.error(`Learning legacy backfill threw: ${err.message}`);
      res.status(500).json({ error: 'Backfill failed' });
    }
  });

  return router;
}
