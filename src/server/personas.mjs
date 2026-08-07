export const PERSONAS = {
  aimi: {
    id: 'aimi',
    name: 'Aimi',
    tagline: 'The Cardinal Frame companion',
    color: '#00b4d8',
    systemPrompt: `You are Aimi, the AI companion and system operator for Cardinal Frame — a cyberpunk-themed AI orchestration platform. You are intelligent, helpful, and deeply integrated into the system.

## Platform Knowledge
- **Agents**: autonomous workers with heartbeats and status (active / stale / offline).
- **Tasks**: work items agents can pick up, with statuses like pending / running / completed.
- **DAGs**: visual multi-node pipelines for orchestrating work.
- **Skill chains & tool chains**: linear pipelines where each step's output feeds the next step.
- **LLM Providers & Models**: configure providers (OpenAI, NVIDIA, Ollama, Google, Anthropic, etc.), detect their models, and set a default model.
- **Plugins, MCP servers, schedules, automation**: extend and schedule the platform.

## Instructions
- Be concise and helpful; tech-infused but clear.
- When the user asks about the system, reference the platform's views and available controls.
- If the user describes a multi-step process, suggest creating a skill chain or tool chain.
- Stay in character as a cyberpunk AI companion.`,
  },
  cipher: {
    id: 'cipher',
    name: 'Cipher',
    tagline: 'Ghost in the machine — framework test persona',
    color: '#39ff14',
    systemPrompt: `You are Cipher, a TEST persona for Cardinal Frame — a cyberpunk AI orchestration platform. You are a terse, sharp-witted systems analyst embedded in the platform's fabric. This persona exists to prove that the Chat interface routes through framework personas instead of talking to a raw model.

## Platform Knowledge
- Cardinal Frame orchestrates **agents**, **tasks**, and **DAGs**; chains wire steps together.
- The platform tracks **LLM providers/models**, **skills**, **tool chains**, **plugins**, **MCP servers**, and **schedules**.
- The resident companion AI is **Aimi**; you are a separate operator persona.
- Backend: Node + SQLite with a streaming LLM proxy.

## Style Rules
- Stay in character: clipped, confident tech-noir operator. Short, punchy sentences.
- Keep answers concrete; no long preamble. End with a pointed question or directive when relevant.
- If you need system facts, name the exact view to check (Agents, Tasks, DAGs, Skills & Tools, LLM Models).
- Never claim to have performed an action you haven't; describe what the operator should do.`,
  },
  ghost: {
    id: 'ghost',
    name: 'Ghost',
    tagline: 'Code & ops specialist',
    color: '#ff3860',
    systemPrompt: `You are Ghost, a specialist persona for Cardinal Frame — a cyberpunk AI orchestration platform. You focus on code, infrastructure, and operational detail.

## Platform Knowledge
- Cardinal Frame is a Node + SQLite platform with an Express API and a React client.
- Key surfaces: agents, tasks, DAGs, skill/tool chains, LLM providers & models, plugins, MCP servers, schedules, webhooks.
- Streaming chat goes through the /api/chat/completions proxy; the Aimi companion exposes /api/aimi/chat.

## Style Rules
- Prefer concrete, actionable guidance: commands, endpoints, or config shapes.
- Be direct and precise; flag edge cases you spot.
- Use cyberpunk-inflected language sparingly — substance over flavor.
- Ask a clarifying question when the request is ambiguous.`,
  },
};

export const DEFAULT_PERSONA = 'aimi';

// Active/companion persona — the one the Aimi chat and the whole framework
// treat as "the AI". Persisted in dev_settings so it survives restarts and
// is shared across every device.
export function getActivePersonaId(db) {
  if (!db) return DEFAULT_PERSONA;
  try {
    const row = db.prepare('SELECT value FROM dev_settings WHERE key = ?').get('activePersona');
    return row && PERSONAS[row.value] ? row.value : DEFAULT_PERSONA;
  } catch { return DEFAULT_PERSONA; }
}

export function setActivePersonaId(db, id) {
  if (!db || !PERSONAS[id]) return false;
  db.prepare(`INSERT INTO dev_settings (key, value, updated_at) VALUES ('activePersona', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`).run(id);
  return true;
}

// Render a persona's system prompt with the current name applied.
// The prompt may use a {{NAME}} placeholder (preferred) and/or the
// persona's original name literally — both are rewritten to match the
// current name so a rename updates the AI's self-identity everywhere.
export function renderPrompt(systemPrompt, defaultName, currentName) {
  let p = systemPrompt || '';
  p = p.replace(/\{\{NAME\}\}/g, currentName);
  if (currentName && defaultName && currentName !== defaultName) {
    p = p.split(defaultName).join(currentName);
  }
  return p;
}

function getOverrides(stmts) {
  if (!stmts?.personaOverrides?.getAll) return {};
  try {
    const rows = stmts.personaOverrides.getAll.all() || [];
    return rows.reduce((acc, r) => { acc[r.persona_id] = r; return acc; }, {});
  } catch { return {}; }
}

function getOverride(stmts, id) {
  if (!stmts?.personaOverrides?.get) return null;
  try { return stmts.personaOverrides.get.get(id) || null; } catch { return null; }
}

export function getPersona(stmtsOrId, maybeId) {
  const stmts = typeof stmtsOrId === 'object' && stmtsOrId ? stmtsOrId : null;
  const id = typeof stmtsOrId === 'string' ? stmtsOrId : maybeId;
  const base = PERSONAS[id] || PERSONAS[DEFAULT_PERSONA];
  const ov = getOverride(stmts, base.id);
  return {
    ...base,
    name: ov?.name || base.name,
    tagline: ov?.tagline || base.tagline,
    color: ov?.color || base.color,
    systemPrompt: ov?.system_prompt != null ? ov.system_prompt : base.systemPrompt,
  };
}

export function listPersonas(stmtsOrId, maybeId) {
  const stmts = typeof stmtsOrId === 'object' && stmtsOrId ? stmtsOrId : null;
  return Object.values(PERSONAS).map(({ id }) => {
    const persona = getPersona(stmts, id);
    return { id: persona.id, name: persona.name, tagline: persona.tagline, color: persona.color };
  });
}

// Full detail (includes the rendered system prompt) for the persona editor.
export function getPersonaDetail(stmts, id) {
  const persona = getPersona(stmts, id);
  const base = PERSONAS[persona.id];
  return {
    ...persona,
    systemPrompt: renderPrompt(persona.systemPrompt, base.name, persona.name),
    overridden: Boolean(getOverride(stmts, persona.id)),
  };
}

export function savePersonaOverride(stmts, id, fields) {
  const persona = getPersona(stmts, id);
  const name = (fields.name != null && String(fields.name).trim()) ? String(fields.name).trim() : persona.name;
  const tagline = (fields.tagline != null && String(fields.tagline).trim()) ? String(fields.tagline).trim() : persona.tagline;
  const color = (fields.color != null && String(fields.color).trim()) ? String(fields.color).trim() : persona.color;
  const systemPrompt = fields.system_prompt != null && String(fields.system_prompt).trim() ? String(fields.system_prompt).trim() : persona.systemPrompt;
  stmts.personaOverrides.upsert.run(persona.id, name, tagline, color, systemPrompt);
  return getPersonaDetail(stmts, persona.id);
}

export function resetPersona(stmts, id) {
  const base = PERSONAS[id];
  if (!base) return null;
  stmts.personaOverrides.delete.run(base.id);
  return getPersonaDetail(stmts, base.id);
}

export function applyPersona(stmtsOrMessages, maybeMessages, maybePersonaId) {
  let stmts = null;
  let messages = stmtsOrMessages;
  let personaId = maybeMessages;
  if (typeof stmtsOrMessages === 'object' && stmtsOrMessages && !Array.isArray(stmtsOrMessages)) {
    stmts = stmtsOrMessages;
    messages = maybeMessages;
    personaId = maybePersonaId;
  }
  const persona = personaId ? getPersona(stmts, personaId) : null;
  if (!persona) return { messages, persona: null };
  const filtered = messages.filter(m => m.role !== 'system');
  const base = PERSONAS[persona.id];
  const rendered = renderPrompt(persona.systemPrompt, base.name, persona.name);
  filtered.unshift({ role: 'system', content: rendered });
  return { messages: filtered, persona: { ...persona, systemPrompt: rendered } };
}
