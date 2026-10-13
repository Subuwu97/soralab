// SoraLab logo (a cloud and a morning star inside the sky ring) and the app tiles.
import { appById } from '../lib/apps.js';

export function Mark({ size = 32, className = '' }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id="sl-r" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#5AB4FF" /><stop offset=".55" stopColor="#8B7CFF" /><stop offset="1" stopColor="#FF8FB1" /></linearGradient>
        <linearGradient id="sl-c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" /><stop offset=".6" stopColor="#DCEBFF" /><stop offset="1" stopColor="#9ccaff" /></linearGradient>
        <radialGradient id="sl-s" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#fff" /><stop offset=".5" stopColor="#FFE3A8" /><stop offset="1" stopColor="#FFC36B" /></radialGradient>
      </defs>
      <circle cx="50" cy="50" r="40" fill="none" stroke="url(#sl-r)" strokeWidth="7" />
      <path d="M31 66h37a11 11 0 0 0 1.5-21.9A15 15 0 0 0 41.2 40 12 12 0 0 0 31 66Z" fill="url(#sl-c)" stroke="#7fb0ff" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M71 18c1 7.5 4.5 11 12 12-7.5 1-11 4.5-12 12-1-7.5-4.5-11-12-12 7.5-1 11-4.5 12-12Z" fill="url(#sl-s)" />
    </svg>
  );
}

export function Logo({ size = 30, sub = true, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2.5 select-none ${className}`}>
      <Mark size={size} />
      <span className="leading-none">
        <span className="block font-head font-bold tracking-tight" style={{ fontSize: size * 0.62 }}>Sora<span className="sora-text">Lab</span></span>
        {sub && <span className="block text-[9.5px] tracking-[0.22em] uppercase text-fg3 mt-0.5">by Mirai Creative Suite</span>}
      </span>
    </span>
  );
}

/** The square, two-letter app icon (like Ph, Ct). */
export function AppTile({ app, size = 40, className = '' }) {
  const a = typeof app === 'string' ? appById(app) : app;
  if (!a) return null;
  const [bg, fg] = a.colors;
  return (
    <span className={`inline-grid place-items-center shrink-0 font-head font-bold select-none ${className}`} aria-hidden="true"
      style={{ width: size, height: size, borderRadius: size * 0.24, background: `linear-gradient(145deg, ${bg}, ${bg}ee)`, color: fg, fontSize: size * 0.4,
        boxShadow: `inset 0 0 0 ${Math.max(1, size / 28)}px ${fg}55, 0 2px 8px rgba(0,0,0,.25)` }}>
      {a.letters}
    </span>
  );
}
