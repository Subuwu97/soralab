// Photo's right-hand panels: Navigator, Colour/Swatches, Properties (contextual, incl. adjustment settings and
// layer effects), Adjustments, History.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Slider, Select, Segmented, Toggle, ColorSwatch, ColorPicker, NumberInput, Button, toast, toastError, cx } from '../../components/ui.jsx';
import { FontPicker, WeightPicker } from '../../components/Pickers.jsx';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/app.jsx';
import { Icon, IBtn } from '../_raster/icons.jsx';
import { ADJUSTMENTS, ADJUST_ORDER, curveLut, histogram } from '../_raster/adjust.js';
import { updateLayer, layerLabel } from '../_raster/model.js';
import { viewMatrix } from '../_raster/Viewport.jsx';

// ---------------------------------------------------------------- navigator

export function Navigator({ renderer, doc, view, onView, vpSize, version }) {
  const ref = useRef(null);
  const W = 248; const s = Math.min(W / doc.width, 150 / doc.height); const w = Math.round(doc.width * s); const h = Math.round(doc.height * s);
  useEffect(() => {
    const t = setTimeout(() => {
      const c = ref.current; if (!c) return;
      c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, w, h); ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(renderer.canvas, 0, 0, w, h);
    }, 120);
    return () => clearTimeout(t);
  }, [version, w, h, renderer]);
  // the visible area as a rectangle on the thumbnail
  let vr = null;
  if (vpSize?.w && view.zoom) {
    const inv = viewMatrix(view, vpSize.w, vpSize.h).inverse();
    const pts = [[0, 0], [vpSize.w, 0], [vpSize.w, vpSize.h], [0, vpSize.h]].map(([x, y]) => inv.transformPoint(new DOMPoint(x, y)));
    const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
    vr = { x: Math.min(...xs) * s, y: Math.min(...ys) * s, w: (Math.max(...xs) - Math.min(...xs)) * s, h: (Math.max(...ys) - Math.min(...ys)) * s };
  }
  const drag = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const go = (ev) => onView({ ...view, cx: (ev.clientX - r.left) / s, cy: (ev.clientY - r.top) / s });
    go(e);
    const up = () => { window.removeEventListener('pointermove', go); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', go); window.addEventListener('pointerup', up);
  };
  return (
    <div>
      <div className="relative mx-auto checker overflow-hidden cursor-pointer" style={{ width: w, height: h }} onPointerDown={drag}>
        <canvas ref={ref} className="absolute inset-0" />
        {vr && <div className="absolute border-2 border-danger pointer-events-none" style={{ left: vr.x, top: vr.y, width: vr.w, height: vr.h }} />}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <IBtn icon="zoomOut" size={24} label="Zoom out" onClick={() => onView({ ...view, zoom: Math.max(0.01, view.zoom / 1.5) })} />
        <input type="range" className="sl-range flex-1" min={-4.6} max={4.15} step={0.01} value={Math.log(view.zoom)} aria-label="Zoom" onChange={(e) => onView({ ...view, zoom: Math.exp(Number(e.target.value)) })} />
        <IBtn icon="zoomIn" size={24} label="Zoom in" onClick={() => onView({ ...view, zoom: Math.min(64, view.zoom * 1.5) })} />
        <span className="text-[11px] tabular-nums text-fg2 w-11 text-right">{Math.round(view.zoom * 100)}%</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- colour

export function ColorPanel({ fg, bg, setFg, setBg, editing, setEditing, docColors }) {
  const { libraries, reloadLibraries } = useApp();
  const value = editing === 'bg' ? bg : fg;
  const set = editing === 'bg' ? setBg : setFg;
  const addToLibrary = async () => {
    try {
      let lib = libraries[0];
      if (!lib) lib = await api.post('/api/libraries', { name: 'My Library' });
      await api.post(`/api/libraries/${lib.id}/items`, { kind: 'color', name: value.toUpperCase(), data: { hex: value } });
      await reloadLibraries?.();
      toast(`Added ${value.toUpperCase()} to ${lib.name}`, { type: 'success' });
    } catch (e) { toastError(e); }
  };
  return (
    <div>
      <div className="flex items-center gap-3 mb-1">
        <FgBg fg={fg} bg={bg} editing={editing} setEditing={setEditing} onSwap={() => { setFg(bg); setBg(fg); }} onReset={() => { setFg('#000000'); setBg('#ffffff'); }} />
        <div className="flex-1 text-[11px] text-fg3 leading-tight">Editing the <b className="text-fg2">{editing === 'bg' ? 'background' : 'foreground'}</b> colour. X swaps, D resets.</div>
        <IBtn icon="library" size={26} label="Add to library" onClick={addToLibrary} />
      </div>
      <ColorPicker value={value} onChange={(c) => set(c.slice(0, 7))} alpha={false} className="!w-full !px-0" />
      {docColors?.length > 0 && (
        <div className="mt-2">
          <div className="text-[10.5px] uppercase tracking-wider text-fg3 mb-1">In this document</div>
          <div className="flex flex-wrap gap-1">{docColors.map((c) => <button key={c} type="button" title={c} onClick={() => set(c)} className="w-[22px] h-[22px] rounded border border-line" style={{ background: c }} />)}</div>
        </div>
      )}
    </div>
  );
}

/** Photoshop-style overlapping foreground/background squares. */
export function FgBg({ fg, bg, editing, setEditing, onSwap, onReset, size = 26 }) {
  return (
    <div className="relative shrink-0" style={{ width: size * 1.55, height: size * 1.55 }}>
      <button type="button" aria-label="Background colour" title="Background colour" onClick={() => setEditing('bg')}
        className={cx('absolute right-0 bottom-0 rounded-[3px] border', editing === 'bg' ? 'border-accent ring-1 ring-accent' : 'border-fg3')} style={{ width: size, height: size, background: bg }} />
      <button type="button" aria-label="Foreground colour" title="Foreground colour" onClick={() => setEditing('fg')}
        className={cx('absolute left-0 top-0 rounded-[3px] border', editing !== 'bg' ? 'border-accent ring-1 ring-accent' : 'border-fg3')} style={{ width: size, height: size, background: fg }} />
      <button type="button" title="Swap colours (X)" aria-label="Swap colours" onClick={onSwap} className="absolute -right-1 -top-1 text-fg2 hover:text-fg"><Icon name="swap" size={12} /></button>
      <button type="button" title="Default colours (D)" aria-label="Default colours" onClick={onReset} className="absolute -left-1 -bottom-1 text-fg2 hover:text-fg"><Icon name="defaultColors" size={12} /></button>
    </div>
  );
}

// ---------------------------------------------------------------- history

export function HistoryPanel({ h }) {
  const ref = useRef(null);
  useEffect(() => {
    // scroll the list itself (scrollIntoView would also scroll the whole panel column)
    const el = ref.current; const cur = el?.querySelector('[data-current]');
    if (el && cur && (cur.offsetTop < el.scrollTop || cur.offsetTop + cur.offsetHeight > el.scrollTop + el.clientHeight)) el.scrollTop = cur.offsetTop - el.clientHeight + cur.offsetHeight;
  }, [h.index]);
  return (
    <div ref={ref} className="relative max-h-56 overflow-y-auto scroll-thin -mx-3">
      {h.entries.map((label, i) => (
        <button key={i} type="button" data-current={i === h.index ? '' : undefined} onClick={() => h.jump(i)}
          className={cx('w-full flex items-center gap-2 px-3 h-7 text-[12.5px] text-left', i === h.index ? 'bg-active text-fg' : i > h.index ? 'text-fg3 hover:bg-hover' : 'text-fg2 hover:bg-hover')}>
          <Icon name={i === 0 ? 'image' : 'history'} size={13} />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- adjustments panel

export function AdjustmentsPanel({ onAdd, disabled }) {
  return (
    <div className="grid grid-cols-5 gap-1">
      {ADJUST_ORDER.map((k) => (
        <IBtn key={k} icon={ADJUSTMENTS[k].icon} label={ADJUSTMENTS[k].label} size={40} iconSize={18} disabled={disabled} onClick={() => onAdd(k)} className="!w-full" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- adjustment settings (layer properties and Image → Adjustments)

const S = ({ label, value, onChange, min, max, step = 1, unit, reset = 0, gradient }) => (
  <Slider label={label} value={value} onChange={onChange} min={min} max={max} step={step} unit={unit} reset={reset} gradient={gradient} />
);

export function AdjustEditor({ adj, onChange, histo }) {
  const set = (patch) => onChange({ ...adj, ...patch });
  const [tone, setTone] = useState('midtones');
  switch (adj.kind) {
    case 'brightness': return <div className="flex flex-col gap-2"><S label="Brightness" value={adj.brightness} min={-100} max={100} onChange={(v) => set({ brightness: v })} /><S label="Contrast" value={adj.contrast} min={-100} max={100} onChange={(v) => set({ contrast: v })} /></div>;
    case 'levels': return (
      <div className="flex flex-col gap-2">
        <Select small value={adj.channel} onChange={(v) => set({ channel: v })} options={[{ value: 'rgb', label: 'RGB' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }]} />
        <Histogram data={histo?.[adj.channel] || histo?.rgb} marks={[adj.inBlack, adj.inBlack + (adj.inWhite - adj.inBlack) * Math.pow(0.5, adj.gamma), adj.inWhite]} />
        <S label="Input black" value={adj.inBlack} min={0} max={253} onChange={(v) => set({ inBlack: Math.min(v, adj.inWhite - 2) })} />
        <S label="Midtones (gamma)" value={adj.gamma} min={0.1} max={9.99} step={0.01} reset={1} onChange={(v) => set({ gamma: v })} />
        <S label="Input white" value={adj.inWhite} min={2} max={255} reset={255} onChange={(v) => set({ inWhite: Math.max(v, adj.inBlack + 2) })} />
        <S label="Output black" value={adj.outBlack} min={0} max={255} onChange={(v) => set({ outBlack: v })} />
        <S label="Output white" value={adj.outWhite} min={0} max={255} reset={255} onChange={(v) => set({ outWhite: v })} />
        <Button size="xs" variant="outline" onClick={() => onChange({ ...adj, ...autoLevels(histo?.rgb) })}>Auto</Button>
      </div>
    );
    case 'curves': return <CurvesEditor adj={adj} onChange={onChange} histo={histo} />;
    case 'exposure': return <div className="flex flex-col gap-2"><S label="Exposure" value={adj.exposure} min={-5} max={5} step={0.01} onChange={(v) => set({ exposure: v })} /><S label="Offset" value={adj.offset} min={-0.5} max={0.5} step={0.001} onChange={(v) => set({ offset: v })} /><S label="Gamma" value={adj.gamma} min={0.1} max={3} step={0.01} reset={1} onChange={(v) => set({ gamma: v })} /></div>;
    case 'vibrance': return <div className="flex flex-col gap-2"><S label="Vibrance" value={adj.vibrance} min={-100} max={100} onChange={(v) => set({ vibrance: v })} /><S label="Saturation" value={adj.saturation} min={-100} max={100} onChange={(v) => set({ saturation: v })} /></div>;
    case 'hueSat': return (
      <div className="flex flex-col gap-2">
        <S label="Hue" value={adj.hue} min={-180} max={180} onChange={(v) => set({ hue: v })} gradient="linear-gradient(to right,#0ff,#00f,#f0f,#f00,#ff0,#0f0,#0ff)" />
        <S label="Saturation" value={adj.saturation} min={-100} max={100} onChange={(v) => set({ saturation: v })} />
        <S label="Lightness" value={adj.lightness} min={-100} max={100} onChange={(v) => set({ lightness: v })} />
        <Toggle checked={adj.colorize} onChange={(v) => set({ colorize: v })} label="Colorize" />
      </div>
    );
    case 'colorBalance': {
      const arr = adj[tone];
      const setC = (i, v) => { const n = [...arr]; n[i] = v; set({ [tone]: n }); };
      return (
        <div className="flex flex-col gap-2">
          <Segmented value={tone} onChange={setTone} options={[{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }]} />
          <S label="Cyan — Red" value={arr[0]} min={-100} max={100} onChange={(v) => setC(0, v)} gradient="linear-gradient(to right,#0ff,#f00)" />
          <S label="Magenta — Green" value={arr[1]} min={-100} max={100} onChange={(v) => setC(1, v)} gradient="linear-gradient(to right,#f0f,#0f0)" />
          <S label="Yellow — Blue" value={arr[2]} min={-100} max={100} onChange={(v) => setC(2, v)} gradient="linear-gradient(to right,#ff0,#00f)" />
          <Toggle checked={adj.preserve} onChange={(v) => set({ preserve: v })} label="Preserve luminosity" />
        </div>
      );
    }
    case 'bw': return (
      <div className="flex flex-col gap-2">
        {[['reds', 'Reds', '#f33'], ['yellows', 'Yellows', '#ee3'], ['greens', 'Greens', '#3e3'], ['cyans', 'Cyans', '#3ee'], ['blues', 'Blues', '#33f'], ['magentas', 'Magentas', '#e3e']].map(([k, l, c]) => (
          <S key={k} label={l} value={adj[k]} min={-200} max={300} reset={ADJUSTMENTS.bw.defaults[k]} onChange={(v) => set({ [k]: v })} gradient={`linear-gradient(to right,#000,${c})`} />
        ))}
        <div className="flex items-center gap-2"><Toggle checked={adj.tint} onChange={(v) => set({ tint: v })} label="Tint" />{adj.tint && <ColorSwatch value={adj.tintColor} alpha={false} onChange={(v) => set({ tintColor: v })} size={22} />}</div>
      </div>
    );
    case 'photoFilter': return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Select small value={['#ec8a00', '#006dff', '#ea1a1a', '#19c919', '#ffd500'].includes(adj.color) ? adj.color : 'custom'} onChange={(v) => v !== 'custom' && set({ color: v })}
            options={[{ value: '#ec8a00', label: 'Warming filter (85)' }, { value: '#006dff', label: 'Cooling filter (80)' }, { value: '#ea1a1a', label: 'Red' }, { value: '#19c919', label: 'Green' }, { value: '#ffd500', label: 'Yellow' }, { value: 'custom', label: 'Custom' }]} className="flex-1" />
          <ColorSwatch value={adj.color} alpha={false} onChange={(v) => set({ color: v })} size={24} />
        </div>
        <S label="Density" value={adj.density} min={0} max={100} unit="%" reset={25} onChange={(v) => set({ density: v })} />
        <Toggle checked={adj.preserve} onChange={(v) => set({ preserve: v })} label="Preserve luminosity" />
      </div>
    );
    case 'posterize': return <S label="Levels" value={adj.levels} min={2} max={64} reset={4} onChange={(v) => set({ levels: v })} />;
    case 'threshold': return (<div className="flex flex-col gap-2"><Histogram data={histo?.rgb} marks={[adj.level]} /><S label="Threshold level" value={adj.level} min={1} max={255} reset={128} onChange={(v) => set({ level: v })} /></div>);
    case 'gradientMap': return (
      <div className="flex flex-col gap-2">
        <div className="h-5 rounded border border-line" style={{ background: `linear-gradient(to right, ${(adj.reverse ? [...adj.colors].reverse() : adj.colors).join(',')})` }} />
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg2">Shadows</span><ColorSwatch value={adj.colors[0]} alpha={false} onChange={(v) => set({ colors: [v, adj.colors[1]] })} size={22} />
          <span className="text-xs text-fg2 ml-2">Highlights</span><ColorSwatch value={adj.colors[1]} alpha={false} onChange={(v) => set({ colors: [adj.colors[0], v] })} size={22} />
        </div>
        <Toggle checked={adj.reverse} onChange={(v) => set({ reverse: v })} label="Reverse" />
      </div>
    );
    case 'invert': return <p className="text-xs text-fg2">Inverts every colour below this layer. Nothing to set.</p>;
    default: return null;
  }
}

function autoLevels(h) {
  if (!h) return {};
  const total = h.reduce((a, b) => a + b, 0); const clip = total * 0.001;
  let lo = 0; let acc = 0; while (lo < 254 && (acc += h[lo]) < clip) lo++;
  let hi = 255; acc = 0; while (hi > lo + 2 && (acc += h[hi]) < clip) hi--;
  return { inBlack: lo, inWhite: hi, gamma: 1 };
}

function Histogram({ data, marks = [], height = 70 }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    c.width = 256; c.height = height;
    const ctx = c.getContext('2d'); ctx.clearRect(0, 0, 256, height);
    if (data) {
      const max = Math.max(1, ...Array.from(data).sort((a, b) => b - a).slice(2, 3));
      ctx.fillStyle = 'rgba(200,205,220,.75)';
      for (let i = 0; i < 256; i++) { const v = Math.min(1, data[i] / max) * height; ctx.fillRect(i, height - v, 1, v); }
    }
    ctx.fillStyle = '#5AB4FF';
    for (const m of marks) ctx.fillRect(Math.round(m) - 1, 0, 2, height);
  }, [data, marks, height]);
  return <canvas ref={ref} className="w-full rounded bg-input border border-line" style={{ height, imageRendering: 'pixelated' }} />;
}

/** Curves: click to add a point, drag to move, drag off the box to remove. Per channel. */
function CurvesEditor({ adj, onChange, histo }) {
  const [ch, setCh] = useState('rgb');
  const pts = (ch === 'rgb' ? adj.points : adj[ch]) || [[0, 0], [255, 255]];
  const setPts = (p) => onChange({ ...adj, ...(ch === 'rgb' ? { points: p } : { [ch]: p }) });
  const ref = useRef(null);
  const size = 236;
  const lut = useMemo(() => curveLut(pts), [pts]);
  const toVal = (e) => { const r = ref.current.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) / r.width) * 255), Math.round((1 - (e.clientY - r.top) / r.height) * 255)]; };
  const down = (e) => {
    e.preventDefault();
    const [x, y] = toVal(e);
    let list = pts.map((p) => [...p]);
    let i = list.findIndex((p) => Math.abs(p[0] - x) < 8 && Math.abs(p[1] - y) < 12);
    if (i < 0) { list.push([x, Math.round(lut[Math.max(0, Math.min(255, x))])]); list.sort((a, b) => a[0] - b[0]); i = list.findIndex((p) => p[0] === x); }
    setPts(list);
    const move = (ev) => {
      const [nx, ny] = toVal(ev);
      const out = nx < -20 || nx > 275 || ny < -20 || ny > 275;
      const l2 = list.map((p) => [...p]);
      if (out && l2.length > 2 && i > 0 && i < l2.length - 1) { l2.splice(i, 1); setPts(l2); return; }
      const lo = i > 0 ? l2[i - 1][0] + 1 : 0; const hi = i < l2.length - 1 ? l2[i + 1][0] - 1 : 255;
      l2[i] = [Math.max(lo, Math.min(hi, nx)), Math.max(0, Math.min(255, ny))];
      setPts(l2);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const col = { rgb: '#eceef6', r: '#ff5c6c', g: '#3ccf8e', b: '#5AB4FF' }[ch];
  const path = Array.from({ length: 64 }, (_, k) => { const x = (k / 63) * 255; return `${k ? 'L' : 'M'}${(x / 255) * size},${(1 - lut[Math.round(x)] / 255) * size}`; }).join('');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select small value={ch} onChange={setCh} options={[{ value: 'rgb', label: 'RGB' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }]} />
        <Button size="xs" variant="ghost" onClick={() => setPts([[0, 0], [255, 255]])}>Reset</Button>
      </div>
      <div className="relative" style={{ width: size, height: size }}>
        <div className="absolute inset-0 opacity-60"><Histogram data={histo?.[ch] || histo?.rgb} height={size} /></div>
        <svg ref={ref} width={size} height={size} className="absolute inset-0 cursor-crosshair touch-none" onPointerDown={down}>
          {[1, 2, 3].map((k) => <g key={k} stroke="rgba(255,255,255,.12)"><line x1={k * size / 4} y1={0} x2={k * size / 4} y2={size} /><line y1={k * size / 4} x1={0} y2={k * size / 4} x2={size} /></g>)}
          <line x1={0} y1={size} x2={size} y2={0} stroke="rgba(255,255,255,.2)" />
          <path d={path} fill="none" stroke={col} strokeWidth={1.6} />
          {pts.map(([x, y], i) => <rect key={i} x={(x / 255) * size - 4} y={(1 - y / 255) * size - 4} width={8} height={8} fill="#1d1f26" stroke={col} />)}
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- layer effects

export const FX_DEFAULTS = {
  shadow: { on: true, color: '#000000', opacity: 0.6, angle: 135, distance: 10, size: 12 },
  stroke: { on: true, color: '#000000', size: 3 },
  glow: { on: true, color: '#ffe08a', opacity: 0.8, size: 18 },
  overlay: { on: true, color: '#ff3b30', opacity: 1 },
};
export const FX_LABELS = { shadow: 'Drop Shadow', stroke: 'Stroke', glow: 'Outer Glow', overlay: 'Color Overlay' };

function FxEditor({ layer, set }) {
  const fx = layer.fx || {};
  const upd = (k, patch, key) => set({ fx: { ...fx, [k]: { ...FX_DEFAULTS[k], ...fx[k], ...patch } } }, FX_LABELS[k], key);
  return (
    <div className="flex flex-col gap-2">
      {Object.keys(FX_LABELS).map((k) => {
        const f = fx[k];
        return (
          <div key={k} className="rounded-md border border-line p-2">
            <div className="flex items-center gap-2">
              <Toggle checked={!!f?.on} onChange={(v) => upd(k, { on: v })} label={FX_LABELS[k]} />
              <span className="flex-1" />
              {f?.on && <ColorSwatch value={f.color} alpha={false} size={20} onChange={(v) => upd(k, { color: v }, `fxc-${k}`)} />}
            </div>
            {f?.on && (
              <div className="flex flex-col gap-1.5 mt-2">
                {'opacity' in FX_DEFAULTS[k] && <Slider label="Opacity" value={Math.round((f.opacity ?? 1) * 100)} min={0} max={100} unit="%" onChange={(v) => upd(k, { opacity: v / 100 }, `fx-${k}-o`)} />}
                {k === 'shadow' && <Slider label="Angle" value={f.angle} min={-180} max={180} unit="°" onChange={(v) => upd(k, { angle: v }, 'fx-sa')} />}
                {k === 'shadow' && <Slider label="Distance" value={f.distance} min={0} max={200} unit="px" onChange={(v) => upd(k, { distance: v }, 'fx-sd')} />}
                {k !== 'overlay' && <Slider label="Size" value={f.size} min={0} max={k === 'stroke' ? 50 : 150} unit="px" onChange={(v) => upd(k, { size: v }, `fx-${k}-s`)} />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- properties

export function PropertiesPanel({ layer, doc, commit, readOnly, target, histo, onRasterize, onEditText, onApplyMask, onDeleteMask, onMaskFromSel }) {
  if (!layer) return <p className="text-xs text-fg3">No layer selected.</p>;
  const set = (patch, label = 'Edit layer', merge) => !readOnly && commit(updateLayer(doc, layer.id, patch), label, merge ? { merge: `${layer.id}-${merge}` } : undefined);
  const num = (k, label, o = {}) => <NumberInput label={label} value={Math.round(layer[k] * 10) / 10} onChange={(v) => set({ [k]: v }, `Change ${label}`, k)} width={56} {...o} />;
  return (
    <div className={cx('flex flex-col gap-3', readOnly && 'pointer-events-none opacity-70')}>
      <div className="text-[11px] text-fg3 flex items-center gap-1.5"><Icon name={layer.type === 'text' ? 'text' : layer.type === 'shape' ? 'shapes' : layer.type === 'adjust' ? 'adjust' : layer.type === 'group' ? 'folder' : 'image'} size={13} />{layer.type === 'adjust' ? ADJUSTMENTS[layer.adj.kind]?.label : layerLabel(layer)}</div>
      {layer.type === 'adjust' && <AdjustEditor adj={layer.adj} histo={histo} onChange={(adj) => set({ adj }, ADJUSTMENTS[adj.kind].label, 'adj')} />}
      {layer.type === 'bitmap' && (
        <div className="flex items-center gap-2 flex-wrap">{num('x', 'X')}{num('y', 'Y')}<span className="text-[11px] text-fg3">offset (px)</span></div>
      )}
      {layer.type === 'text' && (
        <div className="flex flex-col gap-2">
          <textarea value={layer.text} rows={3} onChange={(e) => set({ text: e.target.value, name: e.target.value.split('\n')[0].slice(0, 30) || 'Text' }, 'Edit text', 'text')}
            className="w-full rounded-md bg-input border border-line text-sm p-2 outline-none focus:border-accent/70 resize-y" />
          <div className="flex items-center gap-2"><FontPicker value={layer.font} weight={layer.weight} onChange={(f) => set({ font: f }, 'Font')} width={150} /><WeightPicker family={layer.font} value={layer.weight} onChange={(w) => set({ weight: w }, 'Font weight')} /></div>
          <div className="flex items-center gap-2 flex-wrap">
            <NumberInput label="Size" value={Math.round(layer.size * 10) / 10} min={1} max={2000} unit="px" width={64} onChange={(v) => set({ size: v }, 'Font size', 'size')} />
            <ColorSwatch value={layer.color} alpha={false} size={24} onChange={(v) => set({ color: v }, 'Text colour', 'color')} />
            <IBtn icon="italic" size={26} label="Italic" active={layer.italic} onClick={() => set({ italic: !layer.italic }, 'Italic')} />
          </div>
          <Segmented value={layer.align} onChange={(v) => set({ align: v }, 'Align text')} options={[{ value: 'left', icon: 'alignLeft', title: 'Left' }, { value: 'center', icon: 'alignCenterH', title: 'Centre' }, { value: 'right', icon: 'alignRight', title: 'Right' }]} />
          <div className="flex items-center gap-2 flex-wrap">
            <NumberInput label="Leading" value={layer.lineHeight} step={0.05} min={0.5} max={4} width={52} onChange={(v) => set({ lineHeight: v }, 'Leading', 'lh')} />
            <NumberInput label="Tracking" value={layer.tracking} min={-200} max={1000} width={52} onChange={(v) => set({ tracking: v }, 'Tracking', 'tr')} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">{num('x', 'X')}{num('y', 'Y')}{num('rotation', 'Angle', { unit: '°' })}</div>
          <div className="flex gap-2"><Button size="xs" variant="outline" icon="edit" onClick={onEditText}>Edit on canvas</Button><Button size="xs" variant="outline" onClick={onRasterize}>Rasterize</Button></div>
        </div>
      )}
      {layer.type === 'shape' && (
        <div className="flex flex-col gap-2">
          <Select small value={layer.shape} onChange={(v) => set({ shape: v }, 'Shape')} options={[{ value: 'rect', label: 'Rectangle' }, { value: 'ellipse', label: 'Ellipse' }, { value: 'polygon', label: 'Polygon' }, { value: 'line', label: 'Line' }]} />
          <div className="flex items-center gap-2 flex-wrap">{num('x', 'X')}{num('y', 'Y')}{num('w', 'W')}{num('h', 'H')}{num('rotation', 'Angle', { unit: '°' })}</div>
          <div className="flex items-center gap-2"><span className="text-xs text-fg2 w-10">Fill</span><ColorSwatch value={layer.fill} none alpha onChange={(v) => set({ fill: v }, 'Shape fill', 'fill')} size={24} />
            <span className="text-xs text-fg2 w-12 ml-2">Stroke</span><ColorSwatch value={layer.stroke} none alpha onChange={(v) => set({ stroke: v }, 'Shape stroke', 'stroke')} size={24} /></div>
          <Slider label="Stroke width" value={layer.strokeWidth} min={0} max={100} unit="px" onChange={(v) => set({ strokeWidth: v }, 'Stroke width', 'sw')} />
          {layer.shape === 'rect' && <Slider label="Corner radius" value={layer.radius} min={0} max={500} unit="px" onChange={(v) => set({ radius: v }, 'Corner radius', 'rad')} />}
          {layer.shape === 'polygon' && <Slider label="Sides" value={layer.sides} min={3} max={24} onChange={(v) => set({ sides: v }, 'Sides', 'sides')} />}
          <div><Button size="xs" variant="outline" onClick={onRasterize}>Rasterize</Button></div>
        </div>
      )}
      {layer.type === 'fill' && (
        <div className="flex flex-col gap-2">
          <Segmented value={layer.fill.kind} onChange={(v) => set({ fill: v === 'gradient' ? { kind: 'gradient', type: 'linear', colors: [layer.fill.color || '#000000', '#ffffff'], angle: 90 } : { kind: 'solid', color: layer.fill.colors?.[0] || '#000000' } }, 'Fill type')}
            options={[{ value: 'solid', label: 'Solid colour' }, { value: 'gradient', label: 'Gradient' }]} />
          {layer.fill.kind === 'solid' ? <ColorSwatch value={layer.fill.color} alpha={false} size={28} onChange={(v) => set({ fill: { ...layer.fill, color: v } }, 'Fill colour', 'fc')} /> : (
            <>
              <div className="flex items-center gap-2"><ColorSwatch value={layer.fill.colors[0]} alpha onChange={(v) => set({ fill: { ...layer.fill, colors: [v, layer.fill.colors[1]] } }, 'Gradient', 'g0')} size={24} /><div className="flex-1 h-5 rounded border border-line" style={{ background: `linear-gradient(to right,${layer.fill.colors.join(',')})` }} /><ColorSwatch value={layer.fill.colors[1]} alpha onChange={(v) => set({ fill: { ...layer.fill, colors: [layer.fill.colors[0], v] } }, 'Gradient', 'g1')} size={24} /></div>
              <Segmented value={layer.fill.type} onChange={(v) => set({ fill: { ...layer.fill, type: v } }, 'Gradient style')} options={[{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }]} />
              <Slider label="Angle" value={layer.fill.angle ?? 90} min={-180} max={180} unit="°" onChange={(v) => set({ fill: { ...layer.fill, angle: v } }, 'Gradient angle', 'ga')} />
              <Slider label="Scale" value={Math.round((layer.fill.scale || 1) * 100)} min={10} max={300} unit="%" reset={100} onChange={(v) => set({ fill: { ...layer.fill, scale: v / 100 } }, 'Gradient scale', 'gs')} />
            </>
          )}
        </div>
      )}
      {layer.type === 'group' && <p className="text-xs text-fg2">{layer.children.length} layer{layer.children.length === 1 ? '' : 's'}. Blend mode “Pass Through” lets adjustments inside affect layers below the group.</p>}
      {layer.mask && (
        <div className="rounded-md border border-line p-2 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs"><Icon name="mask" size={14} /><b className="font-medium">Layer mask</b>{target === 'mask' && <span className="text-accent">(painting on the mask)</span>}</div>
          <div className="flex items-center gap-3 flex-wrap">
            <Toggle checked={layer.mask.enabled} onChange={(v) => set({ mask: { ...layer.mask, enabled: v } }, v ? 'Enable mask' : 'Disable mask')} label="Enabled" />
            <Toggle checked={!!layer.mask.inverted} onChange={() => set({ mask: { ...layer.mask, inverted: !layer.mask.inverted } }, 'Invert mask')} label="Inverted" />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {onMaskFromSel && <Button size="xs" variant="outline" onClick={onMaskFromSel}>From selection</Button>}
            {layer.type === 'bitmap' && <Button size="xs" variant="outline" onClick={onApplyMask}>Apply</Button>}
            <Button size="xs" variant="outline" onClick={onDeleteMask}>Delete</Button>
          </div>
        </div>
      )}
      {layer.type !== 'adjust' && (
        <details className="group" open={!!(layer.fx && Object.values(layer.fx).some((f) => f?.on))}>
          <summary className="text-[11px] uppercase tracking-wider text-fg2 cursor-pointer select-none flex items-center gap-1"><Icon name="fx" size={13} />Layer effects</summary>
          <div className="mt-2"><FxEditor layer={layer} set={(patch, label, key) => set(patch, label, key && `fx${key}`)} /></div>
        </details>
      )}
    </div>
  );
}

/** Histograms of the composite for Levels / Curves / Threshold (sampled). */
export function compositeHistograms(renderer) {
  const c = renderer.canvas;
  if (!c.width) return null;
  const s = Math.min(1, 400 / Math.max(c.width, c.height));
  const t = document.createElement('canvas'); t.width = Math.max(1, Math.round(c.width * s)); t.height = Math.max(1, Math.round(c.height * s));
  const ctx = t.getContext('2d', { willReadFrequently: true }); ctx.drawImage(c, 0, 0, t.width, t.height);
  const d = ctx.getImageData(0, 0, t.width, t.height).data;
  return { rgb: histogram(d, 'rgb'), r: histogram(d, 'r'), g: histogram(d, 'g'), b: histogram(d, 'b') };
}
