// One Euro filter (Casiez, Roussel & Vogel, CHI 2012): a low-pass filter whose cut-off rises with speed, so slow
// movements are smooth (no jitter) and fast ones stay responsive (little lag). One per tracked value.
//   minCutoff: lower = smoother when still (Hz).  beta: higher = less lag when moving fast.
const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

export class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.3, dCutoff = 1) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = null; this.dx = 0; this.t = 0; }
  reset() { this.x = null; this.dx = 0; }
  filter(v, t /* seconds */) {
    if (this.x === null || !Number.isFinite(this.x)) { this.x = v; this.t = t; this.dx = 0; return v; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dv = (v - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

/** A filter per key, created on first use. */
export class FilterBank {
  constructor() { this.f = new Map(); }
  run(key, v, t, minCutoff, beta) {
    let f = this.f.get(key);
    if (!f) this.f.set(key, (f = new OneEuro(minCutoff, beta)));
    f.minCutoff = minCutoff; f.beta = beta;
    return f.filter(v, t);
  }
  reset() { this.f.clear(); }
}
