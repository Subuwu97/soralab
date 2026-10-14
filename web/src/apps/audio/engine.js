// The sound engine: decodes assets to AudioBuffers (cached), builds the mixer graph (tracks → effect racks → volume/pan →
// master rack), schedules clips with their fades/envelopes as gain automation, plays and loops, records from the mic,
// meters levels and loudness, and renders mixdowns offline with exactly the same graph.
import { assetSrc } from '../../lib/doc.js';
import { api } from '../../lib/api.js';
import { getPeaks } from '../_media/media.js';
import { buildRack, ensureWorklets } from './effects.js';
import { mipmap, fromBuffer } from './dsp.js';
import { effectiveFades, clipGainAt, clipIsAutomated, clipEnd, dbToGain, sessionEnd, soundKey } from './model.js';

const CURVE_RATE = 200; // gain automation points per second
const LEAD = 0.06;      // seconds between asking to play and the first sample

// ---------------------------------------------------------------- the mixer graph

/**
 * Track strips and the master bus for a context. sync(doc) keeps it in step with the document (adds/removes strips,
 * updates racks, volume, pan, mute/solo). With meters, every strip and the master get analysers.
 */
export function createMixer(ctx, doc, { meters = false, live = false } = {}) {
  const set = (param, v) => { if (live) param.setTargetAtTime(v, ctx.currentTime, 0.015); else param.value = v; };
  const mRack = buildRack(ctx, doc.master.effects);
  const mVol = ctx.createGain();
  mRack.output.connect(mVol);
  const out = ctx.createGain();
  mVol.connect(out);
  const m = { rack: mRack, vol: mVol };
  if (meters) {
    const split = ctx.createChannelSplitter(2); m.an = [ctx.createAnalyser(), ctx.createAnalyser()];
    out.connect(split); m.an.forEach((a, i) => { a.fftSize = 2048; split.connect(a, i); });
    // K-weighted copy for the loudness meter (Web Audio's shelf is a close stand-in for BS.1770's).
    const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1500; shelf.gain.value = 4;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
    const ks = ctx.createChannelSplitter(2); m.k = [ctx.createAnalyser(), ctx.createAnalyser()];
    out.connect(shelf).connect(hp).connect(ks); m.k.forEach((a, i) => { a.fftSize = 4096; ks.connect(a, i); });
  }
  const tracks = new Map();
  const strip = () => {
    const s = { input: ctx.createGain(), duck: ctx.createGain(), rack: buildRack(ctx, []), vol: ctx.createGain(), pan: ctx.createStereoPanner(), mute: ctx.createGain() };
    s.input.connect(s.duck).connect(s.rack.input); s.rack.output.connect(s.vol).connect(s.pan).connect(s.mute).connect(mRack.input);
    if (meters) { s.an = ctx.createAnalyser(); s.an.fftSize = 1024; s.mute.connect(s.an); }
    return s;
  };
  const sync = (d) => {
    const solo = d.tracks.some((t) => t.solo);
    for (const t of d.tracks) {
      let s = tracks.get(t.id);
      if (!s) { s = strip(); tracks.set(t.id, s); }
      s.rack.update(t.effects);
      set(s.vol.gain, dbToGain(t.volume)); set(s.pan.pan, t.pan);
      set(s.mute.gain, t.mute || (solo && !t.solo) ? 0 : 1);
    }
    for (const [id, s] of tracks) {
      if (d.tracks.some((t) => t.id === id)) continue;
      s.rack.dispose(); for (const n of [s.input, s.duck, s.vol, s.pan, s.mute, s.an]) n?.disconnect();
      tracks.delete(id);
    }
    mRack.update(d.master.effects); set(mVol.gain, dbToGain(d.master.volume));
  };
  sync(doc);
  return { out, master: m, tracks, sync, dispose: () => { for (const s of tracks.values()) s.rack.dispose(); mRack.dispose(); out.disconnect(); } };
}

/** Ducking: the target track's gain over the session, driven by how loud the source tracks are (20 frames/s). */
export function computeDuck(doc, mipFor) {
  const dk = doc.duck;
  if (!dk?.on || !dk.target || !dk.sources?.length) return null;
  const rate = 20; const end = sessionEnd(doc); const n = Math.ceil(end * rate) + 2;
  const level = new Float32Array(n);
  for (const t of doc.tracks) {
    if (!dk.sources.includes(t.id) || t.mute) continue;
    const tg = dbToGain(t.volume);
    for (const c of t.clips) {
      const mp = mipFor(c.asset); if (!mp) continue;
      const g = dbToGain(c.gain) * tg;
      for (let f = Math.floor(c.start * rate); f < Math.min(n, Math.ceil(clipEnd(c) * rate)); f++) {
        const src = c.in + (f / rate - c.start);
        const b0 = Math.max(0, Math.floor((src * mp.sampleRate) / mp.block)); const b1 = Math.min(mp.lo.length, Math.ceil(((src + 1 / rate) * mp.sampleRate) / mp.block));
        let pk = 0; for (let b = b0; b < b1; b++) pk = Math.max(pk, mp.hi[b], -mp.lo[b]);
        level[f] = Math.max(level[f], pk * g);
      }
    }
  }
  const thr = dbToGain(dk.threshold); const low = dbToGain(dk.amount);
  const att = Math.exp(-1 / (Math.max(0.01, dk.attack) * rate)); const rel = Math.exp(-1 / (Math.max(0.01, dk.release) * rate));
  const out = new Float32Array(n); let g = 1;
  // Look a little ahead so the music is already down when the voice starts.
  const ahead = Math.round(dk.attack * rate);
  for (let f = 0; f < n; f++) {
    let hot = false; for (let j = f; j <= Math.min(n - 1, f + ahead); j++) if (level[j] > thr) { hot = true; break; }
    const target = hot ? low : 1;
    g = target + (g - target) * (target < g ? att : rel);
    out[f] = g;
  }
  return { rate, data: out };
}

/** Schedules every clip that sounds in [from, to) to start at context time `when`. Returns the sources. */
export function scheduleSegment(ctx, doc, mixer, bufferFor, from, to, when, duck) {
  const sources = [];
  for (const t of doc.tracks) {
    const strip = mixer.tracks.get(t.id); if (!strip) continue;
    for (const c of t.clips) {
      const s = Math.max(c.start, from); const e = Math.min(clipEnd(c), to);
      if (e - s < 0.001) continue;
      const buf = bufferFor(c.asset); if (!buf) continue;
      const offset = c.in + (s - c.start);
      if (offset >= buf.duration) continue;
      const dur = Math.min(e - s, buf.duration - offset);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain();
      const fades = effectiveFades(t, c); const at = when + (s - from);
      if (clipIsAutomated(c, fades)) {
        const n = Math.max(2, Math.ceil(dur * CURVE_RATE) + 1); const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) curve[i] = clipGainAt(c, fades, s - c.start + (dur * i) / (n - 1));
        g.gain.value = curve[0];
        g.gain.setValueCurveAtTime(curve, at, Math.max(0.001, dur));
      } else g.gain.value = dbToGain(c.gain);
      src.connect(g).connect(strip.input);
      src.start(at, offset, dur);
      sources.push(src);
    }
  }
  if (duck && doc.duck?.target) {
    const strip = mixer.tracks.get(doc.duck.target);
    if (strip) {
      const i0 = Math.floor(from * duck.rate); const i1 = Math.min(duck.data.length, Math.ceil(to * duck.rate) + 1);
      const p = strip.duck.gain;
      p.cancelScheduledValues(when);
      if (i1 - i0 >= 2 && Number.isFinite(to)) p.setValueCurveAtTime(duck.data.slice(i0, i1), when, Math.max(0.01, (to - from) * 0.999));
      else p.setValueAtTime(duck.data[Math.min(i0, duck.data.length - 1)] ?? 1, when);
    }
  }
  return sources;
}

// ---------------------------------------------------------------- the live engine

export class Engine {
  constructor() {
    this.doc = null;
    this.loading = new Map(); this.ready = new Map(); this.mips = new Map(); this.peaks = new Map();
    this.subs = new Set();
    this.ctx = null; this.mixer = null;
    this.playing = false; this.recording = false;
    this.segs = []; this.sources = []; this.startPos = 0; this.idlePos = 0;
    this.lufs = { blocks: [], ring: [], momentary: -Infinity, short: -Infinity, integrated: -Infinity };
    this.timer = null;
    this.docId = null;
  }
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(what) { for (const f of this.subs) f(what); }

  get sampleRate() { return this.doc?.sampleRate || 48000; }

  // ------------------------------------------------------------ media
  /** Decoded audio for an asset (cached). Video files give their soundtrack. */
  load(id) {
    if (this.loading.has(id)) return this.loading.get(id);
    const p = (async () => {
      const dec = new OfflineAudioContext(1, 1, this.sampleRate);
      const r = await fetch(assetSrc(id), { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`Couldn’t load audio (${r.status})`);
      let buf;
      try {
        buf = await dec.decodeAudioData(await r.arrayBuffer());
      } catch (e) {
        // The browser can't decode it (e.g. a codec Chromium lacks): have the server extract a WAV and use that.
        buf = await this.serverDecode(id, dec).catch(() => { throw e; });
      }
      this.putBuffer(id, buf);
      return buf;
    })();
    this.loading.set(id, p);
    p.catch(() => this.loading.delete(id));
    return p;
  }
  async serverDecode(id, dec) {
    let job = await api.post('/api/jobs', { kind: 'transcode', name: 'Audio for editing', doc_id: this.docId, spec: { asset_id: id, preset: 'wav' } });
    while (['queued', 'running'].includes(job.status)) { await new Promise((r) => setTimeout(r, 700)); job = await api.get(`/api/jobs/${job.id}`); }
    if (job.status !== 'done') throw new Error(job.error || 'Couldn’t read the sound');
    const r = await fetch(job.output.url, { credentials: 'same-origin' });
    return dec.decodeAudioData(await r.arrayBuffer());
  }
  putBuffer(id, buf) {
    this.ready.set(id, buf);
    if (!this.loading.has(id)) this.loading.set(id, Promise.resolve(buf));
    this.mips.set(id, mipmap(fromBufferView(buf)));
    this.emit('wave');
  }
  /** Overview waveform from the server (fast to show while the full decode runs). */
  loadPeaks(id, duration) {
    if (this.peaks.has(id)) return;
    this.peaks.set(id, null);
    const n = Math.max(400, Math.min(20000, Math.round((duration || 60) * 60)));
    getPeaks(id, n).then((p) => { this.peaks.set(id, p); this.emit('wave'); });
  }
  async loadAll(doc = this.doc) {
    const ids = [...new Set(doc.tracks.flatMap((t) => t.clips.map((c) => c.asset)))];
    await Promise.all(ids.map((id) => this.load(id).catch(() => null)));
  }

  /**
   * Draws a waveform for source seconds [from, to) into the rect (x, top, w, h). Uses the decoded audio when it has
   * enough detail, else the server peaks.
   */
  drawWave(g, id, from, to, x, top, w, h, { color = '#fff', gain = 1 } = {}) {
    if (w < 1 || to <= from) return;
    const mid = top + h / 2; const half = h / 2;
    const mp = this.mips.get(id); const pk = this.peaks.get(id);
    g.fillStyle = color;
    const x0 = Math.max(0, Math.floor(x)); const x1 = Math.ceil(x + w);
    const spp = (to - from) / w; // seconds per pixel
    if (mp) {
      const buf = this.ready.get(id);
      const raw = spp * mp.sampleRate < mp.block * 2 && buf;
      const chans = raw ? Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)) : null;
      for (let px = x0; px < x1; px++) {
        const a = from + (px - x) * spp; const b = a + spp;
        let lo = 0; let hi = 0;
        if (raw) {
          const i0 = Math.max(0, Math.floor(a * mp.sampleRate)); const i1 = Math.min(mp.length, Math.max(i0 + 1, Math.ceil(b * mp.sampleRate)));
          for (const c of chans) for (let i = i0; i < i1; i++) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        } else {
          const b0 = Math.max(0, Math.floor((a * mp.sampleRate) / mp.block)); const b1 = Math.min(mp.lo.length, Math.max(b0 + 1, Math.ceil((b * mp.sampleRate) / mp.block)));
          for (let i = b0; i < b1; i++) { if (mp.lo[i] < lo) lo = mp.lo[i]; if (mp.hi[i] > hi) hi = mp.hi[i]; }
        }
        const y0 = mid - Math.min(1, hi * gain) * half; const y1 = mid - Math.max(-1, lo * gain) * half;
        g.fillRect(px, y0, 1, Math.max(1, y1 - y0));
      }
      return;
    }
    if (pk?.peaks?.length && pk.duration) {
      const per = pk.duration / pk.peaks.length;
      for (let px = x0; px < x1; px++) {
        const a = from + (px - x) * spp; const b = a + spp;
        const i0 = Math.max(0, Math.floor(a / per)); const i1 = Math.min(pk.peaks.length, Math.max(i0 + 1, Math.ceil(b / per)));
        let lo = 0; let hi = 0;
        for (let i = i0; i < i1; i++) { const p = pk.peaks[i]; if (p[0] < lo) lo = p[0]; if (p[1] > hi) hi = p[1]; }
        const y0 = mid - Math.min(1, hi * gain) * half; const y1 = mid - Math.max(-1, lo * gain) * half;
        g.fillRect(px, y0, 1, Math.max(1, y1 - y0));
      }
    }
  }

  // ------------------------------------------------------------ context and document
  async ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate, latencyHint: 'interactive' });
      await ensureWorklets(this.ctx);
      this.mixer = createMixer(this.ctx, this.doc, { meters: true, live: true });
      this.mixer.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  setDoc(doc) {
    const prev = this.doc;
    this.doc = doc;
    for (const t of doc.tracks) for (const c of t.clips) { const f = doc.files.find((x) => x.id === c.asset); this.loadPeaks(c.asset, f?.duration); this.load(c.asset).catch(() => {}); }
    if (this.mixer) this.mixer.sync(doc);
    // Clips, ducking or the loop changed mid-play: pick up from where we are.
    if (this.playing && prev && (soundKey(prev) !== soundKey(doc) || JSON.stringify(prev.loop) !== JSON.stringify(doc.loop))) {
      clearTimeout(this.restartT);
      this.restartT = setTimeout(() => { if (this.playing) this.restart(this.position); }, 30);
    }
  }

  // ------------------------------------------------------------ transport
  get position() {
    if (!this.playing || !this.ctx) return this.idlePos;
    const now = this.ctx.currentTime;
    let s = this.segs[0];
    for (const x of this.segs) if (x.when <= now) s = x;
    if (!s) return this.idlePos;
    return Math.min(s.to, s.from + Math.max(0, now - s.when));
  }
  seek(t) {
    t = Math.max(0, t);
    if (this.playing && !this.recording) this.restart(t);
    else this.idlePos = t;
    this.emit('seek');
  }
  loopOn() { const l = this.doc?.loop; return !!(l?.on && l.end - l.start > 0.05); }

  async play(from = this.idlePos) {
    this.stopPreview();
    await this.ensureCtx();
    await this.loadAll();
    this.startPos = from;
    this.playing = true;
    this.restart(from);
    this.lufs = { blocks: [], ring: [], momentary: -Infinity, short: -Infinity, integrated: -Infinity, last: 0 };
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), 100);
    this.emit('state');
  }
  restart(from) {
    for (const s of this.sources) { try { s.stop(); } catch { /* ended */ } s.disconnect(); }
    this.sources = []; this.segs = [];
    this.duck = computeDuck(this.doc, (id) => this.mips.get(id));
    const when = this.ctx.currentTime + LEAD;
    const l = this.doc.loop;
    const to = this.recording ? Infinity : this.loopOn() && from < l.end ? l.end : Math.max(sessionEnd(this.doc), from);
    this.queue(from, to, when);
  }
  queue(from, to, when) {
    this.segs.push({ from, to, when });
    this.sources.push(...scheduleSegment(this.ctx, this.doc, this.mixer, (id) => this.ready.get(id), from, Number.isFinite(to) ? to : from + 24 * 3600, when, this.duck));
  }
  /** Keeps loops seamless (schedules the next pass ahead of time) and stops at the end. */
  pump() {
    if (!this.playing) return;
    const now = this.ctx.currentTime; const last = this.segs[this.segs.length - 1];
    const lastEnd = last.when + (last.to - last.from);
    if (this.loopOn() && !this.recording) {
      const l = this.doc.loop;
      if (now > lastEnd - 0.4 && last.to === l.end) this.queue(l.start, l.end, lastEnd);
      if (this.segs.length > 3) this.segs.splice(0, this.segs.length - 3);
    } else if (!this.recording && now > lastEnd + 0.05) this.stop();
  }
  stop({ keep = false } = {}) {
    if (!this.playing) return;
    const pos = this.position;
    for (const s of this.sources) { try { s.stop(); } catch { /* ended */ } s.disconnect(); }
    this.sources = []; this.segs = [];
    if (this.mixer) for (const s of this.mixer.tracks.values()) { s.duck.gain.cancelScheduledValues(0); s.duck.gain.value = 1; }
    this.playing = false;
    clearInterval(this.timer);
    // Like Audition: stopping returns the playhead to where playback started (unless asked to keep it).
    this.idlePos = keep ? pos : this.startPos;
    this.emit('state');
  }

  // ------------------------------------------------------------ meters
  /** Peak levels (linear) for each track, the master L/R, and approximate loudness. Call once per frame. */
  levels() {
    const out = { tracks: new Map(), master: [0, 0], input: 0 };
    if (this.input) out.input = peakOf(this.input.an);
    if (!this.mixer || !this.playing) return out;
    for (const [id, s] of this.mixer.tracks) out.tracks.set(id, peakOf(s.an));
    out.master = this.mixer.master.an.map(peakOf);
    // Loudness: mean square of the K-weighted signal, collected into 100 ms steps → 400 ms (momentary) and 3 s (short-term)
    // windows, and gated 400 ms blocks for the integrated value since playback started.
    const now = this.ctx.currentTime; const L = this.lufs;
    const ms = this.mixer.master.k.reduce((p, a) => p + meanSquare(a), 0);
    L.ring.push({ t: now, ms });
    while (L.ring.length && L.ring[0].t < now - 3) L.ring.shift();
    const avg = (win) => { const r = L.ring.filter((x) => x.t >= now - win); return r.length ? r.reduce((p, x) => p + x.ms, 0) / r.length : 0; };
    const lu = (x) => (x > 0 ? -0.691 + 10 * Math.log10(x) : -Infinity);
    const mom = avg(0.4);
    L.momentary = lu(mom); L.short = lu(avg(3));
    if (now - L.last >= 0.1) {
      L.last = now;
      if (L.momentary > -70) L.blocks.push(mom);
      if (L.blocks.length) {
        const all = L.blocks.reduce((p, x) => p + x, 0) / L.blocks.length;
        const g = L.blocks.filter((x) => lu(x) > lu(all) - 10);
        L.integrated = lu(g.reduce((p, x) => p + x, 0) / Math.max(1, g.length));
      }
    }
    out.lufs = { momentary: L.momentary, short: L.short, integrated: L.integrated };
    return out;
  }

  // ------------------------------------------------------------ recording
  async openInput() {
    if (this.input) return this.input;
    await this.ensureCtx();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = this.ctx.createMediaStreamSource(stream); const an = this.ctx.createAnalyser(); an.fftSize = 1024;
    src.connect(an);
    this.input = { stream, src, an };
    this.emit('input');
    return this.input;
  }
  closeInput() {
    if (!this.input || this.recording) return;
    this.input.stream.getTracks().forEach((t) => t.stop()); this.input.src.disconnect();
    this.input = null;
    this.emit('input');
  }
  async record(from) {
    const inp = await this.openInput();
    const node = new AudioWorkletNode(this.ctx, 'sl-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    const chunks = [];
    node.port.onmessage = (e) => chunks.push(e.data);
    inp.src.connect(node); node.connect(sink).connect(this.ctx.destination);
    this.rec = { node, sink, chunks, from, began: this.ctx.currentTime };
    this.recording = true;
    if (this.playing) this.stop();
    await this.play(from);
    this.rec.startAt = this.segs[0]?.when ?? this.ctx.currentTime;
    this.emit('state');
  }
  /** Stops recording; resolves to { audio: { channels, sampleRate }, from } (or null if nothing was captured). */
  async stopRecording() {
    if (!this.rec) return null;
    const r = this.rec; this.rec = null;
    r.node.port.postMessage('stop');
    await new Promise((res) => setTimeout(res, 80));
    r.node.disconnect(); r.sink.disconnect(); try { this.input?.src.disconnect(r.node); } catch { /* gone */ }
    this.recording = false;
    this.stop({ keep: true });
    const sr = this.ctx.sampleRate;
    const nch = Math.max(1, Math.min(2, r.chunks[0]?.length || 1));
    const total = r.chunks.reduce((p, c) => p + c[0].length, 0);
    // Line the take up with the timeline: drop what was captured before playback reached `from`.
    const skip = Math.max(0, Math.round((r.startAt - r.began + (this.ctx.outputLatency || 0)) * sr));
    if (total - skip < sr * 0.1) return null;
    const channels = Array.from({ length: nch }, () => new Float32Array(total - skip));
    let o = -skip;
    for (const c of r.chunks) {
      const n = c[0].length;
      for (let ch = 0; ch < nch; ch++) {
        const src = c[Math.min(ch, c.length - 1)];
        if (o >= 0) channels[ch].set(src, o); else if (o + n > 0) channels[ch].set(src.subarray(-o), 0);
      }
      o += n;
    }
    // A mono mic arrives as two identical channels: keep one.
    const mono = nch === 2 && channels[0].every((v, i) => i % 64 !== 0 || v === channels[1][i]);
    this.emit('state');
    return { audio: { channels: mono ? [channels[0]] : channels, sampleRate: sr }, from: r.from };
  }

  // ------------------------------------------------------------ preview (waveform editor)
  /** Plays a buffer straight out (the waveform editor's transport). Returns { position(), stop() }. */
  async preview(buf, from, to, onEnd) {
    if (this.playing) this.stop();
    this.stopPreview();
    await this.ensureCtx();
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination);
    const when = this.ctx.currentTime + 0.03;
    src.start(when, from, Math.max(0.01, to - from));
    const h = { src, position: () => Math.min(to, from + Math.max(0, this.ctx.currentTime - when)), stop: () => { try { src.stop(); } catch { /* ended */ } src.disconnect(); } };
    src.onended = () => { if (this.prev === h) { this.prev = null; onEnd?.(); } };
    this.prev = h;
    return h;
  }
  stopPreview() { if (this.prev) { const p = this.prev; this.prev = null; p.stop(); } }

  // ------------------------------------------------------------ mixdown
  /** Renders [from, to) of the session with every effect, at `sampleRate`, to an AudioBuffer. */
  async render(doc, { from = 0, to = sessionEnd(doc), sampleRate = doc.sampleRate, onProgress } = {}) {
    await this.loadAll(doc);
    const len = Math.max(1, Math.ceil((to - from) * sampleRate));
    const ctx = new OfflineAudioContext(2, len, sampleRate);
    await ensureWorklets(ctx);
    const mixer = createMixer(ctx, doc);
    mixer.out.connect(ctx.destination);
    const duck = computeDuck(doc, (id) => this.mips.get(id));
    scheduleSegment(ctx, doc, mixer, (id) => this.ready.get(id), from, to, 0, duck);
    const dur = to - from;
    if (onProgress && dur > 1) {
      for (let i = 1; i < 10; i++) ctx.suspend((dur * i) / 10).then(() => { onProgress(i / 10, 'Mixing down…'); ctx.resume(); }).catch(() => {});
    }
    return ctx.startRendering();
  }

  dispose() {
    this.stop(); this.stopPreview(); clearInterval(this.timer);
    if (this.input) { this.input.stream.getTracks().forEach((t) => t.stop()); this.input = null; }
    this.mixer?.dispose();
    this.ctx?.close().catch(() => {});
    this.ctx = null; this.subs.clear();
  }
}

// Read-only view of an AudioBuffer's channels (mipmap doesn't need copies).
const fromBufferView = (b) => ({ sampleRate: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i)) });
export { fromBuffer };

const scratch = new Float32Array(4096);
function peakOf(an) {
  if (!an) return 0;
  const a = scratch.subarray(0, an.fftSize); an.getFloatTimeDomainData(a);
  let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; }
  return p;
}
function meanSquare(an) {
  const a = scratch.subarray(0, an.fftSize); an.getFloatTimeDomainData(a);
  let e = 0; for (let i = 0; i < a.length; i++) e += a[i] * a[i];
  return e / a.length;
}
