// paper.js glue: Pathfinder (unite, subtract, intersect, exclude, divide), pencil smoothing, and SVG import.
import paper from 'paper';
import { worldSubpaths, uid, make, solid, strokeOf, linear, radial } from './model.js';
import { pathData, parsePathData, I } from './geom.js';

let scope = null;
function ps() {
  if (!scope) { scope = new paper.PaperScope(); scope.setup(new scope.Size(1, 1)); scope.settings.insertItems = false; }
  scope.activate();
  return scope;
}

/** Our subpaths → a paper CompoundPath. */
function toPaper(sps) {
  const P = ps();
  const cp = new P.CompoundPath({ insert: false });
  for (const sp of sps) {
    const path = new P.Path({ insert: false, closed: sp.closed });
    for (const p of sp.pts) path.add(new P.Segment(new P.Point(p.x, p.y), new P.Point(p.ix - p.x, p.iy - p.y), new P.Point(p.ox - p.x, p.oy - p.y)));
    cp.addChild(path);
  }
  return cp;
}
/** A paper path item → our subpaths. */
function fromPaper(item) {
  const paths = item.className === 'CompoundPath' ? item.children : item.className === 'Path' ? [item] : [];
  return paths.filter((p) => p.segments.length).map((p) => ({
    closed: p.closed,
    pts: p.segments.map((s) => ({ x: s.point.x, y: s.point.y, ix: s.point.x + s.handleIn.x, iy: s.point.y + s.handleIn.y, ox: s.point.x + s.handleOut.x, oy: s.point.y + s.handleOut.y })),
  }));
}

/**
 * Pathfinder on world-space nodes (bottom → top order). Returns new path nodes (one, or several for divide).
 * unite/intersect/exclude combine everything; subtract (Minus Front) removes the upper shapes from the bottom one.
 */
export function pathfinder(op, nodes) {
  const items = nodes.map((n) => ({ n, sps: worldSubpaths(n) })).filter((x) => x.sps);
  if (items.length < 2) throw new Error('Select two or more shapes or paths.');
  const P = items.map((x) => toPaper(x.sps));
  const style = (n) => ({ fill: n.fill, stroke: n.stroke, opacity: n.opacity, blend: n.blend, effects: n.effects });
  const bottom = items[0].n; const top = items[items.length - 1].n;
  let result;
  if (op === 'unite') result = P.slice(1).reduce((a, b) => a.unite(b, { insert: false }), P[0]);
  else if (op === 'intersect') result = P.slice(1).reduce((a, b) => a.intersect(b, { insert: false }), P[0]);
  else if (op === 'exclude') result = P.slice(1).reduce((a, b) => a.exclude(b, { insert: false }), P[0]);
  else if (op === 'subtract') { const front = P.slice(2).reduce((a, b) => a.unite(b, { insert: false }), P[1]); result = P[0].subtract(front, { insert: false }); }
  else if (op === 'divide') {
    // Every region where the shapes overlap or not becomes its own piece, keeping the colour of the shape on top there.
    let pieces = [{ item: P[0], n: items[0].n }];
    for (let i = 1; i < P.length; i++) {
      const next = [];
      let rest = P[i];
      for (const pc of pieces) {
        const inter = pc.item.intersect(P[i], { insert: false });
        const outside = pc.item.subtract(P[i], { insert: false });
        if (!inter.isEmpty()) next.push({ item: inter, n: items[i].n });
        if (!outside.isEmpty()) next.push({ item: outside, n: pc.n });
        rest = rest.subtract(pc.item, { insert: false });
      }
      if (!rest.isEmpty()) next.push({ item: rest, n: items[i].n });
      pieces = next;
    }
    const out = [];
    for (const pc of pieces) {
      const parts = pc.item.className === 'CompoundPath' ? pc.item.children.filter((c) => c.clockwise === pc.item.children[0].clockwise || true) : [pc.item];
      void parts;
      const sps = fromPaper(pc.item);
      if (sps.length) out.push(make.path({ subpaths: sps, ...style(pc.n), fillRule: 'nonzero', name: 'Piece' }));
    }
    return out;
  } else throw new Error(`Unknown operation ${op}`);
  const sps = fromPaper(result);
  if (!sps.length) return [];
  const src = op === 'subtract' ? bottom : top;
  return [make.path({ subpaths: sps, ...style(src), fillRule: 'nonzero', name: { unite: 'Union', intersect: 'Intersection', exclude: 'Exclusion', subtract: 'Subtraction' }[op] })];
}

/** Freehand points → a smooth open (or closed) path. */
export function smoothPoints(points, tolerance = 2.5, closed = false) {
  const P = ps();
  const path = new P.Path({ insert: false });
  for (const p of points) path.add(new P.Point(p.x, p.y));
  if (closed) path.closed = true;
  if (points.length > 2) path.simplify(tolerance);
  return fromPaper(path);
}

/** Smooths / simplifies an existing path node (Object → Path → Simplify). */
export function simplifySubpaths(sps, tolerance = 2.5) {
  const cp = toPaper(sps);
  for (const c of cp.children) c.simplify(tolerance);
  return fromPaper(cp);
}

// ---------------------------------------------------------------- SVG import

function colorOf(c, opacity = 1) {
  if (!c) return null;
  const toHex = (col) => {
    const a = Math.round((col.alpha ?? 1) * opacity * 255);
    const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(col.red)}${h(col.green)}${h(col.blue)}${a < 255 ? a.toString(16).padStart(2, '0') : ''}`;
  };
  if (c.gradient) {
    const stops = c.gradient.stops.map((s) => ({ o: s.offset ?? 0, color: toHex(s.color) }));
    if (c.gradient.radial) return { ...radial(), stops };
    const ang = Math.round((Math.atan2(c.destination.y - c.origin.y, c.destination.x - c.origin.x) * 180) / Math.PI);
    return { ...linear(ang), stops };
  }
  return solid(toHex(c));
}

/** Parses SVG markup into nodes (world space). Shapes become paths; text stays text where possible. */
export function importSvg(svgText) {
  const P = ps();
  const item = P.project.importSVG(svgText, { expandShapes: true, insert: false, applyMatrix: true });
  if (!item) throw new Error('That doesn’t look like an SVG.');
  const conv = (it) => {
    if (!it.visible) return null;
    const name = it.name || '';
    const common = { opacity: it.opacity ?? 1, blend: it.blendMode && it.blendMode !== 'normal' ? it.blendMode : 'normal' };
    if (it.className === 'Group' || it.className === 'Layer') {
      const kids = it.children.map(conv).filter(Boolean);
      if (it.clipped && kids.length > 1) { const [mask, ...rest] = kids; return { ...make.group([...rest, { ...mask, fill: null, stroke: null }], { name: name || 'Clip group', clip: true }), ...common }; }
      if (!kids.length) return null;
      if (kids.length === 1 && !name) return kids[0];
      return { ...make.group(kids, { name }), ...common };
    }
    if (it.className === 'Path' || it.className === 'CompoundPath') {
      const sps = fromPaper(it);
      if (!sps.length) return null;
      const st = it.strokeColor && it.strokeWidth > 0 ? strokeOf(colorOf(it.strokeColor)?.color || '#000000', it.strokeWidth, { cap: it.strokeCap || 'butt', join: it.strokeJoin || 'miter', dash: it.dashArray || [] }) : null;
      return { ...make.path({ subpaths: sps, name, fill: it.fillColor ? colorOf(it.fillColor) : null, stroke: st, fillRule: it.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' }), ...common };
    }
    if (it.className === 'PointText') {
      const m = it.matrix; const size = it.fontSize || 16;
      const n = make.text({ text: it.content, name, font: { family: String(it.fontFamily || 'Inter').split(',')[0].replace(/['"]/g, '').trim(), weight: parseInt(it.fontWeight, 10) || (it.fontWeight === 'bold' ? 700 : 400), size } });
      // PointText's origin is the baseline; ours is the top of the line box.
      n.t = [m.a, m.b, m.c, m.d, m.tx + m.c * -size * 0.95, m.ty + m.d * -size * 0.95];
      n.fill = it.fillColor ? colorOf(it.fillColor) : null;
      return { ...n, ...common };
    }
    if (it.className === 'Raster' && it.source?.startsWith?.('data:')) {
      // Embedded bitmaps are kept as a data URL in a pending image; the editor uploads them as assets.
      const b = it.bounds;
      return { ...make.image({ x: b.x, y: b.y, w: b.width, h: b.height, asset: null }), pendingSrc: it.source, fit: 'stretch', name: name || 'Image', ...common };
    }
    if (it.className === 'Shape') return conv(it.toPath(false));
    return null;
  };
  const out = conv(item);
  if (!out) return [];
  return out.type === 'group' && !out.clip && !out.name ? out.children : [out];
}

export const dToSubpaths = parsePathData;
export { pathData, I, uid };
