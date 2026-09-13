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
import {
  compile as compileVersion,
  runTests,
  scanArtifact,
  recordVersionEvent,
  VERSION_STATES,
} from '../learning/compiler.mjs';
import {
  getRetrievalFlags,
  recordFeedback,
} from '../learning/retrieval.mjs';
import {
  runCurator,
  approveRecommendation,
  dismissRecommendation,
  restoreVersion,
  setPinned,
  markRunReviewed,
  reviewedDryRunCount,
  pruneEligible,
  curatorConfig,
  getRecommendation,
  CURATOR_REC_STATES,
} from '../learning/curator.mjs';

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
  const { db, stmts, logger, audit, auditLog, authMiddleware, requireRole, apiLimiter, executeSkill } = ctx;
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

  // ─── Skill versions (Phase 4 compiler, shadow mode) ──────────────
  // Versions are IMMUTABLE: compile creates version_number+1; there is no
  // edit endpoint. Even an 'active' version is DISABLED — nothing executes.

  function parseVersionJson(value, fallback = null) {
    try {
      const v = JSON.parse(value);
      return v === undefined ? fallback : v;
    } catch { return fallback; }
  }

  // List/detail projection for skill versions (frozen API contract).
  function toVersionListItem(row, candidateTitle) {
    const testReport = parseVersionJson(row.test_report);
    const scanner = parseVersionJson(row.scanner_verdict);
    return {
      id: row.id,
      candidate_id: row.candidate_id,
      candidate_title: candidateTitle ?? null,
      version_number: row.version_number,
      kind: row.kind,
      state: row.state,
      content_hash: row.content_hash ? String(row.content_hash).slice(0, 12) : null,
      rationale: row.rationale,
      requires_docker: row.requires_docker === 1 || row.requires_docker === true,
      test_summary: testReport
        ? { passed: testReport.passed ?? 0, failed: testReport.failed ?? 0 }
        : null,
      scanner: scanner
        ? { verdict: scanner.verdict || null, blocked: scanner.blocked === true }
        : null,
      created_at: row.created_at,
    };
  }

  function toVersionDetail(row, candidateTitle) {
    const history = db.prepare(`SELECT action, actor, created_at
      FROM learning_version_events WHERE version_id = ?
      ORDER BY created_at ASC, rowid ASC`).all(row.id);
    return {
      ...toVersionListItem(row, candidateTitle),
      spec: parseVersionJson(row.spec, {}),
      artifact: row.artifact,
      test_report: parseVersionJson(row.test_report),
      scanner_verdict: parseVersionJson(row.scanner_verdict),
      history: history.map(h => ({ action: h.action, actor: h.actor, created_at: h.created_at })),
    };
  }

  function getOwnedVersion(id, userId) {
    return db.prepare(`SELECT v.*, c.title AS candidate_title
      FROM learning_skill_versions v
      JOIN learning_candidates c ON c.id = v.candidate_id
      WHERE v.id = ? AND v.user_id = ?`).get(id, userId);
  }

  // Compile a promoted candidate: compile -> generateTests -> runTests ->
  // scanArtifact (skipped when tests fail; failed versions never scan).
  router.post('/learning/candidates/:id/compile', authMiddleware, apiLimiter, async (req, res) => {
    const c = getCandidate(db, req.params.id, req.user.id);
    if (!c) return res.status(404).json({ error: 'not found' });

    let compiled;
    try {
      compiled = compileVersion(db, c.id, req.user.id);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!compiled.ok) {
      // Invalid spec: quarantined — nothing was written.
      return res.status(400).json({ error: 'spec invalid — quarantined, nothing written', errors: compiled.errors });
    }

    let version = compiled.version;
    // Tests are generated from the stored spec inside runTests; the row is
    // re-read after each stage so the projection reflects fresh state.
    const testRes = await runTests(version);
    version = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(version.id);

    if (testRes.ok && testRes.report.failed === 0) {
      await scanArtifact(version, { db, stmts, executeSkill, logger, auditLog });
      version = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(version.id);
    }

    audit('learning.version.compile', 'learning_skill_version', version.id, req.user.id, {
      candidate_id: c.id,
      version_number: version.version_number,
      kind: version.kind,
      state: version.state,
      tests_failed: testRes.ok ? testRes.report.failed > 0 : true,
    });
    logger.info(`Learning skill version compiled: ${version.id} (v${version.version_number}, ${version.kind}) -> ${version.state}`);
    res.json({ version: toVersionListItem(version, c.title) });
  });

  // List versions, optionally filtered by state. Owner-scoped.
  router.get('/learning/skill-versions', authMiddleware, (req, res) => {
    const { state } = req.query;
    if (state && !VERSION_STATES.includes(state)) {
      return res.status(400).json({ error: `state must be one of ${VERSION_STATES.join('|')}` });
    }
    const rows = state
      ? db.prepare(`SELECT v.*, c.title AS candidate_title
          FROM learning_skill_versions v
          JOIN learning_candidates c ON c.id = v.candidate_id
          WHERE v.user_id = ? AND v.state = ?
          ORDER BY v.created_at DESC, v.rowid DESC`).all(req.user.id, state)
      : db.prepare(`SELECT v.*, c.title AS candidate_title
          FROM learning_skill_versions v
          JOIN learning_candidates c ON c.id = v.candidate_id
          WHERE v.user_id = ?
          ORDER BY v.created_at DESC, v.rowid DESC`).all(req.user.id);
    res.json({ versions: rows.map(r => toVersionListItem(r, r.candidate_title)) });
  });

  // Version detail with spec, artifact, test report, scanner verdict, history.
  router.get('/learning/skill-versions/:id', authMiddleware, (req, res) => {
    const row = getOwnedVersion(req.params.id, req.user.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ version: toVersionDetail(row, row.candidate_title) });
  });

  // Approve: scanned -> approved. Still DISABLED — nothing executes.
  router.post('/learning/skill-versions/:id/approve', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const row = getOwnedVersion(req.params.id, targetUser);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.state !== 'scanned') {
      return res.status(400).json({ error: 'only scanned versions can be approved' });
    }
    const report = parseVersionJson(row.test_report);
    if (!report || report.failed > 0) {
      return res.status(400).json({ error: 'version has a failing or missing test report' });
    }
    const scanner = parseVersionJson(row.scanner_verdict);
    if (!scanner || scanner.blocked === true) {
      return res.status(400).json({ error: 'version is blocked by the scanner gate' });
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE learning_skill_versions SET state = 'approved', updated_at = ?
      WHERE id = ? AND user_id = ?`).run(now, row.id, targetUser);
    recordVersionEvent(db, row.id, 'approved', req.user.id, {
      disabled: true,
      note: 'approved but DISABLED — shadow mode, nothing executes',
    });
    audit('learning.version.approve', 'learning_skill_version', row.id, req.user.id, {
      target_user: targetUser, version_number: row.version_number, kind: row.kind,
    });
    logger.info(`Learning skill version approved (still disabled): ${row.id}`);
    const updated = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(row.id);
    res.json({ version: toVersionListItem(updated, row.candidate_title) });
  });

  // Activate: approved -> active. Atomic: any currently active version for
  // the same candidate is rolled back first (exactly one active enforced).
  router.post('/learning/skill-versions/:id/activate', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const row = getOwnedVersion(req.params.id, targetUser);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.state !== 'approved') {
      return res.status(400).json({ error: 'only approved versions can be activated' });
    }
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      const actives = db.prepare(`SELECT id, version_number FROM learning_skill_versions
        WHERE candidate_id = ? AND state = 'active' AND id != ?`).all(row.candidate_id, row.id);
      for (const a of actives) {
        db.prepare(`UPDATE learning_skill_versions SET state = 'rolled_back', updated_at = ?
          WHERE id = ?`).run(now, a.id);
        recordVersionEvent(db, a.id, 'rolled_back', req.user.id, {
          reason: `superseded by activation of version ${row.version_number}`,
        });
      }
      db.prepare(`UPDATE learning_skill_versions SET state = 'active', updated_at = ?
        WHERE id = ? AND user_id = ?`).run(now, row.id, targetUser);
      recordVersionEvent(db, row.id, 'activated', req.user.id, {
        disabled: true,
        note: 'active but DISABLED — shadow mode, nothing executes',
      });
      return actives.map(a => a.id);
    });
    const rolledBack = tx();
    audit('learning.version.activate', 'learning_skill_version', row.id, req.user.id, {
      target_user: targetUser, version_number: row.version_number, rolled_back: rolledBack,
    });
    logger.info(`Learning skill version activated (still disabled): ${row.id}; rolled back ${rolledBack.length}`);
    const updated = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(row.id);
    res.json({ version: toVersionListItem(updated, row.candidate_title), rolled_back: rolledBack });
  });

  // Rollback: active|approved -> rolled_back.
  router.post('/learning/skill-versions/:id/rollback', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const row = getOwnedVersion(req.params.id, targetUser);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!['active', 'approved'].includes(row.state)) {
      return res.status(400).json({ error: 'only active or approved versions can be rolled back' });
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE learning_skill_versions SET state = 'rolled_back', updated_at = ?
      WHERE id = ? AND user_id = ?`).run(now, row.id, targetUser);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : '';
    recordVersionEvent(db, row.id, 'rolled_back', req.user.id, { from_state: row.state, reason });
    audit('learning.version.rollback', 'learning_skill_version', row.id, req.user.id, {
      target_user: targetUser, version_number: row.version_number, from_state: row.state, reason,
    });
    logger.info(`Learning skill version rolled back: ${row.id} (was ${row.state})`);
    const updated = db.prepare('SELECT * FROM learning_skill_versions WHERE id = ?').get(row.id);
    res.json({ version: toVersionListItem(updated, row.candidate_title) });
  });

  // ─── Routing decisions + stats (Phase 5, shadow mode) ───────────────
  // Read-only views of what WOULD have been routed. The decision rows are
  // written by the fire-and-forget hook in runAgentLoop; nothing here
  // affects live agent behavior.

  // Recent routing decisions, newest first, with winner title/kind.
  router.get('/learning/routing/decisions', authMiddleware, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
    const rows = db.prepare(`SELECT d.*,
        v.kind AS winner_kind,
        c.title AS winner_title
      FROM learning_routing_decisions d
      LEFT JOIN learning_skill_versions v ON v.id = d.winner_version_id
      LEFT JOIN learning_candidates c ON c.id = v.candidate_id
      WHERE d.user_id = ?
      ORDER BY d.created_at DESC
      LIMIT ?`).all(targetUser, limit);
    res.json({
      decisions: rows.map(d => ({
        id: d.id,
        request_excerpt: d.request_excerpt,
        winner_version_id: d.winner_version_id,
        winner_title: d.winner_title ?? null,
        winner_kind: d.winner_kind ?? null,
        winner_score: d.winner_score,
        runner_up_score: d.runner_up_score,
        margin: d.margin,
        // Per-component ranking breakdown for the top-ranked version
        // (null for rows written before this field existed).
        score_components: (() => {
          if (!d.score_components) return null;
          try {
            const p = JSON.parse(d.score_components);
            return (p && typeof p === 'object') ? p : null;
          } catch { return null; }
        })(),
        decision: d.decision,
        fallback_reason: d.fallback_reason,
        mode: d.mode,
        created_at: d.created_at,
      })),
    });
  });

  // Per-version route counters + aggregate routing stats.
  router.get('/learning/routing/stats', authMiddleware, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const versions = db.prepare(`SELECT s.*,
        v.version_number, v.kind, c.title AS title
      FROM learning_skill_stats s
      JOIN learning_skill_versions v ON v.id = s.version_id
      JOIN learning_candidates c ON c.id = v.candidate_id
      WHERE v.user_id = ?
      ORDER BY s.routed_count DESC`).all(targetUser);
    const totalDecisions = db.prepare(
      'SELECT COUNT(*) AS n FROM learning_routing_decisions WHERE user_id = ?').get(targetUser).n;
    const fallbacks = db.prepare(
      "SELECT COUNT(*) AS n FROM learning_routing_decisions WHERE user_id = ? AND decision IN ('fallback_normal','filtered_all')").get(targetUser).n;
    const avgMargin = db.prepare(
      'SELECT AVG(margin) AS m FROM learning_routing_decisions WHERE user_id = ? AND decision = ? AND margin IS NOT NULL').get(targetUser, 'shadow_routed').m;
    res.json({
      versions: versions.map(v => {
        const s = v.success_count ?? 0;
        const f = v.failure_count ?? 0;
        return {
          version_id: v.version_id,
          title: v.title,
          kind: v.kind,
          version_number: v.version_number,
          routed_count: v.routed_count ?? 0,
          success_count: s,
          failure_count: f,
          success_rate: (s + 1) / (s + f + 2),
          last_routed_at: v.last_routed_at,
        };
      }),
      totals: {
        total_decisions: totalDecisions,
        fallback_rate: totalDecisions > 0 ? fallbacks / totalDecisions : 0,
        avg_margin: avgMargin ?? null,
      },
    });
  });

  // Record route/execution feedback on a decision (audit-logged).
  // Route ledger → learning_skill_stats counters; execution ledger →
  // learning_route_feedback rows only. The two ledgers never mix.
  router.post('/learning/routing/decisions/:id/feedback', authMiddleware, apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const { ledger, positive, detail } = req.body ?? {};
    if (ledger !== 'route' && ledger !== 'execution') {
      return res.status(400).json({ error: "ledger must be 'route' or 'execution'" });
    }
    if (typeof positive !== 'boolean') {
      return res.status(400).json({ error: 'positive must be a boolean' });
    }
    let result;
    try {
      result = recordFeedback({
        db,
        userId: targetUser,
        decisionId: req.params.id,
        ledger,
        positive,
        detail: typeof detail === 'string' ? detail.slice(0, 2000) : null,
      });
    } catch (err) {
      if (err?.message === 'not found') return res.status(404).json({ error: 'not found' });
      return res.status(400).json({ error: err?.message ?? 'feedback failed' });
    }
    audit('learning.routing.feedback', 'learning_routing_decision', req.params.id, req.user.id, {
      target_user: targetUser, ledger, positive,
    });
    logger.info(`Learning routing feedback: ${ledger} ${positive ? 'positive' : 'negative'} on decision ${req.params.id}`);
    res.json({ feedback: result });
  });

  // Phase kill-switches (curator is Phase 6 — flag only).
  router.get('/learning/retrieval/flags', authMiddleware, (req, res) => {
    res.json({ flags: getRetrievalFlags() });
  });

  // ─── Curator + lifecycle (Phase 6) ─────────────────────────────────
  // The curator PROPOSES, Haz disposes. dry_run proposes only; prune
  // auto-applies ONLY stale transitions, and only when prune-eligible
  // (>= 2 reviewed dry runs). Nothing is ever deleted: archive/stale/
  // quarantine are reversible flags, each with an event trail.

  function toCuratorRun(r) {
    if (!r) return null;
    return {
      id: r.id,
      mode: r.mode,
      reviewed: r.reviewed === 1 || r.reviewed === true,
      policy_snapshot: parseVersionJson(r.policy_snapshot),
      findings_count: r.findings_count ?? 0,
      applied_count: r.applied_count ?? 0,
      created_at: r.created_at,
    };
  }

  // Recommendation detail projection, with version title from the
  // candidate title (falling back to the spec's problem_signature).
  function toRecommendationProjection(r) {
    let versionTitle = r.candidate_title ?? null;
    if (!versionTitle && r.spec) {
      const p = parseVersionJson(r.spec, null);
      if (p && typeof p === 'object' && p.problem_signature) versionTitle = p.problem_signature;
    }
    return {
      id: r.id,
      run_id: r.run_id,
      version_id: r.version_id,
      version_title: versionTitle,
      version_kind: r.version_kind ?? null,
      version_state: r.version_state ?? null,
      kind: r.kind,
      reason: r.reason,
      evidence: parseVersionJson(r.evidence),
      state: r.state,
      decided_by: r.decided_by ?? null,
      decided_at: r.decided_at ?? null,
      created_at: r.created_at,
    };
  }

  function recommendationDetail(id, userId) {
    return db.prepare(`SELECT r.*, v.kind AS version_kind, v.state AS version_state,
        v.spec AS spec, c.title AS candidate_title
      FROM learning_curator_recommendations r
      JOIN learning_skill_versions v ON v.id = r.version_id
      LEFT JOIN learning_candidates c ON c.id = v.candidate_id
      WHERE r.id = ? AND r.user_id = ?`).get(id, userId);
  }

  function listRecommendationDetails(userId, state) {
    const args = state ? [userId, state] : [userId];
    return db.prepare(`SELECT r.*, v.kind AS version_kind, v.state AS version_state,
        v.spec AS spec, c.title AS candidate_title
      FROM learning_curator_recommendations r
      JOIN learning_skill_versions v ON v.id = r.version_id
      LEFT JOIN learning_candidates c ON c.id = v.candidate_id
      WHERE r.user_id = ? ${state ? 'AND r.state = ?' : ''}
      ORDER BY r.created_at DESC, r.rowid DESC
      LIMIT 100`).all(...args);
  }

  function runRecommendationDetails(runId, userId) {
    return db.prepare(`SELECT r.*, v.kind AS version_kind, v.state AS version_state,
        v.spec AS spec, c.title AS candidate_title
      FROM learning_curator_recommendations r
      JOIN learning_skill_versions v ON v.id = r.version_id
      LEFT JOIN learning_candidates c ON c.id = v.candidate_id
      WHERE r.run_id = ? AND r.user_id = ?
      ORDER BY r.created_at ASC, r.rowid ASC`).all(runId, userId);
  }

  // Recent curator runs, newest first. Owner-scoped.
  router.get('/learning/curator/runs', authMiddleware, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
    const rows = db.prepare(`SELECT * FROM learning_curator_runs
      WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(targetUser, limit);
    res.json({ runs: rows.map(toCuratorRun) });
  });

  // Run the curator. Prune mode requires >= 2 reviewed dry runs.
  router.post('/learning/curator/run', authMiddleware, requireRole('admin'), apiLimiter, async (req, res) => {
    const targetUser = resolveTargetUser(req);
    const mode = req.body?.mode === 'prune' ? 'prune' : 'dry_run';
    if (mode === 'prune' && !pruneEligible(db, targetUser)) {
      return res.status(400).json({
        error: 'prune_not_eligible',
        reviewed: reviewedDryRunCount(db, targetUser),
      });
    }
    const { run, recommendations, error } = await runCurator({ db, userId: targetUser, mode, logger });
    if (!run) {
      return res.status(500).json({ error: 'curator run failed', detail: error ?? null });
    }
    audit('learning.curator.run', 'learning_curator_run', run.id, req.user.id, {
      target_user: targetUser, mode, findings: recommendations.length,
      applied: run.applied_count, error: run.error ?? null,
    });
    logger.info(`Learning curator run (${mode}): ${recommendations.length} findings, ${run.applied_count} applied`);
    res.json({
      run: toCuratorRun(run),
      recommendations: runRecommendationDetails(run.id, targetUser).map(toRecommendationProjection),
    });
  });

  // Recommendations for the user, newest first, optional state filter.
  router.get('/learning/curator/recommendations', authMiddleware, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const { state } = req.query;
    if (state && !CURATOR_REC_STATES.includes(state)) {
      return res.status(400).json({ error: `state must be one of ${CURATOR_REC_STATES.join('|')}` });
    }
    const rows = listRecommendationDetails(targetUser, state ?? null);
    res.json({ recommendations: rows.map(toRecommendationProjection) });
  });

  // Approve a proposed recommendation: applies the lifecycle flag
  // (stale/archive/quarantine) or stages the merge path. Never deletes.
  router.post('/learning/curator/recommendations/:id/approve', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const rec = getRecommendation(db, req.params.id, targetUser);
    if (!rec) return res.status(404).json({ error: 'not found' });
    const result = approveRecommendation(db, rec.id, req.user.id);
    if (result.error) return res.status(400).json({ error: result.error });
    audit('learning.curator.recommendation.approve', 'learning_curator_recommendation', rec.id, req.user.id, {
      target_user: targetUser, kind: rec.kind, version_id: rec.version_id,
    });
    logger.info(`Learning curator recommendation approved: ${rec.id} (${rec.kind})`);
    res.json({
      recommendation: toRecommendationProjection(recommendationDetail(rec.id, targetUser)),
      applied: result.applied,
    });
  });

  // Dismiss a proposed recommendation.
  router.post('/learning/curator/recommendations/:id/dismiss', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const rec = getRecommendation(db, req.params.id, targetUser);
    if (!rec) return res.status(404).json({ error: 'not found' });
    const result = dismissRecommendation(db, rec.id, req.user.id);
    if (result.error) return res.status(400).json({ error: result.error });
    audit('learning.curator.recommendation.dismiss', 'learning_curator_recommendation', rec.id, req.user.id, {
      target_user: targetUser, kind: rec.kind, version_id: rec.version_id,
    });
    logger.info(`Learning curator recommendation dismissed: ${rec.id} (${rec.kind})`);
    res.json({ recommendation: toRecommendationProjection(recommendationDetail(rec.id, targetUser)) });
  });

  // Mark a curator run reviewed (counts toward prune eligibility).
  router.post('/learning/curator/runs/:id/review', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const run = db.prepare('SELECT * FROM learning_curator_runs WHERE id = ? AND user_id = ?')
      .get(req.params.id, targetUser);
    if (!run) return res.status(404).json({ error: 'not found' });
    const updated = markRunReviewed(db, run.id, req.user.id);
    audit('learning.curator.run.review', 'learning_curator_run', run.id, req.user.id, {
      target_user: targetUser, mode: run.mode,
    });
    res.json({ run: toCuratorRun(updated) });
  });

  // Pin (protect from curation) or unpin a version.
  router.post('/learning/skill-versions/:id/pin', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const row = getOwnedVersion(req.params.id, targetUser);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (typeof req.body?.pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }
    const updated = setPinned(db, row.id, req.body.pinned, req.user.id);
    audit('learning.version.pin', 'learning_skill_version', row.id, req.user.id, {
      target_user: targetUser, pinned: req.body.pinned,
    });
    logger.info(`Learning skill version ${req.body.pinned ? 'pinned' : 'unpinned'}: ${row.id}`);
    res.json({ id: updated.id, pinned: updated.pinned === 1 });
  });

  // Restore a version: clears stale/archived/quarantined flags.
  router.post('/learning/skill-versions/:id/restore', authMiddleware, requireRole('admin'), apiLimiter, (req, res) => {
    const targetUser = resolveTargetUser(req);
    const row = getOwnedVersion(req.params.id, targetUser);
    if (!row) return res.status(404).json({ error: 'not found' });
    const updated = restoreVersion(db, row.id, req.user.id);
    if (!updated) return res.status(404).json({ error: 'not found' });
    audit('learning.version.restore', 'learning_skill_version', row.id, req.user.id, { target_user: targetUser });
    logger.info(`Learning skill version restored: ${row.id}`);
    res.json({ id: updated.id, archived: 0, stale: 0, quarantined: 0 });
  });

  // Effective curator config + prune gating status for the user.
  router.get('/learning/curator/config', authMiddleware, (req, res) => {
    const targetUser = resolveTargetUser(req);
    res.json({
      config: {
        ...curatorConfig(),
        prune_eligible: pruneEligible(db, targetUser),
        reviewed_dry_runs: reviewedDryRunCount(db, targetUser),
      },
    });
  });

  return router;
}
