// WebGL2 renderer for the develop pipeline.
//
//   const r = new Renderer(canvas)
//   r.setSource(img)                 full-resolution texture (sRGB, mipmapped) + a ≤2048 px preview + base-brightness blurs
//   r.draw({ settings, frame, Q, width, height, draft, split, clip, showMask })   → renders into the canvas
//   r.histogram()                    RGB histogram of what was last drawn
//   r.renderFull(settings, frame, outW, outH)  → Uint8ClampedArray (tiled, for export at full resolution)
//
// While dragging a slider the view is drawn "draft": from the preview texture into a half-resolution buffer that's
// scaled up, without noise reduction — that keeps a 24-megapixel photo at interactive frame rates. When the input
// settles it is drawn again at full quality.
import { VERT, BLUR_FRAG, MAIN_FRAG, MAX_MASKS } from './shaders.js';
import { curveLut, MASK_ADJ, mul, inv } from './model.js';

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program: ${gl.getProgramInfoLog(p)}`);
  const cache = {};
  return { p, u: (n) => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n))) };
}

const hslRgb = (h) => {
  const f = (n) => { const k = (n + h / 30) % 12; return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
};
const LW = [0.2126, 0.7152, 0.0722];
function wheelTint(w) {
  const c = hslRgb(w.h); const l = c[0] * LW[0] + c[1] * LW[1] + c[2] * LW[2];
  return c.map((x) => (x - l) * (w.s / 100) * 0.32);
}

export class Renderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: preserve });
    if (!gl) throw new Error('This browser doesn’t support WebGL2, which Sora Hikari needs for editing.');
    this.gl = gl;
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.main = compile(gl, VERT, MAIN_FRAG);
    this.blur = compile(gl, VERT, BLUR_FRAG);
    // One big triangle covers the viewport.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.black = this.tex2D(1, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    this.curveTex = this.tex2D(1024, 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, null, gl.NEAREST);
    this.curveKey = null;
    this.lut3 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.lut3);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 2, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(32));
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    this.lutN = 2; this.lutKey = null;
    this.brush = [null, null, null, null];
    this.src = null;
    this.draftFbo = null;
    this.histFbo = this.makeFbo(160, 120, false);
  }

  tex2D(w, h, internal, format, type, data, filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  makeFbo(w, h, float) {
    const gl = this.gl;
    const useF = float && this.floatOk;
    const tex = this.tex2D(w, h, useF ? gl.RGBA16F : gl.RGBA8, gl.RGBA, useF ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }
  freeFbo(f) { if (!f) return; this.gl.deleteFramebuffer(f.fb); this.gl.deleteTexture(f.tex); }

  /** Loads a photo (HTMLImageElement / ImageBitmap / canvas). Big images are kept at full size up to the GPU's limit. */
  async setSource(img) {
    const gl = this.gl;
    this.dispose();
    let w = img.naturalWidth || img.width; let h = img.naturalHeight || img.height;
    let full = img;
    if (Math.max(w, h) > this.maxTex) {
      const s = this.maxTex / Math.max(w, h);
      full = await createImageBitmap(img, { resizeWidth: Math.round(w * s), resizeHeight: Math.round(h * s), resizeQuality: 'high' });
      w = full.width; h = full.height;
    }
    const upload = (src) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameterf(gl.TEXTURE_2D, 0x84FE /* TEXTURE_MAX_ANISOTROPY */, 1);
      return t;
    };
    this.full = upload(full);
    const ps = Math.min(1, 2048 / Math.max(w, h));
    if (ps < 1) {
      const pb = await createImageBitmap(full, { resizeWidth: Math.round(w * ps), resizeHeight: Math.round(h * ps), resizeQuality: 'medium' });
      this.preview = upload(pb);
      pb.close?.();
    } else this.preview = this.full;
    if (full !== img) full.close?.();
    this.w = w; this.h = h;
    this.src = true;
    this.makeBlurs();
  }
  dispose() {
    const gl = this.gl;
    if (this.full) gl.deleteTexture(this.full);
    if (this.preview && this.preview !== this.full) gl.deleteTexture(this.preview);
    this.freeFbo(this.blurM); this.freeFbo(this.blurL);
    this.full = this.preview = this.blurM = this.blurL = null;
    this.src = null;
  }

  // Base-brightness textures: medium (≤1024 px, σ ≈ 0.4% of the long edge) and large (≤256 px, σ ≈ 2.5%).
  makeBlurs() {
    const gl = this.gl;
    const make = (maxEdge, sigmaFrac) => {
      const s = Math.min(1, maxEdge / Math.max(this.w, this.h));
      const w = Math.max(4, Math.round(this.w * s)); const h = Math.max(4, Math.round(this.h * s));
      const a = this.makeFbo(w, h, true); const b = this.makeFbo(w, h, true);
      const sigma = Math.max(0.8, sigmaFrac * Math.max(w, h));
      gl.useProgram(this.blur.p);
      gl.uniform1i(this.blur.u('uTex'), 0);
      gl.uniform2f(this.blur.u('uSize'), w, h);
      gl.uniform1f(this.blur.u('uSigma'), Math.min(16, sigma));
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0);
      const pass = (srcTex, dst, dir) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.uniform2f(this.blur.u('uDir'), dir[0], dir[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      pass(this.preview, a, [0, 0]);
      pass(a.tex, b, [1, 0]);
      pass(b.tex, a, [0, 1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.freeFbo(b);
      return a;
    };
    this.blurM = make(1024, 0.004);
    this.blurL = make(256, 0.025);
  }

  /** Brush masks are greyscale canvases in source space, one texture per brush mask (up to 4). */
  setBrush(i, canvas) {
    const gl = this.gl;
    if (!canvas) { if (this.brush[i]) gl.deleteTexture(this.brush[i]); this.brush[i] = null; return; }
    if (!this.brush[i]) this.brush[i] = this.tex2D(1, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.bindTexture(gl.TEXTURE_2D, this.brush[i]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, canvas);
  }
  /** A 3D LUT ({ size, data: Uint8Array RGBA }), or null. */
  setLut(lut, key) {
    if (key === this.lutKey) return;
    this.lutKey = key;
    if (!lut) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, this.lut3);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut.data);
    this.lutN = lut.size;
  }

  setCurve(curve) {
    const key = JSON.stringify(curve);
    if (key === this.curveKey) return;
    this.curveKey = key;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, 1, gl.RGBA, gl.FLOAT, curveLut(curve));
  }

  /** Sets every uniform for these settings. Q maps fragment px → q; frame.M maps q → src uv. */
  uniforms(s, frame, Q, { split = -1, clip = false, showMask = -1, draft = false, mode = 0, lutOn = false } = {}) {
    const gl = this.gl; const u = this.main.u;
    const M = frame.M;
    gl.uniform3f(u('uQx'), Q[0], Q[1], Q[2]); gl.uniform3f(u('uQy'), Q[3], Q[4], Q[5]);
    gl.uniform3f(u('uSx'), M[0], M[1], M[2]); gl.uniform3f(u('uSy'), M[3], M[4], M[5]);
    // uv step for one output pixel: the linear parts of M∘Q
    const D = mul(M, Q);
    gl.uniform2f(u('uDx'), D[0], D[3]); gl.uniform2f(u('uDy'), D[1], D[4]);
    const srcPerPx = Math.hypot(D[0] * this.w, D[3] * this.h) || 1;
    gl.uniform1f(u('uPxScale'), 1 / srcPerPx);
    gl.uniform2f(u('uSrcSize'), this.w, this.h);
    gl.uniform2f(u('uOutSize'), frame.outW, frame.outH);
    gl.uniform1f(u('uSplit'), split);
    gl.uniform1i(u('uMode'), mode);
    gl.uniform1i(u('uDraft'), draft ? 1 : 0);
    gl.uniform1i(u('uClip'), clip ? 1 : 0);
    gl.uniform1i(u('uShowMask'), showMask);
    gl.uniform1fv(u('uG'), new Float32Array([s.exposure, s.contrast / 100, s.highlights / 100, s.shadows / 100, s.whites / 100, s.blacks / 100,
      s.temp / 100, s.tint / 100, s.saturation / 100, s.texture / 100, s.clarity / 100, s.dehaze / 100]));
    gl.uniform1f(u('uVib'), s.vibrance / 100);
    gl.uniform1i(u('uBW'), s.bw ? 1 : 0);
    gl.uniform1fv(u('uHslH'), s.hsl.hue.map((v) => v / 100));
    gl.uniform1fv(u('uHslS'), s.hsl.sat.map((v) => v / 100));
    gl.uniform1fv(u('uHslL'), s.hsl.lum.map((v) => v / 100));
    gl.uniform1fv(u('uGray'), s.hsl.gray.map((v) => v / 100));
    const gr = s.grade;
    gl.uniform3fv(u('uGrShT'), wheelTint(gr.shadows)); gl.uniform3fv(u('uGrMiT'), wheelTint(gr.mid));
    gl.uniform3fv(u('uGrHiT'), wheelTint(gr.high)); gl.uniform3fv(u('uGrGlT'), wheelTint(gr.global));
    gl.uniform4f(u('uGrL'), gr.shadows.l / 400, gr.mid.l / 400, gr.high.l / 400, gr.global.l / 400);
    gl.uniform2f(u('uGrBB'), gr.blending / 100, gr.balance / 100);
    const d = s.detail;
    gl.uniform4f(u('uSharp'), d.sharpen / 100, d.radius, d.detail / 100, d.masking / 100);
    gl.uniform2f(u('uNR'), d.nrLum / 100, d.nrColor / 100);
    gl.uniform2f(u('uLens'), s.optics.vignette / 100, s.optics.midpoint / 100);
    const e = s.effects;
    gl.uniform4f(u('uVig'), e.vig / 100, e.vigMid / 100, e.vigRound / 100, e.vigFeather / 100);
    gl.uniform1f(u('uVigHi'), e.vigHigh / 100);
    gl.uniform3f(u('uGrain'), e.grain / 100, e.grainSize / 100, e.grainRough / 100);
    gl.uniform1f(u('uLutAmt'), lutOn && s.lut ? (s.lut.amount ?? 100) / 100 : 0);
    gl.uniform1f(u('uLutN'), this.lutN);
    // Local masks
    const masks = (s.masks || []).filter((m) => m.visible !== false).slice(0, MAX_MASKS);
    const type = new Int32Array(MAX_MASKS); const G = new Float32Array(MAX_MASKS * 4); const H = new Float32Array(MAX_MASKS * 4);
    const invm = new Float32Array(MAX_MASKS); const amt = new Float32Array(MAX_MASKS); const ch = new Int32Array(MAX_MASKS); const A = new Float32Array(MAX_MASKS * 12);
    const L = Math.max(this.w, this.h);
    masks.forEach((m, i) => {
      const g = m.geo;
      if (m.type === 'linear') { type[i] = 0; G.set([g.x0 * this.w, g.y0 * this.h, g.x1 * this.w, g.y1 * this.h], i * 4); }
      else if (m.type === 'radial') { type[i] = 1; G.set([g.cx * this.w, g.cy * this.h, g.rx * L, g.ry * L], i * 4); H.set([(g.angle * Math.PI) / 180, g.feather / 100, 0, 0], i * 4); }
      else { type[i] = 2; ch[i] = m.channel ?? 0; }
      invm[i] = m.invert ? 1 : 0; amt[i] = (m.amount ?? 100) / 100;
      MASK_ADJ.forEach((a, k) => { A[i * 12 + k] = a.key === 'exposure' ? m.adj[a.key] || 0 : (m.adj[a.key] || 0) / 100; });
    });
    gl.uniform1i(u('uMaskN'), masks.length);
    gl.uniform1iv(u('uMType'), type); gl.uniform4fv(u('uMG'), G); gl.uniform4fv(u('uMH'), H);
    gl.uniform1fv(u('uMInv'), invm); gl.uniform1fv(u('uMAmt'), amt); gl.uniform1iv(u('uMCh'), ch); gl.uniform1fv(u('uMA'), A);
    return masks;
  }

  bindTextures(draft) {
    const gl = this.gl; const u = this.main.u;
    const units = [['uSrc', draft ? this.preview : this.full], ['uBlurM', this.blurM.tex], ['uBlurL', this.blurL.tex], ['uCurve', this.curveTex],
      ['uB0', this.brush[0] || this.black], ['uB1', this.brush[1] || this.black], ['uB2', this.brush[2] || this.black], ['uB3', this.brush[3] || this.black]];
    units.forEach(([n, t], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u(n), i); });
    gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_3D, this.lut3); gl.uniform1i(u('uLut3'), 8);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Draws into the canvas (width × height device px). Q maps canvas fragment px → q.
   * draft: half resolution from the preview texture.
   */
  draw({ settings, frame, Q, width, height, draft = false, split = -1, clip = false, showMask = -1, lutOn = false }) {
    if (!this.src) return;
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.useProgram(this.main.p);
    gl.bindVertexArray(this.vao);
    this.setCurve(settings.curve);
    let Qd = Q; let tw = width; let th = height;
    if (draft) {
      const f = 0.5;
      tw = Math.max(1, Math.round(width * f)); th = Math.max(1, Math.round(height * f));
      if (!this.draftFbo || this.draftFbo.w !== tw || this.draftFbo.h !== th) { this.freeFbo(this.draftFbo); this.draftFbo = this.makeFbo(tw, th, false); }
      Qd = mul(Q, [width / tw, 0, 0, 0, height / th, 0]);
    }
    this.uniforms(settings, frame, Qd, { split, clip, showMask, draft, lutOn });
    this.bindTextures(draft);
    gl.bindFramebuffer(gl.FRAMEBUFFER, draft ? this.draftFbo.fb : null);
    gl.viewport(0, 0, tw, th);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (draft) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.draftFbo.fb);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blitFramebuffer(0, 0, tw, th, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    }
    // Keep a small copy for the histogram.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, draft ? this.draftFbo.fb : null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.histFbo.fb);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blitFramebuffer(0, 0, tw, th, 0, 0, this.histFbo.w, this.histFbo.h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.histDirty = true;
  }

  histogram() {
    if (!this.histDirty) return this.hist;
    const gl = this.gl;
    const { w, h } = this.histFbo;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.histFbo.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const r = new Uint32Array(256); const g = new Uint32Array(256); const b = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 250) continue;
      r[px[i]]++; g[px[i + 1]]++; b[px[i + 2]]++; n++;
    }
    this.histDirty = false;
    this.hist = { r, g, b, n };
    return this.hist;
  }

  /**
   * Renders the whole output (outW × outH px) in tiles at full quality and returns RGBA bytes, top row first.
   */
  async renderFull(settings, frame, outW, outH, { onProgress, lutOn = true } = {}) {
    const gl = this.gl;
    const T = 2048;
    const out = new Uint8ClampedArray(outW * outH * 4);
    const fbo = this.makeFbo(Math.min(T, outW), Math.min(T, outH), false);
    const buf = new Uint8Array(fbo.w * fbo.h * 4);
    gl.useProgram(this.main.p);
    gl.bindVertexArray(this.vao);
    this.setCurve(settings.curve);
    const tiles = Math.ceil(outW / T) * Math.ceil(outH / T);
    let done = 0;
    for (let ty = 0; ty < outH; ty += T) {
      for (let tx = 0; tx < outW; tx += T) {
        const tw = Math.min(T, outW - tx); const th = Math.min(T, outH - ty);
        // fragment (fx, fy) in the tile (y up) → output px (y down) → q
        const Q = [1 / outW, 0, tx / outW, 0, -1 / outH, (ty + th) / outH];
        gl.useProgram(this.main.p);
        this.uniforms(settings, frame, Q, { lutOn });
        this.bindTextures(false);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
        gl.viewport(0, 0, tw, th);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        for (let r = 0; r < th; r++) {
          const row = ty + th - 1 - r;
          out.set(buf.subarray(r * tw * 4, (r + 1) * tw * 4), (row * outW + tx) * 4);
        }
        done++;
        onProgress?.(done / tiles);
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.freeFbo(fbo);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
  }

  /** The colour part of the settings as an n³ cube (for .cube export): RGB floats, red fastest. */
  lutCube(settings, n = 33) {
    const gl = this.gl;
    // Identity image: n slices of n×n side by side (x = r + n·b, y = g).
    const w = n * n; const h = n;
    const id = new Uint8Array(w * h * 4);
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const i = (g * w + b * n + r) * 4;
      id[i] = Math.round((r / (n - 1)) * 255); id[i + 1] = Math.round((g / (n - 1)) * 255); id[i + 2] = Math.round((b / (n - 1)) * 255); id[i + 3] = 255;
    }
    const tex = this.tex2D(w, h, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, id, gl.NEAREST);
    const fbo = this.makeFbo(w, h, false);
    gl.useProgram(this.main.p);
    gl.bindVertexArray(this.vao);
    this.setCurve(settings.curve);
    const sw = this.w; const sh = this.h; this.w = this.w || 1; this.h = this.h || 1;
    this.uniforms(settings, { M: [1, 0, 0, 0, 1, 0], outW: w, outH: h }, [1 / w, 0, 0, 0, 1 / h, 0], { mode: 1, lutOn: true });
    this.w = sw; this.h = sh;
    const blurM = this.blurM; const blurL = this.blurL; const full = this.full;
    this.full = tex; this.blurM = this.blurM || fbo; this.blurL = this.blurL || fbo;
    this.bindTextures(false);
    this.full = full; this.blurM = blurM; this.blurL = blurL;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.freeFbo(fbo); gl.deleteTexture(tex);
    const out = new Float32Array(n * n * n * 3);
    let k = 0;
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const i = (g * w + b * n + r) * 4;
      out[k++] = px[i] / 255; out[k++] = px[i + 1] / 255; out[k++] = px[i + 2] / 255;
    }
    return out;
  }
}

/** fragment px (y up) in a canvas of device height H, with dpr → CSS px (y down) → q via V (CSS → q). */
export function fragToQ(V, H, dpr) {
  return mul(V, [1 / dpr, 0, 0, 0, -1 / dpr, H / dpr]);
}
export { inv };

// ---------------------------------------------------------------- .cube files

export function toCube(data, n, title = 'Sora Hikari') {
  const lines = [`TITLE "${title.replace(/"/g, '')}"`, `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''];
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  return lines.join('\n');
}
/** Parses a .cube 3D LUT into RGBA bytes (red fastest, like the file). */
export function parseCube(text) {
  let n = 0; const vals = [];
  let lo = [0, 0, 0]; let hi = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    if (/^LUT_3D_SIZE/i.test(l)) { n = parseInt(l.split(/\s+/)[1], 10); continue; }
    if (/^LUT_1D_SIZE/i.test(l)) throw new Error('1D LUTs aren’t supported — use a 3D .cube file.');
    if (/^DOMAIN_MIN/i.test(l)) { lo = l.split(/\s+/).slice(1).map(Number); continue; }
    if (/^DOMAIN_MAX/i.test(l)) { hi = l.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/i.test(l)) continue;
    const p = l.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every(Number.isFinite)) vals.push(p[0], p[1], p[2]);
  }
  if (!n || vals.length < n * n * n * 3) throw new Error('That doesn’t look like a 3D .cube LUT.');
  if (n > 65) throw new Error('LUT is too large (max 65³).');
  const data = new Uint8Array(n * n * n * 4);
  for (let i = 0, j = 0; i < n * n * n; i++, j += 3) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(Math.max(0, Math.min(1, (vals[j + c] - lo[c]) / ((hi[c] - lo[c]) || 1))) * 255);
    data[i * 4 + 3] = 255;
  }
  return { size: n, data };
}
