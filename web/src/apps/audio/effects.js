// Track and master effects. Each effect type knows its parameters (for the rack UI) and how to build itself as a small
// Web Audio sub-graph { input, output, update(params), dispose() } — the same builder runs live (AudioContext) and in
// mixdown (OfflineAudioContext), so what you hear is what you export.
// Gate, de-esser and pitch shift need sample-level control, so they're AudioWorklet processors (source below).

const uid = () => `fx${Math.random().toString(36).slice(2, 9)}`;
const dbg = (db) => 10 ** (db / 20);

// ---------------------------------------------------------------- parameter definitions (for the rack)

const P = (key, label, min, max, step, unit, def, extra = {}) => ({ key, label, min, max, step, unit, def, ...extra });

export const EQ_TYPES = [['highpass', 'High-pass'], ['lowshelf', 'Low shelf'], ['peaking', 'Bell'], ['notch', 'Notch'], ['highshelf', 'High shelf'], ['lowpass', 'Low-pass']];
export const defaultBands = () => [
  { type: 'lowshelf', f: 100, g: 0, q: 0.7, on: true },
  { type: 'peaking', f: 400, g: 0, q: 1, on: true },
  { type: 'peaking', f: 2500, g: 0, q: 1, on: true },
  { type: 'highshelf', f: 8000, g: 0, q: 0.7, on: true },
];

export const FX = {
  eq: { name: 'Parametric EQ', params: [P('output', 'Output', -18, 18, 0.1, 'dB', 0)], defaults: () => ({ bands: defaultBands(), output: 0 }) },
  compressor: {
    name: 'Compressor',
    params: [P('threshold', 'Threshold', -60, 0, 0.5, 'dB', -20), P('ratio', 'Ratio', 1, 20, 0.1, ':1', 4), P('knee', 'Knee', 0, 40, 1, 'dB', 6),
      P('attack', 'Attack', 0.1, 200, 0.1, 'ms', 10), P('release', 'Release', 10, 1000, 1, 'ms', 200), P('makeup', 'Make-up', 0, 24, 0.1, 'dB', 4)],
  },
  limiter: { name: 'Hard Limiter', params: [P('input', 'Input boost', 0, 24, 0.1, 'dB', 0), P('ceiling', 'Ceiling', -12, 0, 0.1, 'dB', -1), P('release', 'Release', 10, 500, 1, 'ms', 60)] },
  gate: {
    name: 'Noise Gate',
    params: [P('threshold', 'Threshold', -90, 0, 0.5, 'dB', -50), P('range', 'Floor', -90, 0, 1, 'dB', -60), P('attack', 'Attack', 0.1, 50, 0.1, 'ms', 2),
      P('hold', 'Hold', 0, 500, 1, 'ms', 60), P('release', 'Release', 5, 1000, 1, 'ms', 120)],
  },
  deesser: { name: 'De-esser', params: [P('freq', 'Frequency', 2000, 12000, 50, 'Hz', 6000), P('threshold', 'Threshold', -60, 0, 0.5, 'dB', -30), P('reduction', 'Max reduction', 0, 24, 0.5, 'dB', 10)] },
  reverb: {
    name: 'Convolution Reverb',
    params: [P('decay', 'Decay', 0.2, 10, 0.1, 's', 2.2), P('predelay', 'Pre-delay', 0, 200, 1, 'ms', 20), P('damping', 'Damping', 1000, 20000, 100, 'Hz', 7000),
      P('width', 'Width', 0, 1, 0.01, '', 1), P('mix', 'Mix', 0, 1, 0.01, '', 0.25)],
  },
  delay: { name: 'Delay', params: [P('time', 'Time', 1, 2000, 1, 'ms', 320), P('feedback', 'Feedback', 0, 0.95, 0.01, '', 0.35), P('tone', 'Tone', 500, 20000, 100, 'Hz', 6000), P('mix', 'Mix', 0, 1, 0.01, '', 0.25)] },
  chorus: { name: 'Chorus', params: [P('rate', 'Rate', 0.05, 8, 0.01, 'Hz', 1.2), P('depth', 'Depth', 0, 10, 0.1, 'ms', 3), P('delay', 'Delay', 2, 40, 0.5, 'ms', 14), P('mix', 'Mix', 0, 1, 0.01, '', 0.45)] },
  pitch: { name: 'Pitch Shifter', params: [P('semitones', 'Semitones', -12, 12, 0.1, 'st', 0), P('mix', 'Mix', 0, 1, 0.01, '', 1)] },
  highpass: { name: 'High-pass Filter', params: [P('freq', 'Frequency', 20, 2000, 1, 'Hz', 80, { log: true }), P('q', 'Q', 0.3, 10, 0.05, '', 0.71)] },
  lowpass: { name: 'Low-pass Filter', params: [P('freq', 'Frequency', 500, 20000, 10, 'Hz', 12000, { log: true }), P('q', 'Q', 0.3, 10, 0.05, '', 0.71)] },
  gain: { name: 'Amplify', params: [P('gain', 'Gain', -40, 24, 0.1, 'dB', 0)] },
};
export const FX_ORDER = ['eq', 'compressor', 'limiter', 'gate', 'deesser', 'reverb', 'delay', 'chorus', 'pitch', 'highpass', 'lowpass', 'gain'];

export function newEffect(type, params = {}) {
  const def = FX[type];
  const base = def.defaults ? def.defaults() : Object.fromEntries(def.params.map((p) => [p.key, p.def]));
  return { id: uid(), type, on: true, params: { ...base, ...params } };
}

// ---------------------------------------------------------------- presets

const eqBands = (bands) => bands.map((b) => ({ q: 0.7, g: 0, on: true, ...b }));
export const PRESETS = {
  podcast: {
    name: 'Podcast voice',
    make: () => [
      newEffect('highpass', { freq: 80 }),
      newEffect('gate', { threshold: -55, range: -20 }),
      newEffect('eq', { bands: eqBands([{ type: 'lowshelf', f: 120, g: -2 }, { type: 'peaking', f: 300, g: -2.5, q: 1.2 }, { type: 'peaking', f: 3200, g: 3, q: 0.9 }, { type: 'highshelf', f: 10000, g: 2 }]) }),
      newEffect('deesser', { freq: 6500, threshold: -32, reduction: 8 }),
      newEffect('compressor', { threshold: -22, ratio: 3.5, attack: 8, release: 180, makeup: 5 }),
      newEffect('limiter', { ceiling: -1.5 }),
    ],
  },
  telephone: {
    name: 'Telephone',
    make: () => [
      newEffect('highpass', { freq: 400, q: 1.2 }), newEffect('lowpass', { freq: 3200, q: 1.2 }),
      newEffect('eq', { bands: eqBands([{ type: 'peaking', f: 1500, g: 6, q: 1.4 }, { type: 'peaking', f: 800, g: -3, q: 1 }]) }),
      newEffect('compressor', { threshold: -30, ratio: 8, attack: 2, release: 80, makeup: 8 }),
    ],
  },
  radio: {
    name: 'Radio',
    make: () => [
      newEffect('highpass', { freq: 120 }),
      newEffect('eq', { bands: eqBands([{ type: 'lowshelf', f: 150, g: 3 }, { type: 'peaking', f: 2800, g: 4, q: 1 }, { type: 'highshelf', f: 9000, g: -4 }]) }),
      newEffect('compressor', { threshold: -28, ratio: 6, attack: 3, release: 120, makeup: 9 }),
      newEffect('limiter', { input: 3, ceiling: -0.5 }),
    ],
  },
  bigroom: {
    name: 'Big room',
    make: () => [
      newEffect('eq', { bands: eqBands([{ type: 'lowshelf', f: 200, g: 1.5 }, { type: 'highshelf', f: 6000, g: 2 }]) }),
      newEffect('delay', { time: 90, feedback: 0.15, mix: 0.12, tone: 4000 }),
      newEffect('reverb', { decay: 4.5, predelay: 35, damping: 6000, mix: 0.38 }),
    ],
  },
};

// ---------------------------------------------------------------- worklets

// Runs inside the AudioWorkletGlobalScope (only globals: sampleRate, AudioWorkletProcessor, registerProcessor).
function workletMain() {
  const db = (x) => 10 ** (x / 20);
  /* global sampleRate, AudioWorkletProcessor, registerProcessor */
  class Base extends AudioWorkletProcessor {
    constructor(o) { super(); this.p = { ...(o.processorOptions || {}) }; this.port.onmessage = (e) => { this.p = { ...this.p, ...e.data }; this.changed?.(); }; this.changed?.(); }
  }
  // Noise gate: peak envelope → open/closed with hold, smoothed gain between the floor and unity.
  class Gate extends Base {
    constructor(o) { super(o); this.env = 0; this.g = 0; this.holdLeft = 0; }
    process(inputs, outputs) {
      const inp = inputs[0]; const out = outputs[0];
      if (!inp.length) return true;
      const p = this.p; const thr = db(p.threshold); const floor = db(p.range);
      const att = Math.exp(-1 / (Math.max(0.0001, p.attack / 1000) * sampleRate)); const rel = Math.exp(-1 / (Math.max(0.001, p.release / 1000) * sampleRate));
      const envRel = Math.exp(-1 / (0.01 * sampleRate)); const hold = (p.hold / 1000) * sampleRate;
      for (let i = 0; i < inp[0].length; i++) {
        let pk = 0;
        for (let c = 0; c < inp.length; c++) pk = Math.max(pk, Math.abs(inp[c][i]));
        this.env = pk > this.env ? pk : this.env * envRel;
        let target;
        if (this.env > thr) { target = 1; this.holdLeft = hold; } else if (this.holdLeft > 0) { this.holdLeft--; target = 1; } else target = floor;
        const k = target > this.g ? att : rel;
        this.g = target + (this.g - target) * k;
        for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.g;
      }
      return true;
    }
  }
  // De-esser: split off the "s" band with a 2-pole high-pass, measure it, and turn only that band down when it's hot.
  class DeEsser extends Base {
    changed() {
      const w0 = (2 * Math.PI * this.p.freq) / sampleRate; const cs = Math.cos(w0); const al = Math.sin(w0) / (2 * 0.707);
      const a0 = 1 + al;
      this.c = { b0: (1 + cs) / 2 / a0, b1: -(1 + cs) / a0, b2: (1 + cs) / 2 / a0, a1: (-2 * cs) / a0, a2: (1 - al) / a0 };
      this.st ||= []; this.env ||= 0; this.g ||= 1;
    }
    process(inputs, outputs) {
      const inp = inputs[0]; const out = outputs[0];
      if (!inp.length) return true;
      const { b0, b1, b2, a1, a2 } = this.c; const thr = db(this.p.threshold); const maxRed = db(-this.p.reduction);
      const envRel = Math.exp(-1 / (0.02 * sampleRate)); const gAtt = Math.exp(-1 / (0.002 * sampleRate)); const gRel = Math.exp(-1 / (0.06 * sampleRate));
      const n = inp[0].length; const hp = inp.map(() => new Float32Array(n));
      for (let c = 0; c < inp.length; c++) {
        const s = (this.st[c] ||= [0, 0, 0, 0]); const x = inp[c]; const y = hp[c];
        for (let i = 0; i < n; i++) { const v = b0 * x[i] + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3]; s[1] = s[0]; s[0] = x[i]; s[3] = s[2]; s[2] = v; y[i] = v; }
      }
      for (let i = 0; i < n; i++) {
        let pk = 0;
        for (let c = 0; c < inp.length; c++) pk = Math.max(pk, Math.abs(hp[c][i]));
        this.env = pk > this.env ? pk : this.env * envRel;
        const target = this.env > thr ? Math.max(maxRed, thr / this.env) : 1;
        this.g = target + (this.g - target) * (target < this.g ? gAtt : gRel);
        for (let c = 0; c < out.length; c++) { const ci = Math.min(c, inp.length - 1); out[c][i] = inp[ci][i] - hp[ci][i] * (1 - this.g); }
      }
      return true;
    }
  }
  // Pitch shifter: two read heads sweep a delay line at (1 - ratio) speed, crossfaded with a sine window (classic "rotating tape head").
  class Pitch extends Base {
    constructor(o) { super(o); this.size = Math.round(0.06 * sampleRate); this.len = this.size * 4; this.buf = []; this.w = 0; this.phase = 0; }
    process(inputs, outputs) {
      const inp = inputs[0]; const out = outputs[0];
      if (!inp.length) return true;
      const ratio = 2 ** (this.p.semitones / 12); const step = (1 - ratio) / this.size; const L = this.len;
      for (let c = 0; c < inp.length; c++) this.buf[c] ||= new Float32Array(L);
      for (let i = 0; i < inp[0].length; i++) {
        for (let c = 0; c < inp.length; c++) this.buf[c][this.w] = inp[c][i];
        this.phase = (this.phase + step + 1) % 1;
        for (let c = 0; c < out.length; c++) {
          const b = this.buf[Math.min(c, inp.length - 1)];
          let acc = 0;
          for (const ph of [this.phase, (this.phase + 0.5) % 1]) {
            const d = ph * this.size + 2; let r = this.w - d; if (r < 0) r += L;
            const i0 = Math.floor(r); const fr = r - i0; const s = b[i0] * (1 - fr) + b[(i0 + 1) % L] * fr;
            acc += s * Math.sin(Math.PI * ph);
          }
          const dry = (inp[c] || inp[0])[i];
          out[c][i] = dry * (1 - this.p.mix) + acc * this.p.mix;
        }
        this.w = (this.w + 1) % L;
      }
      return true;
    }
  }
  // Recorder: hands blocks of the input to the main thread.
  class Recorder extends AudioWorkletProcessor {
    constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
    process(inputs) {
      const inp = inputs[0];
      if (inp.length && this.on) this.port.postMessage(inp.map((ch) => ch.slice(0)));
      return this.on;
    }
  }
  registerProcessor('sl-gate', Gate);
  registerProcessor('sl-deesser', DeEsser);
  registerProcessor('sl-pitch', Pitch);
  registerProcessor('sl-recorder', Recorder);
}

let workletUrl = null;
const loaded = new WeakMap();
/** Adds our processors to a context (once per context). */
export function ensureWorklets(ctx) {
  workletUrl ||= URL.createObjectURL(new Blob([`(${workletMain.toString()})();`], { type: 'text/javascript' }));
  if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(workletUrl));
  return loaded.get(ctx);
}

// ---------------------------------------------------------------- impulse responses (reverb)

const irCache = new Map();
/** Stereo impulse: exponentially decaying noise, darker as it decays, after a pre-delay. */
export function makeImpulse(ctx, { decay, predelay, damping, width }) {
  const sr = ctx.sampleRate;
  const key = `${sr}:${decay}:${predelay}:${damping}:${width}`;
  if (irCache.has(key)) {
    const c = irCache.get(key);
    const b = ctx.createBuffer(2, c[0].length, sr); b.copyToChannel(c[0], 0); b.copyToChannel(c[1], 1);
    return b;
  }
  const pre = Math.round((predelay / 1000) * sr); const len = pre + Math.round(decay * sr);
  const chans = [new Float32Array(len), new Float32Array(len)];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const l1 = [0, 0];
  for (let i = pre; i < len; i++) {
    const t = (i - pre) / sr;
    const env = Math.exp((-6.9 * t) / decay);
    // Low-pass gets darker over time: cutoff slides from `damping` down to a quarter of it.
    const fc = damping * (1 - 0.75 * Math.min(1, t / decay));
    const a = Math.exp((-2 * Math.PI * fc) / sr);
    const common = rnd();
    for (let c = 0; c < 2; c++) {
      const n = common * (1 - width) + rnd() * width;
      l1[c] = (1 - a) * n + a * l1[c];
      chans[c][i] = l1[c] * env;
    }
  }
  // Normalise energy so changing the decay doesn't jump the level much.
  let e = 0; for (const ch of chans) for (let i = 0; i < len; i++) e += ch[i] * ch[i];
  const k = 1 / Math.sqrt(Math.max(1e-9, e / 2)) * 0.6;
  for (const ch of chans) for (let i = 0; i < len; i++) ch[i] *= k;
  irCache.set(key, chans);
  if (irCache.size > 24) irCache.delete(irCache.keys().next().value);
  return makeImpulse(ctx, { decay, predelay, damping, width });
}

// ---------------------------------------------------------------- builders

/** Dry/wet wrapper: input → dry → output, input → wet chain → output. */
function wetDry(ctx, mix) {
  const input = ctx.createGain(); const output = ctx.createGain(); const dry = ctx.createGain(); const wet = ctx.createGain();
  input.connect(dry).connect(output); wet.connect(output);
  const setMix = (m) => { dry.gain.value = Math.cos((m * Math.PI) / 2); wet.gain.value = Math.sin((m * Math.PI) / 2); };
  setMix(mix);
  return { input, output, wet, setMix, nodes: [input, output, dry, wet] };
}

const disconnectAll = (nodes) => { for (const n of nodes) { try { n.disconnect(); } catch { /* already */ } try { n.stop?.(); } catch { /* not started */ } } };

function buildEq(ctx, p) {
  const input = ctx.createGain(); const output = ctx.createGain();
  let filters = [];
  const wire = (pp) => {
    disconnectAll(filters); try { input.disconnect(); } catch { /* fresh */ }
    filters = (pp.bands || []).filter((b) => b.on).map((b) => { const f = ctx.createBiquadFilter(); setBand(f, b); return f; });
    let n = input; for (const f of filters) { n.connect(f); n = f; } n.connect(output);
    output.gain.value = dbg(pp.output || 0);
  };
  let key = ''; let cur = p;
  const upd = (pp) => {
    const k = (pp.bands || []).map((b) => `${b.on}${b.type}`).join();
    if (k !== key) { key = k; wire(pp); } else {
      (pp.bands || []).filter((b) => b.on).forEach((b, i) => setBand(filters[i], b));
      output.gain.value = dbg(pp.output || 0);
    }
    cur = pp;
  };
  upd(cur);
  return { input, output, update: upd, dispose: () => disconnectAll([input, output, ...filters]) };
}
export function setBand(f, b) {
  f.type = b.type; f.frequency.value = b.f; f.Q.value = b.type.includes('shelf') ? 0.0001 + b.q : b.q; f.gain.value = b.g;
}

/** EQ magnitude response in dB at the given frequencies (for the curve). */
let respCtx = null;
export function eqResponse(params, freqs) {
  respCtx ||= new OfflineAudioContext(1, 1, 48000);
  const out = new Float32Array(freqs.length).fill(params.output || 0);
  const mag = new Float32Array(freqs.length); const ph = new Float32Array(freqs.length);
  for (const b of params.bands || []) {
    if (!b.on) continue;
    const f = respCtx.createBiquadFilter(); setBand(f, b);
    f.getFrequencyResponse(freqs, mag, ph);
    for (let i = 0; i < freqs.length; i++) out[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
  }
  return out;
}

export function buildEffect(ctx, fx) {
  const p = fx.params;
  switch (fx.type) {
    case 'eq': return buildEq(ctx, p);
    case 'compressor': {
      const c = ctx.createDynamicsCompressor(); const mk = ctx.createGain();
      const upd = (q) => { c.threshold.value = q.threshold; c.ratio.value = q.ratio; c.knee.value = q.knee; c.attack.value = q.attack / 1000; c.release.value = q.release / 1000; mk.gain.value = dbg(q.makeup); };
      upd(p); c.connect(mk);
      return { input: c, output: mk, update: upd, dispose: () => disconnectAll([c, mk]) };
    }
    case 'limiter': {
      const pre = ctx.createGain(); const c = ctx.createDynamicsCompressor(); const post = ctx.createGain();
      const upd = (q) => { pre.gain.value = dbg(q.input); c.threshold.value = q.ceiling - 0.5; c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.001; c.release.value = q.release / 1000; post.gain.value = 1; };
      upd(p); pre.connect(c).connect(post);
      return { input: pre, output: post, update: upd, dispose: () => disconnectAll([pre, c, post]) };
    }
    case 'gate': case 'deesser': case 'pitch': {
      const n = new AudioWorkletNode(ctx, `sl-${fx.type}`, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: p });
      if (fx.type !== 'pitch') return { input: n, output: n, update: (q) => n.port.postMessage(q), dispose: () => { disconnectAll([n]); n.port.close(); } };
      const wd = wetDry(ctx, 0); n.port.postMessage({ ...p, mix: 1 });
      wd.input.connect(n).connect(wd.wet);
      const upd = (q) => { n.port.postMessage({ ...q, mix: 1 }); wd.setMix(q.mix); };
      upd(p);
      return { input: wd.input, output: wd.output, update: upd, dispose: () => { disconnectAll([...wd.nodes, n]); n.port.close(); } };
    }
    case 'reverb': {
      const wd = wetDry(ctx, p.mix); const conv = ctx.createConvolver(); conv.normalize = false;
      wd.input.connect(conv).connect(wd.wet);
      let key = '';
      const upd = (q) => {
        const k = `${q.decay}:${q.predelay}:${q.damping}:${q.width}`;
        if (k !== key) { key = k; conv.buffer = makeImpulse(ctx, q); }
        wd.setMix(q.mix);
      };
      upd(p);
      return { input: wd.input, output: wd.output, update: upd, dispose: () => disconnectAll([...wd.nodes, conv]) };
    }
    case 'delay': {
      const wd = wetDry(ctx, p.mix); const d = ctx.createDelay(2.5); const fb = ctx.createGain(); const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      wd.input.connect(d); d.connect(tone).connect(fb).connect(d); tone.connect(wd.wet);
      const upd = (q) => { d.delayTime.value = q.time / 1000; fb.gain.value = q.feedback; tone.frequency.value = q.tone; wd.setMix(q.mix); };
      upd(p);
      return { input: wd.input, output: wd.output, update: upd, dispose: () => disconnectAll([...wd.nodes, d, fb, tone]) };
    }
    case 'chorus': {
      const wd = wetDry(ctx, p.mix); const merge = ctx.createChannelMerger(2);
      const ds = [ctx.createDelay(0.1), ctx.createDelay(0.1)]; const lfo = ctx.createOscillator(); const depthL = ctx.createGain(); const depthR = ctx.createGain();
      // Two mono voices (one per side) modulated in opposite phase widen the sound.
      for (const d of ds) { d.channelCount = 1; d.channelCountMode = 'explicit'; wd.input.connect(d); }
      ds[0].connect(merge, 0, 0); ds[1].connect(merge, 0, 1); merge.connect(wd.wet);
      lfo.connect(depthL).connect(ds[0].delayTime); lfo.connect(depthR).connect(ds[1].delayTime);
      lfo.start();
      const upd = (q) => {
        lfo.frequency.value = q.rate; depthL.gain.value = q.depth / 1000; depthR.gain.value = -q.depth / 1000;
        ds[0].delayTime.value = q.delay / 1000; ds[1].delayTime.value = q.delay / 1000; wd.setMix(q.mix);
      };
      upd(p);
      return { input: wd.input, output: wd.output, update: upd, dispose: () => disconnectAll([...wd.nodes, merge, ...ds, lfo, depthL, depthR]) };
    }
    case 'highpass': case 'lowpass': {
      const f = ctx.createBiquadFilter(); f.type = fx.type;
      const upd = (q) => { f.frequency.value = q.freq; f.Q.value = q.q; };
      upd(p);
      return { input: f, output: f, update: upd, dispose: () => disconnectAll([f]) };
    }
    case 'gain': default: {
      const g = ctx.createGain(); const upd = (q) => { g.gain.value = dbg(q.gain || 0); };
      upd(p);
      return { input: g, output: g, update: upd, dispose: () => disconnectAll([g]) };
    }
  }
}

/**
 * A rack: fixed input/output gains with the enabled effects between them. update(effects) changes parameters in place,
 * or rewires when effects are added, removed, reordered or switched on/off.
 */
export function buildRack(ctx, effects) {
  const input = ctx.createGain(); const output = ctx.createGain();
  let items = []; let key = null;
  const wire = (list) => {
    try { input.disconnect(); } catch { /* fresh */ }
    for (const it of items) it.node.dispose();
    items = list.filter((e) => e.on && FX[e.type]).map((e) => ({ id: e.id, node: buildEffect(ctx, e) }));
    let n = input; for (const it of items) { n.connect(it.node.input); n = it.node.output; } n.connect(output);
  };
  const update = (list = []) => {
    const k = list.map((e) => `${e.id}:${e.type}:${e.on}`).join('|');
    if (k !== key) { key = k; wire(list); return; }
    const on = list.filter((e) => e.on && FX[e.type]);
    on.forEach((e, i) => items[i]?.node.update(e.params));
  };
  update(effects);
  return { input, output, update, dispose: () => { for (const it of items) it.node.dispose(); disconnectAll([input, output]); } };
}
