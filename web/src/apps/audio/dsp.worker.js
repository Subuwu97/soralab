// Heavy spectral work off the main thread: noise prints, STFT noise reduction (spectral gating) and spectrograms.
// Messages: { id, cmd, ... } → { id, result } | { id, progress } | { id, error }.

const ffts = new Map();
/** In-place radix-2 complex FFT of size n (inverse when inv). */
function fftFor(n) {
  if (ffts.has(n)) return ffts.get(n);
  const rev = new Uint32Array(n); const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2); const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const f = (re, im, inv = false) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1; const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k]; const wi = inv ? sin[k] : -sin[k];
          const a = i + j; const b = a + half;
          const tr = re[b] * wr - im[b] * wi; const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };
  ffts.set(n, f);
  return f;
}
const hann = (n) => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; };

const N = 2048; const HOP = 512;

/** Average magnitude per bin over every frame of the noise sample (all channels). */
function noisePrint(channels) {
  const fft = fftFor(N); const w = hann(N); const bins = N / 2 + 1;
  const acc = new Float64Array(bins); let frames = 0;
  const re = new Float64Array(N); const im = new Float64Array(N);
  for (const x of channels) {
    for (let s = 0; s + N <= Math.max(N, x.length); s += HOP) {
      for (let i = 0; i < N; i++) { re[i] = (x[s + i] || 0) * w[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < bins; k++) acc[k] += Math.hypot(re[k], im[k]);
      frames++;
    }
  }
  return Float32Array.from(acc, (v) => v / Math.max(1, frames));
}

/**
 * Spectral gate: bins that don't rise `sensitivity` dB above the noise print are pulled down by `reduction` dB.
 * The decision uses magnitudes averaged over 3 frames × 3 bins (noise is spiky bin by bin; the average isn't), with a
 * soft knee, then the mask closes slowly over time (`smoothing`) to avoid warbly "musical noise".
 */
function denoise(x, print, { reduction = 18, sensitivity = 8, smoothing = 0.6 }, onProgress) {
  const fft = fftFor(N); const w = hann(N); const bins = N / 2 + 1;
  const floor = 10 ** (-reduction / 20); const k = 10 ** (sensitivity / 20);
  const thr = Float64Array.from(print, (v) => v * k);
  const pad = N; const len = x.length;
  const src = new Float32Array(len + 2 * pad); src.set(x, pad);
  const out = new Float64Array(src.length); const norm = new Float64Array(src.length);
  const K = Math.floor((src.length - N) / HOP) + 1;
  const frames = new Map();
  const frame = (f) => {
    if (f < 0 || f >= K) return null;
    if (frames.has(f)) return frames.get(f);
    const re = new Float64Array(N); const im = new Float64Array(N); const mag = new Float64Array(bins); const s = f * HOP;
    for (let i = 0; i < N; i++) re[i] = src[s + i] * w[i];
    fft(re, im);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b], im[b]);
    const fr = { re, im, mag, s }; frames.set(f, fr);
    return fr;
  };
  const prev = new Float64Array(bins).fill(1);
  for (let f = 0; f < K; f++) {
    const cur = frame(f); const nb = [frame(f - 1), cur, frame(f + 1)].filter(Boolean);
    frames.delete(f - 2);
    const { re, im } = cur;
    for (let b = 0; b < bins; b++) {
      let sum = 0; let n = 0;
      for (const fr of nb) for (let d = -1; d <= 1; d++) { const bb = b + d; if (bb >= 0 && bb < bins) { sum += fr.mag[bb]; n++; } }
      const r = sum / n / thr[b];
      const m0 = r >= 1 ? 1 : r <= 0.8 ? 0 : (r - 0.8) / 0.2;
      const m = m0 > prev[b] ? m0 : prev[b] * smoothing + m0 * (1 - smoothing);
      prev[b] = m;
      const g = floor + (1 - floor) * m;
      re[b] *= g; im[b] *= g;
      if (b > 0 && b < N / 2) { re[N - b] = re[b]; im[N - b] = -im[b]; }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) { out[cur.s + i] += re[i] * w[i]; norm[cur.s + i] += w[i] * w[i]; }
    if (onProgress && f % 200 === 0) onProgress(f / K);
  }
  const y = new Float32Array(len);
  for (let i = 0; i < len; i++) { const nn = norm[i + pad]; y[i] = nn > 1e-6 ? out[i + pad] / nn : 0; }
  return y;
}

// Spectrogram colours: night → violet → pink → sun → white.
const STOPS = [[0, [8, 10, 22]], [0.25, [52, 20, 110]], [0.5, [170, 40, 140]], [0.72, [250, 110, 70]], [0.9, [255, 210, 90]], [1, [255, 255, 230]]];
const LUT = (() => {
  const l = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255; let j = 0; while (j < STOPS.length - 2 && x > STOPS[j + 1][0]) j++;
    const [x0, c0] = STOPS[j]; const [x1, c1] = STOPS[j + 1]; const t = (x - x0) / (x1 - x0);
    for (let c = 0; c < 3; c++) l[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * t;
  }
  return l;
})();

/** RGBA image (cols × rows) of the range [from, to) samples of x; log-frequency rows from 30 Hz to Nyquist. */
function spectrogram(x, sr, from, to, cols, rows, size = 2048) {
  const fft = fftFor(size); const w = hann(size); const img = new Uint8ClampedArray(cols * rows * 4);
  const re = new Float64Array(size); const im = new Float64Array(size);
  const fMin = 30; const fMax = sr / 2; const rowBin = new Float64Array(rows);
  for (let r = 0; r < rows; r++) rowBin[r] = (fMin * (fMax / fMin) ** (1 - r / (rows - 1))) / (sr / size);
  const mags = new Float64Array(size / 2 + 1);
  for (let c = 0; c < cols; c++) {
    const center = Math.round(from + ((to - from) * (c + 0.5)) / cols);
    const s = center - size / 2;
    for (let i = 0; i < size; i++) { const j = s + i; re[i] = j >= 0 && j < x.length ? x[j] * w[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b <= size / 2; b++) mags[b] = Math.hypot(re[b], im[b]);
    for (let r = 0; r < rows; r++) {
      // max of the bins this row covers (rows are wider than bins at high frequencies)
      const b0 = Math.floor(rowBin[r]); const b1 = r > 0 ? Math.max(b0, Math.floor(rowBin[r - 1])) : b0;
      let m = 0; for (let b = b0; b <= Math.min(size / 2, b1); b++) if (mags[b] > m) m = mags[b];
      const db = 20 * Math.log10(m / (size / 4) + 1e-9);
      const v = Math.max(0, Math.min(255, Math.round(((db + 110) / 110) * 255)));
      const o = (r * cols + c) * 4;
      img[o] = LUT[v * 3]; img[o + 1] = LUT[v * 3 + 1]; img[o + 2] = LUT[v * 3 + 2]; img[o + 3] = 255;
    }
  }
  return img;
}

const store = new Map(); // key → mono Float32Array for spectrograms

self.onmessage = (e) => {
  const { id, cmd } = e.data;
  try {
    if (cmd === 'set') { store.set(e.data.key, e.data.mono); self.postMessage({ id, result: true }); return; }
    if (cmd === 'print') { self.postMessage({ id, result: noisePrint(e.data.channels) }); return; }
    if (cmd === 'denoise') {
      const chans = e.data.channels; const outs = [];
      chans.forEach((x, ci) => outs.push(denoise(x, e.data.print, e.data.opts, (p) => self.postMessage({ id, progress: (ci + p) / chans.length }))));
      self.postMessage({ id, result: outs }, outs.map((o) => o.buffer));
      return;
    }
    if (cmd === 'spectrogram') {
      const x = store.get(e.data.key);
      if (!x) throw new Error('No audio loaded');
      const img = spectrogram(x, e.data.sampleRate, e.data.from, e.data.to, e.data.cols, e.data.rows);
      self.postMessage({ id, result: img }, [img.buffer]);
      return;
    }
    throw new Error(`Unknown command ${cmd}`);
  } catch (err) { self.postMessage({ id, error: err.message }); }
};
