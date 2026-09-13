#!/usr/bin/env node
/**
 * Cardinal Frame — Learning — Similarity threshold calibrator (Phase 3).
 *
 * Runnable: node src/server/learning/calibrate.mjs
 *
 * Embeds a built-in golden set of labeled candidate-signature pairs with
 * MiniLM when available (else the lexical fallback — it prints which), sweeps
 * the clustering threshold from 0.60 to 0.95 in 0.05 steps, and reports
 * precision / recall / F1 per threshold plus the best-F1 recommendation.
 *
 * No DB access, no writes, no network beyond the model download (skipped
 * gracefully offline). Exits 0.
 *
 * The golden pairs use realistic candidate signatures in the shape the
 * clusterer sees: `${title}\n${draft steps joined by newlines}`.
 */

import { buildSimilarity, lexicalSimilarity } from './cluster.mjs';

// ─── Golden set ─────────────────────────────────────────────────────
// duplicate=true  → two descriptions of the SAME procedure (should cluster)
// duplicate=false → clearly different procedures (should NOT cluster)

const PAIRS = [
  // ---- duplicates (same procedure, different wording) ----
  {
    duplicate: true,
    a: 'Deploy health check\nPing /health on the staging service every minute.\nIf two consecutive pings fail, page the on-call engineer.',
    b: 'Staging health monitor\nCheck the staging /health endpoint each minute.\nAfter two failed checks in a row, alert the on-call engineer.',
  },
  {
    duplicate: true,
    a: 'API retry policy\nRetry failed API calls up to 3 times.\nUse exponential backoff starting at 2 seconds.\nLog each retry attempt with the error message.',
    b: 'Retry flaky API requests\nOn failure, retry the request a maximum of 3 times.\nBack off exponentially from a 2s base.\nRecord every retry with its error in the logs.',
  },
  {
    duplicate: true,
    a: 'Log rotation\nRotate service logs when they reach 100MB.\nKeep 7 historical archives.\nCompress archives older than one day.',
    b: 'Rotate logs by size\nWhen a log file hits 100MB, rotate it.\nRetain the last 7 rotations.\nGzip any archive older than 24 hours.',
  },
  {
    duplicate: true,
    a: 'Database backup verification\nAfter the nightly backup completes, restore it to a scratch database.\nRun the row-count sanity query.\nAlert if any check fails.',
    b: 'Nightly backup smoke test\nTake the finished nightly backup and restore it into scratch.\nExecute the sanity row-count query.\nNotify the team when a check fails.',
  },
  {
    duplicate: true,
    a: 'Disk space alert\nMonitor disk usage on database nodes.\nAt 85% usage send a warning to the ops channel.\nAt 95% trigger an urgent page.',
    b: 'Watch database disk usage\nTrack free space on the DB hosts.\nWarn ops chat when usage reaches 85%.\nPage urgently once it hits 95%.',
  },
  {
    duplicate: true,
    a: 'Password reset flow\nSend the reset email with a one-hour token.\nInvalidate the token after first use.\nLog the reset event for audit.',
    b: 'Forgot-password handling\nEmail a reset link carrying a token valid for one hour.\nBurn the token once it is used.\nRecord the reset in the audit log.',
  },
  {
    duplicate: true,
    a: 'Cache invalidation on deploy\nPurge the CDN cache after each production deploy.\nWait for the purge confirmation.\nVerify one warm page load succeeds.',
    b: 'Flush CDN after deploys\nInvalidate the CDN cache following every production release.\nBlock until purge is confirmed.\nConfirm a warm page fetch works.',
  },
  {
    duplicate: true,
    a: 'SSL certificate expiry check\nCheck cert expiry daily.\nWarn 30 days before expiry.\nPage 7 days before expiry.',
    b: 'TLS cert expiration monitor\nScan certificate expiry dates each day.\nSend a warning with 30 days remaining.\nPage when 7 days remain.',
  },
  {
    duplicate: true,
    a: 'Rate limit 429 handling\nOn HTTP 429, read the Retry-After header.\nSleep for the indicated duration.\nResume the queue afterwards.',
    b: 'Handle API rate limiting\nWhen the API returns 429, honor the Retry-After header.\nPause for the requested seconds.\nContinue processing the queue.',
  },
  {
    duplicate: true,
    a: 'Docker image pruning\nRemove unused Docker images weekly.\nKeep the last 3 tagged releases.\nReport reclaimed disk space.',
    b: 'Weekly image cleanup\nPrune dangling Docker images every week.\nRetain the three most recent tagged builds.\nLog how much disk was freed.',
  },
  {
    duplicate: true,
    a: 'Session timeout\nExpire idle sessions after 30 minutes.\nShow a 2-minute warning dialog.\nDestroy the server-side session on expiry.',
    b: 'Idle session expiry\nLog out sessions idle for more than 30 minutes.\nDisplay a warning two minutes before.\nInvalidate the session server-side at expiry.',
  },
  {
    duplicate: true,
    a: 'Queue dead-letter triage\nInspect dead-lettered messages each morning.\nRetry transient failures once.\nFile a ticket for persistent ones.',
    b: 'Morning dead-letter review\nLook over the dead-letter queue daily.\nGive transient errors one more retry.\nOpen tickets for messages that keep failing.',
  },

  // ---- non-duplicates (different procedures) ----
  {
    duplicate: false,
    a: 'Deploy health check\nPing /health on the staging service every minute.\nIf two consecutive pings fail, page the on-call engineer.',
    b: 'Rotate logs by size\nWhen a log file hits 100MB, rotate it.\nRetain the last 7 rotations.\nGzip any archive older than 24 hours.',
  },
  {
    duplicate: false,
    a: 'API retry policy\nRetry failed API calls up to 3 times.\nUse exponential backoff starting at 2 seconds.',
    b: 'Password reset flow\nSend the reset email with a one-hour token.\nInvalidate the token after first use.',
  },
  {
    duplicate: false,
    a: 'Database backup verification\nAfter the nightly backup completes, restore it to a scratch database.\nRun the row-count sanity query.',
    b: 'SSL certificate expiry check\nCheck cert expiry daily.\nWarn 30 days before expiry.',
  },
  {
    duplicate: false,
    a: 'Disk space alert\nMonitor disk usage on database nodes.\nAt 85% usage send a warning to the ops channel.',
    b: 'Queue dead-letter triage\nInspect dead-lettered messages each morning.\nRetry transient failures once.',
  },
  {
    duplicate: false,
    a: 'Cache invalidation on deploy\nPurge the CDN cache after each production deploy.\nWait for the purge confirmation.',
    b: 'Session timeout\nExpire idle sessions after 30 minutes.\nShow a 2-minute warning dialog.',
  },
  {
    duplicate: false,
    a: 'Rate limit 429 handling\nOn HTTP 429, read the Retry-After header.\nSleep for the indicated duration.',
    b: 'Docker image pruning\nRemove unused Docker images weekly.\nKeep the last 3 tagged releases.',
  },
  {
    duplicate: false,
    a: 'TLS cert expiration monitor\nScan certificate expiry dates each day.\nSend a warning with 30 days remaining.',
    b: 'Forgot-password handling\nEmail a reset link carrying a token valid for one hour.\nBurn the token once it is used.',
  },
  {
    duplicate: false,
    a: 'Handle API rate limiting\nWhen the API returns 429, honor the Retry-After header.\nPause for the requested seconds.',
    b: 'Morning dead-letter review\nLook over the dead-letter queue daily.\nGive transient errors one more retry.',
  },
  {
    duplicate: false,
    a: 'Staging health monitor\nCheck the staging /health endpoint each minute.\nAfter two failed checks in a row, alert the on-call engineer.',
    b: 'Weekly image cleanup\nPrune dangling Docker images every week.\nRetain the three most recent tagged builds.',
  },
  {
    duplicate: false,
    a: 'Retry flaky API requests\nOn failure, retry the request a maximum of 3 times.\nBack off exponentially from a 2s base.',
    b: 'Idle session expiry\nLog out sessions idle for more than 30 minutes.\nDisplay a warning two minutes before.',
  },
  {
    duplicate: false,
    a: 'Nightly backup smoke test\nTake the finished nightly backup and restore it into scratch.\nExecute the sanity row-count query.',
    b: 'Flush CDN after deploys\nInvalidate the CDN cache following every production release.\nBlock until purge is confirmed.',
  },
  {
    duplicate: false,
    a: 'Watch database disk usage\nTrack free space on the DB hosts.\nWarn ops chat when usage reaches 85%.',
    b: 'Inspect dead-lettered messages each morning.\nRetry transient failures once.\nFile a ticket for persistent ones.',
  },
];

function fmt(x, digits = 3) {
  return Number.isFinite(x) ? x.toFixed(digits) : 'n/a';
}

async function main() {
  const dups = PAIRS.filter(p => p.duplicate).length;
  const nonDups = PAIRS.length - dups;
  console.log(`Golden set: ${PAIRS.length} pairs (${dups} duplicate, ${nonDups} distinct)`);

  // Embed every unique text once, then score each pair.
  const uniques = [];
  const idxOf = new Map();
  for (const p of PAIRS) {
    for (const t of [p.a, p.b]) {
      if (!idxOf.has(t)) { idxOf.set(t, uniques.length); uniques.push(t); }
    }
  }
  const { sim, method } = await buildSimilarity(uniques);
  console.log(`Similarity method: ${method}\n`);

  const scored = PAIRS.map(p => ({
    truth: p.duplicate,
    score: sim(idxOf.get(p.a), idxOf.get(p.b)),
  }));

  // Quick sanity: how many lexical-only pairs overlap between classes?
  const dupScores = scored.filter(s => s.truth).map(s => s.score).sort((x, y) => x - y);
  const nonScores = scored.filter(s => !s.truth).map(s => s.score).sort((x, y) => x - y);
  console.log(`Duplicates   — min ${fmt(dupScores[0])}, max ${fmt(dupScores[dupScores.length - 1])}`);
  console.log(`Non-duplicates — min ${fmt(nonScores[0])}, max ${fmt(nonScores[nonScores.length - 1])}\n`);

  console.log('threshold  precision  recall  f1      tp  fp  fn');
  console.log('─────────  ─────────  ──────  ──────  ──  ──  ──');

  let best = null;
  for (let t = 0.6; t <= 0.951; t += 0.05) {
    const thr = Math.round(t * 100) / 100;
    let tp = 0, fp = 0, fn = 0;
    for (const s of scored) {
      const predicted = s.score >= thr;
      if (predicted && s.truth) tp++;
      else if (predicted && !s.truth) fp++;
      else if (!predicted && s.truth) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    console.log(`${fmt(thr, 2).padStart(9)}  ${fmt(precision).padStart(9)}  ${fmt(recall).padStart(6)}  ` +
      `${fmt(f1).padStart(6)}  ${String(tp).padStart(2)}  ${String(fp).padStart(2)}  ${String(fn).padStart(2)}`);
    if (!best || f1 > best.f1) best = { thr, precision, recall, f1, tp, fp, fn };
  }

  console.log(`\nRecommended threshold: ${fmt(best.thr, 2)} ` +
    `(F1=${fmt(best.f1)}, precision=${fmt(best.precision)}, recall=${fmt(best.recall)})`);
  console.log('Set it with: LEARNING_MERGE_THRESHOLD=' + fmt(best.thr, 2));
}

main().catch(err => {
  console.error('calibrate failed:', err.message);
  process.exitCode = 1;
});
