// Small pieces shared by the Audio views: one animation-frame ticker for meters and the playhead, level meters,
// compact sliders for track headers, time formatting, and a few icons the shared set doesn't have.
import { useEffect, useRef } from 'react';
import { cx } from '../../components/ui.jsx';

// ---------------------------------------------------------------- one rAF loop for everything that moves

const subs = new Set();
let raf = 0;
const loop = (ts) => { for (const f of [...subs]) f(ts); raf = subs.size ? requestAnimationFrame(loop) : 0; };
/** Calls fn(timestamp) every animation frame until the returned function is called. */
export function onFrame(fn) {
  subs.add(fn);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => subs.delete(fn);
}
export function useFrame(fn, deps = []) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => onFrame((ts) => ref.current(ts)), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Engine levels, computed at most once per frame however many meters ask. */
let lastTs = -1; let lastLevels = null;
export function frameLevels(engine, ts) {
  if (ts !== lastTs || !lastLevels) { lastTs = ts; lastLevels = engine.levels(); }
  return lastLevels;
}

// ---------------------------------------------------------------- meters

const toDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
const pct = (db) => Math.max(0, Math.min(1, (db + 60) / 60));
const METER_BG = 'linear-gradient(90deg,#1fd18f 0%,#1fd18f 70%,#e8d43a 85%,#ff9a3c 93%,#ff4d5e 100%)';

/** Horizontal (or vertical) peak meter. get(levels) → linear peak. Decays smoothly and holds peaks for a second. */
export function Meter({ engine, get, vertical, className, style }) {
  const bar = useRef(null); const hold = useRef(null);
  const st = useRef({ v: 0, hold: 0, holdT: 0 });
  useFrame((ts) => {
    if (!bar.current) return;
    const lv = frameLevels(engine, ts);
    const db = toDb(get(lv) || 0);
    const s = st.current;
    const p = pct(db);
    s.v = p > s.v ? p : Math.max(p, s.v - 0.012);
    if (s.v >= s.hold || ts - s.holdT > 1200) { s.hold = s.v; s.holdT = ts; }
    const clip = `inset(${vertical ? `${(1 - s.v) * 100}% 0 0 0` : `0 ${(1 - s.v) * 100}% 0 0`})`;
    bar.current.style.clipPath = clip;
    if (hold.current) {
      if (vertical) hold.current.style.bottom = `${s.hold * 100}%`; else hold.current.style.left = `${s.hold * 100}%`;
      hold.current.style.opacity = s.hold > 0.01 ? 1 : 0;
      hold.current.style.background = s.hold > 0.985 ? '#ff4d5e' : '#fff';
    }
  }, [engine, get]);
  return (
    <div className={cx('relative overflow-hidden rounded-sm bg-black/50', className)} style={style}>
      <div ref={bar} className="absolute inset-0" style={{ background: vertical ? METER_BG.replace('90deg', '0deg') : METER_BG, clipPath: 'inset(0 100% 0 0)' }} />
      <div ref={hold} className={cx('absolute', vertical ? 'left-0 right-0 h-px' : 'top-0 bottom-0 w-px')} style={{ opacity: 0 }} />
    </div>
  );
}

// ---------------------------------------------------------------- compact slider (track headers)

/** A thin slider with a label and value read-out. onChange while dragging, onCommit when released. */
export function MiniSlider({ label, value, min, max, step = 0.1, format, onChange, onCommit, reset = 0, disabled, title }) {
  return (
    <label className={cx('flex items-center gap-1.5 text-[10.5px] text-fg2 min-w-0', disabled && 'opacity-50')} title={title} onDoubleClick={() => { if (!disabled) { onChange(reset); onCommit?.(reset); } }}>
      <span className="w-6 shrink-0 text-fg3">{label}</span>
      <input type="range" className="sl-range flex-1 min-w-0 !h-3.5" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} onPointerUp={(e) => onCommit?.(Number(e.target.value))} onKeyUp={(e) => onCommit?.(Number(e.target.value))} />
      <span className="w-10 shrink-0 text-right tabular-nums text-fg">{format ? format(value) : value}</span>
    </label>
  );
}

// ---------------------------------------------------------------- time

/** 1:02.345 (or 1:02:03.345 past an hour). */
export function fmtClock(s, ms = true) {
  if (!Number.isFinite(s)) s = 0;
  const neg = s < 0; s = Math.abs(s);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  const ss = ms ? sec.toFixed(3).padStart(6, '0') : String(Math.floor(sec)).padStart(2, '0');
  return `${neg ? '-' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${ss}`;
}

/** Tick spacing for a ruler: the smallest "nice" step that leaves ≥ minPx between labels. */
export function rulerStep(pps, minPx = 80) {
  const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  return steps.find((s) => s * pps >= minPx) || 3600;
}
export function fmtRuler(t, step) {
  const m = Math.floor(t / 60); const s = t - m * 60;
  const dec = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
}

// ---------------------------------------------------------------- icons

const PATHS = {
  reverse: ['M4 12h16', 'M8 8l-4 4 4 4', 'M16 8l4 4-4 4'],
  invert: ['M3 12h18', 'M5 8c2-5 4-5 6 0', 'M13 16c2 5 4 5 6 0'],
  silence: ['M3 12h18', 'M7 9v6M17 9v6'],
  paste: ['M9 4h6v3H9z', 'M7 5H5v15h14V5h-2', 'M9 12h6M9 16h4'],
  amplify: ['M3 18 21 6v12z'],
  print: ['M4 20V10M8 20V6M12 20V12M16 20V8M20 20V14', 'M2 4h20'],
  track: ['M3 7h18M3 12h18M3 17h18'],
  solo: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
};
export function AIcon({ name, size = 18, className }) {
  const d = PATHS[name];
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={cx('shrink-0', className)} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {(Array.isArray(d) ? d : [d]).map((x, i) => <path key={i} d={x} />)}
    </svg>
  );
}
