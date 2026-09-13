// ── Learning Inbox — Phase 2 candidate review UI ──────────────────────
// Candidate review → promotion → lifecycle. Shadow mode: nothing here
// affects live behavior until Haz approves a candidate.
//
// API contract (backend): /api/learning/candidates?state=review|testing|
// rejected|promoted, /candidates/:id, /candidates/:id/approve,
// /candidates/:id/reject, /review/run, /review/jobs. Bearer from 'cf_token'.
import { useState, useCallback, useEffect } from 'react';
import { NEON, BG } from './theme';
import { cachedFetch, invalidateCache } from './dataCache';
import { usePolling } from './usePolling';
import {
  Inbox, FlaskConical, CheckCircle2, XCircle, Sparkles,
  Pencil, ArrowLeft, RefreshCw, Loader,
  Network, GitMerge, Cpu, ShieldCheck, Play, RotateCcw, FileCode2, Hammer,
  Route, Gauge, Power, Pin, ArchiveRestore,
} from 'lucide-react';

const TABS = [
  { key: 'review', label: 'REVIEW' },
  { key: 'testing', label: 'TESTING' },
  { key: 'rejected', label: 'REJECTED' },
  { key: 'promoted', label: 'PROMOTED' },
  { key: 'clusters', label: 'CLUSTERS' },
  { key: 'compiled', label: 'COMPILED' },
  { key: 'routing', label: 'ROUTING' },
  { key: 'curator', label: 'CURATOR' },
];

// Phase 3 — semantic clustering pipeline steps (approved preview content).
const PIPELINE_STEPS = [
  { n: '1 · Signature', d: "Each candidate's title + draft → text signature" },
  { n: '2 · Embed', d: "MiniLM 384-dim vector, on-device. Lexical fallback if the model can't load" },
  { n: '3 · Cluster', d: 'Cosine similarity ≥ threshold joins a cluster' },
  { n: '4 · Propose', d: 'Merge proposal lands in your inbox. You tap, it merges. Nothing auto-merges' },
];

// Phase 3 — safety rails (approved preview content).
const SAFETY_RAILS = [
  { title: 'Lexical fallback.', body: "If MiniLM can't load (no model, offline box), clustering falls back to token-overlap similarity — cruder, but the pipeline never breaks." },
  { title: 'Legacy patterns, read-only.', body: 'Old threshold-promoted patterns get backfilled into clusters as reference only. They can inform merges but can never trigger one.' },
  { title: 'Merge errors measured first.', body: "The clusterer runs in shadow mode, logging would-be merges. Auto-merge only ever becomes an option after the error rate is measured — and even then, only with your explicit opt-in." },
];

const KIND_STYLE = {
  recovery:  { label: 'RECOVERY',   color: NEON.green },
  procedure: { label: 'PROCEDURE',  color: NEON.cyan },
  correction:{ label: 'CORRECTION', color: NEON.orange },
};

const RISK_STYLE = {
  low:    { label: 'LOW RISK',    color: NEON.green },
  medium: { label: 'MEDIUM RISK', color: NEON.orange },
  high:   { label: 'HIGH RISK',   color: NEON.red },
};

// ════════════════════════════════════════════════════════════════════
// PHASE 4 — SKILL COMPILER (Compiled tab)
// ════════════════════════════════════════════════════════════════════
// Phase 4 — compiler pipeline steps (approved preview content, static).
const COMPILER_PIPELINE = [
  { n: '1 · Spec', d: 'Approved candidate → structured procedural spec (schema-validated, no free prose)' },
  { n: '2 · Compile', d: 'Compiler picks the form: script, hybrid, prompt template, or memory-only' },
  { n: '3 · Test gate', d: 'Generated tests run isolated. Fail = back to the drawing board' },
  { n: '4 · Scan', d: 'Skill-scanner verdict. Blocked = dead end, logged' },
  { n: '5 · Version', d: 'Immutable v1, disabled. You activate — or roll back' },
];

// Phase 4 — safety rails (approved preview content, static).
const COMPILER_SAFETY_RAILS = [
  { title: 'Disabled by default.', body: 'Every generated version ships disabled. Nothing runs until you explicitly activate it.' },
  { title: 'High-risk → Docker only.', body: 'If the compiler emits executable code with elevated capabilities, it only ever executes inside a container — never on the host.' },
  { title: 'Still no live routing.', body: "After Phase 4, Cardinal Frame can produce a tested, reviewable skill — but live requests still don't flow through learned skills. That's Phase 5, and it's your call." },
];

// ════════════════════════════════════════════════════════════════════
// PHASE 5 — RETRIEVAL & SHADOW ROUTING (Routing tab)
// ════════════════════════════════════════════════════════════════════
// Phase 5 — retrieval pipeline steps (approved preview content, static).
const RETRIEVAL_PIPELINE = [
  { n: '1 · Hard filters', d: 'Owner, role, tool access, risk tier, enabled state. Wrong owner or denied tool = removed before ranking. No score can bypass this.' },
  { n: '2 · Rank', d: 'Top-3 metadata by route_score. Full procedure loads only for the winner — progressive disclosure, prompt stays lean.' },
  { n: '3 · Shadow', d: 'Log what would have happened. Execute the normal path. Compare later.' },
];

// Phase 5 — safety rails (approved preview content, static).
const ROUTING_SAFETY_RAILS = [
  { title: 'Shadow first, always.', body: 'The router scores and logs for at least one representative workload window before live routing is even discussable. Thresholds get tuned against false matches, not vibes.' },
  { title: 'Checksums.', body: "The loaded version's hash must match the approved version's hash. Tamper or drift → refused, logged, normal path." },
  { title: 'Progressive disclosure.', body: "Only compact metadata enters the prompt for ranking; the full procedure loads solely for the selected winner. Learned skills don't bloat every request." },
];

// Shadow-decision outcomes → chips. FILTERED_ALL is red: nothing survived
// hard filters; FALLBACK gray: ranked but declined to route.
const DECISION_STYLE = {
  shadow_routed:   { label: 'SHADOW ROUTED', color: NEON.yellow },
  fallback_normal: { label: 'FALLBACK',      color: '#8b94a7' },
  filtered_all:    { label: 'FILTERED ALL',  color: NEON.red },
};

// Kill-switch flags. Env-configured server-side — toggles here are display
// only. Names follow the LEARNING_<flag>_ENABLED pattern (capture confirmed
// as LEARNING_CAPTURE_ENABLED; review/retrieval/curator per backend docs).
const KILL_FLAGS = [
  { key: 'capture',   label: 'capture',   desc: 'record learning events',   env: 'LEARNING_CAPTURE_ENABLED' },
  { key: 'review',    label: 'review',    desc: 'reviewer + candidates',    env: 'LEARNING_REVIEW_ENABLED' },
  { key: 'retrieval', label: 'retrieval', desc: 'shadow routing + scoring', env: 'LEARNING_RETRIEVAL_ENABLED' },
  { key: 'curator',   label: 'curator',   desc: 'lifecycle maintenance passes', env: 'LEARNING_CURATOR_ENABLED' },
];

// Score components the ranking formula can emit (preview order). The API
// currently returns only totals; components are rendered only if present.
const SCORE_COMPONENTS = ['semantic', 'trigger', 'success', 'recency', 'affinity', 'penalty'];

const VERSION_KIND_STYLE = {
  prompt_template: { label: 'PROMPT TEMPLATE', color: NEON.cyan },
  script:          { label: 'SCRIPT',          color: NEON.green },
  hybrid:          { label: 'HYBRID',          color: NEON.purple },
  memory:          { label: 'MEMORY',          color: '#8b94a7' },
};

// Approved-but-inactive renders as DISABLED (amber) per the approved preview.
const VERSION_STATE_STYLE = {
  compiled:    { label: 'COMPILED',    color: NEON.cyan },
  tested:      { label: 'TESTED',      color: NEON.cyan },
  scanned:     { label: 'SCANNED',     color: NEON.cyan },
  approved:    { label: 'DISABLED',    color: NEON.yellow },
  active:      { label: 'ACTIVE',      color: NEON.green },
  rolled_back: { label: 'ROLLED BACK', color: '#8b94a7' },
  rejected:    { label: 'REJECTED',    color: NEON.red },
};

// ════════════════════════════════════════════════════════════════════
// PHASE 6 — CURATOR & LIFECYCLE (Curator tab)
// ════════════════════════════════════════════════════════════════════
// Phase 6 — how a curator run works (approved preview content, static).
const CURATOR_PIPELINE = [
  { n: '1 · Scan', d: 'Deterministic pass over every version: usage, recency, failure rates, references.' },
  { n: '2 · Draft', d: 'Aimi turns raw findings into plain-language recommendations. No structural changes.' },
  { n: '3 · Haz decides', d: 'Approve, dismiss, or pin. Dry-run reports first — prune-only mode comes later, only after two reviewed dry runs.' },
];

// Phase 6 — the maintenance pass rules (approved preview content, static).
const CURATOR_RULES = [
  { cond: 'Unused for 30 days', trans: 'active → stale', safe: '✓ skips pinned, system, referenced, executing' },
  { cond: 'Stale for 90 days, still unreferenced', trans: 'stale → archived', safe: '✓ recoverable — restore any time, nothing deleted' },
  { cond: 'Failure rate ≥ 50% over ≥ 5 runs', trans: 'active → quarantined', safe: "✓ minimum sample size — one bad run can't quarantine a skill" },
  { cond: 'Duplicate cluster detected', trans: 'merge proposal (human review of behavior diff)', safe: '✓ feeds Phase 3 merge flow — Haz approves' },
];

// Recommendation kinds → chips.
const RECOMMEND_KIND_STYLE = {
  stale:      { label: 'STALE',      color: NEON.yellow },
  archive:    { label: 'ARCHIVE',    color: NEON.cyan },
  quarantine: { label: 'QUARANTINE', color: NEON.red },
  merge:      { label: 'MERGE',      color: NEON.purple },
};

// Curator run modes → chips. DRY-RUN is the default and always available;
// PRUNE (dry-run + apply approved actions) unlocks after 2 reviewed dry runs.
const CURATOR_MODE_STYLE = {
  dry_run: { label: 'DRY-RUN', color: NEON.yellow },
  prune:   { label: 'PRUNE',   color: NEON.purple },
};

// Config rows: response key → display label + backing env var. The settings
// panel is read-only: the backend owns these values, Haz edits env + restarts.
const CURATOR_CONFIG_ROWS = [
  { key: 'stale_after_days',       label: 'stale_after_days',       env: 'LEARNING_CURATOR_STALE_DAYS' },
  { key: 'archive_after_days',     label: 'archive_after_days',     env: 'LEARNING_CURATOR_ARCHIVE_DAYS' },
  { key: 'quarantine_failure_rate', label: 'quarantine_failure_rate', env: 'LEARNING_CURATOR_QUARANTINE_RATE' },
  { key: 'min_failure_sample',     label: 'min_failure_sample',     env: 'LEARNING_CURATOR_MIN_SAMPLE' },
  { key: 'interval_hours',         label: 'interval_hours',         env: 'LEARNING_CURATOR_INTERVAL_HOURS' },
];

// Never auto-touched — the curator's protection shield (static content).
const PROTECTION_LIST = [
  'Pinned skills — your explicit "keep this"',
  'Referenced by schedules or chains',
  'Currently executing versions',
  'System skills',
];

function stateChipLabel(state) {
  switch (state) {
    case 'candidate': return 'CANDIDATE · UNTRUSTED';
    case 'testing':   return 'TESTING';
    case 'rejected':  return 'REJECTED';
    case 'promoted':  return 'PROMOTED';
    default:          return String(state || 'UNKNOWN').toUpperCase();
  }
}

function supportScore(c) {
  const v = Number(c?.support_verified ?? 0);
  const r = Number(c?.support_recovered ?? 0);
  const x = Number(c?.support_corrections ?? 0);
  return v + 1.5 * r + 2 * x;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmtDate = (ts) => {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return String(ts); }
};

async function authedFetch(path, options = {}) {
  const token = localStorage.getItem('cf_token');
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

export default function LearningInbox() {
  const [lists, setLists] = useState({ review: [], testing: [], rejected: [], promoted: [] });
  const [tab, setTab] = useState('review');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [detail, setDetail] = useState(null); // { candidate, evidence }
  const [detailLoading, setDetailLoading] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [running, setRunning] = useState(false);
  const [actioning, setActioning] = useState(false); // approve/reject in flight
  const [showEdit, setShowEdit] = useState(false);
  const [editText, setEditText] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  // ── Phase 3: semantic clustering ──
  const [clusters, setClusters] = useState([]);
  const [clustersLoading, setClustersLoading] = useState(false);
  const [clusterError, setClusterError] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [clusterStats, setClusterStats] = useState(null);
  const [clustering, setClustering] = useState(false); // run clustering in flight
  const [openCluster, setOpenCluster] = useState(null);
  const [deciding, setDeciding] = useState(null); // merge proposal id in flight
  const [mergeNotice, setMergeNotice] = useState(null);

  // ── Phase 4: skill compiler ──
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState(null);
  const [openVersion, setOpenVersion] = useState(null);
  const [versionDetails, setVersionDetails] = useState({}); // id -> VersionDetail
  const [detailFetching, setDetailFetching] = useState(null); // version id fetching detail
  const [versionActioning, setVersionActioning] = useState(null); // `${id}:${action}` in flight
  const [versionNotice, setVersionNotice] = useState(null);
  const [showFullArtifact, setShowFullArtifact] = useState({}); // version id -> bool
  const [compiling, setCompiling] = useState(false); // candidate→version compile in flight
  const [compileNotice, setCompileNotice] = useState(null);

  // ── Phase 5: retrieval & shadow routing ──
  const [decisions, setDecisions] = useState([]);
  const [decisionsLoading, setDecisionsLoading] = useState(false);
  const [routingError, setRoutingError] = useState(null);
  const [routingStats, setRoutingStats] = useState(null); // { versions: [], totals: {} }
  const [flags, setFlags] = useState(null); // { capture, review, retrieval, curator }
  const [openDecision, setOpenDecision] = useState(null);
  const [feedbacking, setFeedbacking] = useState(null); // `${decisionId}:${ledger}` in flight
  const [feedbackNotice, setFeedbackNotice] = useState(null);
  const [flagNote, setFlagNote] = useState(null); // flag key whose env note is shown

  // ── Phase 6: curator & lifecycle ──
  const [runs, setRuns] = useState([]); // curator runs, recent first
  const [runsLoading, setRunsLoading] = useState(false);
  const [recs, setRecs] = useState([]); // proposed recommendations
  const [recsLoading, setRecsLoading] = useState(false);
  const [curatorConfig, setCuratorConfig] = useState(null); // config object
  const [curatorError, setCuratorError] = useState(null);
  const [curatorNotice, setCuratorNotice] = useState(null);
  const [curatorRunning, setCuratorRunning] = useState(null); // 'dry_run' | 'prune' | null
  const [reviewingRun, setReviewingRun] = useState(null); // run id in flight
  const [recActioning, setRecActioning] = useState(null); // `${recId}:${action}` in flight
  const [openRec, setOpenRec] = useState(null); // expanded recommendation id
  const [appliedRecs, setAppliedRecs] = useState([]); // recently applied (for restore)

  const refresh = useCallback(async () => {
    try {
      const [review, testing, rejected, promoted, jobsData] = await Promise.all([
        cachedFetch('/api/learning/candidates?state=review'),
        cachedFetch('/api/learning/candidates?state=testing'),
        cachedFetch('/api/learning/candidates?state=rejected'),
        cachedFetch('/api/learning/candidates?state=promoted'),
        cachedFetch('/api/learning/review/jobs'),
      ]);
      setLists({
        review: Array.isArray(review?.candidates) ? review.candidates : [],
        testing: Array.isArray(testing?.candidates) ? testing.candidates : [],
        rejected: Array.isArray(rejected?.candidates) ? rejected.candidates : [],
        promoted: Array.isArray(promoted?.candidates) ? promoted.candidates : [],
      });
      setJobs(Array.isArray(jobsData?.jobs) ? jobsData.jobs : []);
      setLoadError(null);
    } catch (err) {
      console.error('LearningInbox refresh error:', err);
      setLoadError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(refresh, 30000, !detail && !showEdit && !showReject);

  // ── Phase 3: clustering data ──
  const refreshClusters = useCallback(async () => {
    setClustersLoading(true);
    try {
      const [cData, pData] = await Promise.all([
        cachedFetch('/api/learning/clusters'),
        cachedFetch('/api/learning/merge-proposals?state=proposed'),
      ]);
      setClusters(Array.isArray(cData?.clusters) ? cData.clusters : []);
      setProposals(Array.isArray(pData?.proposals) ? pData.proposals : []);
      setClusterError(null);
    } catch (err) {
      console.error('LearningInbox clusters refresh error:', err);
      setClusterError(err.message || 'Failed to load clusters');
    } finally {
      setClustersLoading(false);
    }
  }, []);

  // Fetch clusters when the CLUSTERS tab is selected.
  useEffect(() => {
    if (tab === 'clusters') refreshClusters();
  }, [tab, refreshClusters]);

  usePolling(refreshClusters, 30000, tab === 'clusters' && !detail && deciding === null);

  const handleRunClustering = async () => {
    if (clustering) return;
    setClustering(true);
    try {
      const data = await authedFetch('/api/learning/cluster/run', { method: 'POST' });
      if (data?.stats) setClusterStats(data.stats);
      invalidateCache('/api/learning/clusters');
      invalidateCache('/api/learning/merge-proposals?state=proposed');
      await refreshClusters();
    } catch (err) {
      console.error('LearningInbox run clustering error:', err);
      setClusterError(err.message || 'Clustering run failed');
    } finally {
      setClustering(false);
    }
  };

  const handleProposalDecision = async (proposalId, action) => {
    if (!proposalId || deciding) return;
    setDeciding(proposalId);
    try {
      const data = await authedFetch(`/api/learning/merge-proposals/${proposalId}/${action}`, { method: 'POST' });
      if (action === 'approve') {
        const survivor = data?.survivor || {};
        setMergeNotice(`Merged → "${survivor.title || survivor.id || 'survivor'}" — losers archived, evidence preserved.`);
      } else {
        setMergeNotice('Kept separate — the cluster stays as independent candidates.');
      }
      invalidateCache('/api/learning/clusters');
      invalidateCache('/api/learning/merge-proposals?state=proposed');
      await refreshClusters();
    } catch (err) {
      console.error('LearningInbox merge decision error:', err);
      setClusterError(err.message || 'Merge decision failed');
    } finally {
      setDeciding(null);
    }
  };

  // ── Phase 4: skill compiler data ──
  const refreshVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      const data = await cachedFetch('/api/learning/skill-versions');
      setVersions(Array.isArray(data?.versions) ? data.versions : []);
      setVersionsError(null);
    } catch (err) {
      console.error('LearningInbox versions refresh error:', err);
      setVersionsError(err.message || 'Failed to load versions');
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  // Fetch versions when the COMPILED tab is selected.
  useEffect(() => {
    if (tab === 'compiled') refreshVersions();
  }, [tab, refreshVersions]);

  usePolling(refreshVersions, 30000, tab === 'compiled' && openVersion === null && versionActioning === null);

  // ── Phase 5: routing data (decisions + per-version stats + kill flags) ──
  // Each endpoint degrades independently — a missing backend piece leaves an
  // empty panel instead of failing the whole tab.
  const refreshRouting = useCallback(async () => {
    setDecisionsLoading(true);
    try {
      const [dData, sData, fData] = await Promise.all([
        cachedFetch('/api/learning/routing/decisions').catch(() => null),
        cachedFetch('/api/learning/routing/stats').catch(() => null),
        cachedFetch('/api/learning/retrieval/flags').catch(() => null),
      ]);
      setDecisions(Array.isArray(dData?.decisions) ? dData.decisions : []);
      setRoutingStats(sData || null);
      setFlags(fData?.flags || null);
      if (!dData) setRoutingError('Shadow-decision log unavailable — backend endpoint not responding.');
      else setRoutingError(null);
    } catch (err) {
      console.error('LearningInbox routing refresh error:', err);
      setRoutingError(err.message || 'Failed to load routing data');
    } finally {
      setDecisionsLoading(false);
    }
  }, []);

  // Fetch routing data when the ROUTING tab is selected.
  useEffect(() => {
    if (tab === 'routing') refreshRouting();
  }, [tab, refreshRouting]);

  usePolling(refreshRouting, 30000, tab === 'routing' && openDecision === null && feedbacking === null);

  // ── Phase 6: curator data (runs + proposed recommendations + config) ──
  // Each endpoint degrades independently — a missing backend piece leaves an
  // empty panel instead of failing the whole tab.
  const refreshCurator = useCallback(async () => {
    setRunsLoading(true);
    setRecsLoading(true);
    try {
      const [rData, recData, cData, aData] = await Promise.all([
        cachedFetch('/api/learning/curator/runs').catch(() => null),
        cachedFetch('/api/learning/curator/recommendations?state=proposed').catch(() => null),
        cachedFetch('/api/learning/curator/config').catch(() => null),
        cachedFetch('/api/learning/curator/recommendations?state=applied').catch(() => null),
      ]);
      setRuns(Array.isArray(rData?.runs) ? rData.runs : []);
      setRecs(Array.isArray(recData?.recommendations) ? recData.recommendations : []);
      setCuratorConfig(cData?.config || null);
      setAppliedRecs(Array.isArray(aData?.recommendations) ? aData.recommendations.slice(0, 5) : []);
      if (!rData && !recData) setCuratorError('Curator endpoints unavailable — backend not responding.');
      else setCuratorError(null);
    } catch (err) {
      console.error('LearningInbox curator refresh error:', err);
      setCuratorError(err.message || 'Failed to load curator data');
    } finally {
      setRunsLoading(false);
      setRecsLoading(false);
    }
  }, []);

  const invalidateCurator = () => {
    invalidateCache('/api/learning/curator/runs');
    invalidateCache('/api/learning/curator/recommendations?state=proposed');
    invalidateCache('/api/learning/curator/recommendations?state=applied');
  };

  // Fetch curator data when the CURATOR tab is selected.
  useEffect(() => {
    if (tab === 'curator') refreshCurator();
  }, [tab, refreshCurator]);

  usePolling(refreshCurator, 30000, tab === 'curator' && curatorRunning === null && recActioning === null && reviewingRun === null);

  // Phase 6 — trigger a curator run. The backend drafts recommendations for
  // dry_run; prune applies approved actions and returns 400
  // { error: 'prune_not_eligible', reviewed } until two dry runs are reviewed.
  const handleRunCurator = async (mode) => {
    if (curatorRunning) return;
    setCuratorRunning(mode);
    setCuratorNotice(null);
    try {
      const token = localStorage.getItem('cf_token');
      const res = await fetch('/api/learning/curator/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ mode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.error === 'prune_not_eligible') {
          const reviewed = num(body.reviewed);
          setCuratorNotice(`Prune not eligible yet — ${reviewed}/2 dry runs reviewed. Mark two dry runs reviewed to unlock prune mode.`);
          return;
        }
        throw new Error(body.error || `Request failed: ${res.status}`);
      }
      const run = body.run || {};
      setCuratorNotice(
        mode === 'prune'
          ? `Prune run complete — ${num(run.findings_count)} findings, ${num(run.applied_count)} applied.`
          : `Dry run complete — ${num(run.findings_count)} findings drafted, 0 applied. Review the proposals below.`
      );
      // Refresh everything: runs (new entry), proposed recs (new/ drained),
      // config (prune eligibility may have changed).
      invalidateCurator();
      invalidateCache('/api/learning/curator/runs');
      invalidateCache('/api/learning/curator/config');
      await refreshCurator();
    } catch (err) {
      console.error('LearningInbox curator run error:', err);
      setCuratorError(err.message || 'Curator run failed');
    } finally {
      setCuratorRunning(null);
    }
  };

  // Phase 6 — mark a dry run reviewed. Two reviewed dry runs unlock prune.
  const handleReviewRun = async (runId) => {
    if (!runId || reviewingRun) return;
    setReviewingRun(runId);
    setCuratorNotice(null);
    try {
      await authedFetch(`/api/learning/curator/runs/${runId}/review`, { method: 'POST' });
      setCuratorNotice('Run marked reviewed. Two reviewed dry runs unlock prune mode.');
      invalidateCurator();
      invalidateCache('/api/learning/curator/config');
      await refreshCurator();
    } catch (err) {
      console.error('LearningInbox run review error:', err);
      setCuratorError(err.message || 'Failed to mark run reviewed');
    } finally {
      setReviewingRun(null);
    }
  };

  // Phase 6 — approve / dismiss a recommendation.
  const handleRecAction = async (rec, action) => {
    // action: 'approve' | 'dismiss'
    if (!rec?.id || recActioning) return;
    setRecActioning(`${rec.id}:${action}`);
    setCuratorNotice(null);
    try {
      const data = await authedFetch(`/api/learning/curator/recommendations/${rec.id}/${action}`, { method: 'POST' });
      const updated = data?.recommendation || {};
      setRecs(prev => prev.map(r => (r?.id === rec.id ? { ...r, ...updated, state: updated.state || (action === 'approve' ? 'approved' : 'dismissed') } : r)).filter(r => r?.state === 'proposed'));
      if (action === 'approve') {
        const applied = data?.applied === true;
        setCuratorNotice(applied ? 'Approved and applied — the version transitioned.' : 'Approved — the action is queued to apply.');
      } else {
        setCuratorNotice('Dismissed — the version stays as it is.');
      }
      invalidateCurator();
      invalidateCache('/api/learning/curator/runs');
    } catch (err) {
      console.error('LearningInbox recommendation action error:', err);
      setCuratorError(err.message || 'Recommendation action failed');
    } finally {
      setRecActioning(null);
    }
  };

  // Phase 6 — pin a version instead of acting on the recommendation.
  // Pinned skills are never auto-touched by future curator runs.
  const handlePinVersion = async (rec) => {
    if (!rec?.version_id || recActioning) return;
    setRecActioning(`${rec.id}:pin`);
    setCuratorNotice(null);
    try {
      await authedFetch(`/api/learning/skill-versions/${rec.version_id}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pinned: true }),
      });
      await authedFetch(`/api/learning/curator/recommendations/${rec.id}/dismiss`, { method: 'POST' });
      setRecs(prev => prev.filter(r => r?.id !== rec.id));
      setCuratorNotice(`Pinned "${rec.version_title || rec.version_id}" — the curator will never touch it.`);
      invalidateCurator();
      invalidateCache('/api/learning/skill-versions');
    } catch (err) {
      console.error('LearningInbox pin error:', err);
      setCuratorError(err.message || 'Pin failed');
    } finally {
      setRecActioning(null);
    }
  };

  // Phase 6 — restore an archived version (archive is reversible).
  // Only archive-kind recommendations can be restored.
  const handleRestoreVersion = async (rec) => {
    if (!rec?.version_id || recActioning) return;
    setRecActioning(`${rec.id}:restore`);
    setCuratorNotice(null);
    try {
      const data = await authedFetch(`/api/learning/skill-versions/${rec.version_id}/restore`, { method: 'POST' });
      setCuratorNotice(
        `Restored "${rec.version_title || rec.version_id}" — archived ${num(data?.archived)}, stale ${num(data?.stale)}, quarantined ${num(data?.quarantined)}.`
      );
      setAppliedRecs(prev => prev.filter(r => r?.id !== rec.id));
      invalidateCurator();
      invalidateCache('/api/learning/skill-versions');
    } catch (err) {
      console.error('LearningInbox restore error:', err);
      setCuratorError(err.message || 'Restore failed');
    } finally {
      setRecActioning(null);
    }
  };

  // Phase 6 — one-line evidence summary for a recommendation card.
  // evidence is either a plain string or an object; never crash on shape.
  const evidenceLine = (ev) => {
    if (!ev) return null;
    if (typeof ev === 'string') return ev;
    if (typeof ev === 'object') {
      const parts = [];
      if (ev.unused_days != null) parts.push(`unused ${ev.unused_days} days`);
      if (ev.stale_days != null) parts.push(`stale ${ev.stale_days} days`);
      if (ev.failures != null && ev.samples != null) parts.push(`${ev.failures}/${ev.samples} failures`);
      else if (ev.failure_rate != null) parts.push(`${Math.round(Number(ev.failure_rate) * 100)}% failure rate`);
      if (ev.unreferenced) parts.push('unreferenced');
      if (ev.similar_to) parts.push(`similar to ${ev.similar_to}`);
      if (parts.length) return parts.join(' · ');
      try { return JSON.stringify(ev); } catch { return null; }
    }
    return String(ev);
  };

  // Phase 6 — policy summary for a run card from its policy snapshot.
  const policyLine = (snapshot) => {
    if (!snapshot) return null;
    if (typeof snapshot === 'string') return snapshot;
    if (typeof snapshot === 'object') {
      const p = [];
      if (snapshot.stale_after_days != null) p.push(`stale>${snapshot.stale_after_days}d`);
      if (snapshot.archive_after_days != null) p.push(`archive>${snapshot.archive_after_days}d`);
      if (snapshot.quarantine_failure_rate != null) p.push(`quarantine≥${Math.round(Number(snapshot.quarantine_failure_rate) * 100)}%`);
      if (snapshot.min_failure_sample != null) p.push(`≥${snapshot.min_failure_sample} runs`);
      if (p.length) return `policy: ${p.join(' · ')}`;
      try { return `policy: ${JSON.stringify(snapshot).slice(0, 120)}`; } catch { return null; }
    }
    return null;
  };

  // Phase 5 — feedback on a shadow decision. Route and execution ledgers are
  // separate: route feedback tunes the retriever, execution feedback tunes
  // the skill's own confidence. Never merged.
  const handleFeedback = async (decisionId, ledger, positive) => {
    if (!decisionId || feedbacking) return;
    setFeedbacking(`${decisionId}:${ledger}`);
    setFeedbackNotice(null);
    try {
      await authedFetch(`/api/learning/routing/decisions/${decisionId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ ledger, positive }),
      });
      const kind = ledger === 'route' ? 'Route' : 'Execution';
      setFeedbackNotice(`${kind} feedback recorded: ${positive ? 'positive' : 'negative'}.`);
    } catch (err) {
      console.error('LearningInbox feedback error:', err);
      setFeedbackNotice(`⚠ Feedback failed: ${err.message || 'unknown error'}`);
    } finally {
      setFeedbacking(null);
    }
  };

  const toggleVersion = async (id) => {
    const opening = openVersion !== id;
    setOpenVersion(opening ? id : null);
    if (opening && id && !versionDetails[id]) {
      setDetailFetching(id);
      try {
        const data = await cachedFetch(`/api/learning/skill-versions/${id}`);
        if (data?.version) setVersionDetails(prev => ({ ...prev, [id]: data.version }));
        else setVersionsError('Version detail not found');
      } catch (err) {
        console.error('LearningInbox version detail error:', err);
        setVersionsError(err.message || 'Failed to load version detail');
      } finally {
        setDetailFetching(null);
      }
    }
  };

  const invalidateVersions = () => {
    invalidateCache('/api/learning/skill-versions');
    for (const v of versions) invalidateCache(`/api/learning/skill-versions/${v.id}`);
  };

  const handleVersionAction = async (id, action) => {
    // action: 'approve' | 'activate' | 'rollback'
    if (!id || versionActioning) return;
    setVersionActioning(`${id}:${action}`);
    setVersionNotice(null);
    setVersionsError(null);
    try {
      const data = await authedFetch(`/api/learning/skill-versions/${id}/${action}`, { method: 'POST' });
      if (data?.version) {
        setVersionDetails(prev => (prev[id] ? { ...prev[id], ...data.version } : prev));
        // Backend returns { version, rolled_back: [ids] } on activation.
        const superseded = Array.isArray(data.superseded) ? data.superseded
          : Array.isArray(data.rolled_back) ? data.rolled_back : [];
        if (action === 'activate' && superseded.length > 0) {
          const names = superseded.map(s => String(s).slice(0, 8)).join(', ');
          setVersionNotice(`Activated → now ACTIVE. Superseded: ${names}. Activation and rollback are atomic and audit-logged.`);
        } else if (action === 'activate') {
          setVersionNotice('Activated → now ACTIVE. Activation and rollback are atomic and audit-logged.');
        } else if (action === 'approve') {
          setVersionNotice('Approved — ships DISABLED until you activate it.');
        } else if (action === 'rollback') {
          setVersionNotice('Rolled back. The version stays immutable; it can never be edited, only superseded.');
        } else {
          setVersionNotice(`Action "${action}" complete.`);
        }
      }
      invalidateVersions();
      await refreshVersions();
    } catch (err) {
      console.error('LearningInbox version action error:', err);
      setVersionsError(err.message || `${action} failed`);
    } finally {
      setVersionActioning(null);
    }
  };

  // Phase 4 — compile a promoted candidate into a versioned skill.
  const handleCompile = async () => {
    if (!detail?.candidate?.id || compiling) return;
    setCompiling(true);
    setCompileNotice(null);
    try {
      const data = await authedFetch(`/api/learning/candidates/${detail.candidate.id}/compile`, { method: 'POST' });
      const v = data?.version || {};
      const n = v.version_number != null ? `v${v.version_number}` : 'a new version';
      setCompileNotice(`Compiled → ${n} · state ${(VERSION_STATE_STYLE[v.state] || {}).label || v.state || '—'}. It ships DISABLED — activate it from the COMPILED tab.`);
      invalidateVersions();
      await refreshVersions();
    } catch (err) {
      console.error('LearningInbox compile error:', err);
      setCompileNotice(`⚠ Compile failed: ${err.message || 'unknown error'}`);
    } finally {
      setCompiling(false);
    }
  };

  const invalidateLists = () => {
    for (const s of ['review', 'testing', 'rejected', 'promoted']) {
      invalidateCache(`/api/learning/candidates?state=${s}`);
    }
    invalidateCache('/api/learning/review/jobs');
  };

  const openDetail = async (id) => {
    setDetailLoading(true);
    try {
      const data = await cachedFetch(`/api/learning/candidates/${id}`);
      if (data?.candidate) {
        setDetail({ candidate: data.candidate, evidence: Array.isArray(data.evidence) ? data.evidence : [] });
        window.scrollTo(0, 0);
      } else {
        setLoadError('Candidate not found');
      }
    } catch (err) {
      console.error('LearningInbox detail error:', err);
      setLoadError(err.message || 'Failed to load candidate');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => { setDetail(null); setEditedLocally(false); };

  const handleApprove = async () => {
    if (!detail?.candidate?.id || actioning) return;
    setActioning(true);
    try {
      await authedFetch(`/api/learning/candidates/${detail.candidate.id}/approve`, { method: 'POST' });
      invalidateCache(`/api/learning/candidates/${detail.candidate.id}`);
      invalidateLists();
      await refresh();
      closeDetail();
    } catch (err) {
      console.error('LearningInbox approve error:', err);
      setLoadError(err.message || 'Approve failed');
    } finally {
      setActioning(false);
    }
  };

  const handleReject = async () => {
    if (!detail?.candidate?.id || actioning) return;
    setActioning(true);
    try {
      await authedFetch(`/api/learning/candidates/${detail.candidate.id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: rejectReason.trim() || undefined }),
      });
      setShowReject(false);
      setRejectReason('');
      invalidateCache(`/api/learning/candidates/${detail.candidate.id}`);
      invalidateLists();
      await refresh();
      closeDetail();
    } catch (err) {
      console.error('LearningInbox reject error:', err);
      setLoadError(err.message || 'Reject failed');
    } finally {
      setActioning(false);
    }
  };

  const handleRunReview = async () => {
    if (running) return;
    setRunning(true);
    try {
      const data = await authedFetch('/api/learning/review/run', { method: 'POST' });
      if (data?.job) setJobs(prev => [data.job, ...prev]);
      invalidateLists();
      await refresh();
    } catch (err) {
      console.error('LearningInbox run review error:', err);
      setLoadError(err.message || 'Review run failed');
    } finally {
      setRunning(false);
    }
  };

  const openEdit = () => {
    const draft = detail?.candidate?.draft;
    setEditText(Array.isArray(draft) ? draft.join('\n') : '');
    setShowEdit(true);
  };

  const saveEdit = async () => {
    // Persist the edited draft server-side via PATCH.
    const steps = editText.split('\n').map(s => s.trim()).filter(Boolean);
    try {
      const token = localStorage.getItem('cf_token');
      const res = await fetch(`/api/learning/candidates/${detail.candidate.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ draft: steps }),
      });
      if (res.ok) {
        const data = await res.json();
        setDetail(prev => prev && ({ ...prev, candidate: data.candidate }));
            setShowEdit(false);
        refresh();
      } else {
        alert('Could not save edit: ' + res.status);
      }
    } catch (err) {
      alert('Could not save edit: ' + err.message);
    }
  };

  // ── Stat card (AimiLearn pattern) ──
  const StatCard = ({ icon: Icon, label, value, color, sub }) => (
    <div
      className="flex-1 min-w-[140px] chamfer-sm p-4 flex flex-col gap-2"
      style={{
        background: BG.card,
        border: `1px solid ${color}20`,
        boxShadow: `inset 0 0 30px ${color}05, 0 0 12px ${color}08`,
      }}
    >
      <div className="flex items-center gap-2">
        <Icon size={16} style={{ color, filter: `drop-shadow(0 0 4px ${color}80)` }} />
        <span className="text-[10px] uppercase tracking-wider font-semibold font-hud" style={{ color: '#666' }}>{label}</span>
      </div>
      <span className="text-2xl font-bold font-hud" style={{ color }}>{loading ? '…' : value}</span>
      {sub && <span className="text-[10px]" style={{ color: '#555' }}>{sub}</span>}
    </div>
  );

  // ── Confidence bar (AimiLearn pattern) ──
  const ConfidenceBar = ({ confidence }) => {
    const pct = Math.round(num(confidence) * 100);
    const color = pct >= 70 ? NEON.green : pct >= 40 ? NEON.yellow : NEON.red;
    return (
      <div className="flex items-center gap-2">
        <div className="h-2 flex-1 rounded-full overflow-hidden" style={{ background: `${color}15` }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}` }}
          />
        </div>
        <span className="text-[10px] font-mono w-9 text-right" style={{ color }}>{pct}%</span>
      </div>
    );
  };

  // ── Similarity bar (Phase 3) — same visual pattern as ConfidenceBar,
  //    purple per the clustering preview. similarity 0..1 → percent.
  const SimBar = ({ similarity, label }) => {
    const raw = num(similarity);
    const pct = Math.max(0, Math.min(100, Math.round(raw * 100)));
    const color = NEON.purple;
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-hud shrink-0 w-[104px]" style={{ color: '#555' }}>
          {label || 'sim to centroid'}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden" style={{ background: `${NEON.purple}12` }}>
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}` }}
          />
        </div>
        <span className="text-[10px] font-mono w-9 text-right shrink-0" style={{ color }}>
          {raw.toFixed(2)}
        </span>
      </div>
    );
  };

  const Chip = ({ color, children }) => (
    <span
      className="text-[9px] font-semibold chamfer-sm px-2 py-0.5 font-hud uppercase"
      style={{ background: `${color}10`, color, border: `1px solid ${color}30` }}
    >
      {children}
    </span>
  );

  const CandidateCard = ({ c }) => {
    const kind = KIND_STYLE[c.kind] || { label: String(c.kind || 'UNKNOWN').toUpperCase(), color: '#8b94a7' };
    const risk = RISK_STYLE[c.risk_tier] || RISK_STYLE.low;
    return (
      <button
        onClick={() => openDetail(c.id)}
        className="chamfer-sm p-3 flex flex-col gap-2 text-left w-full transition-all"
        style={{ background: BG.surface, border: `1px solid ${NEON.magenta}10`, cursor: 'pointer' }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = `${NEON.magenta}35`; e.currentTarget.style.background = BG.card; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = `${NEON.magenta}10`; e.currentTarget.style.background = BG.surface; }}
      >
        <span className="text-[15px] font-medium" style={{ color: '#dbe2f1' }}>{c.title || 'Untitled candidate'}</span>
        <div className="flex gap-1.5 flex-wrap">
          <Chip color={kind.color}>{kind.label}</Chip>
          <Chip color={risk.color}>{risk.label}</Chip>
          <Chip color="#aab4cc">{stateChipLabel(c.state)}</Chip>
        </div>
        <ConfidenceBar confidence={c.promotion_score} />
        <div className="flex gap-3 text-[10px] font-hud" style={{ color: '#555' }}>
          <span><span style={{ color: NEON.green }}>✓</span> {num(c.support_verified)} verified</span>
          <span><span style={{ color: NEON.cyan }}>⟲</span> {num(c.support_recovered)} recovered</span>
          <span><span style={{ color: NEON.orange }}>✎</span> {num(c.support_corrections)} corrections</span>
        </div>
      </button>
    );
  };

  // ── Phase 3: cluster card (tap-to-expand) ──
  const ClusterCard = ({ cluster }) => {
    const members = Array.isArray(cluster.members) ? cluster.members : [];
    const memberCount = num(cluster.member_count) || members.length;
    const legacy = Boolean(cluster.is_legacy_readonly);
    const open = openCluster === cluster.id;
    const proposal = proposals.find(p => p && p.cluster_id === cluster.id);
    const support = proposal?.combined_support || {};
    const proposalCount = num(proposal?.from_candidate_ids?.length) || memberCount;

    return (
      <div
        className="chamfer-sm"
        style={{ background: BG.surface, border: `1px solid ${NEON.purple}25` }}
      >
        <button
          onClick={() => setOpenCluster(open ? null : cluster.id)}
          className="p-3 flex flex-col gap-2 text-left w-full"
          style={{ cursor: 'pointer', minHeight: '40px' }}
        >
          <span className="text-[15px] font-medium" style={{ color: '#dbe2f1' }}>
            {cluster.label || 'Unnamed cluster'}
          </span>
          <div className="flex gap-1.5 flex-wrap">
            {legacy ? (
              <Chip color={NEON.yellow}>LEGACY · READ-ONLY</Chip>
            ) : memberCount >= 2 ? (
              <Chip color={NEON.green}>{memberCount} MEMBERS · MERGEABLE</Chip>
            ) : (
              <Chip color="#8b94a7">{memberCount} MEMBER · SINGLETON</Chip>
            )}
            {!legacy && memberCount >= 2 && (
              <Chip color={NEON.green}>AVG SIM {num(cluster.avg_similarity).toFixed(2)}</Chip>
            )}
          </div>
          <span className="text-[10px] font-hud" style={{ color: '#555' }}>
            Tap to {open ? 'collapse ▲' : 'expand ▾'}
          </span>
        </button>

        {open && (
          <div
            className="px-3 pb-3 flex flex-col gap-2"
            style={{ borderTop: `1px solid ${NEON.purple}15`, paddingTop: '12px' }}
          >
            {members.map((m, i) => (
              <div
                key={m?.candidate_id || m?.title || i}
                className="chamfer-sm p-2.5"
                style={{ background: BG.card, border: `1px solid ${NEON.cyan}10` }}
              >
                <div className="text-[13px] mb-1.5" style={{ color: '#dbe2f1' }}>
                  {m?.title || 'Untitled'}
                </div>
                <div className="flex gap-1.5 mb-1.5 flex-wrap">
                  {m?.is_centroid && <Chip color={NEON.cyan}>CENTROID</Chip>}
                  {m?.state && <Chip color="#aab4cc">{stateChipLabel(m.state)}</Chip>}
                </div>
                <SimBar similarity={m?.similarity} label={m?.is_centroid ? 'centroid' : 'sim to centroid'} />
              </div>
            ))}
            {members.length === 0 && (
              <span className="text-[12px]" style={{ color: '#555' }}>No members recorded for this cluster.</span>
            )}

            {proposal && !legacy && (
              <div
                className="chamfer-sm p-3 flex flex-col gap-2"
                style={{ background: `${NEON.green}04`, border: `1px dashed ${NEON.green}60` }}
              >
                <div className="flex items-center gap-1.5 text-[11px] tracking-widest uppercase font-hud font-bold" style={{ color: NEON.green }}>
                  <GitMerge size={13} /> Merge proposal
                </div>
                <p className="text-[12px] m-0" style={{ color: '#8b94a7' }}>
                  Fold <b style={{ color: '#dbe2f1' }}>{proposalCount} candidates → 1</b>.{' '}
                  Support adds up: <b style={{ color: '#dbe2f1' }}>
                    {num(support.verified)} verified + {num(support.recovered)} recovered + {num(support.corrections)} corrections
                  </b> instead of thin entries. Evidence links are preserved on the survivor; the losers are archived, not deleted.
                </p>
                {Array.isArray(proposal.member_titles) && proposal.member_titles.length > 0 && (
                  <ul className="m-0 pl-4 text-[12px] flex flex-col gap-0.5" style={{ color: '#8b94a7' }}>
                    {proposal.member_titles.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleProposalDecision(proposal.id, 'approve')}
                    disabled={deciding !== null}
                    className="flex-1 py-3 chamfer-sm text-[12px] font-hud uppercase font-bold transition-all"
                    style={{
                      background: `${NEON.green}12`, border: `1px solid ${NEON.green}`, color: NEON.green,
                      opacity: deciding ? 0.5 : 1, cursor: deciding ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {deciding === proposal.id ? 'Merging…' : `Merge ${proposalCount} → 1`}
                  </button>
                  <button
                    onClick={() => handleProposalDecision(proposal.id, 'dismiss')}
                    disabled={deciding !== null}
                    className="flex-1 py-3 chamfer-sm text-[12px] font-hud uppercase font-bold transition-all"
                    style={{
                      background: 'transparent', border: '1px solid #555', color: '#8b94a7',
                      opacity: deciding ? 0.5 : 1, cursor: deciding ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {deciding === proposal.id ? 'Working…' : 'Keep separate'}
                  </button>
                </div>
              </div>
            )}

            {legacy && (
              <p className="text-[11px] font-hud m-0" style={{ color: '#666' }}>
                Legacy backfill — reference only. It can inform merges but can never trigger one.
              </p>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Phase 4: version helpers ──
  const shortHash = (h) => {
    const s = String(h || '');
    return s.length > 10 ? `${s.slice(0, 8)}…` : (s || '—');
  };

  const testCountLabel = (ts) => {
    if (!ts) return '—';
    const p = num(ts.passed);
    return `${p}/${p + num(ts.failed)}`;
  };

  const scanChipStyle = (sc) => {
    if (sc?.blocked) return { label: 'BLOCKED', color: NEON.red };
    if (sc?.verdict === 'safe') return { label: 'SAFE', color: NEON.green };
    return { label: 'PENDING', color: '#8b94a7' };
  };

  // Spec field block — the approved preview's .field pattern.
  const SpecField = ({ label, children }) => (
    <div className="chamfer-sm p-2.5" style={{ background: BG.surface, border: `1px solid ${NEON.cyan}10` }}>
      <div className="text-[10px] tracking-widest uppercase font-hud mb-1.5" style={{ color: NEON.cyan }}>
        {label}
      </div>
      <div className="text-[12px]" style={{ color: '#a9c1e8' }}>{children}</div>
    </div>
  );

  // ── Phase 4: version card (tap-to-expand) ──
  const VersionCard = ({ v }) => {
    const kind = VERSION_KIND_STYLE[v.kind] || { label: String(v.kind || 'UNKNOWN').toUpperCase(), color: '#8b94a7' };
    const st = VERSION_STATE_STYLE[v.state] || { label: String(v.state || 'UNKNOWN').toUpperCase(), color: '#8b94a7' };
    const sc = scanChipStyle(v.scanner);
    const open = openVersion === v.id;
    const d = versionDetails[v.id] || {};
    const spec = d.spec && typeof d.spec === 'object' ? d.spec : null;
    const testReport = d.test_report || null;
    const scannerVerdict = d.scanner_verdict || null;
    const history = Array.isArray(d.history) ? d.history : [];
    const artifact = typeof d.artifact === 'string' ? d.artifact : '';
    const fullArtifact = Boolean(showFullArtifact[v.id]);
    const ART_TRUNC = 600;
    const artifactShown = (!fullArtifact && artifact.length > ART_TRUNC)
      ? `${artifact.slice(0, ART_TRUNC)}…`
      : artifact;
    const busy = versionActioning && String(versionActioning).startsWith(`${v.id}:`)
      ? String(versionActioning).split(':')[1]
      : null;
    // Action gating mirrors the backend state machine:
    // approve: scanned → approved · activate: approved → active · rollback: active|approved → rolled_back.
    const canApprove = v.state === 'scanned';
    const canActivate = v.state === 'approved';
    const canRollback = ['active', 'approved'].includes(v.state);
    const tests = Array.isArray(testReport?.tests) ? testReport.tests : [];
    const evidenceCount = Array.isArray(spec?.evidence_event_ids) ? spec.evidence_event_ids.length : 0;

    const actionBtn = (action, label, color, enabled, Icon) => (
      <button
        key={action}
        onClick={() => enabled && handleVersionAction(v.id, action)}
        disabled={!enabled || busy !== null}
        className="flex-1 min-w-[100px] py-3 chamfer-sm text-[11px] tracking-wider font-hud uppercase font-bold transition-all flex items-center justify-center gap-1.5"
        style={{
          background: enabled ? `${color}12` : 'transparent',
          border: `1px solid ${color}`,
          color,
          opacity: !enabled || busy !== null ? 0.4 : 1,
          cursor: !enabled || busy !== null ? 'not-allowed' : 'pointer',
        }}
      >
        {busy === action ? <Loader size={13} className="animate-spin" /> : <Icon size={13} />}
        {busy === action ? 'Working…' : label}
      </button>
    );

    return (
      <div
        className="chamfer-sm"
        style={{ background: BG.surface, border: `1px solid ${NEON.cyan}20` }}
      >
        <button
          onClick={() => toggleVersion(v.id)}
          className="p-3 flex flex-col gap-2 text-left w-full"
          style={{ cursor: 'pointer', minHeight: '40px' }}
        >
          <span className="text-[15px] font-medium" style={{ color: '#dbe2f1' }}>
            {v.candidate_title || 'Untitled version'}
            {v.version_number != null && <span style={{ color: '#555' }}> · v{v.version_number}</span>}
          </span>
          <div className="flex gap-1.5 flex-wrap items-center">
            <Chip color={kind.color}>KIND · {kind.label}</Chip>
            <Chip color={st.color}>{st.label}</Chip>
            <Chip color={sc.color}>SCAN · {sc.label}</Chip>
            {Boolean(v.requires_docker) && <Chip color={NEON.yellow}>DOCKER ONLY</Chip>}
          </div>
          <div className="flex gap-3 text-[10px] font-hud flex-wrap" style={{ color: '#555' }}>
            <span>sha <span style={{ color: '#8b94a7' }}>{shortHash(v.content_hash)}</span></span>
            <span>tests <span style={{ color: v.test_summary ? NEON.green : '#8b94a7' }}>{testCountLabel(v.test_summary)}</span></span>
            <span>created <span style={{ color: '#8b94a7' }}>{fmtDate(v.created_at)}</span></span>
          </div>
          <span className="text-[10px] font-hud" style={{ color: '#555' }}>
            Tap to {open ? 'collapse ▲' : 'expand ▾'}
          </span>
        </button>

        {open && (
          <div
            className="px-3 pb-3 flex flex-col gap-2.5"
            style={{ borderTop: `1px solid ${NEON.cyan}15`, paddingTop: '12px' }}
          >
            {detailFetching === v.id && !spec && !artifact && tests.length === 0 && (
              <div className="flex items-center gap-2 py-3 text-[12px] font-hud" style={{ color: '#555' }}>
                <Loader size={14} className="animate-spin" /> Loading version detail…
              </div>
            )}

            <p className="text-[11px] font-hud m-0" style={{ color: '#666' }}>
              Versions are immutable — v{v.version_number ?? '—'} can never be edited, only superseded.
              Activation and rollback are atomic and audit-logged.
            </p>

            {/* Compiler rationale */}
            {v.rationale && (
              <div
                className="chamfer-sm p-3 text-[12px]"
                style={{ background: `${NEON.cyan}04`, border: `1px dashed ${NEON.cyan}60`, color: '#8b94a7' }}
              >
                <b style={{ color: NEON.cyan }}>Compiler decision: {kind.label.toLowerCase()}.</b>{' '}
                {v.rationale}
              </div>
            )}

            {/* Procedural spec */}
            {spec ? (
              <div className="flex flex-col gap-2">
                <div className="text-[10px] tracking-widest uppercase font-hud font-bold" style={{ color: NEON.purple }}>
                  ◇ Procedural spec
                </div>
                {spec.problem_signature && (
                  <SpecField label="problem_signature">{spec.problem_signature}</SpecField>
                )}
                {Array.isArray(spec.preconditions) && spec.preconditions.length > 0 && (
                  <SpecField label="preconditions">
                    <ul className="m-0 pl-4 flex flex-col gap-0.5">
                      {spec.preconditions.map((p, i) => <li key={i}>{p}</li>)}
                    </ul>
                  </SpecField>
                )}
                {Array.isArray(spec.procedure) && spec.procedure.length > 0 && (
                  <SpecField label="procedure">
                    <ol className="m-0 pl-5 flex flex-col gap-1">
                      {spec.procedure.map((s, i) => (
                        <li key={i}>
                          {typeof s === 'string' ? s : (
                            <>
                              {s.step != null && <b style={{ color: '#dbe2f1' }}>{s.step}. </b>}
                              {s.action || ''}
                              {s.why && <span style={{ color: '#666' }}> — <i>why: {s.why}</i></span>}
                            </>
                          )}
                        </li>
                      ))}
                    </ol>
                  </SpecField>
                )}
                {Array.isArray(spec.verification) && spec.verification.length > 0 && (
                  <SpecField label="verification">
                    <ul className="m-0 pl-4 flex flex-col gap-0.5">
                      {spec.verification.map((t, i) => <li key={i}><span style={{ color: NEON.green }}>✓</span> {t}</li>)}
                    </ul>
                  </SpecField>
                )}
                {Array.isArray(spec.failure_modes) && spec.failure_modes.length > 0 && (
                  <SpecField label="failure_modes">
                    <ul className="m-0 pl-4 flex flex-col gap-0.5">
                      {spec.failure_modes.map((f, i) => (
                        <li key={i}>
                          {typeof f === 'string' ? f : (
                            <><span style={{ color: '#dbe2f1' }}>{f.symptom}</span> <span style={{ color: '#666' }}>→</span> {f.recovery}</>
                          )}
                        </li>
                      ))}
                    </ul>
                  </SpecField>
                )}
                {Array.isArray(spec.do_not_use_when) && spec.do_not_use_when.length > 0 && (
                  <SpecField label="do_not_use_when">
                    <ul className="m-0 pl-4 flex flex-col gap-0.5">
                      {spec.do_not_use_when.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </SpecField>
                )}
                <SpecField label="evidence">
                  {evidenceCount} event{evidenceCount === 1 ? '' : 's'} linked
                  {spec.confidence != null && (
                    <div className="mt-2"><ConfidenceBar confidence={spec.confidence} /></div>
                  )}
                </SpecField>
              </div>
            ) : (
              detailFetching !== v.id && (
                <span className="text-[12px]" style={{ color: '#555' }}>Spec not available for this version.</span>
              )
            )}

            {/* Artifact */}
            {artifact && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[10px] tracking-widest uppercase font-hud font-bold" style={{ color: NEON.cyan }}>
                  <FileCode2 size={12} /> Artifact
                </div>
                <pre
                  className="chamfer-sm p-3 m-0 text-[11px] font-hud whitespace-pre-wrap break-words overflow-hidden"
                  style={{ background: BG.card, border: `1px solid ${NEON.cyan}15`, color: '#a9c1e8', maxHeight: fullArtifact ? 'none' : 220 }}
                >
                  {artifactShown}
                </pre>
                {artifact.length > ART_TRUNC && (
                  <button
                    onClick={() => setShowFullArtifact(prev => ({ ...prev, [v.id]: !fullArtifact }))}
                    className="self-start text-[11px] font-hud"
                    style={{ color: NEON.cyan, cursor: 'pointer', minHeight: '40px' }}
                  >
                    {fullArtifact ? '▲ show less' : `▾ show more (${artifact.length} chars)`}
                  </button>
                )}
              </div>
            )}

            {/* Test gate */}
            {(tests.length > 0 || testReport || v.test_summary) && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-[10px] tracking-widest uppercase font-hud font-bold" style={{ color: NEON.green }}>
                  <Hammer size={12} /> Test gate · {testReport ? `${num(testReport.passed)}/${num(testReport.passed) + num(testReport.failed)}` : testCountLabel(v.test_summary)} pass
                </div>
                {tests.map((t, i) => {
                  const pass = t.status === 'pass';
                  return (
                    <div key={i} className="flex flex-col gap-0.5">
                      <div
                        className="chamfer-sm px-3 py-2.5 flex items-center gap-2.5"
                        style={{
                          background: BG.surface,
                          border: `1px solid ${pass ? `${NEON.green}40` : `${NEON.red}40`}`,
                        }}
                      >
                        <span
                          style={{
                            width: 10, height: 10, flexShrink: 0,
                            background: pass ? NEON.green : NEON.red,
                            boxShadow: `0 0 8px ${pass ? NEON.green : NEON.red}80`,
                          }}
                        />
                        <span className="flex-1 text-[12px]" style={{ color: '#a9c1e8' }}>{t.name || `test ${i + 1}`}</span>
                        <span className="text-[10px] font-hud font-bold" style={{ color: pass ? NEON.green : NEON.red }}>
                          {String(t.status || '—').toUpperCase()}
                        </span>
                      </div>
                      {t.detail && <div className="text-[11px] font-hud pl-7" style={{ color: '#555' }}>{t.detail}</div>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Scanner verdict */}
            {(scannerVerdict || v.scanner) && (
              <div
                className="chamfer-sm p-3"
                style={{ background: BG.surface, border: `1px solid ${sc.color}40` }}
              >
                <div className="flex items-center gap-1.5 text-[10px] tracking-widest uppercase font-hud font-bold mb-1.5" style={{ color: sc.color }}>
                  <ShieldCheck size={12} /> Scanner verdict · {sc.label}
                </div>
                {(() => {
                  const det = scannerVerdict?.details ?? scannerVerdict?.detail ?? scannerVerdict?.summary;
                  if (!det) return null;
                  const text = typeof det === 'string' ? det : JSON.stringify(det, null, 2);
                  return <p className="text-[12px] m-0 font-hud whitespace-pre-wrap" style={{ color: '#8b94a7' }}>{text}</p>;
                })()}
                {scannerVerdict?.verdict && scannerVerdict.verdict !== 'safe' && (
                  <div className="text-[11px] font-hud mt-1" style={{ color: '#555' }}>
                    verdict: {String(scannerVerdict.verdict)}
                  </div>
                )}
              </div>
            )}

            {/* History timeline */}
            {history.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="text-[10px] tracking-widest uppercase font-hud font-bold" style={{ color: '#8b94a7' }}>
                  ◇ Version history
                </div>
                <div className="flex flex-col gap-1.5">
                  {history.map((h, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] font-hud">
                      <span style={{ width: 8, height: 8, background: NEON.cyan, flexShrink: 0 }} />
                      <span style={{ color: '#a9c1e8' }}>{h.action || '—'}</span>
                      <span style={{ color: '#555' }}>· {h.actor || '—'}</span>
                      <span className="ml-auto shrink-0" style={{ color: '#555' }}>{fmtDate(h.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Admin actions */}
            <div className="flex flex-col gap-1.5">
              <div className="text-[10px] tracking-widest uppercase font-hud font-bold" style={{ color: NEON.yellow }}>
                ◇ Admin actions
              </div>
              <div className="flex gap-2 flex-wrap">
                {actionBtn('approve', 'Approve', NEON.yellow, canApprove, ShieldCheck)}
                {actionBtn('activate', 'Activate', NEON.green, canActivate, Play)}
                {actionBtn('rollback', 'Rollback', NEON.red, canRollback, RotateCcw)}
              </div>
              <p className="text-[10px] m-0" style={{ color: '#555' }}>
                Admin-gated server-side. Approve ships the version DISABLED; activate makes it live; rollback pulls it back.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ══════════════════════════════════════════════════════════════
  // PHASE 5 — ROUTING TAB COMPONENTS
  // ══════════════════════════════════════════════════════════════

  // Phase 5: score bar (cyan) — same visual pattern as SimBar. value 0..1.
  const ScoreBar = ({ label, value }) => {
    const v = Number(value);
    const finite = Number.isFinite(v);
    const pct = finite ? Math.max(0, Math.min(100, Math.round(v * 100))) : 0;
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-hud shrink-0 w-[104px]" style={{ color: '#555' }}>
          {label}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden" style={{ background: `${NEON.cyan}12` }}>
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${pct}%`, background: NEON.cyan, boxShadow: `0 0 6px ${NEON.cyan}` }}
          />
        </div>
        <span className="text-[10px] font-mono w-9 text-right shrink-0" style={{ color: NEON.cyan }}>
          {finite ? v.toFixed(2) : '—'}
        </span>
      </div>
    );
  };

  // Phase 5: shadow-routing decision card (tap-to-expand).
  // The API returns totals (winner/runner-up/margin); per-component scores
  // are rendered only if the response actually includes them — never invented.
  const DecisionCard = ({ d }) => {
    if (!d || typeof d !== 'object') return null;
    const open = openDecision === d.id;
    const style = DECISION_STYLE[d.decision]
      || { label: String(d.decision || 'UNKNOWN').toUpperCase(), color: '#8b94a7' };
    const excerpt = d.request_excerpt || 'No request excerpt recorded.';
    const ws = Number(d.winner_score);
    const rs = Number(d.runner_up_score);
    let margin = Number(d.margin);
    if (!Number.isFinite(margin) && Number.isFinite(ws) && Number.isFinite(rs)) margin = ws - rs;
    const comps = (d.score_components && typeof d.score_components === 'object') ? d.score_components
      : (d.components && typeof d.components === 'object') ? d.components : null;
    const hasComps = comps && SCORE_COMPONENTS.some(k => comps[k] != null);
    const kind = VERSION_KIND_STYLE[d.winner_kind] || null;
    const busy = feedbacking && String(feedbacking).startsWith(`${d.id}:`)
      ? String(feedbacking).split(':')[1]
      : null;

    const fbBtn = (ledger, positive, label, color) => (
      <button
        key={`${ledger}-${positive}`}
        onClick={() => handleFeedback(d.id, ledger, positive)}
        disabled={busy !== null}
        className="flex-1 min-w-[100px] py-3 chamfer-sm text-[11px] tracking-wider font-hud uppercase font-bold transition-all"
        style={{
          background: `${color}10`,
          border: `1px solid ${color}`,
          color,
          opacity: busy !== null ? 0.4 : 1,
          cursor: busy !== null ? 'not-allowed' : 'pointer',
        }}
      >
        {busy === ledger ? <Loader size={12} className="animate-spin inline" /> : null}
        {' '}{busy === ledger ? 'Sending…' : label}
      </button>
    );

    return (
      <div
        className="chamfer-sm"
        style={{ background: BG.surface, border: `1px solid ${NEON.yellow}25` }}
      >
        <button
          onClick={() => setOpenDecision(open ? null : d.id)}
          className="p-3 flex flex-col gap-2 text-left w-full"
          style={{ cursor: 'pointer', minHeight: '40px' }}
        >
          <span className="text-[13px] italic" style={{ color: '#a9c1e8' }}>
            “{excerpt}”
          </span>
          <div className="flex gap-1.5 flex-wrap items-center">
            <Chip color={style.color}>{style.label}</Chip>
            {kind && <Chip color={kind.color}>KIND · {kind.label}</Chip>}
            <span className="text-[10px] font-hud ml-auto" style={{ color: '#555' }}>
              {fmtDate(d.created_at)}
            </span>
          </div>
          <div className="text-[13px]" style={{ color: '#dbe2f1' }}>
            Winner: <b style={{ color: NEON.cyan }}>{d.winner_title || '—'}</b>{' '}
            <span className="font-mono text-[12px]" style={{ color: NEON.cyan }}>
              {Number.isFinite(ws) ? ws.toFixed(2) : '—'}
            </span>
            <span className="text-[11px]" style={{ color: '#555' }}>
              {' '}· runner-up {Number.isFinite(rs) ? rs.toFixed(2) : '—'}
              {' '}· margin {Number.isFinite(margin) ? margin.toFixed(2) : '—'}
            </span>
          </div>
          <span className="text-[10px] font-hud" style={{ color: '#555' }}>
            Tap to {open ? 'collapse ▲' : 'expand ▾'}
          </span>
        </button>

        {open && (
          <div
            className="px-3 pb-3 flex flex-col gap-2.5"
            style={{ borderTop: `1px solid ${NEON.yellow}15`, paddingTop: '12px' }}
          >
            {d.decision === 'fallback_normal' && d.fallback_reason && (
              <div
                className="chamfer-sm p-3 text-[12px]"
                style={{ background: `${NEON.yellow}05`, border: `1px dashed ${NEON.yellow}50`, color: '#8b94a7' }}
              >
                <b style={{ color: NEON.yellow }}>Fallback reason:</b> {d.fallback_reason}
              </div>
            )}
            {d.decision === 'filtered_all' && (
              <p className="text-[12px] m-0" style={{ color: '#8b94a7' }}>
                Every candidate was removed by hard filters before ranking — the normal agent path ran instead.
              </p>
            )}

            <div className="text-[10px] tracking-widest uppercase font-hud font-bold" style={{ color: NEON.cyan }}>
              ◇ Score breakdown
            </div>
            {Number.isFinite(ws) && <ScoreBar label="winner" value={ws} />}
            {Number.isFinite(rs) && <ScoreBar label="runner-up" value={rs} />}
            {hasComps ? (
              <div className="flex flex-col gap-1.5">
                {SCORE_COMPONENTS.map(k => comps[k] != null && (
                  <ScoreBar key={k} label={k} value={comps[k]} />
                ))}
              </div>
            ) : (
              <p className="text-[11px] m-0 font-hud" style={{ color: '#555' }}>
                Per-component scores (semantic / trigger / success / recency / affinity / penalty) come from
                the ranking formula and aren't included in this response — totals only.
              </p>
            )}

            <div className="text-[10px] tracking-widest uppercase font-hud font-bold mt-1" style={{ color: NEON.purple }}>
              ◇ Feedback — two ledgers
            </div>
            <div className="flex flex-col gap-2">
              <div>
                <div className="text-[11px] font-hud mb-1.5" style={{ color: NEON.cyan }}>
                  ROUTE · did the retriever pick the right skill?
                </div>
                <div className="flex gap-2">
                  {fbBtn('route', true, '✓ Helpful pick', NEON.green)}
                  {fbBtn('route', false, '✗ Wrong pick', NEON.red)}
                </div>
              </div>
              <div>
                <div className="text-[11px] font-hud mb-1.5" style={{ color: NEON.purple }}>
                  EXECUTION · did the skill itself work?
                </div>
                <div className="flex gap-2">
                  {fbBtn('execution', true, '✓ Worked', NEON.green)}
                  {fbBtn('execution', false, '✗ Broke', NEON.red)}
                </div>
              </div>
            </div>
            <p className="text-[10px] m-0" style={{ color: '#555' }}>
              Route feedback tunes the retriever only; execution feedback tunes the skill's confidence only.
              A bad pick must not poison a good skill's record.
            </p>
          </div>
        )}
      </div>
    );
  };

  // Phase 5: display-only kill-switch toggle visual.
  const FlagToggle = ({ on }) => (
    <div
      aria-hidden
      style={{
        width: 44, height: 24, flexShrink: 0, position: 'relative',
        background: on ? `${NEON.green}25` : 'rgba(139,148,167,.15)',
        border: `1px solid ${on ? NEON.green : '#555'}`,
      }}
    >
      <div
        style={{
          position: 'absolute', top: 2, width: 18, height: 18,
          ...(on ? { right: 2 } : { left: 2 }),
          background: on ? NEON.green : '#555',
          boxShadow: on ? `0 0 6px ${NEON.green}` : 'none',
        }}
      />
    </div>
  );

  const fmtPct = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—';
  };

  const fmt2 = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : '—';
  };

  // ── Phase 5: the whole Routing tab ──
  const RoutingTab = () => {
    const totals = routingStats?.totals || {};
    const vstats = Array.isArray(routingStats?.versions) ? routingStats.versions : [];

    return (
      <>
        {/* ══ PHASE 5: RETRIEVAL & SHADOW ROUTING ══ */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h2
              className="flex items-center gap-2 text-lg font-bold tracking-wider font-hud"
              style={{ color: NEON.cyan, filter: `drop-shadow(0 0 8px ${NEON.cyan}60)` }}
            >
              ◈ Retrieval & shadow routing
            </h2>
            <p className="text-[11px] mt-1" style={{ color: '#555' }}>
              Phase 5 — learned skills meet live requests (carefully): score, don't steer
            </p>
            <div className="flex gap-2 mt-2.5 flex-wrap">
              <span
                className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                style={{ background: `${NEON.yellow}10`, color: NEON.yellow, border: `1px solid ${NEON.yellow}40` }}
              >
                ◉ shadow mode first
              </span>
              <span
                className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                style={{ background: `${NEON.cyan}10`, color: NEON.cyan, border: `1px solid ${NEON.cyan}35` }}
              >
                scores, doesn't steer — yet
              </span>
            </div>
          </div>
          <button
            onClick={refreshRouting}
            disabled={decisionsLoading}
            className="flex items-center gap-2 px-4 py-2 chamfer-sm text-[11px] font-bold tracking-wide font-hud uppercase transition-all"
            style={{
              background: `${NEON.yellow}12`,
              border: `1px solid ${NEON.yellow}40`,
              color: NEON.yellow,
              opacity: decisionsLoading ? 0.5 : 1,
              cursor: decisionsLoading ? 'not-allowed' : 'pointer',
              boxShadow: `0 0 12px ${NEON.yellow}20`,
              minHeight: '40px',
            }}
          >
            {decisionsLoading ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {decisionsLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {routingError && (
          <div
            className="chamfer-sm px-4 py-3 text-[12px] font-hud"
            style={{ background: `${NEON.red}08`, border: `1px solid ${NEON.red}30`, color: NEON.red }}
          >
            ⚠ {routingError}
          </div>
        )}

        {feedbackNotice && (
          <div
            className="chamfer-sm px-4 py-3 text-[12px] font-hud"
            style={
              feedbackNotice.startsWith('⚠')
                ? { background: `${NEON.red}08`, border: `1px solid ${NEON.red}30`, color: NEON.red }
                : { background: `${NEON.green}06`, border: `1px solid ${NEON.green}40`, color: NEON.green }
            }
          >
            {feedbackNotice}
          </div>
        )}

        {/* Two-stage retrieval pipeline (static, approved preview content) */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.cyan}18` }}
        >
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${NEON.cyan}12` }}>
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.cyan }}>
              ◇ Two-stage retrieval
            </span>
          </div>
          <div className="p-3 flex flex-wrap items-stretch gap-1.5">
            {RETRIEVAL_PIPELINE.map((s, i) => (
              <div key={s.n} className="flex items-stretch gap-1.5 flex-1 min-w-[130px]">
                <div
                  className="chamfer-sm p-2.5 flex-1"
                  style={{ background: BG.surface, border: `1px solid ${NEON.cyan}15` }}
                >
                  <div className="text-[12px] font-bold font-hud" style={{ color: NEON.cyan }}>{s.n}</div>
                  <div className="text-[10px] mt-1" style={{ color: '#8b94a7' }}>{s.d}</div>
                </div>
                {i < RETRIEVAL_PIPELINE.length - 1 && (
                  <span className="self-center shrink-0" style={{ color: NEON.cyan }}>→</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Shadow decision log */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.yellow}20` }}
        >
          <div
            className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: `1px solid ${NEON.yellow}12` }}
          >
            <Route size={13} style={{ color: NEON.yellow }} />
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.yellow }}>
              ◇ Shadow decision log
            </span>
            <span
              className="ml-auto text-[10px] font-hud px-2 py-0.5"
              style={{ background: `${NEON.yellow}12`, color: NEON.yellow }}
            >
              {decisions.length} decisions
            </span>
          </div>
          <div className="p-3 flex flex-col gap-2">
            {decisionsLoading && decisions.length === 0 && (
              <div className="flex items-center justify-center py-10 gap-2 text-[12px] font-hud" style={{ color: '#555' }}>
                <Loader size={16} className="animate-spin" /> Loading shadow decisions…
              </div>
            )}
            {!decisionsLoading && decisions.length === 0 && (
              <div className="text-center py-10 text-[11px] font-hud" style={{ color: '#444' }}>
                <Route size={20} className="mx-auto mb-2" style={{ color: '#333' }} />
                No shadow decisions logged yet — they appear once the router scores live requests.
              </div>
            )}
            {decisions.map((d, di) => <DecisionCard key={d?.id || `decision-${di}`} d={d} />)}
          </div>
        </div>

        {/* Outcome attribution (static, approved preview content) */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.purple}20` }}
        >
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${NEON.purple}12` }}>
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.purple }}>
              ◇ Outcome attribution · two ledgers
            </span>
          </div>
          <div className="flex flex-col gap-2 p-3 md:flex-row">
            <div className="chamfer-sm p-3 flex-1" style={{ background: BG.surface, border: `1px solid ${NEON.cyan}12` }}>
              <div className="text-[10px] tracking-widest uppercase font-hud font-bold mb-1.5" style={{ color: NEON.cyan }}>
                Route feedback
              </div>
              <ul className="m-0 pl-4 text-[11px] flex flex-col gap-1" style={{ color: '#8b94a7' }}>
                <li>Did the retriever pick the right skill?</li>
                <li>Updates routing stats only</li>
              </ul>
            </div>
            <div className="chamfer-sm p-3 flex-1" style={{ background: BG.surface, border: `1px solid ${NEON.purple}12` }}>
              <div className="text-[10px] tracking-widest uppercase font-hud font-bold mb-1.5" style={{ color: NEON.purple }}>
                Execution feedback
              </div>
              <ul className="m-0 pl-4 text-[11px] flex flex-col gap-1" style={{ color: '#8b94a7' }}>
                <li>Did the skill itself work?</li>
                <li>Updates execution confidence only</li>
              </ul>
            </div>
          </div>
          <p className="text-[11px] font-hud px-3 pb-3 m-0" style={{ color: '#555' }}>
            A bad pick must not poison a good skill's record, and a good pick must not excuse a bad execution.
            The two ledgers stay separate — otherwise one failure corrupts two different models.
          </p>
        </div>

        {/* Per-version routing stats */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.green}20` }}
        >
          <div
            className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: `1px solid ${NEON.green}12` }}
          >
            <Gauge size={13} style={{ color: NEON.green }} />
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.green }}>
              ◇ Routing stats by version
            </span>
          </div>
          <div className="p-3 flex flex-col gap-2">
            <div
              className="chamfer-sm p-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] font-hud"
              style={{ background: BG.surface, border: `1px dashed ${NEON.green}60`, color: '#8b94a7' }}
            >
              <span>total decisions <b style={{ color: NEON.green }}>{num(totals.total_decisions)}</b></span>
              <span>fallback rate <b style={{ color: NEON.green }}>{fmtPct(totals.fallback_rate)}</b></span>
              <span>avg margin <b style={{ color: NEON.green }}>{fmt2(totals.avg_margin)}</b></span>
            </div>
            {vstats.length === 0 && (
              <div className="text-center py-8 text-[11px] font-hud" style={{ color: '#444' }}>
                No per-version stats yet — stats accumulate as shadow decisions land.
              </div>
            )}
            {vstats.map((vs, vi) => (
              <div
                key={vs?.version_id || `vstat-${vi}`}
                className="chamfer-sm p-3 flex flex-col gap-1.5"
                style={{ background: BG.surface, border: `1px solid ${NEON.green}12` }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px]" style={{ color: '#dbe2f1' }}>
                    {vs?.title || `version ${String(vs?.version_id || '').slice(0, 8)}`}
                  </span>
                  <span className="text-[10px] font-hud ml-auto shrink-0" style={{ color: '#555' }}>
                    {String(vs?.version_id || '').slice(0, 8)}
                  </span>
                </div>
                <ConfidenceBar confidence={vs?.success_rate} />
                <div className="flex gap-3 text-[10px] font-hud flex-wrap" style={{ color: '#555' }}>
                  <span>routed <b style={{ color: '#8b94a7' }}>{num(vs?.routed_count)}</b></span>
                  <span><span style={{ color: NEON.green }}>✓</span> success <b style={{ color: '#8b94a7' }}>{num(vs?.success_count)}</b></span>
                  <span><span style={{ color: NEON.red }}>✗</span> failure <b style={{ color: '#8b94a7' }}>{num(vs?.failure_count)}</b></span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Kill switches */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.red}20` }}
        >
          <div
            className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: `1px solid ${NEON.red}12` }}
          >
            <Power size={13} style={{ color: NEON.red }} />
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.red }}>
              ◇ Kill switches
            </span>
            <span
              className="ml-auto text-[10px] font-hud px-2 py-0.5"
              style={{ background: `${NEON.red}12`, color: NEON.red }}
            >
              independent flags
            </span>
          </div>
          <div className="p-3 flex flex-col gap-2">
            {KILL_FLAGS.map(f => {
              const on = Boolean(flags?.[f.key]);
              const noted = flagNote === f.key;
              return (
                <div
                  key={f.key}
                  className="chamfer-sm"
                  style={{ background: BG.surface, border: `1px solid ${NEON.cyan}12` }}
                >
                  <button
                    onClick={() => setFlagNote(noted ? null : f.key)}
                    className="w-full flex items-center gap-2.5 p-3 text-left"
                    style={{ cursor: 'pointer', minHeight: '40px' }}
                  >
                    <span className="flex-1">
                      <span className="text-[13px]" style={{ color: '#dbe2f1' }}>{f.label}</span>
                      <span className="block text-[10px]" style={{ color: '#555' }}>{f.desc}</span>
                    </span>
                    <FlagToggle on={on} />
                  </button>
                  {noted && (
                    <div className="px-3 pb-3">
                      <div
                        className="chamfer-sm p-2.5 text-[11px] font-hud"
                        style={{ background: `${NEON.yellow}06`, border: `1px dashed ${NEON.yellow}50`, color: '#8b94a7' }}
                      >
                        Env-configured: <b style={{ color: NEON.yellow }}>{f.env}</b> — restart to change.
                        This toggle is display-only; tapping never flips it.
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="px-3 pb-3">
            <div
              className="chamfer-sm p-3 text-[12px]"
              style={{ background: BG.surface, border: `1px solid ${NEON.yellow}30`, color: '#8b94a7' }}
            >
              <b style={{ color: NEON.yellow }}>Kill-switch behavior.</b> Disabling retrieval restores the
              normal agent path instantly — approved skills stay stored, nothing is deleted, and re-enabling
              picks up where it left off.
            </div>
            <p className="text-[10px] font-hud mt-2 mb-0" style={{ color: '#555' }}>
              Flag state reads from the server. Var names follow the LEARNING_&lt;flag&gt;_ENABLED pattern
              (capture confirmed as LEARNING_CAPTURE_ENABLED).
            </p>
          </div>
        </div>

        {/* Safety rails (static, approved preview content) */}
        <div
          className="chamfer-md p-4 flex flex-col gap-2"
          style={{ background: BG.card, border: `1px solid ${NEON.yellow}25` }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.yellow }}>
              ◇ Safety rails
            </span>
          </div>
          {ROUTING_SAFETY_RAILS.map((r) => (
            <div
              key={r.title}
              className="chamfer-sm p-3 text-[12px]"
              style={{ background: BG.surface, border: `1px solid ${NEON.yellow}25`, color: '#8b94a7' }}
            >
              <b style={{ color: NEON.yellow }}>{r.title}</b> {r.body}
            </div>
          ))}
        </div>
      </>
    );
  };

  // ══════════════════════════════════════════════════════════════
  // PHASE 6 — CURATOR TAB COMPONENTS
  // ══════════════════════════════════════════════════════════════

  // Phase 6: one Aimi-style recommendation card with Approve / Dismiss /
  // Pin-instead actions and tap-to-expand full evidence.
  const RecommendationCard = ({ rec }) => {
    if (!rec || typeof rec !== 'object') return null;
    const open = openRec === rec.id;
    const kindStyle = RECOMMEND_KIND_STYLE[rec.kind]
      || { label: String(rec.kind || 'UNKNOWN').toUpperCase(), color: '#8b94a7' };
    const kindChip = RECOMMEND_KIND_STYLE[rec.kind] ? kindStyle : null;
    const vKind = VERSION_KIND_STYLE[rec.version_kind] || null;
    const vState = VERSION_STATE_STYLE[rec.version_state] || null;
    const evLine = evidenceLine(rec.evidence);
    const busy = recActioning && String(recActioning).startsWith(`${rec.id}:`)
      ? String(recActioning).split(':')[1]
      : null;

    const actBtn = (action, label, color, title) => (
      <button
        key={action}
        onClick={(e) => {
          e.stopPropagation();
          if (action === 'pin') handlePinVersion(rec);
          else handleRecAction(rec, action); // 'approve' | 'dismiss'
        }}
        disabled={busy !== null}
        title={title}
        className="flex-1 min-w-[96px] py-3 chamfer-sm text-[11px] tracking-wider font-hud uppercase font-bold transition-all"
        style={{
          background: `${color}10`,
          border: `1px solid ${color}60`,
          color,
          opacity: busy !== null ? 0.4 : 1,
          cursor: busy !== null ? 'not-allowed' : 'pointer',
          minHeight: '40px',
        }}
      >
        {busy === action ? (
          <><Loader size={12} className="animate-spin inline" /> …</>
        ) : label}
      </button>
    );

    return (
      <div
        className="chamfer-sm"
        style={{ background: BG.surface, border: `1px solid ${kindStyle.color}25` }}
      >
        <button
          onClick={() => setOpenRec(open ? null : rec.id)}
          className="p-3 flex flex-col gap-2 text-left w-full"
          style={{ cursor: 'pointer', minHeight: '40px' }}
        >
          <span className="text-[10px] tracking-widest uppercase font-hud" style={{ color: NEON.purple }}>
            ✦ Aimi drafts
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-medium" style={{ color: '#dbe2f1' }}>
              {rec.version_title || `version ${String(rec.version_id || '').slice(0, 8)}`}
            </span>
            {kindChip && <Chip color={kindChip.color}>{kindChip.label}</Chip>}
            {vKind && <Chip color={vKind.color}>KIND · {vKind.label}</Chip>}
            {vState && <Chip color={vState.color}>{vState.label}</Chip>}
            <span className="text-[10px] font-hud ml-auto" style={{ color: '#555' }}>
              {fmtDate(rec.created_at)}
            </span>
          </div>
          {rec.reason && (
            <p className="text-[12px] m-0" style={{ color: '#8b94a7' }}>{rec.reason}</p>
          )}
          {evLine && (
            <div className="text-[11px] font-hud" style={{ color: NEON.cyan }}>
              {evLine}
            </div>
          )}
          <span className="text-[10px] font-hud" style={{ color: '#555' }}>
            Tap to {open ? 'collapse ▲' : 'expand ▾'}
          </span>
        </button>

        <div className="px-3 pb-3 flex gap-2 flex-wrap" style={{ borderTop: `1px solid ${kindStyle.color}12`, paddingTop: '12px' }}>
          {actBtn('approve', `Approve ${kindStyle.label.toLowerCase()}`, NEON.green, 'Accept Aimi\u2019s proposal and let the curator apply it')}
          {actBtn('pin', 'Pin instead', NEON.cyan, 'Keep the version permanently — the curator will never propose touching it again')}
          {actBtn('dismiss', 'Dismiss', '#8b94a7', 'Reject the proposal; the version stays exactly as it is')}
        </div>

        {open && rec.evidence != null && typeof rec.evidence === 'object' && (
          <div className="px-3 pb-3">
            <div className="text-[10px] tracking-widest uppercase font-hud font-bold mb-1.5" style={{ color: '#555' }}>
              ◇ Full evidence
            </div>
            <pre
              className="chamfer-sm p-3 text-[11px] font-mono overflow-auto m-0"
              style={{ background: BG.card, border: `1px solid ${NEON.cyan}12`, color: '#8b94a7', maxHeight: '220px' }}
            >
              {JSON.stringify(rec.evidence, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  };

  // Phase 6: the whole Curator tab — lifecycle maintenance, Haz's call on
  // every change. Dry-run reports first; prune unlocks after 2 reviewed runs.
  const CuratorTab = () => {
    const latestRun = runs[0] || null;
    const history = runs.slice(1);
    const latestMode = CURATOR_MODE_STYLE[latestRun?.mode] || null;
    const isDryRun = latestRun?.mode === 'dry_run';
    const reviewed = latestRun?.reviewed === true || latestRun?.reviewed === 1;
    const pruneEligible = curatorConfig?.prune_eligible === true;
    const reviewedCount = num(curatorConfig?.reviewed_dry_runs);
    const cfgLoading = !curatorConfig && runsLoading;

    return (
      <>
        {/* ══ PHASE 6: CURATOR & LIFECYCLE ══ */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h2
              className="flex items-center gap-2 text-lg font-bold tracking-wider font-hud"
              style={{ color: NEON.purple, filter: `drop-shadow(0 0 8px ${NEON.purple}60)` }}
            >
              ◈ Curator & lifecycle
            </h2>
            <p className="text-[11px] mt-1" style={{ color: '#555' }}>
              Phase 6 — the catalog ages gracefully, or not at all without your say
            </p>
            <div className="flex gap-2 mt-2.5 flex-wrap">
              <span
                className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                style={{ background: `${NEON.yellow}10`, color: NEON.yellow, border: `1px solid ${NEON.yellow}40` }}
              >
                ◉ dry-run first
              </span>
              <span
                className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                style={{ background: `${NEON.purple}10`, color: NEON.purple, border: `1px solid ${NEON.purple}35` }}
              >
                propose, never auto-apply
              </span>
            </div>
          </div>
          <button
            onClick={refreshCurator}
            disabled={runsLoading || recsLoading}
            className="flex items-center gap-2 px-4 py-2 chamfer-sm text-[11px] font-bold tracking-wide font-hud uppercase transition-all"
            style={{
              background: `${NEON.purple}12`,
              border: `1px solid ${NEON.purple}40`,
              color: NEON.purple,
              opacity: runsLoading ? 0.5 : 1,
              cursor: runsLoading ? 'not-allowed' : 'pointer',
              boxShadow: `0 0 12px ${NEON.purple}20`,
              minHeight: '40px',
            }}
          >
            {runsLoading || recsLoading ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {runsLoading || recsLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {curatorError && (
          <div
            className="chamfer-sm px-4 py-3 text-[12px] font-hud"
            style={{ background: `${NEON.red}08`, border: `1px solid ${NEON.red}30`, color: NEON.red }}
          >
            ⚠ {curatorError}
          </div>
        )}

        {curatorNotice && (
          <div
            className="chamfer-sm px-4 py-3 text-[12px] font-hud"
            style={
              curatorNotice.startsWith('Prune not eligible')
                ? { background: `${NEON.yellow}08`, border: `1px solid ${NEON.yellow}40`, color: NEON.yellow }
                : { background: `${NEON.green}06`, border: `1px solid ${NEON.green}40`, color: NEON.green }
            }
          >
            {curatorNotice}
          </div>
        )}

        {/* How a curator run works (static, approved preview content) */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.cyan}18` }}
        >
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${NEON.cyan}12` }}>
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.cyan }}>
              ◇ How a curator run works
            </span>
          </div>
          <div className="p-3 flex flex-wrap items-stretch gap-1.5">
            {CURATOR_PIPELINE.map((s, i) => (
              <div key={s.n} className="flex items-stretch gap-1.5 flex-1 min-w-[130px]">
                <div
                  className="chamfer-sm p-2.5 flex-1"
                  style={{ background: BG.surface, border: `1px solid ${NEON.cyan}15` }}
                >
                  <div className="text-[12px] font-bold font-hud" style={{ color: NEON.cyan }}>{s.n}</div>
                  <div className="text-[10px] mt-1" style={{ color: '#8b94a7' }}>{s.d}</div>
                </div>
                {i < CURATOR_PIPELINE.length - 1 && (
                  <span className="self-center shrink-0" style={{ color: NEON.cyan }}>→</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Latest-run report */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.purple}20` }}
        >
          <div
            className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: `1px solid ${NEON.purple}12` }}
          >
            <History size={13} style={{ color: NEON.purple }} />
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.purple }}>
              ◇ Latest curator run
            </span>
            {latestMode && (
              <span className="ml-auto">
                <Chip color={latestMode.color}>{latestMode.label}</Chip>
              </span>
            )}
          </div>
          <div className="p-3 flex flex-col gap-2.5">
            {runsLoading && !latestRun && (
              <div className="flex items-center justify-center py-8 gap-2 text-[12px] font-hud" style={{ color: '#555' }}>
                <Loader size={16} className="animate-spin" /> Loading curator runs…
              </div>
            )}
            {!runsLoading && !latestRun && (
              <div className="text-center py-8 text-[11px] font-hud" style={{ color: '#444' }}>
                No curator runs yet — run the first dry-run below to see what the catalog looks like.
              </div>
            )}
            {latestRun && (
              <>
                <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] font-hud" style={{ color: '#8b94a7' }}>
                  <span>findings <b style={{ color: NEON.purple }}>{num(latestRun.findings_count)}</b></span>
                  <span>applied <b style={{ color: NEON.green }}>{num(latestRun.applied_count)}</b></span>
                  <span>reviewed <b style={{ color: reviewed ? NEON.green : NEON.yellow }}>{reviewed ? 'yes' : 'no'}</b></span>
                  <span className="text-[11px]" style={{ color: '#555' }}>{fmtDate(latestRun.created_at)}</span>
                </div>
                {policyLine(latestRun.policy_snapshot) && (
                  <div
                    className="chamfer-sm px-3 py-2 text-[11px] font-hud"
                    style={{ background: BG.surface, border: `1px dashed ${NEON.purple}40`, color: '#8b94a7' }}
                  >
                    {policyLine(latestRun.policy_snapshot)}
                  </div>
                )}
                {isDryRun && !reviewed && (
                  <div
                    className="chamfer-sm px-3 py-2 text-[12px]"
                    style={{ background: `${NEON.yellow}06`, border: `1px dashed ${NEON.yellow}50`, color: '#8b94a7' }}
                  >
                    <b style={{ color: NEON.yellow }}>Unreviewed dry run.</b> Mark it reviewed once you've checked the
                    proposals — two reviewed dry runs unlock prune mode.
                  </div>
                )}
              </>
            )}
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => handleRunCurator('dry_run')}
                disabled={curatorRunning !== null}
                className="flex-1 min-w-[130px] py-3 chamfer-sm text-[11px] tracking-wider font-hud uppercase font-bold transition-all"
                style={{
                  background: `${NEON.yellow}10`,
                  border: `1px solid ${NEON.yellow}60`,
                  color: NEON.yellow,
                  opacity: curatorRunning !== null ? 0.5 : 1,
                  cursor: curatorRunning !== null ? 'not-allowed' : 'pointer',
                  minHeight: '44px',
                }}
              >
                {curatorRunning === 'dry_run' ? <Loader size={13} className="animate-spin inline" /> : <Play size={13} className="inline" />}
                {' '}{curatorRunning === 'dry_run' ? 'Running…' : 'Run curator'}
              </button>
              {pruneEligible && (
                <button
                  onClick={() => handleRunCurator('prune')}
                  disabled={curatorRunning !== null}
                  className="flex-1 min-w-[130px] py-3 chamfer-sm text-[11px] tracking-wider font-hud uppercase font-bold transition-all"
                  style={{
                    background: `${NEON.purple}10`,
                    border: `1px solid ${NEON.purple}60`,
                    color: NEON.purple,
                    opacity: curatorRunning !== null ? 0.5 : 1,
                    cursor: curatorRunning !== null ? 'not-allowed' : 'pointer',
                    boxShadow: `0 0 12px ${NEON.purple}25`,
                    minHeight: '44px',
                  }}
                >
                  {curatorRunning === 'prune' ? <Loader size={13} className="animate-spin inline" /> : <Hammer size={13} className="inline" />}
                  {' '}{curatorRunning === 'prune' ? 'Pruning…' : 'Prune run'}
                </button>
              )}
              {isDryRun && !reviewed && (
                <button
                  onClick={() => handleReviewRun(latestRun.id)}
                  disabled={reviewingRun !== null}
                  className="flex-1 min-w-[130px] py-3 chamfer-sm text-[11px] tracking-wider font-hud uppercase font-bold transition-all"
                  style={{
                    background: `${NEON.green}10`,
                    border: `1px solid ${NEON.green}60`,
                    color: NEON.green,
                    opacity: reviewingRun !== null ? 0.5 : 1,
                    cursor: reviewingRun !== null ? 'not-allowed' : 'pointer',
                    minHeight: '44px',
                  }}
                >
                  {reviewingRun !== null ? <Loader size={13} className="animate-spin inline" /> : <CheckCircle2 size={13} className="inline" />}
                  {' '}{reviewingRun !== null ? 'Marking…' : 'Mark reviewed'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* The maintenance pass (static, approved preview content) */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.cyan}18` }}
        >
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${NEON.cyan}12` }}>
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.cyan }}>
              ◇ The maintenance pass
            </span>
            <span
              className="ml-2 text-[10px] font-hud px-2 py-0.5"
              style={{ background: `${NEON.cyan}12`, color: NEON.cyan }}
            >
              deterministic
            </span>
          </div>
          <div className="p-3 flex flex-col gap-2">
            {CURATOR_RULES.map(r => (
              <div
                key={r.cond}
                className="chamfer-sm p-3 text-[12px]"
                style={{ background: BG.surface, border: `1px solid ${NEON.cyan}12` }}
              >
                <div className="text-[11px] font-hud" style={{ color: NEON.cyan }}>{r.cond}</div>
                <div className="my-1" style={{ color: '#555' }}>→</div>
                <div style={{ color: '#dbe2f1' }}>{r.trans}</div>
                <span className="block mt-1.5 text-[10px]" style={{ color: NEON.green }}>{r.safe}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Aimi's recommendations */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.purple}20` }}
        >
          <div
            className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: `1px solid ${NEON.purple}12` }}
          >
            <Sparkles size={13} style={{ color: NEON.purple }} />
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.purple }}>
              ◇ Aimi's recommendations
            </span>
            <span
              className="ml-auto text-[10px] font-hud px-2 py-0.5"
              style={{ background: `${NEON.purple}12`, color: NEON.purple }}
            >
              {recs.length} proposed
            </span>
          </div>
          <div className="p-3 flex flex-col gap-2">
            {recsLoading && recs.length === 0 && (
              <div className="flex items-center justify-center py-10 gap-2 text-[12px] font-hud" style={{ color: '#555' }}>
                <Loader size={16} className="animate-spin" /> Loading recommendations…
              </div>
            )}
            {!recsLoading && recs.length === 0 && (
              <div className="text-center py-10 text-[11px] font-hud" style={{ color: '#444' }}>
                <ShieldCheck size={20} className="mx-auto mb-2" style={{ color: '#333' }} />
                No pending proposals — the catalog is healthy, or the last dry run found nothing worth flagging.
              </div>
            )}
            {recs.map((rec, ri) => <RecommendationCard key={rec?.id || `rec-${ri}`} rec={rec} />)}
          </div>
        </div>

        {/* Recently applied — archive is reversible */}
        {appliedRecs.length > 0 && (
          <div
            className="chamfer-md overflow-hidden"
            style={{ background: BG.card, border: `1px solid ${NEON.green}18` }}
          >
            <div className="px-4 py-3" style={{ borderBottom: `1px solid ${NEON.green}12` }}>
              <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.green }}>
                ◇ Recently applied
              </span>
            </div>
            <div className="p-3 flex flex-col gap-2">
              {appliedRecs.map((r, ri) => {
                const ks = RECOMMEND_KIND_STYLE[r?.kind]
                  || { label: String(r?.kind || 'UNKNOWN').toUpperCase(), color: '#8b94a7' };
                const busy = recActioning === `${r?.id}:restore`;
                return (
                  <div
                    key={r?.id || `applied-${ri}`}
                    className="chamfer-sm p-3 flex items-center gap-2.5 flex-wrap"
                    style={{ background: BG.surface, border: `1px solid ${NEON.green}12` }}
                  >
                    <span className="text-[13px]" style={{ color: '#dbe2f1' }}>
                      {r?.version_title || `version ${String(r?.version_id || '').slice(0, 8)}`}
                    </span>
                    <Chip color={ks.color}>{ks.label}</Chip>
                    <span className="text-[10px] font-hud" style={{ color: '#555' }}>
                      {fmtDate(r?.decided_at || r?.created_at)}
                    </span>
                    {r?.kind === 'archive' && (
                      <button
                        onClick={() => handleRestoreVersion(r)}
                        disabled={busy || recActioning !== null}
                        className="ml-auto flex items-center gap-1.5 px-3 py-2 chamfer-sm text-[10px] tracking-wider font-hud uppercase font-bold transition-all"
                        style={{
                          background: `${NEON.green}10`,
                          border: `1px solid ${NEON.green}60`,
                          color: NEON.green,
                          opacity: busy || recActioning !== null ? 0.4 : 1,
                          cursor: busy || recActioning !== null ? 'not-allowed' : 'pointer',
                          minHeight: '36px',
                        }}
                      >
                        {busy ? <Loader size={12} className="animate-spin" /> : <ArchiveRestore size={12} />}
                        {' '}{busy ? 'Restoring…' : 'Restore'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Protection rules (static) */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.green}20` }}
        >
          <div
            className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: `1px solid ${NEON.green}12` }}
          >
            <ShieldCheck size={13} style={{ color: NEON.green }} />
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.green }}>
              ◇ Protection rules
            </span>
          </div>
          <div className="p-3 flex flex-col gap-2">
            <div
              className="chamfer-sm p-3"
              style={{ background: `${NEON.green}04`, border: `1px solid ${NEON.green}25` }}
            >
              <div className="text-[11px] font-bold tracking-widest uppercase font-hud mb-2" style={{ color: NEON.green }}>
                🛡 Never auto-touched
              </div>
              <ul className="m-0 pl-4 text-[11px] flex flex-col gap-1" style={{ color: '#8b94a7' }}>
                {PROTECTION_LIST.map(p => <li key={p}>{p}</li>)}
              </ul>
            </div>
            <div
              className="chamfer-sm p-3 text-[12px]"
              style={{ background: `${NEON.red}05`, border: `1px solid ${NEON.red}30`, color: '#8b94a7' }}
            >
              <b style={{ color: NEON.red }}>Archive ≠ delete.</b> Archived skills restore in one tap with full history.
              Permanent deletion stays a manual admin action with a warning — the curator can never do it.
            </div>
          </div>
        </div>

        {/* Curator settings (read-only, server-owned) */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.cyan}18` }}
        >
          <div
            className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: `1px solid ${NEON.cyan}12` }}
          >
            <Gauge size={13} style={{ color: NEON.cyan }} />
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.cyan }}>
              ◇ Curator settings
            </span>
            <span
              className="ml-auto text-[10px] font-hud px-2 py-0.5"
              style={{ background: `${NEON.cyan}12`, color: NEON.cyan }}
            >
              read-only
            </span>
          </div>
          <div className="p-3 flex flex-col gap-1.5">
            {cfgLoading && (
              <div className="flex items-center justify-center py-6 gap-2 text-[12px] font-hud" style={{ color: '#555' }}>
                <Loader size={14} className="animate-spin" /> Loading config…
              </div>
            )}
            {!cfgLoading && !curatorConfig && (
              <div className="text-center py-6 text-[11px] font-hud" style={{ color: '#444' }}>
                Config unavailable — backend endpoint not responding.
              </div>
            )}
            {curatorConfig && CURATOR_CONFIG_ROWS.map(row => (
              <div
                key={row.key}
                className="chamfer-sm px-3 py-2 flex items-center gap-2 text-[11px] font-hud"
                style={{ background: BG.surface, border: `1px solid ${NEON.cyan}10` }}
              >
                <span style={{ color: '#8b94a7', flex: 1 }}>{row.label}</span>
                <span className="text-[10px]" style={{ color: '#555' }}>{row.env}</span>
                <b style={{ color: NEON.cyan }}>{String(curatorConfig[row.key] ?? '—')}</b>
              </div>
            ))}
            {curatorConfig && (
              <div
                className="chamfer-sm px-3 py-2.5 flex items-center gap-2 text-[11px] font-hud"
                style={{ background: BG.surface, border: `1px dashed ${pruneEligible ? NEON.green : NEON.yellow}60`, color: '#8b94a7' }}
              >
                <span style={{ flex: 1 }}>
                  prune eligibility — <b style={{ color: pruneEligible ? NEON.green : NEON.yellow }}>{reviewedCount}/2</b> dry runs reviewed
                </span>
                <Chip color={pruneEligible ? NEON.green : NEON.yellow}>
                  {pruneEligible ? 'PRUNE UNLOCKED' : 'PRUNE LOCKED'}
                </Chip>
              </div>
            )}
          </div>
          <div className="px-3 pb-3">
            <p className="text-[10px] font-hud m-0" style={{ color: '#555' }}>
              Values are env-configured server-side — restart the backend to change them.
              The effective policy is logged on every curator run, so there's always a record
              of what rules were in force when a proposal was drafted.
            </p>
          </div>
        </div>

        {/* Run history */}
        <div
          className="chamfer-md overflow-hidden"
          style={{ background: BG.card, border: `1px solid ${NEON.yellow}20` }}
        >
          <div
            className="px-4 py-3 flex items-center gap-2"
            style={{ borderBottom: `1px solid ${NEON.yellow}12` }}
          >
            <History size={13} style={{ color: NEON.yellow }} />
            <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.yellow }}>
              ◇ Run history
            </span>
            <span
              className="ml-auto text-[10px] font-hud px-2 py-0.5"
              style={{ background: `${NEON.yellow}12`, color: NEON.yellow }}
            >
              {runs.length} runs
            </span>
          </div>
          <div className="p-3 flex flex-col gap-2">
            {!runsLoading && history.length === 0 && (
              <div className="text-center py-6 text-[11px] font-hud" style={{ color: '#444' }}>
                {latestRun ? 'Only one run so far — history builds as the curator runs.' : 'No runs yet.'}
              </div>
            )}
            {history.map((r, ri) => {
              const m = CURATOR_MODE_STYLE[r?.mode] || { label: String(r?.mode || 'UNKNOWN').toUpperCase(), color: '#8b94a7' };
              const rev = r?.reviewed === true || r?.reviewed === 1;
              return (
                <div
                  key={r?.id || `run-${ri}`}
                  className="chamfer-sm p-3 flex items-center gap-2.5 flex-wrap"
                  style={{ background: BG.surface, border: `1px solid ${NEON.yellow}12` }}
                >
                  <Chip color={m.color}>{m.label}</Chip>
                  <Chip color={rev ? NEON.green : '#8b94a7'}>{rev ? 'REVIEWED' : 'UNREVIEWED'}</Chip>
                  <span className="text-[11px] font-hud" style={{ color: '#8b94a7' }}>
                    {num(r?.findings_count)} findings · {num(r?.applied_count)} applied
                  </span>
                  <span className="text-[10px] font-hud ml-auto" style={{ color: '#555' }}>
                    {fmtDate(r?.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </>
    );
  };

  const latestJob = jobs[0];
  const budgetUsed = num(latestJob?.budget_used);
  const budgetLimit = num(latestJob?.budget_limit) || 20;
  const activeList = lists[tab] || [];
  const c = detail?.candidate;
  const evidence = detail?.evidence || [];

  return (
    <div className="flex flex-col gap-6" style={{ minHeight: '100%' }}>
      {/* ── Header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1
            className="flex items-center gap-2 text-xl font-bold tracking-wider font-hud"
            style={{ color: NEON.cyan, filter: `drop-shadow(0 0 8px ${NEON.cyan}60)` }}
          >
            ◈ Learning Inbox
          </h1>
          <p className="text-[11px] mt-1" style={{ color: '#555' }}>
            Candidate review → promotion → lifecycle · nothing here affects live behavior until you approve it
          </p>
          <div className="flex gap-2 mt-2.5 flex-wrap">
            <span
              className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
              style={{ background: `${NEON.yellow}10`, color: NEON.yellow, border: `1px solid ${NEON.yellow}40` }}
            >
              ◉ Shadow mode
            </span>
            <span
              className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
              style={{ background: `${NEON.cyan}10`, color: NEON.cyan, border: `1px solid ${NEON.cyan}35` }}
            >
              Budget {budgetUsed} / {budgetLimit} today
            </span>
          </div>
        </div>
        <button
          onClick={handleRunReview}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 chamfer-sm text-[11px] font-bold tracking-wide font-hud uppercase transition-all"
          style={{
            background: `${NEON.purple}15`,
            border: `1px solid ${NEON.purple}40`,
            color: NEON.purple,
            opacity: running ? 0.5 : 1,
            cursor: running ? 'not-allowed' : 'pointer',
            boxShadow: `0 0 12px ${NEON.purple}20`,
          }}
        >
          {running ? <Loader size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {running ? 'Running…' : 'Run review'}
        </button>
      </div>

      {loadError && (
        <div
          className="chamfer-sm px-4 py-3 text-[12px] font-hud"
          style={{ background: `${NEON.red}08`, border: `1px solid ${NEON.red}30`, color: NEON.red }}
        >
          ⚠ {loadError}
        </div>
      )}

      {detail ? (
        /* ══ DETAIL VIEW ══ */
        <div
          className="chamfer-md hud-brackets p-4 md:p-6 flex flex-col gap-3"
          style={{ background: BG.card, border: `1px solid ${NEON.cyan}25` }}
        >
          <button
            onClick={closeDetail}
            className="self-start flex items-center gap-1.5 text-[13px] font-hud transition-all"
            style={{ color: NEON.cyan, cursor: 'pointer' }}
          >
            <ArrowLeft size={14} /> BACK TO INBOX
          </button>

          <h2 className="text-lg font-bold m-0" style={{ color: '#dbe2f1' }}>
            {c.title || 'Untitled candidate'}
          </h2>
          <div className="flex gap-1.5 flex-wrap">
            <Chip color={(KIND_STYLE[c.kind] || {}).color || '#8b94a7'}>{(KIND_STYLE[c.kind] || {}).label || String(c.kind || 'UNKNOWN').toUpperCase()}</Chip>
            <Chip color={(RISK_STYLE[c.risk_tier] || RISK_STYLE.low).color}>{(RISK_STYLE[c.risk_tier] || RISK_STYLE.low).label}</Chip>
            <Chip color="#aab4cc">{stateChipLabel(c.state)}</Chip>
          </div>

          {/* Aimi's draft */}
          <div className="text-[10px] tracking-widest uppercase font-hud font-bold mt-2" style={{ color: NEON.green }}>
            Aimi's draft — plain language
          </div>
          <div
            className="chamfer-sm p-3"
            style={{ background: BG.surface, borderLeft: `3px solid ${NEON.green}` }}
          >
            {Array.isArray(c.draft) && c.draft.length > 0 ? (
              <ol className="m-0 pl-5 flex flex-col gap-1.5 text-[14px]" style={{ color: '#c6cfe6' }}>
                {c.draft.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            ) : (
              <span className="text-[13px]" style={{ color: '#555' }}>No draft steps yet.</span>
            )}
          </div>

          {/* Why this is a candidate */}
          <div className="text-[10px] tracking-widest uppercase font-hud font-bold mt-2" style={{ color: NEON.magenta }}>
            Why this is a candidate
          </div>
          <p className="text-[13px] m-0" style={{ color: '#aab4cc' }}>
            {c.eligibility_note || 'No eligibility note recorded.'}
          </p>

          {/* Score breakdown */}
          <div className="text-[10px] tracking-widest uppercase font-hud font-bold mt-2" style={{ color: NEON.cyan }}>
            Score breakdown
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="chamfer-sm p-3" style={{ background: BG.surface, border: `1px solid ${NEON.cyan}15` }}>
              <div className="text-xl font-bold font-hud" style={{ color: NEON.cyan, filter: `drop-shadow(0 0 6px ${NEON.cyan}50)` }}>
                {num(c.promotion_score).toFixed(2)}
              </div>
              <div className="text-[10px] font-hud" style={{ color: '#666' }}>PROMOTION SCORE</div>
            </div>
            <div className="chamfer-sm p-3" style={{ background: BG.surface, border: `1px solid ${NEON.cyan}15` }}>
              <div className="text-xl font-bold font-hud" style={{ color: NEON.cyan, filter: `drop-shadow(0 0 6px ${NEON.cyan}50)` }}>
                {supportScore(c).toFixed(1)}
              </div>
              <div className="text-[10px] font-hud" style={{ color: '#666' }}>SUPPORT</div>
              <div className="text-[10px] font-hud mt-0.5" style={{ color: '#555' }}>
                {num(c.support_verified)}✓ + 1.5×{num(c.support_recovered)}⟲ + 2×{num(c.support_corrections)}✎
              </div>
            </div>
          </div>

          {/* Requested capabilities */}
          <div className="text-[10px] tracking-widest uppercase font-hud font-bold mt-2" style={{ color: NEON.purple }}>
            Requested capabilities
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {Array.isArray(c.requested_caps) && c.requested_caps.length > 0 ? (
              c.requested_caps.map((cap, i) => (
                <span
                  key={i}
                  className="text-[11px] px-2.5 py-1 chamfer-sm font-hud"
                  style={{ background: `${NEON.purple}10`, border: `1px solid ${NEON.purple}30`, color: NEON.purple }}
                >
                  {cap}
                </span>
              ))
            ) : (
              <span className="text-[12px]" style={{ color: '#555' }}>None recorded.</span>
            )}
          </div>

          {/* Linked evidence */}
          <div className="text-[10px] tracking-widest uppercase font-hud font-bold mt-2" style={{ color: NEON.cyan }}>
            Linked evidence ({evidence.length})
          </div>
          {evidence.length > 0 ? (
            <div className="flex flex-col gap-2">
              {evidence.map((e, i) => (
                <div key={e.id || i} className="chamfer-sm p-3" style={{ background: BG.surface, border: `1px solid ${NEON.cyan}12` }}>
                  <div className="text-[10px] font-hud mb-1" style={{ color: '#555' }}>
                    {fmtDate(e.created_at)} · {e.event_type || e.role || 'event'} · trace {e.trace_id ? `${String(e.trace_id).slice(0, 4)}…` : '—'}
                  </div>
                  <div className="text-[12px] font-hud whitespace-pre-wrap" style={{ color: '#a9c1e8' }}>
                    {e.excerpt || `outcome: ${e.outcome || '—'}`}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-[12px]" style={{ color: '#555' }}>No linked evidence.</span>
          )}

          {/* ── Phase 4: compile a promoted candidate into a versioned skill ── */}
          {c.state === 'promoted' && (
            <>
              <div className="text-[10px] tracking-widest uppercase font-hud font-bold mt-2" style={{ color: NEON.cyan }}>
                ◇ Skill compiler
              </div>
              <button
                onClick={handleCompile}
                disabled={compiling}
                className="w-full py-3 chamfer-sm text-[12px] tracking-wider font-hud uppercase font-bold transition-all flex items-center justify-center gap-2"
                style={{
                  background: `${NEON.cyan}10`, border: `1px solid ${NEON.cyan}`, color: NEON.cyan,
                  opacity: compiling ? 0.5 : 1, cursor: compiling ? 'not-allowed' : 'pointer',
                }}
              >
                {compiling ? <Loader size={14} className="animate-spin" /> : <Cpu size={14} />}
                {compiling ? 'Compiling — spec → compile → test → scan…' : 'Compile to skill'}
              </button>
              {compileNotice && (
                <div
                  className="chamfer-sm px-3 py-2.5 text-[12px] font-hud"
                  style={
                    compileNotice.startsWith('⚠')
                      ? { background: `${NEON.red}08`, border: `1px solid ${NEON.red}30`, color: NEON.red }
                      : { background: `${NEON.green}06`, border: `1px solid ${NEON.green}40`, color: NEON.green }
                  }
                >
                  {compileNotice}
                </div>
              )}
              <p className="text-[11px] m-0" style={{ color: '#555' }}>
                Runs the full pipeline — spec, compile, isolated test gate, scanner — then stores an immutable
                version. The version ships disabled; you activate it from the COMPILED tab.
              </p>
            </>
          )}

          {/* Rejected note or actions */}
          {c.state === 'rejected' ? (
            <div
              className="chamfer-sm p-3 text-[13px]"
              style={{ background: `${NEON.red}06`, border: `1px solid ${NEON.red}30`, color: '#e8a0a0' }}
            >
              {c.reject_reason || 'Rejected without a recorded reason.'}
              {c.cooldown_until && (
                <div className="text-[11px] font-hud mt-1" style={{ color: '#a88' }}>
                  Cooldown until: {fmtDate(c.cooldown_until)}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex gap-2 mt-2 flex-wrap">
                <button
                  onClick={handleApprove}
                  disabled={actioning}
                  className="flex-1 min-w-[110px] py-3 chamfer-sm text-[12px] tracking-wider font-hud uppercase font-bold transition-all"
                  style={{
                    background: `${NEON.green}12`, border: `1px solid ${NEON.green}`, color: NEON.green,
                    opacity: actioning ? 0.5 : 1, cursor: actioning ? 'not-allowed' : 'pointer',
                  }}
                >
                  {actioning ? 'Working…' : 'Approve'}
                </button>
                <button
                  onClick={openEdit}
                  className="flex-1 min-w-[110px] py-3 chamfer-sm text-[12px] tracking-wider font-hud uppercase font-bold transition-all"
                  style={{ background: `${NEON.purple}10`, border: `1px solid ${NEON.purple}60`, color: NEON.purple, cursor: 'pointer' }}
                >
                  Edit
                </button>
                <button
                  onClick={() => setShowReject(true)}
                  disabled={actioning}
                  className="flex-1 min-w-[110px] py-3 chamfer-sm text-[12px] tracking-wider font-hud uppercase font-bold transition-all"
                  style={{
                    background: `${NEON.red}08`, border: `1px solid ${NEON.red}60`, color: NEON.red,
                    opacity: actioning ? 0.5 : 1, cursor: actioning ? 'not-allowed' : 'pointer',
                  }}
                >
                  Reject
                </button>
              </div>
              <p className="text-[11px] m-0" style={{ color: '#555' }}>
                Approve promotes to a trusted, versioned procedure — reversible. Reject records the reason so it isn't proposed again without new evidence.
              </p>
            </>
          )}
        </div>
      ) : (
        /* ══ LIST VIEW ══ */
        <>
          {/* Stats row */}
          <div className="flex flex-wrap gap-3">
            <StatCard icon={Inbox} label="Candidates" value={lists.review.length} color={NEON.cyan} sub="awaiting review" />
            <StatCard icon={FlaskConical} label="In testing" value={lists.testing.length} color={NEON.yellow} />
            <StatCard icon={CheckCircle2} label="Promoted" value={lists.promoted.length} color={NEON.green} sub="trusted, versioned" />
          </div>

          {/* Tabs */}
          <div className="flex gap-2 flex-wrap">
            {TABS.map(t => {
              const active = tab === t.key;
              const tabCount = t.key === 'clusters' ? clusters.length
                : t.key === 'compiled' ? versions.length
                : t.key === 'routing' ? decisions.length
                : t.key === 'curator' ? recs.length
                : (lists[t.key] || []).length;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className="flex-1 min-w-[100px] text-center px-3 py-2.5 chamfer-sm text-[12px] font-hud transition-all"
                  style={{
                    background: active ? `${NEON.cyan}08` : BG.card,
                    border: `1px solid ${active ? NEON.cyan : `${NEON.cyan}15`}`,
                    color: active ? NEON.cyan : '#8b94a7',
                    cursor: 'pointer',
                  }}
                >
                  {t.label}
                  <span
                    className="inline-block min-w-[20px] px-1.5 py-0.5 ml-1.5 text-[11px] font-hud"
                    style={{ background: `${NEON.cyan}12`, color: active ? NEON.cyan : '#666' }}
                  >
                    {tabCount}
                  </span>
                </button>
              );
            })}
          </div>

          {tab === 'clusters' ? (
            <>
              {/* ══ PHASE 3: SEMANTIC CLUSTERING ══ */}
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <h2
                    className="flex items-center gap-2 text-lg font-bold tracking-wider font-hud"
                    style={{ color: NEON.purple, filter: `drop-shadow(0 0 8px ${NEON.purple}60)` }}
                  >
                    ◈ Semantic clustering
                  </h2>
                  <p className="text-[11px] mt-1" style={{ color: '#555' }}>
                    Repetition becomes evidence, never the trigger — merges are proposed, never automatic
                  </p>
                  <div className="flex gap-2 mt-2.5 flex-wrap">
                    <span
                      className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                      style={{ background: `${NEON.yellow}10`, color: NEON.yellow, border: `1px solid ${NEON.yellow}40` }}
                    >
                      ◉ Shadow mode
                    </span>
                    <span
                      className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                      style={{ background: `${NEON.purple}10`, color: NEON.purple, border: `1px solid ${NEON.purple}35` }}
                    >
                      merges proposed, never automatic
                    </span>
                    <span
                      className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                      style={{ background: `${NEON.cyan}10`, color: NEON.cyan, border: `1px solid ${NEON.cyan}35` }}
                    >
                      threshold {clusterStats?.threshold != null ? num(clusterStats.threshold).toFixed(2) : '0.80'} · calibrated
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleRunClustering}
                  disabled={clustering}
                  className="flex items-center gap-2 px-4 py-2 chamfer-sm text-[11px] font-bold tracking-wide font-hud uppercase transition-all"
                  style={{
                    background: `${NEON.purple}15`,
                    border: `1px solid ${NEON.purple}40`,
                    color: NEON.purple,
                    opacity: clustering ? 0.5 : 1,
                    cursor: clustering ? 'not-allowed' : 'pointer',
                    boxShadow: `0 0 12px ${NEON.purple}20`,
                    minHeight: '40px',
                  }}
                >
                  {clustering ? <Loader size={14} className="animate-spin" /> : <Network size={14} />}
                  {clustering ? 'Clustering…' : 'Run clustering'}
                </button>
              </div>

              {clusterError && (
                <div
                  className="chamfer-sm px-4 py-3 text-[12px] font-hud"
                  style={{ background: `${NEON.red}08`, border: `1px solid ${NEON.red}30`, color: NEON.red }}
                >
                  ⚠ {clusterError}
                </div>
              )}

              {mergeNotice && (
                <div
                  className="chamfer-sm px-4 py-3 text-[12px] font-hud"
                  style={{ background: `${NEON.green}06`, border: `1px solid ${NEON.green}40`, color: NEON.green }}
                >
                  ✓ {mergeNotice}
                </div>
              )}

              {clusterStats && (
                <div
                  className="chamfer-sm p-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] font-hud"
                  style={{ background: BG.surface, border: `1px dashed ${NEON.green}60`, color: '#8b94a7' }}
                >
                  <span>method <b style={{ color: NEON.green }}>{clusterStats.method || '—'}</b></span>
                  <span>threshold <b style={{ color: NEON.green }}>{num(clusterStats.threshold || 0.80).toFixed(2)}</b></span>
                  <span>scanned <b style={{ color: NEON.green }}>{num(clusterStats.candidates_scanned)}</b></span>
                  <span>clusters formed <b style={{ color: NEON.green }}>{num(clusterStats.clusters_formed)}</b></span>
                  <span>proposals created <b style={{ color: NEON.green }}>{num(clusterStats.proposals_created)}</b></span>
                  {num(clusterStats.avg_similarity) > 0 && (
                    <span>avg sim <b style={{ color: NEON.green }}>{num(clusterStats.avg_similarity).toFixed(2)}</b></span>
                  )}
                </div>
              )}

              {/* How it works */}
              <div
                className="chamfer-md overflow-hidden"
                style={{ background: BG.card, border: `1px solid ${NEON.cyan}18` }}
              >
                <div
                  className="px-4 py-3"
                  style={{ borderBottom: `1px solid ${NEON.cyan}12` }}
                >
                  <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.cyan }}>
                    ◇ How it works
                  </span>
                </div>
                <div className="p-3 flex flex-wrap items-stretch gap-1.5">
                  {PIPELINE_STEPS.map((s, i) => (
                    <div key={s.n} className="flex items-stretch gap-1.5 flex-1 min-w-[130px]">
                      <div
                        className="chamfer-sm p-2.5 flex-1"
                        style={{ background: BG.surface, border: `1px solid ${NEON.cyan}15` }}
                      >
                        <div className="text-[12px] font-bold font-hud" style={{ color: NEON.cyan }}>{s.n}</div>
                        <div className="text-[10px] mt-1" style={{ color: '#8b94a7' }}>{s.d}</div>
                      </div>
                      {i < PIPELINE_STEPS.length - 1 && (
                        <span className="self-center shrink-0" style={{ color: NEON.cyan }}>→</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Clusters panel */}
              <div
                className="chamfer-md overflow-hidden"
                style={{ background: BG.card, border: `1px solid ${NEON.purple}20` }}
              >
                <div
                  className="px-4 py-3 flex items-center gap-2"
                  style={{ borderBottom: `1px solid ${NEON.purple}12` }}
                >
                  <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.purple }}>
                    ◇ Clusters
                  </span>
                  <span
                    className="ml-auto text-[10px] font-hud px-2 py-0.5"
                    style={{ background: `${NEON.purple}12`, color: NEON.purple }}
                  >
                    {clusters.length} clusters · {proposals.length} proposals
                  </span>
                </div>
                <div className="p-3 flex flex-col gap-2">
                  {clustersLoading && clusters.length === 0 && (
                    <div className="flex items-center justify-center py-10 gap-2 text-[12px] font-hud" style={{ color: '#555' }}>
                      <Loader size={16} className="animate-spin" /> Loading clusters…
                    </div>
                  )}
                  {!clustersLoading && clusters.length === 0 && (
                    <div className="text-center py-10 text-[11px] font-hud" style={{ color: '#444' }}>
                      <Network size={20} className="mx-auto mb-2" style={{ color: '#333' }} />
                      No clusters yet — run clustering to group near-duplicate candidates.
                    </div>
                  )}
                  {clusters.map((cl, ci) => <ClusterCard key={cl.id || cl.label || `cluster-${ci}`} cluster={cl} />)}
                </div>
              </div>

              {/* Safety rails */}
              <div
                className="chamfer-md p-4 flex flex-col gap-2"
                style={{ background: BG.card, border: `1px solid ${NEON.yellow}25` }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.yellow }}>
                    ◇ Safety rails
                  </span>
                </div>
                {SAFETY_RAILS.map((r) => (
                  <div
                    key={r.title}
                    className="chamfer-sm p-3 text-[12px]"
                    style={{ background: BG.surface, border: `1px solid ${NEON.yellow}25`, color: '#8b94a7' }}
                  >
                    <b style={{ color: NEON.yellow }}>{r.title}</b> {r.body}
                  </div>
                ))}
              </div>
            </>
          ) : tab === 'compiled' ? (
            <>
              {/* ══ PHASE 4: SKILL COMPILER ══ */}
              <div className="flex items-start justify-between flex-wrap gap-3">
                <div>
                  <h2
                    className="flex items-center gap-2 text-lg font-bold tracking-wider font-hud"
                    style={{ color: NEON.cyan, filter: `drop-shadow(0 0 8px ${NEON.cyan}60)` }}
                  >
                    ◈ Skill compiler
                  </h2>
                  <p className="text-[11px] mt-1" style={{ color: '#555' }}>
                    Phase 4 — approved candidates become tested, versioned skills
                  </p>
                  <div className="flex gap-2 mt-2.5 flex-wrap">
                    <span
                      className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                      style={{ background: `${NEON.yellow}10`, color: NEON.yellow, border: `1px solid ${NEON.yellow}40` }}
                    >
                      ◉ disabled until you approve
                    </span>
                    <span
                      className="text-[10px] tracking-wider px-3 py-1 chamfer-sm font-hud uppercase"
                      style={{ background: `${NEON.cyan}10`, color: NEON.cyan, border: `1px solid ${NEON.cyan}35` }}
                    >
                      no live routing yet
                    </span>
                  </div>
                </div>
                <button
                  onClick={refreshVersions}
                  disabled={versionsLoading}
                  className="flex items-center gap-2 px-4 py-2 chamfer-sm text-[11px] font-bold tracking-wide font-hud uppercase transition-all"
                  style={{
                    background: `${NEON.cyan}12`,
                    border: `1px solid ${NEON.cyan}40`,
                    color: NEON.cyan,
                    opacity: versionsLoading ? 0.5 : 1,
                    cursor: versionsLoading ? 'not-allowed' : 'pointer',
                    boxShadow: `0 0 12px ${NEON.cyan}20`,
                    minHeight: '40px',
                  }}
                >
                  {versionsLoading ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  {versionsLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              {versionsError && (
                <div
                  className="chamfer-sm px-4 py-3 text-[12px] font-hud"
                  style={{ background: `${NEON.red}08`, border: `1px solid ${NEON.red}30`, color: NEON.red }}
                >
                  ⚠ {versionsError}
                </div>
              )}

              {versionNotice && (
                <div
                  className="chamfer-sm px-4 py-3 text-[12px] font-hud"
                  style={{ background: `${NEON.green}06`, border: `1px solid ${NEON.green}40`, color: NEON.green }}
                >
                  ✓ {versionNotice}
                </div>
              )}

              {/* Pipeline strip (static, approved preview content) */}
              <div
                className="chamfer-md overflow-hidden"
                style={{ background: BG.card, border: `1px solid ${NEON.cyan}18` }}
              >
                <div
                  className="px-4 py-3"
                  style={{ borderBottom: `1px solid ${NEON.cyan}12` }}
                >
                  <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.cyan }}>
                    ◇ Pipeline
                  </span>
                </div>
                <div className="p-3 flex flex-wrap items-stretch gap-1.5">
                  {COMPILER_PIPELINE.map((s, i) => (
                    <div key={s.n} className="flex items-stretch gap-1.5 flex-1 min-w-[130px]">
                      <div
                        className="chamfer-sm p-2.5 flex-1"
                        style={{ background: BG.surface, border: `1px solid ${NEON.cyan}15` }}
                      >
                        <div className="text-[12px] font-bold font-hud" style={{ color: NEON.cyan }}>{s.n}</div>
                        <div className="text-[10px] mt-1" style={{ color: '#8b94a7' }}>{s.d}</div>
                      </div>
                      {i < COMPILER_PIPELINE.length - 1 && (
                        <span className="self-center shrink-0" style={{ color: NEON.cyan }}>→</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Version cards */}
              <div
                className="chamfer-md overflow-hidden"
                style={{ background: BG.card, border: `1px solid ${NEON.cyan}20` }}
              >
                <div
                  className="px-4 py-3 flex items-center gap-2"
                  style={{ borderBottom: `1px solid ${NEON.cyan}12` }}
                >
                  <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.cyan }}>
                    ◇ Immutable versions
                  </span>
                  <span
                    className="ml-auto text-[10px] font-hud px-2 py-0.5"
                    style={{ background: `${NEON.cyan}12`, color: NEON.cyan }}
                  >
                    {versions.length} versions
                  </span>
                </div>
                <div className="p-3 flex flex-col gap-2">
                  {versionsLoading && versions.length === 0 && (
                    <div className="flex items-center justify-center py-10 gap-2 text-[12px] font-hud" style={{ color: '#555' }}>
                      <Loader size={16} className="animate-spin" /> Loading versions…
                    </div>
                  )}
                  {!versionsLoading && versions.length === 0 && (
                    <div className="text-center py-10 text-[11px] font-hud" style={{ color: '#444' }}>
                      <Cpu size={20} className="mx-auto mb-2" style={{ color: '#333' }} />
                      No compiled versions yet — open a promoted candidate and hit “Compile to skill”.
                    </div>
                  )}
                  {versions.map((ver, vi) => <VersionCard key={ver.id || `version-${vi}`} v={ver} />)}
                </div>
              </div>

              {/* Safety rails (static, approved preview content) */}
              <div
                className="chamfer-md p-4 flex flex-col gap-2"
                style={{ background: BG.card, border: `1px solid ${NEON.yellow}25` }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.yellow }}>
                    ◇ Safety rails
                  </span>
                </div>
                {COMPILER_SAFETY_RAILS.map((r) => (
                  <div
                    key={r.title}
                    className="chamfer-sm p-3 text-[12px]"
                    style={{ background: BG.surface, border: `1px solid ${NEON.yellow}25`, color: '#8b94a7' }}
                  >
                    <b style={{ color: NEON.yellow }}>{r.title}</b> {r.body}
                  </div>
                ))}
              </div>
            </>
          ) : tab === 'routing' ? (
            <RoutingTab />
          ) : tab === 'curator' ? (
            <CuratorTab />
          ) : (
            <>
              {/* Candidate panel */}
          <div
            className="chamfer-md overflow-hidden"
            style={{ background: BG.card, border: `1px solid ${NEON.magenta}20` }}
          >
            <div
              className="px-4 py-3 flex items-center gap-2"
              style={{ borderBottom: `1px solid ${NEON.magenta}12` }}
            >
              <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.magenta }}>
                ◇ Candidates
              </span>
              <span
                className="ml-auto text-[10px] font-hud px-2 py-0.5"
                style={{ background: `${NEON.magenta}12`, color: NEON.magenta }}
              >
                {activeList.length}
              </span>
            </div>
            <div className="p-3 flex flex-col gap-2">
              {loading && activeList.length === 0 && (
                <div className="flex items-center justify-center py-10 gap-2 text-[12px] font-hud" style={{ color: '#555' }}>
                  <Loader size={16} className="animate-spin" /> Loading candidates…
                </div>
              )}
              {!loading && activeList.length === 0 && !detailLoading && (
                <div className="text-center py-10 text-[11px] font-hud" style={{ color: '#444' }}>
                  <XCircle size={20} className="mx-auto mb-2" style={{ color: '#333' }} />
                  Nothing in {tab} right now. Candidates appear after a review run harvests eligible learning events.
                </div>
              )}
              {activeList.map(cand => <CandidateCard key={cand.id} c={cand} />)}
            </div>
          </div>

          {/* Review job strip */}
          <div
            className="chamfer-sm p-3.5 text-[12px] font-hud"
            style={{ background: BG.surface, border: `1px dashed ${NEON.purple}60`, color: '#8b94a7' }}
          >
            {latestJob ? (
              <>
                <span style={{ color: NEON.purple, fontWeight: 'bold' }}>
                  Review job #{String(latestJob.id || '').slice(0, 8) || '—'}
                </span>
                {' — '}scanned {num(latestJob.scanned_events ?? latestJob.scanned)} events ·{' '}
                {num(latestJob.candidates_assembled ?? latestJob.candidates)} candidates assembled ·{' '}
                {num(latestJob.dead_lettered ?? latestJob.dead_letters)} dead-lettered
                {latestJob.created_at && (
                  <div className="mt-1 text-[10px]" style={{ color: '#555' }}>{fmtDate(latestJob.created_at)}</div>
                )}
              </>
            ) : (
              running ? 'Running review…' : 'No review jobs yet — run a review to harvest eligible learning events.'
            )}
            <div className="mt-1.5 text-[10px]" style={{ color: '#555' }}>
              Eligibility is deterministic: verified successes, recoveries, your corrections. Praise alone never qualifies.
            </div>
          </div>

          {/* Two-tier loop diagram */}
          <div
            className="chamfer-md p-4"
            style={{ background: BG.card, border: `1px solid ${NEON.purple}20` }}
          >
            <div className="flex items-center gap-2 mb-3">
              <RefreshCw size={14} style={{ color: NEON.purple }} />
              <span className="text-[11px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.purple }}>
                ◇ The two-tier loop
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1 text-[10px] font-hud font-semibold">
              {[
                { label: 'HARVEST', color: NEON.cyan },
                { label: 'CANDIDATE', color: NEON.magenta },
                { label: 'AIMI DRAFTS', color: NEON.purple },
                { label: 'HAZ PROMOTES', color: NEON.green },
              ].map((step, i, arr) => (
                <div key={step.label} className="flex items-center gap-1">
                  <span
                    className="px-3 py-1.5 chamfer-sm"
                    style={{ background: `${step.color}10`, border: `1px solid ${step.color}30`, color: step.color }}
                  >
                    {step.label}
                  </span>
                  {i < arr.length - 1 && <span style={{ color: '#444' }}>→</span>}
                </div>
              ))}
              <span style={{ color: NEON.purple, marginLeft: 4 }}>↻</span>
            </div>
          </div>
            </>
          )}
        </>
      )}

      {/* ── Edit modal (LOCAL-ONLY: no edit endpoint in the contract) ── */}
      {showEdit && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowEdit(false)}
        >
          <div
            className="chamfer-md w-full p-5 flex flex-col gap-3"
            style={{ maxWidth: '480px', background: BG.card, border: `1px solid ${NEON.purple}40` }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Pencil size={14} style={{ color: NEON.purple }} />
              <span className="text-[12px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.purple }}>
                Edit draft
              </span>
            </div>
            <textarea
              value={editText}
              onChange={e => setEditText(e.target.value)}
              rows={8}
              className="w-full p-3 text-[13px] font-hud chamfer-sm outline-none resize-y"
              style={{ background: BG.surface, border: `1px solid ${NEON.purple}25`, color: '#c6cfe6' }}
              placeholder="One step per line…"
            />
            <p className="text-[10px] m-0" style={{ color: '#555' }}>
              Saved to the candidate on the server. Only candidates still in review can be edited.
            </p>
            <div className="flex gap-2">
              <button
                onClick={saveEdit}
                className="flex-1 py-2.5 chamfer-sm text-[12px] font-hud uppercase font-bold"
                style={{ background: `${NEON.purple}15`, border: `1px solid ${NEON.purple}60`, color: NEON.purple, cursor: 'pointer' }}
              >
                Save
              </button>
              <button
                onClick={() => setShowEdit(false)}
                className="flex-1 py-2.5 chamfer-sm text-[12px] font-hud uppercase"
                style={{ background: 'transparent', border: '1px solid #444', color: '#888', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reject modal ── */}
      {showReject && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowReject(false)}
        >
          <div
            className="chamfer-md w-full p-5 flex flex-col gap-3"
            style={{ maxWidth: '480px', background: BG.card, border: `1px solid ${NEON.red}40` }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <XCircle size={14} style={{ color: NEON.red }} />
              <span className="text-[12px] font-bold uppercase tracking-widest font-hud" style={{ color: NEON.red }}>
                Reject candidate
              </span>
            </div>
            <textarea
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
              rows={4}
              className="w-full p-3 text-[13px] font-hud chamfer-sm outline-none resize-y"
              style={{ background: BG.surface, border: `1px solid ${NEON.red}25`, color: '#c6cfe6' }}
              placeholder="Reason (recorded so it isn't proposed again without new evidence)…"
            />
            <div className="flex gap-2">
              <button
                onClick={handleReject}
                disabled={actioning}
                className="flex-1 py-2.5 chamfer-sm text-[12px] font-hud uppercase font-bold"
                style={{
                  background: `${NEON.red}12`, border: `1px solid ${NEON.red}60`, color: NEON.red,
                  opacity: actioning ? 0.5 : 1, cursor: actioning ? 'not-allowed' : 'pointer',
                }}
              >
                {actioning ? 'Rejecting…' : 'Confirm reject'}
              </button>
              <button
                onClick={() => setShowReject(false)}
                className="flex-1 py-2.5 chamfer-sm text-[12px] font-hud uppercase"
                style={{ background: 'transparent', border: '1px solid #444', color: '#888', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
