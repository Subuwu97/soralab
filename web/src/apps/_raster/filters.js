// Destructive filters (Filter menu). Each is a pure function on ImageData-like { width, height, data } so it can run
// in a worker (filters.worker.js) and keep the editor responsive on big images. Settings come from FILTERS[id].params.

export const FILTERS = {
  gaussian: { label: 'Gaussian Blur…', group: 'Blur', params: [{ key: 'radius', label: 'Radius', min: 0.5, max: 100, step: 0.5, default: 4, unit: 'px' }] },
  motion: { label: 'Motion Blur…', group: 'Blur', params: [{ key: 'angle', label: 'Angle', min: -180, max: 180, default: 0, unit: '°' }, { key: 'distance', label: 'Distance', min: 1, max: 300, default: 20, unit: 'px' }] },
  unsharp: { label: 'Unsharp Mask…', group: 'Sharpen', params: [{ key: 'amount', label: 'Amount', min: 1, max: 500, default: 100, unit: '%' }, { key: 'radius', label: 'Radius', min: 0.5, max: 50, step: 0.5, default: 1.5, unit: 'px' }, { key: 'threshold', label: 'Threshold', min: 0, max: 255, default: 0 }] },
  sharpen: { label: 'Sharpen', group: 'Sharpen', params: [] },
  addNoise: { label: 'Add Noise…', group: 'Noise', params: [{ key: 'amount', label: 'Amount', min: 0, max: 100, default: 12, unit: '%' }, { key: 'mono', label: 'Monochromatic', type: 'toggle', default: true }] },
  reduceNoise: { label: 'Reduce Noise…', group: 'Noise', params: [{ key: 'strength', label: 'Strength', min: 1, max: 10, default: 5 }, { key: 'detail', label: 'Preserve details', min: 0, max: 100, default: 40, unit: '%' }] },
  median: { label: 'Median…', group: 'Noise', params: [{ key: 'radius', label: 'Radius', min: 1, max: 6, default: 1, unit: 'px' }] },
  pixelate: { label: 'Mosaic…', group: 'Pixelate', params: [{ key: 'size', label: 'Cell size', min: 2, max: 200, default: 12, unit: 'px' }] },
  halftone: { label: 'Color Halftone…', group: 'Pixelate', params: [{ key: 'size', label: 'Dot size', min: 3, max: 60, default: 8, unit: 'px' }] },
  emboss: { label: 'Emboss…', group: 'Stylize', params: [{ key: 'angle', label: 'Angle', min: -180, max: 180, default: 135, unit: '°' }, { key: 'height', label: 'Height', min: 1, max: 10, default: 2 }, { key: 'amount', label: 'Amount', min: 1, max: 500, default: 100, unit: '%' }] },
  findEdges: { label: 'Find Edges', group: 'Stylize', params: [] },
  posterize: { label: 'Posterize…', group: 'Stylize', params: [{ key: 'levels', label: 'Levels', min: 2, max: 32, default: 5 }] },
  solarize: { label: 'Solarize', group: 'Stylize', params: [] },
  vignette: { label: 'Vignette…', group: 'Render', params: [{ key: 'amount', label: 'Amount', min: -100, max: 100, default: -50, unit: '%' }, { key: 'size', label: 'Midpoint', min: 0, max: 100, default: 50, unit: '%' }, { key: 'softness', label: 'Feather', min: 1, max: 100, default: 50, unit: '%' }] },
  oilPaint: { label: 'Oil Paint…', group: 'Artistic', params: [{ key: 'radius', label: 'Brush size', min: 1, max: 10, default: 4 }, { key: 'levels', label: 'Detail', min: 4, max: 40, default: 20 }] },
  sketch: { label: 'Pencil Sketch…', group: 'Artistic', params: [{ key: 'radius', label: 'Stroke width', min: 1, max: 30, default: 8, unit: 'px' }, { key: 'contrast', label: 'Contrast', min: 0, max: 100, default: 40, unit: '%' }] },
  cutout: { label: 'Cutout…', group: 'Artistic', params: [{ key: 'levels', label: 'Number of levels', min: 2, max: 8, default: 4 }, { key: 'smooth', label: 'Edge simplicity', min: 1, max: 20, default: 4 }] },
  glow: { label: 'Diffuse Glow…', group: 'Artistic', params: [{ key: 'radius', label: 'Glow radius', min: 1, max: 60, default: 12, unit: 'px' }, { key: 'amount', label: 'Amount', min: 0, max: 100, default: 50, unit: '%' }] },
};
export const FILTER_GROUPS = ['Blur', 'Sharpen', 'Noise', 'Pixelate', 'Stylize', 'Render', 'Artistic'];
export const filterDefaults = (id) => Object.fromEntries(FILTERS[id].params.map((p) => [p.key, p.default]));

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Blur working on premultiplied alpha so transparent edges don't go dark.
function premul(d) { for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; d[i] *= a; d[i + 1] *= a; d[i + 2] *= a; } }
function unpremul(d) { for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a && a < 255) { const k = 255 / a; d[i] = Math.min(255, d[i] * k); d[i + 1] = Math.min(255, d[i + 1] * k); d[i + 2] = Math.min(255, d[i + 2] * k); } } }

/** Box blur, one direction, all 4 channels, running sum (O(n) whatever the radius). */
function boxPass(src, dst, w, h, r, horizontal) {
  const n = horizontal ? w : h; const lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const div = r * 2 + 1;
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w * 4 : l * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      const at = (i) => src[base + Math.min(n - 1, Math.max(0, i)) * step + c];
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < n; i++) {
        dst[base + i * step + c] = sum / div;
        sum += at(i + r + 1) - at(i - r);
      }
    }
  }
}
function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}
export function gaussianInPlace(d, w, h, radius) {
  if (radius <= 0) return;
  premul(d);
  const tmp = new Float32Array(d.length); const f = Float32Array.from(d);
  for (const r of boxesForGauss(radius / 2)) {
    const rr = Math.max(0, Math.round(r));
    if (!rr) continue;
    boxPass(f, tmp, w, h, rr, true); boxPass(tmp, f, w, h, rr, false);
  }
  for (let i = 0; i < d.length; i++) d[i] = f[i];
  unpremul(d);
}

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

export function applyFilter(id, img, p) {
  const { width: w, height: h, data: d } = img;
  switch (id) {
    case 'gaussian': gaussianInPlace(d, w, h, p.radius); break;
    case 'motion': {
      const src = Uint8ClampedArray.from(d); premul(src);
      const a = p.angle * Math.PI / 180; const dx = Math.cos(a); const dy = -Math.sin(a);
      const n = Math.max(2, Math.min(64, Math.round(p.distance)));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0; let g = 0; let b = 0; let al = 0;
        for (let k = 0; k < n; k++) {
          const t = (k / (n - 1) - 0.5) * p.distance;
          const sx = Math.min(w - 1, Math.max(0, Math.round(x + dx * t))); const sy = Math.min(h - 1, Math.max(0, Math.round(y + dy * t)));
          const i = (sy * w + sx) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; al += src[i + 3];
        }
        const i = (y * w + x) * 4; d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n; d[i + 3] = al / n;
      }
      unpremul(d);
      break;
    }
    case 'unsharp': {
      const bl = Uint8ClampedArray.from(d); gaussianInPlace(bl, w, h, p.radius);
      const k = p.amount / 100;
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) {
        const diff = d[i + c] - bl[i + c];
        if (Math.abs(diff) >= p.threshold) d[i + c] = clamp(d[i + c] + diff * k);
      }
      break;
    }
    case 'sharpen': convolve(d, w, h, [0, -1, 0, -1, 5, -1, 0, -1, 0], 1, 0); break;
    case 'addNoise': {
      const k = p.amount / 100 * 255;
      for (let i = 0; i < d.length; i += 4) {
        if (p.mono) { const n = (Math.random() - 0.5) * 2 * k; d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n); }
        else for (let c = 0; c < 3; c++) d[i + c] = clamp(d[i + c] + (Math.random() - 0.5) * 2 * k);
      }
      break;
    }
    case 'reduceNoise': {
      // edge-aware smoothing: blur, then keep the original where it differs a lot (detail)
      const bl = Uint8ClampedArray.from(d); gaussianInPlace(bl, w, h, p.strength * 0.8);
      const lim = 10 + (100 - p.detail) * 0.6;
      for (let i = 0; i < d.length; i += 4) {
        const diff = Math.abs(lum(d, i) - lum(bl, i));
        const t = diff > lim ? 0 : 1 - diff / lim;
        for (let c = 0; c < 3; c++) d[i + c] = d[i + c] + (bl[i + c] - d[i + c]) * t;
      }
      break;
    }
    case 'median': {
      const src = Uint8ClampedArray.from(d); const r = p.radius; const vals = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          vals.length = 0;
          for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) vals.push(src[(yy * w + xx) * 4 + c]);
          vals.sort((a, b) => a - b); d[i + c] = vals[vals.length >> 1];
        }
      }
      break;
    }
    case 'pixelate': {
      const s = Math.max(1, Math.round(p.size));
      for (let by = 0; by < h; by += s) for (let bx = 0; bx < w; bx += s) {
        let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
        for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) { const i = (y * w + x) * 4; const al = d[i + 3]; r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al; n++; }
        const R = a ? r / a : 0; const G = a ? g / a : 0; const B = a ? b / a : 0; const A = a / n;
        for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) { const i = (y * w + x) * 4; d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = A; }
      }
      break;
    }
    case 'halftone': {
      const s = Math.max(2, Math.round(p.size)); const src = Uint8ClampedArray.from(d);
      for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255; }
      for (let by = 0; by < h; by += s) for (let bx = 0; bx < w; bx += s) {
        let sum = [0, 0, 0]; let n = 0;
        for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) { const i = (y * w + x) * 4; sum[0] += src[i]; sum[1] += src[i + 1]; sum[2] += src[i + 2]; n++; }
        sum = sum.map((v) => v / n);
        for (let c = 0; c < 3; c++) {
          const rad = (1 - sum[c] / 255) * s * 0.72; const cx = bx + s / 2; const cy = by + s / 2;
          for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) {
            const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
            if (dist < rad) d[(y * w + x) * 4 + c] = 0;
          }
        }
      }
      break;
    }
    case 'emboss': {
      const a = p.angle * Math.PI / 180; const ox = Math.round(Math.cos(a) * p.height); const oy = Math.round(-Math.sin(a) * p.height);
      const src = Uint8ClampedArray.from(d); const k = p.amount / 100;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const x1 = Math.min(w - 1, Math.max(0, x + ox)); const y1 = Math.min(h - 1, Math.max(0, y + oy));
        const x2 = Math.min(w - 1, Math.max(0, x - ox)); const y2 = Math.min(h - 1, Math.max(0, y - oy));
        const v = 128 + (lum(src, (y1 * w + x1) * 4) - lum(src, (y2 * w + x2) * 4)) * k;
        d[i] = d[i + 1] = d[i + 2] = clamp(v);
      }
      break;
    }
    case 'findEdges': {
      const src = Uint8ClampedArray.from(d);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const s = (dx, dy) => src[(Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4 + c];
          const gx = -s(-1, -1) - 2 * s(-1, 0) - s(-1, 1) + s(1, -1) + 2 * s(1, 0) + s(1, 1);
          const gy = -s(-1, -1) - 2 * s(0, -1) - s(1, -1) + s(-1, 1) + 2 * s(0, 1) + s(1, 1);
          d[i + c] = clamp(255 - Math.hypot(gx, gy) / 2);
        }
      }
      break;
    }
    case 'posterize': { const n = Math.max(2, p.levels) - 1; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.round(Math.round(d[i + c] / 255 * n) / n * 255); break; }
    case 'solarize': for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) if (d[i + c] > 127) d[i + c] = 255 - d[i + c]; break;
    case 'vignette': {
      const cx = w / 2; const cy = h / 2; const maxd = Math.hypot(cx, cy);
      const mid = p.size / 100; const soft = Math.max(0.01, p.softness / 100); const amt = p.amount / 100;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = Math.hypot((x - cx) / cx, (y - cy) / cy) / Math.SQRT2 * (maxd / maxd);
        let v = (t - mid * 0.9) / soft; v = Math.max(0, Math.min(1, v)); v = v * v * (3 - 2 * v);
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) d[i + c] = amt < 0 ? d[i + c] * (1 + amt * v) : d[i + c] + (255 - d[i + c]) * amt * v;
      }
      break;
    }
    case 'oilPaint': {
      // intensity-binned mode filter: each pixel takes the average colour of the most common brightness nearby
      const src = Uint8ClampedArray.from(d); const r = p.radius; const L = p.levels;
      const cnt = new Int32Array(L); const sr = new Float32Array(L); const sg = new Float32Array(L); const sb = new Float32Array(L);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        cnt.fill(0); sr.fill(0); sg.fill(0); sb.fill(0);
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          const i = (yy * w + xx) * 4; const b = Math.min(L - 1, (lum(src, i) / 256 * L) | 0);
          cnt[b]++; sr[b] += src[i]; sg[b] += src[i + 1]; sb[b] += src[i + 2];
        }
        let best = 0; for (let b = 1; b < L; b++) if (cnt[b] > cnt[best]) best = b;
        const i = (y * w + x) * 4; d[i] = sr[best] / cnt[best]; d[i + 1] = sg[best] / cnt[best]; d[i + 2] = sb[best] / cnt[best];
      }
      break;
    }
    case 'sketch': {
      // colour-dodge the greyscale image with its blurred negative: classic pencil sketch
      const g = new Uint8ClampedArray(d.length);
      for (let i = 0; i < d.length; i += 4) { const v = lum(d, i); g[i] = g[i + 1] = g[i + 2] = 255 - v; g[i + 3] = 255; }
      gaussianInPlace(g, w, h, p.radius);
      const k = 1 + p.contrast / 50;
      for (let i = 0; i < d.length; i += 4) {
        const base = lum(d, i); const top = g[i];
        let v = top >= 255 ? 255 : Math.min(255, base * 255 / (255 - top));
        v = 255 - (255 - v) * k;
        d[i] = d[i + 1] = d[i + 2] = clamp(v);
      }
      break;
    }
    case 'cutout': {
      gaussianInPlace(d, w, h, p.smooth);
      const n = p.levels - 1;
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = Math.round(Math.round(d[i + c] / 255 * n) / n * 255);
      break;
    }
    case 'glow': {
      const bl = Uint8ClampedArray.from(d); gaussianInPlace(bl, w, h, p.radius);
      const k = p.amount / 100;
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp(255 - (255 - d[i + c]) * (255 - bl[i + c] * k) / 255); // screen
      break;
    }
    default:
  }
  return img;
}

function convolve(d, w, h, k, div, bias) {
  const src = Uint8ClampedArray.from(d);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) {
        const xx = Math.min(w - 1, Math.max(0, x + kx)); const yy = Math.min(h - 1, Math.max(0, y + ky));
        s += src[(yy * w + xx) * 4 + c] * k[(ky + 1) * 3 + kx + 1];
      }
      d[i + c] = clamp(s / div + bias);
    }
  }
}

// ---------------------------------------------------------------- worker runner

let worker = null; let seqId = 0; const waiting = new Map();
function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./filters.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); w.resolve(new ImageData(e.data.data, e.data.width, e.data.height)); } };
    worker.onerror = () => { for (const w of waiting.values()) w.reject(new Error('Filter failed')); waiting.clear(); worker = null; };
  } catch { worker = null; }
  return worker;
}
/** Runs a filter off the main thread. Resolves to a new ImageData. */
export function runFilter(id, img, params) {
  const wk = getWorker();
  if (!wk) return Promise.resolve(applyFilter(id, img, params));
  const msgId = ++seqId;
  return new Promise((resolve, reject) => {
    waiting.set(msgId, { resolve, reject });
    const data = img.data;
    wk.postMessage({ id: msgId, filter: id, params, width: img.width, height: img.height, data }, [data.buffer]);
  });
}
