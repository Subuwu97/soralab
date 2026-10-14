// Color (like Adobe Color): build a five-colour theme on a colour wheel with harmony rules, pull themes from photos,
// check contrast (WCAG) and colour-blind safety, then save to a library or copy as CSS, Tailwind or JSON.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/app.jsx';
import { api } from '../lib/api.js';
import { parse, toHex, rgbToHsv, hsvToRgb, harmony, extractPalette, contrast, readableOn, luminance, clamp } from '../lib/color.js';
import { assetSrc, loadImage } from '../lib/doc.js';
import { PageLayout } from '../components/Header.jsx';
import { Icon } from '../components/Icons.jsx';
import { pickAssets } from '../components/Pickers.jsx';
import { Button, IconButton, NumberInput, Select, Segmented, Tabs, TextInput, ColorSwatch, Field, toast, toastError, useSize, cx } from '../components/ui.jsx';
import { PageHero, copyText, useDropAnywhere, useStored } from './_shared/index.jsx';

const RULES = [
  { id: 'analogous', label: 'Analogous', base: 2 }, { id: 'monochromatic', label: 'Monochromatic', base: 2 },
  { id: 'triad', label: 'Triad', base: 0 }, { id: 'complementary', label: 'Complementary', base: 2 },
  { id: 'split', label: 'Split complementary', base: 0 }, { id: 'square', label: 'Square', base: 0 },
  { id: 'compound', label: 'Compound', base: 0 }, { id: 'shades', label: 'Shades', base: 3 },
  { id: 'custom', label: 'Custom', base: null },
];
const ruleById = Object.fromEntries(RULES.map((r) => [r.id, r]));
const hsvOf = (hex) => rgbToHsv(parse(hex));
const hexOf = (hsv) => toHex(hsvToRgb(hsv)).toUpperCase();
const DEFAULT = { rule: 'analogous', base: { h: 205, s: 0.65, v: 1 }, colors: harmony(hexOf({ h: 205, s: 0.65, v: 1 }), 'analogous').map((c) => c.toUpperCase()), active: 2 };

// ---------------------------------------------------------------- colour-blindness simulation
// Machado, Oliveira & Fernandes (2009) matrices at full severity, applied in linear RGB.
const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => 255 * clamp(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
function simulate(hex, m) {
  const c = parse(hex); const l = [toLin(c.r), toLin(c.g), toLin(c.b)];
  const o = m.map((row) => row[0] * l[0] + row[1] * l[1] + row[2] * l[2]);
  return toHex({ r: toSrgb(o[0]), g: toSrgb(o[1]), b: toSrgb(o[2]) });
}
/** CIE76 ΔE in Lab — good enough to flag colours that become hard to tell apart. */
function lab(hex) {
  const c = parse(hex); const [r, g, b] = [toLin(c.r), toLin(c.g), toLin(c.b)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047); const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b); const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => { const p = lab(a); const q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

// ---------------------------------------------------------------- the wheel

function Wheel({ theme, onDrag, size }) {
  const canvas = useRef(null);
  const v = theme.rule === 'custom' ? hsvOf(theme.colors[theme.active] || '#ffffff').v : theme.base.v;
  const R = size / 2 - 10;
  // The hue/saturation disc at the current brightness. Hue runs clockwise from red at the top.
  useEffect(() => {
    const c = canvas.current; if (!c || size < 20) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const n = Math.round(size * dpr);
    c.width = n; c.height = n;
    const g = c.getContext('2d');
    const img = g.createImageData(n, n);
    const cx = n / 2; const r = R * dpr;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x - cx; const dy = y - cx; const d = Math.hypot(dx, dy);
        if (d > r + 1) continue;
        const h = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
        const { r: rr, g: gg, b: bb } = hsvToRgb({ h, s: Math.min(1, d / r), v: Math.max(v, 0.04) });
        const i = (y * n + x) * 4;
        img.data[i] = rr; img.data[i + 1] = gg; img.data[i + 2] = bb; img.data[i + 3] = d > r ? Math.round(255 * (r + 1 - d)) : 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, [size, v, R]);

  const pos = (hex) => { const { h, s } = hsvOf(hex); const a = (h * Math.PI) / 180; return { x: size / 2 + Math.sin(a) * s * R, y: size / 2 - Math.cos(a) * s * R }; };
  const baseIdx = ruleById[theme.rule].base ?? theme.active;
  const markers = theme.colors.map((c, i) => ({ c, i, ...pos(c) }));
  const at = (e) => {
    const r = canvas.current.getBoundingClientRect();
    const dx = e.clientX - r.left - size / 2; const dy = e.clientY - r.top - size / 2;
    return { h: (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360, s: Math.min(1, Math.hypot(dx, dy) / R) };
  };
  const down = (e) => {
    const r = canvas.current.getBoundingClientRect();
    const px = e.clientX - r.left; const py = e.clientY - r.top;
    // Grab the nearest marker; clicking empty wheel moves the base colour there.
    const near = markers.map((m) => ({ ...m, d: Math.hypot(m.x - px, m.y - py) })).sort((a, b) => a.d - b.d)[0];
    const idx = near && near.d < 18 ? near.i : baseIdx;
    const el = e.currentTarget; // React clears currentTarget after the handler, so keep the element
    el.setPointerCapture(e.pointerId);
    onDrag(idx, at(e), 'start');
    const move = (ev) => onDrag(idx, at(ev));
    const up = (ev) => { onDrag(idx, at(ev), 'end'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className="relative mx-auto touch-none select-none" style={{ width: size, height: size }} onPointerDown={down}>
      <canvas ref={canvas} style={{ width: size, height: size }} className="rounded-full cursor-crosshair" aria-label="Colour wheel — drag the markers" role="img" />
      <svg width={size} height={size} className="absolute inset-0 pointer-events-none">
        {markers.map((m) => <line key={m.i} x1={size / 2} y1={size / 2} x2={m.x} y2={m.y} stroke="#fff" strokeOpacity={m.i === baseIdx ? 0.9 : 0.55} strokeWidth={m.i === baseIdx ? 2 : 1.25} />)}
        <circle cx={size / 2} cy={size / 2} r={3} fill="#fff" />
      </svg>
      {markers.map((m) => (
        <span key={m.i} className={cx('absolute rounded-full border-white pointer-events-none shadow-[0_0_0_1px_rgba(0,0,0,.35),0_2px_6px_rgba(0,0,0,.35)]',
          m.i === baseIdx ? 'w-7 h-7 -ml-3.5 -mt-3.5 border-[3px]' : 'w-5 h-5 -ml-2.5 -mt-2.5 border-2', m.i === theme.active && m.i !== baseIdx && 'ring-2 ring-accent')}
          style={{ left: m.x, top: m.y, background: m.c }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- swatch editor

function HexField({ value, onCommit, className }) {
  const [t, setT] = useState(null);
  return (
    <input aria-label="Hex" value={t ?? value} onChange={(e) => setT(e.target.value)} spellCheck={false}
      onBlur={() => { if (t !== null && /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t.trim())) onCommit(`#${t.trim().replace('#', '')}`); setT(null); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className={cx('h-7 rounded bg-input border border-line text-[12.5px] font-mono uppercase px-2 outline-none focus:border-accent/70 text-fg', className)} />
  );
}

function SwatchColumn({ hex, active, base, onSelect, onChange }) {
  const c = parse(hex); const hsv = hsvOf(hex);
  const rgb = (k, v) => onChange(toHex({ ...c, [k]: v }));
  const hsb = (k, v) => onChange(hexOf({ ...hsv, [k]: v }));
  return (
    <div className={cx('rounded-xl border p-2 flex sm:flex-col gap-2 min-w-0 transition', active ? 'border-accent/60 bg-active/40' : 'border-line bg-surface')}>
      <button type="button" onClick={onSelect} aria-label={`Select colour ${hex}`} aria-pressed={active}
        className="relative w-20 sm:w-full h-auto sm:h-24 min-h-20 rounded-lg shrink-0 overflow-hidden" style={{ background: hex }}>
        {base && <span className="absolute top-1.5 left-1.5 text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ color: readableOn(hex), background: `${readableOn(hex)}22` }}>Base</span>}
        <span className="absolute bottom-1.5 right-1.5 opacity-70" style={{ color: readableOn(hex) }} onClick={(e) => { e.stopPropagation(); copyText(hex, `Copied ${hex}`); }} title="Copy hex"><Icon name="copy" size={14} /></span>
      </button>
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <ColorSwatch value={hex} onChange={(v) => onChange(v.slice(0, 7).toUpperCase())} alpha={false} size={26} label="Pick colour" />
          <HexField value={hex} onCommit={(v) => onChange(v.toUpperCase())} className="flex-1 min-w-0 w-full" />
        </div>
        <div className="grid grid-cols-3 gap-1 text-[10px] text-fg3 uppercase tracking-wider">
          {['r', 'g', 'b'].map((k) => (
            <label key={k} className="flex flex-col gap-0.5"><span className="pl-0.5">{k}</span>
              <NumberInput value={Math.round(c[k])} min={0} max={255} width="100%" onChange={(v) => rgb(k, v)} />
            </label>
          ))}
          <label className="flex flex-col gap-0.5"><span className="pl-0.5">H°</span><NumberInput value={Math.round(hsv.h)} min={0} max={359} width="100%" onChange={(v) => hsb('h', v)} /></label>
          <label className="flex flex-col gap-0.5"><span className="pl-0.5">S%</span><NumberInput value={Math.round(hsv.s * 100)} min={0} max={100} width="100%" onChange={(v) => hsb('s', v / 100)} /></label>
          <label className="flex flex-col gap-0.5"><span className="pl-0.5">B%</span><NumberInput value={Math.round(hsv.v * 100)} min={0} max={100} width="100%" onChange={(v) => hsb('v', v / 100)} /></label>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- extract from an image

function ImageExtract({ onUse }) {
  const canvas = useRef(null);
  const [img, setImg] = useState(null); // { url, w, h, name }
  const [points, setPoints] = useState([]); // [{ x, y, hex }] x,y 0..1
  const [busy, setBusy] = useState(false);
  const sample = (x, y) => {
    const c = canvas.current; const g = c.getContext('2d', { willReadFrequently: true });
    const px = Math.round(x * (c.width - 1)); const py = Math.round(y * (c.height - 1));
    const d = g.getImageData(Math.max(0, px - 1), Math.max(0, py - 1), 3, 3).data;
    let r = 0; let gg = 0; let b = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    return toHex({ r: r / n, g: gg / n, b: b / n }).toUpperCase();
  };
  const analyse = useCallback((image, name) => {
    const c = canvas.current;
    const s = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
    c.width = Math.max(1, Math.round(image.naturalWidth * s)); c.height = Math.max(1, Math.round(image.naturalHeight * s));
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, c.width, c.height);
    const data = g.getImageData(0, 0, c.width, c.height);
    const pal = extractPalette(data, 5);
    // Put each marker on the pixel that best matches its colour (on a coarse grid, so it's quick).
    const step = Math.max(1, Math.floor(Math.min(c.width, c.height) / 80));
    const pts = pal.map((hex) => {
      const t = parse(hex); let best = { d: Infinity, x: 0.5, y: 0.5 };
      // Stay off the edges, and among equally good matches prefer ones nearer the middle.
      const mx = Math.floor(c.width * 0.05); const my = Math.floor(c.height * 0.05);
      for (let y = my; y < c.height - my; y += step) {
        for (let x = mx; x < c.width - mx; x += step) {
          const i = (y * c.width + x) * 4;
          const d = (data.data[i] - t.r) ** 2 + (data.data[i + 1] - t.g) ** 2 + (data.data[i + 2] - t.b) ** 2
            + 40 * ((x / c.width - 0.5) ** 2 + (y / c.height - 0.5) ** 2);
          if (d < best.d) best = { d, x: x / c.width, y: y / c.height };
        }
      }
      return { x: best.x, y: best.y, hex: hex.toUpperCase() };
    });
    setImg({ url: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height, name });
    setPoints(pts);
  }, []);
  const fromFile = useCallback(async (file) => {
    if (!file?.type?.startsWith('image/')) { toast('Choose an image (PNG, JPEG, WebP…)', { type: 'error' }); return; }
    setBusy(true);
    const url = URL.createObjectURL(file);
    try { analyse(await loadImage(url), file.name); } catch (e) { toastError(e); } finally { URL.revokeObjectURL(url); setBusy(false); }
  }, [analyse]);
  const fromFiles = async () => {
    const [a] = (await pickAssets({ kinds: ['image'], multiple: false, title: 'Extract a theme from an image' })) || [];
    if (!a) return;
    setBusy(true);
    try { analyse(await loadImage(assetSrc(a)), a.name); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const overlay = useDropAnywhere((files) => fromFile(files[0]), { label: 'Drop an image to extract its colours' });
  const input = useRef(null);
  const box = useRef(null);
  const drag = (i) => (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const r = box.current.getBoundingClientRect();
      const x = clamp((ev.clientX - r.left) / r.width); const y = clamp((ev.clientY - r.top) / r.height);
      setPoints((p) => p.map((q, j) => (j === i ? { x, y, hex: sample(x, y) } : q)));
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const colors = points.map((p) => p.hex);
  const grad = [...colors].sort((a, b) => luminance(b) - luminance(a));
  const gradCss = `linear-gradient(90deg, ${grad.map((c, i) => `${c} ${Math.round((i / Math.max(1, grad.length - 1)) * 100)}%`).join(', ')})`;
  return (
    <Card title="Extract from an image" icon="image" actions={img && <Button size="sm" variant="ghost" icon="close" onClick={() => { setImg(null); setPoints([]); }}>Clear</Button>}>
      <canvas ref={canvas} hidden />
      {!img ? (
        <div className="rounded-xl border-2 border-dashed border-line grid place-items-center text-center py-10 px-4">
          <div>
            <Icon name="image" size={30} className="mx-auto text-fg2 mb-2" />
            <div className="font-medium">Drop a photo anywhere on this page</div>
            <div className="text-sm text-fg2 mb-4">Its five main colours become a theme you can fine-tune.</div>
            <div className="flex flex-wrap gap-2 justify-center">
              <Button variant="primary" icon="upload" busy={busy} onClick={() => input.current.click()}>Choose image</Button>
              <Button icon="folder" onClick={fromFiles}>From Files or Cloud</Button>
            </div>
            <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { fromFile(e.target.files[0]); e.target.value = ''; }} />
          </div>
        </div>
      ) : (
        <>
          <div ref={box} className="relative rounded-lg overflow-hidden mx-auto touch-none select-none" style={{ aspectRatio: `${img.w} / ${img.h}`, maxHeight: 340, maxWidth: '100%' }}>
            <img src={img.url} alt={img.name} className="w-full h-full object-cover" draggable={false} />
            {points.map((p, i) => (
              <button key={i} type="button" aria-label={`Colour ${i + 1} picker — drag to choose another spot`} onPointerDown={drag(i)}
                className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgba(0,0,0,.4),0_2px_8px_rgba(0,0,0,.5)] cursor-grab active:cursor-grabbing"
                style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: p.hex }} />
            ))}
          </div>
          <div className="flex rounded-lg overflow-hidden h-10 mt-3">{colors.map((c, i) => <span key={i} className="flex-1" style={{ background: c }} title={c} />)}</div>
          <div className="flex items-center gap-2 mt-3">
            <span className="h-6 flex-1 rounded-md" style={{ background: gradCss }} title="Gradient from the image's colours, light to dark" />
            <Button size="sm" variant="ghost" icon="copy" onClick={() => copyText(`background: ${gradCss};`, 'Copied gradient CSS')}>Gradient CSS</Button>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button variant="primary" icon="check" onClick={() => onUse(colors)}>Use this theme</Button>
            <Button variant="ghost" icon="refresh" onClick={() => input.current.click()}>Another image</Button>
            <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { fromFile(e.target.files[0]); e.target.value = ''; }} />
          </div>
        </>
      )}
      {overlay}
    </Card>
  );
}

// ---------------------------------------------------------------- contrast

function Badge({ ok, children }) {
  return (
    <span className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11.5px] font-semibold', ok ? 'bg-ok/15 text-ok' : 'bg-danger/15 text-danger')}>
      <Icon name={ok ? 'check' : 'close'} size={12} stroke={2.5} />{children}
    </span>
  );
}

function ContrastChecker({ colors }) {
  const sorted = useMemo(() => [...colors].sort((a, b) => luminance(a) - luminance(b)), [colors]);
  const [fg, setFg] = useState(sorted[0]);
  const [bg, setBg] = useState(sorted.at(-1));
  const ratio = contrast(fg, bg);
  const quick = (set) => <div className="flex gap-1">{colors.map((c, i) => <button key={i} type="button" title={c} onClick={() => set(c)} className="w-5 h-5 rounded border border-line hover:scale-110 transition" style={{ background: c }} />)}</div>;
  return (
    <Card title="Contrast checker" icon="contrast">
      <div className="rounded-xl border border-line p-5 mb-4" style={{ background: bg, color: fg }}>
        <div className="font-head font-bold text-2xl leading-tight">Large text, 24 px</div>
        <p className="text-[15px] mt-1.5">Body text at 16 px should be easy to read for everyone, including people with low vision.</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-1"><span className="font-head font-bold text-4xl tabular-nums">{ratio.toFixed(2)}</span><span className="text-fg2">: 1</span></div>
        <div className="flex flex-col gap-1.5 text-[12px] text-fg2">
          <div className="flex items-center gap-1.5 flex-wrap"><span className="w-20">Normal text</span><Badge ok={ratio >= 4.5}>AA 4.5</Badge><Badge ok={ratio >= 7}>AAA 7</Badge></div>
          <div className="flex items-center gap-1.5 flex-wrap"><span className="w-20">Large text</span><Badge ok={ratio >= 3}>AA 3</Badge><Badge ok={ratio >= 4.5}>AAA 4.5</Badge></div>
          <div className="flex items-center gap-1.5 flex-wrap"><span className="w-20">UI &amp; icons</span><Badge ok={ratio >= 3}>AA 3</Badge></div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-end gap-3 mt-4">
        <Field label="Text">
          <div className="flex items-center gap-2"><ColorSwatch value={fg} onChange={(v) => setFg(v.slice(0, 7))} alpha={false} size={28} label="Text colour" /><HexField value={fg.toUpperCase()} onCommit={setFg} className="w-24" />{quick(setFg)}</div>
        </Field>
        <IconButton icon="refresh" label="Swap" size={30} className="bg-chip justify-self-start sm:justify-self-center" onClick={() => { setFg(bg); setBg(fg); }} />
        <Field label="Background">
          <div className="flex items-center gap-2"><ColorSwatch value={bg} onChange={(v) => setBg(v.slice(0, 7))} alpha={false} size={28} label="Background colour" /><HexField value={bg.toUpperCase()} onCommit={setBg} className="w-24" />{quick(setBg)}</div>
        </Field>
      </div>
      <div className="mt-5">
        <div className="text-xs text-fg2 mb-1.5">Every pair in your theme</div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${colors.length + 1}, minmax(0, 1fr))` }}>
          <span />
          {colors.map((c, i) => <span key={i} className="h-5 rounded" style={{ background: c }} title={c} />)}
          {colors.map((a, i) => [
            <span key={`r${i}`} className="h-8 rounded" style={{ background: a }} title={a} />,
            ...colors.map((b, j) => {
              const r = contrast(a, b);
              return (
                <button key={`${i}-${j}`} type="button" disabled={i === j} onClick={() => { setFg(a); setBg(b); }} title={`${a} on ${b}: ${r.toFixed(2)}:1`}
                  className={cx('h-8 rounded text-[11px] font-semibold tabular-nums grid place-items-center transition hover:ring-2 hover:ring-accent disabled:opacity-25 disabled:hover:ring-0')}
                  style={{ background: b, color: a }}>
                  {i === j ? '' : r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA+' : r.toFixed(1)}
                </button>
              );
            }),
          ])}
        </div>
        <div className="text-[11px] text-fg3 mt-1.5">Rows are text colours, columns are backgrounds. AA+ passes for large text only. Click a pair to check it.</div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- colour blindness

function CvdCard({ colors }) {
  const rows = [['Normal vision', null], ['Protanopia', CVD.protanopia, 'red-blind'], ['Deuteranopia', CVD.deuteranopia, 'green-blind'], ['Tritanopia', CVD.tritanopia, 'blue-blind']];
  return (
    <Card title="Colour-blind safe?" icon="eye">
      <div className="flex flex-col gap-3">
        {rows.map(([label, m, note]) => {
          const sim = m ? colors.map((c) => simulate(c, m)) : colors;
          // Pairs that were distinct but become hard to tell apart.
          const clash = [];
          if (m) for (let i = 0; i < sim.length; i++) for (let j = i + 1; j < sim.length; j++) if (deltaE(sim[i], sim[j]) < 12 && deltaE(colors[i], colors[j]) >= 12) clash.push([i + 1, j + 1]);
          return (
            <div key={label}>
              <div className="flex items-center gap-2 text-[13px] mb-1">
                <span className="font-medium">{label}</span>{note && <span className="text-fg3 text-xs">{note}</span>}
                <span className="flex-1" />
                {m && (clash.length ? <span className="text-xs text-warn flex items-center gap-1"><Icon name="warning" size={13} />{clash.map((p) => p.join('&')).join(', ')} look alike</span>
                  : <span className="text-xs text-ok flex items-center gap-1"><Icon name="check" size={13} />Distinct</span>)}
              </div>
              <div className="flex rounded-lg overflow-hidden h-10">{sim.map((c, i) => <span key={i} className="flex-1 grid place-items-center text-[10.5px] font-semibold" style={{ background: c, color: readableOn(c) }} title={c}>{i + 1}</span>)}</div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-fg3 mt-3">Simulated with the Machado et al. (2009) model. Numbers show which theme colour is which.</p>
    </Card>
  );
}

// ---------------------------------------------------------------- export

function exportText(kind, colors, name) {
  const slug = (name || 'theme').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme';
  if (kind === 'css') return `:root {\n${colors.map((c, i) => `  --${slug}-${i + 1}: ${c.toLowerCase()};`).join('\n')}\n}`;
  if (kind === 'tailwind') return `// tailwind.config.js\nexport default {\n  theme: {\n    extend: {\n      colors: {\n        '${slug}': {\n${colors.map((c, i) => `          ${(i + 1) * 100}: '${c.toLowerCase()}',`).join('\n')}\n        },\n      },\n    },\n  },\n};`;
  return JSON.stringify({ name: name || 'Theme', colors: colors.map((c) => { const p = parse(c); return { hex: c.toUpperCase(), rgb: [Math.round(p.r), Math.round(p.g), Math.round(p.b)] }; }) }, null, 2);
}

function Card({ title, icon, actions, children, className }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-surface p-4 sm:p-5 min-w-0', className)}>
      <div className="flex items-center gap-2 mb-4">
        <span className="w-8 h-8 rounded-lg bg-chip grid place-items-center text-fg2"><Icon name={icon} size={17} /></span>
        <h2 className="font-head font-semibold flex-1">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- page

export default function Color() {
  const { libraries, reloadLibraries } = useApp();
  const [theme, setTheme] = useStored('sl-color-theme', DEFAULT);
  const [name, setName] = useStored('sl-color-name', 'My theme');
  const [exp, setExp] = useState('css');
  const [libId, setLibId] = useState('');
  const [saveAs, setSaveAs] = useState('colors');
  const [saving, setSaving] = useState(false);
  const wheelBox = useRef(null);
  const { width } = useSize(wheelBox);
  const wheelSize = Math.max(220, Math.min(380, Math.floor(width || 300)));
  useEffect(() => { document.title = 'Color — SoraLab'; }, []);
  useEffect(() => { if (!libId && libraries[0]) setLibId(libraries[0].id); }, [libraries, libId]);

  const rule = ruleById[theme.rule] || RULES[0];
  const baseIdx = rule.base ?? theme.active;
  const applyBase = (base, r = theme.rule, extra = {}) => setTheme((t) => ({ ...t, ...extra, rule: r, base, colors: harmony(hexOf(base), r).map((c) => c.toUpperCase()) }));
  const setRule = (r) => {
    if (r === 'custom') { setTheme((t) => ({ ...t, rule: 'custom' })); return; }
    // Switching rules keeps the current base colour.
    const base = theme.rule === 'custom' ? hsvOf(theme.colors[theme.active]) : theme.base;
    applyBase(base, r, { active: ruleById[r].base });
  };
  const onDrag = (i, { h, s }, phase) => {
    if (phase === 'start') setTheme((t) => ({ ...t, active: i }));
    if (theme.rule === 'custom') {
      setTheme((t) => ({ ...t, active: i, colors: t.colors.map((c, j) => (j === i ? hexOf({ h, s, v: hsvOf(c).v }) : c)) }));
    } else if (i === baseIdx) {
      applyBase({ ...theme.base, h, s });
    } else {
      // Dragging another marker turns the whole harmony with it (and moves saturation by the same amount).
      const cur = hsvOf(theme.colors[i]);
      applyBase({ h: (theme.base.h + (h - cur.h) + 360) % 360, s: clamp(theme.base.s + (s - cur.s)), v: theme.base.v });
    }
  };
  const editSwatch = (i, hex) => {
    if (theme.rule !== 'custom' && i === baseIdx) { const hsv = hsvOf(hex); applyBase(hsv.s === 0 ? { ...hsv, h: theme.base.h } : hsv); return; }
    setTheme((t) => ({ ...t, rule: 'custom', active: i, colors: t.colors.map((c, j) => (j === i ? hex : c)) }));
  };
  const brightness = theme.rule === 'custom' ? hsvOf(theme.colors[theme.active]).v : theme.base.v;
  const setBrightness = (v) => {
    if (theme.rule === 'custom') editSwatch(theme.active, hexOf({ ...hsvOf(theme.colors[theme.active]), v }));
    else applyBase({ ...theme.base, v });
  };

  const save = async () => {
    setSaving(true);
    try {
      let lib = libraries.find((l) => l.id === libId);
      if (!lib) lib = await api.post('/api/libraries', { name: 'My Library' });
      if (saveAs === 'group') await api.post(`/api/libraries/${lib.id}/items`, { kind: 'swatchgroup', name: name || 'Theme', data: { colors: theme.colors, rule: theme.rule } });
      else for (const [i, c] of theme.colors.entries()) await api.post(`/api/libraries/${lib.id}/items`, { kind: 'color', name: `${name || 'Theme'} ${i + 1}`, data: { hex: c } });
      await reloadLibraries();
      toast(`Saved to ${lib.name}`, { type: 'success', action: { label: 'Open', onClick: () => { location.href = `/libraries?lib=${lib.id}`; } } });
    } catch (e) { toastError(e); }
    setSaving(false);
  };
  const random = () => applyBase({ h: Math.random() * 360, s: 0.45 + Math.random() * 0.45, v: 0.7 + Math.random() * 0.3 }, theme.rule === 'custom' ? 'analogous' : theme.rule);

  return (
    <PageLayout wide>
      <PageHero icon="palette" title="Color" subtitle="Build colour themes with harmony rules, pull them from photos, and check they work for everyone.">
        <Button icon="sparkles" onClick={random}>Surprise me</Button>
      </PageHero>

      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-6 mb-6 grid gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Field label="Colour harmony rule">
            <Select value={theme.rule} onChange={setRule} options={RULES.map((r) => ({ value: r.id, label: r.label }))} className="w-full" />
          </Field>
          <div ref={wheelBox} className="mt-5 w-full">
            <Wheel theme={theme} onDrag={onDrag} size={wheelSize} />
          </div>
          <div className="mt-5 flex items-center gap-3">
            <Icon name="sun" size={16} className="text-fg2" />
            <input type="range" className="sl-range flex-1" min={0} max={100} value={Math.round(brightness * 100)} aria-label="Brightness" onChange={(e) => setBrightness(Number(e.target.value) / 100)}
              style={{ background: `linear-gradient(90deg,#000,${hexOf({ ...(theme.rule === 'custom' ? hsvOf(theme.colors[theme.active]) : theme.base), v: 1 })})`, borderRadius: 4, height: 8 }} />
            <span className="text-xs text-fg2 tabular-nums w-9 text-right">{Math.round(brightness * 100)}%</span>
          </div>
          <p className="text-xs text-fg3 mt-3">Drag the large marker to change the base colour; drag any other marker to turn the whole harmony. Edit a swatch to switch to a custom theme.</p>
        </div>

        <div className="min-w-0 flex flex-col">
          <div className="flex rounded-xl overflow-hidden h-24 sm:h-32 mb-4 shadow-[0_8px_30px_rgba(0,0,0,.25)]">
            {theme.colors.map((c, i) => (
              <button key={i} type="button" onClick={() => setTheme((t) => ({ ...t, active: i }))} aria-label={`Colour ${i + 1}: ${c}`}
                className={cx('flex-1 relative transition-[flex] duration-200', i === theme.active && 'flex-[1.35]')} style={{ background: c }}>
                <span className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] font-mono font-semibold hidden sm:block" style={{ color: readableOn(c) }}>{c}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            {theme.colors.map((c, i) => <SwatchColumn key={i} hex={c} active={i === theme.active} base={i === baseIdx && theme.rule !== 'custom'} onSelect={() => setTheme((t) => ({ ...t, active: i }))} onChange={(hex) => editSwatch(i, hex)} />)}
          </div>
          <div className="flex flex-wrap items-end gap-3 mt-5 pt-5 border-t border-line">
            <Field label="Theme name" className="flex-1 min-w-40"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Library">
              <Select value={libId} onChange={setLibId} options={libraries.length ? libraries.map((l) => ({ value: l.id, label: l.name })) : [{ value: '', label: 'My Library (new)' }]} className="max-w-48" />
            </Field>
            <Field label="Save as"><Segmented size="md" value={saveAs} onChange={setSaveAs} options={[{ value: 'colors', label: '5 colours' }, { value: 'group', label: 'One theme' }]} /></Field>
            <Button variant="primary" icon="library" busy={saving} onClick={save}>Save to library</Button>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2 mb-6 items-start">
        <ImageExtract onUse={(colors) => { setTheme((t) => ({ ...t, rule: 'custom', colors: colors.concat(t.colors).slice(0, 5), active: 0 })); toast('Theme updated from the image', { type: 'success' }); }} />
        <ContrastChecker key={theme.colors.join()} colors={theme.colors} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2 pb-10">
        <CvdCard colors={theme.colors} />
        <Card title="Copy as code" icon="copy" actions={<Button size="sm" icon="copy" onClick={() => copyText(exportText(exp, theme.colors, name), 'Copied')}>Copy</Button>}>
          <Tabs value={exp} onChange={setExp} tabs={[{ value: 'css', label: 'CSS variables' }, { value: 'tailwind', label: 'Tailwind' }, { value: 'json', label: 'JSON' }]} className="mb-3" />
          <pre className="rounded-lg bg-panel-2 border border-line p-3 text-[12.5px] leading-relaxed font-mono overflow-auto max-h-72 scroll-thin text-fg"><code>{exportText(exp, theme.colors, name)}</code></pre>
        </Card>
      </div>
    </PageLayout>
  );
}
