// Colour helpers shared by every app. Colours are usually stored as CSS strings: "#rrggbb" or "#rrggbbaa".
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** "#rgb", "#rrggbb", "#rrggbbaa", "rgb()/rgba()" → { r, g, b, a } (0..255, alpha 0..1). */
export function parse(c) {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  if (typeof c === 'object') return { r: c.r ?? 0, g: c.g ?? 0, b: c.b ?? 0, a: c.a ?? 1 };
  let s = String(c).trim();
  if (s.startsWith('#')) {
    s = s.slice(1);
    if (s.length === 3 || s.length === 4) s = [...s].map((x) => x + x).join('');
    const n = (i) => parseInt(s.slice(i, i + 2), 16);
    return { r: n(0) || 0, g: n(2) || 0, b: n(4) || 0, a: s.length === 8 ? n(6) / 255 : 1 };
  }
  const m = /rgba?\(([^)]+)\)/i.exec(s);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x)));
    return { r, g, b, a: a > 1 ? a / 255 : a };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}
const h2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
export const toHex = ({ r, g, b, a = 1 }, withAlpha = a < 1) => `#${h2(r)}${h2(g)}${h2(b)}${withAlpha ? h2(a * 255) : ''}`;
export const toCss = (c) => { const { r, g, b, a } = parse(c); return a >= 1 ? toHex({ r, g, b }) : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`; };
export const withAlpha = (c, a) => toHex({ ...parse(c), a }, a < 1);

export function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: max ? d / max : 0, v: max };
}
export function hsvToRgb({ h, s, v }) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 };
}
export function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2; const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l };
}
export function hslToRgb({ h, s, l }) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}
/** CMYK (0..1) as used for print; a simple conversion without colour profiles. */
export function rgbToCmyk({ r, g, b }) {
  const k = 1 - Math.max(r, g, b) / 255;
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
  return { c: (1 - r / 255 - k) / (1 - k), m: (1 - g / 255 - k) / (1 - k), y: (1 - b / 255 - k) / (1 - k), k };
}
export const cmykToRgb = ({ c, m, y, k }) => ({ r: 255 * (1 - c) * (1 - k), g: 255 * (1 - m) * (1 - k), b: 255 * (1 - y) * (1 - k) });

/** Relative luminance (WCAG) and contrast ratio between two colours. */
export function luminance(c) {
  const { r, g, b } = parse(c);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const readableOn = (bg) => (luminance(bg) > 0.45 ? '#111111' : '#ffffff');

export const mix = (a, b, t) => { const p = parse(a); const q = parse(b); return toHex({ r: p.r + (q.r - p.r) * t, g: p.g + (q.g - p.g) * t, b: p.b + (q.b - p.b) * t, a: p.a + (q.a - p.a) * t }); };

/** Colour harmony rules (Color app, swatch generators): returns hex colours around a base. */
export function harmony(base, rule) {
  const { h, s, v } = rgbToHsv(parse(base));
  const at = (dh, ds = 0, dv = 0) => toHex(hsvToRgb({ h: (h + dh + 360) % 360, s: clamp(s + ds), v: clamp(v + dv) }));
  switch (rule) {
    case 'analogous': return [at(-30), at(-15), at(0), at(15), at(30)];
    case 'monochromatic': return [at(0, 0, -0.45), at(0, -0.3, -0.15), at(0), at(0, -0.4, 0.2), at(0, -0.7, 0.3)];
    case 'triad': return [at(0), at(120), at(240), at(120, -0.3, 0.1), at(240, -0.3, 0.1)];
    case 'complementary': return [at(0, 0, -0.3), at(0, -0.3, 0.1), at(0), at(180, -0.3, 0.1), at(180)];
    case 'split': return [at(0), at(150), at(210), at(150, -0.3, 0.15), at(210, -0.3, 0.15)];
    case 'square': return [at(0), at(90), at(180), at(270), at(0, -0.4, 0.2)];
    case 'compound': return [at(0), at(30), at(180), at(150), at(0, -0.4, 0.2)];
    case 'shades': return [at(0, 0, -0.6), at(0, 0, -0.4), at(0, 0, -0.2), at(0), at(0, 0, 0.2)];
    default: return [at(0)];
  }
}

/** Main colours of an image (ImageData or canvas), k-means on a sample. Returns hex strings, most common first. */
export function extractPalette(source, k = 5) {
  const data = source.data ? source : source.getContext('2d').getImageData(0, 0, source.width, source.height);
  const px = [];
  const step = Math.max(1, Math.floor((data.data.length / 4) / 4000));
  for (let i = 0; i < data.data.length; i += 4 * step) if (data.data[i + 3] > 128) px.push([data.data[i], data.data[i + 1], data.data[i + 2]]);
  if (!px.length) return [];
  let centers = Array.from({ length: k }, (_, i) => px[Math.floor((i + 0.5) * px.length / k)]);
  let groups = [];
  for (let iter = 0; iter < 12; iter++) {
    groups = centers.map(() => []);
    for (const p of px) {
      let best = 0; let bd = Infinity;
      centers.forEach((c, i) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = i; } });
      groups[best].push(p);
    }
    centers = groups.map((g, i) => (g.length ? [0, 1, 2].map((j) => g.reduce((n, p) => n + p[j], 0) / g.length) : centers[i]));
  }
  return centers.map((c, i) => ({ hex: toHex({ r: c[0], g: c[1], b: c[2] }), n: groups[i].length })).sort((a, b) => b.n - a.n).map((x) => x.hex);
}

/** Named swatches every colour picker offers. */
export const BASIC_SWATCHES = ['#000000', '#444444', '#888888', '#cccccc', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0ff', '#5AB4FF', '#5856d6', '#8B7CFF', '#af52de', '#FF8FB1', '#ff2d55', '#a2845e'];
