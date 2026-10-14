// Paint's widgets: the colour wheel (hue ring + saturation/brightness square, HSB sliders, recent and library
// colours), the pressure-curve pad, and the brush settings panel.
import { useEffect, useRef, useState } from 'react';
import { Slider, Toggle, Select, cx, useRecentColors, rememberColor, libraryColorStore } from '../../components/ui.jsx';
import { parse, toHex, rgbToHsv, hsvToRgb } from '../../lib/color.js';
import { BLEND_MODES } from '../_raster/model.js';

export function ColorWheel({ value, onChange, size = 220 }) {
  const ref = useRef(null);
  const [hsv, setHsv] = useState(() => rgbToHsv(parse(value)));
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { const n = rgbToHsv(parse(value)); setHsv((p) => (n.s === 0 || n.v === 0 ? { ...n, h: p.h } : n)); last.current = value; } }, [value]);
  const R = size / 2; const ring = 18; const sq = (R - ring - 8) * Math.SQRT2;
  useEffect(() => {
    const c = ref.current; const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr; c.height = size * dpr;
    const ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, size, size);
    // hue ring
    for (let a = 0; a < 360; a += 1) {
      ctx.beginPath(); ctx.strokeStyle = `hsl(${a},100%,50%)`; ctx.lineWidth = ring;
      ctx.arc(R, R, R - ring / 2 - 1, ((a - 90 - 0.7) * Math.PI) / 180, ((a - 90 + 0.7) * Math.PI) / 180); ctx.stroke();
    }
    // saturation/brightness square
    const x0 = R - sq / 2; const y0 = R - sq / 2;
    const g1 = ctx.createLinearGradient(x0, 0, x0 + sq, 0); g1.addColorStop(0, '#fff'); g1.addColorStop(1, `hsl(${hsv.h},100%,50%)`);
    ctx.fillStyle = g1; ctx.fillRect(x0, y0, sq, sq);
    const g2 = ctx.createLinearGradient(0, y0, 0, y0 + sq); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000');
    ctx.fillStyle = g2; ctx.fillRect(x0, y0, sq, sq);
    // markers
    const ha = ((hsv.h - 90) * Math.PI) / 180;
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.arc(R + Math.cos(ha) * (R - ring / 2 - 1), R + Math.sin(ha) * (R - ring / 2 - 1), ring / 2 - 1, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x0 + hsv.s * sq, y0 + (1 - hsv.v) * sq, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x0 + hsv.s * sq, y0 + (1 - hsv.v) * sq, 7.5, 0, Math.PI * 2); ctx.stroke();
  }, [hsv, size, R, sq]);
  const emit = (n, commit) => { setHsv(n); const hex = toHex(hsvToRgb(n)); last.current = hex; onChange(hex); if (commit) rememberColor(hex); };
  const down = (e) => {
    const r = ref.current.getBoundingClientRect();
    const x = e.clientX - r.left - R; const y = e.clientY - r.top - R;
    const inRing = Math.hypot(x, y) > R - ring - 4;
    const go = (ev, commit) => {
      const px = ev.clientX - r.left - R; const py = ev.clientY - r.top - R;
      if (inRing) emit({ ...hsvRef.current, h: ((Math.atan2(py, px) * 180) / Math.PI + 90 + 360) % 360 }, commit);
      else emit({ ...hsvRef.current, s: Math.max(0, Math.min(1, (px + sq / 2) / sq)), v: Math.max(0, Math.min(1, 1 - (py + sq / 2) / sq)) }, commit);
    };
    go(e);
    const mv = (ev) => go(ev); const up = (ev) => { go(ev, true); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const hsvRef = useRef(hsv); hsvRef.current = hsv;
  const recent = useRecentColors(); const lib = libraryColorStore.use();
  const pick = (c) => { emit(rgbToHsv(parse(c)), true); };
  const rgb = hsvToRgb(hsv);
  return (
    <div className="select-none">
      <canvas ref={ref} onPointerDown={down} style={{ width: size, height: size }} className="mx-auto block cursor-crosshair touch-none" aria-label="Colour wheel" />
      <div className="flex flex-col gap-1.5 mt-2">
        <Slider label="Hue" value={Math.round(hsv.h)} min={0} max={359} unit="°" onChange={(v) => emit({ ...hsv, h: v })} onCommit={(v) => emit({ ...hsv, h: v }, true)} gradient="linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" />
        <Slider label="Saturation" value={Math.round(hsv.s * 100)} min={0} max={100} unit="%" onChange={(v) => emit({ ...hsv, s: v / 100 })} onCommit={(v) => emit({ ...hsv, s: v / 100 }, true)}
          gradient={`linear-gradient(to right,${toHex(hsvToRgb({ ...hsv, s: 0 }))},${toHex(hsvToRgb({ ...hsv, s: 1 }))})`} />
        <Slider label="Brightness" value={Math.round(hsv.v * 100)} min={0} max={100} unit="%" onChange={(v) => emit({ ...hsv, v: v / 100 })} onCommit={(v) => emit({ ...hsv, v: v / 100 }, true)}
          gradient={`linear-gradient(to right,#000,${toHex(hsvToRgb({ ...hsv, v: 1 }))})`} />
      </div>
      <div className="flex items-center gap-2 mt-2">
        <span className="w-7 h-7 rounded-full border border-line" style={{ background: toHex(rgb) }} />
        <input aria-label="Hex colour" defaultValue={toHex(rgb).slice(1).toUpperCase()} key={toHex(rgb)} className="w-20 h-7 rounded bg-input border border-line text-[12px] font-mono px-1.5 uppercase outline-none focus:border-accent/70"
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }}
          onBlur={(e) => { const v = e.currentTarget.value.trim().replace('#', ''); if (/^[0-9a-f]{6}$/i.test(v)) pick(`#${v}`); }} />
      </div>
      {[['Recent', recent], ['Libraries', lib]].map(([label, list]) => list?.length ? (
        <div key={label} className="mt-2">
          <div className="text-[10.5px] uppercase tracking-wider text-fg3 mb-1">{label}</div>
          <div className="flex flex-wrap gap-1">{list.slice(0, 16).map((c, i) => <button key={c + i} type="button" title={c} onClick={() => pick(c)} className="w-5 h-5 rounded-full border border-line hover:scale-110 transition" style={{ background: c }} />)}</div>
        </div>
      ) : null)}
    </div>
  );
}

/** Pressure → output curve, shown as y = x^gamma; drag the point to bend it. */
export function CurvePad({ label, gamma, onChange, enabled, onToggle }) {
  const size = 64;
  const ref = useRef(null);
  const y = Math.pow(0.5, gamma);
  const path = Array.from({ length: 33 }, (_, i) => { const x = i / 32; return `${i ? 'L' : 'M'}${x * size},${(1 - Math.pow(x, gamma)) * size}`; }).join('');
  const down = (e) => {
    const r = ref.current.getBoundingClientRect();
    const go = (ev) => { const v = Math.min(0.97, Math.max(0.03, 1 - (ev.clientY - r.top) / r.height)); onChange(Math.round((Math.log(v) / Math.log(0.5)) * 100) / 100); };
    go(e);
    const up = () => { window.removeEventListener('pointermove', go); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', go); window.addEventListener('pointerup', up);
  };
  return (
    <div className="flex items-center gap-3">
      <svg ref={ref} width={size} height={size} onPointerDown={enabled ? down : undefined} className={cx('rounded bg-input border border-line touch-none shrink-0', enabled ? 'cursor-ns-resize' : 'opacity-40')}>
        <line x1={0} y1={size} x2={size} y2={0} stroke="rgba(255,255,255,.12)" />
        <path d={path} fill="none" stroke="#ff6fa8" strokeWidth={2} />
        <circle cx={size / 2} cy={(1 - y) * size} r={4} fill="#ff6fa8" />
      </svg>
      <div className="flex flex-col gap-1">
        <Toggle checked={enabled} onChange={onToggle} label={label} />
        <span className="text-[11px] text-fg3">{enabled ? (gamma < 0.9 ? 'Light touch' : gamma > 1.1 ? 'Firm touch' : 'Linear') : 'Off'}</span>
      </div>
    </div>
  );
}

export function BrushSettings({ fam, b, set }) {
  const direct = b.kind === 'smudge' || b.kind === 'blend';
  return (
    <div className="flex flex-col gap-2.5">
      <Slider label="Size" value={Math.round(b.size)} min={1} max={800} unit="px" onChange={(v) => set({ size: v })} />
      {!direct && <Slider label="Opacity" value={Math.round(b.opacity * 100)} min={1} max={100} unit="%" onChange={(v) => set({ opacity: v / 100 })} />}
      {!direct && <Slider label="Flow" value={Math.round(b.flow * 100)} min={1} max={100} unit="%" onChange={(v) => set({ flow: v / 100 })} />}
      {direct && <Slider label={b.kind === 'blend' ? 'Blending' : 'Strength'} value={Math.round((b.strength ?? 0.5) * 100)} min={1} max={100} unit="%" onChange={(v) => set({ strength: v / 100 })} />}
      <Slider label="Smoothing" value={b.smoothing || 0} min={0} max={100} unit="%" onChange={(v) => set({ smoothing: v })} />
      <Slider label="Hardness" value={Math.round(b.hardness * 100)} min={0} max={100} unit="%" onChange={(v) => set({ hardness: v / 100 })} />
      <Slider label="Spacing" value={Math.round(b.spacing * 100)} min={1} max={100} unit="%" onChange={(v) => set({ spacing: v / 100 })} />
      <div className="text-[10.5px] uppercase tracking-wider text-fg3 mt-1">Pressure</div>
      <CurvePad label="Size" gamma={b.sizeCurve ?? 1} enabled={b.pressureSize !== false} onToggle={(v) => set({ pressureSize: v })} onChange={(g) => set({ sizeCurve: g })} />
      {b.pressureSize !== false && <Slider label="Minimum size" value={Math.round((b.minSize ?? 0.15) * 100)} min={0} max={100} unit="%" onChange={(v) => set({ minSize: v / 100 })} />}
      <CurvePad label="Opacity" gamma={b.opacityCurve ?? 1} enabled={!!b.pressureOpacity} onToggle={(v) => set({ pressureOpacity: v })} onChange={(g) => set({ opacityCurve: g })} />
      <Toggle checked={!!b.tilt} onChange={(v) => set({ tilt: v })} label="Pen tilt shapes the tip" />
      {!direct && fam !== 'eraser' && (
        <>
          <div className="text-[10.5px] uppercase tracking-wider text-fg3 mt-1">Colour jitter</div>
          <Slider label="Hue" value={Math.round((b.jitterHue || 0) * 100)} min={0} max={100} unit="%" onChange={(v) => set({ jitterHue: v / 100 })} />
          <Slider label="Saturation" value={Math.round((b.jitterSat || 0) * 100)} min={0} max={100} unit="%" onChange={(v) => set({ jitterSat: v / 100 })} />
          <Slider label="Brightness" value={Math.round((b.jitterBri || 0) * 100)} min={0} max={100} unit="%" onChange={(v) => set({ jitterBri: v / 100 })} />
          <div className="flex items-center gap-2"><span className="text-xs text-fg2">Blend</span><Select small value={b.blend || 'source-over'} onChange={(v) => set({ blend: v })} options={BLEND_MODES} className="flex-1" /></div>
        </>
      )}
      {fam === 'watercolor' && <Toggle checked={!!b.wetEdges} onChange={(v) => set({ wetEdges: v })} label="Wet edges" />}
      {fam === 'watercolor' && <Slider label="Colour bleed" value={Math.round((b.pickup || 0) * 100)} min={0} max={100} unit="%" onChange={(v) => set({ pickup: v / 100 })} />}
      {fam === 'airbrush' && <Toggle checked={!!b.buildUp} onChange={(v) => set({ buildUp: v })} label="Build up while held" />}
    </div>
  );
}

/** Fresco-style vertical size and opacity sliders at the left edge of the canvas. */
export function SideSliders({ size, onSize, opacity, onOpacity, color }) {
  const toPos = (s) => Math.log(s) / Math.log(800);
  return (
    <div className="absolute left-3 top-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-3 px-1.5 py-3 rounded-full bg-panel/90 border border-line shadow-lg">
      <span className="rounded-full border border-fg3 grid place-items-center" style={{ width: 22, height: 22 }}><span className="rounded-full" style={{ width: Math.max(2, Math.min(20, size / 6)), height: Math.max(2, Math.min(20, size / 6)), background: color }} /></span>
      <input type="range" aria-label="Brush size" min={0} max={1} step={0.001} value={toPos(size)} onChange={(e) => onSize(Math.max(1, Math.round(Math.pow(800, Number(e.target.value)))))}
        className="sl-range" style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 130, width: 18 }} />
      <span className="text-[10px] text-fg2 tabular-nums">{Math.round(size)}</span>
      <div className="w-5 h-px bg-line" />
      <input type="range" aria-label="Opacity" min={1} max={100} value={Math.round(opacity * 100)} onChange={(e) => onOpacity(Number(e.target.value) / 100)}
        className="sl-range" style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 100, width: 18 }} />
      <span className="text-[10px] text-fg2 tabular-nums">{Math.round(opacity * 100)}%</span>
    </div>
  );
}
