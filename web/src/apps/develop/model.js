// Sora Hikari (Develop) — the catalog document and the develop settings model.
//
// A catalog is { photos: [...], collections: [...] }. Each photo points at an asset (the original file never changes)
// and carries non-destructive develop settings, plus rating / flag / colour label / keywords, snapshots and its own
// edit history. Settings are stored "compact" (only what differs from the defaults) to keep projects small.

export const uid = (p = 'p') => `${p}${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const clone = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));

// ---------------------------------------------------------------- settings

export const HSL_BANDS = [
  { id: 'red', label: 'Red', hue: 0, color: '#e5484d' },
  { id: 'orange', label: 'Orange', hue: 30, color: '#f08a24' },
  { id: 'yellow', label: 'Yellow', hue: 60, color: '#e8c724' },
  { id: 'green', label: 'Green', hue: 120, color: '#46a758' },
  { id: 'aqua', label: 'Aqua', hue: 180, color: '#29b6c4' },
  { id: 'blue', label: 'Blue', hue: 240, color: '#3e63dd' },
  { id: 'purple', label: 'Purple', hue: 270, color: '#8e4ec6' },
  { id: 'magenta', label: 'Magenta', hue: 300, color: '#d6409f' },
];

export const MASK_ADJ = [
  { key: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.01 },
  { key: 'contrast', label: 'Contrast' }, { key: 'highlights', label: 'Highlights' }, { key: 'shadows', label: 'Shadows' },
  { key: 'whites', label: 'Whites' }, { key: 'blacks', label: 'Blacks' },
  { key: 'temp', label: 'Temp' }, { key: 'tint', label: 'Tint' }, { key: 'saturation', label: 'Saturation' },
  { key: 'texture', label: 'Texture' }, { key: 'clarity', label: 'Clarity' }, { key: 'dehaze', label: 'Dehaze' },
];
export const maskAdjDefaults = () => Object.fromEntries(MASK_ADJ.map((a) => [a.key, 0]));

const wheel = () => ({ h: 0, s: 0, l: 0 });
export function defaultSettings() {
  return {
    bw: false, wb: 'shot', temp: 0, tint: 0,
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
    curve: { param: { highlights: 0, lights: 0, darks: 0, shadows: 0, s1: 25, s2: 50, s3: 75 }, rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
    hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 0, 0, 0, 0, 0], lum: [0, 0, 0, 0, 0, 0, 0, 0], gray: [0, 0, 0, 0, 0, 0, 0, 0] },
    grade: { shadows: wheel(), mid: wheel(), high: wheel(), global: wheel(), blending: 50, balance: 0 },
    detail: { sharpen: 0, radius: 1, detail: 25, masking: 0, nrLum: 0, nrColor: 0 },
    optics: { vignette: 0, midpoint: 50 },
    effects: { vig: 0, vigMid: 50, vigRound: 0, vigFeather: 50, vigHigh: 0, grain: 0, grainSize: 25, grainRough: 50 },
    crop: { angle: 0, cx: 0.5, cy: 0.5, w: 1, h: 1, aspect: 'original' },
    orient: { rot: 0, flipH: false, flipV: false },
    lut: null, // { asset_id, name, amount } — a .cube profile
    masks: [],
  };
}
export const DEFAULTS = defaultSettings();

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** Only what differs from the defaults (deep). */
export function compact(s, d = DEFAULTS) {
  const out = {};
  for (const k of Object.keys(s || {})) {
    const v = s[k]; const dv = d?.[k];
    if (isObj(v) && isObj(dv)) { const c = compact(v, dv); if (Object.keys(c).length) out[k] = c; }
    else if (JSON.stringify(v) !== JSON.stringify(dv)) out[k] = v;
  }
  return out;
}
/** Defaults with the compact settings laid over them. */
export function expand(c, d = DEFAULTS) {
  const out = clone(d);
  const lay = (o, x) => {
    for (const k of Object.keys(x || {})) {
      if (isObj(x[k]) && isObj(o[k])) lay(o[k], x[k]);
      else o[k] = clone(x[k]);
    }
  };
  lay(out, c);
  return out;
}
export const isEdited = (s) => Object.keys(compact(s)).length > 0;

/** Lays a partial settings object (preset / pasted settings) over full settings. */
export function overlay(full, partial) {
  const out = clone(full);
  const lay = (o, x) => { for (const k of Object.keys(x || {})) { if (isObj(x[k]) && isObj(o[k])) lay(o[k], x[k]); else o[k] = clone(x[k]); } };
  lay(out, partial);
  return out;
}

/** The settings that make sense to copy between photos (not crop, rotation or local masks). */
export function copyable(s) {
  const c = compact(s);
  delete c.crop; delete c.orient; delete c.masks;
  return { ...c, ...resetKeys(s) };
}
// Copying also has to carry "back to default" for groups the source never touched, or pasting wouldn't reset them.
function resetKeys() {
  const d = clone(DEFAULTS);
  delete d.crop; delete d.orient; delete d.masks;
  return Object.fromEntries(Object.keys(d).map((k) => [k, d[k]]));
}
export function copyableFull(s) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (!['crop', 'orient', 'masks'].includes(k)) out[k] = clone(s[k]);
  return out;
}

// ---------------------------------------------------------------- presets

const curve = (pts) => pts.map(([x, y]) => [x / 255, y / 255]);
export const BUILTIN_PRESETS = [
  { group: 'Basic', name: 'Auto-ish punch', s: { contrast: 18, highlights: -30, shadows: 25, whites: 10, blacks: -10, clarity: 10, vibrance: 15 } },
  { group: 'Basic', name: 'Soft & bright', s: { exposure: 0.35, contrast: -15, highlights: -20, shadows: 20, clarity: -10, vibrance: 10 } },
  { group: 'Color', name: 'Vivid', s: { contrast: 20, vibrance: 40, saturation: 10, clarity: 12, dehaze: 6 } },
  { group: 'Color', name: 'Warm sunset', s: { temp: 22, tint: 6, vibrance: 15, grade: { high: { h: 40, s: 25, l: 0 }, shadows: { h: 280, s: 10, l: 0 } } } },
  { group: 'Color', name: 'Cool morning', s: { temp: -18, tint: -2, highlights: -15, grade: { shadows: { h: 210, s: 18, l: 0 } } } },
  { group: 'Film', name: 'Faded film', s: { contrast: -10, curve: { rgb: curve([[0, 32], [64, 72], [192, 196], [255, 240]]) }, saturation: -12, grain: 0, effects: { grain: 25, grainSize: 25, grainRough: 50 }, grade: { shadows: { h: 200, s: 12, l: 0 }, high: { h: 45, s: 12, l: 0 } } } },
  { group: 'Film', name: 'Portra-like', s: { temp: 6, contrast: -6, highlights: -25, shadows: 10, vibrance: -5, hsl: { hue: [0, -6, -10, 0, 0, 0, 0, 0], sat: [-10, -8, -15, -20, 0, -10, 0, 0], lum: [0, 8, 0, 0, 0, 0, 0, 0] }, curve: { rgb: curve([[0, 12], [70, 66], [190, 196], [255, 248]]) }, effects: { grain: 18, grainSize: 20, grainRough: 40 } } },
  { group: 'Film', name: 'Cross process', s: { contrast: 20, curve: { r: curve([[0, 0], [64, 52], [192, 210], [255, 255]]), b: curve([[0, 30], [128, 120], [255, 220]]), g: curve([[0, 0], [128, 136], [255, 255]]) }, saturation: 10 } },
  { group: 'Cinematic', name: 'Teal & orange', s: { contrast: 15, grade: { shadows: { h: 190, s: 35, l: -5 }, high: { h: 35, s: 30, l: 0 }, balance: -10 }, hsl: { hue: [0, -5, 0, 25, 0, -10, 0, 0], sat: [0, 15, 0, -30, 10, 10, 0, 0] }, effects: { vig: -15 } } },
  { group: 'Cinematic', name: 'Moody', s: { exposure: -0.3, contrast: 10, highlights: -40, shadows: -10, saturation: -20, clarity: 15, dehaze: 8, grade: { shadows: { h: 220, s: 20, l: 0 } }, effects: { vig: -25, vigMid: 40, vigFeather: 70 } } },
  { group: 'Cinematic', name: 'Bleach bypass', s: { contrast: 35, saturation: -45, clarity: 25, highlights: -15, blacks: -10 } },
  { group: 'Matte', name: 'Matte', s: { contrast: -12, curve: { rgb: curve([[0, 40], [60, 64], [190, 194], [255, 245]]) }, saturation: -8 } },
  { group: 'Matte', name: 'Matte warm', s: { temp: 10, contrast: -10, curve: { rgb: curve([[0, 36], [128, 130], [255, 242]]) }, grade: { high: { h: 40, s: 15, l: 0 } } } },
  { group: 'B&W', name: 'B&W neutral', s: { bw: true } },
  { group: 'B&W', name: 'B&W high contrast', s: { bw: true, contrast: 45, clarity: 20, whites: 15, blacks: -20, hsl: { gray: [10, 10, 5, -10, -15, -25, -10, 0] } } },
  { group: 'B&W', name: 'B&W soft selenium', s: { bw: true, contrast: -5, grade: { shadows: { h: 280, s: 12, l: 0 }, high: { h: 40, s: 8, l: 0 } }, effects: { grain: 20 } } },
  { group: 'B&W', name: 'B&W infrared', s: { bw: true, contrast: 25, hsl: { gray: [0, 0, 40, 80, 20, -60, 0, 0] }, effects: { grain: 15 } } },
  { group: 'Effects', name: 'Vignette', s: { effects: { vig: -35, vigMid: 35, vigFeather: 70 } } },
  { group: 'Effects', name: 'Grain', s: { effects: { grain: 35, grainSize: 30, grainRough: 60 } } },
  { group: 'Detail', name: 'Sharpen — scenic', s: { detail: { sharpen: 60, radius: 1.2, detail: 30, masking: 20 } } },
  { group: 'Detail', name: 'Sharpen — portrait', s: { detail: { sharpen: 35, radius: 1.4, detail: 15, masking: 60 }, texture: -10 } },
];
BUILTIN_PRESETS.forEach((p, i) => { p.id = `b${i}`; });

// ---------------------------------------------------------------- document

export const emptyCatalog = () => ({ v: 1, photos: [], collections: [] });

export function newPhoto(asset) {
  return {
    id: uid('ph'), asset_id: asset.id, name: asset.name, width: asset.width || null, height: asset.height || null, size: asset.size || null, mime: asset.mime || null,
    settings: defaultSettings(), rating: 0, flag: 0, color_label: null, keywords: [], created: Date.now(), snapshots: [], history: [],
  };
}

/** Saved JSON → working document (full settings). */
export function fromSaved(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    v: 1,
    photos: (d.photos || []).filter((p) => p && p.asset_id).map((p) => ({
      id: p.id || uid('ph'), asset_id: p.asset_id, name: p.name || 'Photo', width: p.width || null, height: p.height || null, size: p.size || null, mime: p.mime || null,
      settings: expand(p.settings), rating: p.rating || 0, flag: p.flag || 0, color_label: p.color_label || null, keywords: p.keywords || [], created: p.created || Date.now(),
      snapshots: p.snapshots || [], history: p.history || [],
    })),
    collections: (d.collections || []).map((c) => ({ id: c.id || uid('c'), name: c.name || 'Collection', photo_ids: c.photo_ids || [] })),
  };
}
/** Working document → JSON to save (compact settings). */
export function toSaved(doc) {
  return {
    v: 1,
    photos: doc.photos.map((p) => ({ ...p, settings: compact(p.settings) })),
    collections: doc.collections,
  };
}

export const COLOR_LABELS = [
  { id: 'red', label: 'Red', key: '6', color: '#e5484d' },
  { id: 'yellow', label: 'Yellow', key: '7', color: '#e8c724' },
  { id: 'green', label: 'Green', key: '8', color: '#46a758' },
  { id: 'blue', label: 'Blue', key: '9', color: '#3e63dd' },
  { id: 'purple', label: 'Purple', key: null, color: '#8e4ec6' },
];
export const RAW_RE = /x-(canon|nikon|sony|adobe-dng|fuji|olympus|panasonic)|\.(cr2|cr3|nef|arw|dng|raf|orf|rw2)$/i;
export const isRaw = (p) => RAW_RE.test(p.mime || '') || RAW_RE.test(p.name || '');

// ---------------------------------------------------------------- geometry
//
// Coordinates: "src" uv is the original file (0..1). "Oriented" is after quarter turns and flips (size W'×H').
// The crop is a rectangle of size (w·W', h·H') centred at (cx, cy) in oriented space, rotated by `angle` degrees.
// Output point q (0..1 across the crop) → oriented px = C + R(angle)·((q − ½)·size) → src uv. All affine, so the
// whole chain is one 2×3 matrix the shader uses per pixel.

export function orientedSize(w, h, o) { return o.rot % 2 ? [h, w] : [w, h]; }

/** Matrix (as [a,b,c,d,e,f]: u = a·x + b·y + c, v = d·x + e·y + f) mapping oriented uv → src uv. */
function orientToSrcM(o) {
  // Undo the flips (done after rotating), then the rotation.
  let m = [1, 0, 0, 0, 1, 0];
  const fh = o.flipH ? [-1, 0, 1, 0, 1, 0] : [1, 0, 0, 0, 1, 0];
  const fv = o.flipV ? [1, 0, 0, 0, -1, 1] : [1, 0, 0, 0, 1, 0];
  const rots = [[1, 0, 0, 0, 1, 0], [0, 1, 0, -1, 0, 1], [-1, 0, 1, 0, -1, 1], [0, -1, 1, 1, 0, 0]];
  m = mul(fv, fh);
  return mul(rots[((o.rot % 4) + 4) % 4], m);
}
/** Composition: (A ∘ B)(p) = A(B(p)). */
export function mul(A, B) {
  return [
    A[0] * B[0] + A[1] * B[3], A[0] * B[1] + A[1] * B[4], A[0] * B[2] + A[1] * B[5] + A[2],
    A[3] * B[0] + A[4] * B[3], A[3] * B[1] + A[4] * B[4], A[3] * B[2] + A[4] * B[5] + A[5],
  ];
}
export function inv(M) {
  const [a, b, c, d, e, f] = M;
  const det = a * e - b * d || 1e-12;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}
export const apply = (M, x, y) => [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]];

/**
 * Output frame for the settings: { M: q → src uv, outW, outH } where out size is in source pixels.
 * full: show the whole oriented image rotated by the angle (crop mode), instead of the crop.
 */
export function frameOf(srcW, srcH, s, { full = false } = {}) {
  const [W, H] = orientedSize(srcW, srcH, s.orient);
  const c = s.crop;
  const a = (-c.angle * Math.PI) / 180; // positive angles turn the picture clockwise
  let cx; let cy; let ow; let oh;
  if (full) {
    // Bounding box of the image rotated about its centre.
    const cos = Math.abs(Math.cos(a)); const sin = Math.abs(Math.sin(a));
    ow = W * cos + H * sin; oh = W * sin + H * cos; cx = W / 2; cy = H / 2;
  } else { ow = c.w * W; oh = c.h * H; cx = c.cx * W; cy = c.cy * H; }
  const co = Math.cos(a); const si = Math.sin(a);
  // q → oriented px: p = C + R·((q − ½)·size)  (R rotates the sampling grid, so the picture turns the other way)
  const toPx = [co * ow, -si * oh, cx - 0.5 * (co * ow - si * oh), si * ow, co * oh, cy - 0.5 * (si * ow + co * oh)];
  const pxToUv = [1 / W, 0, 0, 0, 1 / H, 0];
  const M = mul(orientToSrcM(s.orient), mul(pxToUv, toPx));
  return { M, outW: ow, outH: oh, W, H };
}

/** In crop mode the full frame is shown; this maps the crop rectangle into that frame's q space (0..1). */
export function cropRectInFull(srcW, srcH, s) {
  const full = frameOf(srcW, srcH, s, { full: true });
  const crop = frameOf(srcW, srcH, s);
  // crop q → src → full q
  const T = mul(inv(full.M), crop.M);
  const [x0, y0] = apply(T, 0, 0); const [x1, y1] = apply(T, 1, 1);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), full };
}

/** Is the rotated crop fully inside the oriented image? */
function cropInside(W, H, c) {
  const a = (-c.angle * Math.PI) / 180; const co = Math.cos(a); const si = Math.sin(a);
  const hw = (c.w * W) / 2; const hh = (c.h * H) / 2;
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = c.cx * W + co * sx * hw - si * sy * hh; const y = c.cy * H + si * sx * hw + co * sy * hh;
    if (x < -0.01 || y < -0.01 || x > W + 0.01 || y > H + 0.01) return false;
  }
  return true;
}
/** Keeps the crop inside the (rotated) image: first nudges the centre in, then shrinks if it still doesn't fit. */
export function constrainCrop(srcW, srcH, s, c) {
  const [W, H] = orientedSize(srcW, srcH, s.orient);
  let out = { ...c, w: clamp(c.w, 0.02, 1), h: clamp(c.h, 0.02, 1) };
  if (cropInside(W, H, out)) return out;
  // Pull the centre towards the middle.
  for (let i = 1; i <= 20 && !cropInside(W, H, out); i++) {
    const t = i / 20;
    out = { ...out, cx: c.cx + (0.5 - c.cx) * t, cy: c.cy + (0.5 - c.cy) * t };
  }
  if (cropInside(W, H, out)) return out;
  let lo = 0; let hi = 1;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (cropInside(W, H, { ...out, w: out.w * m, h: out.h * m })) lo = m; else hi = m; }
  return { ...out, w: out.w * lo, h: out.h * lo };
}

export const ASPECTS = [
  { id: 'original', label: 'As shot' }, { id: 'free', label: 'Custom' }, { id: '1:1', label: '1 × 1' }, { id: '4:5', label: '4 × 5 / 8 × 10' },
  { id: '5:7', label: '5 × 7' }, { id: '2:3', label: '2 × 3 / 4 × 6' }, { id: '3:4', label: '3 × 4' }, { id: '16:9', label: '16 × 9' }, { id: '16:10', label: '16 × 10' },
];
/** Aspect ratio (w/h in pixels) for an aspect id, matching the crop's current orientation (portrait/landscape). */
export function aspectValue(id, W, H, cur) {
  if (id === 'free') return null;
  if (id === 'original') return W / H;
  const [a, b] = id.split(':').map(Number);
  const r = Math.max(a, b) / Math.min(a, b);
  return cur >= 1 ? r : 1 / r;
}
/** Sets the crop to the largest rectangle of aspect r centred where it is now. */
export function cropToAspect(srcW, srcH, s, r) {
  const [W, H] = orientedSize(srcW, srcH, s.orient);
  const c = s.crop;
  let pw = c.w * W; let ph = c.h * H;
  if (pw / ph > r) pw = ph * r; else ph = pw / r;
  // Grow to the max that fits.
  const scale = Math.min(W / pw, H / ph);
  return constrainCrop(srcW, srcH, s, { ...c, w: (pw * scale) / W, h: (ph * scale) / H });
}

// ---------------------------------------------------------------- curves

/** Monotone cubic (Fritsch–Carlson) through the points; returns f(x). */
export function monotone(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return (x) => x;
  const dx = []; const m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = Math.max(1e-6, p[i + 1][0] - p[i][0]); m[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  t[n - 1] = m[n - 2];
  return (x) => {
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0;
    while (i < n - 2 && x > p[i + 1][0]) i++;
    const h = dx[i]; const u = (x - p[i][0]) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1; const h10 = u ** 3 - 2 * u ** 2 + u; const h01 = -2 * u ** 3 + 3 * u ** 2; const h11 = u ** 3 - u ** 2;
    return h00 * p[i][1] + h10 * h * t[i] + h01 * p[i + 1][1] + h11 * h * t[i + 1];
  };
}

/** Parametric tone curve: four region sliders with three movable split points. */
export function parametric(pc) {
  const s1 = pc.s1 / 100; const s2 = pc.s2 / 100; const s3 = pc.s3 / 100;
  const bump = (x, a, b) => (x <= a || x >= b ? 0 : Math.sin((Math.PI * (x - a)) / (b - a)) ** 2);
  const amt = (v) => (v / 100) * 0.22;
  return (x) => x
    + amt(pc.shadows) * bump(x, 0, s2) * (1 - x)
    + amt(pc.darks) * bump(x, s1 * 0.5, s3)
    + amt(pc.lights) * bump(x, s1, (1 + s3) / 2 + 0.25)
    + amt(pc.highlights) * bump(x, s2, 1.0001) * x;
}
export const curveIsIdentity = (pts) => pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;

/** The combined tone curve as a Float32Array LUT (n entries × RGBA). */
export function curveLut(c, n = 1024) {
  const par = parametric(c.param); const fm = monotone(c.rgb); const fr = monotone(c.r); const fg = monotone(c.g); const fb = monotone(c.b);
  const out = new Float32Array(n * 4);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let y = clamp(par(x));
    y = Math.max(prev, y); prev = y; // keep the parametric part monotonic
    const m = clamp(fm(y));
    out[i * 4] = clamp(fr(m)); out[i * 4 + 1] = clamp(fg(m)); out[i * 4 + 2] = clamp(fb(m)); out[i * 4 + 3] = m;
  }
  return out;
}

// ---------------------------------------------------------------- white balance

// Temperature / tint as channel gains (the same formula as the shader).
export const KT = 0.0055; export const KTINT = 0.0045;
/** temp/tint that make a linear RGB sample neutral. */
export function neutralize(r, g, b) {
  const R = Math.max(1e-4, r); const G = Math.max(1e-4, g); const B = Math.max(1e-4, b);
  const temp = Math.log(B / R) / (2 * KT);
  const tint = Math.log(G / Math.sqrt(R * B)) / KTINT;
  return { temp: Math.round(clamp(temp, -100, 100)), tint: Math.round(clamp(tint, -100, 100)) };
}
export const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// ---------------------------------------------------------------- filters & sorting

export function filterPhotos(photos, f, collections) {
  const coll = f.collection && f.collection !== 'all' ? collections.find((c) => c.id === f.collection) : null;
  const q = (f.text || '').trim().toLowerCase();
  return photos.filter((p) => {
    if (coll && !coll.photo_ids.includes(p.id)) return false;
    if (f.rating > 0) {
      if (f.ratingOp === 'eq' ? p.rating !== f.rating : f.ratingOp === 'lte' ? p.rating > f.rating : p.rating < f.rating) return false;
    }
    if (f.flag === 'picked' && p.flag !== 1) return false;
    if (f.flag === 'rejected' && p.flag !== -1) return false;
    if (f.flag === 'unflagged' && p.flag !== 0) return false;
    if (f.flag === 'notrejected' && p.flag === -1) return false;
    if (f.label && f.label !== 'any' && (f.label === 'none' ? p.color_label : p.color_label !== f.label)) return false;
    if (f.edited === 'edited' && !isEdited(p.settings)) return false;
    if (f.edited === 'unedited' && isEdited(p.settings)) return false;
    if (q && !p.name.toLowerCase().includes(q) && !p.keywords.some((k) => k.toLowerCase().includes(q))) return false;
    return true;
  });
}
export const SORTS = [
  { id: 'added', label: 'Added order' }, { id: 'name', label: 'File name' }, { id: 'rating', label: 'Rating' },
  { id: 'flag', label: 'Pick' }, { id: 'label', label: 'Colour label' }, { id: 'size', label: 'File size' }, { id: 'pixels', label: 'Dimensions' },
];
export function sortPhotos(list, by, desc) {
  const L = COLOR_LABELS.map((c) => c.id);
  const key = {
    added: (p) => p.created, name: (p) => p.name.toLowerCase(), rating: (p) => p.rating, flag: (p) => p.flag,
    label: (p) => (p.color_label ? L.indexOf(p.color_label) : 99), size: (p) => p.size || 0, pixels: (p) => (p.width || 0) * (p.height || 0),
  }[by] || ((p) => p.created);
  const out = list.map((p, i) => [p, i]).sort((a, b) => {
    const x = key(a[0]); const y = key(b[0]);
    return (x < y ? -1 : x > y ? 1 : a[1] - b[1]) * (desc ? -1 : 1);
  });
  return out.map((x) => x[0]);
}

/** Full-frame q (crop mode) → oriented uv (0..1). */
export function fullQToOriented(srcW, srcH, s, qx, qy) {
  const [W, H] = orientedSize(srcW, srcH, s.orient);
  const f = frameOf(srcW, srcH, s, { full: true });
  const a = (-s.crop.angle * Math.PI) / 180; const co = Math.cos(a); const si = Math.sin(a);
  const dx = (qx - 0.5) * f.outW; const dy = (qy - 0.5) * f.outH;
  return [(W / 2 + co * dx - si * dy) / W, (H / 2 + si * dx + co * dy) / H];
}
/** Crop rectangle given in full-frame q space → crop settings (keeps angle). */
export function cropFromFullRect(srcW, srcH, s, r) {
  const [W, H] = orientedSize(srcW, srcH, s.orient);
  const f = frameOf(srcW, srcH, s, { full: true });
  const [cx, cy] = fullQToOriented(srcW, srcH, s, r.x + r.w / 2, r.y + r.h / 2);
  return { ...s.crop, cx, cy, w: (r.w * f.outW) / W, h: (r.h * f.outH) / H };
}
