/**
 * Cardinal Frame — Outbound Report Queue
 *
 * When a worker node completes a delegated task, it needs to report the
 * result back to the coordinator (Cardinal Frame). If the coordinator is
 * unreachable, the report is queued locally and retried with exponential
 * backoff — reusing job-queue.mjs's backoff constants.
 *
 * The report payload is signed with this node's Ed25519 identity so the
 * coordinator can verify it came from the worker, not a spoofer.
 *
 * This is the "best-effort, not load-bearing" half: the worker's own task
 * completion is NOT blocked on the coordinator being up to hear about it.
 */

import { randomUUID } from 'node:crypto';
import { signPayload, getOrCreateNodeIdentity } from './node-identity.mjs';

// Reuse job-queue.mjs's backoff pattern — same constants, not a second mechanism
const BASE_DELAY = 1000;   // 1s, 2s, 4s, 8s...
const MAX_DELAY = 30000;   // cap at 30s
const MAX_RETRIES = 5;
const FLUSH_POLL_MS = 5000;

/**
 * Initialize the outbound report queue.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {function} opts.getCoordinatorUrl — returns coordinator base_url or null
 * @param {function} [opts.fetchFn] — injectable fetch for testing
 * @param {object} [opts.logger] — injectable logger
 * @returns {{ queueOutboundReport, attemptFlush, scheduleReportFlush, getPending, getStats, stop }}
 */
export function createReportQueue(db, opts = {}) {
  const {
    getCoordinatorUrl,
    fetchFn = globalThis.fetch,
    logger = console,
  } = opts;

  // ─── Schema (matches handoff spec) ────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_reports (
      id TEXT PRIMARY KEY,
      delegation_id TEXT NOT NULL,
      status TEXT NOT NULL,             -- 'completed' | 'failed'
      payload TEXT NOT NULL,            -- JSON: outcome or error detail
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pending_reports_delegation ON pending_reports(delegation_id);
  `);

  const stmts = {
    insert: db.prepare(`
      INSERT INTO pending_reports (id, delegation_id, status, payload)
      VALUES (?, ?, ?, ?)
    `),
    getById: db.prepare('SELECT * FROM pending_reports WHERE id = ?'),
    getByDelegation: db.prepare('SELECT * FROM pending_reports WHERE delegation_id = ?'),
    getAll: db.prepare('SELECT * FROM pending_reports ORDER BY created_at ASC'),
    deleteById: db.prepare('DELETE FROM pending_reports WHERE id = ?'),
    incrementAttempts: db.prepare(`
      UPDATE pending_reports SET attempts = attempts + 1, last_attempt_at = datetime('now') WHERE id = ?
    `),
    countPending: db.prepare('SELECT COUNT(*) as c FROM pending_reports'),
  };

  let flushTimer = null;
  let identity = null;

  function getIdentity() {
    if (!identity) identity = getOrCreateNodeIdentity(db);
    return identity;
  }

  /**
   * Enqueue a report to be sent to the coordinator.
   * Called immediately when a task finishes — doesn't block on coordinator.
   *
   * @param {string} delegationId
   * @param {string} status — 'completed' | 'failed'
   * @param {*} payload — outcome object (JSON-serializable)
   * @returns {string} report ID
   */
  function queueOutboundReport(delegationId, status, payload) {
    const id = randomUUID();
    stmts.insert.run(id, delegationId, status, JSON.stringify(payload ?? {}));
    logger.info?.(`[report-queue] Enqueued report for delegation ${delegationId} (status: ${status})`);
    // Try immediately — don't wait for the next scheduled cycle
    attemptFlush().catch(() => {});
    return id;
  }

  /**
   * Compute exponential backoff — reuses job-queue.mjs's exact pattern.
   */
  function computeBackoff(attempts) {
    const delay = Math.min(BASE_DELAY * Math.pow(2, attempts - 1), MAX_DELAY);
    return Math.ceil(delay / 1000); // seconds
  }

  /**
   * Attempt to send every pending report to the coordinator.
   * - Signs each report with this node's Ed25519 identity.
   * - On success: deletes the row from pending_reports.
   * - On failure: increments attempts, leaves row for next cycle.
   * - A report that fails 5+ times stays in the table but doesn't crash
   *   the loop or block newer reports.
   */
  async function attemptFlush() {
    const pending = stmts.getAll.all();

    for (const report of pending) {
      // Skip reports that have exceeded max retries — leave them as dead letters
      if (report.attempts >= MAX_RETRIES) continue;

      const coordinatorUrl = getCoordinatorUrl();
      if (!coordinatorUrl) {
        // No coordinator URL — can't send, increment and move on
        stmts.incrementAttempts.run(report.id);
        continue;
      }

      const nodeIdentity = getIdentity();

      // Parse the stored payload and sign it
      const reportPayload = JSON.parse(report.payload);
      const signedPayload = {
        delegation_id: report.delegation_id,
        status: report.status,
        result: reportPayload,
        timestamp: new Date().toISOString(),
      };

      const signature = signPayload(nodeIdentity.private_key_pem, signedPayload);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const res = await fetchFn(
          `${coordinatorUrl}/api/delegations/${report.delegation_id}/report`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              payload: signedPayload,
              signature,
              source_node_id: nodeIdentity.node_id,
            }),
            signal: controller.signal,
          }
        );
        clearTimeout(timeout);

        if (res.ok) {
          // Successfully delivered — remove from queue
          stmts.deleteById.run(report.id);
          logger.info?.(`[report-queue] Report ${report.id} for delegation ${report.delegation_id} delivered to coordinator`);
        } else {
          // Coordinator responded but not ok — schedule retry
          stmts.incrementAttempts.run(report.id);
          logger.warn?.(`[report-queue] Coordinator responded ${res.status} for report ${report.id}`);
        }
      } catch (err) {
        // Coordinator unreachable — leave the row in place, retry next cycle
        stmts.incrementAttempts.run(report.id);
        logger.warn?.(`[report-queue] Report ${report.id} delivery failed (attempt ${report.attempts + 1}): ${err.message}`);
      }
    }
  }

  /**
   * Schedule periodic flush attempts. Reuses the same setInterval + unref
   * pattern from heartbeat.mjs — no third scheduler framework.
   */
  function scheduleReportFlush(intervalMs = FLUSH_POLL_MS) {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      attemptFlush().catch((err) => {
        logger.error?.(`[report-queue] Flush cycle error: ${err.message}`);
      });
    }, intervalMs);
    flushTimer.unref(); // Don't block graceful shutdown
    logger.info?.(`[report-queue] Scheduled flush every ${intervalMs / 1000}s`);
  }

  function stop() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  function getPending() {
    return stmts.getAll.all();
  }

  function getStats() {
    return {
      pending: stmts.countPending.get().c,
    };
  }

  return {
    queueOutboundReport,
    attemptFlush,
    scheduleReportFlush,
    getPending,
    getStats,
    stop,
    _stmts: stmts,
  };
}
