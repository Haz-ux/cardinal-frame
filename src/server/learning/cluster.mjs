/**
 * Cardinal Frame — Learning — Semantic Clustering (Phase 3, shadow mode)
 *
 * Groups near-duplicate learning candidates into clusters and proposes
 * merges. Proposals are REVIEW OBJECTS ONLY: nothing merges without the
 * explicit merge-proposals approve route. Clustering never deletes
 * candidates — a merge only archives the losers into the survivor.
 *
 * Ownership: every entry point takes userId and filters on it.
 *
 * Similarity path: MiniLM embeddings (embedBatch) when the model loads;
 * lexical Jaccard fallback otherwise. Greedy clustering orders candidates
 * by promotion_score desc and joins each candidate to the best existing
 * cluster when pairwise max-member similarity >= threshold.
 */

import { randomUUID } from 'crypto';
import { embedBatch, cosineSimilarity, unloadEmbeddingModel } from '../embeddings.mjs';

// ─── Threshold (env) ────────────────────────────────────────────────

function readThreshold() {
  const raw = parseFloat(process.env.LEARNING_MERGE_THRESHOLD);
  if (!Number.isFinite(raw)) return 0.8;
  // Clamp to the open interval (0, 1): thresholds of 0 or 1 are useless
  // for a similarity cut-off.
  if (raw <= 0 || raw >= 1) return 0.8;
  return raw;
}

// ─── Signatures ─────────────────────────────────────────────────────

/**
 * Canonical text used for similarity: title plus draft steps.
 * candidate.draft may be a parsed array (listCandidates rows with JSON
 * parsed) or a raw JSON string (getCandidate parse) — handle both.
 */
export function signatureFor(candidate) {
  const title = String(candidate?.title ?? '');
  let draft = candidate?.draft ?? [];
  if (typeof draft === 'string') {
    try {
      draft = JSON.parse(draft);
    } catch {
      draft = [draft];
    }
  }
  if (!Array.isArray(draft)) draft = [draft];
  const steps = draft.map(s => String(s ?? '')).filter(Boolean);
  return `${title}\n${steps.join('\n')}`;
}

// ─── Lexical similarity (MiniLM fallback) ───────────────────────────

const COMMON_WORDS = [
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was',
  'were', 'been', 'have', 'has', 'had', 'will', 'would', 'should',
  'could', 'when', 'where', 'which', 'what', 'how', 'why', 'all',
  'any', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'than', 'then', 'there', 'these', 'those', 'into', 'over', 'after',
  'before', 'between', 'about', 'again', 'once', 'only', 'its', 'it',
  'itself', 'use', 'using', 'used', 'make', 'new', 'out', 'also',
];
export const STOPWORDS = new Set(COMMON_WORDS);

/**
 * Lowercase, split on non-alphanumerics, drop stopwords and tokens
 * shorter than 3 chars. Returns a Set of tokens.
 */
export function tokenize(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/**
 * Jaccard similarity over token sets: |A ∩ B| / |A ∪ B|, in 0..1.
 * Empty-vs-empty is 0 (two empty signatures carry no signal).
 */
export function lexicalSimilarity(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── Similarity construction ────────────────────────────────────────

/**
 * Build a pairwise similarity function over signature strings.
 *
 * Tries MiniLM (embedBatch + cosine similarity); on ANY failure — the
 * embed call throws, returns nothing usable, or returns fewer vectors
 * than requested — falls back to the deterministic lexical path.
 * Unloads the embedding model after a successful MiniLM run to keep
 * memory free (the run is bursty, not continuous).
 *
 * Returns { sim(i, j), method } where sim(i, j) is in 0..1 and
 * method is 'minilm' or 'lexical'.
 */
export async function buildSimilarity(signatures) {
  const n = signatures.length;
  const sim = (i, j) => {
    if (i === j) return 1;
    return lexicalSimilarity(signatures[i], signatures[j]);
  };
  if (n === 0) return { sim, method: 'lexical' };

  let vectors = null;
  let ok = false;
  try {
    const raw = await embedBatch(signatures);
    if (Array.isArray(raw) && raw.length === n && raw.every(v => Array.isArray(v) && v.length > 0)) {
      vectors = raw;
      ok = true;
    }
  } catch {
    vectors = null;
    ok = false;
  }

  if (!ok) {
    return { sim, method: 'lexical' };
  }

  // MiniLM success: free the model now; clustering is one-shot work.
  try { unloadEmbeddingModel(); } catch { /* never breaks clustering */ }

  const cache = new Map();
  const simMinilm = (i, j) => {
    if (i === j) return 1;
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    if (!cache.has(key)) {
      cache.set(key, Math.max(0, Math.min(1, cosineSimilarity(vectors[i], vectors[j]))));
    }
    return cache.get(key);
  };
  return { sim: simMinilm, method: 'minilm' };
}

// ─── Greedy clustering ──────────────────────────────────────────────

/**
 * Greedy clustering over candidates given a pairwise similarity fn.
 *
 * Order candidates by promotion_score desc; for each, compute the best
 * cluster as the max similarity to any current member of a cluster, and
 * join the best cluster when bestSim >= threshold, else start a new one.
 *
 * The centroid-mean variant for MiniLM is intentionally approximated by
 * max-member similarity: for near-duplicate detection this is strictly
 * more conservative at join time (a candidate joins when it is close to
 * at least one member), and it keeps the function purely pairwise and
 * testable without a vector pipeline.
 *
 * @param {Array} candidates candidates (uses title/draft/promotion_score)
 * @param {object} opts { threshold = 0.8, similarity } — similarity(i, j)
 *   indexes into the candidates array order.
 * @returns [{ members: [candidateIdx...], avgSim }] — avgSim is the mean
 *   of the join-time best similarities of members added after the first
 *   (0 for singletons).
 */
export function clusterCandidates(candidates, { threshold = 0.8, similarity } = {}) {
  if (typeof similarity !== 'function') {
    throw new Error('clusterCandidates requires a similarity(i, j) function');
  }
  const order = candidates.map((_, i) => i)
    .sort((a, b) => (candidates[b].promotion_score ?? 0) - (candidates[a].promotion_score ?? 0));
  const clusters = [];
  for (const idx of order) {
    let best = null;
    let bestSim = -Infinity;
    for (const c of clusters) {
      let simToCluster = -Infinity;
      for (const m of c.members) {
        const s = similarity(idx, m);
        if (s > simToCluster) simToCluster = s;
      }
      if (simToCluster > bestSim) { bestSim = simToCluster; best = c; }
    }
    if (best && bestSim >= threshold) {
      best.members.push(idx);
      best._joinSims.push(bestSim);
    } else {
      clusters.push({ members: [idx], _joinSims: [] });
    }
  }
  return clusters.map(c => ({
    members: c.members,
    avgSim: c._joinSims.length
      ? c._joinSims.reduce((a, b) => a + b, 0) / c._joinSims.length
      : 0,
  }));
}

// ─── Merge eligibility ──────────────────────────────────────────────

/** States that may appear in a merge proposal. Rejected (or an active
 *  cooldown) and archived candidates are never merge targets. */
export const MERGEABLE_STATES = new Set(['candidate', 'testing', 'promoted']);

/** A candidate is a merge target only when mergeable and not cooling down. */
export function isMergeable(c) {
  if (!c) return false;
  if (!MERGEABLE_STATES.has(c.state)) return false;
  if (c.cooldown_until && c.cooldown_until > new Date().toISOString()) return false;
  return true;
}

// ─── Proposals ──────────────────────────────────────────────────────

/** Insert a merge proposal row (owner-scoped). */
function insertProposal(db, userId, clusterId, memberIds, combinedSupport) {
  const id = randomUUID();
  db.prepare(`INSERT INTO learning_merge_proposals
      (id, user_id, cluster_id, from_candidate_ids, combined_support, state, created_at)
      VALUES (?, ?, ?, ?, ?, 'proposed', datetime('now'))`)
    .run(id, userId, clusterId, JSON.stringify([...memberIds].sort()),
      JSON.stringify(combinedSupport));
  return id;
}

/**
 * For each cluster with ≥2 mergeable members: insert a proposal unless an
 * identical open proposal already exists for the same member set
 * (idempotent — the stored JSON is kept in canonical sorted order).
 * Legacy read-only clusters never produce proposals. Clusters argument
 * is the persisted shape: [{ id, isLegacy, members: [candidateRows] }].
 * Returns the ids of created proposals.
 */
export function proposeMerges(db, userId, clusters) {
  if (!userId) throw new Error('userId is required (ownership)');
  const created = [];
  for (const cluster of clusters) {
    if (cluster.isLegacy) continue;
    const mergeable = (cluster.members || []).filter(isMergeable);
    if (mergeable.length < 2) continue;
    const memberIds = mergeable.map(c => c.id);
    const key = JSON.stringify([...memberIds].sort());
    const dup = db.prepare(`SELECT id FROM learning_merge_proposals
      WHERE user_id = ? AND cluster_id = ? AND state = 'proposed' AND from_candidate_ids = ?`)
      .get(userId, cluster.id, key);
    if (dup) continue;
    const combinedSupport = {
      verified: mergeable.reduce((a, c) => a + (c.support_verified ?? 0), 0),
      recovered: mergeable.reduce((a, c) => a + (c.support_recovered ?? 0), 0),
      corrections: mergeable.reduce((a, c) => a + (c.support_corrections ?? 0), 0),
    };
    created.push(insertProposal(db, userId, cluster.id, memberIds, combinedSupport));
  }
  return created;
}

/** Load mergeable candidates for the user (lightweight projection). */
function loadMergeableCandidates(db, userId) {
  const placeholders = [...MERGEABLE_STATES].map(() => '?').join(',');
  const now = new Date().toISOString();
  return db.prepare(`SELECT id, user_id, kind, title, draft, risk_tier, state,
      support_verified, support_recovered, support_corrections,
      promotion_score, cooldown_until, created_at
    FROM learning_candidates
    WHERE user_id = ? AND state IN (${placeholders})
      AND (cooldown_until IS NULL OR cooldown_until <= ?)`)
    .all(userId, ...MERGEABLE_STATES, now);
}

// ─── Run clustering ─────────────────────────────────────────────────

/**
 * Full clustering run for a user. NEVER THROWS: on any failure returns
 * { ok: false, error } instead.
 *
 * Optional `similarity` ({ sim(i,j), method }) is a test seam that skips
 * the embedding step entirely (used by CI tests so they never load the
 * model). Production callers omit it.
 *
 * Steps: load mergeable candidates → build signatures → similarity →
 * greedy cluster → persist: delete the user's non-legacy clusters +
 * their members + open proposals (fresh re-cluster; legacy clusters are
 * untouched) → insert clusters (label = highest-score member's title,
 * truncated) with member rows (similarity, is_centroid) → proposals.
 *
 * The centroid is the member with the highest promotion_score; its
 * signature is the cluster's centroid_signature.
 */
export async function runClustering({ db, userId, logger = console, threshold, similarity }) {
  if (!userId) throw new Error('userId is required (ownership)');
  const t = threshold ?? readThreshold();
  const stats = {
    method: 'none', threshold: t, candidates_scanned: 0,
    clusters_formed: 0, proposals_created: 0, avg_similarity: 0,
    member_sizes: [],
  };
  try {
    const candidates = loadMergeableCandidates(db, userId);
    stats.candidates_scanned = candidates.length;
    if (candidates.length < 2) {
      logger.info(`Learning cluster run: ${candidates.length} candidates — nothing to cluster`);
      return { ok: true, stats };
    }

    const signatures = candidates.map(signatureFor);
    // Test seam: a caller-supplied similarity fn skips embedding entirely.
    const { sim, method } = similarity
      ? { sim: similarity, method: 'test-stub' }
      : await buildSimilarity(signatures);
    stats.method = method;

    const clusterPlan = clusterCandidates(candidates, { threshold: t, similarity: sim });
    stats.clusters_formed = clusterPlan.length;

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      // Fresh re-cluster: drop this user's non-legacy clusters, their
      // member rows (cascade), and their open proposals. Legacy
      // read-only clusters are left alone, always.
      db.prepare(`DELETE FROM learning_clusters
        WHERE user_id = ? AND is_legacy_readonly = 0`).run(userId);
      db.prepare(`DELETE FROM learning_merge_proposals
        WHERE user_id = ? AND state = 'proposed'`).run(userId);

      const insCluster = db.prepare(`INSERT INTO learning_clusters
        (id, user_id, label, centroid_signature, member_count, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`);
      const insMember = db.prepare(`INSERT INTO candidate_cluster_members
        (id, cluster_id, candidate_id, similarity, is_centroid, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`);

      for (const plan of clusterPlan) {
        // Centroid = highest promotion_score member (candidates were
        // ordered by score when clustering, but re-check explicitly).
        const ranked = [...plan.members].sort(
          (a, b) => (candidates[b].promotion_score ?? 0) - (candidates[a].promotion_score ?? 0));
        const centroidIdx = ranked[0];
        const centroid = candidates[centroidIdx];
        const clusterId = randomUUID();
        insCluster.run(clusterId, userId,
          String(centroid.title ?? '').slice(0, 120),
          signatureFor(centroid),
          plan.members.length, now, now);
        for (const m of plan.members) {
          const member = candidates[m];
          // Similarity of this member to the cluster: max pairwise
          // similarity to any OTHER member (self excluded); centroid
          // records its own score as 1.
          let similarity = 0;
          if (m !== centroidIdx) {
            for (const o of plan.members) {
              if (o === m) continue;
              const s = sim(m, o);
              if (s > similarity) similarity = s;
            }
          } else {
            similarity = 1;
          }
          insMember.run(randomUUID(), clusterId, member.id, similarity,
            m === centroidIdx ? 1 : 0, now);
        }
      }
    });
    tx();

    // Read back the persisted clusters for proposals + stats.
    const rows = db.prepare(`SELECT c.id, c.is_legacy_readonly, c.member_count
      FROM learning_clusters c WHERE c.user_id = ? AND c.is_legacy_readonly = 0`)
      .all(userId);
    const persisted = rows.map(r => ({
      id: r.id,
      isLegacy: r.is_legacy_readonly === 1,
      members: db.prepare(`SELECT lc.id, lc.user_id, lc.kind, lc.title, lc.draft,
          lc.risk_tier, lc.state, lc.support_verified, lc.support_recovered,
          lc.support_corrections, lc.promotion_score, lc.cooldown_until, lc.created_at
        FROM candidate_cluster_members m
        JOIN learning_candidates lc ON lc.id = m.candidate_id
        WHERE m.cluster_id = ? AND lc.user_id = ?`)
        .all(r.id, userId),
    }));
    const createdProposals = proposeMerges(db, userId, persisted);
    stats.proposals_created = createdProposals.length;

    const sizes = clusterPlan.map(p => p.members.length);
    stats.member_sizes = sizes;
    const multiSim = clusterPlan.filter(p => p.members.length > 1).map(p => p.avgSim);
    stats.avg_similarity = multiSim.length
      ? multiSim.reduce((a, b) => a + b, 0) / multiSim.length
      : 0;

    logger.info(`Learning cluster run: ${stats.candidates_scanned} candidates, ` +
      `${stats.clusters_formed} clusters (method=${method}, threshold=${t}), ` +
      `${stats.proposals_created} merge proposals`);
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ─── Legacy backfill ────────────────────────────────────────────────

/**
 * Backfill clusters from the pre-Phase-2 `learn_patterns` table (when it
 * exists): one read-only cluster per pattern row. Idempotent: skips
 * entirely when the user already has any legacy clusters. Never produces
 * proposals. Never throws.
 */
export function backfillLegacyClusters({ db, userId, logger = console }) {
  if (!userId) throw new Error('userId is required (ownership)');
  const result = { ok: true, imported: 0, skipped: 0 };
  try {
    const existing = db.prepare(`SELECT COUNT(*) AS c FROM learning_clusters
      WHERE user_id = ? AND is_legacy_readonly = 1`).get(userId);
    if (existing && existing.c > 0) {
      result.skipped = existing.c;
      return result;
    }
    const hasTable = db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'learn_patterns'`).get();
    if (!hasTable) {
      return result;
    }
    const rows = db.prepare(`SELECT pattern_key, description, occurrence_count
      FROM learn_patterns`).all();
    const ins = db.prepare(`INSERT INTO learning_clusters
      (id, user_id, label, centroid_signature, member_count, state, is_legacy_readonly, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 1, datetime('now'), datetime('now'))`);
    const tx = db.transaction(() => {
      for (const r of rows) {
        const label = String(r.description || r.pattern_key || '').slice(0, 120);
        ins.run(randomUUID(), userId, label,
          String(r.description || ''),
          Number(r.occurrence_count) || 0);
      }
    });
    tx();
    result.imported = rows.length;
    logger.info(`Learning legacy backfill: imported ${rows.length} read-only clusters`);
    return result;
  } catch (err) {
    return { ok: false, error: err?.message || String(err), imported: 0, skipped: 0 };
  }
}
