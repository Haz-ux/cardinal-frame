import { useState, useCallback } from 'react';
import { usePersonas } from './PersonaContext';
import { cachedFetch, invalidateCache } from './dataCache';
import { NEON, BG } from './theme';
import { User, Check, RotateCcw, X, RefreshCw, Wand2 } from 'lucide-react';

const SWATCHES = ['#00b4d8', '#39ff14', '#ff3860', '#b026ff', '#eab308', '#22c55e', '#ff2a85', '#90e0ef'];

export default function PersonasPanel() {
  const { personas, companionName, refresh } = usePersonas();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', tagline: '', color: '', system_prompt: '' });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const openEditor = useCallback(async (persona) => {
    setEditing(persona.id);
    setStatus('');
    setError('');
    try {
      const d = await cachedFetch(`/api/personas/${persona.id}`);
      const p = d.persona;
      setForm({ name: p.name, tagline: p.tagline || '', color: p.color || '#00b4d8', system_prompt: p.systemPrompt || '' });
    } catch (e) {
      setError('Failed to load persona: ' + e.message);
    }
  }, []);

  const closeEditor = useCallback(() => { setEditing(null); setStatus(''); setError(''); }, []);

  const save = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const token = localStorage.getItem('cf_token');
      const res = await fetch(`/api/personas/${editing}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(form),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
      const data = await res.json();
      const p = data.persona;
      setForm({ name: p.name, tagline: p.tagline || '', color: p.color || '#00b4d8', system_prompt: p.systemPrompt || '' });
      invalidateCache('/api/personas');
      invalidateCache(`/api/personas/${editing}`);
      refresh();
      setStatus(`Identity saved — the AI is now "${p.name}" across Cardinal Frame`);
    } catch (e) {
      setError('Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm(`Reset "${editing}" to its default identity?`)) return;
    setSaving(true);
    setError('');
    try {
      const token = localStorage.getItem('cf_token');
      const res = await fetch(`/api/personas/${editing}/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `HTTP ${res.status}`); }
      const data = await res.json();
      const p = data.persona;
      setForm({ name: p.name, tagline: p.tagline || '', color: p.color || '#00b4d8', system_prompt: p.systemPrompt || '' });
      invalidateCache('/api/personas');
      invalidateCache(`/api/personas/${editing}`);
      refresh();
      setStatus(`Reset to default identity "${p.name}"`);
    } catch (e) {
      setError('Reset failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const field = (label, value, onChange, opts = {}) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#666' }}>{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={opts.placeholder}
        className="px-3 py-2 rounded-lg text-[12px] outline-none"
        style={{ background: BG.surface, border: `1px solid ${NEON.cyan}20`, color: '#ccc' }}
      />
    </label>
  );

  return (
    <div className="rounded-lg p-4" style={{ background: BG.card, border: `1px solid ${NEON.cyan}15`, boxShadow: `inset 0 0 30px ${NEON.cyan}03` }}>
      <div className="flex items-center gap-2 mb-3">
        <User size={14} style={{ color: NEON.cyan }} />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: NEON.cyan }}>Identities</span>
        <span className="text-[10px]" style={{ color: '#555' }}>
          — rename the active persona and the AI's name + self-identity update across the whole framework. Companion is currently <b style={{ color: NEON.cyan }}>{companionName}</b>.
        </span>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {personas.map(p => {
          const active = p.id === 'aimi';
          return (
            <button
              key={p.id}
              onClick={() => openEditor(p)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] transition-all"
              style={{
                background: editing === p.id ? `${p.color}18` : BG.surface,
                border: `1px solid ${p.color}40`,
                color: '#ddd',
                cursor: 'pointer',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, boxShadow: `0 0 6px ${p.color}` }} />
              {p.name}
              {active && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: `${p.color}20`, color: p.color }}>companion</span>}
            </button>
          );
        })}
      </div>

      {editing && (
        <div className="flex flex-col gap-3" style={{ padding: 12, borderRadius: 10, background: BG.surface, border: `1px solid ${NEON.cyan}15` }}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold" style={{ color: NEON.cyan }}>Edit {editing}</span>
            <button onClick={closeEditor} className="p-1 rounded hover:bg-white/5" style={{ color: '#666', background: 'none', border: 'none', cursor: 'pointer' }}>
              <X size={14} />
            </button>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            {field('Name', form.name, v => setForm(f => ({ ...f, name: v })))}
            {field('Tagline', form.tagline, v => setForm(f => ({ ...f, tagline: v })))}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#666' }}>Accent Color</span>
            <div className="flex items-center gap-2">
              <input
                value={form.color}
                onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                className="px-3 py-2 rounded-lg text-[12px] outline-none flex-1"
                style={{ background: BG.surface, border: `1px solid ${NEON.cyan}20`, color: '#ccc' }}
              />
              <div className="flex gap-1">
                {SWATCHES.map(c => (
                  <button key={c} onClick={() => setForm(f => ({ ...f, color: c }))}
                    style={{ width: 18, height: 18, borderRadius: '50%', background: c, border: form.color === c ? `2px solid #fff` : 'none', cursor: 'pointer', padding: 0 }} />
                ))}
              </div>
            </div>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#666' }}>System Prompt</span>
            <textarea
              value={form.system_prompt}
              onChange={e => setForm(f => ({ ...f, system_prompt: e.target.value }))}
              rows={8}
              className="px-3 py-2 rounded-lg text-[12px] outline-none resize-y font-mono leading-relaxed"
              style={{ background: BG.surface, border: `1px solid ${NEON.cyan}20`, color: '#bbb' }}
            />
            <span className="text-[10px]" style={{ color: '#555' }}>
              💡 Renaming the persona auto-updates its name inside the prompt and the AI's self-introduction. You can use <code style={{ color: NEON.cyan }}>{'{{NAME}}'}</code> to inject the current name explicitly.
            </span>
          </label>

          {error && <span className="text-[11px]" style={{ color: NEON.red }}>{error}</span>}
          {status && <span className="text-[11px]" style={{ color: NEON.green }}>{status}</span>}

          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={save} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] font-bold transition-all"
              style={{ background: `${NEON.green}15`, border: `1px solid ${NEON.green}40`, color: NEON.green, cursor: saving ? 'not-allowed' : 'pointer' }}>
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} Save Identity
            </button>
            <button onClick={reset} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-[11px] font-bold transition-all"
              style={{ background: `${NEON.red}10`, border: `1px solid ${NEON.red}30`, color: NEON.red, cursor: saving ? 'not-allowed' : 'pointer' }}>
              <RotateCcw size={13} /> Reset to Default
            </button>
            <span className="w-full sm:w-auto text-[10px] flex items-center gap-1" style={{ color: '#555' }}>
              <Wand2 size={11} /> Rename to change the AI name everywhere.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
