// Develop panels (right side): histogram, Basic, Tone Curve, Color Mixer, Color Grading, Detail, Optics, Effects,
// Profile (LUT) and the Masks panel. Every control edits one path in the photo's settings through `ed.set`.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Slider, PanelSection, Segmented, Select, Button, IconButton, Toggle, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { HSL_BANDS, MASK_ADJ, monotone, parametric, clamp } from './model.js';

export const getIn = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
export function setIn(o, path, v) {
  const [k, ...rest] = path.split('.');
  if (!rest.length) return Array.isArray(o) ? Object.assign([...o], { [k]: v }) : { ...o, [k]: v };
  return Array.isArray(o) ? Object.assign([...o], { [k]: setIn(o[k], rest.join('.'), v) }) : { ...o, [k]: setIn(o[k], rest.join('.'), v) };
}

const fmt = (v) => (v > 0 ? `+${v}` : `${v}`);

/** A settings slider. */
export function S({ ed, path, label, min = -100, max = 100, step = 1, def = 0, gradient, unit }) {
  const v = getIn(ed.s, path) ?? def;
  return (
    <Slider label={label} value={v} min={min} max={max} step={step} reset={def} unit={unit} gradient={gradient} disabled={ed.readOnly}
      onChange={(x) => ed.set(path, x, `${label} ${fmt(+Number(x).toFixed(2))}`)} onCommit={() => ed.commit()} className="mb-1.5" />
  );
}

// ---------------------------------------------------------------- histogram

export function Histogram({ hist, info }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth * dpr; const H = c.clientHeight * dpr;
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.clearRect(0, 0, W, H);
    if (!hist || !hist.n) return;
    // Smooth a little and scale to the 99th-percentile bin so one spike doesn't flatten the rest.
    const chans = [[hist.r, 'rgba(255,70,70,.75)'], [hist.g, 'rgba(70,220,90,.75)'], [hist.b, 'rgba(80,130,255,.8)']];
    const sm = (a) => Array.from(a, (_, i) => (a[Math.max(0, i - 1)] + 2 * a[i] + a[Math.min(255, i + 1)]) / 4);
    const all = chans.map(([a]) => sm(a));
    const sorted = all.flat().sort((p, q) => p - q);
    const top = Math.max(1, sorted[Math.floor(sorted.length * 0.995)]);
    x.globalCompositeOperation = 'lighter';
    all.forEach((a, k) => {
      x.fillStyle = chans[k][1];
      x.beginPath(); x.moveTo(0, H);
      for (let i = 0; i < 256; i++) x.lineTo((i / 255) * W, H - Math.min(1, a[i] / top) * H * 0.95);
      x.lineTo(W, H); x.closePath(); x.fill();
    });
    x.globalCompositeOperation = 'source-over';
  }, [hist]);
  return (
    <div className="px-3 pt-3 pb-2 border-b border-line">
      <div className="relative h-24 rounded bg-[#0b0d10] overflow-hidden border border-line">
        <canvas ref={ref} className="absolute inset-0 w-full h-full" aria-label="Histogram" />
      </div>
      {info && <div className="mt-1.5 text-[11px] text-fg3 truncate">{info}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- curve editor

const CH = [{ value: 'param', label: 'Param' }, { value: 'rgb', label: 'RGB' }, { value: 'r', label: 'R' }, { value: 'g', label: 'G' }, { value: 'b', label: 'B' }];
const CH_COLOR = { rgb: '#e8e8e8', r: '#ff5a5a', g: '#55d46a', b: '#5d8bff' };

function CurveEditor({ ed }) {
  const [ch, setCh] = useState('param');
  const box = useRef(null);
  const c = ed.s.curve;
  const pts = ch === 'param' ? null : c[ch];
  const N = 220;
  const f = useMemo(() => (ch === 'param' ? parametric(c.param) : monotone(pts)), [ch, c.param, pts]);
  const path = useMemo(() => {
    let d = '';
    for (let i = 0; i <= 64; i++) { const x = i / 64; d += `${i ? 'L' : 'M'}${x * N} ${(1 - clamp(f(x))) * N}`; }
    return d;
  }, [f]);
  const drag = useRef(null);
  const toXY = (e) => { const b = box.current.getBoundingClientRect(); return [clamp((e.clientX - b.left) / b.width), clamp(1 - (e.clientY - b.top) / b.height)]; };
  const setPts = (p, commit) => { ed.set(`curve.${ch}`, p, 'Tone curve'); if (commit) ed.commit(); };
  const down = (e) => {
    if (ed.readOnly || ch === 'param') return;
    e.preventDefault();
    const [x, y] = toXY(e);
    let i = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 0.05);
    let next = pts.map((p) => [...p]);
    if (i < 0) { next.push([x, clamp(f(x))]); next.sort((a, b) => a[0] - b[0]); i = next.findIndex((p) => p[0] === x); }
    drag.current = { i, pts: next };
    setPts(next);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e) => {
    const d = drag.current; if (!d) return;
    const [x, y] = toXY(e);
    const p = d.pts.map((q) => [...q]);
    const lo = d.i > 0 ? p[d.i - 1][0] + 0.01 : 0; const hi = d.i < p.length - 1 ? p[d.i + 1][0] - 0.01 : 1;
    const isEnd = d.i === 0 || d.i === p.length - 1;
    // Drag a middle point far outside to remove it.
    const out = !isEnd && (e.clientY - box.current.getBoundingClientRect().bottom > 30 || box.current.getBoundingClientRect().top - e.clientY > 30);
    if (out) { d.removed = true; setPts(p.filter((_, k) => k !== d.i)); return; }
    d.removed = false;
    p[d.i] = [+(isEnd ? (d.i === 0 ? clamp(x, 0, hi) : clamp(x, lo, 1)) : clamp(x, lo, hi)).toFixed(4), +y.toFixed(4)];
    d.pts = p;
    setPts(p);
  };
  const up = () => { const d = drag.current; drag.current = null; if (d) { if (d.removed) d.pts = d.pts.filter((_, k) => k !== d.i); setPts(d.pts, true); } };
  const dbl = (e) => {
    if (ed.readOnly || ch === 'param') return;
    const [x, y] = toXY(e);
    const i = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 0.05);
    if (i > 0 && i < pts.length - 1) setPts(pts.filter((_, k) => k !== i), true);
  };
  const pc = c.param;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Segmented value={ch} onChange={setCh} options={CH} />
        <IconButton icon="refresh" label="Reset this curve" size={24} disabled={ed.readOnly} onClick={() => {
          if (ch === 'param') ed.set('curve.param', { highlights: 0, lights: 0, darks: 0, shadows: 0, s1: 25, s2: 50, s3: 75 }, 'Reset parametric curve');
          else ed.set(`curve.${ch}`, [[0, 0], [1, 1]], 'Reset curve');
          ed.commit();
        }} />
      </div>
      <div ref={box} className="relative w-full aspect-square rounded bg-[#0b0d10] border border-line touch-none" onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={dbl}
        style={{ cursor: ch === 'param' ? 'default' : 'crosshair' }}>
        <svg viewBox={`0 0 ${N} ${N}`} className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
          {[1, 2, 3].map((i) => <g key={i} stroke="rgba(255,255,255,.08)"><line x1={(N * i) / 4} y1={0} x2={(N * i) / 4} y2={N} /><line x1={0} y1={(N * i) / 4} x2={N} y2={(N * i) / 4} /></g>)}
          <line x1={0} y1={N} x2={N} y2={0} stroke="rgba(255,255,255,.12)" />
          {ch === 'param' && [pc.s1, pc.s2, pc.s3].map((v, i) => <line key={i} x1={(v / 100) * N} y1={0} x2={(v / 100) * N} y2={N} stroke="rgba(90,180,255,.35)" strokeDasharray="3 3" />)}
          <path d={path} fill="none" stroke={CH_COLOR[ch] || '#e8e8e8'} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          {pts && pts.map((p, i) => <circle key={i} cx={p[0] * N} cy={(1 - p[1]) * N} r={3.5} fill="#fff" stroke="#000" vectorEffect="non-scaling-stroke" />)}
        </svg>
      </div>
      {ch === 'param' ? (
        <div className="mt-2">
          <S ed={ed} path="curve.param.highlights" label="Highlights" /><S ed={ed} path="curve.param.lights" label="Lights" />
          <S ed={ed} path="curve.param.darks" label="Darks" /><S ed={ed} path="curve.param.shadows" label="Shadows" />
          <div className="grid grid-cols-3 gap-2 mt-1">
            <S ed={ed} path="curve.param.s1" label="Split 1" min={10} max={40} def={25} />
            <S ed={ed} path="curve.param.s2" label="Split 2" min={30} max={70} def={50} />
            <S ed={ed} path="curve.param.s3" label="Split 3" min={60} max={90} def={75} />
          </div>
        </div>
      ) : <p className="text-[11px] text-fg3 mt-1.5">Click to add a point, drag to shape. Double-click (or drag off the graph) to remove a point.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- colour wheel

function ColorWheel({ ed, path, label, size = 112 }) {
  const w = getIn(ed.s, path);
  const ref = useRef(null);
  const set = (h, s, commit) => { ed.set(path, { ...w, h: Math.round(h), s: Math.round(s) }, `${label} colour`); if (commit) ed.commit(); };
  const pick = (e) => {
    const b = ref.current.getBoundingClientRect();
    const x = (e.clientX - b.left) / b.width - 0.5; const y = (e.clientY - b.top) / b.height - 0.5;
    const d = Math.min(1, Math.hypot(x, y) * 2);
    return [((Math.atan2(-y, x) * 180) / Math.PI + 360) % 360, d * 100];
  };
  const down = (e) => {
    if (ed.readOnly) return;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    const [h, s] = pick(e); set(h, s);
  };
  const a = (w.h * Math.PI) / 180; const r = w.s / 100;
  return (
    <div className="flex flex-col items-center">
      <div className="text-[11px] text-fg2 mb-1">{label}</div>
      <div ref={ref} className="relative rounded-full touch-none cursor-crosshair" style={{ width: size, height: size, background: 'radial-gradient(circle,#808080 0%,rgba(128,128,128,0) 70%),conic-gradient(from 90deg,#f00,#f0f,#00f,#0ff,#0f0,#ff0,#f00)' }}
        onPointerDown={down} onPointerMove={(e) => { if (e.buttons & 1 && !ed.readOnly) { const [h, s] = pick(e); set(h, s); } }} onPointerUp={() => ed.commit()}
        onDoubleClick={() => { ed.set(path, { h: 0, s: 0, l: w.l }, `Reset ${label}`); ed.commit(); }} title="Drag to tint. Double-click to reset.">
        <span className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white shadow" style={{ left: `${50 + Math.cos(a) * r * 50}%`, top: `${50 - Math.sin(a) * r * 50}%` }} />
      </div>
      <div className="text-[10.5px] text-fg3 mt-1 tabular-nums">H {w.h}° · S {w.s}</div>
      <div className="w-full"><S ed={ed} path={`${path}.l`} label="Luminance" /></div>
    </div>
  );
}

// ---------------------------------------------------------------- panels

export const TEMP_GRAD = 'linear-gradient(to right,#3d7dd8,#d8d8d8,#e0b340)';
export const TINT_GRAD = 'linear-gradient(to right,#3fae4a,#d8d8d8,#c94fc0)';

export function DevelopPanels({ ed, hist, histInfo, autoTone, autoWB, onWBTool, wbActive, onLut, onExportCube }) {
  const s = ed.s;
  const [hslTab, setHslTab] = useState('hue');
  const [gradeTab, setGradeTab] = useState('3');
  return (
    <div className={cx(ed.readOnly && 'opacity-[.92]')}>
      <Histogram hist={hist} info={histInfo} />
      <PanelSection title="Basic" id="hk-basic">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-fg2">Treatment</span>
          <Segmented value={s.bw ? 'bw' : 'color'} onChange={(v) => { ed.set('bw', v === 'bw', v === 'bw' ? 'Black & White' : 'Color'); ed.commit(); }}
            options={[{ value: 'color', label: 'Color' }, { value: 'bw', label: 'B&W' }]} />
        </div>
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-xs text-fg2 w-8">WB</span>
          <Select small value={s.wb} className="flex-1" disabled={ed.readOnly}
            onChange={(v) => { if (v === 'shot') { ed.setMany({ wb: 'shot', temp: 0, tint: 0 }, 'WB: As Shot'); ed.commit(); } else if (v === 'auto') autoWB(); }}
            options={[{ value: 'shot', label: 'As Shot' }, { value: 'auto', label: 'Auto' }, { value: 'custom', label: 'Custom' }]} />
          <IconButton icon="eyedropper" label="White balance selector — click something neutral" shortcut="W" size={28} active={wbActive} disabled={ed.readOnly} onClick={onWBTool} />
        </div>
        <S ed={ed} path="temp" label="Temp" gradient={TEMP_GRAD} />
        <S ed={ed} path="tint" label="Tint" gradient={TINT_GRAD} />
        <div className="flex items-center justify-between mt-2 mb-1">
          <span className="text-[11px] uppercase tracking-wider text-fg3">Tone</span>
          <Button size="xs" variant="outline" onClick={autoTone} disabled={ed.readOnly}>Auto</Button>
        </div>
        <S ed={ed} path="exposure" label="Exposure" min={-5} max={5} step={0.01} gradient="linear-gradient(to right,#111,#eee)" />
        <S ed={ed} path="contrast" label="Contrast" />
        <S ed={ed} path="highlights" label="Highlights" /><S ed={ed} path="shadows" label="Shadows" />
        <S ed={ed} path="whites" label="Whites" /><S ed={ed} path="blacks" label="Blacks" />
        <div className="text-[11px] uppercase tracking-wider text-fg3 mt-2 mb-1">Presence</div>
        <S ed={ed} path="texture" label="Texture" /><S ed={ed} path="clarity" label="Clarity" /><S ed={ed} path="dehaze" label="Dehaze" />
        <S ed={ed} path="vibrance" label="Vibrance" gradient="linear-gradient(to right,#888,#c86,#e44)" />
        <S ed={ed} path="saturation" label="Saturation" gradient="linear-gradient(to right,#888,#f33)" />
      </PanelSection>
      <PanelSection title="Tone Curve" id="hk-curve"><CurveEditor ed={ed} /></PanelSection>
      <PanelSection title={s.bw ? 'B&W Mix' : 'Color Mixer'} id="hk-hsl">
        {s.bw ? (
          HSL_BANDS.map((b, i) => <S key={b.id} ed={ed} path={`hsl.gray.${i}`} label={b.label} gradient={`linear-gradient(to right,#222,${b.color},#eee)`} />)
        ) : (
          <>
            <Segmented className="mb-2" value={hslTab} onChange={setHslTab} options={[{ value: 'hue', label: 'Hue' }, { value: 'sat', label: 'Saturation' }, { value: 'lum', label: 'Luminance' }]} />
            {HSL_BANDS.map((b, i) => (
              <S key={b.id} ed={ed} path={`hsl.${hslTab}.${i}`} label={b.label}
                gradient={hslTab === 'hue' ? `linear-gradient(to right,hsl(${b.hue - 30},80%,55%),hsl(${b.hue},80%,55%),hsl(${b.hue + 30},80%,55%))`
                  : hslTab === 'sat' ? `linear-gradient(to right,#888,${b.color})` : `linear-gradient(to right,#111,${b.color},#fff)`} />
            ))}
          </>
        )}
      </PanelSection>
      <PanelSection title="Color Grading" id="hk-grade">
        <Segmented className="mb-2" value={gradeTab} onChange={setGradeTab} options={[{ value: '3', label: '3-way' }, { value: 'shadows', label: 'Shadows' }, { value: 'mid', label: 'Midtones' }, { value: 'high', label: 'Highlights' }, { value: 'global', label: 'Global' }]} />
        {gradeTab === '3' ? (
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            <div className="col-span-2 flex justify-center"><div className="w-1/2"><ColorWheel ed={ed} path="grade.mid" label="Midtones" size={84} /></div></div>
            <ColorWheel ed={ed} path="grade.shadows" label="Shadows" size={84} />
            <ColorWheel ed={ed} path="grade.high" label="Highlights" size={84} />
          </div>
        ) : <ColorWheel ed={ed} path={`grade.${gradeTab}`} label={{ shadows: 'Shadows', mid: 'Midtones', high: 'Highlights', global: 'Global' }[gradeTab]} size={160} />}
        <S ed={ed} path="grade.blending" label="Blending" min={0} max={100} def={50} />
        <S ed={ed} path="grade.balance" label="Balance" />
      </PanelSection>
      <PanelSection title="Detail" id="hk-detail">
        <div className="text-[11px] uppercase tracking-wider text-fg3 mb-1">Sharpening</div>
        <S ed={ed} path="detail.sharpen" label="Amount" min={0} max={150} />
        <S ed={ed} path="detail.radius" label="Radius" min={0.5} max={3} step={0.1} def={1} />
        <S ed={ed} path="detail.detail" label="Detail" min={0} max={100} def={25} />
        <S ed={ed} path="detail.masking" label="Masking" min={0} max={100} />
        <div className="text-[11px] uppercase tracking-wider text-fg3 mt-2 mb-1">Noise Reduction</div>
        <S ed={ed} path="detail.nrLum" label="Luminance" min={0} max={100} />
        <S ed={ed} path="detail.nrColor" label="Color" min={0} max={100} />
        <p className="text-[11px] text-fg3">Zoom to 1:1 (Z) to judge sharpening and noise. Noise reduction is skipped while dragging.</p>
      </PanelSection>
      <PanelSection title="Optics" id="hk-optics" defaultOpen={false}>
        <div className="text-[11px] uppercase tracking-wider text-fg3 mb-1">Lens vignetting</div>
        <S ed={ed} path="optics.vignette" label="Amount" />
        <S ed={ed} path="optics.midpoint" label="Midpoint" min={0} max={100} def={50} />
      </PanelSection>
      <PanelSection title="Effects" id="hk-effects" defaultOpen={false}>
        <div className="text-[11px] uppercase tracking-wider text-fg3 mb-1">Post-crop vignetting</div>
        <S ed={ed} path="effects.vig" label="Amount" />
        <S ed={ed} path="effects.vigMid" label="Midpoint" min={0} max={100} def={50} />
        <S ed={ed} path="effects.vigRound" label="Roundness" />
        <S ed={ed} path="effects.vigFeather" label="Feather" min={0} max={100} def={50} />
        <S ed={ed} path="effects.vigHigh" label="Highlights" min={0} max={100} />
        <div className="text-[11px] uppercase tracking-wider text-fg3 mt-2 mb-1">Grain</div>
        <S ed={ed} path="effects.grain" label="Amount" min={0} max={100} />
        <S ed={ed} path="effects.grainSize" label="Size" min={0} max={100} def={25} />
        <S ed={ed} path="effects.grainRough" label="Roughness" min={0} max={100} def={50} />
      </PanelSection>
      <PanelSection title="Profile (LUT)" id="hk-lut" defaultOpen={false}>
        {s.lut ? (
          <>
            <div className="flex items-center gap-2 mb-2 text-[13px]"><Icon name="color" size={15} className="text-fg2" /><span className="flex-1 truncate" title={s.lut.name}>{s.lut.name}</span>
              <IconButton icon="close" label="Remove profile" size={24} disabled={ed.readOnly} onClick={() => { ed.set('lut', null, 'Remove profile'); ed.commit(); }} /></div>
            <S ed={ed} path="lut.amount" label="Amount" min={0} max={200} def={100} />
          </>
        ) : <p className="text-xs text-fg2 mb-2">Apply a 3D .cube LUT as a creative profile.</p>}
        <div className="flex gap-2">
          <Button size="sm" icon="import" onClick={onLut} disabled={ed.readOnly}>Load .cube…</Button>
          <Button size="sm" icon="export" onClick={onExportCube}>Export look as .cube</Button>
        </div>
      </PanelSection>
    </div>
  );
}

// ---------------------------------------------------------------- masks panel

export function MaskPanel({ ed, maskSel, setMaskSel, tool, setTool, brush, setBrush, showOverlay, setShowOverlay }) {
  const masks = ed.s.masks || [];
  const m = masks.find((x) => x.id === maskSel);
  const setMask = (patch, label, merge) => ed.setMask({ ...m, ...patch }, label, merge);
  const brushCount = masks.filter((x) => x.type === 'brush').length;
  return (
    <div>
      <div className="px-3 pt-3 pb-2 border-b border-line">
        <div className="text-[11px] uppercase tracking-wider text-fg3 mb-2">Create new mask</div>
        <div className="grid grid-cols-3 gap-1.5">
          <Button size="sm" variant={tool === 'brush' && !m ? 'primary' : 'secondary'} disabled={ed.readOnly || brushCount >= 4 || masks.length >= 8} onClick={() => ed.addBrushMask()} title="Brush (K)">Brush</Button>
          <Button size="sm" variant={tool === 'linear' ? 'primary' : 'secondary'} disabled={ed.readOnly || masks.length >= 8} onClick={() => { setMaskSel(null); setTool('linear'); }} title="Linear gradient (M) — drag on the photo">Linear</Button>
          <Button size="sm" variant={tool === 'radial' ? 'primary' : 'secondary'} disabled={ed.readOnly || masks.length >= 8} onClick={() => { setMaskSel(null); setTool('radial'); }} title="Radial gradient (Shift+M) — drag on the photo">Radial</Button>
        </div>
        {(tool === 'linear' || tool === 'radial') && !m && <p className="text-[11px] text-accent mt-2">Drag on the photo to place the {tool} gradient.</p>}
      </div>
      <div className="px-3 py-2 border-b border-line">
        <div className="flex items-center mb-1.5">
          <span className="text-[11px] uppercase tracking-wider text-fg3 flex-1">Masks ({masks.length}/8)</span>
          <Toggle checked={showOverlay} onChange={setShowOverlay} label="Overlay (O)" />
        </div>
        {!masks.length && <p className="text-xs text-fg2 py-2">No masks yet. Masks apply local adjustments to part of the photo.</p>}
        {masks.map((x) => (
          <div key={x.id} onClick={() => { setMaskSel(x.id); setTool(x.type === 'brush' ? 'brush' : 'mask'); }}
            className={cx('flex items-center gap-2 h-8 px-2 rounded cursor-pointer text-[13px]', x.id === maskSel ? 'bg-active' : 'hover:bg-hover')}>
            <Icon name={x.type === 'brush' ? 'brush' : x.type === 'radial' ? 'ellipse' : 'gradient'} size={15} className="text-fg2" />
            <span className="flex-1 truncate">{x.name}</span>
            <IconButton icon={x.visible === false ? 'eyeOff' : 'eye'} label={x.visible === false ? 'Show' : 'Hide'} size={22} disabled={ed.readOnly}
              onClick={(e) => { e.stopPropagation(); ed.setMask({ ...x, visible: x.visible === false }, x.visible === false ? 'Show mask' : 'Hide mask'); ed.commit(); }} />
            <IconButton icon="trash" label="Delete mask" size={22} disabled={ed.readOnly} onClick={(e) => { e.stopPropagation(); ed.deleteMask(x.id); }} />
          </div>
        ))}
      </div>
      {m && (
        <div className="px-3 py-2">
          <div className="flex items-center gap-2 mb-2">
            <input value={m.name} disabled={ed.readOnly} onChange={(e) => setMask({ name: e.target.value }, 'Rename mask', `name${m.id}`)} onBlur={() => ed.commit()}
              className="flex-1 h-7 rounded bg-input border border-line text-[13px] px-2 outline-none focus:border-accent/70" />
            <Toggle checked={!!m.invert} onChange={(v) => { setMask({ invert: v }, v ? 'Invert mask' : 'Un-invert mask'); ed.commit(); }} label="Invert" disabled={ed.readOnly} />
          </div>
          <Slider label="Amount" value={m.amount ?? 100} min={0} max={100} reset={100} disabled={ed.readOnly} className="mb-1.5"
            onChange={(v) => setMask({ amount: v }, `Mask amount ${v}`, `amt${m.id}`)} onCommit={() => ed.commit()} />
          {m.type === 'radial' && (
            <Slider label="Feather" value={m.geo.feather} min={0} max={100} reset={50} disabled={ed.readOnly} className="mb-1.5"
              onChange={(v) => setMask({ geo: { ...m.geo, feather: v } }, `Feather ${v}`, `fea${m.id}`)} onCommit={() => ed.commit()} />
          )}
          {m.type === 'brush' && (
            <div className="rounded-md bg-panel-2 p-2 mb-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-fg2">Brush</span>
                <Segmented value={brush.erase ? 'erase' : 'paint'} onChange={(v) => setBrush({ ...brush, erase: v === 'erase' })} options={[{ value: 'paint', label: 'Add' }, { value: 'erase', label: 'Erase (Alt)' }]} />
              </div>
              <Slider label="Size  [ ]" value={Math.round(brush.size)} min={2} max={1500} onChange={(v) => setBrush({ ...brush, size: v })} className="mb-1" />
              <Slider label="Feather  ⇧[ ]" value={brush.feather} min={0} max={100} onChange={(v) => setBrush({ ...brush, feather: v })} className="mb-1" />
              <Slider label="Flow" value={brush.flow} min={1} max={100} onChange={(v) => setBrush({ ...brush, flow: v })} />
              <Button size="xs" variant="ghost" icon="trash" className="mt-1" disabled={ed.readOnly || !(m.strokes || []).length} onClick={() => { setMask({ strokes: [] }, 'Clear brush'); ed.commit(); }}>Clear strokes</Button>
            </div>
          )}
          <div className="text-[11px] uppercase tracking-wider text-fg3 mt-2 mb-1">Adjustments</div>
          {MASK_ADJ.map((a) => (
            <Slider key={a.key} label={a.label} value={m.adj[a.key] || 0} min={a.min ?? -100} max={a.max ?? 100} step={a.step ?? 1} reset={0} disabled={ed.readOnly} className="mb-1.5"
              gradient={a.key === 'temp' ? TEMP_GRAD : a.key === 'tint' ? TINT_GRAD : undefined}
              onChange={(v) => setMask({ adj: { ...m.adj, [a.key]: v } }, `Mask ${a.label} ${fmt(v)}`, `${a.key}${m.id}`)} onCommit={() => ed.commit()} />
          ))}
          <Button size="xs" variant="ghost" icon="refresh" disabled={ed.readOnly} onClick={() => { setMask({ adj: Object.fromEntries(MASK_ADJ.map((a) => [a.key, 0])) }, 'Reset mask sliders'); ed.commit(); }}>Reset sliders</Button>
        </div>
      )}
    </div>
  );
}
