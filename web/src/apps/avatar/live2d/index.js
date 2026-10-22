// The Live2D player: Cubism Core does the model maths (the person adds Core themselves, see core.js); we draw its
// drawables with a small WebGL2 renderer of our own (textured meshes in render order, clipping masks incl. inverted,
// normal / additive / multiplicative blending, multiply and screen colours), and drive the standard Cubism parameters
// from the tracking pose, with the model's own physics, expressions (fading), motions (fading, with priorities, the idle
// group looping when nothing else plays) and pose part switching (see anim.js).
//
// createStageLive2D(canvas, doc, { assetUrl, coreUrl }) → the stage from ../contract.js, plus
//   info() → { parameters: [{ id, min, max, def }], parts, drawables, motions: { group: count }, pose, version }
//   setOverrides({ paramId: value }), playMotion(group, i, priority = 'force') → Promise<started?>, setIdle(group|null),
//   expressions() (expressions, then one entry per motion for hotkeys), setExpression(k, weight), values(), parts()
// Hotkeys reach the stage (and OBS output pages) through pose.expr: 'exp:<k>' is on while set; 'motion:<group>:<i>'
// holds a press counter, and each new count plays that motion (positive: Force, it interrupts; negative: Normal).
import { loadCore } from './core.js';
import { loadModelFiles } from './files.js';
import { Live2DPhysics, ExpressionPlayer, MotionPlayer, PosePlayer, PRIORITY, parseMotion } from './anim.js';

// Tracking → Cubism's standard parameter IDs (scale applied to the pose value).
export const LIVE2D_BINDINGS = [
  ['headYaw', 'ParamAngleX'], ['headPitch', 'ParamAngleY'], ['headRoll', 'ParamAngleZ'],
  ['bodyYaw', 'ParamBodyAngleX'], ['bodyPitch', 'ParamBodyAngleY'], ['bodyRoll', 'ParamBodyAngleZ'],
  ['eyeLOpen', 'ParamEyeLOpen'], ['eyeROpen', 'ParamEyeROpen'], ['eyeX', 'ParamEyeBallX'], ['eyeY', 'ParamEyeBallY'],
  ['browL', 'ParamBrowLY'], ['browR', 'ParamBrowRY'], ['mouthOpen', 'ParamMouthOpenY'], ['mouthForm', 'ParamMouthForm'],
  ['cheek', 'ParamCheek'], ['breath', 'ParamBreath'],
].map(([pose, param]) => ({ pose, param, scale: 1, offset: 0 }));

const VS = `#version 300 es
in vec2 aPos; in vec2 aUv; uniform mat3 uM; out vec2 vUv;
void main() { vUv = aUv; vec3 p = uM * vec3(aPos, 1.0); gl_Position = vec4(p.xy, 0.0, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUv; uniform sampler2D uTex; uniform sampler2D uMask; uniform float uOpacity; uniform int uMaskMode; uniform vec2 uViewport;
uniform vec4 uMul; uniform vec4 uScr; out vec4 o;
void main() {
  vec4 c = texture(uTex, vUv);                       // premultiplied
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  rgb = rgb * uMul.rgb; rgb = rgb + uScr.rgb - rgb * uScr.rgb;   // Cubism multiply / screen colours
  c = vec4(rgb * c.a, c.a) * uOpacity;
  if (uMaskMode > 0) { float m = texture(uMask, gl_FragCoord.xy / uViewport).a; c *= uMaskMode == 1 ? m : 1.0 - m; }
  o = c;
}`;

const parseColor = (css) => {
  if (!css) return null;
  const c = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true }); c.fillStyle = css; c.fillRect(0, 0, 1, 1);
  const d = c.getImageData(0, 0, 1, 1).data; const a = d[3] / 255;
  return [(d[0] / 255) * a, (d[1] / 255) * a, (d[2] / 255) * a, a];
};

export async function createStageLive2D(canvas, doc, { assetUrl, coreUrl } = {}) {
  if (!doc.model?.entry) throw Object.assign(new Error('No Live2D model in this project yet. Import one in Edit mode.'), { code: 'no_model' });
  const Core = await loadCore(coreUrl);
  const urlOf = typeof assetUrl === 'function' ? assetUrl : (id) => `/api/assets/${id}/file`;
  const files = await loadModelFiles(doc.model, urlOf);
  if (!files.moc) throw new Error('The model’s .moc3 file is missing.');
  const moc = Core.Moc.fromArrayBuffer(files.moc);
  if (!moc) throw new Error('Cubism Core couldn’t read this .moc3 (it may need a newer Core).');
  const model = Core.Model.fromMoc(moc);
  const P = model.parameters; const D = model.drawables; const ci = model.canvasinfo;
  const info = { ids: Array.from(P.ids), min: P.minimumValues, max: P.maximumValues, def: P.defaultValues, index: new Map(Array.from(P.ids).map((id, i) => [id, i])) };
  const partIndex = new Map(Array.from(model.parts.ids).map((id, i) => [id, i]));
  const physics = files.physics ? new Live2DPhysics(files.physics, info) : null;
  const U = Core.Utils;

  // ---------------------------------------------------------------- GL
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: true });
  if (!gl) throw new Error('This browser has no WebGL2.');
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  const L = Object.fromEntries(['uM', 'uTex', 'uMask', 'uOpacity', 'uMaskMode', 'uViewport', 'uMul', 'uScr'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  const aPos = gl.getAttribLocation(prog, 'aPos'); const aUv = gl.getAttribLocation(prog, 'aUv');
  const textures = files.textures.map((img) => {
    if (!img) return null;
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  });
  const meshes = [];
  for (let i = 0; i < D.count; i++) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, D.vertexPositions[i], gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const uv = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, uv); gl.bufferData(gl.ARRAY_BUFFER, D.vertexUvs[i], gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aUv); gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    const idx = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, D.indices[i], gl.STATIC_DRAW);
    meshes.push({ vao, pos, uv, idx, count: D.indexCounts[i] });
  }
  gl.bindVertexArray(null);
  let mask = null;
  const ensureMask = (w, h) => {
    if (mask && mask.w === w && mask.h === h) return mask;
    if (mask) { gl.deleteTexture(mask.tex); gl.deleteFramebuffer(mask.fb); }
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    mask = { tex, fb, w, h }; return mask;
  };

  // ---------------------------------------------------------------- state
  let pose = {}; let bg = null; let framing = { zoom: 1, x: 0, y: 0 }; let overrides = null; let alive = true; let raf = 0; let last = performance.now();
  const expW = new Array(files.expressions.length).fill(0);
  const expressions = new ExpressionPlayer(files.expressions);
  const motions = Object.fromEntries(Object.entries(files.motions).map(([g, list]) => [g, list.map((m) => ({ ...m, parsed: null }))]));
  const player = new MotionPlayer();
  let idleGroup = doc.idle !== undefined ? doc.idle : (motions.Idle ? 'Idle' : Object.keys(motions).find((g) => /idle/i.test(g)) || null);
  const bindings = doc.bindings?.length ? doc.bindings : LIVE2D_BINDINGS;
  const lipIds = (files.groups.find((g) => g.Name === 'LipSync')?.Ids) || [];
  const partIds = Array.from(model.parts.ids);
  const posePlayer = files.pose ? new PosePlayer(files.pose, partIds) : null;
  const partParams = {};   // part id → visibility asked for by motions (kept between frames, like Cubism's part parameters)
  /** Plays motion i of a group at a priority ('idle' | 'normal' | 'force'); resolves to whether it started. */
  const startMotion = async (group, i = 0, priority = 'force') => {
    const m = motions[group]?.[i]; const pr = PRIORITY[priority] ?? PRIORITY.force;
    if (!m || !player.reserve(pr)) return false;
    try { m.parsed ||= parseMotion(await m.load(), { fadeIn: m.fadeIn, fadeOut: m.fadeOut }); } catch (e) { player.cancel(pr); throw e; }
    if (!alive) return false;
    player.start(m.parsed, pr);
    return true;
  };
  // the idle group: a random motion from it whenever nothing else plays (Cubism's sample apps do the same)
  let idleLoading = false;
  const idle = () => {
    const list = idleGroup && motions[idleGroup];
    if (!list?.length || idleLoading || !player.isFinished()) return;
    idleLoading = true;
    startMotion(idleGroup, Math.floor(Math.random() * list.length), 'idle').catch(() => {}).finally(() => { idleLoading = false; });
  };
  const triggers = {}; // motion hotkey counters seen
  const motionKeys = Object.entries(motions).flatMap(([g, list]) => list.map((_, i) => `motion:${g}:${i}`));

  // model units → clip space: Cubism's canvas (y up), fitted into our canvas with the framing
  const matrix = () => {
    const W = canvas.width; const H = canvas.height; const ppu = ci.PixelsPerUnit;
    const s = Math.min(W / ci.CanvasWidth, H / ci.CanvasHeight) * 0.96 * framing.zoom;
    const ox = (W - ci.CanvasWidth * s) / 2 + framing.x * W; const oy = (H - ci.CanvasHeight * s) / 2 + framing.y * H;
    // pixel = (origin + pos * ppu * (1, -1)) * s + offset, then to clip
    const ax = (ppu * s * 2) / W; const ay = (ppu * s * 2) / H;
    const bx = ((ci.CanvasOriginX * s + ox) * 2) / W - 1; const by = 1 - ((ci.CanvasOriginY * s + oy) * 2) / H;
    return new Float32Array([ax, 0, 0, 0, ay, 0, bx, by, 1]);
  };

  const values = {};
  const frame = () => {
    const now = performance.now(); const dt = Math.min(0.1, (now - last) / 1000); last = now;
    for (let i = 0; i < info.ids.length; i++) values[info.ids[i]] = info.def[i];
    // motion hotkeys: a new press count plays the motion (the first count seen by a late OBS page is only noted)
    for (const k of motionKeys) {
      const v = pose.expr?.[k]; if (!v || v === triggers[k]) continue;
      const first = triggers[k] === undefined; triggers[k] = v;
      if (first && Math.abs(v) !== 1) continue;
      const [, g, i] = /^motion:(.*):(\d+)$/.exec(k);
      startMotion(g, +i, v > 0 ? 'force' : 'normal').catch(() => {});
    }
    idle();
    player.update(values, partParams, dt);
    for (const b of bindings) {
      const x = pose[b.pose]; const i = info.index.get(b.param);
      if (i === undefined || !Number.isFinite(x)) continue;
      values[b.param] = Math.max(info.min[i], Math.min(info.max[i], x * (b.scale ?? 1) + (b.offset || 0)));
    }
    if (Number.isFinite(pose.mouthOpen)) for (const id of lipIds) if (info.index.has(id)) values[id] = Math.max(values[id] ?? 0, pose.mouthOpen);
    // expressions: from hotkeys (pose.expr = { 'exp:<index>': 1 }) plus any set by the editor; they fade in and out
    for (let k = 0; k < expW.length; k++) expressions.set(k, expW[k] > 0 || pose.expr?.[`exp:${k}`] > 0);
    expressions.update(values, dt, info);
    physics?.step(values, dt);
    if (overrides) Object.assign(values, overrides);
    for (let i = 0; i < info.ids.length; i++) P.values[i] = Math.max(info.min[i], Math.min(info.max[i], values[info.ids[i]]));
    // parts: the pose switches its groups; motions' PartOpacity curves set any other part directly
    const op = model.parts.opacities;
    posePlayer?.update(partParams, op, dt);
    for (const [id, v] of Object.entries(partParams)) { if (posePlayer?.ids.has(id)) continue; const i = partIndex.get(id); if (i !== undefined) op[i] = v; }
    model.update();
    draw();
    D.resetDynamicFlags?.();
  };
  const drawMesh = (i, opacity, mode, M) => {
    const t = textures[D.textureIndices[i]]; if (!t) return;
    const m = meshes[i];
    gl.bindVertexArray(m.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.pos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, D.vertexPositions[i]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1f(L.uOpacity, opacity); gl.uniform1i(L.uMaskMode, mode); gl.uniformMatrix3fv(L.uM, false, M);
    const mc = D.multiplyColors; const sc = D.screenColors;
    gl.uniform4f(L.uMul, mc ? mc[i * 4] : 1, mc ? mc[i * 4 + 1] : 1, mc ? mc[i * 4 + 2] : 1, 1);
    gl.uniform4f(L.uScr, sc ? sc[i * 4] : 0, sc ? sc[i * 4 + 1] : 0, sc ? sc[i * 4 + 2] : 0, 1);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
  };
  const order = new Int32Array(D.count);
  const draw = () => {
    const W = canvas.width; const H = canvas.height; const M = matrix();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    const c = parseColorCached(bg); gl.clearColor(...(c || [0, 0, 0, 0])); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog); gl.enable(gl.BLEND); gl.uniform1i(L.uTex, 0); gl.uniform1i(L.uMask, 1); gl.uniform2f(L.uViewport, W, H);
    for (let i = 0; i < D.count; i++) order[D.renderOrders[i]] = i;
    let maskKey = null;
    for (let k = 0; k < D.count; k++) {
      const i = order[k];
      if (!U.hasIsVisibleBit(D.dynamicFlags[i]) || D.opacities[i] <= 0.001) continue;
      let mode = 0;
      if (D.maskCounts[i] > 0) {
        const key = Array.from(D.masks[i]).join(',');
        if (key !== maskKey) {
          const m = ensureMask(W, H);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, m.fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          for (const j of D.masks[i]) if (j >= 0) drawMesh(j, 1, 0, M);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null); maskKey = key;
        }
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mask.tex);
        mode = U.hasIsInvertedMaskBit?.(D.constantFlags[i]) ? 2 : 1;
      }
      const f = D.constantFlags[i];
      if (U.hasBlendAdditiveBit(f)) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      else if (U.hasBlendMultiplicativeBit(f)) gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawMesh(i, D.opacities[i], mode, M);
    }
    gl.bindVertexArray(null);
  };
  let bgKey = null; let bgVal = null;
  const parseColorCached = (css) => { if (css !== bgKey) { bgKey = css; bgVal = parseColor(css); } return bgVal; };
  const loop = () => { if (!alive) return; try { frame(); } catch (e) { console.warn('[live2d]', e); } raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);

  return {
    setPose(p) { pose = p || {}; },
    resize(w, h) { canvas.width = Math.max(1, Math.round(w)); canvas.height = Math.max(1, Math.round(h)); },
    setBackground(css) { bg = css || null; },
    setFraming(f) { framing = { ...framing, ...f }; },
    async snapshot() {
      frame();
      const W = canvas.width; const H = canvas.height; const px = new Uint8ClampedArray(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const out = new ImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W * 4; x += 4) { const s = (H - 1 - y) * W * 4 + x; const d = y * W * 4 + x; const a = px[s + 3]; out.data[d] = a ? (px[s] * 255) / a : 0; out.data[d + 1] = a ? (px[s + 1] * 255) / a : 0; out.data[d + 2] = a ? (px[s + 2] * 255) / a : 0; out.data[d + 3] = a; }
      const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(out, 0, 0);
      return c.convertToBlob({ type: 'image/png' });
    },
    info: () => ({ parameters: info.ids.map((id, i) => ({ id, min: info.min[i], max: info.max[i], def: info.def[i] })), parts: partIds.length, drawables: D.count, motions: Object.fromEntries(Object.entries(motions).map(([g, l]) => [g, l.length])), pose: posePlayer ? posePlayer.groups.length : 0, version: Core.Version?.csmGetVersion?.(), canvas: { w: ci.CanvasWidth, h: ci.CanvasHeight } }),
    values: () => values,
    parts: () => Object.fromEntries(partIds.map((id, i) => [id, model.parts.opacities[i]])),
    motionState: () => ({ playing: player.entries.length, priority: player.current, time: player.time }),
    setOverrides(o) { overrides = o && Object.keys(o).length ? o : null; },
    playMotion: (g, i, priority) => startMotion(g, i, priority),
    // a new idle group takes over when the current motion ends; none stops the idle motion (fading it out)
    setIdle(g) { idleGroup = g; if (!g && player.current === PRIORITY.idle) for (const e of player.entries) player.fadeOut(e, e.m.fadeOut); },
    expressions: () => [
      ...files.expressions.map((e, k) => ({ id: `exp:${k}`, name: e.name })),
      ...Object.entries(motions).flatMap(([g, list]) => list.map((m, i) => ({ id: `motion:${g}:${i}`, name: `${g || 'Motion'} ${i + 1}`, motion: true }))),
    ],
    setExpression(k, w) { expW[k] = w; },
    dispose() {
      alive = false; cancelAnimationFrame(raf);
      for (const m of meshes) { gl.deleteBuffer(m.pos); gl.deleteBuffer(m.uv); gl.deleteBuffer(m.idx); gl.deleteVertexArray(m.vao); }
      for (const t of textures) if (t) gl.deleteTexture(t);
      try { model.release(); moc._release?.(); } catch { /* already gone */ }
    },
  };
}
