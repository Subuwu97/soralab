// Real-time preview for the Program monitor. Each visible clip near the playhead gets its own hidden <video> (or <audio>)
// element, kept in step with the playhead; every animation frame the visible video clips are composited onto a canvas
// (transform, crop, opacity, fades, transitions and an approximation of the effects), and the sound goes through Web Audio:
// clip gain/pan → track gain/pan (+ meters) → master gain (+ meters) → speakers.
import { assetSrc } from '../../lib/doc.js';
import { tracksOf, clipsOn, resolveTrack, effective, valueAt, trackVisible, trackAudible, clipEnd, clamp } from './model.js';
import { drawTitle, loadTitleFont, titleKey } from './titles.js';

const PRELOAD = 2.5; // seconds ahead that upcoming clips get their media element ready

function hexRgb(c) {
  const h = String(c || '#000').replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

/** Opacity multiplier from clip fades and an incoming dissolve at clip time ct. */
function fadeAlpha(c, ct) {
  let a = 1;
  const fi = Math.max(c.fade_in || 0, c._xin || 0);
  if (fi > 0 && ct < fi) a *= clamp(ct / fi, 0, 1);
  if (c.fade_out > 0 && ct > c.duration - c.fade_out) a *= clamp((c.duration - ct) / c.fade_out, 0, 1);
  return a;
}

export class Engine {
  constructor() {
    this.t = 0;
    this.playing = false;
    this.rate = 1;
    this.doc = null;
    this.canvas = null;
    this.subs = new Set();
    this.videos = new Map();
    this.audios = new Map();
    this.images = new Map();
    this.titles = new Map();
    this.dirty = true;
    this.quality = 1;
    this.meters = { master: [0, 0], tracks: {} };
    this.host = document.createElement('div');
    this.host.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none';
    this.scratch = document.createElement('canvas');
    this.tiny = document.createElement('canvas');
  }

  /** Starts the frame loop (call from an effect; stop() undoes it, and it can start again). */
  start() {
    if (!this.host.isConnected) document.body.appendChild(this.host);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
  }
  stop() {
    cancelAnimationFrame(this.raf);
    this.playing = false;
    for (const v of this.videos.values()) this.dropEl(v.el);
    for (const a of this.audios.values()) { this.dropEl(a.el); try { a.node.disconnect(); } catch { /* gone */ } }
    this.videos.clear(); this.audios.clear();
    this.host.remove();
    this.ac?.close().catch(() => {});
    this.ac = null;
  }

  // ------------------------------------------------------------ state

  subscribe = (fn) => { this.subs.add(fn); return () => this.subs.delete(fn); };
  getT = () => this.t;
  emit() { for (const f of this.subs) f(this.t); }
  setDoc(doc) { this.doc = doc; this.dirty = true; }
  attach(canvas) { this.canvas = canvas; this.dirty = true; }
  get end() { return this.doc ? this.doc.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0) : 0; }

  seek(t) {
    this.t = Math.max(0, t);
    if (this.playing) { this.t0 = this.t; this.wall0 = performance.now(); }
    this.dirty = true;
    this.emit();
  }
  play(rate = 1) {
    this.ensureAudio();
    if (this.t >= this.end - 0.01 && rate > 0) this.t = 0;
    this.rate = rate;
    this.playing = true;
    this.t0 = this.t; this.wall0 = performance.now();
    this.emit();
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.rate = 1;
    for (const v of this.videos.values()) v.el.pause();
    for (const a of this.audios.values()) a.el.pause();
    this.t = Math.round(this.t * (this.doc?.fps || 30)) / (this.doc?.fps || 30);
    this.dirty = true;
    this.emit();
  }
  toggle() { if (this.playing) this.pause(); else this.play(1); }
  /** J/K/L: each press of L (J) speeds up forwards (backwards); K stops. */
  shuttle(dir) {
    if (dir === 0) { this.pause(); return; }
    const cur = this.playing ? this.rate : 0;
    const next = Math.sign(cur) === dir ? clamp(Math.abs(cur) * 2, 1, 8) * dir : dir;
    this.play(next);
  }

  // ------------------------------------------------------------ audio graph

  ensureAudio() {
    if (!this.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC({ latencyHint: 'interactive' });
      this.master = this.ac.createGain();
      this.masterMeter = this.meterNode(this.master);
      this.master.connect(this.ac.destination);
      this.trackNodes = new Map();
    }
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
  }
  meterNode(src) {
    const split = this.ac.createChannelSplitter(2);
    const l = this.ac.createAnalyser(); const r = this.ac.createAnalyser();
    l.fftSize = r.fftSize = 1024;
    src.connect(split); split.connect(l, 0); split.connect(r, 1);
    return { l, r, buf: new Float32Array(1024) };
  }
  readMeter(m) {
    const peak = (an) => { an.getFloatTimeDomainData(m.buf); let p = 0; for (let i = 0; i < m.buf.length; i++) { const v = Math.abs(m.buf[i]); if (v > p) p = v; } return p; };
    return [peak(m.l), peak(m.r)];
  }
  trackNode(track) {
    let n = this.trackNodes.get(track.id);
    if (!n) {
      const gain = this.ac.createGain(); const pan = this.ac.createStereoPanner();
      gain.connect(pan); pan.connect(this.master);
      n = { gain, pan, meter: this.meterNode(pan) };
      this.trackNodes.set(track.id, n);
    }
    return n;
  }

  // ------------------------------------------------------------ media elements

  dropEl(el) { el.pause(); el.removeAttribute('src'); el.load(); el.remove(); }
  videoFor(c) {
    let v = this.videos.get(c.id);
    if (v && v.asset !== c.asset_id) { this.dropEl(v.el); v = null; }
    if (!v) {
      const el = document.createElement('video');
      el.muted = true; el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
      el.src = assetSrc(c.asset_id);
      el.addEventListener('seeked', () => { this.dirty = true; });
      el.addEventListener('loadeddata', () => { this.dirty = true; });
      this.host.appendChild(el);
      v = { el, asset: c.asset_id };
      this.videos.set(c.id, v);
    }
    v.used = true;
    return v;
  }
  audioFor(c, track) {
    let a = this.audios.get(c.id);
    if (a && a.asset !== c.asset_id) { this.dropEl(a.el); a.node.disconnect(); a = null; }
    if (!a) {
      const el = document.createElement('audio');
      el.preload = 'auto'; el.crossOrigin = 'anonymous';
      el.src = assetSrc(c.asset_id);
      this.host.appendChild(el);
      const node = this.ac.createMediaElementSource(el);
      const gain = this.ac.createGain(); const pan = this.ac.createStereoPanner();
      node.connect(gain); gain.connect(pan);
      a = { el, asset: c.asset_id, node, gain, pan, track: null };
      this.audios.set(c.id, a);
    }
    if (a.track !== track.id) { try { a.pan.disconnect(); } catch { /* not connected */ } a.pan.connect(this.trackNode(track).gain); a.track = track.id; }
    a.used = true;
    return a;
  }
  image(id) {
    let img = this.images.get(id);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { this.dirty = true; };
      img.src = assetSrc(id);
      this.images.set(id, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }
  titleCanvas(title, W, H, scale) {
    const key = `${titleKey(title, W, H)}@${scale.toFixed(3)}`;
    let e = this.titles.get(key);
    if (!e) {
      e = { canvas: null };
      this.titles.set(key, e);
      if (this.titles.size > 80) this.titles.delete(this.titles.keys().next().value);
      loadTitleFont(title).then(() => { e.canvas = drawTitle(title, W, H, scale); this.dirty = true; });
    }
    return e.canvas;
  }

  /** Keeps media elements in step with the playhead. */
  sync(t) {
    const doc = this.doc;
    const fps = doc.fps || 30;
    const playing = this.playing && this.rate > 0;
    for (const v of this.videos.values()) v.used = false;
    for (const a of this.audios.values()) a.used = false;
    const near = (c) => c.start <= t + (playing ? PRELOAD : 0.5) && clipEnd(c) > t - 0.5;
    for (const track of tracksOf(doc, 'video')) {
      if (!trackVisible(doc, track)) continue;
      for (const c of resolveTrack(doc, clipsOn(doc, track.id).map((x) => effective(x, doc)), false)) {
        if (c.type !== 'video' || !near(c)) continue;
        const { el } = this.videoFor(c);
        const active = t >= c.start && t < clipEnd(c);
        const target = (c.in || 0) + (clamp(t, c.start, clipEnd(c)) - c.start) * (c.speed || 1);
        if (playing && active) {
          const rate = clamp((c.speed || 1) * this.rate, 0.0625, 16);
          if (el.paused) {
            if (Math.abs(el.currentTime - target) > 0.08) el.currentTime = target; // usually already cued up
            el.playbackRate = rate;
            el.play().catch(() => {});
          } else if (!el.seeking) {
            // Small drift: speed up / slow down a little (seeking stalls the picture). Large drift: seek.
            const drift = el.currentTime - target;
            if (Math.abs(drift) > 0.6) el.currentTime = target;
            else el.playbackRate = clamp(rate * (1 - clamp(drift, -0.3, 0.3)), 0.0625, 16);
          }
        } else {
          if (!el.paused) el.pause();
          if (!el.seeking && Math.abs(el.currentTime - target) > 0.45 / fps) el.currentTime = target;
        }
      }
    }
    if (this.ac) {
      this.master.gain.value = doc.master ?? 1;
      for (const track of tracksOf(doc, 'audio')) {
        const tn = this.trackNode(track);
        tn.gain.gain.setTargetAtTime(trackAudible(doc, track) ? track.volume ?? 1 : 0, this.ac.currentTime, 0.015);
        tn.pan.pan.value = clamp(track.pan || 0, -1, 1);
        for (const c of resolveTrack(doc, clipsOn(doc, track.id), true)) {
          if (!near(c) || !c.asset_id) continue;
          const a = this.audioFor(c, track);
          const active = t >= c.start && t < clipEnd(c);
          const ct = t - c.start;
          const target = (c.in || 0) + clamp(ct, 0, c.duration) * (c.speed || 1);
          let g = c.mute ? 0 : valueAt(c, 'volume', ct);
          const fi = Math.max(c.fade_in || 0, c._xin || 0);
          if (fi > 0 && ct < fi) g *= Math.sin((clamp(ct / fi, 0, 1) * Math.PI) / 2);
          const fo = Math.max(c.fade_out || 0, c._xout || 0);
          if (fo > 0 && ct > c.duration - fo) g *= Math.sin((clamp((c.duration - ct) / fo, 0, 1) * Math.PI) / 2);
          a.gain.gain.setTargetAtTime(active ? g : 0, this.ac.currentTime, 0.01);
          a.pan.pan.value = clamp(c.pan || 0, -1, 1);
          if (playing && active && this.rate <= 2) {
            a.el.playbackRate = clamp((c.speed || 1) * this.rate, 0.0625, 16);
            if (a.el.paused) { a.el.currentTime = target; a.el.play().catch(() => {}); }
            else if (Math.abs(a.el.currentTime - target) > 0.2 && !a.el.seeking) a.el.currentTime = target;
          } else {
            if (!a.el.paused) a.el.pause();
            if (!a.el.seeking && Math.abs(a.el.currentTime - target) > 0.1) a.el.currentTime = target;
          }
        }
      }
    }
    // Let go of elements for clips that are far away (or deleted).
    for (const [id, v] of this.videos) if (!v.used) { this.dropEl(v.el); this.videos.delete(id); }
    for (const [id, a] of this.audios) if (!a.used) { this.dropEl(a.el); try { a.node.disconnect(); a.pan.disconnect(); } catch { /* gone */ } this.audios.delete(id); }
  }

  // ------------------------------------------------------------ the loop

  loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.doc) return;
    if (this.playing) {
      const t = this.t0 + ((performance.now() - this.wall0) / 1000) * this.rate;
      const end = this.end;
      if (this.rate > 0 && t >= end) { this.t = end; this.pause(); }
      else if (this.rate < 0 && t <= 0) { this.t = 0; this.pause(); }
      else this.t = t;
      this.emit();
      this.dirty = true;
    }
    this.sync(this.t);
    if (this.ac) {
      this.meters.master = this.readMeter(this.masterMeter);
      for (const [id, n] of this.trackNodes) this.meters.tracks[id] = this.readMeter(n.meter);
    }
    if (this.dirty && this.canvas) { this.dirty = false; this.draw(this.canvas, this.t); }
  };

  // ------------------------------------------------------------ compositing

  /** Draws the frame at t onto a canvas (its size sets the preview resolution). */
  draw(canvas, t) {
    const doc = this.doc;
    const W = doc.width; const H = doc.height;
    const ps = canvas.width / W;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const track of tracksOf(doc, 'video')) {
      if (!trackVisible(doc, track)) continue;
      for (const c of resolveTrack(doc, clipsOn(doc, track.id).map((x) => effective(x, doc)), false)) {
        if (t < c.start || t >= clipEnd(c)) continue;
        this.drawClip(ctx, c, t - c.start, W, H, ps);
      }
    }
  }

  drawClip(ctx, c, ct, W, H, ps) {
    let src = null; let sw = W; let sh = H;
    if (c.type === 'video') {
      const v = this.videos.get(c.id);
      if (!v) return;
      if (v.el.readyState >= 2 && !v.el.seeking) {
        src = v.el; sw = v.el.videoWidth; sh = v.el.videoHeight;
        // Keep a small copy of the last good frame to show while the element seeks or buffers.
        const k = Math.min(1, 640 / sw);
        v.snap ||= document.createElement('canvas');
        if (v.snap.width !== Math.round(sw * k)) { v.snap.width = Math.round(sw * k); v.snap.height = Math.round(sh * k); }
        v.snap.getContext('2d').drawImage(src, 0, 0, v.snap.width, v.snap.height);
        v.snapW = sw; v.snapH = sh;
      } else if (v.snap) {
        src = v.snap; sw = v.snap.width; sh = v.snap.height;
      } else return;
    } else if (c.type === 'image') {
      src = this.image(c.asset_id);
      if (!src) return;
      sw = src.naturalWidth; sh = src.naturalHeight;
    } else if (c.type === 'title') {
      src = this.titleCanvas(c.title || {}, W, H, Math.min(1, ps * 1.5));
      if (!src) return;
      sw = src.width; sh = src.height; // drawn at preview scale; contain-fit brings it back to the frame
    }
    if (!sw || !sh) return;
    const cr = c.crop || {};
    const l = clamp(cr.l || 0, 0, 0.95); const tp = clamp(cr.t || 0, 0, 0.95);
    const r = clamp(cr.r || 0, 0, 0.95 - l); const b = clamp(cr.b || 0, 0, 0.95 - tp);
    const cw = sw * (1 - l - r); const ch = sh * (1 - tp - b);
    const scale = Math.max(0.001, valueAt(c, 'scale', ct));
    const k = Math.min(W / cw, H / ch) * scale;
    const dw = cw * k * ps; const dh = ch * k * ps;
    if (dw < 1 || dh < 1) return;
    const x = (W / 2 + valueAt(c, 'x', ct)) * ps; const y = (H / 2 + valueAt(c, 'y', ct)) * ps;
    const rot = (valueAt(c, 'rotation', ct) * Math.PI) / 180;
    const alpha = clamp(valueAt(c, 'opacity', ct), 0, 1) * fadeAlpha(c, ct);
    if (alpha <= 0.001) return;

    // Effects → a CSS filter plus a few canvas passes. (Sharpen, Denoise and LUTs show in the export only.)
    const fx = (c.effects || []).filter((e) => e.enabled !== false);
    const srcPx = (dw / cw); // layer pixels per source pixel
    const css = [];
    let flipH = false; let flipV = false; let pixel = 0; let vignette = 0; let temp = null; let key = null;
    for (const e of fx) {
      const v = Number(e.value) || 0;
      switch (e.type) {
        case 'brightness': css.push(`brightness(${(1 + v).toFixed(3)})`); break;
        case 'contrast': css.push(`contrast(${v.toFixed(3)})`); break;
        case 'saturation': css.push(`saturate(${v.toFixed(3)})`); break;
        case 'exposure': css.push(`brightness(${(2 ** v).toFixed(3)})`); break;
        case 'hue': css.push(`hue-rotate(${v}deg)`); break;
        case 'blur': if (v > 0) css.push(`blur(${(v * srcPx).toFixed(2)}px)`); break;
        case 'grayscale': css.push('grayscale(1)'); break;
        case 'sepia': css.push('sepia(1)'); break;
        case 'invert': css.push('invert(1)'); break;
        case 'flip_h': flipH = !flipH; break;
        case 'flip_v': flipV = !flipV; break;
        case 'pixelate': pixel = v; break;
        case 'vignette': vignette = v; break;
        case 'temperature': temp = v; break;
        case 'chroma_key': key = e; break;
        default: break;
      }
    }
    const dipIn = c._dip_in && ct < c._dip_in.d ? { color: c._dip_in.color, a: 1 - ct / c._dip_in.d } : null;
    const dipOut = c._dip_out && ct > c.duration - c._dip_out.d ? { color: c._dip_out.color, a: (ct - (c.duration - c._dip_out.d)) / c._dip_out.d } : null;
    const needLayer = pixel > 1 || vignette > 0 || (temp && Math.abs(temp - 6500) > 50) || key || dipIn || dipOut || c.type === 'color';

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    if (!needLayer) {
      if (flipH || flipV) ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      ctx.filter = css.length ? css.join(' ') : 'none';
      ctx.drawImage(src, sw * l, sh * tp, cw, ch, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      return;
    }
    // Layer path: draw the clip alone, apply the passes, then composite it.
    const lw = Math.max(1, Math.round(dw)); const lh = Math.max(1, Math.round(dh));
    const L = this.scratch;
    if (L.width !== lw || L.height !== lh) { L.width = lw; L.height = lh; }
    const lc = L.getContext('2d', { willReadFrequently: !!key });
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'source-over'; lc.globalAlpha = 1; lc.filter = 'none';
    lc.clearRect(0, 0, lw, lh);
    if (c.type === 'color') { lc.fillStyle = c.color || '#000'; lc.fillRect(0, 0, lw, lh); }
    else {
      lc.filter = css.length ? css.join(' ') : 'none';
      lc.setTransform(flipH ? -1 : 1, 0, 0, flipV ? -1 : 1, flipH ? lw : 0, flipV ? lh : 0);
      lc.drawImage(src, sw * l, sh * tp, cw, ch, 0, 0, lw, lh);
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.filter = 'none';
    }
    if (key) this.chromaKey(lc, lw, lh, key);
    if (pixel > 1) {
      const n = Math.max(1, pixel * srcPx);
      const T = this.tiny; T.width = Math.max(1, Math.round(lw / n)); T.height = Math.max(1, Math.round(lh / n));
      const tc = T.getContext('2d'); tc.clearRect(0, 0, T.width, T.height); tc.drawImage(L, 0, 0, T.width, T.height);
      lc.clearRect(0, 0, lw, lh); lc.imageSmoothingEnabled = false; lc.drawImage(T, 0, 0, lw, lh); lc.imageSmoothingEnabled = true;
    }
    lc.globalCompositeOperation = 'source-atop';
    if (temp && Math.abs(temp - 6500) > 50) {
      const warm = temp < 6500;
      lc.globalAlpha = clamp(Math.abs(temp - 6500) / (warm ? 4500 : 10000), 0, 1) * 0.35;
      lc.fillStyle = warm ? '#ff8a1e' : '#3a8bff';
      lc.fillRect(0, 0, lw, lh);
      lc.globalAlpha = 1;
    }
    if (vignette > 0) {
      const g = lc.createRadialGradient(lw / 2, lh / 2, Math.min(lw, lh) * 0.25, lw / 2, lh / 2, Math.hypot(lw, lh) / 2);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${clamp(vignette / 1.2, 0, 1).toFixed(3)})`);
      lc.fillStyle = g; lc.fillRect(0, 0, lw, lh);
    }
    for (const d of [dipIn, dipOut]) {
      if (!d) continue;
      lc.globalAlpha = clamp(d.a, 0, 1); lc.fillStyle = d.color; lc.fillRect(0, 0, lw, lh); lc.globalAlpha = 1;
    }
    lc.globalCompositeOperation = 'source-over';
    ctx.drawImage(L, -lw / 2, -lh / 2);
    ctx.restore();
  }

  /** Same idea as ffmpeg's chromakey: distance in the U/V (colour) plane from the key colour. */
  chromaKey(lc, w, h, e) {
    const img = lc.getImageData(0, 0, w, h);
    const d = img.data;
    const [kr, kg, kb] = hexRgb(e.color || '#00ff00');
    const ku = -0.169 * kr - 0.331 * kg + 0.5 * kb; const kv = 0.5 * kr - 0.419 * kg - 0.081 * kb;
    const sim = clamp(Number(e.similarity ?? 0.15), 0.01, 1); const blend = clamp(Number(e.blend ?? 0.05), 0, 1);
    for (let i = 0; i < d.length; i += 4) {
      const u = -0.169 * d[i] - 0.331 * d[i + 1] + 0.5 * d[i + 2]; const v = 0.5 * d[i] - 0.419 * d[i + 1] - 0.081 * d[i + 2];
      const diff = Math.sqrt(((u - ku) ** 2 + (v - kv) ** 2) / (255 * 255 * 2));
      const a = diff < sim ? 0 : blend > 0 ? clamp((diff - sim) / blend, 0, 1) : 1;
      d[i + 3] = d[i + 3] * a;
    }
    lc.putImageData(img, 0, 0);
  }
}
