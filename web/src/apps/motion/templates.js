// Ready-made animations (Sora Ugoki templates). Each builds layers for the current composition, scaled to its size,
// so they're useful straight away and show off the engine: trim paths, per-character text, mattes, expressions.
import { newLayer, newShape, newEffect } from './model.js';

/** An animated property from [t, value, ease?] triples. ease: 'ease' (easy ease both sides) | 'linear' | 'hold' | [x1,y1,x2,y2]. */
const K = (...keys) => ({
  v: keys[0][1],
  k: keys.map(([t, v, e = 'ease']) => ({ t, v, in: e === 'linear' ? 'linear' : 'ease', out: e === 'hold' ? 'hold' : e === 'linear' ? 'linear' : 'ease', ...(Array.isArray(e) ? { bz: e } : {}) })),
});
const OVERSHOOT = [0.3, 1.5, 0.6, 1];

function lowerThird(comp) {
  const W = comp.width; const H = comp.height; const u = H / 1080;
  const x0 = W * 0.08; const y0 = H * 0.78;
  const end = Math.min(comp.duration, 5) - 0.6;
  const bar = newLayer('shape', comp, { name: 'LT Bar', fill: '#141824', position: [x0, y0], shapes: [newShape('rect', { pos: [330 * u, 0], size: [660 * u, 130 * u], round: 10 * u })] });
  bar.tr.position = K([0, [x0 - 760 * u, y0]], [0.6, [x0, y0]], [end, [x0, y0]], [end + 0.5, [x0 - 760 * u, y0]]);
  bar.tr.opacity = K([0, 0], [0.3, 92], [end + 0.3, 92], [end + 0.5, 0]);
  const accent = newLayer('shape', comp, { name: 'LT Accent', fill: null, stroke: '#ff4f7b', strokeWidth: 8 * u, position: [x0, y0],
    shapes: [newShape('path', { closed: false, nodes: [{ p: [0, -65 * u] }, { p: [0, 65 * u] }, { p: [660 * u, 65 * u] }] })] });
  accent.shape.trim.on = true;
  accent.shape.trim.end = K([0.3, 0], [1.1, 100]);
  accent.shape.trim.start = K([end - 0.2, 0], [end + 0.4, 100]);
  const name = newLayer('text', comp, { name: 'LT Name', value: 'Aiko Tanaka', size: 58 * u, align: 'left', position: [x0 + 36 * u, y0 - 6 * u], weight: 700 });
  Object.assign(name.text.anim, { on: true, soft: { v: 4 }, opacity: { v: 0 }, pos: { v: [0, 24 * u] }, start: K([0.5, 0], [1.4, 100]) });
  name.tr.opacity = K([end, 100], [end + 0.35, 0]);
  const title = newLayer('text', comp, { name: 'LT Title', value: 'CREATIVE DIRECTOR · MIRAI', size: 26 * u, align: 'left', position: [x0 + 38 * u, y0 + 40 * u], weight: 500, color: '#9aa4c0' });
  title.text.tracking = { v: 120 };
  title.tr.opacity = K([0.9, 0], [1.5, 100], [end, 100], [end + 0.35, 0]);
  return [title, name, accent, bar];
}

function logoReveal(comp) {
  const W = comp.width; const H = comp.height; const u = H / 1080; const c = [W / 2, H / 2 - 40 * u];
  const ring = newLayer('shape', comp, { name: 'Ring', fill: null, stroke: '#7a5cff', strokeWidth: 14 * u, position: c, shapes: [newShape('ellipse', { size: [360 * u, 360 * u] })] });
  ring.shape.trim.on = true;
  ring.shape.trim.end = K([0, 0], [1.2, 100]);
  ring.shape.trim.offset = K([0, -90], [1.6, 90]);
  ring.tr.rotation = { v: 0, x: 'time * 20' };
  const ring2 = newLayer('shape', comp, { name: 'Ring 2', fill: null, stroke: '#ff4f7b', strokeWidth: 6 * u, position: c, shapes: [newShape('ellipse', { size: [430 * u, 430 * u] })] });
  ring2.shape.stroke.dash = 18 * u;
  ring2.shape.trim.on = true;
  ring2.shape.trim.start = K([0.3, 100], [1.5, 0]);
  const mark = newLayer('shape', comp, { name: 'Logo Mark', fill: '#ffffff', position: c, shapes: [newShape('star', { points: 5, outer: 120 * u, inner: 52 * u })] });
  mark.shape.fill.gradient = { on: true, type: 'linear', a: { v: [-120 * u, -120 * u] }, b: { v: [120 * u, 120 * u] }, c0: { v: '#ffd35c' }, c1: { v: '#ff4f7b' } };
  mark.tr.scale = K([0.9, [0, 0], OVERSHOOT], [1.5, [100, 100]]);
  mark.tr.rotation = K([0.9, -120], [1.6, 0]);
  mark.effects.push(newEffect('glow', comp));
  mark.effects[0].params.radius = K([1.2, 0], [1.8, 40], [2.6, 18]);
  const word = newLayer('text', comp, { name: 'Logo Word', value: 'SORA STUDIO', size: 84 * u, position: [W / 2, c[1] + 330 * u], weight: 800 });
  word.text.tracking = K([1.4, 600], [2.6, 120]);
  Object.assign(word.text.anim, { on: true, soft: { v: 3 }, opacity: { v: 0 }, pos: { v: [0, 0] }, scale: { v: 160 }, start: K([1.4, 0], [2.4, 100]) });
  return [word, mark, ring2, ring];
}

function kinetic(comp) {
  const W = comp.width; const H = comp.height; const u = H / 1080;
  const words = [['MAKE', '#ffffff', 0], ['IT', '#ffd35c', 0.55], ['MOVE.', '#ff4f7b', 1.0], ['MOTION', '#7a5cff', 1.8], ['THAT', '#ffffff', 2.25], ['TALKS', '#5ee0c8', 2.7]];
  const layers = [];
  // lay each row out from rough word widths (Montserrat Black is about 0.78 em per capital)
  const sizeOf = (i) => (i % 3 === 2 ? 170 : 130) * u;
  const widthOf = (i) => words[i][0].length * sizeOf(i) * 0.78;
  const gap = 50 * u;
  const xs = [];
  for (const rowStart of [0, 3]) {
    const total = [0, 1, 2].reduce((a, j) => a + widthOf(rowStart + j), 0) + gap * 2;
    let x = W / 2 - total / 2;
    for (let j = 0; j < 3; j++) { xs[rowStart + j] = x + widthOf(rowStart + j) / 2; x += widthOf(rowStart + j) + gap; }
  }
  words.forEach(([w, col, t0], i) => {
    const row = i < 3 ? 0 : 1;
    const x = xs[i]; const y = H / 2 - 40 * u + row * 190 * u;
    const l = newLayer('text', comp, { name: w, value: w, size: sizeOf(i), color: col, position: [x, y], weight: 900, font: 'Montserrat' });
    l.tr.scale = K([t0, [300, 300], OVERSHOOT], [t0 + 0.35, [100, 100]]);
    l.tr.opacity = K([t0, 0, 'linear'], [t0 + 0.12, 100], ...(row === 0 ? [[1.55, 100], [1.75, 0]] : []));
    l.tr.rotation = K([t0, i % 2 ? 12 : -12], [t0 + 0.4, 0]);
    l.motionBlur = true;
    l.in = t0;
    layers.unshift(l);
  });
  const bar = newLayer('shape', comp, { name: 'Underline', fill: '#ff4f7b', position: [W / 2, H / 2 + 260 * u], shapes: [newShape('rect', { size: [1000 * u, 14 * u] })] });
  bar.tr.scale = K([3.0, [0, 100]], [3.5, [100, 100]]);
  return [...layers, bar];
}

function subscribe(comp) {
  const W = comp.width; const H = comp.height; const u = H / 1080; const c = [W / 2, H / 2];
  const btn = newLayer('shape', comp, { name: 'Button', fill: '#ff2d55', position: c, shapes: [newShape('rect', { size: [620 * u, 140 * u], round: 70 * u })] });
  btn.tr.scale = K([0, [0, 0], OVERSHOOT], [0.5, [100, 100]], [1.9, [100, 100]], [2.0, [92, 92]], [2.15, [100, 100]]);
  btn.shape.fill.color = K([0, '#ff2d55', 'hold'], [2.0, '#3a3d47']);
  btn.effects.push(newEffect('dropShadow', comp));
  const label = newLayer('text', comp, { name: 'SUBSCRIBE', value: 'SUBSCRIBE', size: 52 * u, position: [c[0] + 45 * u, c[1] + 18 * u], weight: 800 });
  label.text.tracking = { v: 80 };
  label.tr.opacity = K([0.25, 0], [0.45, 100], [1.98, 100, 'hold'], [2.0, 0]);
  const done = newLayer('text', comp, { name: 'SUBSCRIBED', value: 'SUBSCRIBED', size: 52 * u, position: [c[0] + 45 * u, c[1] + 18 * u], weight: 800, color: '#c8ccd8' });
  done.text.tracking = { v: 80 };
  done.tr.opacity = K([1.98, 0, 'hold'], [2.0, 100]);
  // A bell drawn with the pen: body + clapper. It rings (expression) once you're subscribed.
  const bell = newLayer('shape', comp, { name: 'Bell', fill: '#ffffff', position: [c[0] - 235 * u, c[1]], shapes: [
    newShape('path', { closed: true, nodes: [
      { p: [-30 * u, 22 * u] }, { p: [-24 * u, -12 * u], i: [0, 12 * u], o: [0, -26 * u] }, { p: [0, -36 * u], i: [-16 * u, 0], o: [16 * u, 0] },
      { p: [24 * u, -12 * u], i: [0, -26 * u], o: [0, 12 * u] }, { p: [30 * u, 22 * u] },
    ] }),
    newShape('ellipse', { pos: [0, 32 * u], size: [18 * u, 18 * u] }),
  ] });
  bell.tr.anchor = { v: [0, -36 * u] };
  bell.tr.position = { v: [c[0] - 235 * u, c[1] - 36 * u] };
  bell.tr.rotation = { v: 0, x: 'time > 2.1 ? Math.sin((time - 2.1) * 30) * 25 * Math.max(0, 1 - (time - 2.1) * 1.2) : 0' };
  bell.tr.opacity = K([0.3, 0], [0.5, 100]);
  // The click: a cursor arrow glides in and taps.
  const cursor = newLayer('shape', comp, { name: 'Cursor', fill: '#ffffff', stroke: '#111111', strokeWidth: 3 * u, position: [W * 0.8, H * 0.85], shapes: [
    newShape('path', { closed: true, nodes: [{ p: [0, 0] }, { p: [0, 64 * u] }, { p: [16 * u, 50 * u] }, { p: [28 * u, 76 * u] }, { p: [38 * u, 71 * u] }, { p: [26 * u, 46 * u] }, { p: [46 * u, 46 * u] }] }),
  ] });
  cursor.tr.position = K([0.8, [W * 0.82, H * 0.9]], [1.8, [c[0] + 150 * u, c[1] + 10 * u]], [2.6, [c[0] + 150 * u, c[1] + 10 * u]], [3.2, [W * 0.85, H * 0.95]]);
  cursor.tr.scale = K([1.85, [100, 100]], [1.95, [80, 80]], [2.1, [100, 100]]);
  cursor.tr.opacity = K([0.8, 0], [1.0, 100], [2.9, 100], [3.2, 0]);
  return [cursor, done, label, bell, btn];
}

function matteReveal(comp) {
  const W = comp.width; const H = comp.height; const u = H / 1080;
  const wipe = newLayer('shape', comp, { name: 'Wipe (matte)', fill: '#ffffff', position: [W / 2, H / 2], shapes: [newShape('rect', { size: [W, 260 * u] })] });
  wipe.tr.position = K([0, [-W / 2, H / 2]], [1.2, [W / 2, H / 2]]);
  const word = newLayer('text', comp, { name: 'Revealed text', value: 'REVEAL', size: 220 * u, position: [W / 2, H / 2 + 76 * u], weight: 900, font: 'Montserrat' });
  word.matte = { layer: wipe.id, mode: 'alpha' };
  const grad = newLayer('solid', comp, { name: 'Gradient BG', color: '#10102a' });
  grad.effects.push(newEffect('gradientRamp', comp));
  grad.effects[0].params.startColor = { v: '#1b1240' }; grad.effects[0].params.endColor = { v: '#05050a' };
  return [wipe, word, grad];
}

export const TEMPLATES = [
  { id: 'lowerThird', name: 'Lower third', desc: 'Name + title bar that slides in with a trim-path accent', build: lowerThird, icon: 'title' },
  { id: 'logoReveal', name: 'Logo reveal', desc: 'Trim-path rings, an overshooting logo mark with glow, tracked-in word', build: logoReveal, icon: 'starShape' },
  { id: 'kinetic', name: 'Kinetic typography', desc: 'Words slam in on the beat with scale, rotation and motion blur', build: kinetic, icon: 'text' },
  { id: 'subscribe', name: 'Subscribe button (Tsunami)', desc: 'Pop-in button, cursor click, colour change and a ringing bell', build: subscribe, icon: 'bell' },
  { id: 'matteReveal', name: 'Track matte reveal', desc: 'A wipe shape used as an alpha matte for big text', build: matteReveal, icon: 'mask' },
];
