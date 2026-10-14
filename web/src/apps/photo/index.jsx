// Photo (Sora Kōsaku) — a Photoshop-style layered image editor built on the shared raster engine (../_raster).
//
// The document lives in useHistory as immutable data (see _raster/model.js); pixels are tiled Pix objects, so each
// undo step only keeps the tiles it changed. The Renderer keeps a composite canvas up to date, the Viewport shows it,
// and tools (tools.js) paint into "materialised" canvases and commit new Pix objects when a stroke ends.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import EditorShell from '../../components/EditorShell.jsx';
import { PanelSection, Spinner, toast, toastError, openMenu, promptDialog, confirmDialog, cx } from '../../components/ui.jsx';
import { pickAssets } from '../../components/Pickers.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts, useKeyHeld, keyLabel } from '../../lib/shortcuts.js';
import { download, uploadFiles } from '../../lib/api.js';
import { appById } from '../../lib/apps.js';
import { Renderer, onRasterAsync, textLayout, fontString, layerBounds } from '../_raster/render.js';
import { Pix, makeCanvas, intersect, roundRect } from '../_raster/pix.js';
import {
  newBitmap, newGroup, newAdjust, newFill, findLayer, locate, flatten, updateLayer, removeLayers, insertLayers, moveLayer, cloneLayer, uniqueName, isPixelLayer,
} from '../_raster/model.js';
import { selAll, invert as invertSel, feather as featherSel, expand as expandSel, smooth as smoothSel, selFromAlpha, combine } from '../_raster/selection.js';
import {
  PixEdit, fillPixels, clearPixels, copyPixels, bitmapFrom, maskFrom, applyMask, rasterize, mergeDown, mergeVisible, flattenImage, resizeImage, resizeCanvas,
  cropDoc, rotateDoc, flipDoc, trimDoc, transformLayer, shiftLayer,
} from '../_raster/ops.js';
import { ADJUSTMENTS, ADJUST_ORDER, defaultsFor, applyAdjustment } from '../_raster/adjust.js';
import { FILTERS, FILTER_GROUPS, runFilter } from '../_raster/filters.js';
import { openDocument, toSaved, imageLayer } from '../_raster/io.js';
import { exportImage, exportPsd, exportLayerZip } from '../_raster/export.js';
import Viewport, { stepZoom } from '../_raster/Viewport.jsx';
import LayersPanel from '../_raster/LayersPanel.jsx';
import { IBtn } from '../_raster/icons.jsx';
import { makeTools, transformTool, sampleColor } from './tools.js';
import { ToolStrip, OptionsBar, DEFAULT_OPTS, TOOL_SLOTS } from './chrome.jsx';
import { Navigator, ColorPanel, HistoryPanel, AdjustmentsPanel, PropertiesPanel, compositeHistograms, FX_DEFAULTS, FX_LABELS } from './panels.jsx';
import { ImageSizeDialog, CanvasSizeDialog, FilterDialog, AdjustDialog, NumberDialog } from './dialogs.jsx';

const OPTS_KEY = 'sl-photo-tool-opts';
const loadOpts = () => {
  try { const o = JSON.parse(localStorage.getItem(OPTS_KEY) || '{}'); return Object.fromEntries(Object.keys(DEFAULT_OPTS).map((k) => [k, { ...DEFAULT_OPTS[k], ...(o[k] || {}) }])); } catch { return structuredClone(DEFAULT_OPTS); }
};

export default function PhotoEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null, { limit: 80 });
  const renderer = useMemo(() => new Renderer(), []);
  const [ready, setReady] = useState(false);
  const readOnly = !project.canEdit;
  const doc = h.state;

  // ---------------------------------------------------------------- open
  useEffect(() => {
    if (project.data === undefined || !project.doc) return;
    let off = false;
    openDocument(project, { background: '#ffffff', onMissing: (l) => toast(`Couldn’t load the pixels of “${l.name}”`, { type: 'error' }) })
      .then(({ doc: d }) => {
        if (off) return;
        h.reset(d);
        const top = d.layers[d.layers.length - 1];
        setActive(top?.id || null);
        setReady(true);
      }).catch((e) => toastError(e, 'Couldn’t open this image'));
    return () => { off = true; };
  }, [project.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- state
  const [activeId, setActive] = useState(null);
  const [target, setTarget] = useState('pix');
  const [tool, setToolState] = useState('brush');
  const [opts, setOpts] = useState(loadOpts);
  const [fg, setFg] = useState('#000000');
  const [bg, setBg] = useState('#ffffff');
  const [colorEditing, setColorEditing] = useState('fg');
  const [view, setView] = useState({ zoom: 0, cx: 0, cy: 0, rot: 0, flip: false });
  const [preview, setPreview] = useState(null); // a temporary doc while dragging (move, shapes, moving a selection)
  const [xform, setXform] = useState(null); // free transform tool while active
  const [, setXformTick] = useState(0);
  const [textEdit, setTextEdit] = useState(null); // { id | null, layer }
  const [dialog, setDialog] = useState(null);
  const [rulers, setRulers] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [showSel, setShowSel] = useState(true);
  const [cursorPos, setCursorPos] = useState(null);
  const [renderTick, setRenderTick] = useState(0);
  const [histo, setHisto] = useState(null);
  const vp = useRef(null);
  const spaceHeld = useKeyHeld('space');
  const lastSel = useRef(null);
  const lastFilter = useRef(null);
  const clipboard = useRef(null);

  useEffect(() => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* private mode */ } }, [opts]);
  useLayoutEffect(() => { if (doc) renderer.setDoc(doc); }, [doc, renderer]);
  useEffect(() => onRasterAsync(() => { renderer.invalidate('full'); vp.current?.draw(); }), [renderer]);
  // keep a valid active layer after undo / delete
  useEffect(() => {
    if (!doc) return;
    if (!activeId || !findLayer(doc.layers, activeId)) { const all = flatten(doc.layers); setActive(all[all.length - 1]?.id || null); }
    const l = activeId && findLayer(doc.layers, activeId);
    if (target === 'mask' && l && !l.mask) setTarget('pix');
  }, [doc, activeId, target]);
  // a cheap tick for the navigator / histograms after edits settle
  useEffect(() => { const t = setTimeout(() => setRenderTick((n) => n + 1), 300); return () => clearTimeout(t); }, [doc]);

  const active = doc && activeId ? findLayer(doc.layers, activeId) : null;
  const setOpt = useCallback((tid, patch) => setOpts((o) => ({ ...o, [tid]: { ...o[tid], ...patch } })), []);

  // ---------------------------------------------------------------- editor context for tools
  const ed = useRef({}).current;
  const commit = useCallback((d, label, o) => { if (!readOnly) h.set(d, label, o); }, [h, readOnly]);
  Object.assign(ed, {
    get doc() { return h.get(); },
    commit,
    renderer,
    get vp() { return vp.current; },
    layer: () => (ed.activeId ? findLayer(h.get().layers, ed.activeId) : null),
    activeId, target, fg, bg, readOnly,
    setActive, setFg, setBg,
    opts: (tid) => opts[tid] || {},
    toast: (m, o) => toast(m, o),
    preview: (d) => setPreview(d),
    featherSel: (s, r) => featherSel(s, r, h.get()),
    editText: (lid, draft) => startTextEdit(lid, draft),
    rasterizeActive: () => rasterizeActive(),
    fit: () => setTimeout(() => vp.current?.fit(), 0),
    onTransformChange: () => setXformTick((n) => n + 1),
  });
  const tools = useMemo(() => makeTools(ed), [ed]);
  const curTool = xform || tools[tool];

  const setTool = (t) => {
    if (xform) return;
    tools[tool]?.cancel?.();
    setToolState(t);
    if (t === 'crop') setTimeout(() => tools.crop.reset(), 0);
    const slot = TOOL_SLOTS.find((s) => s.variants?.some((v) => v.tool === t));
    if (slot) slot.lastTool = t;
  };

  // ---------------------------------------------------------------- helpers
  const sel = doc?.sel || null;
  const placeAbove = (d, layers, label, select = true) => {
    const a = activeId && findLayer(d.layers, activeId);
    const next = { ...d, layers: insertLayers(d.layers, layers, a ? { above: a.id } : null) };
    commit(next, label);
    if (select) setActive((Array.isArray(layers) ? layers[layers.length - 1] : layers).id);
    return next;
  };
  const newLayer = () => { const l = newBitmap(uniqueName(doc.layers, 'Layer')); placeAbove(doc, l, 'New Layer'); setTarget('pix'); };
  const deleteActive = () => {
    if (!active) return;
    const all = flatten(doc.layers);
    const i = all.findIndex((l) => l.id === active.id);
    commit({ ...doc, layers: removeLayers(doc.layers, [active.id]) }, 'Delete Layer');
    setActive(all[i - 1]?.id || all[i + 1]?.id || null);
  };
  const duplicate = () => {
    if (!active) return;
    if (sel && active.type === 'bitmap') { layerVia(false); return; }
    const c = cloneLayer(active); placeAbove(doc, c, 'Duplicate Layer');
  };
  /** Layer via Copy (Ctrl+J) / via Cut (Shift+Ctrl+J). */
  const layerVia = (cut) => {
    if (!active || active.type !== 'bitmap' || !sel) return;
    const cp = copyPixels(renderer, doc, { ...active, mask: null }, sel, false);
    if (!cp) return;
    let d = doc;
    if (cut) d = clearPixels(d, active, 'pix', sel);
    placeAbove(d, bitmapFrom(cp.canvas, cp.x, cp.y, uniqueName(doc.layers, `${active.name} ${cut ? 'cut' : 'copy'}`)), cut ? 'Layer via Cut' : 'Layer via Copy');
  };
  const groupActive = () => {
    if (!active) return;
    const g = newGroup([active], uniqueName(doc.layers, 'Group'));
    const loc = locate(doc.layers, active.id);
    const swap = (list) => list.map((l) => (l.id === active.id ? g : l.type === 'group' ? { ...l, children: swap(l.children) } : l));
    commit({ ...doc, layers: loc ? swap(doc.layers) : doc.layers }, 'Group Layers');
    setActive(g.id);
  };
  const ungroup = () => {
    if (active?.type !== 'group') return;
    const kids = active.children;
    const swap = (list) => list.flatMap((l) => (l.id === active.id ? kids : l.type === 'group' ? [{ ...l, children: swap(l.children) }] : [l]));
    commit({ ...doc, layers: swap(doc.layers) }, 'Ungroup Layers');
    setActive(kids[kids.length - 1]?.id || null);
  };
  const rasterizeActive = () => {
    const l = ed.layer(); if (!l || l.type === 'bitmap' || l.type === 'adjust') return;
    const d = h.get();
    commit(updateLayer(d, l.id, () => rasterize(renderer, d, l)), 'Rasterize Layer');
  };
  const addAdjustment = (kind) => {
    const l = newAdjust(defaultsFor(kind), ADJUSTMENTS[kind].label);
    l.mask = sel ? maskFrom(doc, l, sel) : { pix: Pix.empty(), enabled: true, inverted: false, x: 0, y: 0 };
    placeAbove(doc, l, `New ${ADJUSTMENTS[kind].label} Layer`);
    setTarget('pix');
  };
  const addFill = (kind) => {
    const l = newFill(kind === 'gradient' ? { kind: 'gradient', type: 'linear', colors: [fg, `${fg}00`], angle: 90 } : { kind: 'solid', color: fg });
    l.mask = sel ? maskFrom(doc, l, sel) : { pix: Pix.empty(), enabled: true, inverted: false, x: 0, y: 0 };
    placeAbove(doc, l, 'New Fill Layer');
  };
  const addMask = (mode = 'reveal') => {
    if (!active) return;
    if (active.mask) { setTarget('mask'); return; }
    const hide = mode === 'hide' || mode === 'hideSel';
    const m = maskFrom(doc, active, (mode === 'revealSel' || mode === 'hideSel') ? sel : (mode === 'reveal' && sel ? sel : null), hide);
    commit(updateLayer(doc, active.id, { mask: m }), 'Add Layer Mask');
    setTarget('mask');
  };
  const arrange = (dir) => {
    if (!active) return;
    const loc = locate(doc.layers, active.id);
    const list = loc.list; const i = loc.index;
    let where = null;
    if (dir === 'up' && i < list.length - 1) where = { above: list[i + 1].id };
    if (dir === 'down' && i > 0) where = { below: list[i - 1].id };
    if (dir === 'top' && i < list.length - 1) where = { above: list[list.length - 1].id };
    if (dir === 'bottom' && i > 0) where = { below: list[0].id };
    if (where) commit({ ...doc, layers: moveLayer(doc.layers, active.id, where) }, 'Arrange');
  };
  const setSel = (s, label) => { if (doc.sel) lastSel.current = doc.sel; commit({ ...doc, sel: s }, label); };

  const fillWith = (color) => {
    const l = active;
    if (!l) return;
    // on a mask, dark fills hide and light fills reveal
    if (target === 'mask' && l.mask) commit(lumOf(color) < 0.5 ? fillPixels(doc, l, 'mask', '#000000', sel) : fillPixels(doc, l, 'mask', '#000000', sel, { op: 'destination-out' }), 'Fill');
    else if (l.type === 'bitmap') commit(fillPixels(doc, l, 'pix', color, sel), 'Fill');
    else toast('Fill works on pixel layers — rasterize this layer first');
  };
  const clearSel = () => {
    if (!active) return;
    if (target === 'mask' && active.mask) { commit(clearPixels(doc, active, 'mask', sel), 'Clear'); return; }
    if (active.type !== 'bitmap') { if (!sel) deleteActive(); return; }
    if (!sel) { deleteActive(); return; }
    commit(clearPixels(doc, active, 'pix', sel), 'Clear');
  };

  // ---------------------------------------------------------------- copy / paste / place
  const copy = async (merged = false, cut = false) => {
    if (!active && !merged) return;
    const cp = copyPixels(renderer, doc, active, sel, merged);
    if (!cp) return;
    clipboard.current = { ...cp, at: Date.now() };
    try {
      const blob = await new Promise((r) => cp.canvas.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      clipboard.current.sys = true;
    } catch { /* clipboard not allowed: the internal copy still works */ }
    if (cut && active?.type === 'bitmap') commit(clearPixels(doc, active, 'pix', sel), 'Cut');
    toast(cut ? 'Cut' : merged ? 'Copied merged' : 'Copied');
  };
  const pasteCanvas = (canvas, name = 'Pasted', at = null) => {
    const d = h.get();
    const x = at ? at.x - canvas.width / 2 : (sel ? sel.x + sel.w / 2 : d.width / 2) - canvas.width / 2;
    const y = at ? at.y - canvas.height / 2 : (sel ? sel.y + sel.h / 2 : d.height / 2) - canvas.height / 2;
    placeAbove(d, bitmapFrom(canvas, x, y, uniqueName(d.layers, name)), 'Paste');
    setTarget('pix');
  };
  const pasteInternal = () => { const c = clipboard.current; if (c) pasteCanvas(c.canvas, 'Layer', { x: c.x + c.canvas.width / 2, y: c.y + c.canvas.height / 2 }); };
  useEffect(() => {
    const onPaste = async (e) => {
      if (readOnly || !ready || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
      const file = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
      e.preventDefault();
      if (file) {
        try {
          const bmp = await createImageBitmap(file);
          const c = makeCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
          // our own copy comes back via the system clipboard: put it where it was
          const own = clipboard.current?.sys && clipboard.current.canvas.width === c.width && clipboard.current.canvas.height === c.height;
          if (own) pasteInternal(); else pasteCanvas(c, 'Pasted image');
        } catch (err) { toastError(err, 'Couldn’t paste that image'); }
      } else if (clipboard.current) pasteInternal();
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });
  const placeFiles = async (files, at) => {
    for (const f of files) {
      try {
        const bmp = await createImageBitmap(f);
        const d = h.get();
        let w = bmp.width; let hh = bmp.height;
        if (w > d.width || hh > d.height) { const s = Math.min(d.width / w, d.height / hh); w = Math.round(w * s); hh = Math.round(hh * s); }
        const c = makeCanvas(w, hh); const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, w, hh);
        pasteCanvas(c, f.name.replace(/\.[^.]+$/, ''), at);
      } catch {
        // formats the browser can't decode (HEIC, RAW…) go through the server's converter
        try { const [a] = await uploadFiles([f], { docId: id }); const { layer } = await imageLayer(a, h.get().width, h.get().height); placeAbove(h.get(), layer, 'Place'); }
        catch (e) { toastError(e, `Couldn’t place ${f.name}`); }
      }
    }
  };
  const place = async () => {
    const assets = await pickAssets({ kinds: ['image'], docId: id, title: 'Place images' });
    if (!assets?.length) return;
    let d = h.get(); let last = null;
    for (const a of assets) {
      try { const { layer } = await imageLayer(a, d.width, d.height); d = { ...d, layers: insertLayers(d.layers, layer, (last || active) ? { above: (last || active).id } : null) }; last = layer; }
      catch (e) { toastError(e, `Couldn’t place ${a.name}`); }
    }
    if (last) { commit(d, assets.length > 1 ? 'Place images' : 'Place'); setActive(last.id); setTimeout(() => startTransform(last.id), 50); }
  };

  // ---------------------------------------------------------------- free transform
  const startTransform = (lid = activeId) => {
    const d = h.get(); const l = lid && findLayer(d.layers, lid);
    if (!l || readOnly) return;
    if (l.locked) { toast('This layer is locked'); return; }
    if (l.type === 'adjust' || l.type === 'fill') { toast('Nothing to transform on this layer'); return; }
    tools[tool]?.cancel?.();
    const t = transformTool(ed, l, { onEnd: () => setXform(null) });
    setXform(t);
  };
  const flipLayerQuick = (axis) => {
    if (!active) return;
    const b = layerBounds(active, doc) || { x: 0, y: 0, w: doc.width, h: doc.height };
    const cx = b.x + b.w / 2; const cy = b.y + b.h / 2;
    const m = new DOMMatrix().translate(cx, cy).scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1).translate(-cx, -cy);
    commit(updateLayer(doc, active.id, () => transformLayer(active, m)), axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical');
  };
  const rotateLayerQuick = (deg) => {
    if (!active) return;
    const b = layerBounds(active, doc) || { x: 0, y: 0, w: doc.width, h: doc.height };
    const cx = b.x + b.w / 2; const cy = b.y + b.h / 2;
    commit(updateLayer(doc, active.id, () => transformLayer(active, new DOMMatrix().translate(cx, cy).rotate(deg).translate(-cx, -cy))), `Rotate ${deg}°`);
  };

  // ---------------------------------------------------------------- text editing on canvas
  const startTextEdit = (lid, draft) => {
    const d = h.get();
    const l = draft || findLayer(d.layers, lid);
    if (!l) return;
    if (lid) renderer.overrides.set(lid, { draw() {} });
    renderer.invalidate('full');
    setTextEdit({ id: lid, layer: { ...l }, at: Date.now() });
  };
  const endTextEdit = (save = true) => {
    const te = textEdit; if (!te) return;
    setTextEdit(null);
    if (te.id) { renderer.overrides.delete(te.id); renderer.invalidate('full'); }
    if (!save) return;
    const d = h.get();
    const text = te.layer.text;
    const name = text.split('\n')[0].slice(0, 30) || 'Text';
    if (te.id) {
      const cur = findLayer(d.layers, te.id);
      if (cur && cur.text !== text) commit(updateLayer(d, te.id, { text, name }), 'Edit Text');
    } else if (text.trim()) placeAbove(d, { ...te.layer, name }, 'New Text Layer');
  };

  // ---------------------------------------------------------------- filters and destructive adjustments
  const pixelJob = useRef(null);
  const openPixelDialog = (kind, fid) => {
    const l = active;
    if (!l) return;
    const tgt = target === 'mask' && l.mask ? 'mask' : 'pix';
    if (tgt === 'pix' && l.type !== 'bitmap') { toast('Filters work on pixel layers', { action: l.type !== 'adjust' && l.type !== 'group' ? { label: 'Rasterize', onClick: rasterizeActive } : undefined }); return; }
    if (l.locked) { toast('This layer is locked'); return; }
    const e = new PixEdit(doc, l, tgt);
    const lb = tgt === 'pix' ? layerBounds({ ...l, fx: null, mask: null }, doc) : { x: 0, y: 0, w: doc.width, h: doc.height };
    const r = intersect(roundRect(sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : lb || { x: 0, y: 0, w: 0, h: 0 }), { x: 0, y: 0, w: doc.width, h: doc.height });
    if (!r) { toast('This layer is empty'); return; }
    const src = e.read(r);
    pixelJob.current = { e, r, src, seq: 0, busy: false };
    setHisto(compositeHistograms(renderer));
    setDialog({ kind, fid, target: sel ? 'Selection' : `Layer “${l.name}”` });
  };
  const runPixel = async (params, apply) => {
    const job = pixelJob.current; if (!job) return;
    const seq = ++job.seq;
    if (!params) { renderer.invalidate(job.e.cancel()); return; }
    const copy = new ImageData(new Uint8ClampedArray(job.src.data), job.r.w, job.r.h);
    let out;
    if (dialog?.kind === 'filter') { setDialog((d) => d && { ...d, busy: true }); out = await runFilter(dialog.fid, copy, params); setDialog((d) => d && { ...d, busy: false }); }
    else { applyAdjustment(copy.data, params); out = copy; }
    if (seq !== job.seq || pixelJob.current !== job) return;
    renderer.invalidate(job.e.put(job.r, out, sel));
    if (apply) {
      commit(job.e.commit(h.get()), dialog.kind === 'filter' ? FILTERS[dialog.fid].label.replace('…', '') : ADJUSTMENTS[dialog.fid].label);
      if (dialog.kind === 'filter') lastFilter.current = { fid: dialog.fid, params };
      pixelJob.current = null; setDialog(null);
    }
  };
  const closePixelDialog = () => { const job = pixelJob.current; if (job) renderer.invalidate(job.e.cancel()); pixelJob.current = null; setDialog(null); };
  const repeatFilter = async () => {
    const lf = lastFilter.current; if (!lf) return;
    openPixelDialog('filter', lf.fid);
    setTimeout(async () => {
      const job = pixelJob.current; if (!job) return;
      const out = await runFilter(lf.fid, new ImageData(new Uint8ClampedArray(job.src.data), job.r.w, job.r.h), lf.params);
      renderer.invalidate(job.e.put(job.r, out, h.get().sel));
      commit(job.e.commit(h.get()), FILTERS[lf.fid].label.replace('…', ''));
      pixelJob.current = null; setDialog(null);
    }, 0);
  };

  // ---------------------------------------------------------------- export & save
  const getData = useCallback(async () => {
    const d = h.get();
    if (!d) return null;
    const data = await toSaved(d, id);
    renderer.flush();
    return { data, thumb: renderer.canvas, width: d.width, height: d.height };
  }, [h, id, renderer]);
  const exportConfig = useMemo(() => ({
    formats: [
      { id: 'png', label: 'PNG', ext: 'png', kind: 'image', options: [{ key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[0.25, '25%'], [0.5, '50%'], [1, '100%'], [2, '200%']] }] },
      { id: 'jpeg', label: 'JPEG', ext: 'jpg', kind: 'image', options: [{ key: 'quality', label: 'Quality', type: 'range', default: 90, min: 10, max: 100, unit: '%' }, { key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[0.25, '25%'], [0.5, '50%'], [1, '100%'], [2, '200%']] }] },
      { id: 'webp', label: 'WebP', ext: 'webp', kind: 'image', options: [{ key: 'quality', label: 'Quality', type: 'range', default: 90, min: 10, max: 100, unit: '%' }, { key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[0.5, '50%'], [1, '100%'], [2, '200%']] }] },
      { id: 'psd', label: 'Photoshop (PSD, layered)', ext: 'psd', kind: 'image', note: 'Each top-level layer becomes a pixel layer (text, shapes and groups are flattened into pixels; adjustment layers are left out). The merged image is included.' },
      { id: 'zip', label: 'Layers as PNG files (ZIP)', ext: 'zip', kind: 'image', note: 'One PNG per top-level layer at full canvas size, plus the flattened image.' },
    ],
    render: async (fmt, o, { onProgress }) => {
      const d = h.get();
      if (fmt === 'psd') return exportPsd(renderer, d, { onProgress });
      if (fmt === 'zip') return exportLayerZip(renderer, d, { onProgress });
      return exportImage(renderer, d, fmt, { scale: o.scale || 1, quality: (o.quality || 90) / 100 });
    },
  }), [h, renderer]);
  const quickExport = async () => {
    try { download(await exportImage(renderer, h.get(), 'png'), `${project.doc?.name || 'Image'}.png`); toast('Exported PNG', { type: 'success' }); } catch (e) { toastError(e); }
  };

  // ---------------------------------------------------------------- selection commands
  const selCmd = {
    all: () => setSel(selAll(doc), 'Select All'),
    none: () => { if (doc.sel) setSel(null, 'Deselect'); },
    reselect: () => { if (lastSel.current) commit({ ...doc, sel: lastSel.current }, 'Reselect'); },
    inverse: () => setSel(invertSel(doc.sel, doc), 'Inverse'),
    fromLayer: (l = active) => {
      if (!l) return;
      const r = { x: 0, y: 0, w: doc.width, h: doc.height };
      const c = makeCanvas(doc.width, doc.height); const ctx = c.getContext('2d');
      renderer.drawContent(ctx, l, 0, 0, r); renderer.applyMask(ctx, l, 0, 0, r);
      setSel(selFromAlpha(doc, c, 0, 0), 'Load Selection');
    },
    modify: (kind) => {
      if (!doc.sel) return;
      const meta = { feather: ['Feather Selection', 'Feather radius', 10], expand: ['Expand Selection', 'Expand by', 5], contract: ['Contract Selection', 'Contract by', 5], smooth: ['Smooth Selection', 'Sample radius', 3], border: ['Border Selection', 'Width', 8] }[kind];
      setDialog({ kind: 'number', title: meta[0], label: meta[1], value: meta[2], apply: (v) => {
        const d = h.get(); let s = d.sel;
        if (kind === 'feather') s = featherSel(s, v, d);
        if (kind === 'expand') s = expandSel(s, v, d);
        if (kind === 'contract') s = expandSel(s, -v, d);
        if (kind === 'smooth') s = smoothSel(s, v, d);
        if (kind === 'border') s = combine(expandSel(s, Math.ceil(v / 2), d), expandSel(s, -Math.floor(v / 2), d), 'subtract');
        commit({ ...d, sel: s }, meta[0].split(' ')[0]);
      } });
    },
  };

  // ---------------------------------------------------------------- menus
  const can = !readOnly && !!doc;
  const menus = [
    { label: 'Image', items: () => [
      { label: 'Mode', items: [{ label: 'RGB Color, 8 bits/channel', checked: true }, { label: 'Other modes aren’t available — Photo works in RGB', disabled: true }] },
      { divider: true },
      { label: 'Adjustments', disabled: !can, items: ADJUST_ORDER.map((k) => ({ label: ADJUSTMENTS[k].label, icon: ADJUSTMENTS[k].icon, onClick: () => openPixelDialog('adjust', k), shortcut: { levels: keyLabel('mod+l'), curves: keyLabel('mod+m'), hueSat: keyLabel('mod+u'), invert: keyLabel('mod+i') }[k] })) },
      { label: 'Desaturate', shortcut: keyLabel('shift+mod+u'), disabled: !can, onClick: () => quickAdjust({ kind: 'hueSat', hue: 0, saturation: -100, lightness: 0, colorize: false }, 'Desaturate') },
      { label: 'Auto Contrast', disabled: !can, onClick: () => autoContrast() },
      { divider: true },
      { label: 'Image Size…', shortcut: keyLabel('alt+mod+i'), disabled: !can, onClick: () => setDialog({ kind: 'imageSize' }) },
      { label: 'Canvas Size…', shortcut: keyLabel('alt+mod+c'), disabled: !can, onClick: () => setDialog({ kind: 'canvasSize' }) },
      { label: 'Image Rotation', disabled: !can, items: [
        { label: '180°', onClick: () => { commit(rotateDoc(renderer, doc, 180), 'Rotate Canvas 180°'); ed.fit(); } },
        { label: '90° Clockwise', onClick: () => { commit(rotateDoc(renderer, doc, 90), 'Rotate Canvas 90° CW'); ed.fit(); } },
        { label: '90° Counter Clockwise', onClick: () => { commit(rotateDoc(renderer, doc, -90), 'Rotate Canvas 90° CCW'); ed.fit(); } },
        { divider: true },
        { label: 'Flip Canvas Horizontal', onClick: () => commit(flipDoc(renderer, doc, 'h'), 'Flip Canvas Horizontal') },
        { label: 'Flip Canvas Vertical', onClick: () => commit(flipDoc(renderer, doc, 'v'), 'Flip Canvas Vertical') },
      ] },
      { label: 'Crop to Selection', disabled: !can || !sel, onClick: () => { commit(cropDoc(doc, sel, true), 'Crop'); ed.fit(); } },
      { label: 'Trim Transparent Pixels', disabled: !can, onClick: () => { const n = trimDoc(renderer, doc); if (n !== doc) { commit(n, 'Trim'); ed.fit(); } } },
      { label: 'Trim Top-Left Colour', disabled: !can, onClick: () => { const n = trimDoc(renderer, doc, 'color'); if (n !== doc) { commit(n, 'Trim'); ed.fit(); } } },
      { label: 'Reveal All', disabled: !can, onClick: () => revealAll() },
    ] },
    { label: 'Layer', items: () => [
      { label: 'New', items: [
        { label: 'Layer', icon: 'newLayer', shortcut: keyLabel('shift+mod+n'), disabled: !can, onClick: newLayer },
        { label: 'Group', icon: 'folder', disabled: !can, onClick: () => placeAbove(doc, newGroup([], uniqueName(doc.layers, 'Group')), 'New Group') },
        { label: 'Layer via Copy', shortcut: keyLabel('mod+j'), disabled: !can || !sel || active?.type !== 'bitmap', onClick: () => layerVia(false) },
        { label: 'Layer via Cut', shortcut: keyLabel('shift+mod+j'), disabled: !can || !sel || active?.type !== 'bitmap', onClick: () => layerVia(true) },
      ] },
      { label: 'Duplicate Layer', icon: 'duplicate', disabled: !can || !active, onClick: () => { const c = cloneLayer(active); placeAbove(doc, c, 'Duplicate Layer'); } },
      { label: 'Delete Layer', icon: 'trash', disabled: !can || !active, onClick: deleteActive },
      { divider: true },
      { label: 'New Fill Layer', disabled: !can, items: [{ label: 'Solid Color', onClick: () => addFill('solid') }, { label: 'Gradient', onClick: () => addFill('gradient') }] },
      { label: 'New Adjustment Layer', disabled: !can, items: ADJUST_ORDER.map((k) => ({ label: ADJUSTMENTS[k].label, icon: ADJUSTMENTS[k].icon, onClick: () => addAdjustment(k) })) },
      { label: 'Layer Style', disabled: !can || !active || active.type === 'adjust', items: Object.keys(FX_LABELS).map((k) => ({ label: FX_LABELS[k], checked: !!active?.fx?.[k]?.on, onClick: () => toggleFx(k) })) },
      { divider: true },
      { label: 'Layer Mask', disabled: !can || !active, items: [
        { label: 'Reveal All', onClick: () => addMask('revealAll'), disabled: !!active?.mask },
        { label: 'Hide All', onClick: () => addMask('hide'), disabled: !!active?.mask },
        { label: 'Reveal Selection', onClick: () => addMask('revealSel'), disabled: !!active?.mask || !sel },
        { label: 'Hide Selection', onClick: () => addMask('hideSel'), disabled: !!active?.mask || !sel },
        { divider: true },
        { label: active?.mask?.enabled === false ? 'Enable' : 'Disable', disabled: !active?.mask, onClick: () => commit(updateLayer(doc, active.id, { mask: { ...active.mask, enabled: !active.mask.enabled } }), 'Toggle Mask') },
        { label: 'Invert', disabled: !active?.mask, onClick: () => commit(updateLayer(doc, active.id, { mask: { ...active.mask, inverted: !active.mask.inverted } }), 'Invert Mask') },
        { label: 'Apply', disabled: active?.type !== 'bitmap' || !active?.mask, onClick: () => { commit(applyMask(renderer, doc, active), 'Apply Layer Mask'); setTarget('pix'); } },
        { label: 'Delete', disabled: !active?.mask, onClick: () => { commit(updateLayer(doc, active.id, { mask: null }), 'Delete Layer Mask'); setTarget('pix'); } },
      ] },
      { label: active?.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', shortcut: keyLabel('alt+mod+g'), disabled: !can || !active, onClick: toggleClip },
      { divider: true },
      { label: 'Group Layers', shortcut: keyLabel('mod+g'), disabled: !can || !active, onClick: groupActive },
      { label: 'Ungroup Layers', shortcut: keyLabel('shift+mod+g'), disabled: !can || active?.type !== 'group', onClick: ungroup },
      { label: 'Arrange', disabled: !can || !active, items: [
        { label: 'Bring to Front', shortcut: keyLabel('shift+mod+]'), onClick: () => arrange('top') },
        { label: 'Bring Forward', shortcut: keyLabel('mod+]'), onClick: () => arrange('up') },
        { label: 'Send Backward', shortcut: keyLabel('mod+['), onClick: () => arrange('down') },
        { label: 'Send to Back', shortcut: keyLabel('shift+mod+['), onClick: () => arrange('bottom') },
      ] },
      { label: 'Rasterize', disabled: !can || !active || active.type === 'bitmap' || active.type === 'adjust', onClick: rasterizeActive },
      { divider: true },
      { label: 'Merge Down', shortcut: keyLabel('mod+e'), disabled: !can || !active, onClick: () => commit(mergeDown(renderer, doc, active.id), 'Merge Down') },
      { label: 'Merge Visible', disabled: !can, onClick: () => { const n = mergeVisible(renderer, doc); commit(n, 'Merge Visible'); setActive(n.layers[n.layers.length - 1]?.id); } },
      { label: 'Flatten Image', disabled: !can, onClick: () => { const n = flattenImage(renderer, doc); commit(n, 'Flatten Image'); setActive(n.layers[0].id); } },
    ] },
    { label: 'Select', items: () => [
      { label: 'All', shortcut: keyLabel('mod+a'), onClick: selCmd.all, disabled: !can },
      { label: 'Deselect', shortcut: keyLabel('mod+d'), onClick: selCmd.none, disabled: !can || !sel },
      { label: 'Reselect', shortcut: keyLabel('shift+mod+d'), onClick: selCmd.reselect, disabled: !can || !lastSel.current },
      { label: 'Inverse', shortcut: keyLabel('shift+mod+i'), onClick: selCmd.inverse, disabled: !can },
      { divider: true },
      { label: 'Load From Layer Transparency', disabled: !can || !active, onClick: () => selCmd.fromLayer() },
      { label: 'Modify', disabled: !can || !sel, items: [
        { label: 'Border…', onClick: () => selCmd.modify('border') }, { label: 'Smooth…', onClick: () => selCmd.modify('smooth') },
        { label: 'Expand…', onClick: () => selCmd.modify('expand') }, { label: 'Contract…', onClick: () => selCmd.modify('contract') },
        { label: 'Feather…', shortcut: keyLabel('shift+f6'), onClick: () => selCmd.modify('feather') },
      ] },
      { divider: true },
      { label: 'Show Selection Edges', shortcut: keyLabel('mod+h'), checked: showSel, onClick: () => setShowSel(!showSel) },
    ] },
    { label: 'Filter', items: () => [
      { label: lastFilter.current ? `Last Filter (${FILTERS[lastFilter.current.fid].label.replace('…', '')})` : 'Last Filter', shortcut: keyLabel('alt+mod+f'), disabled: !can || !lastFilter.current, onClick: repeatFilter },
      { divider: true },
      ...FILTER_GROUPS.map((g) => ({ label: g, disabled: !can, items: Object.entries(FILTERS).filter(([, f]) => f.group === g).map(([fid, f]) => ({ label: f.label, onClick: () => (f.params.length ? openPixelDialog('filter', fid) : applyInstantFilter(fid)) })) })),
    ] },
    { label: 'View', items: () => [
      { label: 'Zoom In', shortcut: keyLabel('mod+plus'), onClick: () => vp.current?.zoomAt((z) => stepZoom(z, 1)) },
      { label: 'Zoom Out', shortcut: keyLabel('mod+-'), onClick: () => vp.current?.zoomAt((z) => stepZoom(z, -1)) },
      { label: 'Fit on Screen', shortcut: keyLabel('mod+0'), onClick: () => vp.current?.fit() },
      { label: '100%', shortcut: keyLabel('mod+1'), onClick: () => vp.current?.actual() },
      { divider: true },
      { label: 'Rulers', shortcut: keyLabel('mod+r'), checked: rulers, onClick: () => setRulers(!rulers) },
      { label: 'Guides', shortcut: keyLabel('mod+;'), checked: showGuides, onClick: () => setShowGuides(!showGuides) },
      { label: 'New Guide…', disabled: !can, onClick: newGuide },
      { label: 'Clear Guides', disabled: !can || !doc?.guides?.length, onClick: () => commit({ ...doc, guides: [] }, 'Clear Guides') },
    ] },
  ];
  const fileItems = [
    { label: 'Place…', icon: 'image', disabled: !can, onClick: place },
    { label: 'Quick Export as PNG', icon: 'download', shortcut: keyLabel('shift+alt+mod+w'), onClick: quickExport },
  ];
  const editItems = [
    { label: 'Cut', shortcut: keyLabel('mod+x'), disabled: !can, onClick: () => copy(false, true) },
    { label: 'Copy', shortcut: keyLabel('mod+c'), onClick: () => copy(false) },
    { label: 'Copy Merged', shortcut: keyLabel('shift+mod+c'), onClick: () => copy(true) },
    { label: 'Paste', shortcut: keyLabel('mod+v'), disabled: !can, onClick: async () => {
      try { const items = await navigator.clipboard.read(); const it = items.find((i) => i.types.some((t) => t.startsWith('image/'))); if (it) { const b = await it.getType(it.types.find((t) => t.startsWith('image/'))); await placeFiles([new File([b], 'Pasted.png', { type: b.type })]); return; } } catch { /* no permission */ }
      pasteInternal();
    } },
    { divider: true },
    { label: 'Fill with Foreground', shortcut: keyLabel('alt+backspace'), disabled: !can, onClick: () => fillWith(fg) },
    { label: 'Fill with Background', shortcut: keyLabel('mod+backspace'), disabled: !can, onClick: () => fillWith(bg) },
    { label: 'Clear', shortcut: keyLabel('delete'), disabled: !can, onClick: clearSel },
    { divider: true },
    { label: 'Free Transform', shortcut: keyLabel('mod+t'), disabled: !can || !active, onClick: () => startTransform() },
    { label: 'Transform', disabled: !can || !active, items: [
      { label: 'Rotate 180°', onClick: () => rotateLayerQuick(180) }, { label: 'Rotate 90° Clockwise', onClick: () => rotateLayerQuick(90) }, { label: 'Rotate 90° Counter Clockwise', onClick: () => rotateLayerQuick(-90) },
      { divider: true }, { label: 'Flip Horizontal', onClick: () => flipLayerQuick('h') }, { label: 'Flip Vertical', onClick: () => flipLayerQuick('v') },
    ] },
  ];

  function toggleClip() { if (active) commit(updateLayer(doc, active.id, { clip: !active.clip }), active.clip ? 'Release Clipping Mask' : 'Create Clipping Mask'); }
  function toggleFx(k) {
    if (!active) return;
    const fx = { ...(active.fx || {}) };
    fx[k] = fx[k]?.on ? { ...fx[k], on: false } : { ...FX_DEFAULTS[k], ...(fx[k] || {}), on: true };
    commit(updateLayer(doc, active.id, { fx }), FX_LABELS[k]);
  }
  function newGuide() {
    promptDialog({ title: 'New Guide', label: 'Position (px) — prefix with “v” for vertical, e.g. v 500', value: `v ${Math.round(doc.width / 2)}` }).then((s) => {
      if (!s) return;
      const m = /^\s*([vh])?\s*(-?\d+(\.\d+)?)/i.exec(s);
      if (!m) return;
      commit({ ...doc, guides: [...(doc.guides || []), { axis: (m[1] || 'v').toLowerCase() === 'v' ? 'x' : 'y', pos: Number(m[2]) }] }, 'New Guide');
    });
  }
  function quickAdjust(adj, label) {
    const l = active; if (!l || l.type !== 'bitmap') { toast('Choose a pixel layer'); return; }
    const e = new PixEdit(doc, l, 'pix');
    const lb = layerBounds({ ...l, fx: null, mask: null }, doc);
    const r = intersect(roundRect(sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : lb || { x: 0, y: 0, w: 0, h: 0 }), { x: 0, y: 0, w: doc.width, h: doc.height });
    if (!r) return;
    const img = e.read(r); applyAdjustment(img.data, adj);
    e.put(r, img, sel);
    commit(e.commit(doc), label);
  }
  function autoContrast() {
    const hs = compositeHistograms(renderer);
    const hh = hs?.rgb; if (!hh) return;
    const total = hh.reduce((a, b) => a + b, 0); const clip = total * 0.005;
    let lo = 0; let acc = 0; while (lo < 254 && (acc += hh[lo]) < clip) lo++;
    let hi = 255; acc = 0; while (hi > lo + 2 && (acc += hh[hi]) < clip) hi--;
    quickAdjust({ kind: 'levels', inBlack: lo, inWhite: hi, gamma: 1, outBlack: 0, outWhite: 255, channel: 'rgb' }, 'Auto Contrast');
  }
  async function applyInstantFilter(fid) {
    openPixelDialog('filter', fid);
    setTimeout(async () => {
      const job = pixelJob.current; if (!job) return;
      const out = await runFilter(fid, new ImageData(new Uint8ClampedArray(job.src.data), job.r.w, job.r.h), {});
      renderer.invalidate(job.e.put(job.r, out, h.get().sel));
      commit(job.e.commit(h.get()), FILTERS[fid].label);
      lastFilter.current = { fid, params: {} };
      pixelJob.current = null; setDialog(null);
    }, 0);
  }
  function revealAll() {
    // grow the canvas to include every layer's pixels
    let r = { x: 0, y: 0, w: doc.width, h: doc.height };
    for (const l of flatten(doc.layers)) { const b = l.type === 'bitmap' && layerBounds(l, doc); if (b) { const x = Math.min(r.x, b.x); const y = Math.min(r.y, b.y); r = { x, y, w: Math.max(r.x + r.w, b.x + b.w) - x, h: Math.max(r.y + r.h, b.y + b.h) - y }; } }
    commit(cropDoc(doc, r, false), 'Reveal All'); ed.fit();
  }

  // ---------------------------------------------------------------- keyboard
  const toolKey = (k, shift) => () => {
    const slot = TOOL_SLOTS.find((s) => s.key === k); if (!slot) return;
    if (!slot.variants) { setTool(slot.id); return; }
    const inSlot = tool === slot.id || slot.variants.some((v) => v.tool === tool);
    if (shift && inSlot) {
      // Shift+key cycles through the slot's tools
      const vs = slot.variants; const cur = vs.findIndex((v) => (v.tool ? v.tool === tool : opts[v.opt[0]]?.[v.opt[1]] === v.opt[2] && tool === slot.id));
      const nx = vs[(cur + 1) % vs.length];
      if (nx.tool) setTool(nx.tool); else { setOpt(nx.opt[0], { [nx.opt[1]]: nx.opt[2] }); setTool(slot.id); }
      return;
    }
    const last = slot.variants.find((v) => v.tool === slot.lastTool);
    setTool(last?.tool || slot.variants[0].tool || slot.id);
  };
  const brushTool = ['brush', 'pencil', 'eraser', 'clone', 'heal', 'dodge', 'blur'].includes(tool);
  const sizeStep = (dir) => { if (!brushTool) return; const s = opts[tool].size; setOpt(tool, { size: Math.max(1, Math.min(2500, Math.round(dir > 0 ? s * 1.15 + 1 : s / 1.15 - 0.5))) }); vp.current?.overlay(); };
  const nudge = (dx, dy) => () => {
    if (readOnly || !active || active.locked || tool !== 'move') return false;
    commit({ ...doc, layers: doc.layers.map(function walk(l) { return l.id === active.id ? shiftLayer(l, dx, dy) : l.type === 'group' ? { ...l, children: l.children.map(walk) } : l; }) }, 'Nudge', { merge: `nudge-${active.id}` });
    return true;
  };
  const sc = {};
  for (const s of TOOL_SLOTS) if (s.key) { sc[s.key] = toolKey(s.key, false); sc[`shift+${s.key}`] = toolKey(s.key, true); }
  Object.assign(sc, {
    '[': () => sizeStep(-1), ']': () => sizeStep(1),
    'shift+[': () => brushTool && setOpt(tool, { hardness: Math.max(0, (opts[tool].hardness ?? 0.8) - 0.25) }),
    'shift+]': () => brushTool && setOpt(tool, { hardness: Math.min(1, (opts[tool].hardness ?? 0.8) + 0.25) }),
    x: () => { setFg(bg); setBg(fg); }, d: () => { setFg('#000000'); setBg('#ffffff'); },
    'mod+t': () => startTransform(), 'mod+j': () => (sel && active?.type === 'bitmap' ? layerVia(false) : duplicate()), 'shift+mod+j': () => layerVia(true),
    'mod+g': groupActive, 'shift+mod+g': ungroup, 'mod+e': () => active && commit(mergeDown(renderer, doc, active.id), 'Merge Down'),
    'shift+mod+n': newLayer, 'mod+d': selCmd.none, 'shift+mod+d': selCmd.reselect, 'shift+mod+i': selCmd.inverse, 'mod+a': selCmd.all,
    'alt+backspace': () => fillWith(fg), 'alt+delete': () => fillWith(fg), 'mod+backspace': () => fillWith(bg), 'mod+delete': () => fillWith(bg),
    delete: clearSel, backspace: clearSel,
    'mod+c': () => copy(false), 'shift+mod+c': () => copy(true), 'mod+x': () => copy(false, true),
    'mod+0': () => vp.current?.fit(), 'mod+1': () => vp.current?.actual(), 'mod+plus': () => vp.current?.zoomAt((z) => stepZoom(z, 1)), 'mod+=': () => vp.current?.zoomAt((z) => stepZoom(z, 1)), 'mod+-': () => vp.current?.zoomAt((z) => stepZoom(z, -1)),
    'mod+r': () => setRulers((r) => !r), 'mod+;': () => setShowGuides((g) => !g), 'mod+h': () => setShowSel((s) => !s),
    'alt+mod+g': toggleClip, 'mod+]': () => arrange('up'), 'mod+[': () => arrange('down'), 'shift+mod+]': () => arrange('top'), 'shift+mod+[': () => arrange('bottom'),
    'mod+l': () => openPixelDialog('adjust', 'levels'), 'mod+m': () => openPixelDialog('adjust', 'curves'), 'mod+u': () => openPixelDialog('adjust', 'hueSat'),
    'mod+i': () => quickAdjust({ kind: 'invert' }, 'Invert'), 'shift+mod+u': () => quickAdjust({ kind: 'hueSat', hue: 0, saturation: -100, lightness: 0, colorize: false }, 'Desaturate'),
    'alt+mod+f': repeatFilter, 'alt+mod+i': () => can && setDialog({ kind: 'imageSize' }), 'alt+mod+c': () => can && setDialog({ kind: 'canvasSize' }),
    'shift+f6': () => selCmd.modify('feather'), 'shift+alt+mod+w': quickExport,
    arrowleft: nudge(-1, 0), arrowright: nudge(1, 0), arrowup: nudge(0, -1), arrowdown: nudge(0, 1),
    'shift+arrowleft': nudge(-10, 0), 'shift+arrowright': nudge(10, 0), 'shift+arrowup': nudge(0, -10), 'shift+arrowdown': nudge(0, 10),
  });
  // number keys set the brush opacity (1 = 10% … 0 = 100%), as in Photoshop
  for (let n = 0; n <= 9; n++) sc[String(n)] = () => { if (brushTool && 'opacity' in opts[tool]) setOpt(tool, { opacity: n === 0 ? 1 : n / 10 }); };
  useShortcuts(sc, [sc], { enabled: ready && !textEdit && (!dialog || dialog.kind === 'none') });
  useEffect(() => {
    const k = (e) => {
      if (textEdit || dialog || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
      if (curTool?.key?.(e)) { e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Escape') { curTool?.cancel?.(); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [curTool, textEdit, dialog]);

  // ---------------------------------------------------------------- render
  if (!ready || !doc) {
    return (
      <EditorShell app="photo" project={project} history={h}>
        <div className="h-full grid place-items-center text-fg2 text-sm"><div className="flex items-center gap-2"><Spinner />Opening…</div></div>
      </EditorShell>
    );
  }
  const vdoc = preview || doc;
  const layerMenuItems = (l) => [
    { label: 'Duplicate Layer', icon: 'duplicate', onClick: () => placeAbove(doc, cloneLayer(l), 'Duplicate Layer'), disabled: readOnly },
    { label: 'Delete Layer', icon: 'trash', onClick: deleteActive, disabled: readOnly },
    { divider: true },
    { label: l.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', onClick: toggleClip, disabled: readOnly },
    { label: 'Rasterize Layer', onClick: rasterizeActive, disabled: readOnly || l.type === 'bitmap' || l.type === 'adjust' },
    { label: 'Select Pixels', onClick: () => selCmd.fromLayer(l) },
    { label: 'Merge Down', onClick: () => commit(mergeDown(renderer, doc, l.id), 'Merge Down'), disabled: readOnly },
    { label: l.type === 'group' ? 'Ungroup' : 'Group', onClick: l.type === 'group' ? ungroup : groupActive, disabled: readOnly },
    { divider: true },
    { label: 'Free Transform', onClick: () => startTransform(l.id), disabled: readOnly },
  ];

  const textOverlay = textEdit && vp.current && (() => {
    const l = textEdit.layer;
    const t = textLayout(l);
    const z = view.zoom;
    const s = vp.current.toScreen(l.x, l.y);
    const leftOff = (t.left - l.x) * z;
    return (
      <textarea ref={(el) => { if (el && document.activeElement !== el && Date.now() - textEdit.at < 600) setTimeout(() => el.focus(), 0); }} value={l.text} spellCheck={false} placeholder="Type here"
        onChange={(e) => setTextEdit({ ...textEdit, layer: { ...l, text: e.target.value } })}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') endTextEdit(true); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) endTextEdit(true); }}
        onBlur={(e) => { if (Date.now() - textEdit.at < 600) { const el = e.currentTarget; setTimeout(() => el.focus(), 0); return; } endTextEdit(true); }}
        style={{
          position: 'absolute', left: s.x + leftOff, top: s.y, width: Math.max(40, t.w * z + l.size * z), height: t.h * z + 8,
          font: fontString(l, l.size * z), lineHeight: `${l.lineHeight * l.size * z}px`, color: l.color, textAlign: l.align,
          transform: `rotate(${l.rotation || 0}deg)`, transformOrigin: `${-leftOff}px 0`, letterSpacing: `${(l.tracking || 0) * l.size * z / 1000}px`,
          background: 'transparent', border: '1px dashed rgba(90,180,255,.9)', outline: 'none', resize: 'none', overflow: 'hidden', padding: 0, whiteSpace: 'pre', caretColor: l.color,
        }} />
    );
  })();

  const mainOffset = rulers ? 20 : 0;
  return (
    <EditorShell app="photo" project={project} history={h} getData={readOnly ? undefined : getData} exportConfig={exportConfig}
      menus={menus} fileItems={fileItems} editItems={editItems} panelWidth={292}
      commentAnchor={() => { const c = vp.current?.hover(); const p = c ? vp.current.toDoc(c.sx, c.sy) : { x: doc.width / 2, y: doc.height / 2 }; return { x: Math.round(p.x), y: Math.round(p.y) }; }}
      anchorLabel={(a) => (a?.x !== undefined ? `${a.x}, ${a.y}` : '')}
      onJumpToComment={(a) => a?.x !== undefined && setView((v) => ({ ...v, cx: a.x, cy: a.y }))}
      tools={readOnly ? <ToolStripReadOnly tool={tool} setTool={setTool} /> : <ToolStrip tool={tool} opts={opts} setTool={setTool} setOpt={setOpt} fg={fg} bg={bg} setFg={setFg} setBg={setBg} onPickColor={setColorEditing} />}
      options={readOnly ? <span className="text-xs text-fg2 px-2">View only — you can look, zoom and comment.</span> : (
        <OptionsBar tool={tool} o={opts[tool] || {}} set={(p) => setOpt(tool, p)} transform={xform} crop={tool === 'crop'} hasSel={!!sel}
          onSelectAndMask={() => openMenu({ x: 400, y: 90 }, [{ label: 'Feather…', onClick: () => selCmd.modify('feather') }, { label: 'Expand…', onClick: () => selCmd.modify('expand') }, { label: 'Contract…', onClick: () => selCmd.modify('contract') }, { label: 'Smooth…', onClick: () => selCmd.modify('smooth') }, { label: 'Border…', onClick: () => selCmd.modify('border') }])}
          onCropApply={() => tools.crop.apply()} onCropCancel={() => tools.crop.reset()} onTransformApply={() => xform?.apply()} onTransformCancel={() => xform?.cancel()} />
      )}
      status={(
        <>
          <span>{Math.round(view.zoom * 100)}%</span>
          <span>{doc.width} × {doc.height} px · RGB/8</span>
          {cursorPos && <span>X {Math.round(cursorPos.x)} · Y {Math.round(cursorPos.y)}</span>}
          {sel && <span>Selection {sel.w} × {sel.h}</span>}
          <span className="truncate">{active ? `${active.name}${target === 'mask' ? ' (mask)' : ''}` : ''}</span>
        </>
      )}
      panels={(
        <>
          <PanelSection id="ph-nav" title="Navigator" defaultOpen={false}>
            <Navigator renderer={renderer} doc={doc} view={view} onView={setView} vpSize={vp.current?.size()} version={renderTick} />
          </PanelSection>
          <PanelSection id="ph-color" title="Color & Swatches" defaultOpen={false}>
            <ColorPanel fg={fg} bg={bg} setFg={setFg} setBg={setBg} editing={colorEditing} setEditing={setColorEditing} />
          </PanelSection>
          <PanelSection id="ph-layers" title="Layers" defaultOpen>
            <div className="-mx-3 -mb-3">
              <LayersPanel doc={doc} activeId={activeId} onSelect={(lid) => { setActive(lid); }} target={target} onTarget={setTarget} commit={commit} renderer={renderer} readOnly={readOnly}
                contextItems={layerMenuItems} onLoadSelection={(l) => selCmd.fromLayer(l)} height={300}
                onNewLayer={newLayer} onNewGroup={() => placeAbove(doc, newGroup([], uniqueName(doc.layers, 'Group')), 'New Group')} onDelete={deleteActive}
                onAddMask={() => addMask('reveal')} onDuplicate={() => placeAbove(doc, cloneLayer(active), 'Duplicate Layer')}
                adjustMenu={(e) => openMenu(e, [{ label: 'Solid Color…', onClick: () => addFill('solid') }, { label: 'Gradient…', onClick: () => addFill('gradient') }, { divider: true }, ...ADJUST_ORDER.map((k) => ({ label: ADJUSTMENTS[k].label, icon: ADJUSTMENTS[k].icon, onClick: () => addAdjustment(k) }))], { side: 'top' })}
                fxMenu={(e) => openMenu(e, Object.keys(FX_LABELS).map((k) => ({ label: FX_LABELS[k], checked: !!active?.fx?.[k]?.on, onClick: () => toggleFx(k) })), { side: 'top' })} />
            </div>
          </PanelSection>
          <PanelSection id="ph-props" title="Properties" defaultOpen>
            <PropertiesPanel layer={active} doc={doc} commit={commit} readOnly={readOnly} target={target} histo={histo}
              onRasterize={rasterizeActive} onEditText={() => active && startTextEdit(active.id)}
              onApplyMask={() => { commit(applyMask(renderer, doc, active), 'Apply Layer Mask'); setTarget('pix'); }}
              onDeleteMask={() => { commit(updateLayer(doc, active.id, { mask: null }), 'Delete Layer Mask'); setTarget('pix'); }}
              onMaskFromSel={sel ? () => commit(updateLayer(doc, active.id, { mask: maskFrom(doc, active, sel) }), 'Mask from Selection') : null} />
          </PanelSection>
          <PanelSection id="ph-adj" title="Adjustments" defaultOpen={false}>
            <AdjustmentsPanel onAdd={addAdjustment} disabled={readOnly} />
          </PanelSection>
          <PanelSection id="ph-history" title="History" defaultOpen>
            <HistoryPanel h={h} />
          </PanelSection>
        </>
      )}>
      <Viewport ref={vp} renderer={renderer} doc={vdoc} view={view} onView={setView} tool={readOnly ? (tool === 'zoom' ? tools.zoom : { ...tools.hand, id: 'hand' }) : curTool} readOnly={readOnly}
        rulers={rulers} showGuides={showGuides} showSelection={showSel} spaceHeld={spaceHeld}
        onFrame={() => { const r = ed.live?.flush?.(); if (r) renderer.invalidate(r); }}
        onDropFiles={readOnly ? null : (files, at) => placeFiles(files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|tiff?|psd|dng|cr2|nef|arw)$/i.test(f.name)), at)}
        onGuidesChange={readOnly ? null : (g) => commit({ ...h.get(), guides: g }, 'Move Guide')}
        onUndo={h.undo} onRedo={h.redo}
        onContextMenu={(e, p) => !readOnly && openMenu(e, [
          ...(sel ? [{ label: 'Deselect', onClick: selCmd.none }, { label: 'Select Inverse', onClick: selCmd.inverse }, { label: 'Feather…', onClick: () => selCmd.modify('feather') }, { label: 'Layer via Copy', onClick: () => layerVia(false), disabled: active?.type !== 'bitmap' }, { label: 'Fill…', onClick: () => fillWith(fg) }, { divider: true }] : []),
          { label: 'Free Transform', onClick: () => startTransform() }, { label: 'Pick colour here', onClick: () => { const c = sampleColor(ed, p.x, p.y); if (c) setFg(c); } },
        ])} />
      <CursorTracker vp={vp} onPos={setCursorPos} />
      {textOverlay && <div className="absolute inset-0 pointer-events-none" style={{ left: mainOffset, top: mainOffset }}><div className="pointer-events-auto">{textOverlay}</div></div>}
      {dialog?.kind === 'imageSize' && <ImageSizeDialog doc={doc} onClose={() => setDialog(null)} onApply={(w, hh) => { setDialog(null); commit(resizeImage(doc, w, hh), 'Image Size'); ed.fit(); }} />}
      {dialog?.kind === 'canvasSize' && <CanvasSizeDialog doc={doc} onClose={() => setDialog(null)} onApply={(w, hh, a) => { setDialog(null); commit(resizeCanvas(doc, w, hh, a), 'Canvas Size'); ed.fit(); }} />}
      {dialog?.kind === 'filter' && <FilterDialog id={dialog.fid} busy={dialog.busy} target={dialog.target} onPreview={(p) => runPixel(p, false)} onApply={(p) => runPixel(p, true)} onClose={closePixelDialog} />}
      {dialog?.kind === 'adjust' && <AdjustDialog kind={dialog.fid} histo={histo} onPreview={(p) => runPixel(p, false)} onApply={(p) => runPixel(p, true)} onClose={closePixelDialog} />}
      {dialog?.kind === 'number' && <NumberDialog title={dialog.title} label={dialog.label} value={dialog.value} onClose={() => setDialog(null)} onApply={(v) => { const a = dialog.apply; setDialog(null); a(v); }} />}
    </EditorShell>
  );
}

const lumOf = (hex) => { const n = parseInt(hex.slice(1, 7), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };

/** Status-bar cursor position (polled lightly so mouse moves don't re-render the editor). */
function CursorTracker({ vp, onPos }) {
  useEffect(() => {
    let last = null;
    const t = setInterval(() => {
      const hv = vp.current?.hover();
      const p = hv ? vp.current.toDoc(hv.sx, hv.sy) : null;
      const key = p ? `${Math.round(p.x)},${Math.round(p.y)}` : null;
      if (key !== last) { last = key; onPos(p); }
    }, 150);
    return () => clearInterval(t);
  }, [vp, onPos]);
  return null;
}

function ToolStripReadOnly({ tool, setTool }) {
  return (
    <>
      {['hand', 'zoom'].map((t) => (
        <IBtn key={t} icon={t} label={t === 'hand' ? 'Hand' : 'Zoom'} active={tool === t} size={32} iconSize={18} onClick={() => setTool(t)} />
      ))}
    </>
  );
}
export { appById, isPixelLayer, confirmDialog };
