import React, { useState, useEffect, useCallback } from 'react';
import { Link2, Play, Plus, Trash2, Sparkles, ChevronDown, ChevronRight, Zap, Loader, X } from 'lucide-react';
import { NEON, BG, FONTS } from './theme';
import { useAuth } from './AuthContext';
import { useWebSocket } from './useWebSocket';
import { usePersonas } from './PersonaContext';

const API = '/api/chains';

// ─── Chain Pipeline Visualizer ──────────────────────────────
function StepCard({ step, index, isActive, isDone, hasError, type }) {
  const [expanded, setExpanded] = useState(false);
  const name = type === 'skill' ? step.skill_name : step.tool_name;
  const bgBorder = hasError ? NEON.pink : isDone ? NEON.green : isActive ? NEON.cyan : '#333';
  const glowColor = hasError ? NEON.pink : isDone ? NEON.green : isActive ? NEON.cyan : 'transparent';

  return (
    <div style={{
      border: `1px solid ${bgBorder}`,
      borderRadius: '8px',
      padding: '12px 14px',
      marginBottom: '8px',
      background: 'rgba(0,0,0,0.4)',
      boxShadow: isActive || isDone ? `0 0 12px ${glowColor}40` : 'none',
      transition: 'all 0.3s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
           onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown size={14} style={{ color: '#888' }} /> : <ChevronRight size={14} style={{ color: '#888' }} />}
        <span style={{ color: NEON.cyan, fontFamily: FONTS.mono, fontSize: '11px' }}>#{index + 1}</span>
        <span style={{ color: '#eee', fontSize: '13px', fontWeight: 600 }}>{name || step.name || `Step ${index + 1}`}</span>
        {isActive && <Loader size={12} className="animate-spin" style={{ color: NEON.cyan }} />}
        {isDone && !hasError && <span style={{ color: NEON.green, fontSize: '11px' }}>✓</span>}
        {hasError && <span style={{ color: NEON.pink, fontSize: '11px' }}>✗</span>}
      </div>
      {expanded && (
        <div style={{ marginTop: '8px', paddingLeft: '22px', fontSize: '11px', fontFamily: FONTS.mono, color: '#888' }}>
          {step.input_mapping && Object.keys(step.input_mapping).length > 0 && (
            <div style={{ marginBottom: '4px' }}>
              <span style={{ color: NEON.yellow }}>input_mapping:</span>{' '}
              {Object.entries(step.input_mapping).map(([k, v]) => `${k}=${v}`).join(', ')}
            </div>
          )}
          {step.input_override && Object.keys(step.input_override).length > 0 && (
            <div style={{ marginBottom: '4px' }}>
              <span style={{ color: NEON.orange }}>input_override:</span>{' '}
              {JSON.stringify(step.input_override)}
            </div>
          )}
          {step.continue_on_error && <span style={{ color: NEON.pink }}>continue_on_error: true</span>}
        </div>
      )}
    </div>
  );
}

function PipelineViz({ chain, type, runState }) {
  const steps = chain?.steps || [];
  if (steps.length === 0) return <div style={{ color: '#666', fontSize: '12px', padding: '20px', textAlign: 'center' }}>No steps defined</div>;

  return (
    <div>
      {steps.map((step, i) => {
        const stepResult = runState?.results?.[i];
        const isActive = runState?.runningStep === i;
        const isDone = stepResult !== undefined;
        const hasError = stepResult?.ok === false || !!stepResult?.error;
        return (
          <React.Fragment key={i}>
            <StepCard step={step} index={i} type={type} isActive={isActive} isDone={isDone} hasError={hasError} />
            {i < steps.length - 1 && (
              <div style={{ textAlign: 'center', color: NEON.purple, fontSize: '16px', marginBottom: '4px' }}>↓</div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Intent Designer Input ──────────────────────────────────
function AimiIntentBox({ type, onGenerated }) {
  const { companionName } = usePersonas();
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);

  const generate = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setError('');
    setPreview(null);
    try {
      const token = localStorage.getItem('cf_token');
      const resp = await fetch(`${API}/${type === 'skill' ? 'skills' : 'tools'}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt }),
      });
      const data = await resp.json();
      if (data.error) { setError(data.error); return; }
      setPreview(data.chain);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const saveChain = async () => {
    if (!preview) return;
    setLoading(true);
    try {
      const token = localStorage.getItem('cf_token');
      const resp = await fetch(`${API}/${type === 'skill' ? 'skills' : 'tools'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: preview.name, description: preview.description, steps: preview.steps }),
      });
      const data = await resp.json();
      if (data.error) { setError(data.error); return; }
      setPreview(null);
      setPrompt('');
      onGenerated();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      border: `1px solid ${NEON.purple}40`,
      borderRadius: '10px',
      padding: '16px',
      marginBottom: '16px',
      background: `linear-gradient(135deg, rgba(168,85,247,0.08), rgba(0,0,0,0.4))`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <Sparkles size={16} style={{ color: NEON.purple }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: NEON.purple }}>{companionName} Chain Designer</span>
      </div>
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder={type === 'skill'
          ? 'e.g. "Research the latest AI frameworks and generate a landing page from the findings"'
          : 'e.g. "List all agents, then create a task for each agent that is inactive"'}
        style={{
          width: '100%',
          minHeight: '60px',
          background: 'rgba(0,0,0,0.5)',
          border: `1px solid ${NEON.purple}30`,
          borderRadius: '6px',
          padding: '10px',
          color: '#eee',
          fontFamily: FONTS.mono,
          fontSize: '12px',
          resize: 'vertical',
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
        <button onClick={generate} disabled={loading || !prompt.trim()}
          style={btnStyle(NEON.purple, loading || !prompt.trim())}>
          {loading ? <Loader size={14} className="animate-spin" /> : <Zap size={14} />}
          <span style={{ marginLeft: '4px' }}>{loading ? 'Generating...' : 'Generate Chain'}</span>
        </button>
        {preview && (
          <button onClick={saveChain} disabled={loading}
            style={btnStyle(NEON.green, loading)}>
            Save Chain
          </button>
        )}
        {preview && (
          <button onClick={() => setPreview(null)}
            style={btnStyle('#666', false)}>
            Discard
          </button>
        )}
      </div>
      {error && <div style={{ color: NEON.pink, fontSize: '11px', marginTop: '8px' }}>{error}</div>}
      {preview && (
        <div style={{ marginTop: '12px', padding: '12px', border: `1px solid ${NEON.purple}30`, borderRadius: '8px', background: 'rgba(0,0,0,0.3)' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, color: NEON.purple, marginBottom: '4px' }}>
            {preview.name}
          </div>
          <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '8px' }}>{preview.description}</div>
          <PipelineViz chain={preview} type={type} />
        </div>
      )}
    </div>
  );
}

// ─── Chain Editor ─────────────────────────────────────────────
function ChainEditor({ chain, type, availableSkills, availableTools, onSave, onCancel }) {
  const [name, setName] = useState(chain?.name || '');
  const [description, setDescription] = useState(chain?.description || '');
  const [steps, setSteps] = useState(chain?.steps || []);
  const isSkill = type === 'skill';
  const items = isSkill ? availableSkills : availableTools;

  const addStep = () => {
    setSteps([...steps, { [isSkill ? 'skill_name' : 'tool_name']: '', name: '', input_mapping: {}, input_override: {} }]);
  };
  const updateStep = (i, field, value) => {
    const updated = [...steps];
    updated[i] = { ...updated[i], [field]: value };
    setSteps(updated);
  };
  const removeStep = (i) => setSteps(steps.filter((_, idx) => idx !== i));
  const moveStep = (i, dir) => {
    const ni = i + dir;
    if (ni < 0 || ni >= steps.length) return;
    const updated = [...steps];
    [updated[i], updated[ni]] = [updated[ni], updated[i]];
    setSteps(updated);
  };

  const parseMapping = (str) => {
    if (!str.trim()) return {};
    const pairs = str.split(',').map(s => s.trim()).filter(Boolean);
    const obj = {};
    for (const p of pairs) {
      const [k, ...vParts] = p.split('=');
      obj[k.trim()] = vParts.join('=').trim();
    }
    return obj;
  };

  const mapToStr = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join(', ');

  return (
    <div style={{ border: `1px solid ${NEON.cyan}40`, borderRadius: '10px', padding: '16px', background: 'rgba(0,0,0,0.4)' }}>
      <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="chain-name"
          style={inputStyle(NEON.cyan)} />
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description"
          style={inputStyle('#888')} />
      </div>

      {steps.map((step, i) => (
        <div key={i} style={{ border: '1px solid #333', borderRadius: '6px', padding: '12px', marginBottom: '8px', background: 'rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ color: NEON.cyan, fontFamily: FONTS.mono, fontSize: '11px' }}>Step {i + 1}</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button onClick={() => moveStep(i, -1)} style={miniBtn('#666')} disabled={i === 0}>↑</button>
              <button onClick={() => moveStep(i, 1)} style={miniBtn('#666')} disabled={i === steps.length - 1}>↓</button>
              <button onClick={() => removeStep(i)} style={miniBtn(NEON.pink)}><Trash2 size={12} /></button>
            </div>
          </div>
          <select value={isSkill ? step.skill_name : step.tool_name}
            onChange={e => updateStep(i, isSkill ? 'skill_name' : 'tool_name', e.target.value)}
            style={{ ...inputStyle(NEON.blue), marginBottom: '6px' }}>
            <option value="">Select {isSkill ? 'skill' : 'tool'}...</option>
            {items.map(item => (
              <option key={item.id} value={item.name}>{item.name}</option>
            ))}
          </select>
          <input value={mapToStr(step.input_mapping)} onChange={e => updateStep(i, 'input_mapping', parseMapping(e.target.value))}
            placeholder="input_mapping: key=$prev.field, key2=$input"
            style={{ ...inputStyle(NEON.yellow), marginBottom: '6px', fontFamily: FONTS.mono, fontSize: '11px' }} />
          <input value={mapToStr(step.input_override)} onChange={e => updateStep(i, 'input_override', parseMapping(e.target.value))}
            placeholder="input_override: limit=5, format=json"
            style={{ ...inputStyle(NEON.orange), fontFamily: FONTS.mono, fontSize: '11px' }} />
        </div>
      ))}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button onClick={addStep} style={btnStyle(NEON.cyan, false)}><Plus size={14} /><span style={{ marginLeft: '4px' }}>Add Step</span></button>
        <button onClick={() => onSave({ name, description, steps })} disabled={!name}
          style={btnStyle(NEON.green, !name)}>Save</button>
        <button onClick={onCancel} style={btnStyle('#666', false)}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────
const inputStyle = (color) => ({
  flex: 1,
  minWidth: 0,
  background: 'rgba(0,0,0,0.5)',
  border: `1px solid ${color}30`,
  borderRadius: '4px',
  padding: '6px 10px',
  color: '#eee',
  fontSize: '12px',
  outline: 'none',
});
const btnStyle = (color, disabled) => ({
  display: 'flex',
  alignItems: 'center',
  padding: '6px 14px',
  border: `1px solid ${color}50`,
  borderRadius: '6px',
  background: `${color}15`,
  color: disabled ? '#666' : color,
  cursor: disabled ? 'not-allowed' : 'pointer',
  fontSize: '12px',
  fontWeight: 600,
  opacity: disabled ? 0.5 : 1,
});
const miniBtn = (color) => ({
  padding: '2px 6px',
  border: `1px solid ${color}40`,
  borderRadius: '4px',
  background: 'transparent',
  color,
  cursor: 'pointer',
  fontSize: '11px',
});

// ─── Main Page ────────────────────────────────────────────────
export default function Chains() {
  const { user } = useAuth();
  const { companionName } = usePersonas();
  const [tab, setTab] = useState('skill'); // 'skill' or 'tool'
  const [chains, setChains] = useState({ skill: [], tool: [] });
  const [skills, setSkills] = useState([]);
  const [tools, setTools] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [runState, setRunState] = useState(null);
  const [running, setRunning] = useState(false);
  const [chainInput, setChainInput] = useState('');
  const { lastMsg } = useWebSocket();

  const loadChains = useCallback(async () => {
    const token = localStorage.getItem('cf_token');
    const [skillResp, toolResp, skillData, toolData] = await Promise.all([
      fetch(`${API}/skills`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${API}/tools`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch('/api/skills', { headers: { Authorization: `Bearer ${token}` } }),
      fetch('/api/tools', { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    const [skills, tools, skillList, toolList] = await Promise.all([
      skillResp.json(), toolResp.json(), skillData.json(), toolData.json(),
    ]);
    setChains({ skill: skills, tool: tools });
    setSkills(skillList || []);
    setTools(toolList || []);
  }, []);

  useEffect(() => { loadChains(); }, [loadChains]);

  // Listen for WS chain events
  useEffect(() => {
    if (!lastMsg) return;
    if (lastMsg.type === 'chain:step:running') {
      setRunState(prev => ({ ...prev, runningStep: lastMsg.payload.stepIndex, status: 'running' }));
    } else if (lastMsg.type === 'chain:step:done') {
      setRunState(prev => ({ ...prev, runningStep: null }));
    } else if (lastMsg.type === 'chain:complete' || lastMsg.type === 'chain:executed') {
      setRunState(prev => ({ ...prev, runningStep: null, status: 'done' }));
      loadChains();
    } else if (lastMsg.type === 'chain:failed') {
      setRunState(prev => ({ ...prev, runningStep: null, status: 'failed' }));
    }
  }, [lastMsg, loadChains]);

  const runChain = async (chain) => {
    setRunning(true);
    setRunState({ runningStep: 0, status: 'running', results: [] });
    try {
      const token = localStorage.getItem('cf_token');
      const endpoint = tab === 'skill' ? `${API}/skills/${chain.id}/execute` : `${API}/tools/${chain.id}/execute`;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ input: chainInput || undefined }),
      });
      const data = await resp.json();
      setRunState({ ...data, runningStep: null, status: data.ok ? 'done' : 'failed' });
    } catch (e) {
      setRunState({ ok: false, error: e.message, status: 'failed' });
    } finally {
      setRunning(false);
    }
  };

  const saveChain = async (chainData) => {
    const token = localStorage.getItem('cf_token');
    const endpoint = tab === 'skill' ? `${API}/skills` : `${API}/tools`;
    if (selected) {
      await fetch(`${endpoint}/${selected.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(chainData),
      });
    } else {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(chainData),
      });
    }
    setCreating(false);
    setEditing(false);
    setSelected(null);
    loadChains();
  };

  const deleteChain = async (chain) => {
    if (!confirm(`Delete chain "${chain.name}"?`)) return;
    const token = localStorage.getItem('cf_token');
    const endpoint = tab === 'skill' ? `${API}/skills` : `${API}/tools`;
    await fetch(`${endpoint}/${chain.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    setSelected(null);
    loadChains();
  };

  const currentChains = chains[tab];
  const current = selected ? currentChains.find(c => c.id === selected.id) : null;

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
        <Link2 size={24} style={{ color: NEON.cyan }} />
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#eee', margin: 0 }}>Skill & Tool Chains</h1>
      </div>

      {/* Tab Switcher */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
        {['skill', 'tool'].map(t => (
          <button key={t} onClick={() => { setTab(t); setSelected(null); setRunState(null); }}
            style={{
              padding: '8px 20px',
              border: `1px solid ${tab === t ? NEON.cyan : '#333'}`,
              borderRadius: '8px 8px 0 0',
              background: tab === t ? `${NEON.cyan}15` : 'transparent',
              color: tab === t ? NEON.cyan : '#888',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 600,
              textTransform: 'capitalize',
            }}>
            {t} Chains
          </button>
        ))}
      </div>

      {/* Aimi Intent Designer */}
      <AimiIntentBox type={tab} onGenerated={loadChains} />

      {/* Chain List + Detail */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        {/* Left: Chain List */}
        <div style={{ flex: '1 1 300px' }}>
          <button onClick={() => { setCreating(true); setSelected(null); setEditing(false); }}
            style={btnStyle(NEON.green, false)}><Plus size={14} /><span style={{ marginLeft: '4px' }}>New {tab} chain</span></button>

          <div style={{ marginTop: '12px' }}>
            {currentChains.length === 0 && (
              <div style={{ color: '#666', fontSize: '12px', padding: '16px 0' }}>No chains yet. Use {companionName} above or create one manually.</div>
            )}
            {currentChains.map(chain => (
              <div key={chain.id} onClick={() => { setSelected(chain); setCreating(false); setRunState(null); }}
                style={{
                  padding: '12px',
                  marginBottom: '6px',
                  border: `1px solid ${selected?.id === chain.id ? NEON.cyan : '#333'}`,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  background: selected?.id === chain.id ? `${NEON.cyan}10` : 'rgba(0,0,0,0.3)',
                  transition: 'all 0.2s',
                }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#eee' }}>{chain.name}</div>
                <div style={{ fontSize: '11px', color: '#888', marginTop: '2px' }}>
                  {(chain.steps || []).length} steps · {chain.status}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: Detail / Editor / Runner */}
        <div style={{ flex: 1 }}>
          {creating ? (
            <ChainEditor type={tab} availableSkills={skills} availableTools={tools}
              onSave={saveChain} onCancel={() => setCreating(false)} />
          ) : current && editing ? (
            <ChainEditor chain={current} type={tab} availableSkills={skills} availableTools={tools}
              onSave={saveChain} onCancel={() => setEditing(false)} />
          ) : current ? (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div>
                  <h2 style={{ fontSize: '18px', fontWeight: 700, color: '#eee', margin: 0 }}>{current.name}</h2>
                  <p style={{ fontSize: '12px', color: '#888', marginTop: '2px' }}>{current.description}</p>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button onClick={() => setEditing(true)} style={btnStyle(NEON.cyan, false)}>Edit</button>
                  <button onClick={() => deleteChain(current)} style={btnStyle(NEON.pink, false)}><Trash2 size={14} /></button>
                </div>
              </div>

              {/* Run input */}
              <div style={{ marginBottom: '12px' }}>
                <input value={chainInput} onChange={e => setChainInput(e.target.value)}
                  placeholder="Input for chain (optional)"
                  style={{ ...inputStyle(NEON.green), width: '100%', fontFamily: FONTS.mono, fontSize: '11px' }} />
                <button onClick={() => runChain(current)} disabled={running}
                  style={{ ...btnStyle(NEON.green, running), marginTop: '6px' }}>
                  {running ? <Loader size={14} className="animate-spin" /> : <Play size={14} />}
                  <span style={{ marginLeft: '4px' }}>{running ? 'Running...' : 'Run Chain'}</span>
                </button>
              </div>

              {/* Pipeline Visualization */}
              <div style={{ border: '1px solid #333', borderRadius: '8px', padding: '16px', background: 'rgba(0,0,0,0.3)' }}>
                <div style={{ fontSize: '12px', color: NEON.cyan, marginBottom: '12px', fontWeight: 600 }}>Pipeline</div>
                <PipelineViz chain={current} type={tab} runState={runState} />
              </div>

              {/* Run Results */}
              {runState && (
                <div style={{ marginTop: '12px', border: `1px solid ${runState.ok ? NEON.green : NEON.pink}40`, borderRadius: '8px', padding: '16px', background: 'rgba(0,0,0,0.3)' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: runState.ok ? NEON.green : NEON.pink, marginBottom: '8px' }}>
                    {runState.ok ? '✓ Chain Complete' : '✗ Chain Failed'}
                    {runState.duration_ms && <span style={{ color: '#888', fontSize: '11px', marginLeft: '8px' }}>{runState.duration_ms}ms</span>}
                  </div>
                  {runState.error && <div style={{ color: NEON.pink, fontSize: '12px', marginBottom: '8px' }}>{runState.error}</div>}
                  {runState.results && (
                    <div style={{ marginTop: '8px' }}>
                      {runState.results.map((r, i) => (
                        <div key={i} style={{ padding: '8px', marginBottom: '4px', border: '1px solid #222', borderRadius: '4px', background: 'rgba(0,0,0,0.2)' }}>
                          <div style={{ fontSize: '11px', color: r.ok ? NEON.green : NEON.pink, fontFamily: FONTS.mono }}>
                            Step {i + 1}: {r.stepName} — {r.ok ? '✓' : '✗'} {r.duration_ms}ms
                          </div>
                          {r.error && <div style={{ color: NEON.pink, fontSize: '11px', marginTop: '4px' }}>{r.error}</div>}
                          {r.output && (
                            <div style={{ color: '#aaa', fontSize: '11px', fontFamily: FONTS.mono, marginTop: '4px', maxHeight: '120px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                              {typeof r.output === 'string' ? r.output.slice(0, 500) : JSON.stringify(r.output, null, 2).slice(0, 500)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: '#666', fontSize: '13px', padding: '40px', textAlign: 'center' }}>
              Select a chain or create a new one
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
