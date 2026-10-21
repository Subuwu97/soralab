// Lip-sync from the microphone, for when there's no camera (or to sharpen the mouth when there is):
// loudness opens the mouth, and the two lowest formants (resonances of the mouth) pick the vowel A / I / U / E / O.
// Japanese vowel formants (F1, F2 in Hz), roughly, for an average adult voice; higher voices shift up, so we compare
// against these after normalising by the speaker's typical F2 range.
const VOWELS = { A: [780, 1250], I: [320, 2350], U: [360, 1450], E: [520, 1950], O: [520, 900] };

export class MicLipSync {
  constructor() { this.level = 0; this.open = 0; this.vis = { A: 0, I: 0, U: 0, E: 0, O: 0 }; this.on = false; }
  async start(deviceId) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.ac = new AudioContext();
    const src = this.ac.createMediaStreamSource(this.stream);
    this.an = this.ac.createAnalyser(); this.an.fftSize = 2048; this.an.smoothingTimeConstant = 0.5;
    src.connect(this.an);
    this.time = new Float32Array(this.an.fftSize); this.freq = new Float32Array(this.an.frequencyBinCount);
    this.on = true;
  }
  stop() { this.on = false; this.stream?.getTracks().forEach((t) => t.stop()); this.ac?.close().catch(() => {}); this.stream = null; this.ac = null; this.open = 0; }

  /** Call every frame. Returns { mouthOpen, mouthA..mouthO, level } in 0..1. */
  sample({ gain = 1, threshold = 0.02, visemes = true } = {}) {
    if (!this.on || !this.an) return null;
    this.an.getFloatTimeDomainData(this.time);
    let sum = 0; for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    const rms = Math.sqrt(sum / this.time.length);
    this.level = rms;
    const target = Math.max(0, Math.min(1, ((rms - threshold) * 9 * gain)));
    // open quickly, close a bit slower (looks more natural than following every syllable exactly)
    this.open += (target - this.open) * (target > this.open ? 0.6 : 0.3);
    const out = { mouthOpen: this.open, level: rms };
    if (visemes) {
      const v = target > 0.05 ? this.formants() : null;
      for (const k of Object.keys(this.vis)) this.vis[k] += ((v ? v[k] : 0) - this.vis[k]) * 0.35;
      for (const k of Object.keys(this.vis)) out[`mouth${k}`] = this.vis[k] * Math.min(1, this.open * 1.4);
    }
    return out;
  }

  /** Finds F1 and F2 as the strongest peaks in their ranges of a smoothed spectrum, then weights the vowels. */
  formants() {
    this.an.getFloatFrequencyData(this.freq);
    const hz = this.ac.sampleRate / this.an.fftSize;
    const sm = new Float32Array(this.freq.length);
    for (let i = 2; i < sm.length - 2; i++) sm[i] = (this.freq[i - 2] + 2 * this.freq[i - 1] + 3 * this.freq[i] + 2 * this.freq[i + 1] + this.freq[i + 2]) / 9;
    const peak = (lo, hi) => { let best = -Infinity; let at = lo; for (let i = Math.floor(lo / hz); i <= Math.ceil(hi / hz) && i < sm.length; i++) if (sm[i] > best) { best = sm[i]; at = i * hz; } return at; };
    const f1 = peak(250, 950); const f2 = peak(Math.max(800, f1 + 250), 2800);
    return vowelWeights(f1, f2);
  }
}

/** Soft vowel weights (0..1, summing to ~1) for a pair of formants. */
export function vowelWeights(f1, f2) {
  const w = {}; let total = 0;
  for (const [k, [a, b]] of Object.entries(VOWELS)) {
    const d = ((f1 - a) / 180) ** 2 + ((f2 - b) / 420) ** 2;
    w[k] = Math.exp(-d); total += w[k];
  }
  for (const k of Object.keys(w)) w[k] = total > 1e-6 ? w[k] / total : 0;
  return w;
}
