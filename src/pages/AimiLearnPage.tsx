import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "../components/AuthContext";
import {
  Brain, Plus, Trash2, Activity, AlertCircle, Loader,
  Sparkles, CheckCircle, XCircle, TrendingUp, Zap, Eye,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────
interface Pattern {
  id: string;
  pattern_key: string;
  pattern_type: string;
  description: string;
  occurrence_count: number;
  last_seen: string;
  confidence: number;
  auto_skill_id: string | null;
}

interface Observation {
  id: string;
  conversation_id: string | null;
  user_input: string;
  assistant_output: string;
  intent: string;
  entities: string;
  skillProposed: string | null;
  confidence: number;
  created_at: string;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  handler: string;
  parameters: string;
  enabled: number;
  confidence: number;
  auto_proposed: number;
  success_count: number;
  failure_count: number;
}

interface LearnStats {
  total_observations: number;
  total_patterns: number;
  high_confidence_patterns: number;
  auto_proposed_skills: number;
  validated_skills: number;
  avg_pattern_confidence: number;
}

interface Validation {
  id: string;
  skill_id: string;
  test_input: string;
  expected_output: string;
  actual_output: string;
  passed: number;
  exit_code: number;
  duration_ms: number;
  created_at: string;
}

// ─── Confidence Bar ─────────────────────────────────────────────
function ConfidenceBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 70 ? "from-green-400 to-emerald-500" :
    pct >= 40 ? "from-amber-400 to-yellow-500" :
    "from-red-400 to-rose-500";
  const glow =
    pct >= 70 ? "shadow-[0_0_6px_rgba(16,185,129,0.3)]" :
    pct >= 40 ? "shadow-[0_0_6px_rgba(245,158,11,0.2)]" :
    "shadow-[0_0_6px_rgba(239,68,68,0.15)]";

  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[10px] font-mono text-gray-500 w-16">{label}</span>}
      <div className="flex-1 h-1.5 bg-gray-800/60 rounded overflow-hidden">
        <div
          className={`h-full bg-gradient-to-r ${color} ${glow} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] font-mono text-gray-400 w-10 text-right">{pct}%</span>
    </div>
  );
}

// ─── Card Wrapper ────────────────────────────────────────────────
function NeonCard({ children, borderColor = "cyan" }: { children: React.ReactNode; borderColor?: string }) {
  const borderMap: Record<string, string> = {
    cyan: "border-cyan-500/20 hover:border-cyan-500/40",
    purple: "border-purple-500/20 hover:border-purple-500/40",
    pink: "border-pink-500/20 hover:border-pink-500/40",
    green: "border-green-500/20 hover:border-green-500/40",
  };
  return (
    <div className={`rounded-xl border ${borderMap[borderColor] || borderMap.cyan} bg-gray-900/40 backdrop-blur-sm transition-all duration-200`}>
      {children}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────
export default function AimiLearnPage() {
  const { token } = useAuth();
  const [stats, setStats] = useState<LearnStats | null>(null);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [autoSkills, setAutoSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"patterns" | "skills" | "observations">("patterns");
  const [proposing, setProposing] = useState(false);
  const [validating, setValidating] = useState<string | null>(null);
  const [validationResults, setValidationResults] = useState<Record<string, Validation>>({});
  const [showProposeModal, setShowProposeModal] = useState(false);
  const [newSkill, setNewSkill] = useState({ name: "", description: "", handler: "", category: "auto-learned" });
  const wsRef = useRef<WebSocket | null>(null);

  function api(path: string, opts: RequestInit = {}) {
    return fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      cache: "no-store",
    });
  }

  const loadAll = useCallback(() => {
    Promise.all([
      api("/api/learn/stats").then((r) => r.ok ? r.json() : null),
      api("/api/learn/patterns?limit=50").then((r) => r.ok ? r.json() : []),
      api("/api/learn/observations?limit=30").then((r) => r.ok ? r.json() : []),
      api("/api/skills").then((r) => r.ok ? r.json() : []),
    ])
      .then(([s, p, o, sk]: [LearnStats | null, Pattern[], Observation[], Skill[]]) => {
        setStats(s);
        setPatterns(p || []);
        setObservations(o || []);
        setAutoSkills((sk || []).filter((s) => s.auto_proposed === 1));
      })
      .catch(() => setError("Failed to load learning data"))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    loadAll();

    // WebSocket for live updates
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type?.startsWith("learn:") || msg.type?.startsWith("skill:")) {
        loadAll();
      }
    };
    return () => ws.close();
  }, [loadAll]);

  // ─── Actions ────────────────────────────────────────────────────
  async function autoPropose() {
    setProposing(true);
    setError(null);
    try {
      const r = await api("/api/skills/auto-propose", { method: "POST", body: JSON.stringify({}) });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Auto-propose failed");
      }
      const result = await r.json();
      if (result.proposed === false) {
        setError(result.reason || "No skill could be proposed from current data");
      }
      loadAll();
    } catch (e: any) { setError(e.message); }
    finally { setProposing(false); }
  }

  async function manualPropose() {
    if (!newSkill.name || !newSkill.handler) return;
    setProposing(true);
    setError(null);
    try {
      const r = await api("/api/skills/auto-propose", {
        method: "POST",
        body: JSON.stringify(newSkill),
      });
      if (!r.ok) throw new Error("Propose failed");
      setShowProposeModal(false);
      setNewSkill({ name: "", description: "", handler: "", category: "auto-learned" });
      loadAll();
    } catch (e: any) { setError(e.message); }
    finally { setProposing(false); }
  }

  async function validateSkill(skillId: string, testInput?: string) {
    setValidating(skillId);
    setError(null);
    try {
      const r = await api(`/api/skills/${skillId}/validate`, {
        method: "POST",
        body: JSON.stringify({
          test_input: testInput || "test execution",
        }),
      });
      if (!r.ok) throw new Error("Validation failed");
      const result = await r.json();
      setValidationResults((prev) => ({ ...prev, [skillId]: result }));
      loadAll();
    } catch (e: any) { setError(e.message); }
    finally { setValidating(null); }
  }

  async function provideFeedback(skillId: string, success: boolean) {
    try {
      await api(`/api/skills/${skillId}/feedback`, {
        method: "POST",
        body: JSON.stringify({ success }),
      });
      loadAll();
    } catch (e: any) { setError(e.message); }
  }

  async function deletePattern(id: string) {
    try {
      await api(`/api/learn/patterns/${id}`, { method: "DELETE" });
      loadAll();
    } catch (e: any) { setError(e.message); }
  }

  // ─── Observe (manual test) ─────────────────────────────────────
  const [obsInput, setObsInput] = useState("");
  async function submitObservation() {
    if (!obsInput.trim()) return;
    try {
      await api("/api/learn/observe", {
        method: "POST",
        body: JSON.stringify({
          user_input: obsInput,
          intent: "manual-test",
        }),
      });
      setObsInput("");
      loadAll();
    } catch (e: any) { setError(e.message); }
  }

  // ─── Render ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader size={24} className="animate-spin text-cyan-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Brain size={22} className="text-cyan-400 drop-shadow-[0_0_8px_rgba(6,182,212,0.6)]" />
        <h1 className="text-xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-purple-400 to-pink-400">
          AIMI LEARN
        </h1>
        <span className="text-[10px] font-mono text-gray-600 ml-2">Self-Learning Skill Loop</span>
        <div className="flex-1" />
        <button
          onClick={() => setShowProposeModal(!showProposeModal)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500/20 transition"
        >
          <Sparkles size={14} /> Propose Skill
        </button>
        <button
          onClick={autoPropose}
          disabled={proposing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 transition disabled:opacity-50"
        >
          {proposing ? <Loader size={14} className="animate-spin" /> : <Zap size={14} />}
          Auto-Analyze
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 rounded-lg bg-red-950/40 border border-red-500/30 text-red-400 text-xs">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {/* Stats Row */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
          {[
            { label: "Observations", value: stats.total_observations, icon: Eye, color: "text-cyan-400" },
            { label: "Patterns", value: stats.total_patterns, icon: Activity, color: "text-purple-400" },
            { label: "High Conf.", value: stats.high_confidence_patterns, icon: TrendingUp, color: "text-green-400" },
            { label: "Auto-Skills", value: stats.auto_proposed_skills, icon: Sparkles, color: "text-pink-400" },
            { label: "Validated", value: stats.validated_skills, icon: CheckCircle, color: "text-emerald-400" },
            { label: "Avg Conf.", value: `${Math.round(stats.avg_pattern_confidence * 100)}%`, icon: Brain, color: "text-amber-400" },
          ].map((s) => (
            <NeonCard key={s.label} borderColor="cyan">
              <div className="p-3 flex flex-col items-center">
                <s.icon size={16} className={`${s.color} mb-1.5`} />
                <span className="text-lg font-bold mono text-gray-100">{s.value}</span>
                <span className="text-[9px] uppercase tracking-wide text-gray-500 mt-0.5">{s.label}</span>
              </div>
            </NeonCard>
          ))}
        </div>
      )}

      {/* Observe Input */}
      <NeonCard borderColor="cyan">
        <div className="p-3 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">Feed Observation</div>
          </div>
          <div className="flex gap-2">
            <input
              value={obsInput}
              onChange={(e) => setObsInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitObservation()}
              placeholder="Type a test user input for Aimi to observe and learn from..."
              className="flex-1 px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-cyan-500/50"
            />
            <button
              onClick={submitObservation}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white transition"
            >
              Observe
            </button>
          </div>
        </div>
      </NeonCard>

      {/* Tab Switcher */}
      <div className="flex items-center gap-1 mb-4 mt-4">
        {([
          { key: "patterns", label: "Patterns", icon: Activity, color: "purple" },
          { key: "skills", label: "Auto-Proposed Skills", icon: Sparkles, color: "pink" },
          { key: "observations", label: "Observations Log", icon: Eye, color: "cyan" },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition ${
              activeTab === t.key
                ? `bg-${t.color}-500/10 border border-${t.color}-500/30 text-${t.color}-400`
                : "text-gray-500 hover:text-gray-300 border border-transparent"
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* ─── Patterns Tab ────────────────────────────────── */}
      {activeTab === "patterns" && (
        <div className="space-y-2">
          {patterns.length === 0 ? (
            <div className="text-center py-12 text-gray-600 text-sm">
              No patterns detected yet. Feed observations to build patterns.
            </div>
          ) : (
            patterns.map((p) => (
              <NeonCard key={p.id} borderColor="purple">
                <div className="p-4 flex items-start gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-mono text-purple-300">{p.pattern_key}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                        {p.pattern_type}
                      </span>
                      <span className="text-[9px] text-gray-600">×{p.occurrence_count}</span>
                    </div>
                    <p className="text-xs text-gray-500 mb-2">{p.description}</p>
                    <ConfidenceBar value={p.confidence} label="confidence" />
                    {p.auto_skill_id && (
                      <span className="inline-flex items-center gap-1 mt-2 text-[10px] text-emerald-400">
                        <CheckCircle size={10} /> Linked skill: {p.auto_skill_id.slice(0, 8)}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => deletePattern(p.id)}
                    className="text-gray-600 hover:text-red-400 transition"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </NeonCard>
            ))
          )}
        </div>
      )}

      {/* ─── Skills Tab ──────────────────────────────────── */}
      {activeTab === "skills" && (
        <div className="space-y-3">
          {autoSkills.length === 0 ? (
            <div className="text-center py-12 text-gray-600 text-sm">
              No auto-proposed skills yet. Use "Auto-Analyze" to scan observations and propose skills.
            </div>
          ) : (
            autoSkills.map((s) => {
              const valResult = validationResults[s.id];
              return (
                <NeonCard key={s.id} borderColor="pink">
                  <div className="p-4">
                    <div className="flex items-start gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-bold text-pink-300">{s.name}</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-pink-500/10 text-pink-400 border border-pink-500/20">
                            {s.category}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mb-2">{s.description}</p>

                        {/* Stats row */}
                        <div className="flex items-center gap-4 mb-2 text-[10px] font-mono">
                          <span className="text-green-400 flex items-center gap-1">
                            <CheckCircle size={10} /> {s.success_count} pass
                          </span>
                          <span className="text-red-400 flex items-center gap-1">
                            <XCircle size={10} /> {s.failure_count} fail
                          </span>
                        </div>

                        <ConfidenceBar value={s.confidence || 0.3} label="skill conf" />

                        {/* Handler preview (expandable) */}
                        <details className="mt-2">
                          <summary className="text-[10px] text-gray-600 cursor-pointer hover:text-gray-400">
                            View handler code
                          </summary>
                          <pre className="mt-1 p-2 rounded-lg bg-gray-950/60 border border-gray-800 text-[10px] font-mono text-gray-400 overflow-x-auto">
                            {s.handler}
                          </pre>
                        </details>

                        {/* Validation result */}
                        {valResult && (
                          <div className="mt-2 p-2 rounded-lg bg-gray-950/40 border border-gray-800 text-[10px]">
                            <div className="flex items-center gap-2 mb-1">
                              {valResult.passed ? (
                                <CheckCircle size={12} className="text-green-400" />
                              ) : (
                                <XCircle size={12} className="text-red-400" />
                              )}
                              <span className={valResult.passed ? "text-green-400" : "text-red-400"}>
                                {valResult.passed ? "PASSED" : "FAILED"}
                              </span>
                              <span className="text-gray-600">
                                ({valResult.duration_ms}ms · pass rate: {valResult.pass_rate})
                              </span>
                            </div>
                            <pre className="text-gray-500 font-mono whitespace-pre-wrap">
                              {valResult.actual_output?.slice(0, 200)}
                            </pre>
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col gap-1.5">
                        <button
                          onClick={() => validateSkill(s.id)}
                          disabled={validating === s.id}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 transition disabled:opacity-50"
                        >
                          {validating === s.id ? <Loader size={10} className="animate-spin" /> : <Zap size={10} />}
                          Validate
                        </button>
                        <button
                          onClick={() => provideFeedback(s.id, true)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-green-500/10 border border-green-500/30 text-green-400 hover:bg-green-500/20 transition"
                        >
                          <CheckCircle size={10} /> Pass
                        </button>
                        <button
                          onClick={() => provideFeedback(s.id, false)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition"
                        >
                          <XCircle size={10} /> Fail
                        </button>
                      </div>
                    </div>
                  </div>
                </NeonCard>
              );
            })
          )}
        </div>
      )}

      {/* ─── Observations Tab ────────────────────────────── */}
      {activeTab === "observations" && (
        <div className="space-y-1">
          {observations.length === 0 ? (
            <div className="text-center py-12 text-gray-600 text-sm">
              No observations logged yet. Use the "Feed Observation" box above.
            </div>
          ) : (
            observations.map((o) => (
              <div
                key={o.id}
                className="flex items-start gap-3 p-2 rounded-lg bg-gray-900/30 border border-gray-800/50 hover:border-gray-700/50 transition"
              >
                <div className="text-[9px] font-mono text-gray-700 mt-0.5 w-16 shrink-0">
                  {new Date(o.created_at).toLocaleTimeString().slice(0, 5)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-300 truncate">{o.user_input}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {o.intent && (
                      <span className="text-[9px] text-purple-400 font-mono">intent: {o.intent}</span>
                    )}
                    {o.skillProposed && (
                      <span className="text-[9px] text-cyan-400 font-mono">→ {o.skillProposed}</span>
                    )}
                  </div>
                </div>
                <ConfidenceBar value={o.confidence} />
              </div>
            ))
          )}
        </div>
      )}

      {/* ─── Manual Propose Modal ────────────────────────── */}
      {showProposeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <NeonCard borderColor="purple">
            <div className="p-6 w-full max-w-lg">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles size={16} className="text-purple-400" />
                <h2 className="text-sm font-bold text-purple-300">Propose New Skill</h2>
              </div>
              <div className="space-y-2">
                <input
                  value={newSkill.name}
                  onChange={(e) => setNewSkill({ ...newSkill, name: e.target.value })}
                  placeholder="Skill name (e.g. auto-format-json)"
                  className="w-full px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500/50"
                />
                <input
                  value={newSkill.description}
                  onChange={(e) => setNewSkill({ ...newSkill, description: e.target.value })}
                  placeholder="Description"
                  className="w-full px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-200 focus:outline-none focus:border-purple-500/50"
                />
                <textarea
                  value={newSkill.handler}
                  onChange={(e) => setNewSkill({ ...newSkill, handler: e.target.value })}
                  placeholder="Handler function: async (input) => { return { result: input } }"
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg bg-gray-800/60 border border-gray-700 text-sm text-gray-200 font-mono focus:outline-none focus:border-purple-500/50"
                />
                <div className="flex gap-2 justify-end pt-2">
                  <button
                    onClick={() => setShowProposeModal(false)}
                    className="px-4 py-2 rounded-lg text-xs font-semibold text-gray-400 border border-gray-700 hover:bg-gray-800/50 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={manualPropose}
                    disabled={proposing || !newSkill.name || !newSkill.handler}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white transition disabled:opacity-50"
                  >
                    {proposing ? <Loader size={12} className="animate-spin" /> : "Create Skill"}
                  </button>
                </div>
              </div>
            </div>
          </NeonCard>
        </div>
      )}
    </div>
  );
}
