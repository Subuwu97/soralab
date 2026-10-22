// Playing a Live2D model's own data on top of Cubism Core, following the published behaviour of Live2D's open-source
// Cubism Framework: physics (physics3.json, pendulum strands), expressions (exp3.json, with Add / Multiply / Overwrite
// blending and fades), motions (motion3.json curves, with fade-in / fade-out, priorities and crossfades) and pose part
// switching (pose3.json, CubismPose). All work on a plain { paramId: value } map that the stage then writes into Core.

// ---------------------------------------------------------------- physics3.json
const AIR_RESISTANCE = 5; const MAX_WEIGHT = 100; const MOVEMENT_THRESHOLD = 0.001;
const dirToRad = (from, to) => { let r = Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x); while (r < -Math.PI) r += 2 * Math.PI; while (r > Math.PI) r -= 2 * Math.PI; return r; };
function normalizeParam(value, pMin, pMax, pDef, nMin, nMax, nDef, inverted) {
  const maxV = Math.max(pMax, pMin); const minV = Math.min(pMax, pMin);
  value = Math.max(minV, Math.min(maxV, value));
  const minN = Math.min(nMin, nMax); const maxN = Math.max(nMin, nMax);
  const mid = minV + (maxV - minV) / 2; const pv = value - mid;
  let r = nDef;
  if (pv > 0) { const pl = maxV - mid; if (pl) r = pv * ((maxN - nDef) / pl) + nDef; } else if (pv < 0) { const pl = minV - mid; if (pl) r = pv * ((minN - nDef) / pl) + nDef; }
  void pDef;
  return inverted ? r : -r;
}

export class Live2DPhysics {
  /** json: physics3.json; info: { ids, min, max, def } of the model's parameters. */
  constructor(json, info) {
    this.info = info; this.acc = 0;
    this.settings = (json?.PhysicsSettings || []).map((s) => {
      const strand = (s.Vertices || []).map((v) => ({ mobility: v.Mobility ?? 1, delay: v.Delay ?? 1, acceleration: v.Acceleration ?? 1, radius: v.Radius ?? 0, position: { x: 0, y: 0 }, last: { x: 0, y: 0 }, lastGravity: { x: 0, y: 1 }, velocity: { x: 0, y: 0 }, force: { x: 0, y: 0 } }));
      let y = 0; strand.forEach((p, i) => { if (i) y += p.radius; p.position = { x: 0, y }; p.last = { x: 0, y }; });
      return { input: s.Input || [], output: s.Output || [], strand, norm: s.Normalization || { Position: { Minimum: -10, Default: 0, Maximum: 10 }, Angle: { Minimum: -10, Default: 0, Maximum: 10 } } };
    });
  }
  idx(id) { return this.info.index.get(id) ?? -1; }
  step(values, dt) {
    if (!this.settings.length) return values;
    this.acc += Math.min(0.1, Math.max(0, dt));
    const h = 1 / 60; let n = 0;
    while (this.acc >= h && n++ < 6) { this.acc -= h; for (const s of this.settings) this.sim(s, values, h); }
    for (const s of this.settings) this.out(s, values);
    return values;
  }
  sim(s, values, dt) {
    const tr = { x: 0, y: 0 }; let angle = 0;
    for (const inp of s.input) {
      const i = this.idx(inp.Source?.Id); if (i < 0) continue;
      const id = inp.Source.Id; const v = values[id] ?? this.info.def[i]; const w = (inp.Weight ?? 100) / MAX_WEIGHT;
      const P = s.norm.Position; const A = s.norm.Angle;
      if (inp.Type === 'X') tr.x += normalizeParam(v, this.info.min[i], this.info.max[i], this.info.def[i], P.Minimum, P.Maximum, P.Default, inp.Reflect) * w;
      else if (inp.Type === 'Y') tr.y += normalizeParam(v, this.info.min[i], this.info.max[i], this.info.def[i], P.Minimum, P.Maximum, P.Default, inp.Reflect) * w;
      else if (inp.Type === 'Angle') angle += normalizeParam(v, this.info.min[i], this.info.max[i], this.info.def[i], A.Minimum, A.Maximum, A.Default, inp.Reflect) * w;
    }
    const ra = (-angle * Math.PI) / 180;
    const x = tr.x * Math.cos(ra) - tr.y * Math.sin(ra); const y = tr.x * Math.sin(ra) + tr.y * Math.cos(ra);
    const st = s.strand; if (!st.length) return;
    st[0].position = { x, y };
    const tRad = (angle * Math.PI) / 180;
    const g = { x: Math.sin(tRad), y: Math.cos(tRad) }; const gl = Math.hypot(g.x, g.y) || 1; g.x /= gl; g.y /= gl;
    const threshold = MOVEMENT_THRESHOLD * Math.abs(s.norm.Position.Maximum);
    for (let i = 1; i < st.length; i++) {
      const p = st[i]; const q = st[i - 1];
      p.force = { x: g.x * p.acceleration, y: g.y * p.acceleration };
      p.last = { ...p.position };
      const delay = p.delay * dt * 30;
      let dx = p.position.x - q.position.x; let dy = p.position.y - q.position.y;
      const rad = dirToRad(p.lastGravity, g) / AIR_RESISTANCE;
      const ndx = Math.cos(rad) * dx - dy * Math.sin(rad); const ndy = Math.sin(rad) * dx + dy * Math.cos(rad); dx = ndx; dy = ndy;
      p.position = { x: q.position.x + dx + p.velocity.x * delay + p.force.x * delay * delay, y: q.position.y + dy + p.velocity.y * delay + p.force.y * delay * delay };
      let ux = p.position.x - q.position.x; let uy = p.position.y - q.position.y; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
      p.position = { x: q.position.x + ux * p.radius, y: q.position.y + uy * p.radius };
      if (Math.abs(p.position.x) < threshold) p.position.x = 0;
      if (delay) p.velocity = { x: ((p.position.x - p.last.x) / delay) * p.mobility, y: ((p.position.y - p.last.y) / delay) * p.mobility };
      p.lastGravity = { ...g };
    }
  }
  out(s, values) {
    const st = s.strand;
    for (const o of s.output) {
      const k = o.VertexIndex; const i = this.idx(o.Destination?.Id);
      if (i < 0 || k < 1 || k >= st.length) continue;
      const t = { x: st[k].position.x - st[k - 1].position.x, y: st[k].position.y - st[k - 1].position.y };
      let v;
      if (o.Type === 'X') v = t.x * (o.Reflect ? -1 : 1);
      else if (o.Type === 'Y') v = t.y * (o.Reflect ? -1 : 1);
      else {
        const parent = k >= 2 ? { x: st[k - 1].position.x - st[k - 2].position.x, y: st[k - 1].position.y - st[k - 2].position.y } : { x: 0, y: 1 };
        v = dirToRad(parent, t) * (o.Reflect ? -1 : 1);
      }
      v *= o.Scale ?? 1;
      v = Math.max(this.info.min[i], Math.min(this.info.max[i], v));
      const w = (o.Weight ?? 100) / MAX_WEIGHT; const id = o.Destination.Id;
      values[id] = w >= 1 ? v : (values[id] ?? this.info.def[i]) * (1 - w) + v * w;
    }
  }
}

// ---------------------------------------------------------------- fades

/** Cubism's fade curve: 0 → 1 over x in 0..1, eased like a sine (CubismMath.getEasingSine). */
export const easeSine = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(x * Math.PI));
const fadeTime = (...v) => { for (const x of v) if (Number.isFinite(x) && x >= 0) return x; return 1; }; // Cubism's default fade is 1 s

// ---------------------------------------------------------------- exp3.json

/**
 * Expressions that fade in when turned on and out when turned off (exp3 FadeInTime / FadeOutTime, 1 s by default).
 * Each parameter blends as Cubism's CubismExpressionMotion does: Add adds Value, Multiply multiplies by Value,
 * Overwrite sets Value; an expression at fade weight w mixes its (add, multiply, overwrite) into the ones before it
 * by w, and the result is (overwrite + add) × multiply. Turning one on while another is on works like Cubism's switch
 * (the later one wins where both set a parameter); parameters only one of them sets keep that one's effect.
 */
export class ExpressionPlayer {
  /** exps: [{ name, data: exp3 json }] */
  constructor(exps) { this.exps = exps; this.time = 0; this.entries = []; }
  /** Turns expression k on or off (fading). */
  set(k, on) {
    const x = this.exps[k]?.data; if (!x) return;
    const live = this.entries.find((e) => e.k === k && e.end < 0);
    if (on && !live) this.entries.push({ k, start: this.time, end: -1 });
    else if (!on && live) live.end = this.time + fadeTime(x.FadeOutTime);
  }
  isOn(k) { return this.entries.some((e) => e.k === k && e.end < 0); }
  /** Fade weight of expression k now (0..1). */
  weight(k) { return this.entries.filter((e) => e.k === k).reduce((w, e) => Math.max(w, this.fadeOf(e)), 0); }
  fadeOf(e) {
    const x = this.exps[e.k].data; const fi = fadeTime(x.FadeInTime); const fo = fadeTime(x.FadeOutTime);
    const fin = fi === 0 ? 1 : easeSine((this.time - e.start) / fi);
    const fout = e.end < 0 ? 1 : fo === 0 ? (this.time < e.end ? 1 : 0) : easeSine((e.end - this.time) / fo);
    return fin * fout;
  }
  /** Advances by dt seconds and applies the expressions to values (info: the model's parameter ranges). */
  update(values, dt, info) {
    this.time += Math.max(0, dt);
    const acc = new Map(); // id → { add, mul, over }
    for (const e of this.entries) {
      const w = this.fadeOf(e);
      for (const p of this.exps[e.k].data.Parameters || []) {
        const i = info.index.get(p.Id); if (i === undefined) continue;
        const cur = values[p.Id] ?? info.def[i];
        let a = acc.get(p.Id); if (!a) acc.set(p.Id, (a = { add: 0, mul: 1, over: cur, i }));
        const v = p.Value ?? (p.Blend === 'Multiply' ? 1 : 0);
        const [na, nm, no] = p.Blend === 'Multiply' ? [0, v, cur] : p.Blend === 'Overwrite' ? [0, 1, v] : [v, 1, cur];
        a.add += (na - a.add) * w; a.mul += (nm - a.mul) * w; a.over += (no - a.over) * w;
      }
    }
    for (const [id, a] of acc) values[id] = Math.max(info.min[a.i], Math.min(info.max[a.i], (a.over + a.add) * a.mul));
    this.entries = this.entries.filter((e) => e.end < 0 || this.time < e.end);
    return values;
  }
}

// ---------------------------------------------------------------- motion3.json

/** Parses curves into [{ target, id, segs, fadeIn, fadeOut }]; fades from the model3.json entry win over the file's. */
export function parseMotion(json, { fadeIn, fadeOut } = {}) {
  const curves = (json.Curves || []).map((c) => {
    const s = c.Segments || []; const segs = []; let i = 2; let t0 = s[0]; let v0 = s[1];
    while (i < s.length) {
      const type = s[i];
      if (type === 1) { segs.push({ type, t0, v0, p1: [s[i + 1], s[i + 2]], p2: [s[i + 3], s[i + 4]], t1: s[i + 5], v1: s[i + 6] }); t0 = s[i + 5]; v0 = s[i + 6]; i += 7; } else { segs.push({ type, t0, v0, t1: s[i + 1], v1: s[i + 2] }); t0 = s[i + 1]; v0 = s[i + 2]; i += 3; }
    }
    // per-curve fades: -1 = use the motion's
    return { target: c.Target, id: c.Id, first: s[1], segs, fadeIn: Number.isFinite(c.FadeInTime) ? c.FadeInTime : -1, fadeOut: Number.isFinite(c.FadeOutTime) ? c.FadeOutTime : -1 };
  });
  const m = json.Meta || {};
  // Cubism: a motion loops only when Meta.Loop is true; fades default to 1 s.
  return { duration: m.Duration || 0, loop: m.Loop === true, curves, fadeIn: fadeTime(fadeIn, m.FadeInTime), fadeOut: fadeTime(fadeOut, m.FadeOutTime) };
}
export function evalCurve(c, t) {
  if (!c.segs.length) return c.first;
  if (t <= c.segs[0].t0) return c.segs[0].v0;
  for (const g of c.segs) {
    if (t > g.t1) continue;
    const u = g.t1 > g.t0 ? (t - g.t0) / (g.t1 - g.t0) : 1;
    if (g.type === 0) return g.v0 + (g.v1 - g.v0) * u;
    if (g.type === 2) return g.v0;      // stepped
    if (g.type === 3) return g.v1;      // inverse stepped
    // bezier: find the curve parameter whose time is t (bisection; exact for Cubism's restricted handles too), then its value
    const bz = (a, b, c2, d, x) => { const y = 1 - x; return y * y * y * a + 3 * y * y * x * b + 3 * y * x * x * c2 + x * x * x * d; };
    let lo = 0; let hi = 1;
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (bz(g.t0, g.p1[0], g.p2[0], g.t1, mid) < t) lo = mid; else hi = mid; }
    return bz(g.v0, g.p1[1], g.p2[1], g.v1, (lo + hi) / 2);
  }
  return c.segs[c.segs.length - 1].v1;
}

// Cubism's motion priorities: an idle motion runs when nothing else does; Normal starts only when nothing of its
// priority or higher is playing (or reserved while loading); Force always starts.
export const PRIORITY = { none: 0, idle: 1, normal: 2, force: 3 };

/**
 * Motion playback like Cubism's CubismMotionManager: starting a motion fades out the ones playing (each over its own
 * fade-out time) while the new one fades in, so they crossfade. A motion's weight is easeSine(fade-in) × easeSine(fade-out),
 * and each parameter moves from its current value toward the curve by that weight. A motion that doesn't loop fades out
 * by itself at its end. PartOpacity curves set the part's visibility value (for the pose) without fading.
 */
export class MotionPlayer {
  constructor() { this.time = 0; this.entries = []; this.current = 0; this.reserved = 0; }
  /** Before loading a motion: may one of this priority start? (Reserves it; Force always may.) */
  reserve(priority) {
    if (priority >= PRIORITY.force) { this.reserved = priority; return true; }
    if (priority <= this.reserved || priority <= this.current) return false;
    this.reserved = priority; return true;
  }
  /** Starts a parsed motion (after reserve). */
  start(m, priority) {
    if (priority === this.reserved) this.reserved = 0;
    this.current = priority;
    for (const e of this.entries) this.fadeOut(e, e.m.fadeOut);
    this.entries.push({ m, priority, start: null, end: -1 });
  }
  /** Releases a reservation whose motion couldn't be loaded. */
  cancel(priority) { if (priority === this.reserved) this.reserved = 0; }
  fadeOut(e, secs) {
    if (e.start === null) { e.finished = true; return; } // never shown
    const end = this.time + secs;
    if (e.end < 0 || end < e.end) e.end = end;
  }
  stopAll() { this.entries = []; this.current = 0; this.reserved = 0; }
  isFinished() { return !this.entries.length; }
  /** Advances by dt and applies the motions. partParams: part id → visibility (persistent, for the pose). */
  update(values, partParams, dt) {
    this.time += Math.max(0, dt);
    const t = this.time;
    for (const e of this.entries) {
      const m = e.m;
      if (e.finished) continue;
      if (e.start === null) { e.start = t; e.end = m.loop || m.duration <= 0 ? -1 : t + m.duration; }
      const fin = m.fadeIn === 0 ? 1 : easeSine((t - e.start) / m.fadeIn);
      const fout = m.fadeOut === 0 || e.end < 0 ? 1 : easeSine((e.end - t) / m.fadeOut);
      let local = t - e.start;
      if (m.loop && m.duration > 0) local %= m.duration;
      for (const c of m.curves) {
        const v = evalCurve(c, local);
        if (c.target === 'PartOpacity') { partParams[c.id] = v; continue; }
        if (c.target !== 'Parameter') continue;
        let w = fin * fout;
        if (c.fadeIn >= 0 || c.fadeOut >= 0) {
          const ci = c.fadeIn < 0 ? fin : c.fadeIn === 0 ? 1 : easeSine((t - e.start) / c.fadeIn);
          const co = c.fadeOut < 0 ? fout : c.fadeOut === 0 || e.end < 0 ? 1 : easeSine((e.end - t) / c.fadeOut);
          w = ci * co;
        }
        const src = values[c.id];
        values[c.id] = src === undefined ? v : src + (v - src) * w;
      }
      if (e.end > 0 && e.end < t) e.finished = true;
    }
    this.entries = this.entries.filter((e) => !e.finished);
    if (!this.entries.length) this.current = 0;
    return values;
  }
}

// ---------------------------------------------------------------- pose3.json

/**
 * Part switching like Cubism's CubismPose: in each group only one part shows (say, arms down or arms up). A part is
 * asked for by setting its visibility value (a "parameter" named like the part, set by motions' PartOpacity curves) above
 * 0.001; it then fades in over FadeInTime (0.5 s by default) while the others fade out along Cubism's curve, which keeps
 * the background from showing through more than 15 %. Linked parts copy their part's opacity.
 */
export class PosePlayer {
  /** json: pose3.json; partIds: the model's part ids in Core's order. */
  constructor(json, partIds) {
    const index = new Map(Array.from(partIds, (id, i) => [id, i]));
    const ft = json?.FadeInTime;
    this.fade = Number.isFinite(ft) && ft >= 0 ? ft : 0.5;
    this.groups = (json?.Groups || []).map((g) => (g || [])
      .map((p) => ({ id: p.Id, part: index.get(p.Id) ?? -1, links: (p.Link || []).map((l) => index.get(l) ?? -1).filter((i) => i >= 0) }))
      .filter((p) => p.part >= 0)).filter((g) => g.length);
    this.ids = new Set(this.groups.flat().map((p) => p.id));
    this.ready = false;
  }
  /** First part of each group shown, the rest hidden (Cubism's reset). */
  reset(partParams, opacities) {
    for (const g of this.groups) g.forEach((p, j) => { partParams[p.id] = j === 0 ? 1 : 0; opacities[p.part] = j === 0 ? 1 : 0; });
    this.ready = true;
  }
  update(partParams, opacities, dt) {
    if (!this.ready) this.reset(partParams, opacities);
    dt = Math.max(0, dt);
    const PHI = 0.5; const BACK = 0.15;
    for (const g of this.groups) {
      let vis = -1; let op = 1;
      for (let i = 0; i < g.length; i++) {
        if (!((partParams[g[i].id] ?? 0) > 0.001)) continue;
        if (vis >= 0) break;
        vis = i;
        op = this.fade === 0 ? 1 : Math.min(1, opacities[g[i].part] + dt / this.fade);
      }
      if (vis < 0) { vis = 0; op = 1; }
      for (let i = 0; i < g.length; i++) {
        const p = g[i];
        if (i === vis) { opacities[p.part] = op; continue; }
        let a = op < PHI ? (op * (PHI - 1)) / PHI + 1 : ((1 - op) * PHI) / (1 - PHI);
        if ((1 - a) * (1 - op) > BACK) a = 1 - BACK / (1 - op);
        if (opacities[p.part] > a) opacities[p.part] = a;
      }
    }
    for (const g of this.groups) for (const p of g) for (const l of p.links) opacities[l] = opacities[p.part];
  }
}
