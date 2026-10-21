// WebGL2 renderer for the 2D rig: textured meshes in draw order, clipping masks (a part drawn only where its mask
// parts are, or only where they aren't), normal / multiply / screen / add blending, per-part opacity.
// Vertex positions are re-uploaded each frame (they're deformed on the CPU in deform.js — a few thousand points even
// at ~50 parts); everything else stays on the GPU until the part's mesh or texture changes.
//
// createStage2D(canvas, doc, { assetUrl }) is the performing stage from ../contract.js:
//   { setPose(pose), resize(w, h), setBackground(css|null), snapshot(): Promise<Blob>, dispose() }
//   plus setDoc(doc), setFraming({ zoom, x, y }), expressions() and values() for the Perform page.
import { evaluate } from './deform.js';
import { PhysicsSim } from './physics.js';
import { normalize2D, defaults, paramById } from './model.js';
import { loadTex, assetFileUrl } from './textures.js';

const VS = `#version 300 es
in vec2 aPos; in vec2 aUv;
uniform vec4 uView;            // canvas px → clip space: pos * xy + zw
out vec2 vUv;
void main() { vUv = aUv; gl_Position = vec4(aPos * uView.xy + uView.zw, 0.0, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex; uniform sampler2D uMask;
uniform float uOpacity; uniform int uMaskMode; uniform vec2 uViewport;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv) * uOpacity;                   // textures are premultiplied
  if (uMaskMode > 0) { float m = texture(uMask, gl_FragCoord.xy / uViewport).a; c *= uMaskMode == 1 ? m : 1.0 - m; }
  outColor = c;
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const parseColor = (() => {
  let ctx = null;
  return (css) => {
    if (!css) return null;
    ctx ||= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data; const a = d[3] / 255;
    return [(d[0] / 255) * a, (d[1] / 255) * a, (d[2] / 255) * a, a]; // premultiplied
  };
})();

export class Renderer2D {
  constructor(canvas, { onTexture, urlOf = assetFileUrl } = {}) {
    this.canvas = canvas; this.urlOf = urlOf; this.onTexture = onTexture;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('This browser has no WebGL2, which the 2D avatar needs.');
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, VS)); gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    this.loc = { pos: gl.getAttribLocation(p, 'aPos'), uv: gl.getAttribLocation(p, 'aUv'), view: gl.getUniformLocation(p, 'uView'), tex: gl.getUniformLocation(p, 'uTex'), mask: gl.getUniformLocation(p, 'uMask'), opacity: gl.getUniformLocation(p, 'uOpacity'), mode: gl.getUniformLocation(p, 'uMaskMode'), vp: gl.getUniformLocation(p, 'uViewport') };
    this.parts = new Map(); // part id → GPU buffers
    this.textures = new Map(); // asset id → { tex } | 'loading' | 'failed'
    this.mask = null;
  }

  ensureTexture(id) {
    if (!id || this.textures.has(id)) return;
    this.textures.set(id, 'loading');
    loadTex(id, this.urlOf).then((img) => {
      if (this.lost) return;
      const gl = this.gl; const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.set(id, { tex: t, w: img.width, h: img.height });
      this.onTexture?.(id);
    }).catch(() => this.textures.set(id, 'failed'));
  }
  /** Starts loading every texture the document uses; resolves when they're all in. */
  preload(doc) {
    for (const p of doc.parts) this.ensureTexture(p.tex);
    return Promise.all(doc.parts.map((p) => loadTex(p.tex, this.urlOf).catch(() => null)));
  }
  ready(doc) { return doc.parts.every((p) => !p.tex || typeof this.textures.get(p.tex) === 'object' || this.textures.get(p.tex) === 'failed'); }

  /** GPU buffers for a part, rebuilt when its mesh or texture placement changes. */
  gpu(part) {
    const gl = this.gl;
    let g = this.parts.get(part.id);
    const sig = `${part.x},${part.y},${part.w},${part.h}`;
    if (g && g.mesh === part.mesh && g.sig === sig) return g;
    if (g) { gl.deleteBuffer(g.pos); gl.deleteBuffer(g.uv); gl.deleteBuffer(g.idx); gl.deleteVertexArray(g.vao); }
    const m = part.mesh; if (!m?.v?.length) { this.parts.delete(part.id); return null; }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(m.v), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
    const uvs = new Float32Array(m.v.length);
    for (let i = 0; i < m.v.length; i += 2) { uvs[i] = (m.v[i] - part.x) / (part.w || 1); uvs[i + 1] = (m.v[i + 1] - part.y) / (part.h || 1); }
    const uv = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, uv); gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.loc.uv); gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 0, 0);
    const idx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    const big = m.v.length / 2 > 65535;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(m.t) : new Uint16Array(m.t), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    g = { vao, pos, uv, idx, count: m.t.length, type: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, mesh: m, sig };
    this.parts.set(part.id, g);
    return g;
  }
  /** Frees buffers of parts that no longer exist. */
  prune(doc) {
    const ids = new Set(doc.parts.map((p) => p.id)); const gl = this.gl;
    for (const [id, g] of this.parts) if (!ids.has(id)) { gl.deleteBuffer(g.pos); gl.deleteBuffer(g.uv); gl.deleteBuffer(g.idx); gl.deleteVertexArray(g.vao); this.parts.delete(id); }
  }

  ensureMask(w, h) {
    const gl = this.gl;
    if (this.mask && this.mask.w === w && this.mask.h === h) return this.mask;
    if (this.mask) { gl.deleteFramebuffer(this.mask.fb); gl.deleteTexture(this.mask.tex); }
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.mask = { tex, fb, w, h, key: null };
    return this.mask;
  }

  blend(mode) {
    const gl = this.gl;
    if (mode === 'add') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    else if (mode === 'multiply') gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    else if (mode === 'screen') gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  drawPart(part, st, maskMode) {
    const gl = this.gl;
    const g = this.gpu(part); const t = this.textures.get(part.tex);
    if (!g || typeof t !== 'object') { this.ensureTexture(part.tex); return; }
    gl.bindVertexArray(g.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, g.pos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, st.verts);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1f(this.loc.opacity, st.opacity); gl.uniform1i(this.loc.mode, maskMode);
    gl.drawElements(gl.TRIANGLES, g.count, g.type, 0);
  }

  /**
   * Draws the rig. ev = evaluate(…) result; view = { s, tx, ty } maps canvas px to device px on this canvas.
   * opts: { bg: css colour | null (transparent), solo: Set of part ids to show (others hidden), dim: opacity for others }
   */
  draw(doc, ev, view, opts = {}) {
    const gl = this.gl; const W = this.canvas.width; const H = this.canvas.height;
    if (gl.isContextLost()) { this.lost = true; return; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const bg = parseColor(opts.bg);
    gl.clearColor(...(bg || [0, 0, 0, 0])); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform4f(this.loc.view, (2 * view.s) / W, (-2 * view.s) / H, (2 * view.tx) / W - 1, 1 - (2 * view.ty) / H);
    gl.uniform1i(this.loc.tex, 0); gl.uniform1i(this.loc.mask, 1); gl.uniform2f(this.loc.vp, W, H);
    gl.enable(gl.BLEND);
    const byId = this.byId(doc);
    let maskKey = null;
    for (const id of ev.order) {
      const part = byId.get(id); const st = ev.parts.get(id);
      if (!part || !st || !st.visible || st.opacity <= 0.002) continue;
      const shown = !opts.solo || opts.solo.has(id);
      if (!shown && !opts.dim) continue;
      let mode = 0;
      const clip = (part.clip || []).filter((c) => byId.has(c));
      if (clip.length) {
        const key = clip.join(',');
        if (key !== maskKey) { this.renderMask(clip, byId, ev, W, H); maskKey = key; gl.viewport(0, 0, W, H); }
        mode = part.invertClip ? 2 : 1;
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.mask.tex);
      }
      this.blend(part.blend);
      const s2 = shown ? st : { ...st, opacity: st.opacity * opts.dim };
      this.drawPart(part, s2, mode);
    }
    gl.bindVertexArray(null);
  }
  renderMask(ids, byId, ev, W, H) {
    const gl = this.gl; const m = this.ensureMask(W, H);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null); // never sample the texture we're drawing into
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.fb); gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const id of ids) {
      const st = ev.parts.get(id); const part = byId.get(id);
      if (st && part && st.visible) this.drawPart(part, { ...st, opacity: Math.min(1, st.opacity) }, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  byId(doc) {
    if (this.lastDoc !== doc) { this.lastDoc = doc; this.map = new Map(doc.parts.map((p) => [p.id, p])); }
    return this.map;
  }
  /** Reads the current drawing back as a PNG (call right after draw(), in the same task). */
  snapshotBlob() {
    const gl = this.gl; const W = this.canvas.width; const H = this.canvas.height;
    const px = new Uint8ClampedArray(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // flip rows and un-premultiply for a normal PNG
    const out = new ImageData(W, H);
    for (let y = 0; y < H; y++) {
      const src = (H - 1 - y) * W * 4; const dst = y * W * 4;
      for (let x = 0; x < W * 4; x += 4) {
        const a = px[src + x + 3];
        out.data[dst + x] = a ? (px[src + x] * 255) / a : 0; out.data[dst + x + 1] = a ? (px[src + x + 1] * 255) / a : 0; out.data[dst + x + 2] = a ? (px[src + x + 2] * 255) / a : 0; out.data[dst + x + 3] = a;
      }
    }
    const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(out, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }
  dispose() {
    const gl = this.gl;
    for (const g of this.parts.values()) { gl.deleteBuffer(g.pos); gl.deleteBuffer(g.uv); gl.deleteBuffer(g.idx); gl.deleteVertexArray(g.vao); }
    for (const t of this.textures.values()) if (typeof t === 'object') gl.deleteTexture(t.tex);
    if (this.mask) { gl.deleteFramebuffer(this.mask.fb); gl.deleteTexture(this.mask.tex); }
    this.parts.clear(); this.textures.clear(); this.lost = true;
  }
}

// ---------------------------------------------------------------- pose → parameter values

/**
 * Parameter values for a pose: defaults, then each tracking binding (pose key × scale + offset, clamped to the
 * parameter's range), then active expressions (pose.expr = { expressionId: weight }) and any manual overrides.
 */
export function paramsFromPose(doc, pose = {}, overrides) {
  const v = defaults(doc);
  for (const b of doc.bindings || []) {
    const x = pose[b.pose]; const p = paramById(doc, b.param);
    if (!p || !Number.isFinite(x)) continue;
    v[p.id] = Math.max(p.min, Math.min(p.max, x * (b.scale ?? 1) + (b.offset || 0)));
  }
  applyExpressions(doc, v, pose.expr);
  if (overrides) for (const [k, x] of Object.entries(overrides)) if (Number.isFinite(x)) v[k] = x;
  return v;
}
export function applyExpressions(doc, v, weights) {
  if (!weights) return v;
  for (const e of doc.expressions || []) {
    const w = weights[e.id]; if (!w) continue;
    for (const o of e.params || []) {
      const p = paramById(doc, o.param); if (!p) continue;
      const cur = v[p.id] ?? p.def;
      const next = o.mode === 'set' ? cur + (o.value - cur) * w : o.mode === 'mul' ? cur * (1 + (o.value - 1) * w) : cur + o.value * w;
      v[p.id] = Math.max(p.min, Math.min(p.max, next));
    }
  }
  return v;
}

/** Fits the doc's canvas into a w×h viewport (with framing zoom/offset, as fractions of the viewport). */
export function fitView(doc, w, h, { zoom = 1, x = 0, y = 0, pad = 0.02 } = {}) {
  const s = Math.min(w / doc.width, h / doc.height) * (1 - pad * 2) * zoom;
  return { s, tx: (w - doc.width * s) / 2 + x * w, ty: (h - doc.height * s) / 2 + y * h };
}

// ---------------------------------------------------------------- the performing stage

export function createStage2D(canvas, docIn, { assetUrl } = {}) {
  let doc = normalize2D(docIn);
  const urlOf = typeof assetUrl === 'function' ? assetUrl : assetFileUrl;
  let dirty = true;
  const r = new Renderer2D(canvas, { urlOf, onTexture: () => { dirty = true; } });
  r.preload(doc);
  const sim = new PhysicsSim();
  let pose = {}; let bg = null; let framing = { zoom: 1, x: 0, y: 0 }; let ev = null; let values = defaults(doc);
  let last = performance.now(); let alive = true; let raf = 0;
  const frame = () => {
    const now = performance.now(); const dt = (now - last) / 1000; last = now;
    values = paramsFromPose(doc, pose);
    sim.step(doc, values, dt);
    ev = evaluate(doc, values, ev);
    r.draw(doc, ev, fitView(doc, canvas.width, canvas.height, framing), { bg });
    dirty = false;
  };
  const loop = () => { if (!alive) return; frame(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  return {
    setPose(p) { pose = p || {}; },
    resize(w, h) { canvas.width = Math.max(1, Math.round(w)); canvas.height = Math.max(1, Math.round(h)); dirty = true; },
    setBackground(css) { bg = css || null; },
    setFraming(f) { framing = { ...framing, ...f }; },
    setDoc(d) { doc = normalize2D(d); r.prune(doc); r.preload(doc); dirty = true; },
    async snapshot() { await r.preload(doc); frame(); return r.snapshotBlob(); },
    ready: () => r.preload(doc),
    expressions: () => (doc.expressions || []).map((e) => ({ id: e.id, name: e.name })),
    values: () => values,
    get dirty() { return dirty; },
    dispose() { alive = false; cancelAnimationFrame(raf); r.dispose(); },
  };
}
