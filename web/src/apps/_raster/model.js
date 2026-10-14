// The layered document both raster editors share. Everything here is plain immutable data that lives in useHistory:
//
//   doc = { width, height, layers: [bottom … top], sel: Selection | null, guides: [{ axis: 'x'|'y', pos }] }
//
// Every layer has { id, type, name, visible, opacity 0..1, blend (Canvas 2D composite op), locked, lockAlpha,
// clip (clipped to the layer below), mask: { pix, enabled, inverted } | null, fx: { shadow, stroke, glow, overlay } | null }
// plus, by type:
//   bitmap  { x, y, pix }                       pixels (a Pix, see pix.js) offset by x,y
//   text    { x, y, text, font, size, weight, italic, color, align, lineHeight, tracking, rotation }
//   shape   { shape: rect|ellipse|line|polygon, x, y, w, h, rotation, fill, stroke, strokeWidth, radius, sides }
//   fill    { fill: { kind: 'solid', color } | { kind: 'gradient', type: 'linear'|'radial', colors: [a, b], angle } }
//   adjust  { adj: { kind, …settings } }        non-destructive adjustment of everything below it
//   group   { children: [...], open }
import { Pix } from './pix.js';

let seq = Date.now() % 100000;
export const uid = (p = 'l') => `${p}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const BLEND_MODES = [
  { value: 'source-over', label: 'Normal' },
  { group: 'Darken', options: [{ value: 'darken', label: 'Darken' }, { value: 'multiply', label: 'Multiply' }, { value: 'color-burn', label: 'Color Burn' }] },
  { group: 'Lighten', options: [{ value: 'lighten', label: 'Lighten' }, { value: 'screen', label: 'Screen' }, { value: 'color-dodge', label: 'Color Dodge' }, { value: 'lighter', label: 'Linear Dodge (Add)' }] },
  { group: 'Contrast', options: [{ value: 'overlay', label: 'Overlay' }, { value: 'soft-light', label: 'Soft Light' }, { value: 'hard-light', label: 'Hard Light' }] },
  { group: 'Inversion', options: [{ value: 'difference', label: 'Difference' }, { value: 'exclusion', label: 'Exclusion' }] },
  { group: 'Component', options: [{ value: 'hue', label: 'Hue' }, { value: 'saturation', label: 'Saturation' }, { value: 'color', label: 'Color' }, { value: 'luminosity', label: 'Luminosity' }] },
];
export const GROUP_BLEND_MODES = [{ value: 'pass-through', label: 'Pass Through' }, ...BLEND_MODES];
export const blendLabel = (v) => (v === 'pass-through' ? 'Pass Through' : BLEND_MODES.flatMap((b) => b.options || [b]).find((b) => b.value === v)?.label || 'Normal');

const base = (type, name, extra) => ({ id: uid(), type, name, visible: true, opacity: 1, blend: 'source-over', locked: false, lockAlpha: false, clip: false, mask: null, fx: null, ...extra });

export const newBitmap = (name = 'Layer', extra = {}) => base('bitmap', name, { x: 0, y: 0, pix: Pix.empty(), ...extra });
export const newText = (extra = {}) => base('text', extra.text ? extra.text.split('\n')[0].slice(0, 30) : 'Text', {
  x: 0, y: 0, text: 'Text', font: 'Inter', size: 72, weight: 400, italic: false, color: '#000000', align: 'left', lineHeight: 1.2, tracking: 0, rotation: 0, ...extra,
});
export const newShape = (extra = {}) => base('shape', { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', polygon: 'Polygon' }[extra.shape || 'rect'], {
  shape: 'rect', x: 0, y: 0, w: 100, h: 100, rotation: 0, fill: '#5AB4FF', stroke: null, strokeWidth: 4, radius: 0, sides: 6, ...extra,
});
export const newFill = (fill, name) => base('fill', name || (fill.kind === 'gradient' ? 'Gradient Fill' : 'Color Fill'), { fill });
export const newAdjust = (adj, name) => base('adjust', name, { adj });
export const newGroup = (children = [], name = 'Group') => base('group', name, { blend: 'pass-through', children, open: true });

export const newDoc = (width, height, layers = []) => ({ width, height, layers, sel: null, guides: [] });

// ---------------------------------------------------------------- tree helpers (all return new trees)

/** Depth-first list of every layer (top-level and inside groups), bottom first. */
export function flatten(layers, out = [], parent = null) {
  for (const l of layers) { out.push(l); if (l.type === 'group') flatten(l.children, out, l); }
  return out;
}
export const findLayer = (layers, id) => flatten(layers).find((l) => l.id === id) || null;
/** { list, index, parent } where the layer lives. */
export function locate(layers, id, parent = null) {
  for (let i = 0; i < layers.length; i++) {
    if (layers[i].id === id) return { list: layers, index: i, parent };
    if (layers[i].type === 'group') { const r = locate(layers[i].children, id, layers[i]); if (r) return r; }
  }
  return null;
}
export function mapLayers(layers, fn) {
  let changed = false;
  const out = layers.map((l) => {
    let n = fn(l);
    if (n && n.type === 'group') {
      const kids = mapLayers(n.children, fn);
      if (kids !== n.children) n = { ...n, children: kids };
    }
    if (n !== l) changed = true;
    return n;
  });
  return changed ? out : layers;
}
export const updateLayer = (doc, id, patch) => ({ ...doc, layers: mapLayers(doc.layers, (l) => (l.id === id ? { ...l, ...(typeof patch === 'function' ? patch(l) : patch) } : l)) });
export function removeLayers(layers, ids) {
  const set = new Set(ids);
  const walk = (list) => list.filter((l) => !set.has(l.id)).map((l) => (l.type === 'group' ? { ...l, children: walk(l.children) } : l));
  return walk(layers);
}
/** Inserts layer(s) at a position: { above: id } | { below: id } | { into: groupId } (top of group) | null (top). */
export function insertLayers(layers, items, where) {
  items = Array.isArray(items) ? items : [items];
  if (!where) return [...layers, ...items];
  const target = where.above || where.below || where.into;
  const walk = (list) => {
    const out = [];
    for (const l of list) {
      if (l.id === target && where.below) out.push(...items);
      if (l.id === target && where.into && l.type === 'group') { out.push({ ...l, children: [...l.children, ...items], open: true }); continue; }
      out.push(l.type === 'group' ? { ...l, children: walk(l.children) } : l);
      if (l.id === target && where.above) out.push(...items);
    }
    return out;
  };
  return walk(layers);
}
export function moveLayer(layers, id, where) {
  const l = findLayer(layers, id);
  if (!l || where?.above === id || where?.below === id || where?.into === id) return layers;
  if (l.type === 'group' && where && findLayer(l.children, where.above || where.below || where.into)) return layers; // into itself
  return insertLayers(removeLayers(layers, [id]), [l], where);
}
/** The layer below/above inside the same list. */
export function sibling(layers, id, dir) {
  const loc = locate(layers, id);
  if (!loc) return null;
  return loc.list[loc.index + dir] || null;
}

export const isPixelLayer = (l) => l?.type === 'bitmap';
export const layerLabel = (l) => ({ bitmap: 'Pixel layer', text: 'Text layer', shape: 'Shape layer', fill: 'Fill layer', adjust: 'Adjustment layer', group: 'Group' }[l?.type] || 'Layer');
/** Where a layer's mask (0,0) sits in document space. Bitmap masks move with their layer; mask.x/y shift it further. */
export const maskOffset = (l) => ({ x: (l.type === 'bitmap' ? l.x : 0) + (l.mask?.x || 0), y: (l.type === 'bitmap' ? l.y : 0) + (l.mask?.y || 0) });
/** Duplicates a layer (and children) with fresh ids. Pixels are shared — they're immutable. */
export function cloneLayer(l, suffix = ' copy') {
  const c = { ...l, id: uid(), name: suffix ? `${l.name}${suffix}` : l.name };
  if (l.type === 'group') c.children = l.children.map((k) => cloneLayer(k, ''));
  return c;
}
export function uniqueName(layers, baseName) {
  const names = new Set(flatten(layers).map((l) => l.name));
  if (!names.has(baseName)) return baseName;
  for (let i = 2; ; i++) if (!names.has(`${baseName} ${i}`)) return `${baseName} ${i}`;
}
