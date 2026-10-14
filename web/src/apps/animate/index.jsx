// Sora ANI (Animate) — an Adobe Animate-style 2D animation editor: a stage and a frame-based timeline of layers,
// vector brush/pencil/shape drawing on keyframes, paint bucket, eraser, eyedropper, onion skinning, classic and
// shape tweens with easing, movie-clip symbols with their own timelines, image import, and video/GIF/sprite export.
import { useCallback, useEffect, useRef, useState } from 'react';
import EditorShell, { Tool, ToolDivider } from '../../components/EditorShell.jsx';
import { Spinner, ColorSwatch, NumberInput, Slider, Select, Toggle, Segmented, IconButton, toast, cx } from '../../components/ui.jsx';
import { pickAssets } from '../../components/Pickers.jsx';
import { useProject } from '../../lib/doc.js';
import { useHistory } from '../../lib/history.js';
import { useShortcuts, keyLabel } from '../../lib/shortcuts.js';
import { ensureFont } from '../../lib/fonts.js';
import { renderStage, keyAt, layerElements, timelineLength, bitmapsIn, fontsIn } from '../_anim/stage.js';
import { loadImageAsset } from '../_anim/media.js';
import { exportVideo, exportGif, exportPng, exportPngSequence, exportSpriteSheet, videoSupport } from '../_anim/export.js';
import {
  fromSaved, timelineOf, withTimeline, withLayer, newLayer, insertFrames, removeFrames, insertKeyframe, clearKeyframe, setTween,
  editEls as editElsOf, makeSymbol, breakApart, uid,
} from './model.js';
import Stage from './Stage.jsx';
import Timeline from './Timeline.jsx';
import { PropertiesPanel, LibraryPanel } from './Panels.jsx';

const svg = (d) => () => <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
const OvalSvg = svg(<ellipse cx="12" cy="12" rx="8" ry="6" />);
const InkSvg = svg(<><path d="M3 17c3-4 5-9 9-9s3 6 9 2" /><path d="M3 21h18" /></>);

const TOOLS = [
  { id: 'select', label: 'Selection / Free Transform', key: 'v', icon: 'select' },
  { id: 'hand', label: 'Hand', key: 'h', icon: 'hand' },
  { id: 'zoom', label: 'Zoom', key: 'z', icon: 'zoom' },
  { divider: true },
  { id: 'brush', label: 'Brush', key: 'b', icon: 'brush', edit: true },
  { id: 'pencil', label: 'Pencil', key: 'y', Svg: InkSvg, edit: true },
  { id: 'line', label: 'Line', key: 'n', icon: 'line', edit: true },
  { id: 'rect', label: 'Rectangle', key: 'r', icon: 'rect', edit: true },
  { id: 'oval', label: 'Oval', key: 'o', Svg: OvalSvg, edit: true },
  { id: 'text', label: 'Text', key: 't', icon: 'text', edit: true },
  { divider: true },
  { id: 'bucket', label: 'Paint Bucket', key: 'k', icon: 'fill', edit: true },
  { id: 'eraser', label: 'Eraser', key: 'e', icon: 'eraser', edit: true },
  { id: 'eyedropper', label: 'Eyedropper', key: 'i', icon: 'eyedropper' },
];

let clipboard = null; // { kind: 'els' | 'frames', items }

export default function AnimateEditor({ id }) {
  const project = useProject(id);
  const h = useHistory(null);
  const canEdit = project.canEdit;
  useEffect(() => { if (project.data !== undefined && project.doc) h.reset(fromSaved(project.data, project.doc)); }, [project.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc = h.state;

  const [symId, setSymId] = useState(null);
  const tl = doc ? timelineOf(doc, symId) : null;
  const [frame, setFrameRaw] = useState(0);
  const [activeId, setActive] = useState(null);
  const [sel, setSel] = useState([]);
  const [tool, setTool] = useState('brush');
  const [opts, setOpts] = useState({ fill: '#1f1f2b', stroke: '#1f1f2b', sw: 3, brush: 10, smooth: 50, fillOn: true, strokeOn: true, radius: 0, eraser: 24, gap: 2, font: 'Inter', fontSize: 48 });
  const [onion, setOnion] = useState({ on: false, before: 2, after: 2 });
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [zoom, setZoom] = useState('fit');
  const [tlHeight, setTlHeight] = useState(230);
  const [editingText, setEditingText] = useState(null);

  const active = tl && (tl.layers.find((l) => l.id === activeId) || tl.layers[0]);
  const setFrame = useCallback((f) => { setFrameRaw(Math.max(0, f)); setSel([]); }, []);
  useEffect(() => { setSel([]); }, [activeId, symId]);
  useEffect(() => { if (!canEdit && project.doc) setTool('select'); }, [canEdit, project.doc]);

  // ---------------------------------------------------------------- editing (all through history)
  const editDocFn = useCallback((fn, label, merge) => { if (canEdit) h.set((d) => fn(d), label, merge ? { merge } : undefined); }, [canEdit, h.set]); // eslint-disable-line react-hooks/exhaustive-deps
  const editTl = useCallback((fn, label, merge) => editDocFn((d) => withTimeline(d, symId, fn), label, merge), [editDocFn, symId]);
  const editLayer = useCallback((lid, fn, label, merge) => editTl((t) => withLayer(t, lid, fn), label, merge), [editTl]);
  const editEls = useCallback((fn, label, merge, lid) => {
    const target = lid || active?.id;
    if (!target) return;
    editLayer(target, (l) => editElsOf(l, frame, fn), label, merge);
  }, [editLayer, active?.id, frame]);
  const endMerge = useCallback(() => h.commit(), [h.commit]); // eslint-disable-line react-hooks/exhaustive-deps
  const editSel = (fn, label, merge) => editEls((list) => list.map((e) => (sel.includes(e.id) ? fn(e) : e)), label, merge);
  const editKey = (fn, label, merge) => active && editLayer(active.id, (l) => { const k = keyAt(l, frame); return k ? { ...l, frames: l.frames.map((x) => (x === k ? fn(x) : x)) } : l; }, label, merge);
  const frameOp = (fn, label, lid = active?.id) => { if (canEdit && lid) editLayer(lid, (l) => fn(l, frame), label); };

  const len = tl ? timelineLength(tl) : 1;
  const fps = doc?.fps || 24;
  const els = active ? layerElements(active, frame) : [];
  const selEls = els.filter((e) => sel.includes(e.id));

  // ---------------------------------------------------------------- playback
  const playRef = useRef(null);
  const stop = useCallback(() => { if (playRef.current) cancelAnimationFrame(playRef.current); playRef.current = null; setPlaying(false); }, []);
  const play = () => {
    if (!tl) return;
    const total = timelineLength(tl);
    const start = frame >= total - 1 ? 0 : frame;
    const t0 = performance.now();
    setPlaying(true); setSel([]);
    const step = () => {
      let f = start + Math.floor(((performance.now() - t0) / 1000) * fps);
      if (f >= total) { if (!loop) { setFrameRaw(total - 1); stop(); return; } f %= total; }
      setFrameRaw(f);
      playRef.current = requestAnimationFrame(step);
    };
    playRef.current = requestAnimationFrame(step);
  };
  useEffect(() => () => stop(), [stop]);
  const togglePlay = () => (playing ? stop() : play());

  // ---------------------------------------------------------------- commands
  const addLayer = () => {
    const l = newLayer(`Layer ${tl.layers.length + 1}`, tl.layers.length);
    const i = Math.max(0, tl.layers.findIndex((x) => x.id === active?.id));
    editTl((t) => { const layers = t.layers.slice(); layers.splice(i, 0, l); return { ...t, layers }; }, 'New layer');
    setActive(l.id);
  };
  const deleteLayer = () => {
    if (tl.layers.length < 2 || !active) return;
    editTl((t) => ({ ...t, layers: t.layers.filter((l) => l.id !== active.id) }), 'Delete layer');
    setActive(null);
  };
  const moveLayer = (dir) => editTl((t) => {
    const layers = t.layers.slice(); const i = layers.findIndex((l) => l.id === active.id); const j = i + dir;
    if (j < 0 || j >= layers.length) return t;
    [layers[i], layers[j]] = [layers[j], layers[i]]; return { ...t, layers };
  }, 'Arrange layer');
  const deleteSel = () => { if (sel.length) { editEls((list) => list.filter((e) => !sel.includes(e.id)), 'Delete'); setSel([]); } };
  const copy = () => { if (selEls.length) { clipboard = { kind: 'els', items: structuredClone(selEls) }; toast(`Copied ${selEls.length} object${selEls.length > 1 ? 's' : ''}`); } };
  const paste = (inPlace) => {
    if (clipboard?.kind !== 'els') return;
    const items = clipboard.items.map((e) => ({ ...structuredClone(e), id: uid(), x: (e.x || 0) + (inPlace ? 0 : 12), y: (e.y || 0) + (inPlace ? 0 : 12) }));
    editEls((list) => [...list, ...items], 'Paste'); setSel(items.map((e) => e.id));
  };
  const duplicate = () => { if (!selEls.length) return; const items = selEls.map((e) => ({ ...structuredClone(e), id: uid(), x: (e.x || 0) + 12, y: (e.y || 0) + 12 })); editEls((list) => [...list, ...items], 'Duplicate'); setSel(items.map((e) => e.id)); };
  const arrange = (dir) => editEls((list) => {
    const picked = list.filter((e) => sel.includes(e.id)); const rest = list.filter((e) => !sel.includes(e.id));
    if (dir === 'front') return [...rest, ...picked];
    if (dir === 'back') return [...picked, ...rest];
    const out = list.slice();
    const idx = out.map((e, i) => (sel.includes(e.id) ? i : -1)).filter((i) => i >= 0);
    if (dir === 'up') for (const i of idx.reverse()) { if (i < out.length - 1 && !sel.includes(out[i + 1].id)) [out[i], out[i + 1]] = [out[i + 1], out[i]]; }
    else for (const i of idx) if (i > 0 && !sel.includes(out[i - 1].id)) [out[i], out[i - 1]] = [out[i - 1], out[i]];
    return out;
  }, 'Arrange');
  const nudge = (dx, dy) => { if (sel.length) editSel((e) => ({ ...e, x: (e.x || 0) + dx, y: (e.y || 0) + dy }), 'Nudge', `nudge-${sel.join()}`); };
  const toSymbol = () => {
    if (!selEls.length) { toast('Select something on the stage first.'); return; }
    const name = `Symbol ${doc.symbols.length + 1}`;
    const { symbol, instance } = makeSymbol(doc, selEls, name);
    editDocFn((d) => withTimeline({ ...d, symbols: [...d.symbols, symbol] }, symId, (t) => withLayer(t, active.id, (l) => editElsOf(l, frame, (list) => {
      const i = list.findIndex((e) => sel.includes(e.id));
      const out = list.filter((e) => !sel.includes(e.id)); out.splice(Math.max(0, i), 0, instance); return out;
    }))), 'Convert to symbol');
    setSel([instance.id]);
    toast(`Made “${name}” — double-click it to edit its own timeline`, { type: 'success' });
  };
  const breakSel = () => {
    const inst = selEls.find((e) => e.type === 'symbol');
    if (!inst) return;
    const parts = breakApart(doc, inst);
    editEls((list) => { const i = list.findIndex((e) => e.id === inst.id); const out = list.filter((e) => e.id !== inst.id); out.splice(i, 0, ...parts); return out; }, 'Break apart');
    setSel(parts.map((p) => p.id));
  };
  const editSymbol = (sid) => { stop(); setSymId(sid); setFrameRaw(0); setActive(null); setSel([]); };
  useEffect(() => {
    const f = (e) => editSymbol(e.detail);
    window.addEventListener('sl-edit-symbol', f);
    return () => window.removeEventListener('sl-edit-symbol', f);
  });
  const placeFromLibrary = ({ symbol, bitmap }) => {
    const c = symId ? [0, 0] : [doc.width / 2, doc.height / 2];
    if (symbol) {
      if (symbol === symId) { toast('A symbol can’t contain itself.', { type: 'error' }); return; }
      const inst = { id: uid(), type: 'symbol', symbol, x: c[0], y: c[1], sx: 1, sy: 1, r: 0, alpha: 1, loop: 'loop', first: 0 };
      editEls((list) => [...list, inst], 'Place symbol'); setSel([inst.id]);
    } else if (bitmap) {
      const s = Math.min(1, (doc.width * 0.8) / bitmap.w, (doc.height * 0.8) / bitmap.h);
      const el = { id: uid(), type: 'bitmap', asset: bitmap.id, w: bitmap.w, h: bitmap.h, x: c[0] - (bitmap.w * s) / 2, y: c[1] - (bitmap.h * s) / 2, sx: s, sy: s, r: 0, alpha: 1 };
      editEls((list) => [...list, el], 'Place bitmap'); setSel([el.id]);
    }
  };
  const importImages = async (asSequence) => {
    const list = await pickAssets({ kinds: ['image'], docId: id, title: asSequence ? 'Import image sequence' : 'Import to stage' });
    if (!list?.length) return;
    const bitmaps = list.map((a) => ({ id: a.id, name: a.name, w: a.width || 512, h: a.height || 512 }));
    const sorted = asSequence ? bitmaps.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : bitmaps;
    await Promise.all(sorted.map((b) => loadImageAsset(b.id)));
    if (!asSequence) {
      editDocFn((d) => ({ ...d, library: [...d.library, ...bitmaps.filter((b) => !d.library.some((x) => x.id === b.id))] }), 'Import');
      for (const b of bitmaps) placeFromLibrary({ bitmap: b });
      return;
    }
    // one image per frame on a new layer, starting at the playhead
    const s = Math.min(1, doc.width / sorted[0].w, doc.height / sorted[0].h);
    const layer = { ...newLayer(`Sequence ${tl.layers.length + 1}`, tl.layers.length), frames: [] };
    if (frame > 0) layer.frames.push({ i: 0, len: frame, els: [] });
    sorted.forEach((b, i) => layer.frames.push({ i: frame + i, len: 1, els: [{ id: uid(), type: 'bitmap', asset: b.id, w: b.w, h: b.h, x: (doc.width - b.w * s) / 2, y: (doc.height - b.h * s) / 2, sx: s, sy: s, r: 0, alpha: 1 }] }));
    editDocFn((d) => withTimeline({ ...d, library: [...d.library, ...bitmaps.filter((b) => !d.library.some((x) => x.id === b.id))] }, symId, (t) => ({ ...t, layers: [layer, ...t.layers] })), 'Import sequence');
    setActive(layer.id);
    toast(`Imported ${sorted.length} images as frames`, { type: 'success' });
  };
  const copyFrames = () => { const k = active && keyAt(active, frame); if (k) { clipboard = { kind: 'frames', items: structuredClone(layerElements(active, frame)) }; toast('Copied frame'); } };
  const pasteFrames = () => {
    if (clipboard?.kind !== 'frames') return;
    const items = clipboard.items;
    frameOp((l, f) => { const withKey = insertKeyframe(l, f, true); return { ...withKey, frames: withKey.frames.map((k) => (k.i === f ? { ...k, els: structuredClone(items) } : k)) }; }, 'Paste frames');
  };

  const frameMenu = (layer, f) => {
    const k = keyAt(layer, f);
    const op = (fn, label) => () => editLayer(layer.id, (l) => fn(l, f), label);
    const dis = !canEdit || layer.locked;
    return [
      { label: 'Create Classic Tween', icon: 'tween', disabled: dis || !k, onClick: op((l, ff) => setTween(l, ff, 'motion'), 'Create classic tween') },
      { label: 'Create Shape Tween', icon: 'tween', disabled: dis || !k, onClick: op((l, ff) => setTween(l, ff, 'shape'), 'Create shape tween') },
      { label: 'Remove Tween', disabled: dis || !k?.tween, onClick: op((l, ff) => setTween(l, ff, null), 'Remove tween') },
      { divider: true },
      { label: 'Insert Frame', shortcut: 'F5', disabled: dis, onClick: op(insertFrames, 'Insert frame') },
      { label: 'Remove Frames', shortcut: keyLabel('shift+f5'), disabled: dis || !k, onClick: op(removeFrames, 'Remove frame') },
      { label: 'Insert Keyframe', shortcut: 'F6', disabled: dis, onClick: op((l, ff) => insertKeyframe(l, ff), 'Insert keyframe') },
      { label: 'Insert Blank Keyframe', shortcut: 'F7', disabled: dis, onClick: op((l, ff) => insertKeyframe(l, ff, true), 'Insert blank keyframe') },
      { label: 'Clear Keyframe', shortcut: keyLabel('shift+f6'), disabled: dis || k?.i !== f, onClick: op(clearKeyframe, 'Clear keyframe') },
      { divider: true },
      { label: 'Copy Frames', shortcut: keyLabel('alt+mod+c'), disabled: !k, onClick: copyFrames },
      { label: 'Paste Frames', shortcut: keyLabel('alt+mod+v'), disabled: dis || clipboard?.kind !== 'frames', onClick: pasteFrames },
    ];
  };
  const layerMenu = (layer) => [
    { label: 'New layer', icon: 'plus', disabled: !canEdit, onClick: addLayer },
    { label: 'Delete layer', icon: 'trash', disabled: !canEdit || tl.layers.length < 2, onClick: deleteLayer },
    { divider: true },
    { label: 'Move up', disabled: !canEdit, onClick: () => moveLayer(-1) },
    { label: 'Move down', disabled: !canEdit, onClick: () => moveLayer(1) },
    { label: 'Guide layer (not exported)', checked: !!layer.guide, disabled: !canEdit, onClick: () => editLayer(layer.id, (l) => ({ ...l, guide: !l.guide }), 'Guide layer') },
    { label: 'Duplicate layer', disabled: !canEdit, onClick: () => editTl((t) => { const i = t.layers.findIndex((l) => l.id === layer.id); const c = { ...structuredClone(layer), id: uid('L'), name: `${layer.name} copy` }; const layers = t.layers.slice(); layers.splice(i, 0, c); return { ...t, layers }; }, 'Duplicate layer') },
  ];

  // ---------------------------------------------------------------- export
  const prepare = async (d) => {
    const all = [d.scene, ...d.symbols.map((s) => s.timeline)];
    await Promise.all(all.flatMap((t) => [...bitmapsIn(d, t)].map((a) => loadImageAsset(a))));
    await Promise.all(all.flatMap((t) => [...fontsIn(d, t).values()].map((f) => ensureFont(f.family, f.weight))));
  };
  const [mp4Note, setMp4Note] = useState('');
  useEffect(() => { videoSupport().then((s) => setMp4Note(s.h264 ? '' : 'No H.264 encoder in this browser — the MP4 uses VP9 video.')); }, []);
  const exportConfig = doc && {
    formats: [
      { id: 'webm', label: 'WebM video', ext: 'webm', kind: 'video', options: [{ key: 'loops', label: 'Repeat', type: 'select', default: 1, choices: [[1, 'Once'], [2, '2×'], [3, '3×'], [5, '5×']] }] },
      { id: 'mp4', label: 'MP4 video', ext: 'mp4', kind: 'video', note: mp4Note, options: [{ key: 'loops', label: 'Repeat', type: 'select', default: 1, choices: [[1, 'Once'], [2, '2×'], [3, '3×'], [5, '5×']] }] },
      { id: 'gif', label: 'Animated GIF', ext: 'gif', kind: 'image', options: [{ key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[1, '100%'], [0.5, '50%'], [0.25, '25%']] }, { key: 'transparent', label: 'Transparent background', type: 'toggle', default: false }, { key: 'loop', label: 'Loop forever', type: 'toggle', default: true }] },
      { id: 'sprite', label: 'Sprite sheet (PNG + JSON, zipped)', ext: 'zip', kind: 'image', options: [{ key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[1, '100%'], [0.5, '50%'], [0.25, '25%']] }, { key: 'cols', label: 'Columns (0 = auto)', type: 'number', default: 0, min: 0, max: 64 }, { key: 'transparent', label: 'Transparent background', type: 'toggle', default: true }] },
      { id: 'pngseq', label: 'PNG sequence (ZIP)', ext: 'zip', kind: 'image', options: [{ key: 'transparent', label: 'Transparent background', type: 'toggle', default: false }] },
      { id: 'png', label: 'PNG (current frame)', ext: 'png', kind: 'image', options: [{ key: 'transparent', label: 'Transparent background', type: 'toggle', default: false }] },
    ],
    render: async (fid, o, { onProgress }) => {
      stop();
      const d = h.get();
      await prepare(d);
      const n = timelineLength(d.scene);
      const draw = (transparent) => async (ctx, t) => renderStage(d, Math.round(t * d.fps) % n, ctx, { transparent, scale: ctx.canvas.width / d.width });
      const base = { width: d.width, height: d.height, fps: d.fps, start: 0, duration: n / d.fps, onProgress };
      if (fid === 'webm' || fid === 'mp4') return exportVideo({ ...base, duration: (n * (o.loops || 1)) / d.fps, container: fid, draw: draw(false) });
      if (fid === 'gif') return exportGif({ ...base, scale: o.scale, loop: o.loop, transparent: o.transparent, draw: draw(o.transparent) });
      if (fid === 'sprite') return exportSpriteSheet({ ...base, scale: o.scale, cols: o.cols, name: (project.doc.name || 'sheet').replace(/\W+/g, '_'), draw: draw(o.transparent) });
      if (fid === 'pngseq') return exportPngSequence({ ...base, name: 'frame', draw: draw(o.transparent) });
      return exportPng({ width: d.width, height: d.height, t: (symId ? 0 : frame) / d.fps, draw: draw(o.transparent) });
    },
  };

  const getData = useCallback(async () => {
    const d = h.get();
    if (!d) return null;
    const s = Math.min(1, 640 / d.width);
    const canvas = document.createElement('canvas'); canvas.width = Math.round(d.width * s); canvas.height = Math.round(d.height * s);
    try { await prepare(d); renderStage(d, symId ? 0 : Math.min(frame, timelineLength(d.scene) - 1), canvas.getContext('2d'), { scale: s }); } catch { /* thumbnail is optional */ }
    const n = timelineLength(d.scene);
    return { data: d, thumb: canvas, width: d.width, height: d.height, duration: n / d.fps, meta: { fps: d.fps, frames: n } };
  }, [h, frame, symId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- shortcuts
  const E = (f) => () => { if (canEdit) f(); };
  const toolKeys = Object.fromEntries(TOOLS.filter((t) => t.key).map((t) => [t.key, () => { if (t.edit && !canEdit) return; setTool(t.id); }]));
  useShortcuts(doc ? {
    ...toolKeys, q: () => setTool('select'),
    enter: togglePlay, ',': () => setFrame(frame - 1), '.': () => setFrame(frame + 1), home: () => setFrame(0), end: () => setFrame(len - 1),
    f5: E(() => frameOp(insertFrames, 'Insert frame')), 'shift+f5': E(() => frameOp(removeFrames, 'Remove frame')),
    f6: E(() => { frameOp((l, f) => insertKeyframe(l, f), 'Insert keyframe'); }), f7: E(() => frameOp((l, f) => insertKeyframe(l, f, true), 'Insert blank keyframe')),
    'shift+f6': E(() => frameOp(clearKeyframe, 'Clear keyframe')),
    f8: E(toSymbol), 'mod+b': E(breakSel), 'mod+e': () => { const inst = selEls.find((e) => e.type === 'symbol'); if (inst) editSymbol(inst.symbol); else if (symId) setSymId(null); },
    delete: E(deleteSel), backspace: E(deleteSel), 'mod+c': copy, 'mod+x': E(() => { copy(); deleteSel(); }), 'mod+v': E(() => paste(false)), 'shift+mod+v': E(() => paste(true)), 'mod+d': E(duplicate),
    'alt+mod+c': copyFrames, 'alt+mod+v': E(pasteFrames),
    'mod+a': () => setSel(els.map((e) => e.id)), escape: () => { if (sel.length) setSel([]); else if (symId) setSymId(null); },
    arrowleft: E(() => nudge(-1, 0)), arrowright: E(() => nudge(1, 0)), arrowup: E(() => nudge(0, -1)), arrowdown: E(() => nudge(0, 1)),
    'shift+arrowleft': E(() => nudge(-10, 0)), 'shift+arrowright': E(() => nudge(10, 0)), 'shift+arrowup': E(() => nudge(0, -10)), 'shift+arrowdown': E(() => nudge(0, 10)),
    'mod+arrowup': E(() => arrange('up')), 'mod+arrowdown': E(() => arrange('down')), 'shift+mod+arrowup': E(() => arrange('front')), 'shift+mod+arrowdown': E(() => arrange('back')),
    'shift+alt+o': () => setOnion((o) => ({ ...o, on: !o.on })), 'mod+r': E(() => importImages(false)),
    'mod+1': () => setZoom(1), 'mod+0': () => setZoom('fit'), 'mod+=': () => setZoom((z) => Math.min(32, (z === 'fit' ? 1 : z) * 1.5)), 'mod+-': () => setZoom((z) => Math.max(0.05, (z === 'fit' ? 1 : z) / 1.5)),
  } : {}, [doc, frame, sel, active, tool, canEdit, playing, symId, len]);

  if (!doc || !tl) return <EditorShell app="animate" project={project} history={h}><div className="h-full grid place-items-center"><Spinner size={28} /></div></EditorShell>;

  const tools = TOOLS.map((t, i) => (t.divider ? <ToolDivider key={i} /> : (
    <Tool key={t.id} icon={t.icon} label={t.label} shortcut={t.key} active={tool === t.id} onClick={() => { if (t.edit && !canEdit) return; setTool(t.id); }}>{t.Svg ? <t.Svg /> : null}</Tool>
  )));
  tools.push(<ToolDivider key="d9" />);
  tools.push(
    <div key="colors" className="flex flex-col items-center gap-1 mt-1" title="Stroke and fill colours">
      <ColorSwatch value={opts.stroke} onChange={(c) => setOpts((o) => ({ ...o, stroke: c }))} size={22} title="Stroke colour" />
      <ColorSwatch value={opts.fill} onChange={(c) => setOpts((o) => ({ ...o, fill: c }))} size={22} title="Fill colour" />
    </div>,
  );

  const o = (patch) => setOpts((x) => ({ ...x, ...patch }));
  const toolOptions = {
    brush: <><span className="text-xs text-fg2">Brush size</span><Slider className="w-40" showNumber={false} value={opts.brush} min={1} max={120} onChange={(v) => o({ brush: v })} /><NumberInput value={opts.brush} min={1} max={120} width={48} onChange={(v) => o({ brush: v })} /><span className="text-xs text-fg2 ml-2">Smoothing</span><Slider className="w-28" showNumber={false} value={opts.smooth} min={0} max={100} onChange={(v) => o({ smooth: v })} /><NumberInput value={opts.smooth} min={0} max={100} width={48} onChange={(v) => o({ smooth: v })} /><span className="text-[11px] text-fg3">Uses the fill colour</span></>,
    pencil: <><span className="text-xs text-fg2">Stroke</span><NumberInput value={opts.sw} min={0.5} max={60} step={0.5} unit="px" width={56} onChange={(v) => o({ sw: v })} /><span className="text-xs text-fg2 ml-2">Smoothing</span><Slider className="w-28" showNumber={false} value={opts.smooth} min={0} max={100} onChange={(v) => o({ smooth: v })} /><NumberInput value={opts.smooth} min={0} max={100} width={48} onChange={(v) => o({ smooth: v })} /></>,
    line: <><span className="text-xs text-fg2">Stroke</span><NumberInput value={opts.sw} min={0.5} max={60} step={0.5} unit="px" width={56} onChange={(v) => o({ sw: v })} /><span className="text-[11px] text-fg3">Shift snaps to 45°</span></>,
    rect: <><Toggle label="Fill" checked={opts.fillOn} onChange={(v) => o({ fillOn: v })} /><Toggle label="Stroke" checked={opts.strokeOn} onChange={(v) => o({ strokeOn: v })} /><NumberInput value={opts.sw} min={0.5} max={60} step={0.5} unit="px" width={56} onChange={(v) => o({ sw: v })} /><span className="text-xs text-fg2 ml-2">Corner radius</span><NumberInput value={opts.radius} min={0} max={500} width={52} onChange={(v) => o({ radius: v })} /></>,
    oval: <><Toggle label="Fill" checked={opts.fillOn} onChange={(v) => o({ fillOn: v })} /><Toggle label="Stroke" checked={opts.strokeOn} onChange={(v) => o({ strokeOn: v })} /><NumberInput value={opts.sw} min={0.5} max={60} step={0.5} unit="px" width={56} onChange={(v) => o({ sw: v })} /><span className="text-[11px] text-fg3">Shift draws a circle</span></>,
    bucket: <><span className="text-xs text-fg2">Gap size</span><Segmented value={String(opts.gap)} onChange={(v) => o({ gap: Number(v) })} options={[{ value: '0', label: "Don't close" }, { value: '2', label: 'Small' }, { value: '5', label: 'Medium' }, { value: '10', label: 'Large' }]} /><span className="text-[11px] text-fg3">Click inside lines to fill, or on a shape to recolour it</span></>,
    eraser: <><span className="text-xs text-fg2">Eraser size</span><Slider className="w-40" showNumber={false} value={opts.eraser} min={2} max={200} onChange={(v) => o({ eraser: v })} /><NumberInput value={opts.eraser} min={2} max={200} width={48} onChange={(v) => o({ eraser: v })} /></>,
    text: <><span className="text-xs text-fg2">Size</span><NumberInput value={opts.fontSize} min={6} max={600} width={56} onChange={(v) => o({ fontSize: v })} /><span className="text-[11px] text-fg3">Click the stage to type</span></>,
  }[tool] || <span className="text-xs text-fg3">{tool === 'select' ? 'Click to select, drag to move, corner handles scale (Shift keeps proportions), just outside corners rotates. F8 makes a symbol.' : ''}</span>;

  const crumbs = (
    <span className="flex items-center gap-1 truncate">
      <button type="button" className={cx('hover:text-fg', !symId && 'text-fg font-medium')} onClick={() => { stop(); setSymId(null); setActive(null); }}>Scene 1</button>
      {symId && <><span className="text-fg3">›</span><span className="text-accent font-medium truncate">{doc.symbols.find((s) => s.id === symId)?.name}</span></>}
    </span>
  );
  const options = (
    <>
      {toolOptions}
      <div className="flex items-center gap-0.5 ml-auto">
        <Select small value={String(zoom)} onChange={(v) => setZoom(v === 'fit' ? 'fit' : Number(v))} options={[{ value: 'fit', label: 'Fit' }, ...(zoom !== 'fit' && ![0.5, 1, 2, 4].includes(zoom) ? [{ value: String(zoom), label: `${Math.round(zoom * 100)}%` }] : []), { value: '0.5', label: '50%' }, { value: '1', label: '100%' }, { value: '2', label: '200%' }, { value: '4', label: '400%' }]} />
        <IconButton icon="skipBack" label="First frame" shortcut="Home" size={28} onClick={() => setFrame(0)} />
        <IconButton icon="chevronLeft" label="Previous frame" shortcut="," size={28} onClick={() => setFrame(frame - 1)} />
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Stop' : 'Play'} shortcut="Enter" size={30} onClick={togglePlay} data-testid="an-play" />
        <IconButton icon="chevronRight" label="Next frame" shortcut="." size={28} onClick={() => setFrame(frame + 1)} />
        <IconButton icon="skipForward" label="Last frame" shortcut="End" size={28} onClick={() => setFrame(len - 1)} />
        <IconButton icon="loop" label="Loop" size={28} active={loop} onClick={() => setLoop(!loop)} />
        <IconButton icon="onion" label="Onion skin" shortcut={keyLabel('shift+alt+o')} size={28} active={onion.on} onClick={() => setOnion({ ...onion, on: !onion.on })} />
      </div>
    </>
  );

  const menus = [
    { label: 'Insert', items: () => [
      { label: 'New symbol from selection', shortcut: 'F8', icon: 'component', onClick: toSymbol, disabled: !canEdit || !selEls.length },
      { label: 'New layer', icon: 'plus', onClick: addLayer, disabled: !canEdit },
      { divider: true },
      { label: 'Create Classic Tween', icon: 'tween', onClick: () => frameOp((l, f) => setTween(l, f, 'motion'), 'Create classic tween'), disabled: !canEdit },
      { label: 'Create Shape Tween', icon: 'tween', onClick: () => frameOp((l, f) => setTween(l, f, 'shape'), 'Create shape tween'), disabled: !canEdit },
      { label: 'Remove Tween', onClick: () => frameOp((l, f) => setTween(l, f, null), 'Remove tween'), disabled: !canEdit },
      { divider: true },
      { label: 'Frame', shortcut: 'F5', onClick: () => frameOp(insertFrames, 'Insert frame'), disabled: !canEdit },
      { label: 'Keyframe', shortcut: 'F6', onClick: () => frameOp((l, f) => insertKeyframe(l, f), 'Insert keyframe'), disabled: !canEdit },
      { label: 'Blank keyframe', shortcut: 'F7', onClick: () => frameOp((l, f) => insertKeyframe(l, f, true), 'Insert blank keyframe'), disabled: !canEdit },
      { label: 'Remove frame', shortcut: keyLabel('shift+f5'), onClick: () => frameOp(removeFrames, 'Remove frame'), disabled: !canEdit },
      { label: 'Clear keyframe', shortcut: keyLabel('shift+f6'), onClick: () => frameOp(clearKeyframe, 'Clear keyframe'), disabled: !canEdit },
    ] },
    { label: 'Modify', items: () => [
      { label: 'Convert to Symbol…', shortcut: 'F8', onClick: toSymbol, disabled: !canEdit || !selEls.length },
      { label: 'Break Apart', shortcut: keyLabel('mod+b'), onClick: breakSel, disabled: !canEdit || !selEls.some((e) => e.type === 'symbol') },
      { label: 'Edit Symbol', shortcut: keyLabel('mod+e'), onClick: () => { const inst = selEls.find((e) => e.type === 'symbol'); if (inst) editSymbol(inst.symbol); }, disabled: !selEls.some((e) => e.type === 'symbol') },
      { label: 'Back to Scene 1', onClick: () => setSymId(null), disabled: !symId },
      { divider: true },
      { label: 'Arrange', disabled: !canEdit || !sel.length, items: [
        { label: 'Bring to front', shortcut: keyLabel('shift+mod+arrowup'), onClick: () => arrange('front') }, { label: 'Bring forward', shortcut: keyLabel('mod+arrowup'), onClick: () => arrange('up') },
        { label: 'Send backward', shortcut: keyLabel('mod+arrowdown'), onClick: () => arrange('down') }, { label: 'Send to back', shortcut: keyLabel('shift+mod+arrowdown'), onClick: () => arrange('back') },
      ] },
      { label: 'Flip horizontal', disabled: !canEdit || !sel.length, onClick: () => editSel((e) => ({ ...e, sx: -(e.sx ?? 1) }), 'Flip horizontal') },
      { label: 'Flip vertical', disabled: !canEdit || !sel.length, onClick: () => editSel((e) => ({ ...e, sy: -(e.sy ?? 1) }), 'Flip vertical') },
      { label: 'Duplicate', shortcut: keyLabel('mod+d'), disabled: !canEdit || !sel.length, onClick: duplicate },
      { label: 'Paste in place', shortcut: keyLabel('shift+mod+v'), disabled: !canEdit || clipboard?.kind !== 'els', onClick: () => paste(true) },
    ] },
    { label: 'Control', items: () => [
      { label: playing ? 'Stop' : 'Play', shortcut: '↵', onClick: togglePlay },
      { label: 'Loop playback', checked: loop, onClick: () => setLoop(!loop) },
      { label: 'Rewind', shortcut: 'Home', onClick: () => setFrame(0) },
      { label: 'Step forward one frame', shortcut: '.', onClick: () => setFrame(frame + 1) },
      { label: 'Step backward one frame', shortcut: ',', onClick: () => setFrame(frame - 1) },
    ] },
    { label: 'View', items: () => [
      { label: 'Fit stage', shortcut: keyLabel('mod+0'), onClick: () => setZoom('fit') },
      { label: '100%', shortcut: keyLabel('mod+1'), onClick: () => setZoom(1) },
      { divider: true },
      { label: 'Onion skin', checked: onion.on, shortcut: keyLabel('shift+alt+o'), onClick: () => setOnion({ ...onion, on: !onion.on }) },
    ] },
  ];

  return (
    <EditorShell app="animate" project={project} history={h} getData={getData} menus={menus} exportConfig={exportConfig} tools={tools} options={options} panelWidth={290}
      fileItems={[
        { label: 'Import to stage…', icon: 'import', shortcut: keyLabel('mod+r'), onClick: () => importImages(false), disabled: !canEdit },
        { label: 'Import image sequence…', icon: 'frames', onClick: () => importImages(true), disabled: !canEdit },
      ]}
      commentAnchor={() => ({ frame })} anchorLabel={(a) => `Frame ${(a.frame || 0) + 1}`} onJumpToComment={(a) => { setSymId(null); setFrame(a.frame || 0); }}
      panels={(
        <>
          <PropertiesPanel doc={doc} layer={active} frame={frame} selEls={selEls} canEdit={canEdit} editSel={editSel} editKey={editKey} endMerge={endMerge} symbols={doc.symbols}
            editDoc={(patch, label, merge) => editDocFn((d) => ({ ...d, ...patch }), label, merge)} />
          <LibraryPanel doc={doc} canEdit={canEdit} editing={symId} onPlace={placeFromLibrary} onEdit={editSymbol} onImport={() => importImages(false)}
            onRename={(sid, n) => editDocFn((d) => ({ ...d, symbols: d.symbols.map((s) => (s.id === sid ? { ...s, name: n } : s)) }), 'Rename symbol')}
            onDelete={(sid) => {
              const used = [doc.scene, ...doc.symbols.map((s) => s.timeline)].some((t) => t.layers.some((l) => l.frames.some((k) => k.els.some((e) => e.symbol === sid))));
              if (used) { toast('That symbol is still used on the stage — delete its instances first.', { type: 'error' }); return; }
              if (symId === sid) setSymId(null);
              editDocFn((d) => ({ ...d, symbols: d.symbols.filter((s) => s.id !== sid) }), 'Delete symbol');
            }} />
        </>
      )}
      bottom={(
        <Timeline tl={tl} frame={frame} setFrame={setFrame} active={active?.id} setActive={setActive} editLayer={editLayer} editTl={editTl} canEdit={canEdit} playing={playing}
          onion={onion} setOnion={setOnion} fps={fps} frameMenu={frameMenu} layerMenu={layerMenu} addLayer={addLayer} deleteLayer={deleteLayer} crumbs={crumbs} height={tlHeight} setHeight={setTlHeight} />
      )}
      status={<><span>{symId ? `Editing ${doc.symbols.find((s) => s.id === symId)?.name}` : 'Scene 1'}</span><span>Frame {frame + 1}</span><span>{doc.width}×{doc.height} · {fps} fps</span>{!canEdit && <span className="text-warn">View only</span>}</>}>
      <Stage doc={doc} tl={tl} symId={symId} frame={frame} active={active?.id} setActive={setActive} sel={sel} setSel={setSel} tool={tool} opts={opts} setOpts={setOpts}
        onion={onion} canEdit={canEdit} playing={playing} editEls={editEls} editingText={editingText} setEditingText={setEditingText} zoom={zoom} setZoom={setZoom} />
      {canEdit && !symId && len === 1 && !tl.layers.some((l) => l.frames.some((k) => k.els.length)) && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-none rounded-lg bg-panel/90 border border-line px-3 py-1.5 text-[12px] text-fg2 shadow">
          Draw with the brush (B), then press <b>F6</b> for the next keyframe — or <b>F7</b> for a blank one. Onion skin: <b>{keyLabel('shift+alt+o')}</b>.
        </div>
      )}
    </EditorShell>
  );
}
