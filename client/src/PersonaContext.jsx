import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { cachedFetch, invalidateCache } from './dataCache';
import { useWebSocket } from './useWebSocket';

const PersonaContext = createContext(null);

const FALLBACK = {
  aimi: { id: 'aimi', name: 'Aimi', tagline: 'The Cardinal Frame companion', color: '#00b4d8' },
};

const DEFAULT_ACTIVE = 'aimi';

function defaultValue() {
  return {
    personas: [],
    byId: {},
    activeId: DEFAULT_ACTIVE,
    getPersona: (id) => FALLBACK[id] || { id, name: 'Aimi', tagline: '', color: '#00b4d8' },
    name: (id) => (FALLBACK[id] || { name: 'Aimi' }).name,
    companion: FALLBACK.aimi,
    companionName: FALLBACK.aimi.name,
    loaded: false,
    refresh: () => {},
    setActive: () => {},
  };
}

export function PersonaProvider({ children }) {
  const [personas, setPersonas] = useState([]);
  const [activeId, setActiveId] = useState(DEFAULT_ACTIVE);
  const [loaded, setLoaded] = useState(false);
  const { lastMsg } = useWebSocket();

  const refresh = useCallback(async () => {
    try {
      const data = await cachedFetch('/api/personas');
      setPersonas(data.personas || []);
      if (data.default) setActiveId(data.default);
    } catch (err) {
      // keep last known list on transient failures
    } finally {
      setLoaded(true);
    }
  }, []);

  const setActive = useCallback(async (id) => {
    setActiveId(id);
    try {
      const token = localStorage.getItem('cf_token');
      const res = await fetch('/api/personas/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        refresh();
        return d.error || `HTTP ${res.status}`;
      }
      invalidateCache('/api/personas');
      refresh();
      return null;
    } catch (err) {
      refresh();
      return err.message;
    }
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (lastMsg?.type === 'persona:updated' || lastMsg?.type === 'persona:active') {
      invalidateCache('/api/personas');
      refresh();
    }
  }, [lastMsg, refresh]);

  const value = useMemo(() => {
    const byId = {};
    for (const p of personas) byId[p.id] = p;
    const getPersona = (id) => byId[id] || FALLBACK[id] || { id, name: 'Aimi', tagline: '', color: '#00b4d8' };
    const companion = byId[activeId] || FALLBACK.aimi;
    return {
      personas,
      byId,
      activeId,
      getPersona,
      name: (id) => getPersona(id).name,
      companion,
      companionName: companion.name,
      loaded,
      refresh,
      setActive,
    };
  }, [personas, activeId, loaded, refresh, setActive]);

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}

export function usePersonas() {
  return useContext(PersonaContext) || defaultValue();
}
