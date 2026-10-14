// Sora Ugoki's document: compositions of layers with animatable properties (see _anim/comp.js for how they draw).
//
//   project = { v: 1, comps: [comp], main: compId }
//   comp    = { id, name, width, height, fps, duration, bg, work: [in, out], motionBlur, layers: [top … bottom] }
//   layer   = { id, name, type, in, out, start, enabled, solo, locked, parent, blend, matte: { layer, mode }, motionBlur,
//               tr: { anchor, position, scale, rotation, opacity }, masks: [], effects: [], …type-specific }
// Property paths address a property inside a layer: 'tr/position', 'shape/shapes/#s1/size', 'effects/#fx1/params/radius'.
import { P, isAnimated, keyedValue } from '../_anim/keyframes.js';
import { EFFECTS } from '../_anim/effects.js';
import { layerBox, compById } from '../_anim/comp.js';

export const uid = (p = 'l') => `${p}${Math.random().toString(36).slice(2, 9)}`;
export const LABELS = ['#e05e5e', '#e0b25e', '#7fc77f', '#5eb0e0', '#a77fe0', '#e07fc0', '#5ee0c8', '#c0c0c0'];

export function emptyComp({ width = 1920, height = 1080, fps = 30, duration = 10, name = 'Comp 1' } = {}) {
  return { id: uid('c'), name, width, height, fps, duration, bg: '#0b0b10', work: [0, duration], layers: [], motionBlur: false };
}
export function emptyProject(doc) {
  const meta = doc?.meta || {};
  const c = emptyComp({ width: doc?.width || 1920, height: doc?.height || 1080, fps: meta.fps || 30, duration: meta.duration || doc?.duration || 10 });
  return { v: 1, comps: [c], main: c.id };
}
/** Saved data → project (filling anything missing so older saves keep working). */
export function fromSaved(data, doc) {
  if (!data || !Array.isArray(data.comps) || !data.comps.length) return emptyProject(doc);
  const p = structuredClone(data);
  for (const c of p.comps) { c.work ||= [0, c.duration]; c.layers ||= []; for (const l of c.layers) { l.masks ||= []; l.effects ||= []; } }
  if (!p.main || !compById(p, p.main)) p.main = p.comps[0].id;
  return p;
}

const transform = (anchor, position) => ({ anchor: P(anchor), position: P(position), scale: P([100, 100]), rotation: P(0), opacity: P(100) });

/** A new layer of the given type, centred in the comp and spanning it. */
export function newLayer(type, comp, o = {}) {
  const W = comp.width; const H = comp.height;
  const base = {
    id: uid(), name: o.name || type[0].toUpperCase() + type.slice(1), type, in: o.in ?? 0, out: o.out ?? comp.duration, start: o.start ?? o.in ?? 0,
    enabled: true, solo: false, locked: false, parent: null, blend: 'normal', matte: null, motionBlur: false, label: LABELS[Math.floor(Math.random() * LABELS.length)],
    masks: [], effects: [],
  };
  switch (type) {
    case 'solid': {
      const w = o.w || W; const h = o.h || H;
      return { ...base, name: o.name || 'Solid', w, h, color: P(o.color || '#3d6bff'), tr: transform([w / 2, h / 2], [W / 2, H / 2]) };
    }
    case 'adjustment': return { ...base, name: o.name || 'Adjustment Layer', w: W, h: H, tr: transform([W / 2, H / 2], [W / 2, H / 2]), label: '#c0c0c0' };
    case 'null': return { ...base, name: o.name || 'Null', tr: transform([50, 50], [W / 2, H / 2]), label: '#e0b25e' };
    case 'shape': return {
      ...base, name: o.name || 'Shape Layer', tr: transform([0, 0], o.position || [W / 2, H / 2]),
      shape: {
        shapes: o.shapes || [],
        fill: { on: o.fill !== null, color: P(o.fill || '#ff4f7b'), opacity: P(100), gradient: { on: false, type: 'linear', a: P([-200, 0]), b: P([200, 0]), c0: P('#ff4f7b'), c1: P('#7a5cff') } },
        stroke: { on: !!o.stroke, color: P(o.stroke || '#ffffff'), width: P(o.strokeWidth ?? 6), opacity: P(100), cap: 'round', join: 'round', dash: 0 },
        trim: { on: false, start: P(0), end: P(100), offset: P(0) },
        repeater: { on: false, copies: P(3), offset: P([120, 0]), rotation: P(0), scale: P([100, 100]), endOpacity: P(100) },
      },
    };
    case 'text': return {
      ...base, name: o.name || (o.value || 'Text').split('\n')[0].slice(0, 24), tr: transform([0, 0], o.position || [W / 2, H / 2 + (o.size || 96) * 0.35]),
      text: {
        value: o.value ?? 'Text', font: o.font || 'Inter', weight: o.weight || 700, italic: false, size: P(o.size || 96), color: P(o.color || '#ffffff'), align: o.align || 'center',
        tracking: P(0), leading: 1.2, stroke: { on: false, color: P('#000000'), width: P(4) },
        anim: { on: false, start: P(0), end: P(100), offset: P(0), soft: P(0), opacity: P(0), pos: P([0, 40]), scale: P(100), rot: P(0) },
      },
    };
    case 'image': case 'video': {
      const w = o.w || 640; const h = o.h || 360;
      const fit = Math.min(1, W / w, H / h);
      return {
        ...base, name: o.name || 'Media', asset: o.asset, w, h, tr: { ...transform([w / 2, h / 2], [W / 2, H / 2]), scale: P([fit * 100, fit * 100]) },
        ...(type === 'video' ? { audioOn: true, volume: P(100), out: o.out ?? Math.min(comp.duration, (o.start ?? 0) + (o.duration || comp.duration)) } : {}),
      };
    }
    case 'audio': return { ...base, name: o.name || 'Audio', asset: o.asset, audioOn: true, volume: P(100), tr: transform([0, 0], [0, 0]), out: o.out ?? Math.min(comp.duration, (o.start ?? 0) + (o.duration || comp.duration)) };
    case 'precomp': {
      const sub = o.sub;
      return { ...base, name: o.name || sub.name, comp: sub.id, tr: transform([sub.width / 2, sub.height / 2], [W / 2, H / 2]) };
    }
    default: throw new Error(`Unknown layer type ${type}`);
  }
}

export const newShape = (kind, o = {}) => {
  const id = uid('s');
  if (kind === 'rect') return { id, kind, pos: P(o.pos || [0, 0]), size: P(o.size || [300, 200]), round: P(o.round || 0) };
  if (kind === 'ellipse') return { id, kind, pos: P(o.pos || [0, 0]), size: P(o.size || [240, 240]) };
  if (kind === 'star') return { id, kind, pos: P(o.pos || [0, 0]), points: P(o.points || 5), outer: P(o.outer || 140), inner: P(o.inner || 60), rot: P(0) };
  if (kind === 'polygon') return { id, kind, pos: P(o.pos || [0, 0]), points: P(o.points || 6), outer: P(o.outer || 140), rot: P(0) };
  return { id, kind: 'path', pos: P([0, 0]), nodes: o.nodes || [], closed: o.closed ?? true };
};
export const newMask = (kind, rect, nodes) => ({ id: uid('m'), name: 'Mask', kind, rect, nodes, mode: 'add', inverted: false, feather: P(0), opacity: P(100) });
export function newEffect(type, comp) {
  const def = EFFECTS[type];
  const params = {};
  for (const [k, d] of Object.entries(def.params)) {
    let v = Array.isArray(d.v) ? d.v.slice() : d.v;
    if (d.rel && comp) v = [d.rel[0] * comp.width, d.rel[1] * comp.height];
    params[k] = ['toggle', 'select'].includes(d.type) ? v : P(v);
  }
  return { id: uid('fx'), type, on: true, params };
}

// ---------------------------------------------------------------- property paths

const seg = (obj, k) => (k.startsWith('#') && Array.isArray(obj) ? obj.find((x) => x.id === k.slice(1)) : obj?.[k]);
export const getPath = (obj, path) => path.split('/').reduce((o, k) => seg(o, k), obj);
/** Returns a copy of obj with fn applied to the value at path. */
export function updatePath(obj, path, fn) {
  const keys = path.split('/');
  const go = (o, i) => {
    if (i === keys.length) return fn(o);
    const k = keys[i];
    if (k.startsWith('#') && Array.isArray(o)) return o.map((x) => (x.id === k.slice(1) ? go(x, i + 1) : x));
    if (Array.isArray(o)) { const c = o.slice(); c[k] = go(o[k], i + 1); return c; }
    return { ...o, [k]: go(o?.[k], i + 1) };
  };
  return go(obj, 0);
}

/**
 * The animatable properties of a layer, grouped like the After Effects timeline:
 * [{ group, key, props: [{ path, label, type, min, max, step }] }]. type: point | scale | angle | percent | num | color | int
 */
export function propGroups(layer) {
  const g = [];
  const tr = [
    { path: 'tr/anchor', label: 'Anchor Point', type: 'point', key: 'a' }, { path: 'tr/position', label: 'Position', type: 'point', key: 'p' },
    { path: 'tr/scale', label: 'Scale', type: 'scale', key: 's' }, { path: 'tr/rotation', label: 'Rotation', type: 'angle', key: 'r' },
    { path: 'tr/opacity', label: 'Opacity', type: 'percent', key: 't', min: 0, max: 100 },
  ];
  if (layer.type === 'audio') {
    g.push({ group: 'Audio', key: 'audio', props: [{ path: 'volume', label: 'Audio Levels', type: 'percent', min: 0, max: 400 }] });
    return g;
  }
  if (layer.type === 'text') {
    const a = layer.text.anim;
    g.push({ group: 'Text', key: 'text', props: [
      { path: 'text/size', label: 'Font size', type: 'num', min: 1, max: 2000 }, { path: 'text/color', label: 'Fill colour', type: 'color' },
      { path: 'text/tracking', label: 'Tracking', type: 'num', min: -500, max: 2000 },
      ...(layer.text.stroke?.on ? [{ path: 'text/stroke/color', label: 'Stroke colour', type: 'color' }, { path: 'text/stroke/width', label: 'Stroke width', type: 'num', min: 0, max: 200 }] : []),
    ] });
    if (a?.on) g.push({ group: 'Animator 1', key: 'anim', props: [
      { path: 'text/anim/start', label: 'Range start', type: 'percent', min: 0, max: 100 }, { path: 'text/anim/end', label: 'Range end', type: 'percent', min: 0, max: 100 },
      { path: 'text/anim/offset', label: 'Range offset', type: 'percent', min: -100, max: 100 }, { path: 'text/anim/soft', label: 'Softness (chars)', type: 'num', min: 0, max: 50, step: 0.1 },
      { path: 'text/anim/opacity', label: 'Opacity', type: 'percent', min: 0, max: 100 }, { path: 'text/anim/pos', label: 'Position', type: 'point' },
      { path: 'text/anim/scale', label: 'Scale', type: 'percent', min: 0, max: 1000 }, { path: 'text/anim/rot', label: 'Rotation', type: 'angle' },
    ] });
  }
  if (layer.type === 'shape') {
    const sh = layer.shape;
    const props = [];
    for (const s of sh.shapes) {
      const n = { rect: 'Rectangle', ellipse: 'Ellipse', star: 'Star', polygon: 'Polygon', path: 'Path' }[s.kind];
      const b = `shape/shapes/#${s.id}`;
      props.push({ path: `${b}/pos`, label: `${n} · Position`, type: 'point' });
      if (s.kind === 'rect') props.push({ path: `${b}/size`, label: `${n} · Size`, type: 'point' }, { path: `${b}/round`, label: `${n} · Roundness`, type: 'num', min: 0, max: 2000 });
      if (s.kind === 'ellipse') props.push({ path: `${b}/size`, label: `${n} · Size`, type: 'point' });
      if (s.kind === 'star' || s.kind === 'polygon') {
        props.push({ path: `${b}/points`, label: `${n} · Points`, type: 'num', min: 3, max: 100 }, { path: `${b}/outer`, label: `${n} · Outer radius`, type: 'num', min: 0, max: 5000 });
        if (s.kind === 'star') props.push({ path: `${b}/inner`, label: `${n} · Inner radius`, type: 'num', min: 0, max: 5000 });
        props.push({ path: `${b}/rot`, label: `${n} · Rotation`, type: 'angle' });
      }
    }
    if (sh.fill.on) props.push(...(sh.fill.gradient?.on
      ? [{ path: 'shape/fill/gradient/c0', label: 'Gradient start colour', type: 'color' }, { path: 'shape/fill/gradient/c1', label: 'Gradient end colour', type: 'color' },
        { path: 'shape/fill/gradient/a', label: 'Gradient start point', type: 'point' }, { path: 'shape/fill/gradient/b', label: 'Gradient end point', type: 'point' }]
      : [{ path: 'shape/fill/color', label: 'Fill colour', type: 'color' }]), { path: 'shape/fill/opacity', label: 'Fill opacity', type: 'percent', min: 0, max: 100 });
    if (sh.stroke.on) props.push({ path: 'shape/stroke/color', label: 'Stroke colour', type: 'color' }, { path: 'shape/stroke/width', label: 'Stroke width', type: 'num', min: 0, max: 500 }, { path: 'shape/stroke/opacity', label: 'Stroke opacity', type: 'percent', min: 0, max: 100 });
    g.push({ group: 'Contents', key: 'contents', props });
    if (sh.trim.on) g.push({ group: 'Trim Paths', key: 'trim', props: [
      { path: 'shape/trim/start', label: 'Start', type: 'percent', min: 0, max: 100 }, { path: 'shape/trim/end', label: 'End', type: 'percent', min: 0, max: 100 },
      { path: 'shape/trim/offset', label: 'Offset', type: 'angle' },
    ] });
    if (sh.repeater.on) g.push({ group: 'Repeater', key: 'repeater', props: [
      { path: 'shape/repeater/copies', label: 'Copies', type: 'num', min: 1, max: 200 }, { path: 'shape/repeater/offset', label: 'Position', type: 'point' },
      { path: 'shape/repeater/rotation', label: 'Rotation', type: 'angle' }, { path: 'shape/repeater/scale', label: 'Scale', type: 'scale' },
      { path: 'shape/repeater/endOpacity', label: 'End opacity', type: 'percent', min: 0, max: 100 },
    ] });
  }
  if (layer.type === 'solid') g.push({ group: 'Solid', key: 'solid', props: [{ path: 'color', label: 'Colour', type: 'color' }] });
  if (layer.masks?.length) g.push({ group: 'Masks', key: 'masks', props: layer.masks.flatMap((m, i) => [
    { path: `masks/#${m.id}/feather`, label: `${m.name || `Mask ${i + 1}`} · Feather`, type: 'num', min: 0, max: 1000 },
    { path: `masks/#${m.id}/opacity`, label: `${m.name || `Mask ${i + 1}`} · Opacity`, type: 'percent', min: 0, max: 100 },
  ]) });
  if (layer.effects?.length) g.push({ group: 'Effects', key: 'effects', props: layer.effects.flatMap((e) => Object.entries(EFFECTS[e.type]?.params || {})
    .filter(([, d]) => !['toggle', 'select'].includes(d.type))
    .map(([k, d]) => ({ path: `effects/#${e.id}/params/${k}`, label: `${EFFECTS[e.type].label} · ${d.label}`, type: d.type, min: d.min, max: d.max, step: d.step }))) });
  if (layer.type === 'video') g.push({ group: 'Audio', key: 'audio', props: [{ path: 'volume', label: 'Audio Levels', type: 'percent', min: 0, max: 400 }] });
  g.push({ group: 'Transform', key: 'tr', props: tr });
  return g;
}
export const allProps = (layer) => propGroups(layer).flatMap((g) => g.props);
export const animatedProps = (layer) => allProps(layer).filter((p) => { const v = getPath(layer, p.path); return isAnimated(v) || v?.x; });

/** All keyframe times of a layer (for J / K navigation and the collapsed summary row). */
export function layerKeyTimes(layer) {
  const s = new Set();
  for (const p of allProps(layer)) for (const k of getPath(layer, p.path)?.k || []) s.add(+k.t.toFixed(5));
  return [...s].sort((a, b) => a - b);
}

/** Static snapshot of a property at t (used when editing values on non-animated properties). */
export const valueOf = (layer, path, t) => keyedValue(getPath(layer, path), t);

export function duplicateLayer(l) {
  const c = structuredClone(l);
  c.id = uid(); c.name = /\d+$/.test(l.name) ? l.name.replace(/\d+$/, (n) => String(Number(n) + 1)) : `${l.name} 2`;
  for (const m of c.masks) m.id = uid('m');
  for (const e of c.effects) e.id = uid('fx');
  // keep shape ids (paths reference them) — they only need to be unique inside the layer
  return c;
}

/** Comps that contain `id` (directly or through precomps) — used to stop circular nesting. */
export function compContains(project, compId, targetId, depth = 0) {
  if (compId === targetId) return true;
  const c = compById(project, compId);
  if (!c || depth > 16) return false;
  return c.layers.some((l) => l.type === 'precomp' && compContains(project, l.comp, targetId, depth + 1));
}

/** Content centre of a layer in layer space (for "anchor to centre"). */
export function boxCenter(project, layer, t, comp) {
  const b = layerBox(project, layer, t, comp);
  return [b.x + b.w / 2, b.y + b.h / 2];
}

export const fmtTC = (t, fps) => {
  const f = Math.round(t * fps);
  const sec = Math.floor(f / fps); const fr = f - sec * fps;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
};
export const snapT = (t, fps) => Math.round(t * fps) / fps;
