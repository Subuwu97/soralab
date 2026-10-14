// The vector document: a scene graph saved as JSON. Shared by Sora Eshi (vector), Sora Express and Sora UI/UX (proto).
//
//   doc = {
//     v: 1,
//     children: [artboard | node…],     // artboards, plus loose objects on the pasteboard (vector only)
//     symbols: [{ id, name, children }], // symbol / component masters, drawn in their own space around 0,0
//     swatches: ['#hex'…], guides: { x: [], y: [] },
//     interactions: [{ id, from, trigger, delay, action, dest, transition, duration, easing }], home: artboardId,   // proto
//   }
//
// All coordinates are world coordinates: artboards are rectangles on the canvas and own their children, but children are
// not offset by the artboard (moving an artboard moves its children). Groups never carry a transform: transforming a
// group transforms its children. Leaf nodes have a matrix `t` applied to their local geometry.
//
// Node kinds: artboard, group (clip: true → last child is the clipping mask), path, rect, ellipse, polygon, star,
// text (mode point | area | path), image (asset), instance (symbol), repeat (repeat grid).
// Every leaf: fill, stroke, opacity, blend, effects, hidden, locked, name.
import { I, mul, apply, decompose, compose, isIdentity, mapSubpaths, localSubpaths, subpathBounds, transformRect, unionRects, translate, parsePathData } from './geom.js';
import { layoutText, fontOf } from './text.js';

export const uid = () => Math.random().toString(36).slice(2, 10);

export const solid = (color) => ({ type: 'solid', color });
export const linear = (angle, ...colors) => ({ type: 'linear', angle, stops: colors.map((c, i) => (typeof c === 'object' ? c : { o: colors.length > 1 ? i / (colors.length - 1) : 0, color: c })) });
export const radial = (...colors) => ({ type: 'radial', cx: 0.5, cy: 0.5, r: 0.5, stops: colors.map((c, i) => ({ o: colors.length > 1 ? i / (colors.length - 1) : 0, color: c })) });
export const strokeOf = (color, width = 1, extra = {}) => ({ color, width, cap: 'butt', join: 'miter', dash: [], align: 'center', ...extra });

export const DEFAULT_SWATCHES = ['#000000', '#ffffff', '#e5e5e5', '#808080', '#1a1a1a', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0ff', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#a2845e', '#5AB4FF', '#8B7CFF', '#FF8FB1', '#FFC36B'];

const base = (type, extra) => ({ id: uid(), type, name: '', t: I, fill: null, stroke: null, opacity: 1, blend: 'normal', effects: [], ...extra });

/** Node factories. Shapes are drawn in local space from 0,0; `x, y` place them via the matrix. */
export const make = {
  rect: ({ x = 0, y = 0, w, h, r = 0, ...o }) => base('rect', { t: translate(x, y), w, h, r, fill: solid('#d9d9d9'), ...o }),
  ellipse: ({ x = 0, y = 0, w, h, ...o }) => base('ellipse', { t: translate(x, y), w, h, fill: solid('#d9d9d9'), ...o }),
  polygon: ({ x = 0, y = 0, w, h, sides = 6, ...o }) => base('polygon', { t: translate(x, y), w, h, sides, fill: solid('#d9d9d9'), ...o }),
  star: ({ x = 0, y = 0, w, h, points = 5, inner = 0.5, ...o }) => base('star', { t: translate(x, y), w, h, points, inner, fill: solid('#d9d9d9'), ...o }),
  path: ({ subpaths, d, ...o }) => base('path', { subpaths: subpaths || parsePathData(d), fillRule: 'nonzero', ...o }),
  line: ({ x1, y1, x2, y2, ...o }) => base('path', { subpaths: [{ closed: false, pts: [{ x: x1, y: y1, ix: x1, iy: y1, ox: x1, oy: y1 }, { x: x2, y: y2, ix: x2, iy: y2, ox: x2, oy: y2 }] }], fillRule: 'nonzero', stroke: strokeOf('#000000', 2), ...o }),
  text: ({ x = 0, y = 0, text, font, mode = 'point', w, h, ...o }) => base('text', { t: translate(x, y), text, mode, w, h, font: { family: 'Inter', weight: 400, style: 'normal', size: 36, tracking: 0, leading: 0, align: 'left', ...font }, fill: solid('#000000'), ...o }),
  image: ({ x = 0, y = 0, w, h, asset, ...o }) => base('image', { t: translate(x, y), w, h, asset, ...o }),
  group: (children, o = {}) => ({ id: uid(), type: 'group', name: '', children, clip: false, opacity: 1, blend: 'normal', effects: [], ...o }),
  artboard: ({ x = 0, y = 0, w, h, name = 'Artboard 1', bg = '#ffffff', ...o }) => ({ id: uid(), type: 'artboard', name, x, y, w, h, bg, children: [], ...o }),
  instance: ({ symbol, x = 0, y = 0, ...o }) => base('instance', { t: translate(x, y), symbol, overrides: {}, ...o }),
};

/** A new empty document for an app. Express and Proto clip content to their pages/screens. */
export function createDoc({ app, width = 1024, height = 1024 }) {
  const name = app === 'express' ? 'Page 1' : app === 'proto' ? 'Screen 1' : 'Artboard 1';
  const ab = make.artboard({ w: width, h: height, name, clip: app !== 'vector' });
  if (app === 'proto') ab.viewportH = height;
  return { v: 1, app, children: [ab], symbols: [], swatches: [...DEFAULT_SWATCHES], guides: { x: [], y: [] }, interactions: [], home: ab.id };
}
/** Fills in anything missing from an older or hand-made document. */
export function normalizeDoc(d, fallback) {
  if (!d || !Array.isArray(d.children)) return createDoc(fallback);
  return { symbols: [], swatches: [...DEFAULT_SWATCHES], guides: { x: [], y: [] }, interactions: [], ...d, home: d.home || d.children.find((n) => n.type === 'artboard')?.id };
}

export const isContainer = (n) => n.type === 'group' || n.type === 'artboard';
export const artboardsOf = (doc) => doc.children.filter((n) => n.type === 'artboard');

// ---------------------------------------------------------------- tree helpers (copy-on-write)

/** Calls fn(node, parentNode|null, index, depth) for every node, depth first. Return false to skip children. */
export function walk(list, fn, parent = null, depth = 0) {
  (list || []).forEach((n, i) => { if (fn(n, parent, i, depth) !== false && n.children) walk(n.children, fn, n, depth + 1); });
}
/** { node, parent, index, list, chain } for an id (chain = ancestor nodes, outermost first). */
export function find(list, id, chain = []) {
  for (let i = 0; i < (list || []).length; i++) {
    const n = list[i];
    if (n.id === id) return { node: n, parent: chain[chain.length - 1] || null, index: i, list, chain };
    if (n.children) { const r = find(n.children, id, [...chain, n]); if (r) return r; }
  }
  return null;
}
export const findNode = (list, id) => find(list, id)?.node || null;
/** Replaces node `id` with fn(node) (fn may return null to delete, or an array to splice in several). */
export function updateIn(list, id, fn) {
  let changed = false;
  const out = [];
  for (const n of list) {
    if (n.id === id) { const r = fn(n); changed = true; if (Array.isArray(r)) out.push(...r); else if (r) out.push(r); continue; }
    if (n.children) {
      const c = updateIn(n.children, id, fn);
      if (c !== n.children) { changed = true; out.push({ ...n, children: c }); continue; }
    }
    out.push(n);
  }
  return changed ? out : list;
}
export function updateMany(list, ids, fn) {
  const set = ids instanceof Set ? ids : new Set(ids);
  let changed = false;
  const out = list.map((n) => {
    if (set.has(n.id)) { changed = true; return fn(n); }
    if (n.children) { const c = updateMany(n.children, set, fn); if (c !== n.children) { changed = true; return { ...n, children: c }; } }
    return n;
  });
  return changed ? out : list;
}
export function removeIds(list, ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  let changed = false;
  const out = [];
  for (const n of list) {
    if (set.has(n.id)) { changed = true; continue; }
    if (n.children) { const c = removeIds(n.children, set); if (c !== n.children) { changed = true; out.push({ ...n, children: c }); continue; } }
    out.push(n);
  }
  return changed ? out : list;
}
/** Inserts nodes into parent `pid` (null = root) at index (default: top). */
export function insertInto(list, pid, nodes, index) {
  if (!pid) { const l = list.slice(); l.splice(index ?? l.length, 0, ...nodes); return l; }
  return updateIn(list, pid, (p) => { const c = p.children.slice(); c.splice(index ?? c.length, 0, ...nodes); return { ...p, children: c }; });
}
/** Deep copy with fresh ids. */
export function cloneNode(n) {
  const c = { ...n, id: uid() };
  if (n.children) c.children = n.children.map(cloneNode);
  return c;
}
export function allIds(n, out = []) { out.push(n.id); (n.children || []).forEach((c) => allIds(c, out)); return out; }

// ---------------------------------------------------------------- the editing scope (main document or a symbol)

export const rootOf = (doc, scope) => (scope ? doc.symbols.find((s) => s.id === scope)?.children || [] : doc.children);
export const withRoot = (doc, scope, children) => (scope ? { ...doc, symbols: doc.symbols.map((s) => (s.id === scope ? { ...s, children } : s)) } : { ...doc, children });

// ---------------------------------------------------------------- bounds

/** Geometry box before the node's matrix. */
export function localBox(n, doc) {
  switch (n.type) {
    case 'rect': case 'ellipse': case 'polygon': case 'star': case 'image': return { x: 0, y: 0, w: n.w, h: n.h };
    case 'path': return subpathBounds(n.subpaths) || { x: 0, y: 0, w: 0, h: 0 };
    case 'text': {
      if (n.mode === 'path') { const b = subpathBounds(parsePathData(n.pathD || '')) || { x: 0, y: 0, w: 0, h: 0 }; const s = fontOf(n).size; return { x: b.x - s * 0.2, y: b.y - s, w: b.w + s * 0.4, h: b.h + s * 1.2 }; }
      const L = layoutText(n); return { x: 0, y: 0, w: L.w, h: L.h };
    }
    case 'instance': { const s = doc?.symbols?.find((x) => x.id === n.symbol); return (s && unionRects(s.children.filter((c) => !c.hidden).map((c) => bounds(c, doc)))) || { x: 0, y: 0, w: 10, h: 10 }; }
    case 'repeat': return { x: 0, y: 0, w: n.cols * (n.cell.w + n.gx) - n.gx, h: n.rows * (n.cell.h + n.gy) - n.gy };
    default: return { x: 0, y: 0, w: 0, h: 0 };
  }
}
/** World-space bounding box. */
export function bounds(n, doc) {
  if (n.type === 'artboard') return { x: n.x, y: n.y, w: n.w, h: n.h };
  if (n.type === 'group') {
    if (n.clip && n.children.length) return bounds(n.children[n.children.length - 1], doc);
    return unionRects(n.children.filter((c) => !c.hidden).map((c) => bounds(c, doc))) || { x: 0, y: 0, w: 0, h: 0 };
  }
  const sps = n.type === 'path' || n.type === 'polygon' || n.type === 'star' || n.type === 'ellipse' ? localSubpaths(n) : null;
  if (sps) return subpathBounds(sps, n.t) || { x: n.t[4], y: n.t[5], w: 0, h: 0 };
  return transformRect(localBox(n, doc), n.t || I);
}
export const boundsOf = (nodes, doc) => unionRects(nodes.map((n) => bounds(n, doc)));

// ---------------------------------------------------------------- transforming

/** Applies a world-space matrix M to a node, baking scale into geometry where that keeps things editable. */
export function transformNode(n, M) {
  if (isIdentity(M)) return n;
  if (n.type === 'artboard') return { ...n, x: n.x + M[4], y: n.y + M[5], children: n.children.map((c) => transformNode(c, M)) };
  if (n.type === 'group') return { ...n, children: n.children.map((c) => transformNode(c, M)) };
  const t = mul(M, n.t || I);
  if (n.type === 'path') return { ...n, t: I, subpaths: mapSubpaths(n.subpaths, t) };
  const d = decompose(t);
  const noSkew = Math.abs(d.skew) < 1e-6;
  if (noSkew && ['rect', 'ellipse', 'polygon', 'star', 'image'].includes(n.type)) {
    return { ...n, w: n.w * Math.abs(d.sx), h: n.h * Math.abs(d.sy), t: compose({ x: d.x, y: d.y, rotation: d.rotation, sx: Math.sign(d.sx) || 1, sy: Math.sign(d.sy) || 1 }) };
  }
  if (noSkew && n.type === 'text' && n.mode === 'area') {
    return { ...n, w: n.w * Math.abs(d.sx), h: (n.h || 0) * Math.abs(d.sy), t: compose({ x: d.x, y: d.y, rotation: d.rotation, sx: Math.sign(d.sx) || 1, sy: Math.sign(d.sy) || 1 }) };
  }
  if (noSkew && n.type === 'text' && n.mode !== 'path' && Math.abs(Math.abs(d.sx) - Math.abs(d.sy)) < 1e-3 * Math.abs(d.sx)) {
    // Uniform scale of point text changes the type size, like Illustrator.
    const s = Math.abs(d.sy); const f = fontOf(n);
    return { ...n, font: { ...n.font, size: Math.round(f.size * s * 100) / 100, leading: f.leading ? Math.round(f.leading * s * 100) / 100 : 0 }, t: compose({ x: d.x, y: d.y, rotation: d.rotation, sx: Math.sign(d.sx) || 1, sy: Math.sign(d.sy) || 1 }) };
  }
  return { ...n, t };
}
export const moveNode = (n, dx, dy) => transformNode(n, translate(dx, dy));

/** Turns a shape (or anything with an outline) into an editable path node in world space. */
export function toPathNode(n) {
  const sps = localSubpaths(n);
  if (!sps || n.type === 'path') return n;
  const { w, h, r, sides, points, inner, asset, ...rest } = n;
  return { ...rest, type: 'path', subpaths: mapSubpaths(sps, n.t || I), t: I, fillRule: 'nonzero' };
}
/** World-space subpaths of a node (for booleans, PDF, hit tests). Text and images give null. */
export function worldSubpaths(n) {
  const sps = localSubpaths(n);
  return sps ? mapSubpaths(sps, n.t || I) : null;
}
export { apply };
