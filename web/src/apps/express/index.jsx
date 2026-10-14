// Sora Express: quick designs from templates on the shared vector engine — a friendly sidebar (templates, text,
// elements, uploads, brand, background, layers), a floating toolbar on the selection, pages, and "Resize for…".
import { useEffect, useMemo, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useNavigate } from 'react-router-dom';
import EditorShell from '../../components/EditorShell.jsx';
import { Button, IconButton, NumberInput, ColorSwatch, Popover, Slider, Spinner, openMenu, toast, toastError, cx, libraryColorStore, Segmented } from '../../components/ui.jsx';
import { Icon, iconNames } from '../../components/Icons.jsx';
import { FontPicker, pickAssets } from '../../components/Pickers.jsx';
import { useProject, createProject } from '../../lib/doc.js';
import { appById } from '../../lib/apps.js';
import { api } from '../../lib/api.js';
import { keyLabel } from '../../lib/shortcuts.js';
import { useVectorEditor } from '../_vector/editor.js';
import Viewport from '../_vector/Viewport.jsx';
import { LayersPanel, FillEditor, VIcon } from '../_vector/panels.jsx';
import { useGetData, useClipboard, useVectorShortcuts, editItems, objectMenu, viewMenu, useCanvasDrop } from '../_vector/common.jsx';
import { exportFormats, renderExport } from '../_vector/export.js';
import { make, solid, linear, strokeOf, artboardsOf, findNode, find, updateIn, walk, transformNode, uid, bounds, cloneNode } from '../_vector/model.js';
import { translate, scale, mul, I } from '../_vector/geom.js';
import { renderNode, renderContext } from '../_vector/render.js';
import { loadFonts, fontOf, getFontVersion, onFontsChanged } from '../_vector/text.js';
import { TEMPLATES, buildTemplate, TEXT_PRESETS, PAIRINGS, GRADIENTS } from './templates.js';

const PANELS = [
  { id: 'templates', icon: 'sparkles', label: 'Templates' },
  { id: 'text', icon: 'text', label: 'Text' },
  { id: 'elements', icon: 'shapes', label: 'Elements' },
  { id: 'uploads', icon: 'upload', label: 'Uploads' },
  { id: 'brand', icon: 'palette', label: 'Brand' },
  { id: 'background', icon: 'fill', label: 'Page bg' },
  { id: 'layers', icon: 'layers', label: 'Layers' },
];

export default function ExpressEditor({ id }) {
  const project = useProject(id);
  const ed = useVectorEditor(project, 'express', { defaultStyle: { fill: solid('#8B7CFF'), stroke: null, font: { family: 'Montserrat', size: 64 } } });
  const nav = useNavigate();
  const [panel, setPanel] = useState(null);
  const getData = useGetData(ed);
  useClipboard(ed);
  const page = ed.doc ? artboardsOf(ed.doc).find((a) => a.id === ed.activeAb) || artboardsOf(ed.doc)[0] : null;

  // New, empty projects open with the template picker.
  useEffect(() => { if (ed.doc && panel === null) setPanel(artboardsOf(ed.doc).every((a) => !a.children.length) ? 'templates' : 'templates'); }, [ed.doc, panel]);
  useEffect(() => { if (ed.tool !== 'select' && ed.tool !== 'hand') ed.setTool('select'); }, [ed.tool]); // eslint-disable-line react-hooks/exhaustive-deps

  const center = () => (page ? { x: page.x + page.w / 2, y: page.y + page.h / 2 } : { x: 0, y: 0 });
  const addText = (preset, at) => {
    if (!page) return;
    const size = Math.round(Math.min(page.w, page.h * 1.2) * preset.font[2] * 1.6);
    const w = Math.round(page.w * 0.8);
    const c = at || center();
    const n = make.text({ x: c.x - w / 2, y: c.y - size * 0.6, w, h: 0, mode: 'area', text: preset.sample, font: { family: preset.font[0], weight: preset.font[1], size, align: 'center' }, fill: solid('#1d1b2e'), name: preset.label.replace('Add a ', '') });
    ed.addNodes([n], 'Add Text', { parent: page.id });
    return n;
  };
  useVectorShortcuts(ed, {
    tools: { v: 'select', h: 'hand' },
    extra: {
      'mod+d': () => ed.duplicate(), t: () => addText(TEXT_PRESETS[0]),
      r: () => addShape('rect'), c: () => addShape('ellipse'),
      'mod+2': () => ed.setFlag('locked', true), 'alt+mod+2': () => ed.unlockAll(),
    },
  });
  const drop = useCanvasDrop(ed);

  const addShape = (kind, extra = {}) => {
    if (!page) return;
    const s = Math.round(Math.min(page.w, page.h) * 0.3);
    const c = center();
    const style = { fill: solid(extra.color || '#8B7CFF'), stroke: null };
    let n;
    if (kind === 'line') n = { ...make.line({ x1: c.x - s, y1: c.y, x2: c.x + s, y2: c.y }), stroke: strokeOf('#1d1b2e', Math.max(4, s / 30), { cap: 'round', ...(extra.dash ? { dash: [s / 8, s / 12] } : {}) }), name: 'Line' };
    else if (kind === 'path') n = { ...unitPath(extra.d, c.x - s / 2, c.y - s / 2, s), ...style, name: extra.name };
    else n = { ...make[kind]({ x: c.x - s / 2, y: c.y - s / 2, w: s, h: s, ...(extra.r ? { r: s * extra.r } : {}), ...(extra.sides ? { sides: extra.sides } : {}), ...(extra.points ? { points: extra.points, inner: extra.inner || 0.5 } : {}) }), ...style, name: extra.name || kind };
    if (extra.fill) n.fill = extra.fill;
    ed.addNodes([n], 'Add Element', { parent: page.id });
  };
  const addIcon = (name) => {
    const ds = iconPaths(name);
    const s = Math.round(Math.min(page.w, page.h) * 0.25);
    const c = center(); const k = s / 24;
    const subpaths = ds.flatMap((d) => make.path({ d }).subpaths).map((sp) => ({ ...sp, pts: sp.pts.map((p) => ({ x: c.x - s / 2 + p.x * k, y: c.y - s / 2 + p.y * k, ix: c.x - s / 2 + p.ix * k, iy: c.y - s / 2 + p.iy * k, ox: c.x - s / 2 + p.ox * k, oy: c.y - s / 2 + p.oy * k })) }));
    ed.addNodes([{ ...make.path({ subpaths }), fill: null, stroke: strokeOf('#1d1b2e', 1.75 * k, { cap: 'round', join: 'round' }), name: `${name} icon` }], 'Add Icon', { parent: page.id });
  };
  const addFrame = (shape) => {
    const s = Math.round(Math.min(page.w, page.h) * 0.45);
    const c = center();
    const base = shape === 'circle' ? make.ellipse({ x: c.x - s / 2, y: c.y - s / 2, w: s, h: s }) : shape === 'arch' ? unitPath('M0 1V0.5C0 0.22 0.22 0 0.5 0S1 0.22 1 0.5V1Z', c.x - s / 2, c.y - s / 2, s) : make.rect({ x: c.x - s / 2, y: c.y - s * 0.62, w: s, h: s * 1.25, r: s * 0.06 });
    const g = make.group([{ ...base, id: uid(), fill: solid('#d9d9e3'), stroke: null, name: 'Placeholder' }, { ...base, id: uid(), fill: null, stroke: null, name: 'Frame shape' }], { clip: true, frame: true, name: 'Photo frame' });
    ed.addNodes([g], 'Add Frame', { parent: page.id });
  };

  /** Puts an image into a frame (cover-fit), replacing what was in it. */
  const fillFrame = async (frame, asset) => {
    const mask = frame.children[frame.children.length - 1];
    const b = bounds(mask, ed.doc);
    const w = asset.width || 1000; const h = asset.height || 1000;
    const s = Math.max(b.w / w, b.h / h);
    const img = make.image({ x: b.x + (b.w - w * s) / 2, y: b.y + (b.h - h * s) / 2, w: w * s, h: h * s, asset: asset.id, name: asset.name || 'Photo' });
    ed.updateNode(frame.id, (g) => ({ ...g, children: [img, g.children[g.children.length - 1]] }), 'Replace Image');
  };
  const replaceImage = async () => {
    const n = ed.selNodes[0];
    const [a] = (await pickAssets({ kinds: ['image'], multiple: false, docId: project.doc?.id, title: 'Choose a photo' })) || [];
    if (!a || !n) return;
    if (n.type === 'group' && n.clip) fillFrame(n, a);
    else if (n.type === 'image') ed.updateNode(n.id, { asset: a.id, name: a.name }, 'Replace Image');
  };

  /** Replaces the current page with a template (resizing the page to fit it). Undo brings the old page back. */
  const applyTemplate = async (tpl) => {
    if (!page || ed.readOnly) return;
    const ab = { ...page, w: tpl.w, h: tpl.h };
    const kids = buildTemplate(tpl, ab);
    await loadFonts(kids);
    ed.changeDoc((d) => ({ ...d, children: d.children.map((n) => (n.id === page.id ? { ...n, w: tpl.w, h: tpl.h, bg: tpl.bg, children: kids, name: n.name } : n)) }), `Template: ${tpl.name}`);
    ed.setSel([]);
    setTimeout(() => ed.viewportRef.current?.fit(), 30);
    toast(`Applied “${tpl.name}” — undo to go back`, { action: { label: 'Undo', onClick: ed.h.undo } });
  };

  /** "Resize for…": a copy of the whole design at another preset size, with everything scaled to fit. */
  const resizeFor = async (preset) => {
    const d = ed.get();
    const pages = artboardsOf(d);
    let y = 0;
    const out = pages.map((p) => {
      const s = Math.min(preset.width / p.w, preset.height / p.h);
      const ox = (preset.width - p.w * s) / 2; const oy = (preset.height - p.h * s) / 2;
      const M = mul(translate(ox, y + oy), mul(scale(s), translate(-p.x, -p.y)));
      const kids = p.children.map((c) => {
        const cb = bounds(c, d);
        // Full-page backgrounds stretch to the new page instead of letterboxing.
        if (cb.x <= p.x + 1 && cb.y <= p.y + 1 && cb.w >= p.w - 2 && cb.h >= p.h - 2 && c.type !== 'group') {
          return transformNode(cloneNode(c), mul(translate(0, y), mul(scale(preset.width / p.w, preset.height / p.h), translate(-p.x, -p.y))));
        }
        const n = transformNode(cloneNode(c), M);
        // Type scales with the layout.
        const fix = (x) => (x.type === 'text' && x.mode === 'area' ? { ...x, font: { ...x.font, size: Math.round(fontOf(x).size * s * 10) / 10, leading: x.font?.leading ? x.font.leading * s : 0 } } : x.children ? { ...x, children: x.children.map(fix) } : x);
        return fix(n);
      });
      const np = { ...p, id: uid(), x: 0, y, w: preset.width, h: preset.height, children: kids };
      y += preset.height + 80;
      return np;
    });
    try {
      const nd = await createProject('express', { name: `${project.doc.name} — ${preset.label}`, width: preset.width, height: preset.height, data: { ...d, children: out, home: out[0].id } });
      toast(`Made a ${preset.label} copy`, { type: 'success' });
      nav(`/express/${nd.id}`);
    } catch (e) { toastError(e); }
  };

  const exportConfig = useMemo(() => (ed.doc ? { formats: exportFormats(ed.doc, { label: 'Page', current: ed.activeAb }), render: (fid, o, { onProgress }) => renderExport(ed.get(), fid, o, onProgress) } : undefined), [ed.doc, ed.activeAb]); // eslint-disable-line react-hooks/exhaustive-deps
  const presets = appById('express').presets;

  const rail = PANELS.map((p) => (
    <button key={p.id} type="button" onClick={() => setPanel(panel === p.id ? 'none' : p.id)} title={p.label}
      className={cx('w-10 py-1.5 rounded-md flex flex-col items-center gap-0.5 text-[9px]', panel === p.id ? 'bg-active text-fg' : 'text-fg2 hover:bg-hover hover:text-fg')}>
      <Icon name={p.icon} size={18} /><span className="leading-none">{p.label}</span>
    </button>
  ));

  const options = (
    <>
      <Button size="sm" variant="ghost" icon="scale" disabled={ed.readOnly} onClick={(e) => openMenu(e, [{ heading: 'Resize for… (makes a copy)' }, ...presets.map((p) => ({ label: `${p.label}  ${p.width}×${p.height}`, onClick: () => resizeFor(p) }))])}>Resize for…</Button>
      <Button size="sm" variant="ghost" icon="plus" disabled={ed.readOnly} onClick={() => { ed.addArtboard({ bg: '#ffffff' }); setTimeout(() => ed.viewportRef.current?.fit(), 30); }}>Add page</Button>
      {page && <span className="text-[12px] text-fg3">{page.name} · {page.w}×{page.h}</span>}
      <span className="flex-1" />
      <IconButton icon="zoomOut" label="Zoom out" size={28} onClick={() => ed.viewportRef.current?.zoomAt(ed.view.zoom / 1.25)} />
      <span className="text-[12px] w-12 text-center tabular-nums">{Math.round(ed.view.zoom * 100)}%</span>
      <IconButton icon="zoomIn" label="Zoom in" size={28} onClick={() => ed.viewportRef.current?.zoomAt(ed.view.zoom * 1.25)} />
      <IconButton icon="fit" label="Fit page" size={28} onClick={() => ed.viewportRef.current?.fit()} />
    </>
  );

  return (
    <EditorShell app="express" project={project} history={ed.h} getData={getData}
      menus={[objectMenu(ed, { symbolsLabel: 'Component' }), viewMenu(ed)]} editItems={editItems(ed, { dupKey: 'mod+d' })}
      exportConfig={exportConfig} tools={<div className="flex flex-col items-center gap-1">{rail}</div>} options={options}
      commentAnchor={() => ed.viewportRef.current?.center()} anchorLabel={() => 'this spot'}
      onJumpToComment={(a) => ed.viewportRef.current?.fitRect({ x: a.x - 300, y: a.y - 300, w: 600, h: 600 })}>
      <div className="absolute inset-0 flex">
        {panel && panel !== 'none' && (
          <div className="w-80 shrink-0 bg-panel border-r border-line overflow-y-auto scroll-thin">
            <div className="flex items-center h-10 px-3 border-b border-line sticky top-0 bg-panel z-10">
              <span className="font-head font-semibold text-sm flex-1">{PANELS.find((p) => p.id === panel)?.label}</span>
              <IconButton icon="close" label="Close panel" size={26} onClick={() => setPanel('none')} />
            </div>
            <div className="p-3">
              {panel === 'templates' && <TemplatesPanel page={page} onApply={applyTemplate} ro={ed.readOnly} />}
              {panel === 'text' && <TextPanel page={page} onAdd={addText} ed={ed} />}
              {panel === 'elements' && <ElementsPanel addShape={addShape} addIcon={addIcon} addFrame={addFrame} ed={ed} page={page} />}
              {panel === 'uploads' && <UploadsPanel ed={ed} project={project} />}
              {panel === 'brand' && <BrandPanel ed={ed} page={page} />}
              {panel === 'background' && <BackgroundPanel ed={ed} page={page} />}
              {panel === 'layers' && <div className="-mx-3 -mt-3"><LayersPanel ed={ed} /></div>}
            </div>
          </div>
        )}
        <div className="flex-1 relative min-w-0" {...drop}>
          {ed.doc && <Viewport ed={ed} artboardLabel={(a) => `${a.name}`} />}
          {ed.doc && !ed.readOnly && <FloatingToolbar ed={ed} onReplace={replaceImage} />}
        </div>
      </div>
    </EditorShell>
  );
}

/** A path from data in a 0..1 box, placed at x, y with size s. */
function unitPath(d, x, y, s) {
  const p = make.path({ d });
  return { ...p, subpaths: p.subpaths.map((sp) => ({ ...sp, pts: sp.pts.map((q) => ({ x: x + q.x * s, y: y + q.y * s, ix: x + q.ix * s, iy: y + q.iy * s, ox: x + q.ox * s, oy: y + q.oy * s })) })) };
}
const iconCache = new Map();
function iconPaths(name) {
  if (!iconCache.has(name)) {
    const html = renderToStaticMarkup(<Icon name={name} />);
    iconCache.set(name, [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]));
  }
  return iconCache.get(name);
}

// ---------------------------------------------------------------- side panels

function useFontTick() {
  const [, set] = useState(0);
  useEffect(() => onFontsChanged(() => set(getFontVersion())), []);
}
function NodesPreview({ nodes, w, h, bg, size = 130 }) {
  useFontTick();
  const ctx = renderContext({ symbols: [] }, { prefix: `p${uid()}-` });
  const html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"><rect width="${w}" height="${h}" fill="${bg || '#fff'}"/>${nodes.map((n) => renderNode(n, ctx)).join('')}</svg>`;
  // eslint-disable-next-line react/no-danger
  return <div className="w-full" style={{ aspectRatio: `${w} / ${h}`, maxHeight: size * 1.6 }} dangerouslySetInnerHTML={{ __html: html }} />;
}

function TemplatesPanel({ page, onApply, ro }) {
  const [cat, setCat] = useState('all');
  const built = useMemo(() => TEMPLATES.map((t) => ({ t, nodes: buildTemplate(t, { x: 0, y: 0 }) })), []);
  useEffect(() => { loadFonts(built.flatMap((b) => b.nodes)); }, [built]);
  const cats = ['all', ...new Set(TEMPLATES.map((t) => t.category))];
  const fits = (t) => page && t.w === page.w && t.h === page.h;
  const list = built.filter(({ t }) => cat === 'all' || t.category === cat).sort((a, b) => Number(fits(b.t)) - Number(fits(a.t)));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1">
        {cats.map((c) => <button key={c} type="button" onClick={() => setCat(c)} className={cx('px-2 h-6 rounded-full text-[11px] border', cat === c ? 'bg-accent text-[#06121f] border-accent' : 'border-line text-fg2 hover:text-fg')}>{c === 'all' ? 'All' : c}</button>)}
      </div>
      <p className="text-[11px] text-fg3">Click a template to replace this page (Undo brings it back). Templates for this page size come first.</p>
      <div className="grid grid-cols-2 gap-2 items-start">
        {list.map(({ t, nodes }) => (
          <button key={t.id} type="button" disabled={ro} onClick={() => onApply(t)} data-template={t.id}
            className="group text-left rounded-lg overflow-hidden border border-line hover:border-accent bg-panel-2 transition">
            <div className="p-1.5 grid place-items-center bg-work"><NodesPreview nodes={nodes} w={t.w} h={t.h} bg={t.bg} /></div>
            <div className="px-2 py-1.5"><div className="text-[12px] truncate">{t.name}</div><div className="text-[10.5px] text-fg3 truncate">{t.category} · {t.w}×{t.h}{fits(t) ? ' · fits' : ''}</div></div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TextPanel({ page, onAdd, ed }) {
  useFontTick();
  useEffect(() => { loadFonts(PAIRINGS.flatMap((p) => [make.text({ text: 'a', font: { family: p.head[0], weight: p.head[1] } }), make.text({ text: 'a', font: { family: p.body[0], weight: p.body[1] } })])); }, []);
  const addPair = (p) => {
    if (!page) return;
    const w = page.w * 0.8; const hs = Math.round(Math.min(page.w, page.h) * 0.11); const bs = Math.round(hs * 0.38);
    const c = { x: page.x + page.w / 2, y: page.y + page.h / 2 };
    const a = make.text({ x: c.x - w / 2, y: c.y - hs, w, h: 0, mode: 'area', text: p.sample[0], font: { family: p.head[0], weight: p.head[1], size: hs, align: 'center' }, fill: solid('#1d1b2e'), name: 'Heading' });
    const b = make.text({ x: c.x - w / 2, y: c.y + hs * 0.35, w, h: 0, mode: 'area', text: p.sample[1], font: { family: p.body[0], weight: p.body[1], size: bs, align: 'center' }, fill: solid('#4a4760'), name: 'Body' });
    ed.addNodes([make.group([a, b], { name: 'Text pair' })], 'Add Text', { parent: page.id });
  };
  return (
    <div className="flex flex-col gap-2">
      <Button variant="primary" icon="text" onClick={() => onAdd(TEXT_PRESETS[0])} disabled={ed.readOnly}>Add a text box</Button>
      {TEXT_PRESETS.map((p, i) => (
        <button key={p.label} type="button" disabled={ed.readOnly} onClick={() => onAdd(p)} className="text-left px-3 py-2 rounded-lg bg-panel-2 hover:bg-hover border border-line"
          style={{ fontFamily: `"${p.font[0]}"`, fontWeight: p.font[1], fontSize: [26, 18, 13][i] }}>{p.label}</button>
      ))}
      <div className="text-[11px] uppercase tracking-wider text-fg3 mt-2">Font pairings</div>
      <div className="grid grid-cols-2 gap-2">
        {PAIRINGS.map((p) => (
          <button key={p.head[0]} type="button" disabled={ed.readOnly} onClick={() => addPair(p)} className="p-2 rounded-lg bg-white text-[#1d1b2e] hover:ring-2 ring-accent text-center">
            <div style={{ fontFamily: `"${p.head[0]}"`, fontWeight: p.head[1], fontSize: 20, lineHeight: 1.1 }}>{p.sample[0]}</div>
            <div style={{ fontFamily: `"${p.body[0]}"`, fontWeight: p.body[1], fontSize: 10 }} className="text-[#4a4760] mt-1">{p.sample[1]}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

const SHAPES = [
  { k: 'rect', name: 'Square', icon: 'square' }, { k: 'rect', name: 'Rounded', r: 0.18, icon: 'rect' }, { k: 'ellipse', name: 'Circle', icon: 'circle' },
  { k: 'polygon', name: 'Triangle', sides: 3, icon: 'polygon' }, { k: 'polygon', name: 'Hexagon', sides: 6, icon: 'polygon' }, { k: 'star', name: 'Star', points: 5, inner: 0.45, icon: 'starShape' },
  { k: 'star', name: 'Burst', points: 12, inner: 0.75, icon: 'sparkles' }, { k: 'path', name: 'Heart', d: 'M0.5 0.95C0.2 0.72 0 0.52 0 0.3C0 0.13 0.13 0 0.29 0C0.39 0 0.46 0.05 0.5 0.12C0.54 0.05 0.61 0 0.71 0C0.87 0 1 0.13 1 0.3C1 0.52 0.8 0.72 0.5 0.95Z', icon: 'drop' },
  { k: 'path', name: 'Arrow', d: 'M0 0.35H0.6V0.12L1 0.5L0.6 0.88V0.65H0V0.35Z', icon: 'arrow' }, { k: 'path', name: 'Speech', d: 'M0.1 0H0.9C0.96 0 1 0.04 1 0.1V0.65C1 0.71 0.96 0.75 0.9 0.75H0.4L0.18 0.95V0.75H0.1C0.04 0.75 0 0.71 0 0.65V0.1C0 0.04 0.04 0 0.1 0Z', icon: 'comment' },
];
const ICONS = ['star', 'home', 'user', 'bell', 'camera', 'clock', 'cloud', 'heart', 'link', 'lock', 'mic', 'phone', 'play', 'search', 'settings', 'sun', 'moon', 'check', 'tag', 'pin', 'image', 'video', 'audio', 'comment', 'share', 'download', 'sparkles', 'palette', 'brush', 'drop'].filter((n) => iconNames.includes(n));

function ElementsPanel({ addShape, addIcon, addFrame, ed }) {
  const ro = ed.readOnly;
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] uppercase tracking-wider text-fg3">Shapes</div>
      <div className="grid grid-cols-5 gap-1.5">
        {SHAPES.map((s) => <IconButton key={s.name} icon={s.icon} label={s.name} size={48} iconSize={26} disabled={ro} className="bg-panel-2" onClick={() => addShape(s.k, s)} />)}
      </div>
      <div className="text-[11px] uppercase tracking-wider text-fg3">Lines</div>
      <div className="flex gap-1.5">
        <Button size="sm" disabled={ro} onClick={() => addShape('line')}>Solid line</Button>
        <Button size="sm" disabled={ro} onClick={() => addShape('line', { dash: true })}>Dashed line</Button>
      </div>
      <div className="text-[11px] uppercase tracking-wider text-fg3">Frames <span className="normal-case tracking-normal">— then Replace to drop a photo in</span></div>
      <div className="flex gap-1.5">
        {[['rect', 'Portrait'], ['circle', 'Circle'], ['arch', 'Arch']].map(([k, l]) => <Button key={k} size="sm" icon="frame" disabled={ro} onClick={() => addFrame(k)}>{l}</Button>)}
      </div>
      <div className="text-[11px] uppercase tracking-wider text-fg3">Gradients</div>
      <div className="grid grid-cols-4 gap-1.5">
        {GRADIENTS.map((g, i) => <button key={i} type="button" disabled={ro} title="Add a gradient shape" onClick={() => addShape('rect', { name: 'Gradient', r: 0.08, fill: linear(135, ...g) })} className="h-12 rounded-lg border border-line" style={{ background: `linear-gradient(135deg, ${g.join(',')})` }} />)}
      </div>
      <div className="text-[11px] uppercase tracking-wider text-fg3">Icons</div>
      <div className="grid grid-cols-6 gap-1">
        {ICONS.map((n) => <IconButton key={n} icon={n} label={n} size={40} iconSize={20} disabled={ro} className="bg-panel-2" onClick={() => addIcon(n)} />)}
      </div>
    </div>
  );
}

function UploadsPanel({ ed, project }) {
  const [list, setList] = useState(null);
  const load = () => api.get('/api/assets?kind=image&limit=60').then((l) => setList(l.filter((a) => a.kind === 'image'))).catch(() => setList([]));
  useEffect(() => { load(); }, []);
  const pick = async () => { const a = await pickAssets({ kinds: ['image'], docId: project.doc?.id, title: 'Upload photos' }); if (a?.length) { ed.placeAssets(a); load(); } };
  return (
    <div className="flex flex-col gap-3">
      <Button variant="primary" icon="upload" onClick={pick} disabled={ed.readOnly}>Upload or choose photos</Button>
      {!list ? <Spinner /> : !list.length ? <p className="text-xs text-fg3">Photos you upload show up here.</p> : (
        <div className="grid grid-cols-2 gap-1.5">
          {list.map((a) => (
            <button key={a.id} type="button" disabled={ed.readOnly} title={a.name} onClick={() => {
              const n = ed.selNodes[0];
              if (n?.type === 'group' && n.clip) { const mask = n.children[n.children.length - 1]; const b = bounds(mask, ed.doc); const s = Math.max(b.w / (a.width || 1000), b.h / (a.height || 1000)); ed.updateNode(n.id, (g) => ({ ...g, children: [make.image({ x: b.x + (b.w - (a.width || 1000) * s) / 2, y: b.y + (b.h - (a.height || 1000) * s) / 2, w: (a.width || 1000) * s, h: (a.height || 1000) * s, asset: a.id, name: a.name }), mask] }), 'Replace Image'); }
              else ed.placeAssets([a]);
            }} className="rounded-md overflow-hidden bg-panel-2 aspect-square border border-line hover:border-accent">
              <img src={a.thumb || `/api/assets/${a.id}/thumb`} alt="" className="w-full h-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <p className="text-[11px] text-fg3">Tip: select a photo frame first and a photo goes into it.</p>
    </div>
  );
}

function BrandPanel({ ed, page }) {
  const lib = libraryColorStore.use();
  const used = useMemo(() => {
    const cols = new Set(); const fonts = new Set();
    if (ed.doc) walk(ed.doc.children, (n) => { if (n.fill?.type === 'solid') cols.add(n.fill.color.slice(0, 7).toLowerCase()); if (n.type === 'text') fonts.add(fontOf(n).family); });
    return { cols: [...cols].slice(0, 24), fonts: [...fonts] };
  }, [ed.doc]);
  const apply = (c) => {
    if (ed.sel.length) ed.setProps((n) => (n.type === 'image' ? {} : { fill: solid(c) }), 'Colour');
    else if (page) ed.updateArtboard(page.id, { bg: c }, 'Background');
  };
  const Swatches = ({ colors }) => <div className="flex flex-wrap gap-1.5">{colors.map((c, i) => <button key={`${c}${i}`} type="button" title={c} onClick={() => apply(c)} className="w-8 h-8 rounded-full border border-line hover:scale-110 transition" style={{ background: c }} />)}</div>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-fg3">Click a colour to use it on the selection (or the page background when nothing is selected).</p>
      <div className="text-[11px] uppercase tracking-wider text-fg3">Library colours</div>
      {lib.length ? <Swatches colors={lib} /> : <p className="text-xs text-fg3">Add colours to your Libraries to see your brand palette here.</p>}
      <div className="text-[11px] uppercase tracking-wider text-fg3">In this design</div>
      <Swatches colors={used.cols} />
      <div className="text-[11px] uppercase tracking-wider text-fg3">Document swatches</div>
      <Swatches colors={ed.doc?.swatches || []} />
      <div className="text-[11px] uppercase tracking-wider text-fg3">Fonts in this design</div>
      <div className="flex flex-col gap-1">
        {used.fonts.map((f) => <button key={f} type="button" className="text-left px-2 py-1.5 rounded bg-panel-2 hover:bg-hover text-[15px]" style={{ fontFamily: `"${f}"` }}
          onClick={() => ed.setProps((n) => (n.type === 'text' ? { font: { ...n.font, family: f } } : {}), 'Font')}>{f}</button>)}
        {!used.fonts.length && <p className="text-xs text-fg3">No text yet.</p>}
      </div>
    </div>
  );
}

function BackgroundPanel({ ed, page }) {
  if (!page) return null;
  const setBg = (c) => ed.updateArtboard(page.id, { bg: c }, 'Background');
  const setGradient = (g) => {
    // A gradient background is a locked full-page shape at the back.
    const existing = page.children.find((n) => n.name === 'Background' && n.type === 'rect');
    const fill = linear(135, ...g);
    if (existing) ed.updateNode(existing.id, { fill }, 'Background');
    else ed.addNodes([{ ...make.rect({ x: page.x, y: page.y, w: page.w, h: page.h, fill }), stroke: null, name: 'Background', locked: true }], 'Background', { parent: page.id, index: 0, select: false });
  };
  const colors = ['#ffffff', '#f6efe3', '#fff0f6', '#eef6ff', '#e9fff1', '#fffbe6', '#1d1b2e', '#10162f', '#0b0e1a', '#111111', '#ff7a59', '#ffd400', '#5AB4FF', '#8B7CFF', '#FF8FB1', '#34c759'];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2"><span className="text-sm">Page colour</span><ColorSwatch value={page.bg} onChange={(c) => ed.updateArtboard(page.id, { bg: c }, 'Background', { merge: `bg-${page.id}` })} onCommit={() => ed.h.commit()} /></div>
      <div className="grid grid-cols-8 gap-1.5">{colors.map((c) => <button key={c} type="button" onClick={() => setBg(c)} className="h-8 rounded-md border border-line" style={{ background: c }} title={c} />)}</div>
      <div className="text-[11px] uppercase tracking-wider text-fg3">Gradients</div>
      <div className="grid grid-cols-4 gap-1.5">{GRADIENTS.map((g, i) => <button key={i} type="button" onClick={() => setGradient(g)} className="h-12 rounded-md border border-line" style={{ background: `linear-gradient(135deg, ${g.join(',')})` }} />)}</div>
      <Button size="sm" variant="ghost" icon="image" onClick={async () => {
        const [a] = (await pickAssets({ kinds: ['image'], multiple: false, docId: ed.project.doc?.id, title: 'Background photo' })) || [];
        if (a) ed.addNodes([{ ...make.image({ x: page.x, y: page.y, w: page.w, h: page.h, asset: a.id }), name: 'Background photo', locked: true }], 'Background', { parent: page.id, index: 0, select: false });
      }}>Use a photo</Button>
    </div>
  );
}

// ---------------------------------------------------------------- floating toolbar

function FloatingToolbar({ ed, onReplace }) {
  const [pop, setPop] = useState(null); // { kind, anchor }
  const b = ed.selBounds;
  if (!b || !ed.selNodes.length || ed.editingText) return null;
  const v = ed.view;
  const left = Math.max(8, (b.x + b.w / 2) * v.zoom + v.x);
  const top = b.y * v.zoom + v.y - 56;
  const n = ed.selNodes[0];
  const leaves = []; walk(ed.selNodes, (x) => { if (x.type !== 'group') leaves.push(x); });
  const texts = leaves.filter((x) => x.type === 'text');
  const shape = leaves.find((x) => x.type !== 'text' && x.type !== 'image');
  const isFrame = ed.selNodes.length === 1 && n.type === 'group' && n.clip;
  const key = ed.sel.join();
  const f = texts[0] ? fontOf(texts[0]) : null;
  const setTextProps = (patch) => {
    // setProps doesn't reach into groups for non-style keys, so update each text leaf.
    ed.change((r) => { let nr = r; for (const t of texts) nr = updateIn(nr, t.id, (x) => ({ ...x, font: { ...x.font, ...patch } })); return nr; }, 'Text', { merge: `ftg-${key}-${Object.keys(patch)}` });
  };
  const textColor = texts[0]?.fill?.color || '#000000';
  return (
    <div className="absolute z-20 -translate-x-1/2 flex items-center gap-1 px-1.5 h-11 rounded-xl bg-panel border border-line shadow-[0_8px_30px_rgba(0,0,0,.35)]" style={{ left, top: Math.max(6, top) }}
      onPointerDown={(e) => e.stopPropagation()} data-floating-toolbar="">
      {texts.length > 0 && (
        <>
          <FontPicker value={f.family} weight={f.weight} onChange={(fam) => { setTextProps({ family: fam }); ed.h.commit(); }} width={140} />
          <NumberInput value={f.size} min={4} max={1000} width={50} onChange={(s) => setTextProps({ size: s })} onCommit={() => ed.h.commit()} />
          <ColorSwatch value={textColor} size={26} onChange={(c) => ed.change((r) => { let nr = r; for (const t of texts) nr = updateIn(nr, t.id, (x) => ({ ...x, fill: solid(c) })); return nr; }, 'Text Colour', { merge: `tc-${key}` })} onCommit={() => ed.h.commit()} title="Text colour" />
          <IconButton icon="bold" label="Bold" size={28} active={f.weight >= 700} onClick={() => { setTextProps({ weight: f.weight >= 700 ? 400 : 700 }); ed.h.commit(); }} />
          <IconButton icon="italic" label="Italic" size={28} active={f.style === 'italic'} onClick={() => { setTextProps({ style: f.style === 'italic' ? 'normal' : 'italic' }); ed.h.commit(); }} />
          <IconButton icon={f.align === 'left' ? 'alignLeft' : f.align === 'right' ? 'alignRight' : 'alignCenterH'} label="Alignment" size={28} onClick={() => { setTextProps({ align: { left: 'center', center: 'right', right: 'left' }[f.align] || 'left' }); ed.h.commit(); }} />
          <IconButton icon="sliders" label="Spacing" size={28} onClick={(e) => setPop({ kind: 'spacing', anchor: e.currentTarget })} />
          <span className="w-px h-6 bg-line mx-0.5" />
        </>
      )}
      {!texts.length && shape && (
        <>
          <button type="button" title="Fill" onClick={(e) => setPop({ kind: 'fill', anchor: e.currentTarget })} className="w-7 h-7 rounded-md border border-line checker overflow-hidden"><span className="block w-full h-full" style={{ background: shape.fill?.type === 'solid' ? shape.fill.color : shape.fill?.stops ? `linear-gradient(135deg, ${shape.fill.stops.map((s) => s.color).join(',')})` : 'transparent' }} /></button>
          <ColorSwatch value={shape.stroke?.color || null} none size={26} title="Border colour" onChange={(c) => ed.setProps((x) => ({ stroke: c ? { ...(x.stroke || strokeOf(c, 4)), color: c } : null }), 'Border', { merge: `bd-${key}` })} onCommit={() => ed.h.commit()} />
          {n.type === 'rect' && <NumberInput label="◜" value={Math.round(n.r || 0)} min={0} width={44} onChange={(r) => ed.setProps({ r }, 'Corner', { merge: `cr-${key}` })} onCommit={() => ed.h.commit()} title="Corner radius" />}
          <span className="w-px h-6 bg-line mx-0.5" />
        </>
      )}
      {(isFrame || n.type === 'image') && <><Button size="sm" variant="ghost" icon="image" onClick={onReplace}>Replace</Button><span className="w-px h-6 bg-line mx-0.5" /></>}
      <IconButton icon="adjust" label="Transparency" size={28} onClick={(e) => setPop({ kind: 'opacity', anchor: e.currentTarget })} />
      <IconButton icon="layers" label="Arrange" size={28} onClick={(e) => openMenu(e, [
        { label: 'Bring to front', icon: 'bringFront', onClick: () => ed.arrange('front') }, { label: 'Bring forward', onClick: () => ed.arrange('forward') },
        { label: 'Send backward', onClick: () => ed.arrange('backward') }, { label: 'Send to back', icon: 'sendBack', onClick: () => ed.arrange('back') },
        { divider: true }, { heading: 'Align to page' },
        ...[['left', 'Left', 'alignLeft'], ['hcenter', 'Centre', 'alignCenterH'], ['right', 'Right', 'alignRight'], ['top', 'Top', 'alignTop'], ['vcenter', 'Middle', 'alignMiddle'], ['bottom', 'Bottom', 'alignBottom']].map(([k, l, ic]) => ({ label: l, icon: ic, onClick: () => ed.align(k, ed.sel.length > 1 ? 'selection' : 'artboard') })),
      ])} />
      <IconButton icon="duplicate" label={`Duplicate (${keyLabel('mod+d')})`} size={28} onClick={() => ed.duplicate()} />
      <IconButton icon="trash" label="Delete" size={28} onClick={ed.del} />
      <IconButton icon="more" label="More" size={28} onClick={(e) => openMenu(e, [
        { label: 'Group', icon: 'group', disabled: ed.sel.length < 2, onClick: ed.group }, { label: 'Ungroup', icon: 'ungroup', disabled: n.type !== 'group', onClick: ed.ungroup },
        { label: 'Flip horizontal', icon: 'flipH', onClick: () => ed.reflectSel('h') }, { label: 'Flip vertical', icon: 'flipV', onClick: () => ed.reflectSel('v') },
        { label: 'Drop shadow', icon: 'fx', onClick: () => ed.setProps((x) => ({ effects: (x.effects || []).some((e) => e.type === 'shadow' && e.on !== false) ? [] : [{ type: 'shadow', x: 0, y: 10, blur: 24, color: '#00000055', on: true }] }), 'Shadow') },
        { label: 'Lock', icon: 'lock', onClick: () => ed.setFlag('locked', true) },
      ])} />
      {pop?.kind === 'opacity' && <Popover anchor={pop.anchor} onClose={() => setPop(null)}><div className="p-3 w-56"><Slider label="Transparency" value={Math.round((n.opacity ?? 1) * 100)} min={0} max={100} unit="%" onChange={(o) => ed.setProps({ opacity: o / 100 }, 'Opacity', { merge: `op-${key}` })} onCommit={() => ed.h.commit()} /></div></Popover>}
      {pop?.kind === 'fill' && shape && <Popover anchor={pop.anchor} onClose={() => setPop(null)}><div className="p-3 w-64"><FillEditor value={shape.fill} onChange={(fl) => ed.setProps({ fill: fl }, 'Fill', { merge: `fl-${key}` })} onCommit={() => ed.h.commit()} /></div></Popover>}
      {pop?.kind === 'spacing' && f && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)}>
          <div className="p-3 w-60 flex flex-col gap-2">
            <Slider label="Letter spacing" value={f.tracking} min={-100} max={800} step={10} onChange={(t) => setTextProps({ tracking: t })} onCommit={() => ed.h.commit()} />
            <Slider label="Line spacing" value={Math.round(((f.leading || f.size * 1.2) / f.size) * 100) / 100} min={0.6} max={3} step={0.05} onChange={(l) => setTextProps({ leading: Math.round(l * f.size * 100) / 100 })} onCommit={() => ed.h.commit()} />
            <Segmented value={f.weight >= 700 ? 'bold' : 'reg'} onChange={(w) => { setTextProps({ weight: w === 'bold' ? 700 : 400 }); ed.h.commit(); }} options={[{ value: 'reg', label: 'Regular' }, { value: 'bold', label: 'Bold' }]} />
          </div>
        </Popover>
      )}
    </div>
  );
}
void find; void findNode; void I; void VIcon;
