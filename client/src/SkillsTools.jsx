import React, { useState, useEffect } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';
import { useToast } from './ToastContext';
import { NEON, BG, GLOW, STATUS } from './theme';
import { Wrench, Sparkles, Plus, Trash2, ToggleLeft, ToggleRight, Cpu, Zap, Settings, ChevronDown, ExternalLink } from 'lucide-react';

export default function SkillsTools({ initialTab }) {
  const [tab, setTab] = useState(initialTab || 'tools');
  const [tools, setTools] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddTool, setShowAddTool] = useState(false);
  const [showAddSkill, setShowAddSkill] = useState(false);
  const [newTool, setNewTool] = useState({ name: '', description: '', endpoint: '', method: 'GET' });
  const [newSkill, setNewSkill] = useState({ name: '', description: '', category: 'general', handler: 'api' });
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const [t, s] = await Promise.all([api('/api/tools'), api('/api/skills')]);
      setTools(Array.isArray(t) ? t : []);
      setSkills(Array.isArray(s) ? s : []);
    } catch (e) { toast.error('Failed to load skills/tools'); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const addTool = async () => {
    if (!newTool.name.trim()) return toast.error('Tool name required');
    try {
      await api('/api/tools', { method: 'POST', body: JSON.stringify(newTool) });
      toast.success(`Tool "${newTool.name}" created`);
      setNewTool({ name: '', description: '', endpoint: '', method: 'GET' });
      setShowAddTool(false);
      load();
    } catch (e) { toast.error('Failed to create tool'); }
  };

  const addSkill = async () => {
    if (!newSkill.name.trim() || !newSkill.handler.trim()) return toast.error('Name and handler required');
    try {
      await api('/api/skills', { method: 'POST', body: JSON.stringify(newSkill) });
      toast.success(`Skill "${newSkill.name}" created`);
      setNewSkill({ name: '', description: '', category: 'general', handler: 'api' });
      setShowAddSkill(false);
      load();
    } catch (e) { toast.error('Failed to create skill'); }
  };

  const deleteTool = async (id, name) => {
    if (!confirm(`Delete tool "${name}"?`)) return;
    try { await api(`/api/tools/${id}`, { method: 'DELETE' }); toast.info(`Tool "${name}" deleted`); load(); }
    catch (e) { toast.error('Delete failed'); }
  };

  const deleteSkill = async (id, name) => {
    if (!confirm(`Delete skill "${name}"?`)) return;
    try { await api(`/api/skills/${id}`, { method: 'DELETE' }); toast.info(`Skill "${name}" deleted`); load(); }
    catch (e) { toast.error('Delete failed'); }
  };

  const toggleSkill = async (skill) => {
    try {
      await api(`/api/skills/${skill.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      load();
    } catch (e) { toast.error('Toggle failed'); }
  };

  const categories = [...new Set(skills.map(s => s.category || 'general'))];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: `${NEON.orange}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Wrench size={18} style={{ color: NEON.orange }} />
        </div>
        <div>
          <h1 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: 0 }}>Skills & Tools</h1>
          <p style={{ color: '#666', fontSize: 12, margin: 0 }}>Manage Aimi's capabilities — system tools, custom skills, and API endpoints</p>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ color: '#555', fontSize: 11 }}>{tools.length} tools · {skills.length} skills</span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 20, background: BG.surface, borderRadius: 10, padding: 3 }}>
        {[
          { key: 'tools', label: 'Tools', icon: <Zap size={14} />, color: NEON.magenta },
          { key: 'skills', label: 'Skills', icon: <Sparkles size={14} />, color: NEON.purple },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flex: 1, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: tab === t.key ? `${t.color}15` : 'transparent',
            color: tab === t.key ? t.color : '#555',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
          }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#444' }}>Loading...</div>
      ) : tab === 'tools' ? (
        <div>
          {/* Add tool button */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ color: '#888', fontSize: 12 }}>System tools Aimi can invoke to interact with Cardinal Frame</span>
            <button onClick={() => setShowAddTool(!showAddTool)} style={{
              ...pillBtn, background: `${NEON.magenta}15`, border: `1px solid ${NEON.magenta}30`, color: NEON.magenta,
            }}>
              <Plus size={12} /> Add Tool
            </button>
          </div>

          {/* Add tool form */}
          {showAddTool && (
            <div style={{ background: BG.card, border: `1px solid ${NEON.magenta}20`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <input placeholder="Tool name" value={newTool.name} onChange={e => setNewTool(p => ({ ...p, name: e.target.value }))}
                  style={inputStyle} />
                <select value={newTool.method} onChange={e => setNewTool(p => ({ ...p, method: e.target.value }))}
                  style={{ ...inputStyle, background: BG.surface }}>
                  {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <input placeholder="Endpoint (e.g. /api/agents)" value={newTool.endpoint} onChange={e => setNewTool(p => ({ ...p, endpoint: e.target.value }))}
                  style={{ ...inputStyle, gridColumn: '1 / -1' }} />
                <input placeholder="Description" value={newTool.description} onChange={e => setNewTool(p => ({ ...p, description: e.target.value }))}
                  style={{ ...inputStyle, gridColumn: '1 / -1' }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={addTool} style={{ ...pillBtn, background: NEON.magenta, color: '#fff' }}>Create</button>
                <button onClick={() => setShowAddTool(false)} style={pillBtn}>Cancel</button>
              </div>
            </div>
          )}

          {/* Tool cards */}
          <div style={{ display: 'grid', gap: 8 }}>
            {tools.map(tool => (
              <div key={tool.id} style={{
                background: BG.card, border: `1px solid ${NEON.magenta}10`, borderRadius: 10,
                padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: `${NEON.magenta}10`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Zap size={14} style={{ color: NEON.magenta }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>{tool.name}</div>
                  <div style={{ color: '#666', fontSize: 11 }}>{tool.description}</div>
                </div>
                <span style={{ ...methodBadge, background: `${methodColor(tool.method)}15`, color: methodColor(tool.method), border: `1px solid ${methodColor(tool.method)}30` }}>
                  {tool.method}
                </span>
                <span style={{ color: '#444', fontSize: 11, fontFamily: 'monospace', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tool.endpoint}
                </span>
                <span style={{ color: tool.enabled ? NEON.green : '#555', fontSize: 10, fontWeight: 700 }}>
                  {tool.enabled ? 'ENABLED' : 'DISABLED'}
                </span>
                <button onClick={() => deleteTool(tool.id, tool.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#444', padding: 4, display: 'flex' }}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {tools.length === 0 && <div style={{ color: '#444', textAlign: 'center', padding: 40 }}>No tools registered yet</div>}
          </div>
        </div>
      ) : (
        <div>
          {/* Skills tab */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ color: '#888', fontSize: 12 }}>Skills group related tools into callable capabilities</span>
            <button onClick={() => setShowAddSkill(!showAddSkill)} style={{
              ...pillBtn, background: `${NEON.purple}15`, border: `1px solid ${NEON.purple}30`, color: NEON.purple,
            }}>
              <Plus size={12} /> Add Skill
            </button>
          </div>

          {/* Add skill form */}
          {showAddSkill && (
            <div style={{ background: BG.card, border: `1px solid ${NEON.purple}20`, borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <input placeholder="Skill name" value={newSkill.name} onChange={e => setNewSkill(p => ({ ...p, name: e.target.value }))}
                  style={inputStyle} />
                <select value={newSkill.category} onChange={e => setNewSkill(p => ({ ...p, category: e.target.value }))}
                  style={{ ...inputStyle, background: BG.surface }}>
                  {['general', 'agents', 'tasks', 'llm', 'system', 'mcp', 'schedules', 'custom'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input placeholder="Handler (api, function, script)" value={newSkill.handler} onChange={e => setNewSkill(p => ({ ...p, handler: e.target.value }))}
                  style={inputStyle} />
                <div />
                <input placeholder="Description" value={newSkill.description} onChange={e => setNewSkill(p => ({ ...p, description: e.target.value }))}
                  style={{ ...inputStyle, gridColumn: '1 / -1' }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button onClick={addSkill} style={{ ...pillBtn, background: NEON.purple, color: '#fff' }}>Create</button>
                <button onClick={() => setShowAddSkill(false)} style={pillBtn}>Cancel</button>
              </div>
            </div>
          )}

          {/* Skills by category */}
          {categories.map(cat => (
            <div key={cat} style={{ marginBottom: 16 }}>
              <div style={{ color: NEON.purple, fontSize: 12, fontWeight: 700, marginBottom: 8, letterSpacing: 1, textTransform: 'uppercase' }}>
                {cat}
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {skills.filter(s => (s.category || 'general') === cat).map(skill => (
                  <div key={skill.id} style={{
                    background: BG.card, border: `1px solid ${NEON.purple}10`, borderRadius: 10,
                    padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: `${NEON.purple}10`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Sparkles size={12} style={{ color: NEON.purple }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>{skill.name}</div>
                      <div style={{ color: '#666', fontSize: 11 }}>{skill.description}</div>
                    </div>
                    <span style={{ color: '#444', fontSize: 10, fontFamily: 'monospace' }}>{skill.handler}</span>
                    <button onClick={() => toggleSkill(skill)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: skill.enabled ? NEON.green : '#555', padding: 2, display: 'flex' }}>
                      {skill.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                    </button>
                    <button onClick={() => deleteSkill(skill.id, skill.name)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#444', padding: 2, display: 'flex' }}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {skills.length === 0 && <div style={{ color: '#444', textAlign: 'center', padding: 40 }}>No skills registered yet</div>}
        </div>
      )}
    </div>
  );
}

const inputStyle = {
  background: '#0a0a1a', border: '1px solid #ffffff10', borderRadius: 8, padding: '8px 12px',
  color: '#fff', fontSize: 12, outline: 'none',
};

const pillBtn = {
  borderRadius: 20, padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
  display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: '1px solid #ffffff10', color: '#888',
};

const methodBadge = {
  padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
};

function methodColor(m) {
  switch (m) {
    case 'GET': return '#22c55e';
    case 'POST': return '#3b82f6';
    case 'PUT': return '#eab308';
    case 'PATCH': return '#f97316';
    case 'DELETE': return '#ef4444';
    default: return '#888';
  }
}
