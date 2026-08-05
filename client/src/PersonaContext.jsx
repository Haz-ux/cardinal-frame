import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { cachedFetch, invalidateCache } from './dataCache';
import { useWebSocket } from './useWebSocket';

const PersonaContext = createContext(null);

const FALLBACK = {
  aimi: { id: 'aimi', name: 'Aimi', tagline: 'The Cardinal Frame companion', color: '#00b4d8' },
};

function defaultValue() {
  return {
    personas: [],
    byId: {},
    getPersona: (id) => FALLBACK[id] || { id, name: 'Aimi', tagline: '', color: '#00b4d8' },
    name: (id) => (FALLBACK[id] || { name: 'Aimi' }).name,
    companion: FALLBACK.aimi,
    companionName: FALLBACK.aimi.name,
    loaded: false,
    refresh: () => {},
  };
}

export function PersonaProvider({ children }) {
  const [personas, setPersonas] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const { lastMsg } = useWebSocket();

  const refresh = useCallback(async () => {
    try {
      const data = await cachedFetch('/api/personas');
      setPersonas(data.personas || []);
    } catch (err) {
      // keep last known list on transient failures
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (lastMsg?.type === 'persona:updated') {
      invalidateCache('/api/personas');
      refresh();
    }
  }, [lastMsg, refresh]);

  const value = useMemo(() => {
    const byId = {};
    for (const p of personas) byId[p.id] = p;
    const getPersona = (id) => byId[id] || FALLBACK[id] || { id, name: 'Aimi', tagline: '', color: '#00b4d8' };
    const companion = byId.aimi || FALLBACK.aimi;
    return {
      personas,
      byId,
      getPersona,
      name: (id) => getPersona(id).name,
      companion,
      companionName: companion.name,
      loaded,
      refresh,
    };
  }, [personas, loaded, refresh]);

  return <PersonaContext.Provider value={value}>{children}</PersonaContext.Provider>;
}

export function usePersonas() {
  return useContext(PersonaContext) || defaultValue();
}
