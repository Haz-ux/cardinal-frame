import React, { useState, useEffect } from 'react';
import { Sparkles } from 'lucide-react';

const NEON = {
  cyan: '#00f0ff',
  blue: '#3b82f6',
  purple: '#a855f7',
  green: '#22c55e',
};

// Cyberpunk boot sequence lines — typed out one by one
const BOOT_LINES = [
  { text: 'CARDINAL FRAME v0.6.0', color: NEON.cyan, delay: 0 },
  { text: 'Initializing neural substrate…', color: '#666', delay: 300 },
  { text: '[OK] Quantum bus connected', color: NEON.green, delay: 600 },
  { text: '[OK] Agent runtime loaded', color: NEON.green, delay: 800 },
  { text: '[OK] Task scheduler online', color: NEON.green, delay: 1000 },
  { text: '[OK] MCP gateway active', color: NEON.green, delay: 1200 },
  { text: '[OK] DAG engine ready', color: NEON.green, delay: 1400 },
  { text: '[OK] LLM providers synced', color: NEON.green, delay: 1600 },
  { text: 'Loading orchestration layer…', color: NEON.purple, delay: 1800 },
  { text: 'System ready. Welcome, Operator.', color: NEON.cyan, delay: 2100 },
];

const BOOT_DURATION = 2800; // total ms before auto-dismiss starts

export default function BootScreen({ onDone }) {
  const [visibleLines, setVisibleLines] = useState([]);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const timers = BOOT_LINES.map((line) =>
      setTimeout(() => {
        setVisibleLines(prev => [...prev, line]);
      }, line.delay)
    );

    // Start fade-out
    const fadeTimer = setTimeout(() => setFadeOut(true), BOOT_DURATION);
    // Remove from DOM after fade completes
    const doneTimer = setTimeout(() => onDone(), BOOT_DURATION + 600);

    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, [onDone]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{
        background: '#050510',
        transition: 'opacity 0.6s ease',
        opacity: fadeOut ? 0 : 1,
      }}
    >
      {/* Hex grid bg */}
      <div className="absolute inset-0 hex-grid-bg opacity-30" />

      {/* Scanline overlay */}
      <div className="scanline-overlay" />

      {/* Radial glow behind logo */}
      <div
        className="absolute"
        style={{
          width: 400,
          height: 400,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'radial-gradient(circle, rgba(0,240,255,0.12) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center w-full max-w-lg px-8">
        {/* Logo */}
        <div className="mb-8 flex items-center gap-3">
          <Sparkles
            size={36}
            style={{
              color: NEON.cyan,
              filter: `drop-shadow(0 0 12px ${NEON.cyan}) drop-shadow(0 0 24px ${NEON.cyan}40)`,
              animation: 'neonPulse 2s ease-in-out infinite',
            }}
          />
          <span
            className="text-3xl font-black tracking-widest"
            style={{
              background: `linear-gradient(135deg, ${NEON.cyan}, ${NEON.blue})`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              filter: `drop-shadow(0 0 20px ${NEON.cyan}40)`,
            }}
          >
            CARDINAL FRAME
          </span>
        </div>

        {/* Terminal output */}
        <div
          className="w-full font-mono text-sm space-y-1.5"
          style={{
            background: 'rgba(5,5,16,0.8)',
            border: `1px solid ${NEON.cyan}15`,
            borderRadius: 8,
            padding: '16px 20px',
            boxShadow: `0 0 30px ${NEON.cyan}08, inset 0 0 30px rgba(0,240,255,0.02)`,
          }}
        >
          {visibleLines.map((line, i) => (
            <div
              key={i}
              style={{
                color: line.color,
                opacity: 0,
                animation: 'bootLineIn 0.3s ease forwards',
                textShadow: line.color === NEON.cyan ? `0 0 8px ${NEON.cyan}60` : 'none',
              }}
            >
              {line.text.startsWith('[OK]') ? (
                <>
                  <span style={{ color: NEON.green, fontWeight: 700 }}>[OK]</span>
                  <span style={{ color: '#aaa' }}>{line.text.slice(4)}</span>
                </>
              ) : line.text === 'System ready. Welcome, Operator.' ? (
                <span className="neon-pulse font-bold">{line.text}</span>
              ) : (
                line.text
              )}
            </div>
          ))}
          {/* Blinking cursor */}
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 16,
              background: NEON.cyan,
              animation: 'bootCursorBlink 0.6s step-end infinite',
              boxShadow: `0 0 6px ${NEON.cyan}`,
              verticalAlign: 'middle',
              marginLeft: 2,
            }}
          />
        </div>
      </div>

      {/* Inline keyframes — scoped to boot screen */}
      <style>{`
        @keyframes bootLineIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes bootCursorBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
