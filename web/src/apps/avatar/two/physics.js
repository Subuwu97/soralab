// Physics for hair, ribbons and accessories: pendulum chains whose root is moved by parameters (usually the head
// angles), simulated with Verlet integration, and whose swing drives output parameters (ParamHairFront…), which the
// hair's keyforms then follow. Similar in spirit to Cubism's physics settings.
//
//   chain = { id, name, enabled, segments: 3, length: 120 (px), damping: 0.15 (0..1), stiffness: 0.25 (pull back to
//             hanging), wind: 0 (0..1), gravity: 1,
//             inputs:  [{ param, weight, type: 'x' | 'angle' }]     x moves the root sideways, angle tilts it
//             outputs: [{ param, weight, segment: -1 (last) }] }     swing angle → parameter (±60° = its full range)
import { paramById } from './model.js';

export const newChain = (name, extra = {}) => ({
  id: `ph${Math.random().toString(36).slice(2, 8)}`, name, enabled: true, segments: 3, length: 120, damping: 0.3, stiffness: 0.25, wind: 0, gravity: 1,
  inputs: [{ param: 'ParamAngleX', weight: 0.6, type: 'x' }, { param: 'ParamAngleZ', weight: 0.6, type: 'angle' }, { param: 'ParamBodyAngleX', weight: 0.4, type: 'x' }],
  outputs: [{ param: 'ParamHairFront', weight: 1, segment: -1 }], ...extra,
});

const norm = (p, v) => {
  // −1..1 around the default (each side scaled separately, so 0..1 params still read well)
  if (v >= p.def) return p.max > p.def ? (v - p.def) / (p.max - p.def) : 0;
  return p.min < p.def ? (v - p.def) / (p.def - p.min) : 0;
};
const denorm = (p, n) => (n >= 0 ? p.def + n * (p.max - p.def) : p.def + n * (p.def - p.min));

/** Holds the simulation state of every chain; step() advances it and writes the outputs into `values`. */
export class PhysicsSim {
  constructor() { this.state = new Map(); this.t = 0; this.acc = 0; }
  reset() { this.state.clear(); }
  step(doc, values, dt) {
    if (!doc.physics?.length) return values;
    dt = Math.min(0.1, Math.max(0, dt));
    this.acc += dt;
    const h = 1 / 120; // fixed sub-steps keep it stable at any frame rate
    let n = 0;
    while (this.acc >= h && n++ < 24) { this.t += h; for (const c of doc.physics) if (c.enabled !== false) this.sim(doc, c, values, h); this.acc -= h; }
    for (const c of doc.physics) if (c.enabled !== false) this.output(doc, c, values);
    return values;
  }
  init(c) {
    const seg = Math.max(1, Math.min(8, c.segments | 0)); const L = (c.length || 100) / seg;
    const pts = []; for (let i = 0; i <= seg; i++) pts.push({ x: 0, y: i * L, px: 0, py: i * L });
    const s = { pts, seg, L, rootAngle: 0 };
    this.state.set(c.id, s);
    return s;
  }
  sim(doc, c, values, h) {
    let s = this.state.get(c.id);
    if (!s || s.seg !== Math.max(1, Math.min(8, c.segments | 0)) || Math.abs(s.L - (c.length || 100) / s.seg) > 1e-6) s = this.init(c);
    // the root follows the inputs
    let rx = 0; let ra = 0;
    for (const inp of c.inputs || []) {
      const p = paramById(doc, inp.param); if (!p) continue;
      const v = norm(p, values[inp.param] ?? p.def) * (inp.weight ?? 1);
      if (inp.type === 'angle') ra += v * 30; else rx += v * (c.length || 100) * 0.3;
    }
    s.rootAngle = (ra * Math.PI) / 180;
    const root = s.pts[0]; root.px = root.x; root.py = root.y; root.x = rx; root.y = 0;
    // damping: how fast a swing dies down — the share of speed kept per step (0.15 → about half lost each second)
    const damp = Math.pow(1 - Math.max(0, Math.min(0.95, c.damping ?? 0.15)), 4 * h);
    const g = 2000 * (c.gravity ?? 1); // px/s²: a ~1 Hz swing for a chain a few hundred px long
    const wind = (c.wind || 0) * 1200 * (Math.sin(this.t * 1.7) * 0.6 + Math.sin(this.t * 3.1 + 1) * 0.4 + 0.3);
    const ca = Math.cos(s.rootAngle); const sa = Math.sin(s.rootAngle);
    for (let i = 1; i < s.pts.length; i++) {
      const q = s.pts[i];
      // where this point would hang at rest (straight down from the root, tilted with it)
      const hx = root.x - sa * i * s.L; const hy = root.y + ca * i * s.L;
      const k = (c.stiffness ?? 0.25) * 100;
      const ax = wind + (hx - q.x) * k; const ay = g + (hy - q.y) * k;
      const vx = (q.x - q.px) * damp; const vy = (q.y - q.py) * damp;
      q.px = q.x; q.py = q.y;
      q.x += vx + ax * h * h; q.y += vy + ay * h * h;
    }
    // keep segment lengths (a few relaxation passes)
    for (let it = 0; it < 4; it++) for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1]; const b = s.pts[i];
      const dx = b.x - a.x; const dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1e-6; const k = (d - s.L) / d;
      if (i === 1) { b.x -= dx * k; b.y -= dy * k; } else { a.x += dx * k * 0.5; a.y += dy * k * 0.5; b.x -= dx * k * 0.5; b.y -= dy * k * 0.5; }
    }
  }
  /** Swing angle of a segment relative to hanging straight (radians; positive = toward +x). */
  angle(c, segment = -1) {
    const s = this.state.get(c.id); if (!s) return 0;
    const i = segment < 0 ? s.pts.length - 1 : Math.max(1, Math.min(s.pts.length - 1, segment));
    const a = s.pts[i - 1]; const b = s.pts[i];
    return Math.atan2(b.x - a.x, b.y - a.y) + s.rootAngle;
  }
  output(doc, c, values) {
    for (const o of c.outputs || []) {
      const p = paramById(doc, o.param); if (!p) continue;
      const n = Math.max(-1, Math.min(1, (this.angle(c, o.segment ?? -1) / (Math.PI / 3)) * (o.weight ?? 1)));
      values[o.param] = denorm(p, n);
    }
  }
  /** Chain points (root at 0,0) for drawing a preview. */
  points(c) { return this.state.get(c.id)?.pts || []; }
}
