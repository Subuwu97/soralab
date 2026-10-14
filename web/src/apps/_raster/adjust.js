// Non-destructive adjustments. Each kind has defaults and an apply(data, settings) that changes RGBA pixels in place.
// Most are turned into per-channel lookup tables first, so a 4000×4000 composite stays quick.
import { parse, rgbToHsl, hslToRgb } from '../../lib/color.js';

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export const ADJUSTMENTS = {
  brightness: { label: 'Brightness/Contrast', icon: 'sun', defaults: { brightness: 0, contrast: 0 } },
  levels: { label: 'Levels', icon: 'histogram', defaults: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255, channel: 'rgb' } },
  curves: { label: 'Curves', icon: 'graph', defaults: { points: [[0, 0], [255, 255]], r: null, g: null, b: null } },
  exposure: { label: 'Exposure', icon: 'contrast', defaults: { exposure: 0, offset: 0, gamma: 1 } },
  vibrance: { label: 'Vibrance', icon: 'sparkles', defaults: { vibrance: 0, saturation: 0 } },
  hueSat: { label: 'Hue/Saturation', icon: 'palette', defaults: { hue: 0, saturation: 0, lightness: 0, colorize: false } },
  colorBalance: { label: 'Color Balance', icon: 'sliders', defaults: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserve: true } },
  bw: { label: 'Black & White', icon: 'contrast', defaults: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: '#e0c89a' } },
  photoFilter: { label: 'Photo Filter', icon: 'temperature', defaults: { color: '#ec8a00', density: 25, preserve: true } },
  invert: { label: 'Invert', icon: 'adjust', defaults: {} },
  posterize: { label: 'Posterize', icon: 'grid', defaults: { levels: 4 } },
  threshold: { label: 'Threshold', icon: 'contrast', defaults: { level: 128 } },
  gradientMap: { label: 'Gradient Map', icon: 'gradient', defaults: { colors: ['#000000', '#ffffff'], reverse: false } },
};
export const ADJUST_ORDER = ['brightness', 'levels', 'curves', 'exposure', 'vibrance', 'hueSat', 'colorBalance', 'bw', 'photoFilter', 'invert', 'posterize', 'threshold', 'gradientMap'];
export const defaultsFor = (kind) => ({ kind, ...structuredClone(ADJUSTMENTS[kind].defaults) });

// ---------------------------------------------------------------- curves

/** Monotone cubic interpolation through [[x,y]…] (0..255) → 256-entry table. */
export function curveLut(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const lut = new Uint8ClampedArray(256);
  if (p.length < 2) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
  const n = p.length; const dx = []; const m = []; const d = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = Math.max(1e-6, p[i + 1][0] - p[i][0]); d[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i]; const b = m[i + 1] / d[i]; const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let k = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= p[0][0]) { lut[x] = p[0][1]; continue; }
    if (x >= p[n - 1][0]) { lut[x] = p[n - 1][1]; continue; }
    while (k < n - 2 && x > p[k + 1][0]) k++;
    const h = dx[k]; const t = (x - p[k][0]) / h; const t2 = t * t; const t3 = t2 * t;
    lut[x] = (2 * t3 - 3 * t2 + 1) * p[k][1] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * p[k + 1][1] + (t3 - t2) * h * m[k + 1];
  }
  return lut;
}

const identity = () => { const l = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) l[i] = i; return l; };
function applyLuts(data, lr, lg, lb) {
  for (let i = 0; i < data.length; i += 4) { if (!data[i + 3]) continue; data[i] = lr[data[i]]; data[i + 1] = lg[data[i + 1]]; data[i + 2] = lb[data[i + 2]]; }
}
function levelsLut(s) {
  const l = new Uint8ClampedArray(256);
  const range = Math.max(1, s.inWhite - s.inBlack);
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, Math.max(0, (i - s.inBlack) / range)) ** (1 / Math.max(0.01, s.gamma));
    l[i] = s.outBlack + v * (s.outWhite - s.outBlack);
  }
  return l;
}

// LUTs depend only on settings: cache them by the settings object (they're immutable).
const lutCache = new WeakMap();
function luts(s, make) { let v = lutCache.get(s); if (!v) { v = make(); lutCache.set(s, v); } return v; }

export function applyAdjustment(data, s) {
  switch (s.kind) {
    case 'brightness': {
      const [l] = luts(s, () => {
        const t = new Uint8ClampedArray(256);
        const b = s.brightness / 100; const c = s.contrast / 100;
        const k = c >= 0 ? 1 / Math.max(0.01, 1 - c * 0.99) : 1 + c;
        for (let i = 0; i < 256; i++) {
          let v = i / 255;
          v = b >= 0 ? v + (1 - v) * b * 0.6 * (1 - v * 0.3) : v * (1 + b * 0.6); // keeps highlights from clipping hard
          v = (v - 0.5) * k + 0.5;
          t[i] = v * 255;
        }
        return [t];
      });
      applyLuts(data, l, l, l); return;
    }
    case 'levels': {
      const [lr, lg, lb] = luts(s, () => {
        const l = levelsLut(s); const id = identity();
        return s.channel === 'r' ? [l, id, id] : s.channel === 'g' ? [id, l, id] : s.channel === 'b' ? [id, id, l] : [l, l, l];
      });
      applyLuts(data, lr, lg, lb); return;
    }
    case 'curves': {
      const [lr, lg, lb] = luts(s, () => {
        const m = curveLut(s.points);
        const ch = (pts) => { const c = pts ? curveLut(pts) : identity(); const o = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) o[i] = m[c[i]]; return o; };
        return [ch(s.r), ch(s.g), ch(s.b)];
      });
      applyLuts(data, lr, lg, lb); return;
    }
    case 'exposure': {
      const [l] = luts(s, () => {
        const t = new Uint8ClampedArray(256); const k = 2 ** s.exposure;
        for (let i = 0; i < 256; i++) { const lin = (i / 255) ** 2.2; let v = lin * k + s.offset; v = Math.max(0, v) ** (1 / 2.2); v **= 1 / Math.max(0.01, s.gamma); t[i] = v * 255; }
        return [t];
      });
      applyLuts(data, l, l, l); return;
    }
    case 'invert': for (let i = 0; i < data.length; i += 4) { data[i] = 255 - data[i]; data[i + 1] = 255 - data[i + 1]; data[i + 2] = 255 - data[i + 2]; } return;
    case 'posterize': {
      const [l] = luts(s, () => { const t = new Uint8ClampedArray(256); const n = Math.max(2, s.levels) - 1; for (let i = 0; i < 256; i++) t[i] = Math.round(Math.round((i / 255) * n) / n * 255); return [t]; });
      applyLuts(data, l, l, l); return;
    }
    case 'threshold':
      for (let i = 0; i < data.length; i += 4) { const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; data[i] = data[i + 1] = data[i + 2] = y >= s.level ? 255 : 0; }
      return;
    case 'gradientMap': {
      const [map] = luts(s, () => {
        const cols = (s.reverse ? [...s.colors].reverse() : s.colors).map(parse);
        const m = new Uint8ClampedArray(256 * 3);
        for (let i = 0; i < 256; i++) {
          const t = (i / 255) * (cols.length - 1); const k = Math.min(cols.length - 2, Math.floor(t)); const f = t - k;
          const a = cols[k]; const b = cols[k + 1];
          m[i * 3] = a.r + (b.r - a.r) * f; m[i * 3 + 1] = a.g + (b.g - a.g) * f; m[i * 3 + 2] = a.b + (b.b - a.b) * f;
        }
        return [m];
      });
      for (let i = 0; i < data.length; i += 4) { const y = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0; data[i] = map[y * 3]; data[i + 1] = map[y * 3 + 1]; data[i + 2] = map[y * 3 + 2]; }
      return;
    }
    case 'vibrance': {
      const vib = s.vibrance / 100; const sat = s.saturation / 100;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
        const mx = Math.max(r, g, b); const avg = (r + g + b) / 3;
        // vibrance pushes muted colours more than saturated ones
        const amt = sat + vib * (1 - (mx - Math.min(r, g, b)) / 255) * 1.5;
        data[i] = clamp255(r + (r - avg) * amt); data[i + 1] = clamp255(g + (g - avg) * amt); data[i + 2] = clamp255(b + (b - avg) * amt);
      }
      return;
    }
    case 'hueSat': {
      const dh = s.hue; const ds = s.saturation / 100; const dl = s.lightness / 100;
      for (let i = 0; i < data.length; i += 4) {
        if (!data[i + 3]) continue;
        const hsl = rgbToHsl({ r: data[i], g: data[i + 1], b: data[i + 2] });
        if (s.colorize) { hsl.h = (dh + 360) % 360; hsl.s = Math.max(0, Math.min(1, 0.25 + ds * 0.75)); }
        else { hsl.h = (hsl.h + dh + 360) % 360; hsl.s = Math.max(0, Math.min(1, ds >= 0 ? hsl.s + (1 - hsl.s) * ds * hsl.s * 1.5 : hsl.s * (1 + ds))); }
        hsl.l = dl >= 0 ? hsl.l + (1 - hsl.l) * dl : hsl.l * (1 + dl);
        const o = hslToRgb(hsl);
        data[i] = o.r; data[i + 1] = o.g; data[i + 2] = o.b;
      }
      return;
    }
    case 'colorBalance': {
      // each tonal range shifts the channels, weighted by how much a pixel belongs to that range
      const sh = s.shadows; const mi = s.midtones; const hi = s.highlights;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
        const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const ws = Math.max(0, 1 - L * 3) * 0.7 + Math.max(0, 0.5 - L) * 0.6; const wh = Math.max(0, L * 3 - 2) * 0.7 + Math.max(0, L - 0.5) * 0.6; const wm = 1 - Math.abs(L - 0.5) * 2;
        let nr = r + (sh[0] * ws + mi[0] * wm + hi[0] * wh) * 1.28;
        let ng = g + (sh[1] * ws + mi[1] * wm + hi[1] * wh) * 1.28;
        let nb = b + (sh[2] * ws + mi[2] * wm + hi[2] * wh) * 1.28;
        if (s.preserve) { const L2 = 0.299 * nr + 0.587 * ng + 0.114 * nb; const k = L * 255 - L2; nr += k; ng += k; nb += k; }
        data[i] = clamp255(nr); data[i + 1] = clamp255(ng); data[i + 2] = clamp255(nb);
      }
      return;
    }
    case 'bw': {
      // Photoshop's method: grey = min + (mid−min)·secondary + (max−mid)·primary, using the hue sliders.
      const w = { r: s.reds / 100, y: s.yellows / 100, g: s.greens / 100, c: s.cyans / 100, b: s.blues / 100, m: s.magentas / 100 };
      const tint = s.tint ? parse(s.tintColor) : null;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
        let v;
        if (r >= g && g >= b) v = b + (g - b) * w.y + (r - g) * w.r;
        else if (r >= b && b >= g) v = g + (b - g) * w.m + (r - b) * w.r;
        else if (g >= r && r >= b) v = b + (r - b) * w.y + (g - r) * w.g;
        else if (g >= b && b >= r) v = r + (b - r) * w.c + (g - b) * w.g;
        else if (b >= r && r >= g) v = g + (r - g) * w.m + (b - r) * w.b;
        else v = r + (g - r) * w.c + (b - g) * w.b;
        v = clamp255(v);
        if (tint) { const t = v / 255; const ov = (c) => (t < 0.5 ? 2 * t * c : 255 - 2 * (1 - t) * (255 - c)); data[i] = ov(tint.r); data[i + 1] = ov(tint.g); data[i + 2] = ov(tint.b); }
        else data[i] = data[i + 1] = data[i + 2] = v;
      }
      return;
    }
    case 'photoFilter': {
      const c = parse(s.color); const d = s.density / 100;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
        // a multiply-style coloured filter, mixed in by density
        let nr = r * (1 - d) + (r * c.r / 255) * d; let ng = g * (1 - d) + (g * c.g / 255) * d; let nb = b * (1 - d) + (b * c.b / 255) * d;
        if (s.preserve) { const L = 0.299 * r + 0.587 * g + 0.114 * b; const L2 = 0.299 * nr + 0.587 * ng + 0.114 * nb; const k = L2 > 0 ? L / L2 : 1; nr *= k; ng *= k; nb *= k; }
        data[i] = clamp255(nr); data[i + 1] = clamp255(ng); data[i + 2] = clamp255(nb);
      }
      return;
    }
    default:
  }
}

/** Histogram of luminance (or one channel) for Levels/Curves: 256 counts. */
export function histogram(data, channel = 'rgb') {
  const h = new Uint32Array(256);
  const step = Math.max(1, Math.floor(data.length / 4 / 400000)) * 4;
  for (let i = 0; i < data.length; i += step) {
    if (!data[i + 3]) continue;
    const v = channel === 'r' ? data[i] : channel === 'g' ? data[i + 1] : channel === 'b' ? data[i + 2] : (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    h[v]++;
  }
  return h;
}
