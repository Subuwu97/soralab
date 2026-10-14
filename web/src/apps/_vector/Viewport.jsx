// The vector canvas: renders the document as SVG, and runs every pointer tool (selection with scale/rotate handles,
// direct selection of anchors and handles, pen, pencil, shapes, text, eyedropper, hand, zoom, artboards, rotate/scale/
// reflect), smart guides and snapping, rulers and guides, the grid, and in-place text editing.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useKeyHeld } from '../../lib/shortcuts.js';
import { promptDialog } from '../../components/ui.jsx';
import { I, mul, inv, apply, translate, rotate, scale, matStr, pathData, mapSubpaths, localSubpaths, normRect, intersects, splitSeg, nearestOnSeg, segments, unionRects, decompose, isIdentity } from './geom.js';
import { find, findNode, updateIn, updateMany, bounds, localBox, toPathNode, make, uid, rootOf, artboardsOf, walk, transformNode, solid } from './model.js';
import { renderNode, renderContext } from './render.js';
import { layoutText, fontOf, leadingOf, cssFont, onFontsChanged } from './text.js';
import { smoothPoints } from './paperops.js';

const HANDLE = 7;
const ACCENT = '#30a2ff';
const GUIDE = '#00c8ff';
const SMART = '#ff3eb5';

/** Box (local w×h through matrix m) around the selection: oriented for one rotated object, axis-aligned otherwise. */
function selectionBox(ed) {
  const ns = ed.selNodes;
  if (!ns.length) return null;
  if (ns.length === 1 && !['group', 'artboard', 'path'].includes(ns[0].type) && ns[0].t && !isIdentity(ns[0].t)) {
    const d = decompose(ns[0].t);
    if (Math.abs(d.rotation) > 0.01 || d.sy < 0 || d.sx < 0 || Math.abs(d.skew) > 1e-6) {
      const lb = localBox(ns[0], ed.doc);
      return { m: mul(ns[0].t, translate(lb.x, lb.y)), w: lb.w, h: lb.h };
    }
  }
  const b = ed.selBounds;
  return b ? { m: translate(b.x, b.y), w: b.w, h: b.h } : null;
}
const HANDLES = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const TOOL_CURSOR = { hand: 'grab', zoom: 'zoom-in', pen: 'crosshair', pencil: 'crosshair', rect: 'crosshair', ellipse: 'crosshair', polygon: 'crosshair', star: 'crosshair', line: 'crosshair', text: 'text', eyedropper: 'copy', artboard: 'crosshair', rotate: 'crosshair', scale: 'crosshair', reflect: 'crosshair', convert: 'default', addAnchor: 'crosshair', deleteAnchor: 'crosshair' };

/** World outline (path data) of a node for hover/selection highlights. */
function outlineOf(n, doc) {
  if (n.type === 'group' || n.type === 'artboard') return null;
  const sps = localSubpaths(n);
  if (sps && n.type !== 'image') return pathData(mapSubpaths(sps, n.t || I));
  const lb = localBox(n, doc);
  const c = [[lb.x, lb.y], [lb.x + lb.w, lb.y], [lb.x + lb.w, lb.y + lb.h], [lb.x, lb.y + lb.h]].map(([x, y]) => apply(n.t || I, x, y));
  return `M${c.map((p) => `${p.x} ${p.y}`).join('L')}Z`;
}

/** Anchors of a path-like node in world space (shapes give their would-be path anchors). */
const anchorSubpaths = (n) => { const sps = localSubpaths(n); return sps && n.type !== 'image' ? mapSubpaths(sps, n.t || I) : null; };

export default function Viewport({ ed, mode = 'design', overlay, onWire, onEditInstance, onDoubleClickArtboard, artboardLabel, showLabels = true, className }) {
  const wrap = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const { view, setView, doc, scope, tool, opts } = ed;
  const viewRef = useRef(view); viewRef.current = view;
  const edRef = useRef(ed); edRef.current = ed;
  const space = useKeyHeld('space');
  const [drag, setDrag] = useState(null); // live drag state for overlays (marquee, guides, previews)
  const dragRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [cursorPt, setCursorPt] = useState(null);
  const pen = useRef(null); // { id, si } while drawing with the pen
  const [penOn, setPenOn] = useState(false);
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => onFontsChanged(() => setFontTick((t) => t + 1)), []);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const toWorld = useCallback((e) => {
    const r = wrap.current.getBoundingClientRect(); const v = viewRef.current;
    return { x: (e.clientX - r.left - v.x) / v.zoom, y: (e.clientY - r.top - v.y) / v.zoom };
  }, []);
  const S = (p) => ({ x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y });

  // ---------------------------------------------------------------- fitting and zooming

  const fitRect = useCallback((r, pad = 60) => {
    if (!r || !wrap.current) return;
    const W = wrap.current.clientWidth; const H = wrap.current.clientHeight;
    const z = Math.max(0.02, Math.min(16, Math.min((W - pad * 2) / Math.max(1, r.w), (H - pad * 2) / Math.max(1, r.h))));
    setView({ zoom: z, x: W / 2 - (r.x + r.w / 2) * z, y: H / 2 - (r.y + r.h / 2) * z, fitted: true });
  }, [setView]);
  const contentRect = useCallback(() => {
    const e = edRef.current; const d = e.get();
    if (!d) return null;
    if (e.scope) return unionRects(rootOf(d, e.scope).map((n) => bounds(n, d))) || { x: -100, y: -100, w: 200, h: 200 };
    const ab = artboardsOf(d).find((a) => a.id === e.activeAb);
    return ab ? { x: ab.x, y: ab.y, w: ab.w, h: ab.h } : unionRects(d.children.map((n) => bounds(n, d)));
  }, []);
  const zoomAt = useCallback((z, sx, sy) => {
    const v = viewRef.current;
    const nz = Math.max(0.02, Math.min(64, z));
    const W = wrap.current?.clientWidth || 800; const H = wrap.current?.clientHeight || 600;
    const px = sx ?? W / 2; const py = sy ?? H / 2;
    const wx = (px - v.x) / v.zoom; const wy = (py - v.y) / v.zoom;
    setView({ ...v, zoom: nz, x: px - wx * nz, y: py - wy * nz });
  }, [setView]);

  useEffect(() => {
    ed.viewportRef.current = {
      center: () => { const v = viewRef.current; const W = wrap.current?.clientWidth || 800; const H = wrap.current?.clientHeight || 600; return { x: (W / 2 - v.x) / v.zoom, y: (H / 2 - v.y) / v.zoom }; },
      visibleWorld: () => { const v = viewRef.current; return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: (wrap.current?.clientWidth || 800) / v.zoom, h: (wrap.current?.clientHeight || 600) / v.zoom }; },
      fit: () => fitRect(contentRect()),
      fitAll: () => { const d = edRef.current.get(); fitRect(unionRects(d.children.map((n) => bounds(n, d)))); },
      fitSoon: () => setTimeout(() => fitRect(contentRect()), 0),
      fitRect, zoomAt,
      clientToWorld: (cx, cy) => { const r = wrap.current.getBoundingClientRect(); const v = viewRef.current; return { x: (cx - r.left - v.x) / v.zoom, y: (cy - r.top - v.y) / v.zoom }; },
      actual: () => { const c = edRef.current.viewportRef.current.center(); const W = wrap.current.clientWidth; const H = wrap.current.clientHeight; setView({ zoom: 1, x: W / 2 - c.x, y: H / 2 - c.y, fitted: true }); },
    };
  });
  // Fit the first time the document is ready.
  useEffect(() => { if (doc && !view.fitted && size.w > 50) fitRect(contentRect()); }, [doc, size.w]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel: pan, Ctrl/⌘ (or pinch) to zoom around the pointer. Needs a non-passive listener.
  useEffect(() => {
    const el = wrap.current;
    const wheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(viewRef.current.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
      else { const v = viewRef.current; setView({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }); }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomAt, setView]);

  // ---------------------------------------------------------------- the rendered document

  const cache = useRef(new WeakMap());
  useMemo(() => { cache.current = new WeakMap(); }, [fontTick, ed.editingText]); // eslint-disable-line react-hooks/exhaustive-deps
  const content = useMemo(() => {
    if (!doc) return '';
    const ctx = renderContext(doc, { ids: true, cache: cache.current, hide: ed.editingText ? new Set([ed.editingText]) : null });
    return rootOf(doc, scope).map((n) => renderNode(n, ctx)).join('');
  }, [doc, scope, fontTick, ed.editingText]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- snapping

  const snapTargets = useCallback((exclude = new Set()) => {
    const e = edRef.current; const d = e.get();
    const xs = []; const ys = [];
    const addBox = (b) => { xs.push(b.x, b.x + b.w / 2, b.x + b.w); ys.push(b.y, b.y + b.h / 2, b.y + b.h); };
    const r = rootOf(d, e.scope);
    for (const n of r) {
      if (n.type === 'artboard') { addBox(n); for (const c of n.children) if (!exclude.has(c.id) && !c.hidden) addBox(bounds(c, d)); }
      else if (!exclude.has(n.id) && !n.hidden) addBox(bounds(n, d));
    }
    if (e.opts.guides) { xs.push(...(d.guides?.x || [])); ys.push(...(d.guides?.y || [])); }
    return { xs, ys };
  }, []);
  /** Snaps a moving box: returns the correction and the guide lines to draw. */
  const snapBox = useCallback((b, T) => {
    const e = edRef.current; const tol = 6 / viewRef.current.zoom;
    let dx = 0; let dy = 0; const lines = [];
    if (e.opts.smart && T) {
      let best = tol; let bx = null;
      for (const c of [b.x, b.x + b.w / 2, b.x + b.w]) for (const v of T.xs) { const dd = Math.abs(v - c); if (dd < best) { best = dd; bx = v - c; } }
      if (bx !== null) { dx = bx; for (const c of [b.x, b.x + b.w / 2, b.x + b.w]) if (T.xs.some((v) => Math.abs(v - (c + dx)) < 0.01)) lines.push({ x: c + dx }); }
      best = tol; let by = null;
      for (const c of [b.y, b.y + b.h / 2, b.y + b.h]) for (const v of T.ys) { const dd = Math.abs(v - c); if (dd < best) { best = dd; by = v - c; } }
      if (by !== null) { dy = by; for (const c of [b.y, b.y + b.h / 2, b.y + b.h]) if (T.ys.some((v) => Math.abs(v - (c + dy)) < 0.01)) lines.push({ y: c + dy }); }
    }
    if (e.opts.snapGrid) {
      const g = e.opts.gridSize || 10;
      if (!lines.some((l) => l.x !== undefined)) dx = Math.round(b.x / g) * g - b.x;
      if (!lines.some((l) => l.y !== undefined)) dy = Math.round(b.y / g) * g - b.y;
    }
    return { dx, dy, lines };
  }, []);
  const snapPt = useCallback((p, T) => { const s = snapBox({ x: p.x, y: p.y, w: 0, h: 0 }, T); return { x: p.x + s.dx, y: p.y + s.dy, lines: s.lines }; }, [snapBox]);

  // ---------------------------------------------------------------- pointer tools

  const startDrag = (state) => { dragRef.current = state; setDrag(state); };
  const effectiveTool = () => (space.current ? 'hand' : mode === 'prototype' ? 'proto' : tool);

  const hitId = (e) => e.target.closest?.('[data-id]')?.getAttribute('data-id') || null;
  const finishPen = () => { if (pen.current) { pen.current = null; setPenOn(false); ed.h.commit(); } };
  useEffect(() => { if (tool !== 'pen') finishPen(); }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e) => { if ((e.key === 'Enter' || e.key === 'Escape') && pen.current) { e.preventDefault(); finishPen(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Inserts a new shape for drawing tools, styled with the current defaults. */
  const newShape = (kind, p) => {
    const st = ed.style;
    const common = { fill: kind === 'line' ? null : st.fill, stroke: kind === 'line' ? (st.stroke?.color ? st.stroke : { color: '#000000', width: 2, cap: 'butt', join: 'miter', dash: [], align: 'center' }) : st.stroke };
    if (kind === 'line') return make.line({ x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...common, name: 'Line' });
    const n = make[kind]({ x: p.x, y: p.y, w: 0, h: 0, ...(kind === 'rect' && st.radius ? { r: st.radius } : {}), ...common });
    n.name = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star' }[kind];
    return n;
  };

  const onPointerDown = (e) => {
    if (e.button === 2) return;
    if (ed.editingText && !e.target.closest('textarea')) { ed.setEditingText(null); }
    const t = e.button === 1 ? 'hand' : effectiveTool();
    const p = toWorld(e);
    const d = ed.get();
    if (!d) return;
    wrap.current.setPointerCapture?.(e.pointerId);
    const ro = ed.readOnly;
    const target = e.target;

    // Ruler guides can be dragged with any tool.
    if (target.dataset.guide && !ro) { startDrag({ kind: 'guide', axis: target.dataset.guide, index: Number(target.dataset.gi), p }); return; }

    if (t === 'hand') { startDrag({ kind: 'pan', sx: e.clientX, sy: e.clientY, v: viewRef.current }); return; }
    if (t === 'zoom') { startDrag({ kind: 'zoomrect', p0: p, p, out: e.altKey }); return; }

    // Prototype mode: drag the wire handle to an artboard, click to select.
    if (t === 'proto') {
      if (target.dataset.wire) { startDrag({ kind: 'wire', from: target.dataset.wire, p0: p, p }); return; }
      const lbl = target.closest('[data-ablabel]')?.getAttribute('data-ablabel');
      if (lbl) { ed.setSel([]); ed.setActiveAb(lbl); return; }
      const id = hitId(e);
      const s = id ? ed.selectable(id) : null;
      ed.setSel(s ? [s.id] : []);
      if (!s) { const ab = ed.artboardAt(p.x, p.y); if (ab) ed.setActiveAb(ab.id); }
      return;
    }

    // Artboard labels: select (and move) the artboard.
    const label = target.closest('[data-ablabel]')?.getAttribute('data-ablabel');
    if (label && (t === 'select' || t === 'artboard' || t === 'direct')) {
      ed.setSel([]); ed.setActiveAb(label);
      const ab = d.children.find((n) => n.id === label);
      if (!ro) startDrag({ kind: 'abmove', id: label, p0: p, orig: ab, T: snapTargets(new Set(ab.children.map((c) => c.id))) });
      return;
    }

    if (t === 'artboard') {
      const h = target.dataset.abh;
      if (h && !ro) { const ab = d.children.find((n) => n.id === ed.activeAb); startDrag({ kind: 'abresize', h, id: ab.id, orig: ab, p0: p }); return; }
      const abId = target.closest('[data-abbg]')?.getAttribute('data-abbg') || ed.artboardAt(p.x, p.y)?.id;
      if (abId) {
        ed.setActiveAb(abId); ed.setSel([]);
        const ab = d.children.find((n) => n.id === abId);
        if (!ro) startDrag({ kind: 'abmove', id: abId, p0: p, orig: ab, T: snapTargets(new Set(ab.children.map((c) => c.id))), dup: e.altKey });
      } else if (!ro) startDrag({ kind: 'abnew', p0: p, p });
      return;
    }

    if (t === 'select' || t === 'direct' || ro) {
      // Selection handles: scale / rotate.
      const h = target.dataset.h;
      if (h && !ro && t === 'select') {
        const box = selectionBox(ed);
        const orig = new Map(ed.selNodes.map((n) => [n.id, n]));
        if (h === 'rot') {
          const c = apply(box.m, box.w / 2, box.h / 2);
          startDrag({ kind: 'rotate', c, a0: Math.atan2(p.y - c.y, p.x - c.x), orig, ids: [...orig.keys()], key: uid() });
        } else startDrag({ kind: 'scale', h, box, orig, ids: [...orig.keys()], key: uid(), T: snapTargets(new Set(orig.keys())) });
        return;
      }
      // Direct selection: anchors and handles.
      if (t === 'direct' && !ro) {
        const hp = target.dataset.hp;
        if (hp) { const [id, si, pi, which] = hp.split(':'); startDrag({ kind: 'handle', id, si: +si, pi: +pi, which, orig: findNode(ed.root, id), key: uid(), alt: e.altKey }); return; }
        const an = target.dataset.anchor;
        if (an) {
          let keys = ed.anchors;
          if (e.shiftKey) keys = keys.includes(an) ? keys.filter((k) => k !== an) : [...keys, an];
          else if (!keys.includes(an)) keys = [an];
          ed.setAnchors(keys);
          const ids = [...new Set(keys.map((k) => k.split(':')[0]))];
          startDrag({ kind: 'anchors', keys, p0: p, orig: new Map(ids.map((id) => [id, findNode(ed.root, id)])), key: uid() });
          return;
        }
      }
      const id = hitId(e);
      let node = null;
      if (id) {
        if (t === 'direct') { const f = find(ed.root, id); node = f && !f.chain.some((c) => c.locked) ? f.node : null; }
        else node = ed.selectable(id);
        if (node?.locked) node = null;
      }
      if (node) {
        let ids = ed.sel;
        if (e.shiftKey) ids = ids.includes(node.id) ? ids.filter((x) => x !== node.id) : [...ids, node.id];
        else if (!ids.includes(node.id)) ids = [node.id];
        ed.setSel(ids);
        if (ro || !ids.includes(node.id)) return;
        const orig = new Map(ids.map((x) => [x, findNode(ed.root, x)]).filter(([, n]) => n));
        startDrag({ kind: 'move', p0: p, orig, ids: [...orig.keys()], dup: e.altKey, key: uid(), T: snapTargets(new Set(orig.keys())), box: unionRects([...orig.values()].map((n) => bounds(n, d))) });
        return;
      }
      if (!e.shiftKey) { ed.setSel([]); if (t === 'select' && ed.groupScope) ed.setGroupScope(null); }
      const ab = ed.artboardAt(p.x, p.y); if (ab && !ed.scope) ed.setActiveAb(ab.id);
      startDrag({ kind: 'marquee', p0: p, p, add: e.shiftKey, direct: t === 'direct' });
      return;
    }

    if (t === 'eyedropper') {
      const id = hitId(e);
      const src = id ? findNode(ed.root, id) : null;
      if (!src) return;
      const st = { fill: src.fill ?? null, stroke: src.stroke ?? null };
      if (ed.sel.length) {
        ed.setProps((n) => ({ ...(n.type === 'image' ? {} : { fill: st.fill }), stroke: st.stroke, ...(n.type === 'text' && src.type === 'text' ? { font: { ...src.font } } : {}), opacity: src.opacity ?? 1 }), 'Eyedropper');
      }
      ed.setStyle((s) => ({ ...s, ...st }));
      return;
    }

    if (t === 'rotate' || t === 'scale' || t === 'reflect') {
      if (!ed.selNodes.length) return;
      const b = ed.selBounds; const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      if (t === 'reflect') { ed.reflectSel(e.altKey ? 'v' : 'h'); return; }
      const orig = new Map(ed.selNodes.map((n) => [n.id, n]));
      startDrag({ kind: t === 'rotate' ? 'rotate' : 'scaletool', c, a0: Math.atan2(p.y - c.y, p.x - c.x), d0: Math.max(1, Math.hypot(p.x - c.x, p.y - c.y)), orig, ids: [...orig.keys()], key: uid(), dup: e.altKey });
      return;
    }

    if (['rect', 'ellipse', 'polygon', 'star', 'line'].includes(t)) {
      const T = snapTargets();
      const p0 = snapPt(p, T);
      const n = newShape(t, p0);
      startDrag({ kind: 'draw', shape: t, id: n.id, p0, T, key: uid(), node: n, started: false });
      return;
    }

    if (t === 'pencil') { startDrag({ kind: 'pencil', pts: [p] }); return; }

    if (t === 'text') {
      const id = hitId(e);
      const hit = id ? findNode(ed.root, id) : null;
      if (hit?.type === 'text') { ed.setSel([hit.id]); ed.setEditingText(hit.id); e.preventDefault(); return; }
      startDrag({ kind: 'textbox', p0: p, p });
      return;
    }

    if (t === 'pen' || t === 'convert' || t === 'addAnchor' || t === 'deleteAnchor') { penDown(e, p, t); }
  };

  /** Pen tool: add anchors (drag for curves), close, continue, add/delete/convert anchors. */
  const penDown = (e, p, t) => {
    const an = e.target.dataset.anchor;
    const tol = 8 / view.zoom;
    if (pen.current) {
      const n = findNode(ed.root, pen.current.id);
      if (!n) { pen.current = null; setPenOn(false); return; }
      const sp = n.subpaths[pen.current.si];
      const first = sp.pts[0];
      if (sp.pts.length > 1 && Math.hypot(first.x - p.x, first.y - p.y) < tol) {
        ed.updateNode(n.id, (x) => ({ ...x, subpaths: x.subpaths.map((s, i) => (i === pen.current.si ? { ...s, closed: true } : s)) }), 'Close Path');
        startDrag({ kind: 'pendrag', id: n.id, si: pen.current.si, pi: 0, p0: first, key: uid(), closing: true });
        pen.current = null; setPenOn(false);
        return;
      }
      let q = p;
      const last = sp.pts[sp.pts.length - 1];
      if (e.shiftKey) { const a = Math.round(Math.atan2(p.y - last.y, p.x - last.x) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(p.x - last.x, p.y - last.y); q = { x: last.x + Math.cos(a) * len, y: last.y + Math.sin(a) * len }; }
      ed.updateNode(n.id, (x) => ({ ...x, subpaths: x.subpaths.map((s, i) => (i === pen.current.si ? { ...s, pts: [...s.pts, { x: q.x, y: q.y, ix: q.x, iy: q.y, ox: q.x, oy: q.y }] } : s)) }), 'Add Anchor');
      startDrag({ kind: 'pendrag', id: n.id, si: pen.current.si, pi: sp.pts.length, p0: q, key: uid() });
      return;
    }
    // Not drawing: anchor operations on selected paths.
    if (an) {
      const [id, siS, piS] = an.split(':'); const si = +siS; const pi = +piS;
      let node = findNode(ed.root, id);
      if (!node) return;
      if (node.type !== 'path') { node = toPathNode(node); ed.updateNode(id, () => node, 'Convert to Path'); }
      const sp = node.subpaths[si];
      if (t === 'convert' || e.altKey) {
        const P = sp.pts[pi];
        const smooth = P.ix !== P.x || P.iy !== P.y || P.ox !== P.x || P.oy !== P.y;
        if (smooth) ed.updateNode(id, (x) => ({ ...x, subpaths: x.subpaths.map((s, i) => (i === si ? { ...s, pts: s.pts.map((q, j) => (j === pi ? { ...q, ix: q.x, iy: q.y, ox: q.x, oy: q.y } : q)) } : s)) }), 'Convert Anchor');
        startDrag({ kind: 'pendrag', id, si, pi, p0: { x: P.x, y: P.y }, key: uid() });
        return;
      }
      const isEnd = !sp.closed && (pi === 0 || pi === sp.pts.length - 1);
      if (isEnd && t === 'pen') {
        // Continue an open path from this end.
        if (pi === 0) ed.updateNode(id, (x) => ({ ...x, subpaths: x.subpaths.map((s, i) => (i === si ? { ...s, pts: s.pts.slice().reverse().map((q) => ({ ...q, ix: q.ox, iy: q.oy, ox: q.ix, oy: q.iy })) } : s)) }), 'Continue Path');
        pen.current = { id, si }; setPenOn(true); ed.setSel([id]);
        return;
      }
      // Delete anchor.
      if (t === 'pen' || t === 'deleteAnchor') {
        ed.updateNode(id, (x) => {
          const sps = x.subpaths.map((s, i) => (i === si ? { ...s, pts: s.pts.filter((_, j) => j !== pi) } : s)).filter((s) => s.pts.length > (s.closed ? 2 : 1));
          return sps.length ? { ...x, subpaths: sps } : null;
        }, 'Delete Anchor');
        return;
      }
    }
    // Add an anchor on a selected path's segment.
    if (t === 'pen' || t === 'addAnchor') {
      for (const n of ed.selNodes) {
        const sps = anchorSubpaths(n);
        if (!sps) continue;
        for (let si = 0; si < sps.length; si++) {
          const segs = segments(sps[si]);
          for (let k = 0; k < segs.length; k++) {
            const near = nearestOnSeg(segs[k], p.x, p.y);
            if (near.dist < tol && near.t > 0.01 && near.t < 0.99) {
              const [L, R] = splitSeg(segs[k], near.t);
              ed.updateNode(n.id, (x) => {
                const px = x.type === 'path' ? x : toPathNode(x);
                return { ...px, subpaths: px.subpaths.map((s, i) => {
                  if (i !== si) return s;
                  const pts = s.pts.slice(); const nxt = (k + 1) % pts.length;
                  pts[k] = { ...pts[k], ox: L[1].x, oy: L[1].y };
                  pts[nxt] = { ...pts[nxt], ix: R[2].x, iy: R[2].y };
                  pts.splice(k + 1, 0, { x: L[3].x, y: L[3].y, ix: L[2].x, iy: L[2].y, ox: R[1].x, oy: R[1].y });
                  return { ...s, pts };
                }) };
              }, 'Add Anchor');
              return;
            }
          }
        }
      }
      if (t === 'addAnchor') return;
    }
    if (t !== 'pen') return;
    // Start a new path.
    const st = ed.style;
    const n = make.path({ subpaths: [{ closed: false, pts: [{ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y }] }], fill: null, stroke: st.stroke?.color ? st.stroke : { color: '#000000', width: 2, cap: 'butt', join: 'miter', dash: [], align: 'center' }, name: 'Path' });
    ed.addNodes([n], 'Pen');
    pen.current = { id: n.id, si: 0 }; setPenOn(true);
    startDrag({ kind: 'pendrag', id: n.id, si: 0, pi: 0, p0: p, key: uid() });
  };

  const onPointerMove = (e) => {
    const p = toWorld(e);
    const dg = dragRef.current;
    if (!dg) {
      if (pen.current) setCursorPt(p);
      const id = e.target.closest?.('[data-id]')?.getAttribute('data-id');
      const s = id && (tool === 'select' || mode === 'prototype') ? ed.selectable(id)?.id : id && tool === 'direct' ? id : null;
      if (s !== hover) setHover(s);
      return;
    }
    const e2 = ed;
    switch (dg.kind) {
      case 'pan': setView({ ...dg.v, x: dg.v.x + e.clientX - dg.sx, y: dg.v.y + e.clientY - dg.sy }); break;
      case 'zoomrect': case 'marquee': case 'abnew': case 'textbox': case 'wire': startDrag({ ...dg, p }); break;
      case 'guide': startDrag({ ...dg, p }); break;
      case 'move': {
        let dx = p.x - dg.p0.x; let dy = p.y - dg.p0.y;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (!dg.moved && Math.hypot(dx, dy) * viewRef.current.zoom < 3) return;
        const sn = snapBox({ ...dg.box, x: dg.box.x + dx, y: dg.box.y + dy }, dg.T);
        dx += e.shiftKey && !dx ? 0 : sn.dx; dy += e.shiftKey && !dy ? 0 : sn.dy;
        let ids = dg.ids; let orig = dg.orig;
        if (dg.dup && !dg.copied) {
          // Alt-drag: leave the originals, drag copies.
          const copies = new Map();
          let nr = rootOf(e2.get(), e2.scope);
          for (const id of dg.ids) {
            const f = find(nr, id); if (!f) continue;
            const c = { ...structuredClone(f.node), id: uid() };
            if (c.children) walk(c.children, (x) => { x.id = uid(); });
            copies.set(c.id, c);
            nr = updateIn(nr, id, (o) => [o, c]);
          }
          e2.change(() => nr, 'Copy', { merge: dg.key });
          ids = [...copies.keys()]; orig = copies;
          e2.setSel(ids);
          dragRef.current = { ...dg, ids, orig, copied: true };
        }
        e2.change((r) => updateMany(r, ids, (n) => transformNode(orig.get(n.id), translate(dx, dy))), dg.dup ? 'Copy' : 'Move', { merge: dg.key });
        const nd = { ...dragRef.current, moved: true, dx, dy, lines: sn.lines };
        dragRef.current = nd; setDrag(nd);
        break;
      }
      case 'scale': {
        const { box, h } = dg;
        const im = inv(box.m);
        const sn = snapPt(p, dg.T);
        const lp = apply(im, sn.x, sn.y);
        const [hx, hy] = HANDLES[h];
        const ax = e.altKey ? 0.5 : 1 - hx; const ay = e.altKey ? 0.5 : 1 - hy;
        let sx = hx === 0.5 ? 1 : (lp.x - ax * box.w) / ((hx - ax) * box.w || 1);
        let sy = hy === 0.5 ? 1 : (lp.y - ay * box.h) / ((hy - ay) * box.h || 1);
        if (box.w < 1e-6) sx = 1; if (box.h < 1e-6) sy = 1;
        // Shift keeps proportions (Express/Proto images always do from corners).
        const keep = e.shiftKey !== (ed.app !== 'vector' && hx !== 0.5 && hy !== 0.5 && [...dg.orig.values()].some((n) => n.type === 'image' || n.type === 'text'));
        if (keep) { if (hx === 0.5) sx = Math.abs(sy); else if (hy === 0.5) sy = Math.abs(sx); else { const s = Math.max(Math.abs(sx), Math.abs(sy)); sx = s * Math.sign(sx || 1); sy = s * Math.sign(sy || 1); } }
        const M = mul(box.m, mul(scale(sx, sy, ax * box.w, ay * box.h), im));
        e2.change((r) => updateMany(r, dg.ids, (n) => transformNode(dg.orig.get(n.id), M)), 'Scale', { merge: dg.key });
        const nd = { ...dg, lines: sn.lines, sx, sy }; dragRef.current = nd; setDrag(nd);
        break;
      }
      case 'rotate': {
        let a = Math.atan2(p.y - dg.c.y, p.x - dg.c.x) - dg.a0;
        let deg = (a * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 45) * 45;
        a = deg;
        const M = rotate(a, dg.c.x, dg.c.y);
        e2.change((r) => updateMany(r, dg.ids, (n) => transformNode(dg.orig.get(n.id), M)), 'Rotate', { merge: dg.key });
        const nd = { ...dg, deg }; dragRef.current = nd; setDrag(nd);
        break;
      }
      case 'scaletool': {
        let s = Math.hypot(p.x - dg.c.x, p.y - dg.c.y) / dg.d0;
        let sx = s; let sy = s;
        if (!e.shiftKey) { sx = Math.abs(p.x - dg.c.x) / Math.max(1, Math.abs(dg.d0 * Math.cos(dg.a0))); sy = Math.abs(p.y - dg.c.y) / Math.max(1, Math.abs(dg.d0 * Math.sin(dg.a0))); if (!Number.isFinite(sx)) sx = 1; if (!Number.isFinite(sy)) sy = 1; s = 1; }
        const M = scale(sx, sy, dg.c.x, dg.c.y);
        e2.change((r) => updateMany(r, dg.ids, (n) => transformNode(dg.orig.get(n.id), M)), 'Scale', { merge: dg.key });
        dragRef.current = { ...dg, sx, sy };
        break;
      }
      case 'draw': {
        const sn = snapPt(p, dg.T);
        let x1 = sn.x; let y1 = sn.y; const { x: x0, y: y0 } = dg.p0;
        if (dg.shape === 'line') {
          if (e.shiftKey) { const a = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(x1 - x0, y1 - y0); x1 = x0 + Math.cos(a) * len; y1 = y0 + Math.sin(a) * len; }
          const node = make.line({ x1: x0, y1: y0, x2: x1, y2: y1 });
          const n = { ...dg.node, subpaths: node.subpaths };
          if (!dg.started) e2.addNodes([n], 'Line'); else e2.updateNode(dg.id, () => n, 'Line', { merge: dg.key });
          dragRef.current = { ...dg, started: true, lines: sn.lines }; setDrag(dragRef.current);
          break;
        }
        let w = x1 - x0; let h = y1 - y0;
        if (e.shiftKey) { const s = Math.max(Math.abs(w), Math.abs(h)); w = s * Math.sign(w || 1); h = s * Math.sign(h || 1); }
        let r = e.altKey ? { x: x0 - Math.abs(w), y: y0 - Math.abs(h), w: Math.abs(w) * 2, h: Math.abs(h) * 2 } : normRect(x0, y0, x0 + w, y0 + h);
        if (r.w < 0.5 && r.h < 0.5) r = { ...r, w: 0.5, h: 0.5 };
        const n = { ...dg.node, w: r.w, h: r.h, t: translate(r.x, r.y) };
        if (!dg.started) e2.addNodes([n], n.name); else e2.updateNode(dg.id, () => n, n.name, { merge: dg.key });
        dragRef.current = { ...dg, started: true, lines: sn.lines, r }; setDrag(dragRef.current);
        break;
      }
      case 'pencil': { const last = dg.pts[dg.pts.length - 1]; if (Math.hypot(p.x - last.x, p.y - last.y) * viewRef.current.zoom > 2) { const nd = { ...dg, pts: [...dg.pts, p] }; dragRef.current = nd; setDrag(nd); } break; }
      case 'pendrag': {
        let q = p;
        if (e.shiftKey) { const a = Math.round(Math.atan2(p.y - dg.p0.y, p.x - dg.p0.x) / (Math.PI / 4)) * (Math.PI / 4); const len = Math.hypot(p.x - dg.p0.x, p.y - dg.p0.y); q = { x: dg.p0.x + Math.cos(a) * len, y: dg.p0.y + Math.sin(a) * len }; }
        if (Math.hypot(q.x - dg.p0.x, q.y - dg.p0.y) * viewRef.current.zoom < 2) break;
        const mx = 2 * dg.p0.x - q.x; const my = 2 * dg.p0.y - q.y;
        e2.updateNode(dg.id, (x) => ({ ...x, subpaths: x.subpaths.map((s, i) => (i === dg.si ? { ...s, pts: s.pts.map((P, j) => (j === dg.pi ? (dg.closing ? { ...P, ix: mx, iy: my, ox: e.altKey ? P.ox : q.x, oy: e.altKey ? P.oy : q.y } : { ...P, ox: q.x, oy: q.y, ix: e.altKey ? P.ix : mx, iy: e.altKey ? P.iy : my }) : P)) } : s)) }), 'Curve', { merge: dg.key });
        break;
      }
      case 'anchors': {
        const dx = p.x - dg.p0.x; const dy = p.y - dg.p0.y;
        const byNode = new Map();
        for (const k of dg.keys) { const [id, si, pi] = k.split(':'); if (!byNode.has(id)) byNode.set(id, new Set()); byNode.get(id).add(`${si}:${pi}`); }
        e2.change((r) => updateMany(r, [...byNode.keys()], (n) => {
          const o = toPathNode(dg.orig.get(n.id));
          const set = byNode.get(n.id);
          return { ...o, subpaths: o.subpaths.map((s, si) => ({ ...s, pts: s.pts.map((P, pi) => (set.has(`${si}:${pi}`) ? { x: P.x + dx, y: P.y + dy, ix: P.ix + dx, iy: P.iy + dy, ox: P.ox + dx, oy: P.oy + dy } : P)) })) };
        }), 'Move Anchor', { merge: dg.key });
        break;
      }
      case 'handle': {
        const o = toPathNode(dg.orig);
        e2.change((r) => updateIn(r, dg.id, () => ({ ...o, subpaths: o.subpaths.map((s, si) => (si !== dg.si ? s : { ...s, pts: s.pts.map((P, pi) => {
          if (pi !== dg.pi) return P;
          const inH = dg.which === 'in';
          const q = { ...P, [inH ? 'ix' : 'ox']: p.x, [inH ? 'iy' : 'oy']: p.y };
          const ox = inH ? P.ox : P.ix; const oy = inH ? P.oy : P.iy;
          const hx = inH ? P.ix : P.ox; const hy = inH ? P.iy : P.oy;
          const oLen = Math.hypot(ox - P.x, oy - P.y);
          const cross = (hx - P.x) * (oy - P.y) - (hy - P.y) * (ox - P.x);
          const smooth = oLen > 1e-6 && Math.abs(cross) < 1e-3 * Math.max(1, oLen * Math.hypot(hx - P.x, hy - P.y));
          if (smooth && !e.altKey && !dg.alt) {
            const a = Math.atan2(p.y - P.y, p.x - P.x) + Math.PI;
            q[inH ? 'ox' : 'ix'] = P.x + Math.cos(a) * oLen; q[inH ? 'oy' : 'iy'] = P.y + Math.sin(a) * oLen;
          }
          return q;
        }) })) })), 'Move Handle', { merge: dg.key });
        break;
      }
      case 'abmove': {
        let dx = p.x - dg.p0.x; let dy = p.y - dg.p0.y;
        const sn = snapBox({ x: dg.orig.x + dx, y: dg.orig.y + dy, w: dg.orig.w, h: dg.orig.h }, dg.T);
        dx += sn.dx; dy += sn.dy;
        e2.updateArtboard(dg.id, () => ({ x: Math.round(dg.orig.x + dx), y: Math.round(dg.orig.y + dy) }), 'Move Artboard', { merge: dg.key || (dg.key = uid()) });
        const nd = { ...dg, lines: sn.lines }; dragRef.current = nd; setDrag(nd);
        break;
      }
      case 'abresize': {
        const o = dg.orig; const [hx, hy] = HANDLES[dg.h];
        let x0 = o.x; let y0 = o.y; let x1 = o.x + o.w; let y1 = o.y + o.h;
        if (hx === 0) x0 = Math.min(p.x, x1 - 1); if (hx === 1) x1 = Math.max(p.x, x0 + 1);
        if (hy === 0) y0 = Math.min(p.y, y1 - 1); if (hy === 1) y1 = Math.max(p.y, y0 + 1);
        // Resizing doesn't move the artwork, so update the rectangle only.
        e2.changeDoc((d) => ({ ...d, children: d.children.map((n) => (n.id === dg.id ? { ...n, x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), ...(n.viewportH && n.viewportH === o.h && ed.app === 'proto' ? {} : {}) } : n)) }), 'Resize Artboard', { merge: dg.key || (dg.key = uid()) });
        break;
      }
      default:
    }
  };

  const onPointerUp = (e) => {
    const dg = dragRef.current;
    dragRef.current = null; setDrag(null);
    if (!dg) return;
    const p = toWorld(e);
    const d = ed.get();
    switch (dg.kind) {
      case 'move': if (dg.moved) { ed.reparent(dg.ids); ed.lastTransform.current = { type: 'move', dx: dg.dx, dy: dg.dy, dup: dg.dup }; } else ed.h.commit(); break;
      case 'scale': case 'rotate': case 'scaletool': ed.h.commit(); if (dg.kind === 'rotate' && dg.deg) ed.lastTransform.current = { type: 'rotate', deg: dg.deg }; break;
      case 'marquee': {
        const r = normRect(dg.p0.x, dg.p0.y, p.x, p.y);
        if (r.w * view.zoom < 3 && r.h * view.zoom < 3) break;
        if (dg.direct) {
          const keys = []; const ids = new Set();
          walk(ed.root, (n) => {
            if (n.hidden || n.locked) return false;
            const sps = anchorSubpaths(n);
            if (!sps) return true;
            sps.forEach((sp, si) => sp.pts.forEach((P, pi) => { if (P.x >= r.x && P.x <= r.x + r.w && P.y >= r.y && P.y <= r.y + r.h) { keys.push(`${n.id}:${si}:${pi}`); ids.add(n.id); } }));
            return true;
          });
          ed.setSel([...ids]); ed.setAnchors(keys);
          break;
        }
        const hits = [];
        const consider = (n) => { if (!n.hidden && !n.locked && intersects(bounds(n, d), r)) hits.push(n.id); };
        const scopeNode = ed.groupScope ? findNode(ed.root, ed.groupScope) : null;
        if (scopeNode) scopeNode.children.forEach(consider);
        else for (const n of ed.root) { if (n.type === 'artboard') n.children.forEach(consider); else consider(n); }
        ed.setSel(dg.add ? [...new Set([...ed.sel, ...hits])] : hits);
        break;
      }
      case 'zoomrect': {
        const r = normRect(dg.p0.x, dg.p0.y, p.x, p.y);
        const rect = wrap.current.getBoundingClientRect();
        if (r.w * view.zoom > 8) fitRect(r, 10);
        else zoomAt(view.zoom * (dg.out || e.altKey ? 0.5 : 2), e.clientX - rect.left, e.clientY - rect.top);
        break;
      }
      case 'draw': {
        if (!dg.started) {
          // A click without dragging makes a default-size shape.
          const n = dg.shape === 'line' ? { ...dg.node, subpaths: make.line({ x1: dg.p0.x, y1: dg.p0.y, x2: dg.p0.x + 100, y2: dg.p0.y }).subpaths } : { ...dg.node, w: 100, h: 100 };
          ed.addNodes([n], n.name);
        }
        ed.h.commit();
        break;
      }
      case 'pencil': {
        if (dg.pts.length < 2) break;
        const first = dg.pts[0]; const last = dg.pts[dg.pts.length - 1];
        const closed = dg.pts.length > 8 && Math.hypot(first.x - last.x, first.y - last.y) * view.zoom < 12;
        const sps = smoothPoints(closed ? dg.pts.slice(0, -1) : dg.pts, 2.5 / Math.max(0.2, view.zoom), closed);
        const st = ed.style;
        ed.addNodes([make.path({ subpaths: sps, fill: closed ? st.fill : null, stroke: st.stroke?.color ? st.stroke : { color: '#000000', width: 2, cap: 'round', join: 'round', dash: [], align: 'center' }, name: 'Pencil' })], 'Pencil');
        break;
      }
      case 'textbox': {
        const r = normRect(dg.p0.x, dg.p0.y, p.x, p.y);
        const area = r.w * view.zoom > 10 && r.h * view.zoom > 10;
        const fill = ed.style.textFill || solid('#000000');
        const n = make.text({ x: area ? r.x : dg.p0.x, y: area ? r.y : dg.p0.y - (ed.style.font?.size || 36) * 0.6, text: '', mode: area ? 'area' : 'point', w: area ? r.w : undefined, h: area ? r.h : undefined, font: { ...(ed.style.font || {}) }, fill, name: 'Text' });
        ed.addNodes([n], 'Type');
        ed.setEditingText(n.id);
        break;
      }
      case 'abnew': {
        const r = normRect(dg.p0.x, dg.p0.y, p.x, p.y);
        if (r.w * view.zoom > 8 && r.h * view.zoom > 8) ed.addArtboard({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
        break;
      }
      case 'abmove': case 'abresize': ed.h.commit(); break;
      case 'pendrag': ed.h.commit(); break;
      case 'anchors': case 'handle': ed.h.commit(); break;
      case 'wire': {
        const ab = ed.artboardAt(p.x, p.y);
        if (ab && onWire) onWire(dg.from, ab.id);
        break;
      }
      case 'guide': {
        const rect = wrap.current.getBoundingClientRect();
        const inRuler = dg.axis === 'x' ? e.clientX - rect.left < 20 : e.clientY - rect.top < 20;
        const v = Math.round(dg.axis === 'x' ? p.x : p.y);
        ed.changeDoc((dd) => {
          const g = { x: [...(dd.guides?.x || [])], y: [...(dd.guides?.y || [])] };
          if (dg.index >= 0) g[dg.axis].splice(dg.index, 1);
          if (!inRuler) g[dg.axis].push(v);
          return { ...dd, guides: g };
        }, inRuler ? 'Delete Guide' : 'Guide');
        break;
      }
      default:
    }
  };

  const onDoubleClick = (ev) => {
    if (mode === 'prototype') return;
    // Pointer capture retargets click events to the wrapper, so look up what's really under the pointer.
    const e = { target: document.elementFromPoint(ev.clientX, ev.clientY) || ev.target, clientX: ev.clientX, clientY: ev.clientY };
    const label = e.target.closest('[data-ablabel]')?.getAttribute('data-ablabel');
    if (label) {
      const ab = ed.get().children.find((n) => n.id === label);
      if (onDoubleClickArtboard) onDoubleClickArtboard(ab);
      else if (!ed.readOnly) promptDialog({ title: 'Rename artboard', label: 'Name', value: ab.name }).then((v) => v && ed.updateArtboard(label, { name: v }, 'Rename Artboard'));
      return;
    }
    const id = hitId(e);
    if (!id) { if (ed.groupScope) ed.setGroupScope(null); else if (ed.scope) ed.exitSymbol(); return; }
    const leaf = findNode(ed.root, id);
    if (leaf?.type === 'text' && !ed.readOnly) { ed.setSel([leaf.id]); ed.setEditingText(leaf.id); return; }
    if (tool !== 'select') return;
    const s = ed.selectable(id);
    if (s?.type === 'instance') { onEditInstance ? onEditInstance(s) : ed.editSymbol(s.symbol); return; }
    if (s?.type === 'group') {
      // Enter the group and select the child under the pointer.
      ed.setGroupScope(s.id);
      const f = find(ed.root, id);
      const chain = [...f.chain, f.node];
      const gi = chain.findIndex((n) => n.id === s.id);
      const child = chain[gi + 1];
      if (child) { if (child.type === 'text' && !ed.readOnly) { ed.setSel([child.id]); ed.setEditingText(child.id); } else ed.setSel([child.id]); }
    }
  };

  // ---------------------------------------------------------------- overlays

  const z = view.zoom;
  const vt = `translate(${view.x} ${view.y}) scale(${z})`;
  const box = !ed.editingText && (tool === 'select' || tool === 'rotate' || tool === 'scale' || tool === 'reflect') && mode === 'design' ? selectionBox(ed) : null;
  const boxPts = box ? Object.fromEntries(Object.entries(HANDLES).map(([k, [hx, hy]]) => [k, S(apply(box.m, hx * box.w, hy * box.h))])) : null;
  const showAnchors = (tool === 'direct' || tool === 'pen' || tool === 'convert' || tool === 'addAnchor' || tool === 'deleteAnchor') && mode === 'design';
  const abs = doc && !scope ? artboardsOf(doc) : [];
  const vw = { x: -view.x / z, y: -view.y / z, w: size.w / z, h: size.h / z };
  const cursor = drag?.kind === 'pan' ? 'grabbing' : space.current ? 'grab' : mode === 'prototype' ? 'default' : TOOL_CURSOR[tool] || 'default';
  const handleCursor = (k) => {
    if (!box) return CURSORS[k];
    const rot = decompose(box.m).rotation;
    const order = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
    const idx = (order.indexOf(k) + Math.round(rot / 45) + 8) % 8;
    return CURSORS[order[idx]];
  };

  const editingNode = ed.editingText ? findNode(ed.root, ed.editingText) : null;

  return (
    <div ref={wrap} className={`absolute inset-0 overflow-hidden bg-work touch-none ${className || ''}`} style={{ cursor }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={onDoubleClick}
      onPointerLeave={() => setHover(null)} onContextMenu={(e) => e.preventDefault()} data-vector-viewport="">
      <svg className="absolute inset-0 w-full h-full block" style={{ shapeRendering: opts.outline ? 'crispEdges' : undefined }}>
        <defs>
          <pattern id="vgrid" width={opts.gridSize || 10} height={opts.gridSize || 10} patternUnits="userSpaceOnUse">
            <path d={`M${opts.gridSize || 10} 0H0V${opts.gridSize || 10}`} fill="none" stroke="rgba(128,128,128,.35)" strokeWidth={1 / z} />
          </pattern>
          <pattern id="vgrid10" width={(opts.gridSize || 10) * 10} height={(opts.gridSize || 10) * 10} patternUnits="userSpaceOnUse">
            <path d={`M${(opts.gridSize || 10) * 10} 0H0V${(opts.gridSize || 10) * 10}`} fill="none" stroke="rgba(128,128,128,.6)" strokeWidth={1.2 / z} />
          </pattern>
        </defs>
        <g transform={vt}>
          {abs.map((a) => <rect key={a.id} x={a.x} y={a.y} width={a.w} height={a.h} fill={a.bg ? 'none' : 'rgba(255,255,255,.04)'} stroke="rgba(0,0,0,.35)" strokeWidth={1 / z} style={{ filter: 'drop-shadow(0 2px 8px rgba(0,0,0,.35))' }} />)}
          {/* eslint-disable-next-line react/no-danger */}
          <g dangerouslySetInnerHTML={{ __html: content }} style={opts.outline ? { filter: 'none' } : undefined} />
          {opts.grid && <><rect x={vw.x} y={vw.y} width={vw.w} height={vw.h} fill="url(#vgrid)" pointerEvents="none" /><rect x={vw.x} y={vw.y} width={vw.w} height={vw.h} fill="url(#vgrid10)" pointerEvents="none" /></>}
          {/* layout grids (proto) */}
          {abs.filter((a) => a.layout?.on).map((a) => {
            const L = a.layout; const cols = Math.max(1, L.cols || 12); const m = L.margin || 0; const g = L.gutter || 0;
            const cw = (a.w - m * 2 - g * (cols - 1)) / cols;
            return <g key={`lg${a.id}`} pointerEvents="none">{Array.from({ length: cols }, (_, i) => <rect key={i} x={a.x + m + i * (cw + g)} y={a.y} width={Math.max(0, cw)} height={a.h} fill={L.color || 'rgba(255,60,90,.12)'} />)}</g>;
          })}
          {/* hover + selection outlines */}
          {hover && !drag && !ed.sel.includes(hover) && (() => { const n = findNode(ed.root, hover); const d = n && outlineOf(n, doc); return d ? <path d={d} fill="none" stroke={ACCENT} strokeWidth={1.5} vectorEffect="non-scaling-stroke" pointerEvents="none" /> : n ? (() => { const b = bounds(n, doc); return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke={ACCENT} strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />; })() : null; })()}
          {ed.selNodes.map((n) => { const d = outlineOf(n, doc); return d ? <path key={n.id} d={d} fill="none" stroke={ACCENT} strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" /> : null; })}
          {ed.groupScope && (() => { const g = findNode(ed.root, ed.groupScope); if (!g) return null; const b = bounds(g, doc); return <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke={ACCENT} strokeDasharray="4 3" strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />; })()}
          {scope && <g pointerEvents="none"><path d={`M-10000 0H10000M0 -10000V10000`} stroke="rgba(48,162,255,.5)" strokeWidth={1} vectorEffect="non-scaling-stroke" /></g>}
          {/* pen preview */}
          {penOn && cursorPt && pen.current && (() => {
            const n = findNode(ed.root, pen.current.id); const sp = n?.subpaths[pen.current.si]; const last = sp?.pts[sp.pts.length - 1];
            if (!last) return null;
            return <path d={`M${last.x} ${last.y}C${last.ox} ${last.oy} ${cursorPt.x} ${cursorPt.y} ${cursorPt.x} ${cursorPt.y}`} fill="none" stroke={ACCENT} strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />;
          })()}
          {drag?.kind === 'pencil' && <polyline points={drag.pts.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={ed.style.stroke?.color || '#000'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
        </g>

        {/* guides (screen space so they span the window) */}
        {opts.guides && doc && !scope && <g>
          {(doc.guides?.x || []).map((x, i) => <line key={`gx${i}`} x1={x * z + view.x} x2={x * z + view.x} y1={0} y2={size.h} stroke={GUIDE} strokeWidth={1} />)}
          {(doc.guides?.y || []).map((y, i) => <line key={`gy${i}`} y1={y * z + view.y} y2={y * z + view.y} x1={0} x2={size.w} stroke={GUIDE} strokeWidth={1} />)}
          {tool === 'select' && (doc.guides?.x || []).map((x, i) => <line key={`hx${i}`} data-guide="x" data-gi={i} x1={x * z + view.x} x2={x * z + view.x} y1={0} y2={size.h} stroke="transparent" strokeWidth={7} style={{ cursor: 'ew-resize' }} />)}
          {tool === 'select' && (doc.guides?.y || []).map((y, i) => <line key={`hy${i}`} data-guide="y" data-gi={i} y1={y * z + view.y} y2={y * z + view.y} x1={0} x2={size.w} stroke="transparent" strokeWidth={7} style={{ cursor: 'ns-resize' }} />)}
        </g>}
        {drag?.kind === 'guide' && (drag.axis === 'x' ? <line x1={drag.p.x * z + view.x} x2={drag.p.x * z + view.x} y1={0} y2={size.h} stroke={GUIDE} strokeDasharray="4 3" /> : <line y1={drag.p.y * z + view.y} y2={drag.p.y * z + view.y} x1={0} x2={size.w} stroke={GUIDE} strokeDasharray="4 3" />)}

        {/* artboard labels */}
        {showLabels && abs.map((a) => {
          const p = S({ x: a.x, y: a.y });
          const active = a.id === ed.activeAb;
          return (
            <g key={`l${a.id}`} data-ablabel={a.id} style={{ cursor: 'pointer' }}>
              <rect x={p.x} y={p.y - 20} width={Math.max(40, Math.min(a.w * z, 240))} height={18} fill="transparent" />
              <text x={p.x} y={p.y - 6} fontSize={11} fill={active ? '#e8f2ff' : '#9aa0ae'} fontWeight={active ? 600 : 400} style={{ userSelect: 'none' }}>{artboardLabel ? artboardLabel(a) : a.name}</text>
            </g>
          );
        })}

        {/* artboard tool handles */}
        {tool === 'artboard' && mode === 'design' && abs.filter((a) => a.id === ed.activeAb).map((a) => (
          <g key={`ah${a.id}`}>
            <rect x={a.x * z + view.x} y={a.y * z + view.y} width={a.w * z} height={a.h * z} fill="none" stroke={ACCENT} strokeWidth={1.5} pointerEvents="none" />
            {Object.entries(HANDLES).map(([k, [hx, hy]]) => <rect key={k} data-abh={k} x={(a.x + hx * a.w) * z + view.x - 4} y={(a.y + hy * a.h) * z + view.y - 4} width={8} height={8} fill="#fff" stroke={ACCENT} style={{ cursor: CURSORS[k] }} />)}
          </g>
        ))}

        {/* selection box */}
        {box && (
          <g>
            <polygon points={['nw', 'ne', 'se', 'sw'].map((k) => `${boxPts[k].x},${boxPts[k].y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={1} pointerEvents="none" />
            {!ed.readOnly && tool === 'select' && ['nw', 'ne', 'se', 'sw'].map((k) => <circle key={`r${k}`} data-h="rot" cx={boxPts[k].x + (k.includes('w') ? -10 : 10)} cy={boxPts[k].y + (k.includes('n') ? -10 : 10)} r={11} fill="transparent" style={{ cursor: 'alias' }} />)}
            {!ed.readOnly && tool === 'select' && Object.keys(HANDLES).filter((k) => (box.w * z > 24 || !['n', 's'].includes(k)) && (box.h * z > 24 || !['e', 'w'].includes(k))).map((k) => (
              <rect key={k} data-h={k} x={boxPts[k].x - HANDLE / 2} y={boxPts[k].y - HANDLE / 2} width={HANDLE} height={HANDLE} fill="#fff" stroke={ACCENT} strokeWidth={1} style={{ cursor: handleCursor(k) }} />
            ))}
          </g>
        )}
        {drag?.kind === 'rotate' && drag.deg !== undefined && <text x={S(drag.c).x + 12} y={S(drag.c).y - 12} fontSize={11} fill="#fff" stroke="#000" strokeWidth={3} paintOrder="stroke">{Math.round(drag.deg)}°</text>}

        {/* anchors and handles (direct selection / pen) */}
        {showAnchors && ed.selNodes.map((n) => {
          const sps = anchorSubpaths(n);
          if (!sps) return null;
          return (
            <g key={`a${n.id}`}>
              {sps.map((sp, si) => sp.pts.map((P, pi) => {
                const k = `${n.id}:${si}:${pi}`;
                const selA = ed.anchors.includes(k) || (penOn && pen.current?.id === n.id && pi === sp.pts.length - 1);
                const a = S(P); const hi = S({ x: P.ix, y: P.iy }); const ho = S({ x: P.ox, y: P.oy });
                const showH = selA && (tool === 'direct' || tool === 'pen' || tool === 'convert');
                return (
                  <g key={k}>
                    {showH && (P.ix !== P.x || P.iy !== P.y) && <><line x1={a.x} y1={a.y} x2={hi.x} y2={hi.y} stroke={ACCENT} /><circle data-hp={`${k}:in`} cx={hi.x} cy={hi.y} r={3.5} fill={ACCENT} style={{ cursor: 'move' }} /></>}
                    {showH && (P.ox !== P.x || P.oy !== P.y) && <><line x1={a.x} y1={a.y} x2={ho.x} y2={ho.y} stroke={ACCENT} /><circle data-hp={`${k}:out`} cx={ho.x} cy={ho.y} r={3.5} fill={ACCENT} style={{ cursor: 'move' }} /></>}
                    <rect data-anchor={k} x={a.x - 3.5} y={a.y - 3.5} width={7} height={7} fill={selA ? ACCENT : '#fff'} stroke={ACCENT} style={{ cursor: tool === 'pen' ? 'crosshair' : 'move' }} />
                  </g>
                );
              }))}
            </g>
          );
        })}

        {/* smart guides */}
        {drag?.lines?.map((l, i) => (l.x !== undefined
          ? <line key={i} x1={l.x * z + view.x} x2={l.x * z + view.x} y1={0} y2={size.h} stroke={SMART} strokeWidth={1} pointerEvents="none" />
          : <line key={i} y1={l.y * z + view.y} y2={l.y * z + view.y} x1={0} x2={size.w} stroke={SMART} strokeWidth={1} pointerEvents="none" />))}
        {drag?.kind === 'move' && drag.moved && <text x={S({ x: drag.p0.x + drag.dx, y: drag.p0.y + drag.dy }).x + 14} y={S({ x: drag.p0.x + drag.dx, y: drag.p0.y + drag.dy }).y + 24} fontSize={11} fill="#fff" stroke="#000" strokeWidth={3} paintOrder="stroke">{`dX ${Math.round(drag.dx)}  dY ${Math.round(drag.dy)}`}</text>}
        {drag?.kind === 'draw' && drag.r && <text x={S({ x: drag.r.x + drag.r.w, y: drag.r.y + drag.r.h }).x + 10} y={S({ x: drag.r.x + drag.r.w, y: drag.r.y + drag.r.h }).y + 18} fontSize={11} fill="#fff" stroke="#000" strokeWidth={3} paintOrder="stroke">{`W ${Math.round(drag.r.w)}  H ${Math.round(drag.r.h)}`}</text>}

        {/* marquee / zoom / new artboard / text box */}
        {['marquee', 'zoomrect', 'abnew', 'textbox'].includes(drag?.kind) && (() => { const r = normRect(drag.p0.x, drag.p0.y, drag.p.x, drag.p.y); const a = S(r); return <rect x={a.x} y={a.y} width={r.w * z} height={r.h * z} fill={drag.kind === 'marquee' ? 'rgba(48,162,255,.08)' : 'none'} stroke={ACCENT} strokeDasharray={drag.kind === 'abnew' ? undefined : '4 3'} strokeWidth={1} pointerEvents="none" />; })()}

        {overlay?.({ S, z, view, size, drag })}
        {drag?.kind === 'wire' && (() => { const a = S(drag.p0); const b = S(drag.p); return <path d={`M${a.x} ${a.y}C${(a.x + b.x) / 2} ${a.y} ${(a.x + b.x) / 2} ${b.y} ${b.x} ${b.y}`} fill="none" stroke="#3b8cff" strokeWidth={2} pointerEvents="none" />; })()}
      </svg>
      {opts.rulers && !scope && <Rulers view={view} size={size} origin={abs.find((a) => a.id === ed.activeAb) || { x: 0, y: 0 }} onStart={(axis, e) => {
        if (ed.readOnly) return;
        e.stopPropagation();
        wrap.current.setPointerCapture?.(e.pointerId);
        startDrag({ kind: 'guide', axis, index: -1, p: toWorld(e) });
      }} />}
      {editingNode && <TextEditor key={editingNode.id} node={editingNode} view={view} ed={ed} />}
    </div>
  );
}

// ---------------------------------------------------------------- rulers

function Rulers({ view, size, origin, onStart }) {
  const z = view.zoom;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const step = steps.find((s) => s * z >= 60) || 10000;
  const ticks = (len, off, o) => {
    const out = [];
    const start = Math.floor((-off / z - o) / step) * step;
    for (let v = start; (v + o) * z + off < len; v += step) {
      const px = (v + o) * z + off;
      out.push({ px, v });
    }
    return out;
  };
  const tx = ticks(size.w, view.x, origin.x); const ty = ticks(size.h, view.y, origin.y);
  return (
    <>
      <svg className="absolute left-0 top-0 h-5 bg-panel border-b border-line" style={{ width: size.w, cursor: 'ns-resize' }} onPointerDown={(e) => onStart('y', e)}>
        {tx.map((t) => <g key={t.v}><line x1={t.px} x2={t.px} y1={8} y2={20} stroke="var(--fg3)" /><text x={t.px + 3} y={11} fontSize={9} fill="var(--fg2)">{t.v}</text>{[1, 2, 3, 4].map((k) => <line key={k} x1={t.px + (k * step * z) / 5} x2={t.px + (k * step * z) / 5} y1={15} y2={20} stroke="var(--fg3)" />)}</g>)}
      </svg>
      <svg className="absolute left-0 top-5 w-5 bg-panel border-r border-line" style={{ height: size.h - 20, cursor: 'ew-resize' }} onPointerDown={(e) => onStart('x', e)}>
        {ty.map((t) => <g key={t.v}><line y1={t.px - 20} y2={t.px - 20} x1={8} x2={20} stroke="var(--fg3)" /><text x={2} y={t.px - 22} fontSize={9} fill="var(--fg2)" transform={`rotate(-90 9 ${t.px - 22})`}>{t.v}</text></g>)}
      </svg>
      <div className="absolute left-0 top-0 w-5 h-5 bg-panel border-r border-b border-line" />
    </>
  );
}

// ---------------------------------------------------------------- in-place text editing

function TextEditor({ node, view, ed }) {
  const ref = useRef(null);
  const f = fontOf(node);
  const L = node.mode === 'path' ? null : layoutText(node);
  const m = mul([view.zoom, 0, 0, view.zoom, view.x, view.y], node.t || I);
  const color = node.fill?.type === 'solid' ? node.fill.color : node.fill?.stops?.[0]?.color || '#000';
  const empty = useRef(!node.text);
  useEffect(() => {
    const el = ref.current;
    el.focus();
    if (!empty.current) el.select();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const w = node.mode === 'area' ? node.w : Math.max(L ? L.w : 100, f.size) + f.size;
  const h = Math.max(L ? L.h : leadingOf(f), leadingOf(f));
  if (node.mode === 'path') {
    const b = bounds(node, ed.doc);
    return <textarea ref={ref} defaultValue={node.text} className="absolute bg-panel text-fg border border-accent rounded p-1 text-sm" style={{ left: b.x * view.zoom + view.x, top: (b.y + b.h) * view.zoom + view.y + 6, width: 260, height: 60 }}
      onChange={(e) => ed.updateNode(node.id, { text: e.target.value }, 'Type', { merge: `type-${node.id}` })} onKeyDown={(e) => { if (e.key === 'Escape') ed.setEditingText(null); e.stopPropagation(); }} onPointerDown={(e) => e.stopPropagation()} />;
  }
  return (
    <textarea ref={ref} value={node.text} spellCheck={false}
      onChange={(e) => ed.updateNode(node.id, { text: e.target.value }, 'Type', { merge: `type-${node.id}` })}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); ed.setEditingText(null); } e.stopPropagation(); }}
      onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      className="absolute left-0 top-0 resize-none overflow-hidden p-0 m-0 border-0 outline outline-1 outline-dashed outline-[#30a2ff] bg-transparent"
      style={{
        transform: `matrix(${m.join(',')})`, transformOrigin: '0 0', width: w, height: h + leadingOf(f),
        font: cssFont(f), lineHeight: `${leadingOf(f)}px`, letterSpacing: `${(f.tracking * f.size) / 1000}px`, textAlign: f.align === 'justify' ? 'left' : f.align,
        color, caretColor: '#30a2ff', whiteSpace: node.mode === 'area' ? 'pre-wrap' : 'pre', overflowWrap: 'break-word',
      }} />
  );
}
