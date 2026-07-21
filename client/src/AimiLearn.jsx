import { useState, useEffect, useCallback } from 'react';
import { NEON, BG, GLOW } from './theme';
import { cachedFetch, invalidateCache } from './dataCache';
import { usePolling } from './usePolling';
import { Brain, Target, Zap, TrendingUp, CheckCircle, XCircle, Sparkles, Eye, Cpu } from 'lucide-react';

export default function AimiLearn() {
  const [stats, setStats] = useState(null);
  const [patterns, setPatterns] = useState([]);
  const [observations, setObservations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [proposeLoading, setProposeLoading] = useState(false);
  const [validating, setValidating] = useState(null);
  const [testInput, setTestInput] = useState('');
  const [validationResults, setValidationResults] = useState({});

  const load = useCallback(async () => {
    try {
      const [s, p, o] = await Promise.all([
        cachedFetch('/api/learn/stats'),
        cachedFetch('/api/learn/patterns'),
        cachedFetch('/api/learn/observations'),
      ]);
      setStats(s);
      setPatterns(p);
      setObservations(o);
    } catch (err) {
      console.error('AimiLearn load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  usePolling(load, 30000);

  const handleAutoPropose = async () => {
    setProposeLoading(true);
    try {
      const token = localStorage.getItem('cf_token');
      const res = await fetch('/api/skills/auto-propose', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ min_confidence: 0.3, min_count: 2 }),
      });
      if (res.ok) {
        const result = await res.json();
        invalidateCache('/api/learn/stats');
        load();
        if (result.id) {
          alert(`Aimi proposed skill: ${result.name}\nBased on ${result.based_on?.observation_count} observations of intent: ${result.based_on?.intent}`);
        } else {
          alert(result.message || 'No new skills to propose — need more recurring patterns.');
        }
      }
    } catch (err) {
      console.error('Auto-propose error:', err);
      alert('Failed to propose skill: ' + err.message);
    } finally {
      setProposeLoading(false);
    }
  };

  const handleValidate = async (skillId) => {
    if (!testInput.trim()) {
      alert('Enter test input first');
      return;
    }
    setValidating(skillId);
    try {
      const token = localStorage.getItem('cf_token');
      const res = await fetch(`/api/skills/${skillId}/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ test_input: testInput }),
      });
      if (res.ok) {
        const result = await res.json();
        setValidationResults(prev => ({ ...prev, [skillId]: result }));
        invalidateCache('/api/learn/stats');
        load();
      }
    } catch (err) {
      console.error('Validation error:', err);
    } finally {
      setValidating(null);
    }
  };

  // ── Stat card ──
  const StatCard = ({ icon: Icon, label, value, color, sub }) => (
    <div
      className="flex-1 min-w-[140px] rounded-lg p-4 flex flex-col gap-2"
      style={{
        background: BG.card,
        border: `1px solid ${color}20`,
        boxShadow: `inset 0 0 30px ${color}05, 0 0 12px ${color}08`,
      }}
    >
      <div className="flex items-center gap-2">
        <Icon size={16} style={{ color, filter: `drop-shadow(0 0 4px ${color}80)` }} />
        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: '#666' }}>{label}</span>
      </div>
      <span className="text-2xl font-bold" style={{ color }}>{loading ? '…' : value}</span>
      {sub && <span className="text-[10px]" style={{ color: '#555' }}>{sub}</span>}
    </div>
  );

  // ── Confidence bar ──
  const ConfidenceBar = ({ confidence }) => {
    const pct = Math.round(confidence * 100);
    const color = pct >= 70 ? NEON.green : pct >= 40 ? NEON.yellow : NEON.red;
    return (
      <div className="flex items-center gap-2">
        <div className="h-2 flex-1 rounded-full overflow-hidden" style={{ background: `${color}15` }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}` }}
          />
        </div>
        <span className="text-[10px] font-mono w-8 text-right" style={{ color }}>{pct}%</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6" style={{ minHeight: '100%' }}>
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-wider font-hud"
            style={{ color: NEON.cyan, filter: `drop-shadow(0 0 8px ${NEON.cyan}60)` }}>
            <Brain size={24} />
            Aimi Self-Learning
          </h1>
          <p className="text-[11px] mt-1" style={{ color: '#555' }}>
            Pattern detection → skill proposal → validation → confidence loop
          </p>
        </div>
        <button
          onClick={handleAutoPropose}
          disabled={proposeLoading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] font-bold tracking-wide transition-all"
          style={{
            background: `${NEON.purple}15`,
            border: `1px solid ${NEON.purple}40`,
            color: NEON.purple,
            opacity: proposeLoading ? 0.5 : 1,
            cursor: proposeLoading ? 'not-allowed' : 'pointer',
            boxShadow: `0 0 12px ${NEON.purple}20`,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = `${NEON.purple}25`; e.currentTarget.style.borderColor = NEON.purple; }}
          onMouseLeave={e => { e.currentTarget.style.background = `${NEON.purple}15`; e.currentTarget.style.borderColor = `${NEON.purple}40`; }}
        >
          <Sparkles size={14} />
          {proposeLoading ? 'Proposing…' : 'Auto-Propose Skill'}
        </button>
      </div>

      {/* ── Stats row ── */}
      <div className="flex flex-wrap gap-3">
        <StatCard icon={Eye} label="Observations" value={stats?.total_observations ?? 0} color={NEON.cyan} />
        <StatCard icon={TrendingUp} label="Patterns" value={stats?.total_patterns ?? 0} color={NEON.magenta} sub="detected from observations" />
        <StatCard icon={Sparkles} label="Auto-Proposed" value={stats?.auto_proposed_skills ?? 0} color={NEON.purple} sub="skills proposed by Aimi" />
        <StatCard icon={CheckCircle} label="Validated" value={stats?.validated_skills ?? 0} color={NEON.green} sub="skills passing validation" />
        <StatCard icon={Cpu} label="Avg Confidence" value={`${Math.round((stats?.avg_pattern_confidence ?? 0) * 100)}%`} color={NEON.yellow} />
      </div>

      {/* ── Two column: Patterns | Observations ── */}
      <div className="flex flex-col lg:flex-row gap-4 flex-1">
        {/* Patterns */}
        <div
          className="flex-1 rounded-lg overflow-hidden flex flex-col"
          style={{ background: BG.card, border: `1px solid ${NEON.magenta}15` }}
        >
          <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: `1px solid ${NEON.magenta}10` }}>
            <Target size={14} style={{ color: NEON.magenta }} />
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: NEON.magenta }}>Detected Patterns</span>
            <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: `${NEON.magenta}15`, color: NEON.magenta }}>{patterns.length}</span>
          </div>
          <div className="flex-1 overflow-auto p-3 flex flex-col gap-2" style={{ maxHeight: '400px' }}>
            {patterns.length === 0 && !loading && (
              <div className="text-center py-12 text-[11px]" style={{ color: '#444' }}>
                No patterns yet. Aimi observes interactions and detects recurring patterns over time.
              </div>
            )}
            {patterns.map(p => (
              <div
                key={p.id}
                className="rounded-lg p-3 flex flex-col gap-2"
                style={{ background: BG.surface, border: `1px solid ${NEON.magenta}08` }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                    style={{ background: `${NEON.cyan}10`, color: NEON.cyan, border: `1px solid ${NEON.cyan}20` }}
                  >
                    {p.pattern_type || 'keyword'}
                  </span>
                  <span className="text-[11px] flex-1 truncate" style={{ color: '#aaa' }}>{p.pattern_key}</span>
                  {p.auto_skill_id && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1" style={{ background: `${NEON.green}10`, color: NEON.green }}>
                      <Zap size={8} /> skill
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[10px]" style={{ color: '#555' }}>
                  <span>Seen {p.occurrence_count}x</span>
                  <span className="text-[9px]">{new Date(p.last_seen).toLocaleDateString()}</span>
                </div>
                <ConfidenceBar confidence={p.confidence} />
              </div>
            ))}
          </div>
        </div>

        {/* Observations */}
        <div
          className="flex-1 rounded-lg overflow-hidden flex flex-col"
          style={{ background: BG.card, border: `1px solid ${NEON.cyan}15` }}
        >
          <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: `1px solid ${NEON.cyan}10` }}>
            <Eye size={14} style={{ color: NEON.cyan }} />
            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: NEON.cyan }}>Recent Observations</span>
            <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: `${NEON.cyan}15`, color: NEON.cyan }}>{observations.length}</span>
          </div>
          <div className="flex-1 overflow-auto p-3 flex flex-col gap-2" style={{ maxHeight: '400px' }}>
            {observations.length === 0 && !loading && (
              <div className="text-center py-12 text-[11px]" style={{ color: '#444' }}>
                No observations recorded yet. Observations are logged when Aimi processes user interactions.
              </div>
            )}
            {observations.map(o => (
              <div
                key={o.id}
                className="rounded-lg p-3 flex flex-col gap-1.5"
                style={{ background: BG.surface, border: `1px solid ${NEON.cyan}08` }}
              >
                <div className="flex items-center gap-2">
                  {o.intent && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: `${NEON.purple}10`, color: NEON.purple, border: `1px solid ${NEON.purple}20` }}>
                      {o.intent}
                    </span>
                  )}
                  {o.skillProposed && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1" style={{ background: `${NEON.purple}10`, color: NEON.purple }}>
                      <Sparkles size={8} /> {o.skillProposed}
                    </span>
                  )}
                  {o.confidence > 0 && <ConfidenceBar confidence={o.confidence} />}
                </div>
                <div className="text-[11px] truncate" style={{ color: '#aaa' }}>→ {o.user_input}</div>
                {o.assistant_output && (
                  <div className="text-[10px] truncate" style={{ color: '#555' }}>↳ {o.assistant_output}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Validation panel ── */}
      <div
        className="rounded-lg p-4 flex flex-col gap-3"
        style={{ background: BG.card, border: `1px solid ${NEON.green}15`, boxShadow: `inset 0 0 30px ${NEON.green}03` }}
      >
        <div className="flex items-center gap-2">
          <CheckCircle size={14} style={{ color: NEON.green }} />
          <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: NEON.green }}>Skill Validation Sandbox</span>
        </div>
        <p className="text-[10px]" style={{ color: '#555' }}>
          Test Aimi's auto-proposed skills against inputs. Pass/fail updates confidence scores in real time.
        </p>
        <div className="flex gap-2 items-center">
          <input
            value={testInput}
            onChange={e => setTestInput(e.target.value)}
            placeholder="Enter test input to validate against skill handler…"
            className="flex-1 px-3 py-2 rounded-lg text-[12px] outline-none"
            style={{
              background: BG.surface,
              border: `1px solid ${NEON.green}20`,
              color: '#ccc',
            }}
          />
        </div>
        {Object.entries(validationResults).map(([skillId, result]) => (
          <div
            key={skillId}
            className="rounded-lg p-3 flex items-center gap-3"
            style={{
              background: BG.surface,
              border: `1px solid ${result.passed ? NEON.green : NEON.red}20`,
            }}
          >
            {result.passed ? (
              <CheckCircle size={14} style={{ color: NEON.green }} />
            ) : (
              <XCircle size={14} style={{ color: NEON.red }} />
            )}
            <div className="flex-1 flex flex-col gap-0.5">
              <span className="text-[11px] font-mono" style={{ color: '#aaa' }}>Output: {result.actual_output}</span>
              <span className="text-[10px]" style={{ color: '#555' }}>
                Pass rate: <span style={{ color: result.passed ? NEON.green : NEON.red }}>{result.pass_rate || '0/0'}</span>
                {' • '}Confidence: <span style={{ color: NEON.yellow }}>{Math.round(result.confidence * 100)}%</span>
                {' • '}{result.duration_ms}ms
              </span>
            </div>
          </div>
        ))}
        <div className="flex gap-2 items-center text-[10px]" style={{ color: '#555' }}>
          <span className="px-2 py-1 rounded" style={{ background: `${NEON.cyan}08` }}>
            💡 Aimi runs the skill handler in a sandboxed eval. Pass results adjust confidence via incremental Bayesian update.
          </span>
        </div>
      </div>

      {/* ── Loop diagram ── */}
      <div
        className="rounded-lg p-4"
        style={{ background: BG.card, border: `1px solid ${NEON.purple}10` }}
      >
        <div className="flex items-center gap-2 mb-3">
          <Brain size={14} style={{ color: NEON.purple }} />
          <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: NEON.purple }}>The Self-Learning Loop</span>
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          {[
            { label: 'Observe', color: NEON.cyan },
            { label: 'Extract Pattern', color: NEON.magenta },
            { label: 'Propose Skill', color: NEON.purple },
            { label: 'Validate', color: NEON.yellow },
            { label: 'Update Confidence', color: NEON.green },
            { label: 'Auto-Invoke', color: NEON.cyan },
          ].map((step, i, arr) => (
            <div key={step.label} className="flex items-center gap-1">
              <span
                className="px-3 py-1.5 rounded-lg font-medium"
                style={{
                  background: `${step.color}10`,
                  border: `1px solid ${step.color}30`,
                  color: step.color,
                }}
              >
                {step.label}
              </span>
              {i < arr.length - 1 && <span style={{ color: '#444' }}>→</span>}
            </div>
          ))}
          <span style={{ color: NEON.purple, marginLeft: 4 }}>↻ loop</span>
        </div>
      </div>
    </div>
  );
}
