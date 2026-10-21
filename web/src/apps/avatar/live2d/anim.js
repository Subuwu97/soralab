// Playing a Live2D model's own data on top of Cubism Core: physics (physics3.json — pendulum strands, following the
// published behaviour of Live2D's open Cubism Framework), expressions (exp3.json) and motions (motion3.json curves).
// All work on a plain { paramId: value } map that the stage then writes into the Core model.

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

// ---------------------------------------------------------------- exp3.json

/** Applies expressions (list of { data: exp3 json }, weights 0..1) to the values. */
export function applyExp3(values, exps, weights, info) {
  exps.forEach((e, k) => {
    const w = weights[k]; if (!w) return;
    for (const p of e.data.Parameters || []) {
      const i = info.index.get(p.Id); if (i === undefined) continue;
      const cur = values[p.Id] ?? info.def[i];
      const next = p.Blend === 'Multiply' ? cur * (1 + ((p.Value ?? 1) - 1) * w) : p.Blend === 'Overwrite' ? cur + ((p.Value ?? 0) - cur) * w : cur + (p.Value ?? 0) * w;
      values[p.Id] = Math.max(info.min[i], Math.min(info.max[i], next));
    }
  });
  return values;
}

// ---------------------------------------------------------------- motion3.json

/** Parses curves into [{ target, id, pts: [{ t, v, type, cps }] }] and evaluates them at a time. */
export function parseMotion(json) {
  const curves = (json.Curves || []).map((c) => {
    const s = c.Segments || []; const segs = []; let i = 2; let t0 = s[0]; let v0 = s[1];
    while (i < s.length) {
      const type = s[i];
      if (type === 1) { segs.push({ type, t0, v0, p1: [s[i + 1], s[i + 2]], p2: [s[i + 3], s[i + 4]], t1: s[i + 5], v1: s[i + 6] }); t0 = s[i + 5]; v0 = s[i + 6]; i += 7; } else { segs.push({ type, t0, v0, t1: s[i + 1], v1: s[i + 2] }); t0 = s[i + 1]; v0 = s[i + 2]; i += 3; }
    }
    return { target: c.Target, id: c.Id, first: s[1], segs };
  });
  return { duration: json.Meta?.Duration || 0, loop: json.Meta?.Loop !== false, curves };
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
    const a = 1 - u; return a * a * a * g.v0 + 3 * a * a * u * g.p1[1] + 3 * a * u * u * g.p2[1] + u * u * u * g.v1; // bezier (time taken as linear)
  }
  return c.segs[c.segs.length - 1].v1;
}
/** Writes a motion's parameter values at time t (looping) into values; part opacities into partOpacity. */
export function applyMotion(m, t, values, partOpacity, weight = 1) {
  const tt = m.loop && m.duration > 0 ? t % m.duration : Math.min(t, m.duration);
  for (const c of m.curves) {
    const v = evalCurve(c, tt);
    if (c.target === 'Parameter') values[c.id] = values[c.id] === undefined || weight >= 1 ? v : values[c.id] + (v - values[c.id]) * weight;
    else if (c.target === 'PartOpacity' && partOpacity) partOpacity[c.id] = v;
  }
  return values;
}
