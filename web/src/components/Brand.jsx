// SoraLab brand: the cloud-and-orbit logo and wordmark (from the brand sheet, in public/sora/), and the app tiles.
import { appById } from '../lib/apps.js';

export function Mark({ size = 32, className = '' }) {
  return <img src="/sora/logo-mark.webp" alt="" aria-hidden="true" draggable={false} className={`sora-logo object-contain ${className}`} style={{ height: size, width: size * 1.56 }} />;
}

export function Logo({ size = 30, sub = true, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2 select-none ${className}`} aria-label="SoraLab">
      <Mark size={size} />
      <span className="leading-none flex flex-col">
        <img src="/sora/wordmark.webp" alt="SoraLab" draggable={false} className="sora-logo object-contain object-left" style={{ height: size * 0.72, width: size * 0.72 * 5.7 }} />
        {sub && <span className="block text-[9px] tracking-[0.3em] uppercase text-[#8fb8ff] mt-0.5 font-semibold">Creative Suite</span>}
      </span>
    </span>
  );
}

/** The full logo lockup (logo, SoraLab, Creative Suite, katakana and tagline) for sign-in and splash screens. */
export const LogoLockup = ({ width = 360, className = '' }) => (
  <img src="/sora/logo-full.webp" alt="SoraLab Creative Suite — ソララボ クリエイティブスイート — Create / Design / Bring your vision to the sky"
    draggable={false} className={`sora-logo ${className}`} style={{ width, height: 'auto' }} />
);

/** The square app icon. Apps on the brand sheet use its artwork; the others get a matching drawn tile. */
export function AppTile({ app, size = 40, className = '' }) {
  const a = typeof app === 'string' ? appById(app) : app;
  if (!a) return null;
  if (a.tile) return <img src={a.tile} alt="" aria-hidden="true" draggable={false} className={`shrink-0 select-none ${className}`} style={{ width: size, height: size }} />;
  const [bg, fg] = a.colors;
  return (
    <span className={`relative inline-grid place-items-center shrink-0 font-head font-bold select-none overflow-hidden ${className}`} aria-hidden="true"
      style={{ width: size, height: size, borderRadius: size * 0.2, fontSize: size * 0.4,
        background: `radial-gradient(circle at 30% 20%, ${fg}55, transparent 60%), linear-gradient(150deg, ${bg} 0%, #0b0e1a 100%)`,
        boxShadow: `inset 0 0 0 ${Math.max(1, size / 32)}px ${fg}cc, inset 0 0 ${size / 5}px ${fg}66, 0 0 ${size / 6}px ${fg}55` }}>
      <span style={{ background: `linear-gradient(180deg,#fff, ${fg})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', filter: `drop-shadow(0 0 ${size / 16}px ${fg})` }}>{a.letters}</span>
    </span>
  );
}
