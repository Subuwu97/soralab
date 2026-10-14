// Time-lapse: a small JPEG snapshot of the canvas after each stroke, turned into a WebM (VP9 via WebCodecs +
// webm-muxer) on export. Frames live in memory for this session only.
import { Muxer, ArrayBufferTarget } from 'webm-muxer';

const MAX_FRAMES = 1200;

export class TimeLapse {
  constructor() { this.frames = []; this.size = null; this.pending = Promise.resolve(); }
  get count() { return this.frames.length; }
  clear() { this.frames = []; }
  /** Snapshot a canvas (scaled to ≤ 1080 px, even dimensions). */
  capture(src) {
    const s = Math.min(1, 1080 / Math.max(src.width, src.height));
    const w = Math.max(2, Math.round(src.width * s / 2) * 2); const h = Math.max(2, Math.round(src.height * s / 2) * 2);
    if (this.size && (this.size.w !== w || this.size.h !== h)) this.frames = []; // canvas resized: start over
    this.size = { w, h };
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(src, 0, 0, w, h);
    this.pending = this.pending.then(() => new Promise((r) => c.toBlob((b) => { if (b) this.frames.push(b); if (this.frames.length > MAX_FRAMES) this.frames = this.frames.filter((_, i) => i % 2 === 0); r(); }, 'image/jpeg', 0.85)));
  }
  /** The recording as a WebM video. fps: frames shown per second; the last frame is held for 2 s. */
  async toWebm({ fps = 12, onProgress } = {}) {
    await this.pending;
    if (!this.frames.length) throw new Error('Nothing recorded yet — turn on recording and paint a few strokes.');
    if (typeof VideoEncoder === 'undefined') throw new Error('This browser can’t encode video (WebCodecs is missing).');
    const { w, h } = this.size;
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'V_VP9', width: w, height: h, frameRate: fps } });
    let err = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { err = e; } });
    enc.configure({ codec: 'vp09.00.10.08', width: w, height: h, bitrate: 4_000_000, framerate: fps });
    const list = [...this.frames, ...Array(fps * 2).fill(this.frames[this.frames.length - 1])];
    for (let i = 0; i < list.length; i++) {
      if (err) throw err;
      const bmp = await createImageBitmap(list[i]);
      const frame = new VideoFrame(bmp, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close(); bmp.close();
      if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      onProgress?.(i / list.length, 'Encoding time-lapse…');
    }
    await enc.flush();
    if (err) throw err;
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/webm' });
  }
}
