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
} from 'lucide-react';

const TABS = [
  { key: 'review', label: 'REVIEW' },
  { key: 'testing', label: 'TESTING' },
  { key: 'rejected', label: 'REJECTED' },
  { key: 'promoted', label: 'PROMOTED' },
  { key: 'clusters', label: 'CLUSTERS' },
  { key: 'compiled', label: 'COMPILED' },
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
              const tabCount = t.key === 'clusters' ? clusters.length : t.key === 'compiled' ? versions.length : (lists[t.key] || []).length;
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
