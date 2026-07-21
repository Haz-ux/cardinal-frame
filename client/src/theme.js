// ─── Cardinal Frame Shared Theme ─────────────────────────────────────
// Single source of truth for neon colors, gradients, and cyberpunk utilities
// Aligned with CSS :root design system variables in index.css

export const NEON = {
 cyan: '#00f0ff',
 magenta: '#ff00ff',
 purple: '#b026ff',
 pink: '#ff2d95',
 green: '#00ff88',   // Updated from #22c55e — true neon green per UI/UX skill
 orange: '#ff6600',
 red: '#ff0040',
 yellow: '#eab308',
 teal: '#14b8a6',
 blue: '#3b82f6',
 // Additional HUD accent from cyberpunk skill
 accent: '#00ff88',
 accent2: '#ff00ff',
 accent3: '#00d4ff',
};

export const GRADIENTS = {
 cyanMagenta: `linear-gradient(135deg, ${NEON.cyan}, ${NEON.magenta})`,
 purpleCyan: `linear-gradient(135deg, ${NEON.purple}, ${NEON.cyan})`,
 magentaPink: `linear-gradient(135deg, ${NEON.magenta}, ${NEON.pink})`,
 cyanGreen: `linear-gradient(135deg, ${NEON.cyan}, ${NEON.green})`,
 greenCyan: `linear-gradient(135deg, ${NEON.green}, ${NEON.cyan})`,
 darkRadial: `radial-gradient(ellipse at 50% 0%, ${NEON.purple}15 0%, transparent 60%)`,
 neonAccent: `linear-gradient(135deg, ${NEON.accent}, ${NEON.accent3})`,
};

export const GLOW = {
 cyan: `0 0 8px ${NEON.cyan}60, 0 0 20px ${NEON.cyan}20`,
 magenta: `0 0 8px ${NEON.magenta}60, 0 0 20px ${NEON.magenta}20`,
 purple: `0 0 8px ${NEON.purple}60, 0 0 20px ${NEON.purple}20`,
 pink: `0 0 8px ${NEON.pink}60, 0 0 20px ${NEON.pink}20`,
 green: `0 0 8px ${NEON.green}60, 0 0 20px ${NEON.green}20`,
 orange: `0 0 8px ${NEON.orange}60, 0 0 20px ${NEON.orange}20`,
 red: `0 0 8px ${NEON.red}60, 0 0 20px ${NEON.red}20`,
};

export const BG = {
 base: '#050510',
 surface: '#0a0a1a',
 card: '#0f0f23',
 elevated: '#16163a',
 hover: '#1a1a3e',
 void: '#0a0a0f',   // Deep void from cyberpunk mobile HUD skill
};

// Status colors for consistent state display
export const STATUS = {
 running: NEON.green,
 active: NEON.green,
 online: NEON.green,
 connected: NEON.green,
 idle: NEON.cyan,
 pending: NEON.yellow,
 queued: NEON.yellow,
 paused: NEON.orange,
 error: NEON.red,
 failed: NEON.red,
 offline: NEON.red,
 disconnected: NEON.red,
 completed: NEON.purple,
 disabled: '#444',
};

// Font families — matches CSS variables
export const FONTS = {
 hud: "'Share Tech Mono', monospace",
 code: "'Fira Code', monospace",
 body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

// Reusable inline style objects
export const STYLES = {
 card: {
  background: BG.card,
  border: `1px solid ${NEON.green}12`,
  borderRadius: 0,  // Chamfered — no border-radius
 },
 neonText: (color = NEON.cyan) => ({
  color,
  textShadow: `0 0 8px ${color}60`,
  fontFamily: FONTS.hud,
 }),
 glowBorder: (color = NEON.green) => ({
  border: `1px solid ${color}30`,
  boxShadow: `0 0 8px ${color}15, inset 0 0 8px ${color}06`,
 }),
 neonInput: (color = NEON.green) => ({
  background: BG.surface,
  border: `1px solid ${color}20`,
  borderRadius: '4px',
  color: '#e0e0e0',
  outline: 'none',
  fontFamily: FONTS.code,
  fontSize: 12,
 }),
 // HUD bracket corners for containers
 hudBracket: (color = NEON.green) => ({
  position: 'relative',
  border: `1px solid ${color}15`,
 }),
};

// Provider type color mapping
export const PROVIDER_COLORS = {
 openai: NEON.green,
 google: NEON.blue,
 nvidia: '#76b900',
 anthropic: NEON.orange,
 openrouter: NEON.purple,
 groq: NEON.orange,
 together: NEON.teal,
 deepseek: NEON.cyan,
 mistral: NEON.pink,
 cerebras: NEON.yellow,
 sambanova: NEON.magenta,
 perplexity: NEON.purple,
 xai: NEON.magenta,
 cohere: NEON.teal,
 ollama: NEON.teal,
};
