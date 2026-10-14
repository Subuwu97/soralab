// Libraries (like Creative Cloud Libraries): colours, gradients, text styles, graphics, brushes, presets and templates
// you reuse in every app. Items can be dragged to reorder or onto another library to move them.
//
// Item data shapes (what editors can rely on):
//   color       { hex }                        swatchgroup { colors: [hex…] }
//   gradient    { type: 'linear'|'radial', angle, stops: [{ color, pos 0..1 }], colors: [hex…] }
//   charstyle   { font, size, weight, style, color, tracking }
//   parastyle   charstyle + { lineHeight, align, spaceAfter }
//   graphic     asset_id (+ any data)          brush/preset/look/lut/template: app-specific JSON
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { parse, toHex, rgbToHsl, rgbToCmyk, readableOn } from '../lib/color.js';
import { ensureFont, WEIGHT_NAMES } from '../lib/fonts.js';
import { PageLayout } from '../components/Header.jsx';
import { Icon } from '../components/Icons.jsx';
import { pickAssets, FontPicker, WeightPicker } from '../components/Pickers.jsx';
import {
  Button, IconButton, Modal, Field, TextInput, NumberInput, Slider, Segmented, ColorPicker, ColorSwatch, Popover, EmptyState, Spinner,
  openMenu, promptDialog, confirmDialog, toast, toastError, cx,
} from '../components/ui.jsx';
import { PageHero, copyText, useStored } from './_shared/index.jsx';

// Sections, in the order they're shown.
const GROUPS = [
  { id: 'colors', title: 'Colours', icon: 'palette', kinds: ['color', 'swatchgroup'] },
  { id: 'gradients', title: 'Gradients', icon: 'gradient', kinds: ['gradient'] },
  { id: 'charstyles', title: 'Character styles', icon: 'text', kinds: ['charstyle', 'text'] },
  { id: 'parastyles', title: 'Paragraph styles', icon: 'paragraph', kinds: ['parastyle'] },
  { id: 'graphics', title: 'Graphics', icon: 'image', kinds: ['graphic', 'pattern', 'shape'] },
  { id: 'tools', title: 'Brushes, presets, looks & LUTs', icon: 'brush', kinds: ['brush', 'preset', 'look', 'lut'] },
  { id: 'templates', title: 'Templates', icon: 'page', kinds: ['template'] },
];
const KIND_LABEL = { color: 'Colour', swatchgroup: 'Colour theme', gradient: 'Gradient', charstyle: 'Character style', text: 'Text', parastyle: 'Paragraph style', graphic: 'Graphic', pattern: 'Pattern', shape: 'Shape', brush: 'Brush', preset: 'Preset', look: 'Look', lut: 'LUT', template: 'Template' };
const SAMPLE = 'The quick brown fox jumps over the lazy dog';

/** CSS for a gradient item (accepts { stops } or Photo-style { colors }). */
function gradientCss(g, { forceLinear } = {}) {
  const stops = g?.stops?.length ? g.stops : (g?.colors || ['#000', '#fff']).map((c, i, a) => ({ color: c, pos: a.length > 1 ? i / (a.length - 1) : 0 }));
  const list = [...stops].sort((a, b) => (a.pos ?? a.offset ?? 0) - (b.pos ?? b.offset ?? 0)).map((s) => `${s.color} ${Math.round((s.pos ?? s.offset ?? 0) * 100)}%`).join(', ');
  return g?.type === 'radial' && !forceLinear ? `radial-gradient(circle, ${list})` : `linear-gradient(${g?.angle ?? 90}deg, ${list})`;
}

function colorFormats(hex) {
  const c = parse(hex);
  const hsl = rgbToHsl(c); const k = rgbToCmyk(c);
  const r = (v) => Math.round(v);
  return [
    ['HEX', toHex(c).toUpperCase()],
    ['RGB', `rgb(${r(c.r)}, ${r(c.g)}, ${r(c.b)})`],
    ['HSL', `hsl(${r(hsl.h)}, ${r(hsl.s * 100)}%, ${r(hsl.l * 100)}%)`],
    ['CMYK', `cmyk(${r(k.c * 100)}%, ${r(k.m * 100)}%, ${r(k.y * 100)}%, ${r(k.k * 100)}%)`],
  ];
}

/** One-line summary of an item's JSON (brushes, presets…): "size 40 · hardness 0.2 · …". */
function summary(data) {
  if (!data || typeof data !== 'object') return '';
  const flat = [];
  const walk = (o, pre) => {
    for (const [k, v] of Object.entries(o)) {
      if (flat.length > 8) return;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${k}.`);
      else if (Array.isArray(v)) flat.push(`${pre}${k} [${v.length}]`);
      else flat.push(`${pre}${k} ${typeof v === 'number' ? +v.toFixed(2) : String(v).slice(0, 24)}`);
    }
  };
  walk(data, '');
  return flat.slice(0, 6).join(' · ') + (flat.length > 6 ? ' · …' : '');
}

// ---------------------------------------------------------------- item tiles

function ColorTile({ item }) {
  const [anchor, setAnchor] = useState(null);
  const hex = item.data?.hex || '#000000';
  return (
    <>
      <button type="button" onClick={(e) => setAnchor(e.currentTarget)} className="block w-full text-left" aria-label={`${item.name} — colour values`}>
        <span className="block aspect-[4/3] rounded-t-[11px] relative" style={{ background: hex }}>
          <span className="absolute bottom-2 left-2.5 text-[11px] font-mono font-semibold" style={{ color: readableOn(hex) }}>{toHex(parse(hex)).toUpperCase()}</span>
        </span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-72 p-3">
          <div className="h-12 rounded-md mb-2.5" style={{ background: hex }} />
          {colorFormats(hex).map(([k, v]) => (
            <button key={k} type="button" onClick={() => copyText(v, `Copied ${v}`)} className="w-full flex items-center gap-2 h-8 px-2 rounded-md hover:bg-hover text-left group">
              <span className="w-10 text-[11px] text-fg3 font-semibold">{k}</span>
              <span className="flex-1 font-mono text-[12.5px] truncate">{v}</span>
              <Icon name="copy" size={14} className="text-fg3 group-hover:text-fg" />
            </button>
          ))}
        </Popover>
      )}
    </>
  );
}

function StylePreview({ item, para }) {
  const d = item.data || {};
  useEffect(() => { if (d.font) ensureFont(d.font, d.weight || 400, d.style || 'normal'); }, [d.font, d.weight, d.style]);
  const size = Math.min(para ? 18 : 28, Math.max(10, d.size || 16));
  return (
    <div className={cx('rounded-t-[11px] bg-panel-2 px-3 overflow-hidden', para ? 'py-3 h-[118px]' : 'aspect-[4/3] grid place-items-center')}>
      <div style={{ fontFamily: d.font ? `"${d.font}"` : undefined, fontWeight: d.weight || 400, fontStyle: d.style || 'normal', fontSize: size, color: d.color || 'var(--fg)',
        lineHeight: para ? d.lineHeight || 1.45 : 1.15, letterSpacing: d.tracking ? `${d.tracking / 1000}em` : undefined, textAlign: d.align || (para ? 'left' : 'center') }}
        className={para ? 'line-clamp-4' : 'whitespace-nowrap overflow-hidden text-ellipsis max-w-full'}>
        {para ? `${SAMPLE}. Sphinx of black quartz, judge my vow. Pack my box with five dozen liquor jugs.` : 'Aa Bb'}
      </div>
    </div>
  );
}

function ItemVisual({ item }) {
  const d = item.data || {};
  switch (item.kind) {
    case 'color': return <ColorTile item={item} />;
    case 'swatchgroup': return (
      <div className="flex aspect-[4/3] rounded-t-[11px] overflow-hidden">
        {(d.colors || []).map((c, i) => <button key={i} type="button" title={c} onClick={() => copyText(c, `Copied ${c.toUpperCase()}`)} className="flex-1 hover:flex-[1.4] transition-all" style={{ background: c }} />)}
      </div>
    );
    case 'gradient': return <div className="aspect-[4/3] rounded-t-[11px]" style={{ background: gradientCss(d) }} />;
    case 'charstyle': case 'text': return <StylePreview item={item} />;
    case 'parastyle': return <StylePreview item={item} para />;
    case 'graphic': case 'pattern': case 'shape': case 'template':
      if (item.asset_id) return <div className="aspect-[4/3] rounded-t-[11px] checker overflow-hidden grid place-items-center"><img src={`/api/assets/${item.asset_id}/thumb`} onError={(e) => { e.currentTarget.src = item.asset_url; }} alt="" draggable={false} className="max-w-full max-h-full object-contain" /></div>;
      if (d.thumb) return <div className="aspect-[4/3] rounded-t-[11px] bg-panel-2 overflow-hidden grid place-items-center"><img src={d.thumb} alt="" draggable={false} className="max-w-full max-h-full object-contain" /></div>;
    // falls through to the generic tile
    default: {
      const icon = { brush: 'brush', preset: 'presets', look: 'sparkles', lut: 'adjust', template: 'page', pattern: 'grid', shape: 'shapes' }[item.kind] || 'file';
      return (
        <div className="aspect-[4/3] rounded-t-[11px] bg-panel-2 p-3 flex flex-col overflow-hidden">
          <span className="w-9 h-9 rounded-lg bg-chip grid place-items-center text-fg2 mb-2"><Icon name={icon} size={18} /></span>
          <div className="text-[11.5px] text-fg2 font-mono leading-snug line-clamp-4 break-words">{summary(d) || 'No settings'}</div>
        </div>
      );
    }
  }
}

function ItemCard({ item, onMenu, drag }) {
  const sub = item.kind === 'charstyle' || item.kind === 'parastyle'
    ? `${item.data?.font || 'Default'} · ${item.data?.size || 16}pt · ${WEIGHT_NAMES[item.data?.weight] || item.data?.weight || 'Regular'}`
    : item.kind === 'color' ? null : KIND_LABEL[item.kind];
  return (
    <div {...drag} className={cx('group relative rounded-xl bg-surface border border-line hover:border-accent/40 transition', drag.className)} onContextMenu={onMenu}>
      <ItemVisual item={item} />
      <div className="flex items-center gap-1 pl-3 pr-1 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium truncate" title={item.name}>{item.name}</div>
          {sub && <div className="text-[11.5px] text-fg3 truncate">{sub}</div>}
        </div>
        <IconButton icon="more" label={`${item.name} options`} size={26} className="opacity-60 group-hover:opacity-100 focus:opacity-100" onClick={onMenu} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- add dialogs

function AddColor({ onSave, onClose, initial }) {
  const [hex, setHex] = useState(initial?.data?.hex || '#5AB4FF');
  const [name, setName] = useState(initial?.name || '');
  return (
    <Modal title={initial ? 'Edit colour' : 'Add a colour'} onClose={onClose} width={340}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSave({ kind: 'color', name: name.trim() || hex.toUpperCase(), data: { hex } })}>{initial ? 'Save' : 'Add colour'}</Button></>}>
      <ColorPicker value={hex} onChange={setHex} alpha={false} className="!w-full !p-0" />
      <Field label="Name" className="mt-4"><TextInput value={name} placeholder={hex.toUpperCase()} onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}

function AddGradient({ onSave, onClose, initial }) {
  const [g, setG] = useState(() => initial?.data?.stops ? structuredClone(initial.data) : { type: 'linear', angle: 90, stops: [{ color: '#5AB4FF', pos: 0 }, { color: '#8B7CFF', pos: 0.55 }, { color: '#FF8FB1', pos: 1 }] });
  const [name, setName] = useState(initial?.name || '');
  const [active, setActive] = useState(0);
  const bar = useRef(null);
  const setStop = (i, patch) => setG((x) => ({ ...x, stops: x.stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const dragStop = (i) => (e) => {
    e.preventDefault(); e.stopPropagation(); setActive(i);
    const move = (ev) => { const r = bar.current.getBoundingClientRect(); setStop(i, { pos: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) }); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const addAt = (e) => {
    const r = bar.current.getBoundingClientRect();
    const pos = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    // The new stop takes the colour the gradient already has there.
    const sorted = [...g.stops].sort((a, b) => a.pos - b.pos);
    const right = sorted.find((s) => s.pos >= pos) || sorted[sorted.length - 1];
    const left = [...sorted].reverse().find((s) => s.pos <= pos) || sorted[0];
    const t = right.pos === left.pos ? 0 : (pos - left.pos) / (right.pos - left.pos);
    const a = parse(left.color); const b = parse(right.color);
    const color = toHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
    setG((x) => ({ ...x, stops: [...x.stops, { color, pos }] }));
    setActive(g.stops.length);
  };
  const st = g.stops[active] || g.stops[0];
  const save = () => {
    const stops = [...g.stops].sort((a, b) => a.pos - b.pos).map((s) => ({ color: s.color, pos: +s.pos.toFixed(3) }));
    onSave({ kind: 'gradient', name: name.trim() || 'Gradient', data: { type: g.type, angle: g.angle, stops, colors: stops.map((s) => s.color) } });
  };
  return (
    <Modal title={initial ? 'Edit gradient' : 'Add a gradient'} onClose={onClose} width={460}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{initial ? 'Save' : 'Add gradient'}</Button></>}>
      <div className="h-28 rounded-lg mb-4 border border-line" style={{ background: gradientCss(g) }} />
      <div className="text-xs text-fg2 mb-1.5">Stops <span className="text-fg3">— click the bar to add, drag to move</span></div>
      <div className="relative mb-7">
        <div ref={bar} onPointerDown={addAt} className="h-6 rounded-md checker cursor-copy overflow-hidden border border-line">
          <div className="w-full h-full" style={{ background: gradientCss(g, { forceLinear: true }).replace(/\(\d+deg/, '(90deg') }} />
        </div>
        {g.stops.map((s, i) => (
          <button key={i} type="button" aria-label={`Stop ${i + 1}`} onPointerDown={dragStop(i)} onClick={() => setActive(i)}
            className={cx('absolute top-[26px] -ml-[9px] w-[18px] h-[18px] rounded-[5px] border-2 shadow cursor-ew-resize', i === active ? 'border-accent ring-2 ring-accent/40' : 'border-white')}
            style={{ left: `${s.pos * 100}%`, background: s.color }} />
        ))}
      </div>
      {st && (
        <div className="flex flex-wrap items-center gap-3 mb-4 p-3 rounded-lg bg-panel-2">
          <ColorSwatch value={st.color} onChange={(c) => setStop(active, { color: c })} alpha={false} size={30} label="Stop colour" />
          <span className="font-mono text-[13px]">{st.color.toUpperCase()}</span>
          <NumberInput label="Location" unit="%" value={Math.round(st.pos * 100)} min={0} max={100} width={60} onChange={(v) => setStop(active, { pos: v / 100 })} />
          <div className="flex-1" />
          <IconButton icon="trash" label="Remove stop" size={28} disabled={g.stops.length <= 2}
            onClick={() => { setG((x) => ({ ...x, stops: x.stops.filter((_, j) => j !== active) })); setActive(0); }} />
        </div>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Type"><Segmented size="md" value={g.type} onChange={(type) => setG((x) => ({ ...x, type }))} options={[{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }]} /></Field>
        {g.type === 'linear' && <Slider className="flex-1 min-w-40" label="Angle" unit="°" min={0} max={360} value={g.angle} reset={90} onChange={(angle) => setG((x) => ({ ...x, angle }))} />}
      </div>
      <Field label="Name" className="mt-4"><TextInput value={name} placeholder="Gradient" onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}

function AddTextStyle({ onSave, onClose, initial }) {
  const [kind, setKind] = useState(initial?.kind === 'parastyle' ? 'parastyle' : 'charstyle');
  const [d, setD] = useState(() => ({ font: 'Inter', size: 32, weight: 700, style: 'normal', color: '#5AB4FF', tracking: 0, lineHeight: 1.4, align: 'left', spaceAfter: 8, ...(initial?.data || {}) }));
  const [name, setName] = useState(initial?.name || '');
  useEffect(() => { ensureFont(d.font, d.weight, d.style); }, [d.font, d.weight, d.style]);
  const set = (p) => setD((x) => ({ ...x, ...p }));
  const save = () => {
    const data = { font: d.font, size: d.size, weight: d.weight, style: d.style, color: d.color, tracking: d.tracking, ...(kind === 'parastyle' ? { lineHeight: d.lineHeight, align: d.align, spaceAfter: d.spaceAfter } : {}) };
    onSave({ kind, name: name.trim() || `${d.font} ${d.size}`, data });
  };
  return (
    <Modal title={initial ? 'Edit text style' : 'Add a text style'} onClose={onClose} width={500}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>{initial ? 'Save' : 'Add style'}</Button></>}>
      {!initial && <Segmented size="md" className="mb-4" value={kind} onChange={setKind} options={[{ value: 'charstyle', label: 'Character style' }, { value: 'parastyle', label: 'Paragraph style' }]} />}
      <div className="rounded-lg bg-panel-2 border border-line p-4 mb-4 h-32 overflow-hidden">
        <div style={{ fontFamily: `"${d.font}"`, fontSize: Math.min(48, d.size), fontWeight: d.weight, fontStyle: d.style, color: d.color, letterSpacing: `${d.tracking / 1000}em`, lineHeight: kind === 'parastyle' ? d.lineHeight : 1.15, textAlign: kind === 'parastyle' ? d.align : 'left' }}>
          {kind === 'parastyle' ? `${SAMPLE}. Sphinx of black quartz, judge my vow.` : SAMPLE}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Font"><FontPicker value={d.font} weight={d.weight} onChange={(font) => set({ font })} width="100%" /></Field>
        <Field label="Weight"><WeightPicker family={d.font} value={d.weight} onChange={(weight) => set({ weight })} className="w-full" /></Field>
        <div className="flex items-end gap-3">
          <Field label="Size"><NumberInput value={d.size} min={4} max={400} unit="pt" width={72} onChange={(size) => set({ size })} /></Field>
          <Field label="Colour"><ColorSwatch value={d.color} onChange={(color) => set({ color })} size={28} label="Text colour" /></Field>
          <Field label="Italic"><button type="button" aria-pressed={d.style === 'italic'} onClick={() => set({ style: d.style === 'italic' ? 'normal' : 'italic' })} className={cx('h-7 w-8 rounded border border-line grid place-items-center', d.style === 'italic' ? 'bg-active' : 'bg-input')}><Icon name="italic" size={15} /></button></Field>
        </div>
        <Field label="Tracking"><NumberInput value={d.tracking} min={-200} max={1000} step={5} width={72} onChange={(tracking) => set({ tracking })} /></Field>
        {kind === 'parastyle' && (
          <>
            <Field label="Line height"><NumberInput value={d.lineHeight} min={0.8} max={3} step={0.05} width={72} onChange={(lineHeight) => set({ lineHeight })} /></Field>
            <Field label="Align"><Segmented value={d.align} onChange={(align) => set({ align })} options={[{ value: 'left', icon: 'alignLeft', title: 'Left' }, { value: 'center', icon: 'alignCenterH', title: 'Centre' }, { value: 'right', icon: 'alignRight', title: 'Right' }, { value: 'justify', icon: 'menu', title: 'Justify' }]} /></Field>
          </>
        )}
      </div>
      <Field label="Name" className="mt-4"><TextInput value={name} placeholder={`${d.font} ${d.size}`} onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- page

export default function Libraries() {
  const { libraries, reloadLibraries } = useApp();
  const [params, setParams] = useSearchParams();
  const [loaded, setLoaded] = useState(false);
  const [stored, setStored] = useStored('sl-libraries-current', null);
  const [dialog, setDialog] = useState(null); // { kind: 'color'|'gradient'|'text', initial? }
  const [dragging, setDragging] = useState(null); // item id
  const [dropOn, setDropOn] = useState(null); // { lib } or { item, after }
  const [filter, setFilter] = useState('');
  const currentId = params.get('lib') || stored;
  const lib = libraries.find((l) => l.id === currentId) || libraries[0];

  useEffect(() => { document.title = 'Libraries — SoraLab'; reloadLibraries().then(() => setLoaded(true)); }, [reloadLibraries]);
  const choose = (id) => { setStored(id); setParams((p) => { const n = new URLSearchParams(p); n.set('lib', id); return n; }, { replace: true }); };

  const run = async (fn, okMsg) => {
    try { await fn(); if (okMsg) toast(okMsg, { type: 'success' }); } catch (e) { toastError(e); }
    await reloadLibraries();
  };

  const createLib = async () => {
    const name = await promptDialog({ title: 'New library', label: 'Name', placeholder: 'e.g. Brand kit', confirm: 'Create' });
    if (!name) return;
    try { const l = await api.post('/api/libraries', { name }); await reloadLibraries(); choose(l.id); } catch (e) { toastError(e); }
  };
  const renameLib = async (l) => {
    const name = await promptDialog({ title: 'Rename library', label: 'Name', value: l.name });
    if (name && name !== l.name) run(() => api.patch(`/api/libraries/${l.id}`, { name }));
  };
  const deleteLib = async (l) => {
    if (!(await confirmDialog({ title: `Delete “${l.name}”?`, message: `Its ${l.items.length} item${l.items.length === 1 ? '' : 's'} will be deleted too. Projects that used them keep their own copies.`, confirm: 'Delete library', danger: true }))) return;
    run(() => api.del(`/api/libraries/${l.id}`), 'Library deleted');
  };
  const libMenu = (e, l) => openMenu(e.type === 'contextmenu' ? e : e.currentTarget, [
    { label: 'Rename…', icon: 'edit', onClick: () => renameLib(l) },
    { divider: true },
    { label: 'Delete library', icon: 'trash', danger: true, onClick: () => deleteLib(l) },
  ], { align: 'end' });

  const addItem = async (body) => { if (!lib) return; setDialog(null); run(() => api.post(`/api/libraries/${lib.id}/items`, body), `Added to ${lib.name}`); };
  const editItem = async (item, body) => { setDialog(null); run(() => api.patch(`/api/library-items/${item.id}`, { name: body.name, data: body.data })); };
  const addGraphics = async () => {
    const assets = await pickAssets({ kinds: ['image'], multiple: true, title: 'Add graphics' });
    if (!assets?.length || !lib) return;
    run(async () => { for (const a of assets) await api.post(`/api/libraries/${lib.id}/items`, { kind: 'graphic', name: a.name.replace(/\.[^.]+$/, ''), asset_id: a.id, data: { width: a.width, height: a.height } }); },
      `Added ${assets.length} graphic${assets.length > 1 ? 's' : ''}`);
  };
  const addMenu = (e) => openMenu(e.currentTarget, [
    { label: 'Colour', icon: 'palette', onClick: () => setDialog({ kind: 'color' }) },
    { label: 'Gradient', icon: 'gradient', onClick: () => setDialog({ kind: 'gradient' }) },
    { label: 'Text style', icon: 'text', onClick: () => setDialog({ kind: 'text' }) },
    { label: 'Graphic…', icon: 'image', onClick: addGraphics },
  ]);

  const moveItem = (item, to) => run(() => api.patch(`/api/library-items/${item.id}`, { library_id: to.id, position: (to.items.at(-1)?.position || 0) + 1 }), `Moved to ${to.name}`);
  const itemMenu = (e, item) => openMenu(e.type === 'contextmenu' ? e : e.currentTarget, [
    ...(item.kind === 'color' ? [{ label: 'Copy hex', icon: 'copy', onClick: () => copyText(item.data.hex.toUpperCase(), `Copied ${item.data.hex.toUpperCase()}`) }] : []),
    ...(item.kind === 'gradient' ? [{ label: 'Copy CSS', icon: 'copy', onClick: () => copyText(gradientCss(item.data), 'Copied CSS') }] : []),
    ...(['color', 'gradient', 'charstyle', 'parastyle'].includes(item.kind) ? [{ label: 'Edit…', icon: 'sliders', onClick: () => setDialog({ kind: item.kind === 'color' ? 'color' : item.kind === 'gradient' ? 'gradient' : 'text', initial: item }) }] : []),
    { label: 'Rename…', icon: 'edit', onClick: async () => {
      const name = await promptDialog({ title: 'Rename', label: 'Name', value: item.name });
      if (name && name !== item.name) run(() => api.patch(`/api/library-items/${item.id}`, { name }));
    } },
    ...(libraries.length > 1 ? [{ label: 'Move to', icon: 'move', items: libraries.filter((l) => l.id !== item.library_id).map((l) => ({ label: l.name, onClick: () => moveItem(item, l) })) }] : []),
    { divider: true },
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => run(() => api.del(`/api/library-items/${item.id}`)) },
  ], { align: 'end' });

  // Reordering: drop an item before/after another in the same section. Positions are renumbered for the
  // section's items so the order is stable; only items whose position actually changes are saved.
  const reorder = (dragId, target, after) => {
    if (!lib || dragId === target.id) return;
    const item = lib.items.find((i) => i.id === dragId);
    if (!item) return;
    const list = lib.items.filter((i) => i.id !== dragId);
    let at = list.findIndex((i) => i.id === target.id) + (after ? 1 : 0);
    if (at < 0) at = list.length;
    list.splice(at, 0, item);
    const changes = list.map((i, n) => ({ i, pos: n + 1 })).filter(({ i, pos }) => i.position !== pos);
    run(() => Promise.all(changes.map(({ i, pos }) => api.patch(`/api/library-items/${i.id}`, { position: pos }))));
  };
  const dragProps = (item) => ({
    draggable: true,
    onDragStart: (e) => { setDragging(item.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-sl-item', item.id); },
    onDragEnd: () => { setDragging(null); setDropOn(null); },
    onDragOver: (e) => {
      if (!dragging) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      if (dropOn?.item !== item.id || dropOn.after !== after) setDropOn({ item: item.id, after });
    },
    onDrop: (e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/x-sl-item'); setDropOn(null); setDragging(null); reorder(id, item, e.clientX > e.currentTarget.getBoundingClientRect().left + e.currentTarget.getBoundingClientRect().width / 2); },
    className: cx('cursor-grab active:cursor-grabbing', dragging === item.id && 'opacity-40',
      dropOn?.item === item.id && (dropOn.after ? 'shadow-[4px_0_0_0_#5AB4FF]' : 'shadow-[-4px_0_0_0_#5AB4FF]')),
  });
  const libDrop = (l) => ({
    onDragOver: (e) => { if (dragging && l.id !== lib?.id) { e.preventDefault(); setDropOn({ lib: l.id }); } },
    onDragLeave: () => setDropOn((d) => (d?.lib === l.id ? null : d)),
    onDrop: (e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/x-sl-item'); const item = lib?.items.find((i) => i.id === id); setDropOn(null); setDragging(null); if (item) moveItem(item, l); },
  });

  const groups = useMemo(() => {
    if (!lib) return [];
    const needle = filter.trim().toLowerCase();
    const items = lib.items.filter((i) => !needle || i.name.toLowerCase().includes(needle) || (i.data?.hex || '').toLowerCase().includes(needle));
    return GROUPS.map((g) => ({ ...g, items: items.filter((i) => g.kinds.includes(i.kind)) })).filter((g) => g.items.length);
  }, [lib, filter]);

  const dialogEl = dialog && (
    dialog.kind === 'color' ? <AddColor initial={dialog.initial} onClose={() => setDialog(null)} onSave={(b) => (dialog.initial ? editItem(dialog.initial, b) : addItem(b))} />
      : dialog.kind === 'gradient' ? <AddGradient initial={dialog.initial} onClose={() => setDialog(null)} onSave={(b) => (dialog.initial ? editItem(dialog.initial, b) : addItem(b))} />
        : <AddTextStyle initial={dialog.initial} onClose={() => setDialog(null)} onSave={(b) => (dialog.initial ? editItem(dialog.initial, b) : addItem(b))} />
  );

  return (
    <PageLayout wide>
      <PageHero icon="library" title="Libraries" subtitle="Colours, text styles, graphics and presets you use everywhere — every colour picker shows them.">
        <Button variant="primary" icon="plus" onClick={createLib}>New library</Button>
      </PageHero>

      {!loaded && !libraries.length ? <div className="py-16 grid place-items-center"><Spinner size={22} /></div> : !libraries.length ? (
        <EmptyState icon="library" title="No libraries yet" action={<Button variant="primary" icon="plus" onClick={createLib}>Create a library</Button>}>
          Keep your brand colours, type styles and graphics in a library and use them in every app.
        </EmptyState>
      ) : (
        <div className="flex flex-col lg:flex-row gap-6 items-start">
          {/* Library list: a sidebar on wide screens, a scrolling row of chips on phones. */}
          <nav aria-label="Libraries" className="w-full lg:w-60 shrink-0 lg:sticky lg:top-0">
            <div className="hidden lg:block text-[11px] font-semibold uppercase tracking-wider text-fg3 mb-2 px-2">Your libraries</div>
            <div className="flex lg:flex-col gap-1.5 lg:gap-0.5 overflow-x-auto no-scrollbar -mx-4 px-4 lg:mx-0 lg:px-0">
              {libraries.map((l) => (
                <div key={l.id} {...libDrop(l)} className={cx('group flex items-center shrink-0 rounded-full lg:rounded-lg transition border lg:border-0',
                  l.id === lib?.id ? 'bg-active border-accent/40' : 'border-line hover:bg-hover', dropOn?.lib === l.id && 'ring-2 ring-accent bg-accent/15')}>
                  <button type="button" onClick={() => choose(l.id)} onContextMenu={(e) => libMenu(e, l)} aria-current={l.id === lib?.id ? 'true' : undefined}
                    className="flex items-center gap-2.5 h-9 pl-3 pr-1 lg:flex-1 min-w-0 text-left text-sm">
                    <span className="hidden lg:flex w-6 h-6 rounded-md overflow-hidden shrink-0 border border-line">
                      {(l.items.filter((i) => i.kind === 'color').slice(0, 3).map((i) => <span key={i.id} className="flex-1" style={{ background: i.data?.hex }} />))}
                      {!l.items.some((i) => i.kind === 'color') && <span className="flex-1 bg-chip grid place-items-center text-fg3"><Icon name="library" size={12} /></span>}
                    </span>
                    <span className="truncate max-w-40">{l.name}</span>
                    <span className="text-xs text-fg3 tabular-nums">{l.items.length}</span>
                  </button>
                  <IconButton icon="more" label={`${l.name} options`} size={26} className="mr-1 lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100" onClick={(e) => libMenu(e, l)} />
                </div>
              ))}
            </div>
            {dragging && libraries.length > 1 && <p className="hidden lg:block text-xs text-fg3 mt-3 px-2">Drop on a library to move the item there.</p>}
          </nav>

          <main className="flex-1 min-w-0 w-full pb-10">
            {lib && (
              <>
                <div className="flex flex-wrap items-center gap-2 mb-5">
                  <h2 className="font-head font-semibold text-xl mr-auto truncate max-w-full">{lib.name}</h2>
                  <div className="relative w-full sm:w-52 order-last sm:order-none">
                    <Icon name="search" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg3" />
                    <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter items" aria-label="Filter items"
                      className="w-full h-8 pl-8 pr-2.5 rounded-md bg-input border border-line text-sm text-fg placeholder:text-fg3 outline-none focus:border-accent/70" />
                  </div>
                  <Button icon="plus" iconRight="chevronDown" variant="primary" onClick={addMenu}>Add</Button>
                </div>
                {!lib.items.length ? (
                  <EmptyState icon="sparkles" title="This library is empty">
                    Add colours, gradients, text styles and graphics here — or save them from any app.
                    <div className="flex flex-wrap justify-center gap-2 mt-4">
                      <Button size="sm" icon="palette" onClick={() => setDialog({ kind: 'color' })}>Colour</Button>
                      <Button size="sm" icon="gradient" onClick={() => setDialog({ kind: 'gradient' })}>Gradient</Button>
                      <Button size="sm" icon="text" onClick={() => setDialog({ kind: 'text' })}>Text style</Button>
                      <Button size="sm" icon="image" onClick={addGraphics}>Graphic</Button>
                    </div>
                  </EmptyState>
                ) : !groups.length ? <EmptyState icon="search" title="Nothing matches">Try another name.</EmptyState> : groups.map((g) => (
                  <section key={g.id} className="mb-8">
                    <h3 className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-fg2 mb-3">
                      <Icon name={g.icon} size={15} />{g.title}<span className="text-fg3 font-normal">{g.items.length}</span>
                    </h3>
                    <div className={cx('grid gap-3', g.id === 'colors' ? 'grid-cols-[repeat(auto-fill,minmax(120px,1fr))]' : g.id === 'parastyles' ? 'grid-cols-[repeat(auto-fill,minmax(240px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]')}>
                      {g.items.map((i) => <ItemCard key={i.id} item={i} drag={dragProps(i)} onMenu={(e) => itemMenu(e, i)} />)}
                    </div>
                  </section>
                ))}
              </>
            )}
          </main>
        </div>
      )}
      {dialogEl}
    </PageLayout>
  );
}
