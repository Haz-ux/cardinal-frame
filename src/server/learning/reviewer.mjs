/**
 * Cardinal Frame — Learning — Reviewer (Phase 2)
 *
 * runReviewJob() distills the Phase-1 evidence stream (learning_events)
 * into candidate proposals (learning_candidates + candidate_evidence).
 * It runs synchronously from POST /api/learning/review/run.
 *
 * SHADOW MODE — candidates are review objects, NEVER usable skills:
 * - the reviewer only assembles review rows + evidence links;
 * - HIGH risk candidates are created in state='candidate' and can NEVER
 *   be auto-anything;
 * - approve/reject only flip state flags; no promotion path executes,
 *   installs, or activates anything.
 *
 * Determinism: eligibility, grouping, scoring, and risk are pure
 * functions of the evidence. The only non-deterministic step is Aimi's
 * LLM draft, which degrades to a template on any failure and never fails
 * the job.
 *
 * Never throws: the catch-all records the error on the job row and sets
 * status='failed'.
 */

import { randomUUID } from 'crypto';
import {
  buildExcerpt, excerptHash, EVIDENCE_WEIGHTS,
  reopenCandidate, findCandidatesByTraceKey, insertCandidate,
  updateCandidateFields, linkEvidence, countCandidatesToday,
  getCandidate, getCandidateEventRows,
} from './candidates.mjs';

const NULL_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Reviewer configuration. Weights are a const; the daily assembly budget
 * is env-overridable via LEARNING_REVIEW_BUDGET (default 20/user/day).
 */
export const REVIEW_CONFIG = {
  budgetEnv: 'LEARNING_REVIEW_BUDGET',
  defaultBudget: 20,
  // support = verified + 1.5*recovered + 2*corrections
  supportWeights: { verified: 1.0, recovered: 1.5, corrections: 2.0 },
  // quality = weighted sum (weights sum to 1)
  qualityWeights: {
    verification: 0.35,
    generality: 0.25,
    reproducibility: 0.2,
    recency: 0.1,
    reviewerConfidence: 0.1,
  },
  reviewerConfidenceBaseline: 0.75,
  // promotion_score = support * quality * (1 - risk_penalty)
  riskPenalty: { low: 0, medium: 0.3, high: 0.6 },
  recencyHalfLifeDays: 30,
  // Payload text patterns that force risk_tier='high'.
  destructivePatterns: [
    /\brm\s+-rf\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bmkfs\b/i,
    /:\(\)\s*\{[^}]*\}\s*;/,      // fork bomb
    /\bdd\s+if=/i,
    /\bformat\s+[a-z]:/i,
    /\bshutdown\b/i,
  ],
  // Event types that can carry eligible outcomes. The Phase-1 writer emits
  // 'turn_terminal'/'tool_outcome'; 'terminal_turn' is the plan's naming —
  // accept both so the contract and reality agree.
  eligibleTypes: new Set(['terminal_turn', 'turn_terminal', 'tool_outcome']),
  successOutcomes: new Set(['success', 'completed']),
  failedOutcomes: new Set(['failed', 'error']),
};

function budgetFor(override) {
  if (Number.isFinite(override)) return Math.max(0, Math.floor(override));
  const env = parseInt(process.env[REVIEW_CONFIG.budgetEnv] || '', 10);
  return Number.isFinite(env) && env >= 0 ? env : REVIEW_CONFIG.defaultBudget;
}

function normalizeOutcome(outcome) {
  if (REVIEW_CONFIG.successOutcomes.has(outcome)) return 'success';
  if (REVIEW_CONFIG.failedOutcomes.has(outcome)) return 'failed';
  return outcome || 'unknown';
}

function parsePayload(json) {
  // Throws on malformed JSON — the caller dead-letters the event.
  const v = JSON.parse(json);
  return v && typeof v === 'object' ? v : {};
}

function isCorrection(type, payload) {
  return type === 'user_correction'
    || (type === 'user_message' && payload && payload.correction === true);
}

/**
 * Classify one event row. Returns null when the event is not eligible
 * (praise-only messages, awaiting_approval, unknown outcomes/types are
 * NEVER eligible), or a classified item { row, payload, outcome, roleHint }.
 * Throws on malformed payload so the caller can dead-letter the event.
 */
export function classifyEvent(row) {
  const payload = parsePayload(row.payload);
  const type = row.type || '';
  if (isCorrection(type, payload)) {
    return { row, payload, outcome: normalizeOutcome(row.outcome), correction: true };
  }
  if (!REVIEW_CONFIG.eligibleTypes.has(type)) return null; // never eligible
  const outcome = normalizeOutcome(row.outcome);
  if (outcome === 'success' || outcome === 'failed') {
    return { row, payload, outcome, correction: false };
  }
  return null; // praise-only / unknown / awaiting_approval: never eligible
}

/**
 * Group classified items into candidate proposals:
 * - outcome items grouped by trace_id → 'recovery' when a failure is
 *   followed by a success in the same trace, else 'procedure' for traces
 *   with bare successes (failures without recovery are not learnable);
 * - correction items grouped by conversation_id → 'correction'.
 * Returns [{ key, kind, items: [{ row, payload, outcome, role, weight, excerpt }] }].
 */
export function groupEvidence(items) {
  const byTrace = new Map();
  const byConversation = new Map();
  for (const item of items) {
    if (item.correction) {
      const key = item.row.conversation_id || item.row.id;
      if (!byConversation.has(key)) byConversation.set(key, []);
      byConversation.get(key).push(item);
    } else {
      const key = item.row.trace_id || item.row.conversation_id || item.row.id;
      if (!byTrace.has(key)) byTrace.set(key, []);
      byTrace.get(key).push(item);
    }
  }

  const groups = [];
  for (const [key, traceItems] of byTrace) {
    // Insertion order: created_at has 1s granularity, so rowid breaks ties.
    const ordered = [...traceItems].sort(
      (a, b) => String(a.row.created_at).localeCompare(String(b.row.created_at))
        || ((a.row.rowid ?? 0) - (b.row.rowid ?? 0))
        || String(a.row.id).localeCompare(String(b.row.id)),
    );
    const firstFailureIdx = ordered.findIndex((i) => i.outcome === 'failed');
    const hasRecovery = firstFailureIdx >= 0
      && ordered.slice(firstFailureIdx + 1).some((i) => i.outcome === 'success');
    const successes = ordered.filter((i) => i.outcome === 'success');
    if (hasRecovery) {
      const group = { key, kind: 'recovery', items: [] };
      for (let n = 0; n < ordered.length; n++) {
        const item = ordered[n];
        if (item.outcome === 'failed' && n < ordered.length - 1
            && ordered.slice(n + 1).some((s) => s.outcome === 'success')) {
          group.items.push(withRole(item, 'recovery_trigger'));
        } else if (item.outcome === 'success') {
          group.items.push(withRole(item, 'recovery_action'));
        }
      }
      if (group.items.length) groups.push(group);
    } else if (successes.length) {
      groups.push({ key, kind: 'procedure', items: successes.map((i) => withRole(i, 'success')) });
    }
    // else: failures with no recovery — not learnable, no candidate.
  }

  for (const [key, convItems] of byConversation) {
    groups.push({ key, kind: 'correction', items: convItems.map((i) => withRole(i, 'correction')) });
  }
  return groups;
}

function withRole(item, role) {
  const excerpt = buildExcerpt(item.row.payload);
  return {
    row: item.row,
    payload: item.payload,
    outcome: item.outcome,
    role,
    weight: EVIDENCE_WEIGHTS[role] ?? 1.0,
    excerpt,
    excerptHash: excerptHash(excerpt),
  };
}

/**
 * Rebuild reviewer items from stored evidence rows (role comes from
 * candidate_evidence). Used when refreshing a reopened candidate so its
 * stats reflect ALL linked evidence, not just the newest batch.
 */
export function itemsFromRows(rows) {
  return rows.map((r) => {
    let payload = {};
    try {
      const v = JSON.parse(r.payload);
      if (v && typeof v === 'object') payload = v;
    } catch { /* excerpt builder tolerates this */ }
    const excerpt = buildExcerpt(r.payload);
    return {
      row: {
        id: r.id, trace_id: r.trace_id, conversation_id: r.conversation_id,
        created_at: r.created_at, rowid: r.rowid,
      },
      payload,
      outcome: normalizeOutcome(r.outcome),
      role: r.role,
      weight: r.weight ?? EVIDENCE_WEIGHTS[r.role] ?? 1.0,
      excerpt,
      excerptHash: excerptHash(excerpt),
    };
  });
}

/** Assemble the full candidate field set from a list of items. */
async function buildFields(db, userId, kind, items, log) {
  const { riskTier, requestedCaps } = assessRisk(items);
  const scored = scoreCandidate(items, riskTier);
  const draft = await draftProcedure(db, items, log);
  return {
    userId,
    kind,
    title: titleFor(kind, items),
    draft,
    eligibilityNote: eligibilityNoteFor(kind, items, scored),
    riskTier,
    requestedCaps,
    supportVerified: scored.supportVerified,
    supportRecovered: scored.supportRecovered,
    supportCorrections: scored.supportCorrections,
    qualityJson: scored.quality,
    promotionScore: scored.promotionScore,
  };
}

/**
 * Risk assessment from evidence. requested_caps are inferred heuristically:
 * tool names containing exec/shell/run/command → `exec: <tool>` (wildcard
 * `exec: *` when the tool or its command contains a `*` glob), read-like
 * tools → `read: <tool>`, anything else → `use: <tool>`.
 * high: wildcard exec cap or destructive payload pattern;
 * medium: any exec cap; else low.
 */
export function assessRisk(items) {
  const caps = new Set();
  const texts = [];
  for (const { payload } of items) {
    texts.push(JSON.stringify(payload));
    const tool = payload.tool ?? payload.tool_name ?? payload.name;
    if (tool == null || tool === '') continue;
    const toolStr = String(tool);
    const t = toolStr.toLowerCase();
    const cmdStr = String(payload.command ?? payload.cmd ?? payload.args ?? '');
    const isExec = /exec|shell|run|command|terminal|bash|\bsh\b/.test(t);
    const isRead = /read|file|cat|fetch|get|load/.test(t);
    if (isExec) {
      caps.add(t === '*' || /\*/.test(cmdStr) ? 'exec: *' : `exec: ${toolStr}`);
    } else if (isRead) {
      caps.add(`read: ${toolStr}`);
    } else {
      caps.add(`use: ${toolStr}`);
    }
  }
  const requestedCaps = [...caps].sort();
  const blob = texts.join('\n');
  const destructive = REVIEW_CONFIG.destructivePatterns.some((re) => re.test(blob));
  let riskTier = 'low';
  if (requestedCaps.includes('exec: *') || destructive) riskTier = 'high';
  else if (requestedCaps.some((c) => c.startsWith('exec:'))) riskTier = 'medium';
  return { riskTier, requestedCaps };
}

/**
 * Deterministic scoring.
 * support = verified + 1.5*recovered + 2*corrections
 * quality = 0.35*verification + 0.25*generality + 0.2*reproducibility
 *         + 0.1*recency + 0.1*reviewer_confidence
 * promotion_score = support * quality * (1 - risk_penalty)
 */
export function scoreCandidate(items, riskTier) {
  const w = REVIEW_CONFIG.supportWeights;
  let supportVerified = 0, supportRecovered = 0, supportCorrections = 0;
  for (const item of items) {
    if (item.role === 'success') supportVerified++;
    else if (item.role === 'recovery_trigger' || item.role === 'recovery_action') supportRecovered++;
    else if (item.role === 'correction') supportCorrections++;
  }
  const support = supportVerified * w.verified
    + supportRecovered * w.recovered
    + supportCorrections * w.corrections;

  const total = items.length;
  const outcomes = items.map((i) => i.outcome);
  const successCount = outcomes.filter((o) => o === 'success').length;
  const verification = total ? successCount / total : 0;

  const traceIds = new Set(items.map((i) => i.row.trace_id || i.row.conversation_id || i.row.id));
  const generality = traceIds.size > 1 ? 1 : 0.6;

  const outcomeCounts = {};
  for (const o of outcomes) outcomeCounts[o] = (outcomeCounts[o] || 0) + 1;
  const dominant = Math.max(0, ...Object.values(outcomeCounts));
  const reproducibility = total ? dominant / total : 0;

  const newest = items.reduce((m, i) => {
    const t = Date.parse(i.row.created_at);
    return Number.isFinite(t) && t > m ? t : m;
  }, 0);
  const ageDays = newest > 0 ? (Date.now() - newest) / 86400000 : 365;
  const recency = Math.exp(-ageDays / REVIEW_CONFIG.recencyHalfLifeDays);

  const reviewerConfidence = REVIEW_CONFIG.reviewerConfidenceBaseline;
  const qw = REVIEW_CONFIG.qualityWeights;
  const quality = qw.verification * verification
    + qw.generality * generality
    + qw.reproducibility * reproducibility
    + qw.recency * recency
    + qw.reviewerConfidence * reviewerConfidence;
  const penalty = REVIEW_CONFIG.riskPenalty[riskTier] ?? 0;
  const promotionScore = support * quality * (1 - penalty);

  return {
    supportVerified, supportRecovered, supportCorrections, support,
    quality: {
      verification, generality, reproducibility, recency,
      reviewer_confidence: reviewerConfidence, quality,
    },
    promotionScore,
  };
}

function titleFor(kind, items) {
  const first = items[0]?.excerpt || '';
  const tool = items[0]?.payload?.tool ?? items[0]?.payload?.tool_name;
  const short = first.length > 80 ? `${first.slice(0, 80)}…` : first;
  if (kind === 'recovery') return `Recovered after failure${tool ? `: ${tool}` : ''}`;
  if (kind === 'correction') return `Correction: ${short}`;
  return `Procedure${tool ? `: ${tool}` : ''} (${items.length} supporting event${items.length === 1 ? '' : 's'})`;
}

function eligibilityNoteFor(kind, items, scored) {
  const traces = new Set(items.map((i) => i.row.trace_id || i.row.conversation_id || i.row.id)).size;
  return `${scored.supportVerified} verified, ${scored.supportRecovered} recovered, ` +
    `${scored.supportCorrections} corrections across ${traces} trace(s); ` +
    `quality=${scored.quality.quality.toFixed(3)}`;
}

/** Deterministic template draft — always available, never fails. */
function templateDraft(items) {
  const steps = [];
  const excerpts = items.map((i) => i.excerpt).filter(Boolean);
  if (excerpts[0]) steps.push(`Do: ${excerpts[0]}`);
  for (const e of excerpts.slice(1, 4)) steps.push(`Then: ${e}`);
  steps.push('Verify the outcome matches the evidence above before relying on it.');
  return steps.slice(0, 6);
}

/**
 * Aimi's LLM draft. Tries the configured provider runtime; any failure —
 * no provider, no default model, network error, unparseable reply —
 * returns null and the caller falls back to the template. Never throws.
 */
async function draftWithLLM(db, items) {
  try {
    const evidenceBlock = items
      .map((i, n) => `${n + 1}. [${i.role}] ${i.excerpt}`)
      .join('\n')
      .slice(0, 4000);
    if (!evidenceBlock) return null;

    let provider = null;
    let modelId = null;
    try {
      const modelRow = db.prepare('SELECT * FROM llm_models WHERE is_default = 1 LIMIT 1').get();
      if (modelRow) {
        provider = db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(modelRow.provider_id);
        modelId = modelRow.model_id;
      }
    } catch { /* table may not exist on old DBs */ }
    if (!provider || !provider.enabled || !modelId) {
      const providers = db.prepare('SELECT * FROM llm_providers WHERE enabled = 1 ORDER BY created_at ASC').all();
      for (const p of providers) {
        const m = db.prepare('SELECT * FROM llm_models WHERE provider_id = ? ORDER BY model_id ASC LIMIT 1').get(p.id);
        const hasKey = p.api_key && String(p.api_key).length > 10 && !String(p.api_key).includes('*');
        if (m && (hasKey || p.type === 'ollama')) { provider = p; modelId = m.model_id; break; }
      }
    }
    if (!provider || !modelId) return null;

    const { executeChat } = await import('../llm/provider-runtime.mjs');
    const { content } = await executeChat(provider, modelId, [
      {
        role: 'system',
        content: 'You draft plain-language numbered procedures from evidence. '
          + 'Output ONLY numbered steps, one per line. No prose, no preamble, no conclusion.',
      },
      {
        role: 'user',
        content: 'Draft a plain-language numbered procedure from this evidence. '
          + 'No prose outside the steps.\n\nEvidence:\n' + evidenceBlock,
      },
    ], { max_tokens: 512, temperature: 0.2, timeoutMs: 20000 });

    const steps = String(content || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+\s*[.):-]\s+/.test(l))
      .map((l) => l.replace(/^\d+\s*[.):-]\s+/, '').trim())
      .filter(Boolean);
    return steps.length ? steps.slice(0, 12) : null;
  } catch {
    return null;
  }
}

async function draftProcedure(db, items, logger) {
  const llmSteps = await draftWithLLM(db, items);
  if (llmSteps && llmSteps.length) return llmSteps;
  return templateDraft(items);
}

// ─── Job bookkeeping ────────────────────────────────────────────────

function insertJobRow(db, jobId, userId, startedAt) {
  db.prepare(`INSERT INTO learning_review_jobs
    (id, user_id, status, started_at) VALUES (?, ?, 'running', ?)`)
    .run(jobId, userId || '', startedAt);
}

function finishJobRow(db, jobId, status, counts, error) {
  db.prepare(`UPDATE learning_review_jobs SET status = ?, events_scanned = ?,
    candidates_assembled = ?, dead_lettered = ?, budget_used = ?,
    finished_at = ?, error = ? WHERE id = ?`)
    .run(status, counts.eventsScanned, counts.candidatesAssembled,
      counts.deadLettered, counts.budgetUsed,
      new Date().toISOString(), error || null, jobId);
}

function getJobRow(db, jobId) {
  return db.prepare(`SELECT id, status, events_scanned, candidates_assembled,
    dead_lettered, budget_used, started_at, finished_at, error
    FROM learning_review_jobs WHERE id = ?`).get(jobId);
}

function deadLetter(db, eventId, note) {
  db.prepare(`UPDATE learning_events SET review_status = 'dead_lettered', review_note = ?
              WHERE id = ?`).run(String(note || 'unknown error').slice(0, 500), eventId);
}

// ─── Main entry ────────────────────────────────────────────────────

/**
 * Run one review job for a user. Scans pending events newest-first,
 * assembles eligible candidates (budget-capped), dead-letters broken
 * events, and marks everything scanned as reviewed. Never throws.
 *
 * @returns the finished job row { id, status, events_scanned,
 *   candidates_assembled, dead_lettered, budget_used, started_at,
 *   finished_at, error }
 */
export async function runReviewJob({ db, userId, budget, logger } = {}) {
  const log = logger || NULL_LOGGER;
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const failSafe = (message) => ({
    id: jobId, status: 'failed', events_scanned: 0, candidates_assembled: 0,
    dead_lettered: 0, budget_used: 0, started_at: startedAt,
    finished_at: new Date().toISOString(), error: String(message || 'unknown error'),
  });

  if (!db) return failSafe('db is required');
  if (!userId) return failSafe('userId is required (ownership)');

  try {
    insertJobRow(db, jobId, userId, startedAt);
  } catch (err) {
    log.error(`learning review: cannot record job row: ${err.message}`);
    return failSafe(err.message);
  }

  const counts = { eventsScanned: 0, candidatesAssembled: 0, deadLettered: 0, budgetUsed: 0 };
  try {
    const budgetCap = budgetFor(budget);
    const rows = db.prepare(`SELECT rowid, id, user_id, conversation_id, trace_id, type,
        payload, outcome, created_at
      FROM learning_events
      WHERE user_id = ? AND review_status = 'pending'
      ORDER BY created_at DESC, rowid DESC`).all(userId);

    // Per-event classification; broken events are dead-lettered, never fatal.
    const eligible = [];
    for (const row of rows) {
      try {
        const item = classifyEvent(row);
        if (item) eligible.push(item);
      } catch (err) {
        deadLetter(db, row.id, `classify: ${err.message}`);
        counts.deadLettered++;
      }
    }
    counts.eventsScanned = rows.length;

    const groups = groupEvidence(eligible);
    // Newest evidence first so a tight budget favors fresh candidates.
    groups.sort((a, b) => {
      const ta = Math.max(...a.items.map((i) => Date.parse(i.row.created_at) || 0));
      const tb = Math.max(...b.items.map((i) => Date.parse(i.row.created_at) || 0));
      return tb - ta;
    });

    let assembledToday = countCandidatesToday(db, userId);
    for (const group of groups) {
      // Dedupe: never a second open candidate for the same trace. Looks
      // up candidates linked to ANY event from this trace/conversation, so
      // fresh events on an old trace find the existing candidate.
      const existing = findCandidatesByTraceKey(db, userId, group.key);
      let reopenTarget = null;
      let skip = false;
      for (const c of existing) {
        if (c.state === 'rejected') {
          const cooling = c.cooldown_until && Date.parse(c.cooldown_until) > Date.now();
          if (cooling) { skip = true; break; }      // still in cooldown: leave it alone
          reopenTarget = c;                          // cooldown expired: reopen below
        } else {
          skip = true; break;                        // open/promoted/observed/testing: no duplicate
        }
      }
      if (skip) continue;

      // Budget: stop assembling, but scanned events are still marked reviewed.
      if (assembledToday >= budgetCap) break;

      try {
        const evidenceItems = group.items.map((i) => ({
          eventId: i.row.id, role: i.role, weight: i.weight, excerptHash: i.excerptHash,
        }));
        if (reopenTarget) {
          linkEvidence(db, reopenTarget.id, userId, evidenceItems);
          // Refresh stats from ALL linked evidence (old + new), keeping kind.
          const prev = getCandidate(db, reopenTarget.id, userId);
          const allItems = itemsFromRows(getCandidateEventRows(db, reopenTarget.id, userId));
          const fields = await buildFields(db, userId, prev ? prev.kind : group.kind, allItems, log);
          updateCandidateFields(db, reopenTarget.id, userId, fields);
          reopenCandidate(db, reopenTarget.id, userId);
          log.info(`learning review: reopened candidate ${reopenTarget.id} on fresh evidence`);
        } else {
          const fields = await buildFields(db, userId, group.kind, group.items, log);
          // GUARD: HIGH risk candidates are created in state='candidate'
          // and can NEVER be auto-anything. Candidates are review objects,
          // never usable skills — approval only flips a state flag.
          insertCandidate(db, { ...fields, state: 'candidate' }, evidenceItems);
        }
        counts.candidatesAssembled++;
        assembledToday++;
      } catch (err) {
        for (const item of group.items) {
          deadLetter(db, item.row.id, `assemble: ${err.message}`);
          counts.deadLettered++;
        }
        log.error(`learning review: group ${group.key} dead-lettered: ${err.message}`);
      }
    }

    // Mark everything scanned as reviewed (dead-lettered rows keep their status).
    db.prepare(`UPDATE learning_events SET review_status = 'reviewed'
                WHERE user_id = ? AND review_status = 'pending'`).run(userId);

    counts.budgetUsed = Math.min(assembledToday, budgetCap);
    finishJobRow(db, jobId, 'completed', counts, null);
    log.info(`learning review job ${jobId} for ${userId}: ` +
      `${counts.eventsScanned} scanned, ${counts.candidatesAssembled} assembled, ` +
      `${counts.deadLettered} dead-lettered`);
    return getJobRow(db, jobId);
  } catch (err) {
    log.error(`learning review job ${jobId} failed: ${err.message}`);
    try {
      finishJobRow(db, jobId, 'failed', counts, err.message);
      return getJobRow(db, jobId);
    } catch {
      return failSafe(err.message);
    }
  }
}
