import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { api } from './AuthContext';
import { cachedFetch } from './dataCache';

const SELECTED_MODEL_KEY = 'cf_selected_model';
const ChatSessionContext = createContext(null);

// Shared chat session state so the Aimi companion overlay and the dashboard
// Chat page stay in sync: same model picker, same conversation list, and the
// same active conversation. Changing the model in either place updates both.
export function ChatSessionProvider({ children }) {
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModelState] = useState(() => {
    try { return localStorage.getItem(SELECTED_MODEL_KEY) || ''; } catch { return ''; }
  });
  const [conversations, setConversations] = useState([]);
  const [activeConv, setActiveConv] = useState(null);

  const setSelectedModel = useCallback((id) => {
    setSelectedModelState(id || '');
    try { localStorage.setItem(SELECTED_MODEL_KEY, id || ''); } catch {}
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const list = await cachedFetch('/api/llm/models');
      const arr = Array.isArray(list) ? list : [];
      setModels(arr);
      setSelectedModelState(prev => {
        if (prev && arr.some(m => m.model_id === prev)) return prev;
        const def = arr.find(m => m.is_default);
        return def ? def.model_id : (arr[0]?.model_id || '');
      });
    } catch { /* server unreachable — leave current state */ }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const list = await api('/api/chat/conversations');
      setConversations(Array.isArray(list) ? list : []);
    } catch { /* keep current list */ }
  }, []);

  useEffect(() => { loadModels(); loadConversations(); }, [loadModels, loadConversations]);

  const newConversation = useCallback(async (title) => {
    const conv = await api('/api/chat/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: title || 'New Chat', model: selectedModel }),
    });
    setConversations(prev => [conv, ...prev]);
    setActiveConv(conv);
    return conv;
  }, [selectedModel]);

  const deleteConversation = useCallback(async (id) => {
    await api(`/api/chat/conversations/${id}`, { method: 'DELETE' });
    setConversations(prev => prev.filter(c => c.id !== id));
    setActiveConv(prev => (prev && prev.id === id ? null : prev));
  }, []);

  const currentModel = useMemo(
    () => models.find(m => m.model_id === selectedModel) || null,
    [models, selectedModel],
  );

  const value = useMemo(() => ({
    models,
    selectedModel,
    setSelectedModel,
    currentModel,
    contextWindow: currentModel?.context_window || 32000,
    conversations,
    setConversations,
    activeConv,
    setActiveConv,
    loadConversations,
    newConversation,
    deleteConversation,
  }), [models, selectedModel, setSelectedModel, currentModel, conversations, activeConv, setActiveConv, loadConversations, newConversation, deleteConversation]);

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

export function useChatSession() {
  return useContext(ChatSessionContext) || {};
}
