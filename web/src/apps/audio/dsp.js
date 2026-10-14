// Plain-array audio maths shared by the waveform editor and mixdown: WAV writing, loudness (ITU BS.1770 / EBU R128
// integrated LUFS), peak level, a look-ahead limiter, and the destructive edits (cut, paste, fades, reverse…).
// "Audio" here is { channels: Float32Array[], sampleRate }.

export const fromBuffer = (b) => ({ sampleRate: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i).slice()) });
export function toBuffer(a, ctx) {
  const len = Math.max(1, a.channels[0]?.length || 1);
  const b = ctx ? ctx.createBuffer(a.channels.length, len, a.sampleRate) : new AudioBuffer({ numberOfChannels: a.channels.length, length: len, sampleRate: a.sampleRate });
  a.channels.forEach((c, i) => { if (c.length) b.copyToChannel(c, i); });
  return b;
}
export const lengthOf = (a) => a.channels[0]?.length || 0;
export const durationOf = (a) => lengthOf(a) / a.sampleRate;

// ---------------------------------------------------------------- WAV

/** PCM WAV (16 or 24-bit integer, with TPDF dither for 16-bit; 32 = float). */
export function encodeWav(a, bits = 24) {
  const ch = a.channels.length; const n = lengthOf(a); const bps = bits / 8;
  const dataLen = n * ch * bps;
  const buf = new ArrayBuffer(44 + dataLen); const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, ch, true); v.setUint32(24, a.sampleRate, true);
  v.setUint32(28, a.sampleRate * ch * bps, true); v.setUint16(32, ch * bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let s = a.channels[c][i];
      if (bits === 32) { v.setFloat32(o, s, true); o += 4; continue; }
      s = Math.max(-1, Math.min(1, s));
      if (bits === 16) {
        const d = (Math.random() - Math.random()) / 32768; // TPDF dither, ±1 LSB
        const x = Math.max(-32768, Math.min(32767, Math.round((s + d) * 32767)));
        v.setInt16(o, x, true); o += 2;
      } else {
        const x = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388607)));
        bytes[o] = x & 255; bytes[o + 1] = (x >> 8) & 255; bytes[o + 2] = (x >> 16) & 255; o += 3;
      }
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------------------------------------------------------------- loudness

/** K-weighting: high shelf (+4 dB above ~1.5 kHz) then high-pass at 38 Hz, as biquad coefficients for any rate. */
export function kWeighting(sr) {
  const shelf = (() => {
    const G = 4, Q = 1 / Math.SQRT2, fc = 1500; const A = 10 ** (G / 40); const w0 = (2 * Math.PI * fc) / sr; const al = Math.sin(w0) / (2 * Q); const cs = Math.cos(w0); const sa = 2 * Math.sqrt(A) * al;
    const b0 = A * ((A + 1) + (A - 1) * cs + sa); const b1 = -2 * A * ((A - 1) + (A + 1) * cs); const b2 = A * ((A + 1) + (A - 1) * cs - sa);
    const a0 = (A + 1) - (A - 1) * cs + sa; const a1 = 2 * ((A - 1) - (A + 1) * cs); const a2 = (A + 1) - (A - 1) * cs - sa;
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  })();
  const hp = (() => {
    const Q = 0.5, fc = 38; const w0 = (2 * Math.PI * fc) / sr; const al = Math.sin(w0) / (2 * Q); const cs = Math.cos(w0);
    const a0 = 1 + al;
    return [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, (-2 * cs) / a0, (1 - al) / a0];
  })();
  return [shelf, hp];
}
function biquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}

/** Integrated loudness in LUFS (400 ms blocks, 75 % overlap, absolute −70 and relative −10 LU gates). */
export function integratedLoudness(a) {
  const sr = a.sampleRate; const [s1, s2] = kWeighting(sr);
  const kw = a.channels.slice(0, 2).map((c) => biquad(biquad(c, s1), s2));
  const block = Math.round(0.4 * sr); const step = Math.round(0.1 * sr); const n = kw[0].length;
  const z = [];
  for (let s = 0; s + block <= n; s += step) {
    let sum = 0;
    for (const c of kw) { let e = 0; for (let i = s; i < s + block; i++) e += c[i] * c[i]; sum += e / block; }
    z.push(sum);
  }
  if (!z.length && n) { let sum = 0; for (const c of kw) { let e = 0; for (let i = 0; i < n; i++) e += c[i] * c[i]; sum += e / n; } z.push(sum); }
  const L = (x) => -0.691 + 10 * Math.log10(Math.max(1e-12, x));
  const abs = z.filter((x) => L(x) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((p, x) => p + x, 0) / abs.length) - 10;
  const g = abs.filter((x) => L(x) > rel);
  return L(g.reduce((p, x) => p + x, 0) / Math.max(1, g.length));
}

export function peak(a, from = 0, to = Infinity) {
  let p = 0;
  for (const c of a.channels) { const e = Math.min(c.length, to); for (let i = from; i < e; i++) { const v = Math.abs(c[i]); if (v > p) p = v; } }
  return p;
}
export const toDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

/** Look-ahead peak limiter (in place): keeps every sample under `ceilingDb` without clicks. */
export function limit(a, ceilingDb = -1, { lookahead = 0.005, release = 0.08 } = {}) {
  const ceil = 10 ** (ceilingDb / 20); const sr = a.sampleRate; const n = lengthOf(a);
  const la = Math.max(1, Math.round(lookahead * sr)); const rel = Math.exp(-1 / (release * sr));
  // Required gain per sample, then a running minimum over the look-ahead window, then smoothed release.
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) { let p = 0; for (const c of a.channels) p = Math.max(p, Math.abs(c[i])); need[i] = p > ceil ? ceil / p : 1; }
  let g = 1; const gains = new Float32Array(n);
  const dq = new Int32Array(n + 1); let head = 0; let tail = 0; // monotonic deque of indices for the window minimum
  for (let i = 0; i < n + la; i++) {
    if (i < n) { while (tail > head && need[dq[tail - 1]] >= need[i]) tail--; dq[tail++] = i; }
    const out = i - la;
    if (out < 0) continue;
    while (tail > head && dq[head] < out) head++;
    const target = tail > head ? need[dq[head]] : 1;
    g = target < g ? target : target + (g - target) * rel;
    gains[out] = g;
  }
  for (const c of a.channels) for (let i = 0; i < n; i++) c[i] = Math.max(-ceil, Math.min(ceil, c[i] * gains[i]));
  return a;
}

export function scale(a, k, from = 0, to = Infinity) {
  for (const c of a.channels) { const e = Math.min(c.length, to); for (let i = from; i < e; i++) c[i] *= k; }
  return a;
}

/** Brings integrated loudness to `target` LUFS, limiting peaks at `ceiling` dBFS. Returns the gain applied (dB). */
export function normalizeLoudness(a, target = -16, ceiling = -1) {
  const l = integratedLoudness(a);
  if (!Number.isFinite(l)) return 0;
  const db = target - l;
  scale(a, 10 ** (db / 20));
  if (peak(a) > 10 ** (ceiling / 20)) limit(a, ceiling);
  return db;
}

// ---------------------------------------------------------------- destructive edits (return new audio)

const clone = (a) => ({ sampleRate: a.sampleRate, channels: a.channels.map((c) => c.slice()) });
export const slice = (a, s, e) => ({ sampleRate: a.sampleRate, channels: a.channels.map((c) => c.slice(s, e)) });

export function remove(a, s, e) {
  return { sampleRate: a.sampleRate, channels: a.channels.map((c) => { const o = new Float32Array(c.length - (e - s)); o.set(c.subarray(0, s)); o.set(c.subarray(e), s); return o; }) };
}

/** Inserts clip audio at s (replacing [s, e) when there's a selection). Channel counts are matched. */
export function insert(a, s, e, clip) {
  const n = lengthOf(clip);
  return {
    sampleRate: a.sampleRate,
    channels: a.channels.map((c, ci) => {
      const src = clip.channels[Math.min(ci, clip.channels.length - 1)];
      const o = new Float32Array(c.length - (e - s) + n); o.set(c.subarray(0, s)); o.set(src, s); o.set(c.subarray(e), s + n); return o;
    }),
  };
}

export function silence(a, s, e) { const b = clone(a); for (const c of b.channels) c.fill(0, s, e); return b; }
export function gainRange(a, s, e, db) { return scale(clone(a), 10 ** (db / 20), s, e); }
export function normalizePeakRange(a, s, e, targetDb = -1) {
  const p = peak(a, s, e); if (!p) return clone(a);
  return scale(clone(a), 10 ** (targetDb / 20) / p, s, e);
}
export function normalizeLoudnessRange(a, s, e, target = -16) {
  const part = slice(a, s, e);
  normalizeLoudness(part, target, -1);
  const b = clone(a); b.channels.forEach((c, i) => c.set(part.channels[i], s));
  return b;
}
/** Fade over [s, e): shaped like model.fadeShape (in = 0→1, out = 1→0). */
export function fade(a, s, e, dir, shape = (x) => x) {
  const b = clone(a); const n = Math.max(1, e - s);
  for (const c of b.channels) for (let i = s; i < e; i++) { const x = (i - s) / n; c[i] *= shape(dir === 'in' ? x : 1 - x); }
  return b;
}
export function reverse(a, s, e) { const b = clone(a); for (const c of b.channels) c.subarray(s, e).reverse(); return b; }
export function invert(a, s, e) { const b = clone(a); for (const c of b.channels) for (let i = s; i < e; i++) c[i] = -c[i]; return b; }

/** Waveform summary: min/max per `block` samples across channels (for drawing zoomed-in detail quickly). */
export function mipmap(a, block = 64) {
  const n = lengthOf(a); const m = Math.ceil(n / block);
  const lo = new Float32Array(m); const hi = new Float32Array(m);
  for (const c of a.channels) {
    for (let b = 0; b < m; b++) {
      let l = lo[b], h = hi[b];
      const e = Math.min(n, (b + 1) * block);
      for (let i = b * block; i < e; i++) { const v = c[i]; if (v < l) l = v; else if (v > h) h = v; }
      lo[b] = l; hi[b] = h;
    }
  }
  return { block, lo, hi, sampleRate: a.sampleRate, length: n };
}
