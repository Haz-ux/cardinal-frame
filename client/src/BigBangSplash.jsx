import React, { useRef, useState, useEffect } from 'react';

const NEON = {
  cyan: '#00f0ff',
  blue: '#3b82f6',
  magenta: '#ff2d78',
  purple: '#a855f7',
  white: '#ffffff',
  orange: '#ff9a5a',
};

// Build-time injected version (single source of truth — root package.json).
const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

const TOTAL_MS = 4000;      // full cinematic duration before onDone()
const FADE_START_MS = 3350; // start dimming the whole overlay

// Supernova / starfield palette — white-hot sparks early, cool starfield after.
const SPARK_COLORS = [
  '#ffffff', '#ffffff', '#ffe8c8', '#ffd0a0', '#ff9a5a',
  '#7dd3fc', '#67e8f9', '#c4b5fd', '#5eead4', '#f0abfc',
];
const STAR_COLORS = [
  '#ffffff', '#7dd3fc', '#67e8f9', '#c4b5fd', '#5eead4', '#93c5fd',
];

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

export default function BigBangSplash({ onDone }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [logoIn, setLogoIn] = useState(false);
  const [fading, setFading] = useState(false);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (onDone) onDone();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    let W = 0;
    let H = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const cx = W / 2;
    const cy = H / 2;

    // ── Particle system ────────────────────────────────────────
    // dist grows exponentially (speeding bullets). Alpha fades to 0 as a
    // particle nears maxDist, then it dies — stars "shoot out and fade away".
    const parts = [];

    function burst(count, colors, sizeMax, speedMax, accelMax) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        parts.push({
          angle,
          speed: 60 + Math.random() * speedMax,
          accel: 1.5 + Math.random() * accelMax,
          dist: 2 + Math.random() * 6,
          maxDist: Math.min(W, H) * (0.5 + Math.random() * 1.1) + 60,
          size: 0.5 + Math.random() * sizeMax,
          color: pick(colors),
          baseAlpha: 0.45 + Math.random() * 0.55,
          fadeStart: 0.3 + Math.random() * 0.4,
        });
      }
    }

    // The Big Bang — a white-hot supernova of sparks.
    burst(420, SPARK_COLORS, 2.0, 950, 3.4);
    // A slower seed layer so the sky never goes empty (galaxy keeps forming).
    for (let i = 0; i < 220; i++) {
      parts.push({
        angle: Math.random() * Math.PI * 2,
        speed: 20 + Math.random() * 260,
        accel: 1.2 + Math.random() * 1.4,
        dist: Math.random() * Math.min(W, H) * 0.85,
        maxDist: Math.min(W, H) * (0.8 + Math.random() * 1.2) + 60,
        size: 0.4 + Math.random() * 1.4,
        color: pick(STAR_COLORS),
        baseAlpha: 0.35 + Math.random() * 0.5,
        fadeStart: 0.4 + Math.random() * 0.3,
      });
    }

    // ── Shockwave rings + core flash ───────────────────────────
    const rings = [
      { t: 430,  r: 10, speed: 1500, color: NEON.cyan,    width: 4, life: 850 },
      { t: 950,  r: 10, speed: 1200, color: NEON.magenta, width: 3, life: 1100 },
      { t: 1400, r: 10, speed: 900,  color: NEON.purple,  width: 2, life: 1300 },
    ];
    const flashes = [
      { t: 320,  peak: 0.85, decay: 180 },
      { t: 1200, peak: 0.35, decay: 260 },
    ];

    let raf = 0;
    let last = performance.now();
    const t0 = last;

    function drawParticle(p, alpha) {
      const x = cx + Math.cos(p.angle) * p.dist;
      const y = cy + Math.sin(p.angle) * p.dist;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fill();
      if (p.size > 1.1) {
        // soft glow for the brighter stars — a faint larger halo
        ctx.globalAlpha = alpha * 0.22;
        ctx.beginPath();
        ctx.arc(x, y, p.size * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const frame = (now) => {
      const elapsed = now - t0;
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      // Clear to opaque black (bg is #000; canvas must wipe trails).
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // Slow ambient stream of new stars keeps the galaxy alive after the burst.
      if (elapsed > 700 && Math.random() < 0.6) {
        parts.push({
          angle: Math.random() * Math.PI * 2,
          speed: 18 + Math.random() * 220,
          accel: 1.15 + Math.random() * 1.1,
          dist: 1 + Math.random() * 8,
          maxDist: Math.min(W, H) * (0.7 + Math.random() * 1.2) + 60,
          size: 0.4 + Math.random() * 1.3,
          color: pick(STAR_COLORS),
          baseAlpha: 0.3 + Math.random() * 0.5,
          fadeStart: 0.35 + Math.random() * 0.3,
        });
      }

      // Update + prune particles.
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.speed *= 1 + p.accel * dt;
        p.dist += p.speed * dt;
        if (p.dist >= p.maxDist) {
          parts.splice(i, 1);
          continue;
        }
        const f = p.dist <= p.maxDist * p.fadeStart
          ? 1
          : 1 - (p.dist - p.maxDist * p.fadeStart) / (p.maxDist * (1 - p.fadeStart));
        const alpha = Math.max(p.baseAlpha * f, 0);
        if (alpha <= 0.01) {
          parts.splice(i, 1);
          continue;
        }
        drawParticle(p, alpha);
      }

      // Core glow — the galaxy center keeps breathing.
      const corePulse = 0.05 + 0.03 * Math.sin(elapsed / 900);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * 0.22);
      cg.addColorStop(0, `rgba(176, 38, 255, ${corePulse})`);
      cg.addColorStop(0.5, `rgba(0, 240, 255, ${corePulse * 0.5})`);
      cg.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = cg;
      ctx.fillRect(0, 0, W, H);

      // Core flashes (supernova flare).
      for (const fl of flashes) {
        const ft = elapsed - fl.t;
        if (ft >= 0 && ft < fl.decay * 6) {
          const a = fl.peak * Math.exp(-ft / fl.decay);
          const r = Math.min(W, H) * (0.05 + (ft / (fl.decay * 6)) * 0.55);
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          g.addColorStop(0, `rgba(255, 245, 235, ${a})`);
          g.addColorStop(0.4, `rgba(255, 154, 90, ${a * 0.45})`);
          g.addColorStop(1, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, W, H);
        }
      }

      // Shockwave rings.
      for (const ring of rings) {
        const rt = elapsed - ring.t;
        if (rt >= 0 && rt < ring.life) {
          const prog = rt / ring.life;
          const r = ring.r + ring.speed * prog;
          const a = (1 - prog) * 0.7;
          ctx.globalAlpha = a;
          ctx.strokeStyle = ring.color;
          ctx.lineWidth = ring.width * (1 - prog * 0.6);
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // Logo reveal + fade-out + completion (timeline).
    const logoTimer = setTimeout(() => setLogoIn(true), 1250);
    const fadeTimer = setTimeout(() => setFading(true), FADE_START_MS);
    const doneTimer = setTimeout(finish, TOTAL_MS);

    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(logoTimer);
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 overflow-hidden"
      style={{
        background: '#000',
        zIndex: 9999,
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.65s ease',
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />

      {/* Center branding — crisp DOM text over the particle canvas */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div
          className={`text-center select-none ${logoIn ? 'galaxy-logo-in' : 'opacity-0'}`}
          style={{ transform: logoIn ? 'none' : 'scale(1.12)' }}
        >
          <div
            className="text-3xl md:text-6xl font-black tracking-[0.15em] md:tracking-[0.22em] pl-[0.15em] md:pl-[0.22em] font-hud whitespace-nowrap px-2"
            style={{
              background: `linear-gradient(135deg, ${NEON.cyan}, ${NEON.blue})`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              filter: `drop-shadow(0 0 24px ${NEON.cyan}60) drop-shadow(0 0 60px ${NEON.purple}40)`,
            }}
          >
            CARDINAL FRAME
          </div>

          <div
            className="mx-auto mt-5 w-40 md:w-64"
            style={{ height: 1, background: `linear-gradient(90deg, transparent, ${NEON.magenta}90, transparent)` }}
          />

          <div className="mt-5 font-code text-lg md:text-2xl tracking-[0.4em] pl-[0.4em]" style={{ color: NEON.white }}>
            <span style={{ color: NEON.magenta, textShadow: `0 0 14px ${NEON.magenta}, 0 0 40px ${NEON.magenta}60` }}>
              v{APP_VERSION}
            </span>
          </div>
        </div>
      </div>

      {/* Skip */}
      <button
        onClick={finish}
        className="absolute top-5 right-5 px-4 py-1.5 font-hud text-xs tracking-widest transition-all"
        style={{
          color: NEON.cyan,
          background: 'rgba(0, 240, 255, 0.04)',
          border: `1px solid ${NEON.cyan}25`,
          borderRadius: 4,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(0, 240, 255, 0.12)';
          e.currentTarget.style.boxShadow = `0 0 16px ${NEON.cyan}30`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(0, 240, 255, 0.04)';
          e.currentTarget.style.boxShadow = 'none';
        }}
      >
        SKIP ›
      </button>

      <style>{`
        @keyframes galaxyLogoIn {
          from { opacity: 0; transform: scale(1.12); filter: blur(6px); }
          40% { opacity: 1; }
          to { opacity: 1; transform: scale(1); filter: blur(0); }
        }
        .galaxy-logo-in {
          animation: galaxyLogoIn 0.9s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
    </div>
  );
}
