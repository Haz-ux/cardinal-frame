import React, { createContext, useContext, useState, useCallback } from 'react';
import { NEON, GLOW } from './theme';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    if (duration > 0) {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    }
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback({
    success: (msg, d) => addToast(msg, 'success', d),
    error:   (msg, d) => addToast(msg, 'error', d ?? 6000),
    info:    (msg, d) => addToast(msg, 'info', d),
    warning: (msg, d) => addToast(msg, 'warning', d ?? 5000),
  }, [addToast]);

  const colors = {
    success: { bg: `${NEON.green}15`, border: NEON.green, glow: GLOW.green, icon: '✓' },
    error:   { bg: `${NEON.red}15`, border: NEON.red, glow: GLOW.red, icon: '✕' },
    info:    { bg: `${NEON.cyan}15`, border: NEON.cyan, glow: GLOW.cyan, icon: 'ℹ' },
    warning: { bg: `${NEON.orange}15`, border: NEON.orange, glow: GLOW.orange, icon: '⚠' },
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Toast container — fixed top-right */}
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
        {toasts.map(t => {
          const c = colors[t.type] || colors.info;
          return (
            <div key={t.id} style={{
              pointerEvents: 'auto',
              background: c.bg,
              border: `1px solid ${c.border}60`,
              borderRadius: 8,
              padding: '12px 16px',
              boxShadow: c.glow,
              color: '#fff',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              maxWidth: 380,
              backdropFilter: 'blur(12px)',
              animation: 'toastIn 0.3s ease-out',
              cursor: 'pointer',
            }} onClick={() => removeToast(t.id)}>
              <span style={{ color: c.border, fontSize: 16, fontWeight: 700 }}>{c.icon}</span>
              <span style={{ flex: 1 }}>{t.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be inside ToastProvider');
  return ctx;
}
