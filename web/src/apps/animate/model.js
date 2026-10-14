// Sora ANI's document and the frame operations of the timeline (F5 / F6 / F7, tweens, symbols).
//
//   doc = { v: 1, width, height, fps, bg, scene: timeline, symbols: [{ id, name, timeline }], library: [{ id: assetId, name, w, h }] }
// See _anim/stage.js for timelines, keys and elements. All functions here return new objects (history friendly).
import { keyAt, layerElements, timelineLength, elMatrix } from '../_anim/stage.js';
import { bbox, apply } from '../_anim/geom.js';
import { worldBounds } from '../_anim/stage.js';

export const uid = (p = 'e') => `${p}${Math.random().toString(36).slice(2, 9)}`;
export const LAYER_COLORS = ['#4aa3ff', '#ff5a5a', '#3ccf6e', '#ffb02e', '#b06bff', '#ff6bd0', '#2ed3c6', '#c9c94a'];

export const newLayer = (name, i = 0) => ({ id: uid('L'), name, visible: true, locked: false, outline: false, color: LAYER_COLORS[i % LAYER_COLORS.length], frames: [{ i: 0, len: 1, els: [] }] });
export function emptyDoc(meta) {
  return { v: 1, width: meta?.width || 1280, height: meta?.height || 720, fps: meta?.fps || 24, bg: '#ffffff', scene: { layers: [newLayer('Layer 1')] }, symbols: [], library: [] };
}
export function fromSaved(data, doc) {
  if (!data || !data.scene) return emptyDoc({ width: doc?.width, height: doc?.height, fps: doc?.meta?.fps });
  const d = structuredClone(data);
  d.symbols ||= []; d.library ||= [];
  return d;
}

/** The timeline being edited: the scene, or a symbol's. */
export const timelineOf = (doc, symId) => (symId ? doc.symbols.find((s) => s.id === symId)?.timeline : doc.scene) || doc.scene;
export const withTimeline = (doc, symId, fn) => (symId
  ? { ...doc, symbols: doc.symbols.map((s) => (s.id === symId ? { ...s, timeline: fn(s.timeline) } : s)) }
  : { ...doc, scene: fn(doc.scene) });
export const withLayer = (tl, lid, fn) => ({ ...tl, layers: tl.layers.map((l) => (l.id === lid ? fn(l) : l)) });

const sortKeys = (frames) => frames.slice().sort((a, b) => a.i - b.i);
const cloneEls = (els) => structuredClone(els);

// ---------------------------------------------------------------- frame operations (on one layer)

/** F5: adds a frame at f (extends the span there, or the last span up to f). */
export function insertFrames(layer, f, n = 1) {
  const k = keyAt(layer, f);
  if (k) return { ...layer, frames: layer.frames.map((x) => (x === k ? { ...x, len: x.len + n } : x.i > k.i ? { ...x, i: x.i + n } : x)) };
  const prev = sortKeys(layer.frames).filter((x) => x.i + x.len <= f).pop();
  if (prev) return { ...layer, frames: layer.frames.map((x) => (x === prev ? { ...x, len: f + 1 - x.i } : x)) };
  return { ...layer, frames: sortKeys([...layer.frames, { i: 0, len: f + 1, els: [] }]) };
}
/** Shift+F5: removes the frame at f (shortening its span; later keys move left). */
export function removeFrames(layer, f) {
  const k = keyAt(layer, f);
  if (!k) return layer;
  let frames = layer.frames.map((x) => (x === k ? { ...x, len: x.len - 1 } : x.i > k.i ? { ...x, i: x.i - 1 } : x)).filter((x) => x.len > 0);
  if (!frames.length) frames = [{ i: 0, len: 1, els: [] }];
  return { ...layer, frames };
}
/** F6 (copy what's showing) / F7 (blank): a keyframe at f. */
export function insertKeyframe(layer, f, blank = false) {
  const k = keyAt(layer, f);
  if (k && k.i === f) return layer;
  if (k) {
    const els = blank ? [] : cloneEls(layerElements(layer, f));
    const first = { ...k, len: f - k.i };
    const second = { i: f, len: k.i + k.len - f, els, tween: blank ? null : k.tween, ease: k.ease, bz: k.bz };
    return { ...layer, frames: sortKeys([...layer.frames.filter((x) => x !== k), first, second]) };
  }
  const prev = sortKeys(layer.frames).filter((x) => x.i + x.len <= f).pop();
  let frames = layer.frames;
  if (prev) frames = frames.map((x) => (x === prev ? { ...x, len: f - x.i } : x));
  else if (f > 0) frames = [...frames, { i: 0, len: f, els: [] }];
  const els = blank || !prev ? [] : cloneEls(layerElements(layer, prev.i + prev.len - 1));
  return { ...layer, frames: sortKeys([...frames, { i: f, len: 1, els }]) };
}
/** Shift+F6: turns the keyframe at f back into frames of the previous span. */
export function clearKeyframe(layer, f) {
  const k = layer.frames.find((x) => x.i === f);
  if (!k) return layer;
  const prev = layer.frames.find((x) => x.i + x.len === f);
  if (!prev) return { ...layer, frames: layer.frames.map((x) => (x === k ? { ...x, els: [] } : x)) };
  return { ...layer, frames: layer.frames.filter((x) => x !== k).map((x) => (x === prev ? { ...x, len: x.len + k.len } : x)) };
}
export const setTween = (layer, f, tween) => {
  const k = keyAt(layer, f);
  if (!k) return layer;
  return { ...layer, frames: layer.frames.map((x) => (x === k ? { ...x, tween } : x)) };
};
/** Moves the keyframe starting at `from` to `to` (bounded by its neighbours), keeping where its span ends. */
export function moveKey(layer, from, to) {
  const k = layer.frames.find((x) => x.i === from);
  if (!k) return layer;
  const prev = layer.frames.find((x) => x.i + x.len === from);
  const end = k.i + k.len;
  const lo = prev ? prev.i + 1 : 0;
  const t = Math.max(lo, Math.min(end - 1, to));
  if (t === from) return layer;
  return { ...layer, frames: layer.frames.map((x) => (x === k ? { ...x, i: t, len: end - t } : x === prev ? { ...x, len: t - x.i } : x)).filter((x) => x.len > 0) };
}

/**
 * The keyframe to edit at f. Inside a tween (not on its key) a keyframe is added there first — like Animate's
 * auto-keyframing — and on an empty frame a blank keyframe is created. Returns { layer, key }.
 */
export function keyForEdit(layer, f) {
  let k = keyAt(layer, f);
  if (k && k.i !== f && k.tween) { layer = insertKeyframe(layer, f); k = keyAt(layer, f); }
  if (!k) { layer = insertKeyframe(layer, f, true); k = keyAt(layer, f); }
  return { layer, key: k };
}
/** Applies fn(els) to the elements of the keyframe being edited at f. */
export function editEls(layer, f, fn) {
  const r = keyForEdit(layer, f);
  return { ...r.layer, frames: r.layer.frames.map((x) => (x === r.key ? { ...x, els: fn(x.els) } : x)) };
}

// ---------------------------------------------------------------- symbols

/** F8: wraps elements (stage space) into a new movie-clip symbol; returns { symbol, instance }. */
export function makeSymbol(doc, els, name) {
  const pts = els.flatMap((e) => { const b = worldBounds(doc, e); return [[b.x, b.y], [b.x + b.w, b.y + b.h]]; });
  const b = bbox([pts]);
  const c = [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];
  const inner = els.map((e) => ({ ...structuredClone(e), x: (e.x || 0) - c[0], y: (e.y || 0) - c[1] }));
  const symbol = { id: uid('S'), name, timeline: { layers: [{ ...newLayer('Layer 1'), frames: [{ i: 0, len: 1, els: inner }] }] } };
  const instance = { id: uid(), type: 'symbol', symbol: symbol.id, x: c[0], y: c[1], sx: 1, sy: 1, r: 0, alpha: 1, loop: 'loop', first: 0 };
  return { symbol, instance };
}
/** Ctrl+B on an instance: its first frame's elements, placed on the stage. */
export function breakApart(doc, inst) {
  const s = doc.symbols.find((x) => x.id === inst.symbol);
  if (!s) return [];
  const M = elMatrix(inst);
  return s.timeline.layers.slice().reverse().flatMap((l) => layerElements(l, inst.first || 0)).map((e) => {
    const p = apply(M, [e.x || 0, e.y || 0]);
    return { ...structuredClone(e), id: uid(), x: p[0], y: p[1], r: (e.r || 0) + (inst.r || 0), sx: (e.sx ?? 1) * (inst.sx ?? 1), sy: (e.sy ?? 1) * (inst.sy ?? 1), alpha: (e.alpha ?? 1) * (inst.alpha ?? 1) };
  });
}
export const symbolLength = (s) => timelineLength(s.timeline);

/** Makes a shape element from stage-space subpaths, with its registration point at the centre of its bounds. */
export function shapeFrom(subs, style) {
  const b = bbox(subs.map((s) => s.pts));
  const c = [b.x + b.w / 2, b.y + b.h / 2];
  return { id: uid(), type: 'shape', x: c[0], y: c[1], sx: 1, sy: 1, r: 0, alpha: 1, subs: subs.map((s) => ({ closed: s.closed, pts: s.pts.map(([x, y]) => [+(x - c[0]).toFixed(2), +(y - c[1]).toFixed(2)]) })), ...style };
}
