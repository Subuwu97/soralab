// Layer effects. Each runs on a layer's buffer (a canvas the size of the composition at the current resolution) in place.
// Canvas filters do the heavy lifting (blur, colour); a few effects (tint, noise, turbulent displace) are pixel loops.
// All of them are deterministic — noise is seeded by the frame — so export matches preview.
import { colorArr } from './keyframes.js';
import { noise1, seedOf } from './expr.js';

// Parameter types: num | angle | percent | color | point | toggle | select. Points are in composition pixels.
export const EFFECTS = {
  blur: { label: 'Gaussian Blur', group: 'Blur & Sharpen', params: { radius: { label: 'Blurriness', type: 'num', v: 10, min: 0, max: 250 } } },
  dropShadow: {
    label: 'Drop Shadow', group: 'Perspective', params: {
      color: { label: 'Shadow colour', type: 'color', v: '#000000' }, opacity: { label: 'Opacity', type: 'percent', v: 60, min: 0, max: 100 },
      direction: { label: 'Direction', type: 'angle', v: 135 }, distance: { label: 'Distance', type: 'num', v: 12, min: 0, max: 1000 }, softness: { label: 'Softness', type: 'num', v: 16, min: 0, max: 250 },
    },
  },
  glow: {
    label: 'Glow', group: 'Stylize', params: {
      radius: { label: 'Glow radius', type: 'num', v: 24, min: 0, max: 400 }, intensity: { label: 'Glow intensity', type: 'num', v: 1.2, min: 0, max: 6, step: 0.1 },
      color: { label: 'Glow colour', type: 'color', v: '#ffffff' }, useColor: { label: 'Colourise', type: 'toggle', v: false },
    },
  },
  fill: { label: 'Fill', group: 'Generate', params: { color: { label: 'Colour', type: 'color', v: '#ff3b6b' }, opacity: { label: 'Opacity', type: 'percent', v: 100, min: 0, max: 100 } } },
  tint: {
    label: 'Tint', group: 'Color Correction', params: {
      black: { label: 'Map black to', type: 'color', v: '#000000' }, white: { label: 'Map white to', type: 'color', v: '#ffffff' }, amount: { label: 'Amount', type: 'percent', v: 100, min: 0, max: 100 },
    },
  },
  brightnessContrast: {
    label: 'Brightness & Contrast', group: 'Color Correction', params: {
      brightness: { label: 'Brightness', type: 'num', v: 0, min: -100, max: 100 }, contrast: { label: 'Contrast', type: 'num', v: 0, min: -100, max: 100 },
    },
  },
  hueSaturation: {
    label: 'Hue/Saturation', group: 'Color Correction', params: {
      hue: { label: 'Master hue', type: 'angle', v: 0 }, saturation: { label: 'Saturation', type: 'num', v: 0, min: -100, max: 100 }, lightness: { label: 'Lightness', type: 'num', v: 0, min: -100, max: 100 },
    },
  },
  gradientRamp: {
    label: 'Gradient Ramp', group: 'Generate', params: {
      start: { label: 'Start of ramp', type: 'point', v: [0, 0], rel: [0.5, 0] }, startColor: { label: 'Start colour', type: 'color', v: '#000000' },
      end: { label: 'End of ramp', type: 'point', v: [0, 1080], rel: [0.5, 1] }, endColor: { label: 'End colour', type: 'color', v: '#ffffff' },
      shape: { label: 'Ramp shape', type: 'select', v: 'linear', choices: [['linear', 'Linear'], ['radial', 'Radial']] }, blend: { label: 'Blend with original', type: 'percent', v: 0, min: 0, max: 100 },
    },
  },
  noise: { label: 'Noise', group: 'Noise & Grain', params: { amount: { label: 'Amount of noise', type: 'percent', v: 20, min: 0, max: 100 }, color: { label: 'Colour noise', type: 'toggle', v: true } } },
  turbulentDisplace: {
    label: 'Turbulent Displace', group: 'Distort', params: {
      amount: { label: 'Amount', type: 'num', v: 40, min: 0, max: 500 }, size: { label: 'Size', type: 'num', v: 80, min: 4, max: 1000 },
      evolution: { label: 'Evolution', type: 'angle', v: 0 },
    },
  },
};
export const effectGroups = () => {
  const g = {};
  for (const [id, e] of Object.entries(EFFECTS)) (g[e.group] ||= []).push({ id, label: e.label });
  return g;
};

// ---------------------------------------------------------------- scratch canvases

const pool = [];
export function scratch(w, h, i = 0) {
  let c = pool[i];
  if (!c) { c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }); pool[i] = c; }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d', { willReadFrequently: false });
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return [c, ctx];
}
const replaceWith = (canvas, src) => {
  const ctx = canvas.getContext('2d');
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy'; ctx.filter = 'none';
  ctx.drawImage(src, 0, 0);
  ctx.restore();
};
const css = (c, a = 1) => { const [r, g, b, al] = colorArr(c); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${(al * a).toFixed(3)})`; };

// ---------------------------------------------------------------- the effects

/**
 * Applies the effects to canvas in place. effects: [{ type, params: { name: value } }] with values already evaluated.
 * env: { scale (resolution × zoom of the buffer), t, fps, seed }
 */
export function applyEffects(canvas, effects, env) {
  for (const fx of effects) {
    const def = EFFECTS[fx.type];
    if (!def) continue;
    run(fx.type, canvas, fx.params, env);
  }
}

function run(type, canvas, p, env) {
  const W = canvas.width; const H = canvas.height; const s = env.scale || 1;
  const ctx = canvas.getContext('2d');
  switch (type) {
    case 'blur': {
      const r = Math.max(0, p.radius) * s;
      if (r < 0.3) return;
      const [tmp, tctx] = scratch(W, H, 9);
      tctx.filter = `blur(${(r / 2).toFixed(2)}px)`;
      tctx.drawImage(canvas, 0, 0);
      replaceWith(canvas, tmp);
      return;
    }
    case 'dropShadow': {
      const a = ((p.direction - 90) * Math.PI) / 180;
      const [tmp, tctx] = scratch(W, H, 9);
      tctx.shadowColor = css(p.color, p.opacity / 100);
      tctx.shadowBlur = Math.max(0, p.softness) * s;
      tctx.shadowOffsetX = Math.cos(a) * p.distance * s; tctx.shadowOffsetY = Math.sin(a) * p.distance * s;
      tctx.drawImage(canvas, 0, 0);
      replaceWith(canvas, tmp);
      return;
    }
    case 'glow': {
      const [tmp, tctx] = scratch(W, H, 9);
      tctx.filter = `blur(${Math.max(0.5, (p.radius * s) / 2).toFixed(2)}px)`;
      tctx.drawImage(canvas, 0, 0);
      tctx.filter = 'none';
      if (p.useColor) { tctx.globalCompositeOperation = 'source-in'; tctx.fillStyle = css(p.color); tctx.fillRect(0, 0, W, H); }
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'lighter';
      let k = Math.max(0, p.intensity);
      while (k > 0.001) { ctx.globalAlpha = Math.min(1, k); ctx.drawImage(tmp, 0, 0); k -= 1; }
      ctx.restore();
      return;
    }
    case 'fill': {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = p.opacity / 100;
      ctx.fillStyle = css(p.color); ctx.fillRect(0, 0, W, H);
      ctx.restore();
      return;
    }
    case 'brightnessContrast': case 'hueSaturation': {
      const f = type === 'brightnessContrast'
        ? `brightness(${(1 + p.brightness / 100).toFixed(3)}) contrast(${(1 + p.contrast / 100).toFixed(3)})`
        : `hue-rotate(${p.hue}deg) saturate(${Math.max(0, 1 + p.saturation / 100).toFixed(3)}) brightness(${(1 + p.lightness / 100).toFixed(3)})`;
      const [tmp, tctx] = scratch(W, H, 9);
      tctx.filter = f; tctx.drawImage(canvas, 0, 0);
      replaceWith(canvas, tmp);
      return;
    }
    case 'gradientRamp': {
      const [tmp, tctx] = scratch(W, H, 9);
      const g = p.shape === 'radial'
        ? tctx.createRadialGradient(p.start[0] * s, p.start[1] * s, 0, p.start[0] * s, p.start[1] * s, Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]) * s || 1)
        : tctx.createLinearGradient(p.start[0] * s, p.start[1] * s, p.end[0] * s, p.end[1] * s);
      g.addColorStop(0, css(p.startColor)); g.addColorStop(1, css(p.endColor));
      tctx.fillStyle = g; tctx.fillRect(0, 0, W, H);
      tctx.globalCompositeOperation = 'destination-in'; tctx.drawImage(canvas, 0, 0); // keep the layer's alpha
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-atop'; ctx.globalAlpha = 1 - p.blend / 100;
      ctx.drawImage(tmp, 0, 0); ctx.restore();
      return;
    }
    case 'tint': case 'noise': case 'turbulentDisplace': {
      if (W * H === 0) return;
      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;
      if (type === 'tint') {
        const b = colorArr(p.black).map((x) => x * 255); const w = colorArr(p.white).map((x) => x * 255); const k = p.amount / 100;
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          for (let c = 0; c < 3; c++) d[i + c] += (b[c] + (w[c] - b[c]) * l - d[i + c]) * k;
        }
      } else if (type === 'noise') {
        const amt = (p.amount / 100) * 255; const frame = Math.round((env.t || 0) * (env.fps || 30));
        let x = (seedOf(`${env.seed}|${frame}`) >>> 0) || 1;
        const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296 - 0.5; };
        for (let i = 0; i < d.length; i += 4) {
          if (!d[i + 3]) continue;
          if (p.color) { d[i] += rnd() * amt; d[i + 1] += rnd() * amt; d[i + 2] += rnd() * amt; } else { const n = rnd() * amt; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
        }
      } else {
        // Displacement from smooth noise evaluated on a coarse grid and interpolated — fast enough at full HD.
        const src = new Uint8ClampedArray(d);
        const size = Math.max(4, p.size * s); const amt = p.amount * s; const evo = (p.evolution / 360) * 4;
        const G = 8; const gw = Math.ceil(W / G) + 2; const gh = Math.ceil(H / G) + 2;
        const fx = new Float32Array(gw * gh); const fy = new Float32Array(gw * gh);
        const n2 = (x, y, sd) => (noise1(x + noise1(y * 0.73 + evo, sd + 3) * 1.7 + evo, sd) + 0.5 * noise1(x * 2.1 + y * 1.3 - evo, sd + 11)) / 1.5;
        for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
          const X = (gx * G) / size; const Y = (gy * G) / size;
          fx[gy * gw + gx] = n2(X, Y, 17) * amt; fy[gy * gw + gx] = n2(Y + 31.7, X, 29) * amt;
        }
        for (let y = 0; y < H; y++) {
          const gyf = y / G; const gy0 = Math.floor(gyf); const ty = gyf - gy0;
          for (let x = 0; x < W; x++) {
            const gxf = x / G; const gx0 = Math.floor(gxf); const tx = gxf - gx0;
            const i00 = gy0 * gw + gx0;
            const dx = (fx[i00] * (1 - tx) + fx[i00 + 1] * tx) * (1 - ty) + (fx[i00 + gw] * (1 - tx) + fx[i00 + gw + 1] * tx) * ty;
            const dy = (fy[i00] * (1 - tx) + fy[i00 + 1] * tx) * (1 - ty) + (fy[i00 + gw] * (1 - tx) + fy[i00 + gw + 1] * tx) * ty;
            const sx = Math.min(W - 1, Math.max(0, Math.round(x + dx))); const sy = Math.min(H - 1, Math.max(0, Math.round(y + dy)));
            const o = (y * W + x) * 4; const q = (sy * W + sx) * 4;
            d[o] = src[q]; d[o + 1] = src[q + 1]; d[o + 2] = src[q + 2]; d[o + 3] = src[q + 3];
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      break;
    }
    default:
  }
}

/** Converts a buffer's luminance into alpha (for luma mattes). */
export function lumaToAlpha(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height); const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; d[i + 3] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * a; }
  ctx.putImageData(img, 0, 0);
}
