// The Composition panel: renders the comp at the playhead, and lets you move/scale/rotate the selected layer,
// drag its anchor point, draw shapes and masks (rectangle, ellipse, star, polygon, pen) and place text.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { renderFrame, prepareFrame, collectMedia, worldMatrix, layerBox, hitTest, maskPoly, isActive, shapePolys } from '../_anim/comp.js';
import { onMediaLoaded } from '../_anim/media.js';
import { apply, invert, mul, trs } from '../_anim/geom.js';
import { valueAt, isAnimated } from '../_anim/keyframes.js';
import { ensureFont } from '../../lib/fonts.js';
import { useSize, cx } from '../../components/ui.jsx';
import { newLayer, newShape, newMask, getPath } from './model.js';

const HANDLE = 7;

/** Where comp coordinates land on screen: { scale, ox, oy }. */
function useView(size, comp, zoom, pan) {
  const fit = Math.max(0.02, Math.min((size.width - 48) / comp.width, (size.height - 48) / comp.height));
  const scale = zoom === 'fit' ? fit : zoom;
  return { scale, ox: (size.width - comp.width * scale) / 2 + pan[0], oy: (size.height - comp.height * scale) / 2 + pan[1], fit };
}

export default function Viewer({
  project, comp, time, res, zoom, setZoom, guides, sel, setSel, tool, setTool, shapeKind, canEdit, playing,
  editLayer, addLayer, newFill, newStroke, strokeWidth, editingText, setEditingText, renderRef,
}) {
  const box = useRef(null);
  const canvas = useRef(null);
  const size = useSize(box);
  const [pan, setPan] = useState([0, 0]);
  const view = useView(size.width ? size : { width: 800, height: 450 }, comp, zoom, pan);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const rs = res === 'auto' ? Math.min(1, view.scale * dpr) : res;
  const [drag, setDrag] = useState(null); // live drawing state for shapes/masks/pen
  const [pen, setPen] = useState(null);   // { pts: [{ p, i, o }] } while placing pen points
  const [tick, setTick] = useState(0);
  const fontWait = useRef(false);

  useEffect(() => { if (zoom === 'fit') setPan([0, 0]); }, [zoom]);
  useEffect(() => onMediaLoaded(() => setTick((n) => n + 1)), []);

  // Render the frame. Media that's still loading triggers another render when it arrives.
  const W = Math.max(1, Math.round(comp.width * rs)); const H = Math.max(1, Math.round(comp.height * rs));
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    prepareFrame(project, comp, time);
    const fonts = collectMedia(project, comp, time).filter((m) => m.kind === 'font' && !document.fonts.check(`${m.weight} 12px "${m.family}"`));
    if (fonts.length && !fontWait.current) {
      fontWait.current = true;
      Promise.all(fonts.map((f) => ensureFont(f.family, f.weight, f.italic ? 'italic' : 'normal'))).then(() => { fontWait.current = false; setTick((n) => n + 1); });
    }
    renderFrame(project, comp, time, c.getContext('2d'), { scale: rs });
  }, [project, comp, time, W, H, rs, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (renderRef) renderRef.current = canvas.current;

  const toComp = useCallback((e) => {
    const r = box.current.getBoundingClientRect();
    return [(e.clientX - r.left - view.ox) / view.scale, (e.clientY - r.top - view.oy) / view.scale];
  }, [view.ox, view.oy, view.scale]);
  const toScreen = (p) => [view.ox + p[0] * view.scale, view.oy + p[1] * view.scale];

  const selLayers = comp.layers.filter((l) => sel.includes(l.id));
  const primary = selLayers[0];
  const primaryActive = primary && isActive(primary, time) && primary.type !== 'audio';

  // Handles of the primary selected layer (screen space).
  let handles = null;
  if (primaryActive) {
    const M = worldMatrix(primary, time, comp);
    const b = layerBox(project, primary, time, comp);
    const pts = { nw: [b.x, b.y], n: [b.x + b.w / 2, b.y], ne: [b.x + b.w, b.y], e: [b.x + b.w, b.y + b.h / 2], se: [b.x + b.w, b.y + b.h], s: [b.x + b.w / 2, b.y + b.h], sw: [b.x, b.y + b.h], w: [b.x, b.y + b.h / 2] };
    const anchor = valueAt(primary.tr.anchor, time);
    handles = { M, b, pts, scr: Object.fromEntries(Object.entries(pts).map(([k, p]) => [k, toScreen(apply(M, p))])), anchor: toScreen(apply(M, anchor)) };
  }

  // Parent-space helpers for dragging a layer.
  const parentMatrix = (l) => {
    const p = l.parent && comp.layers.find((x) => x.id === l.parent);
    return p ? worldMatrix(p, time, comp) : [1, 0, 0, 1, 0, 0];
  };
  const linInv = (m) => { const i = invert(m); return (d) => [i[0] * d[0] + i[2] * d[1], i[1] * d[0] + i[3] * d[1]]; };

  /** Target for a drawn shape/mask: the selected shape layer (adds a shape), another selected visual layer (adds a mask), or a new shape layer. */
  const drawTarget = () => {
    if (selLayers.length !== 1) return { kind: 'new' };
    const l = selLayers[0];
    if (l.type === 'shape') return { kind: 'shape', layer: l };
    if (['solid', 'image', 'video', 'text', 'precomp', 'adjustment'].includes(l.type)) return { kind: 'mask', layer: l };
    return { kind: 'new' };
  };

  const finishShape = (kind, a, b) => {
    const t = drawTarget();
    const cx0 = (a[0] + b[0]) / 2; const cy0 = (a[1] + b[1]) / 2;
    const w = Math.abs(b[0] - a[0]); const h = Math.abs(b[1] - a[1]);
    const radius = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (kind === 'rect' || kind === 'ellipse' ? w < 3 || h < 3 : radius < 3) return;
    if (t.kind === 'mask') {
      const inv = invert(worldMatrix(t.layer, time, comp));
      const corners = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]].map((p) => apply(inv, p));
      const xs = corners.map((p) => p[0]); const ys = corners.map((p) => p[1]);
      const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
      const mk = kind === 'ellipse' ? 'ellipse' : 'rect';
      editLayer(t.layer.id, (l) => ({ ...l, masks: [...l.masks, { ...newMask(mk, rect), name: `Mask ${l.masks.length + 1}` }] }), 'Add mask');
      return;
    }
    const isStar = kind === 'star' || kind === 'polygon';
    if (t.kind === 'shape') {
      const inv = invert(worldMatrix(t.layer, time, comp));
      const c = apply(inv, isStar ? a : [cx0, cy0]);
      const sc = Math.hypot(inv[0], inv[1]);
      const s = isStar ? newShape(kind, { pos: c, outer: radius * sc, inner: radius * sc * 0.45 }) : newShape(kind, { pos: c, size: [w * sc, h * sc] });
      editLayer(t.layer.id, (l) => ({ ...l, shape: { ...l.shape, shapes: [...l.shape.shapes, s] } }), 'Add shape');
      return;
    }
    const s = isStar ? newShape(kind, { outer: radius, inner: radius * 0.45 }) : newShape(kind, { size: [w, h] });
    const n = comp.layers.filter((l) => l.type === 'shape').length + 1;
    addLayer(newLayer('shape', comp, { name: `Shape Layer ${n}`, position: isStar ? a : [cx0, cy0], shapes: [s], fill: newFill, stroke: newStroke, strokeWidth, in: 0 }));
  };

  const finishPen = (nodes, closed) => {
    if (nodes.length < 2) { setPen(null); return; }
    const t = drawTarget();
    const toLayer = (l) => {
      const inv = invert(worldMatrix(l, time, comp)); const li = linInv(worldMatrix(l, time, comp));
      return nodes.map((n) => ({ p: apply(inv, n.p), i: li(n.i), o: li(n.o) }));
    };
    if (t.kind === 'mask') editLayer(t.layer.id, (l) => ({ ...l, masks: [...l.masks, { ...newMask('path', null, toLayer(l)), name: `Mask ${l.masks.length + 1}` }] }), 'Add mask');
    else if (t.kind === 'shape') editLayer(t.layer.id, (l) => ({ ...l, shape: { ...l.shape, shapes: [...l.shape.shapes, newShape('path', { nodes: toLayer(l), closed })] } }), 'Add path');
    else {
      const xs = nodes.map((n) => n.p[0]); const ys = nodes.map((n) => n.p[1]);
      const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      addLayer(newLayer('shape', comp, { name: 'Shape Layer', position: c, shapes: [newShape('path', { nodes: nodes.map((n) => ({ p: [n.p[0] - c[0], n.p[1] - c[1]], i: n.i, o: n.o })), closed })], fill: closed ? newFill : null, stroke: newStroke || (closed ? null : '#ffffff'), strokeWidth }));
    }
    setPen(null);
  };
  useEffect(() => {
    if (tool !== 'pen') { setPen(null); return undefined; }
    const k = (e) => {
      if (!pen) return;
      if (e.key === 'Enter') { e.preventDefault(); finishPen(pen.pts, false); }
      if (e.key === 'Escape') setPen(null);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const r = box.current.getBoundingClientRect();
      const mx = e.clientX - r.left; const my = e.clientY - r.top;
      const s0 = view.scale; const s1 = Math.max(0.03, Math.min(16, s0 * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      // keep the point under the mouse still
      const cx0 = (mx - view.ox) / s0; const cy0 = (my - view.oy) / s0;
      const nox = mx - cx0 * s1; const noy = my - cy0 * s1;
      setPan([nox - (size.width - comp.width * s1) / 2, noy - (size.height - comp.height * s1) / 2]);
      setZoom(s1);
    } else setPan(([x, y]) => [x - e.deltaX, y - e.deltaY]);
  };

  const onDown = (e) => {
    if (e.button === 1 || tool === 'hand') { startPan(e); return; }
    if (e.button !== 0) return;
    const p = toComp(e);
    if (tool === 'zoom') {
      const z = Math.max(0.03, Math.min(16, view.scale * (e.altKey ? 0.5 : 2)));
      setPan([-(p[0] - comp.width / 2) * z, -(p[1] - comp.height / 2) * z]); setZoom(z);
      return;
    }
    if (!canEdit) { const hit = hitTest(project, comp, time, p); setSel(hit ? [hit.id] : []); return; }
    if (['rect', 'ellipse', 'star', 'polygon'].includes(tool)) { setDrag({ kind: 'draw', shape: tool, a: p, b: p }); capture(e, (q) => setDrag((d) => d && { ...d, b: q }), (q) => { setDrag(null); finishShape(tool, p, q); }); return; }
    if (tool === 'pen') {
      const pts = pen?.pts || [];
      if (pts.length > 2 && Math.hypot((pts[0].p[0] - p[0]) * view.scale, (pts[0].p[1] - p[1]) * view.scale) < 9) { finishPen(pts, true); return; }
      const node = { p, i: [0, 0], o: [0, 0] };
      setPen({ pts: [...pts, node] });
      capture(e, (q) => { const d = [q[0] - p[0], q[1] - p[1]]; setPen((s) => s && { pts: [...s.pts.slice(0, -1), { p, o: d, i: [-d[0], -d[1]] }] }); }, () => {});
      return;
    }
    if (tool === 'text') {
      e.preventDefault(); // keep focus on the text box we're about to open
      const hit = hitTest(project, comp, time, p);
      if (hit?.type === 'text') { setSel([hit.id]); setEditingText(hit.id); return; }
      const l = newLayer('text', comp, { value: 'Text', position: p, size: Math.round(comp.height / 11) });
      addLayer(l);
      setEditingText(l.id);
      return;
    }
    // Selection / rotation / anchor tools.
    if (handles && primary && !primary.locked) {
      const sp = [e.clientX - box.current.getBoundingClientRect().left, e.clientY - box.current.getBoundingClientRect().top];
      const near = (q, r = HANDLE + 3) => Math.hypot(q[0] - sp[0], q[1] - sp[1]) <= r;
      if (tool === 'anchor' || (tool === 'select' && near(handles.anchor, 6) && e.altKey)) { dragAnchor(e); return; }
      if (tool === 'select') {
        for (const k of Object.keys(handles.scr)) if (near(handles.scr[k])) { dragScale(e, k); return; }
        for (const k of ['nw', 'ne', 'se', 'sw']) if (near(handles.scr[k], 26) && !insideBox(sp)) { dragRotate(e); return; }
      }
      if (tool === 'rotate') { dragRotate(e); return; }
    }
    const hit = hitTest(project, comp, time, p);
    if (!hit) { if (!e.shiftKey) setSel([]); startMarquee(e, p); return; }
    let ids = sel;
    if (e.shiftKey) { ids = sel.includes(hit.id) ? sel.filter((x) => x !== hit.id) : [...sel, hit.id]; setSel(ids); return; }
    if (!sel.includes(hit.id)) { ids = [hit.id]; setSel(ids); }
    if (tool === 'rotate') return;
    dragMove(e, ids, p);
  };

  const insideBox = (sp) => {
    if (!handles) return false;
    const inv = invert(handles.M); const q = apply(inv, [(sp[0] - view.ox) / view.scale, (sp[1] - view.oy) / view.scale]); const b = handles.b;
    return q[0] >= b.x && q[0] <= b.x + b.w && q[1] >= b.y && q[1] <= b.y + b.h;
  };

  function capture(e, move, up) {
    const el = e.currentTarget; el.setPointerCapture?.(e.pointerId);
    const mv = (ev) => move(toComp(ev), ev);
    const u = (ev) => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', u); el.removeEventListener('pointercancel', u); up(toComp(ev), ev); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', u); el.addEventListener('pointercancel', u);
  }
  function startPan(e) {
    const x0 = e.clientX; const y0 = e.clientY; const p0 = pan;
    const el = e.currentTarget; el.setPointerCapture?.(e.pointerId);
    const mv = (ev) => setPan([p0[0] + ev.clientX - x0, p0[1] + ev.clientY - y0]);
    const u = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', u); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', u);
  }
  function startMarquee(e, a) {
    setDrag({ kind: 'marquee', a, b: a });
    capture(e, (q) => setDrag((d) => d && { ...d, b: q }), (q) => {
      setDrag(null);
      const x0 = Math.min(a[0], q[0]); const x1 = Math.max(a[0], q[0]); const y0 = Math.min(a[1], q[1]); const y1 = Math.max(a[1], q[1]);
      if (x1 - x0 < 2 && y1 - y0 < 2) return;
      const ids = comp.layers.filter((l) => !l.locked && isActive(l, time) && l.type !== 'audio').filter((l) => {
        const M = worldMatrix(l, time, comp); const b = layerBox(project, l, time, comp);
        const c = apply(M, [b.x + b.w / 2, b.y + b.h / 2]);
        return c[0] >= x0 && c[0] <= x1 && c[1] >= y0 && c[1] <= y1;
      }).map((l) => l.id);
      setSel(e.shiftKey ? [...new Set([...sel, ...ids])] : ids);
    });
  }
  // Writes a transform property at the playhead (keyframe if animated) through editLayer with a merge key.
  const writeProp = (l, path, v, merge, label) => editLayer(l.id, (x) => {
    const p = getPath(x, path);
    const next = isAnimated(p) ? (() => {
      const k = p.k.slice(); const i = k.findIndex((kk) => Math.abs(kk.t - time) < 1e-4);
      if (i >= 0) k[i] = { ...k[i], v }; else { k.push({ t: time, v, in: 'linear', out: 'linear' }); k.sort((m, n) => m.t - n.t); }
      return { ...p, k };
    })() : { ...p, v };
    return { ...x, tr: { ...x.tr, [path.split('/')[1]]: next } };
  }, label, merge);

  function dragMove(e, ids, a) {
    const layers = comp.layers.filter((l) => ids.includes(l.id) && !l.locked);
    // Only move layers whose ancestors aren't also being moved.
    const roots = layers.filter((l) => !layers.some((o) => isAncestor(o.id, l)));
    const starts = roots.map((l) => ({ l, pos: valueAt(l.tr.position, time), li: linInv(parentMatrix(l)) }));
    const merge = `move-${Date.now()}`;
    let moved = false;
    capture(e, (q, ev) => {
      let d = [q[0] - a[0], q[1] - a[1]];
      if (ev.shiftKey) d = Math.abs(d[0]) > Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
      if (!moved && Math.hypot(d[0], d[1]) * view.scale < 2) return;
      moved = true;
      for (const s of starts) { const dl = s.li(d); writeProp(s.l, 'tr/position', [s.pos[0] + dl[0], s.pos[1] + dl[1]], merge, 'Move'); }
    }, () => {});
  }
  const isAncestor = (id, l, depth = 0) => { if (!l.parent || depth > 32) return false; if (l.parent === id) return true; const p = comp.layers.find((x) => x.id === l.parent); return p ? isAncestor(id, p, depth + 1) : false; };

  function dragScale(e, k) {
    const l = primary; const sc0 = valueAt(l.tr.scale, time); const anchor = valueAt(l.tr.anchor, time);
    const pos = valueAt(l.tr.position, time); const rot = valueAt(l.tr.rotation, time);
    const U = mul(parentMatrix(l), trs(pos, rot, 1, 1, [0, 0])); const inv = invert(U);
    const corner = handles.pts[k]; const d = [corner[0] - anchor[0], corner[1] - anchor[1]];
    const merge = `scale-${Date.now()}`;
    capture(e, (q, ev) => {
      const r = apply(inv, q);
      let sx = Math.abs(d[0]) > 1e-6 && /[ew]/.test(k) ? (r[0] / d[0]) * 100 : sc0[0];
      let sy = Math.abs(d[1]) > 1e-6 && /[ns]/.test(k) ? (r[1] / d[1]) * 100 : sc0[1];
      if (ev.shiftKey || k.length === 2 && !ev.altKey && ev.shiftKey) { const f = /[ew]/.test(k) ? sx / (sc0[0] || 1) : sy / (sc0[1] || 1); sx = sc0[0] * f; sy = sc0[1] * f; }
      writeProp(l, 'tr/scale', [+sx.toFixed(2), +sy.toFixed(2)], merge, 'Scale');
    }, () => {});
  }
  function dragRotate(e) {
    const l = primary; const r0 = valueAt(l.tr.rotation, time);
    const c = apply(worldMatrix(l, time, comp), valueAt(l.tr.anchor, time));
    const a0 = Math.atan2(toComp(e)[1] - c[1], toComp(e)[0] - c[0]);
    const merge = `rot-${Date.now()}`;
    capture(e, (q, ev) => {
      let r = r0 + ((Math.atan2(q[1] - c[1], q[0] - c[0]) - a0) * 180) / Math.PI;
      if (ev.shiftKey) r = Math.round(r / 45) * 45;
      writeProp(l, 'tr/rotation', +r.toFixed(2), merge, 'Rotate');
    }, () => {});
  }
  function dragAnchor(e) {
    // Pan Behind: move the anchor in layer space and compensate position so the layer stays put.
    const l = primary; const M = worldMatrix(l, time, comp); const inv = invert(M);
    const pos0 = valueAt(l.tr.position, time); const a0 = valueAt(l.tr.anchor, time);
    const local = mul(invert(parentMatrix(l)), M);
    const merge = `anchor-${Date.now()}`;
    capture(e, (q) => {
      const na = apply(inv, q);
      const pa = apply(local, na); const pa0 = apply(local, a0);
      editLayer(l.id, (x) => ({ ...x, tr: { ...x.tr, anchor: { ...x.tr.anchor, v: na, k: undefined }, position: isAnimated(x.tr.position) ? { ...x.tr.position, k: x.tr.position.k.map((kk) => ({ ...kk, v: [kk.v[0] + pa[0] - pa0[0], kk.v[1] + pa[1] - pa0[1]] })) } : { ...x.tr.position, v: [pos0[0] + pa[0] - pa0[0], pos0[1] + pa[1] - pa0[1]] } } }), 'Move anchor point', merge);
    }, () => {});
  }

  const cursor = { hand: 'grab', zoom: 'zoom-in', pen: 'crosshair', rect: 'crosshair', ellipse: 'crosshair', star: 'crosshair', polygon: 'crosshair', text: 'text', rotate: 'alias', anchor: 'move' }[tool] || 'default';
  const g = `translate(${view.ox} ${view.oy}) scale(${view.scale})`;
  const nss = { vectorEffect: 'non-scaling-stroke' };

  // Motion path of the selected layer's position keyframes.
  let motionPath = null;
  if (primary && isAnimated(primary.tr.position) && !playing) {
    const k = primary.tr.position.k; const pts = [];
    const pm = parentMatrix(primary);
    for (let t = k[0].t; t <= k[k.length - 1].t + 1e-6; t += 1 / comp.fps) pts.push(apply(pm, valueAt(primary.tr.position, t)));
    motionPath = { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(''), keys: k.map((kk) => apply(pm, kk.v)) };
  }

  const textEditLayer = editingText && comp.layers.find((l) => l.id === editingText);

  return (
    <div ref={box} className="absolute inset-0 overflow-hidden bg-work" style={{ cursor }} onWheel={onWheel} onPointerDown={onDown}
      onDoubleClick={(e) => { if (tool !== 'select') return; const hit = hitTest(project, comp, time, toComp(e)); if (hit?.type === 'text' && canEdit) setEditingText(hit.id); }}
      onContextMenu={(e) => e.preventDefault()}>
      <div className="absolute" style={{ left: view.ox, top: view.oy, width: comp.width * view.scale, height: comp.height * view.scale, boxShadow: '0 0 0 1px rgba(255,255,255,.08), 0 10px 40px rgba(0,0,0,.5)', background: 'repeating-conic-gradient(#2a2a30 0 25%, #1f1f25 0 50%) 0 0/16px 16px' }}>
        <canvas ref={canvas} data-testid="comp-canvas" style={{ width: '100%', height: '100%', display: 'block', imageRendering: view.scale > 2 ? 'pixelated' : 'auto' }} />
      </div>
      <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
        {guides && (
          <g transform={g} fill="none" stroke="rgba(120,200,255,.55)" strokeWidth={1} style={nss}>
            <rect x={comp.width * 0.05} y={comp.height * 0.05} width={comp.width * 0.9} height={comp.height * 0.9} style={nss} />
            <rect x={comp.width * 0.1} y={comp.height * 0.1} width={comp.width * 0.8} height={comp.height * 0.8} style={nss} />
            <path d={`M${comp.width / 2 - 20} ${comp.height / 2}h40M${comp.width / 2} ${comp.height / 2 - 20}v40`} style={nss} />
          </g>
        )}
        {motionPath && (
          <g transform={g}>
            <path d={motionPath.d} fill="none" stroke="#c79bff" strokeWidth={1} strokeDasharray="3 3" style={nss} />
            {motionPath.keys.map((p, i) => <rect key={i} x={p[0] - 3 / view.scale} y={p[1] - 3 / view.scale} width={6 / view.scale} height={6 / view.scale} fill="#c79bff" />)}
          </g>
        )}
        {selLayers.filter((l) => l !== primary && isActive(l, time) && l.type !== 'audio').map((l) => {
          const M = worldMatrix(l, time, comp); const b = layerBox(project, l, time, comp);
          return <g key={l.id} transform={g}><path d={[[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map((p, i) => `${i ? 'L' : 'M'}${apply(M, p).join(' ')}`).join('') + 'Z'} fill="none" stroke={l.label || '#5eb0e0'} strokeWidth={1} style={nss} /></g>;
        })}
        {primaryActive && handles && (
          <>
            {(primary.masks || []).map((m) => {
              const poly = maskPoly(m);
              const d = poly.pts.map((p, i) => `${i ? 'L' : 'M'}${apply(handles.M, p).join(' ')}`).join('') + 'Z';
              return <g key={m.id} transform={g}><path d={d} fill="none" stroke="#ffd35c" strokeWidth={1.2} style={nss} /></g>;
            })}
            {primary.type === 'shape' && (
              <g transform={g}>
                <path d={shapePolys({ ...primary, shape: { ...primary.shape, trim: null } }, time, comp).map((pl) => pl.pts.map((p, i) => `${i ? 'L' : 'M'}${apply(handles.M, p).join(' ')}`).join('') + (pl.closed ? 'Z' : '')).join('')} fill="none" stroke="#5eb0e0" strokeOpacity={0.6} strokeWidth={1} style={nss} />
              </g>
            )}
            <path d={['nw', 'ne', 'se', 'sw'].map((k, i) => `${i ? 'L' : 'M'}${handles.scr[k].join(' ')}`).join('') + 'Z'} fill="none" stroke={primary.label || '#5eb0e0'} strokeWidth={1.25} />
            {canEdit && !primary.locked && tool === 'select' && Object.entries(handles.scr).map(([k, p]) => (
              <rect key={k} x={p[0] - HANDLE / 2} y={p[1] - HANDLE / 2} width={HANDLE} height={HANDLE} fill="#fff" stroke={primary.label || '#5eb0e0'} strokeWidth={1} />
            ))}
            <g transform={`translate(${handles.anchor[0]} ${handles.anchor[1]})`} stroke="#fff" strokeWidth={1.25} fill="none">
              <circle r={5} /><path d="M-9 0h18M0 -9v18" />
            </g>
          </>
        )}
        {drag?.kind === 'marquee' && (
          <g transform={g}><rect x={Math.min(drag.a[0], drag.b[0])} y={Math.min(drag.a[1], drag.b[1])} width={Math.abs(drag.b[0] - drag.a[0])} height={Math.abs(drag.b[1] - drag.a[1])} fill="rgba(90,180,255,.12)" stroke="#5ab4ff" strokeWidth={1} style={nss} /></g>
        )}
        {drag?.kind === 'draw' && (() => {
          const { a, b, shape } = drag;
          const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const color = drawTarget().kind === 'mask' ? '#ffd35c' : '#5ab4ff';
          return (
            <g transform={g} fill="none" stroke={color} strokeWidth={1.25} style={nss}>
              {shape === 'rect' && <rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} style={nss} />}
              {shape === 'ellipse' && <ellipse cx={(a[0] + b[0]) / 2} cy={(a[1] + b[1]) / 2} rx={Math.abs(b[0] - a[0]) / 2} ry={Math.abs(b[1] - a[1]) / 2} style={nss} />}
              {(shape === 'star' || shape === 'polygon') && <circle cx={a[0]} cy={a[1]} r={r} style={nss} strokeDasharray="4 4" />}
            </g>
          );
        })()}
        {pen && (
          <g transform={g}>
            <path d={pen.pts.map((n, i) => {
              if (!i) return `M${n.p[0]} ${n.p[1]}`;
              const a = pen.pts[i - 1];
              return `C${a.p[0] + a.o[0]} ${a.p[1] + a.o[1]} ${n.p[0] + n.i[0]} ${n.p[1] + n.i[1]} ${n.p[0]} ${n.p[1]}`;
            }).join('')} fill="none" stroke="#5ab4ff" strokeWidth={1.5} style={nss} />
            {pen.pts.map((n, i) => (
              <g key={i}>
                {(n.o[0] || n.o[1]) ? <path d={`M${n.p[0] + n.i[0]} ${n.p[1] + n.i[1]}L${n.p[0] + n.o[0]} ${n.p[1] + n.o[1]}`} stroke="#5ab4ff" strokeWidth={1} style={nss} /> : null}
                <rect x={n.p[0] - 3.5 / view.scale} y={n.p[1] - 3.5 / view.scale} width={7 / view.scale} height={7 / view.scale} fill={i === 0 ? '#5ab4ff' : '#fff'} stroke="#5ab4ff" strokeWidth={1} style={nss} />
              </g>
            ))}
          </g>
        )}
      </svg>
      {textEditLayer && (() => {
        const M = worldMatrix(textEditLayer, time, comp);
        const p = toScreen(apply(M, [0, 0]));
        return (
          <textarea autoFocus ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; setTimeout(() => { el.focus(); el.select(); }, 30); } }} data-testid="text-edit" defaultValue={textEditLayer.text.value} spellCheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => { const v = e.target.value; editLayer(textEditLayer.id, (l) => ({ ...l, name: (v.split('\n')[0] || 'Text').slice(0, 32), text: { ...l.text, value: v } }), 'Edit text', `text-${textEditLayer.id}`); }}
            onBlur={() => setEditingText(null)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.currentTarget.blur(); setTool('select'); } }}
            className="absolute z-10 min-w-48 min-h-16 p-2 rounded-md bg-panel/95 border border-accent text-[14px] text-fg outline-none shadow-xl resize"
            style={{ left: Math.max(4, p[0] - 100), top: Math.max(4, p[1] + 16) }} />
        );
      })()}
      <div className={cx('absolute left-2 bottom-2 text-[11px] text-fg3 bg-panel/80 rounded px-1.5 py-0.5 pointer-events-none')}>
        {Math.round(view.scale * 100)}% · {res === 'auto' ? `Auto (${Math.round(rs * 100)}%)` : rs >= 1 ? 'Full' : rs >= 0.5 ? 'Half' : 'Quarter'}
      </div>
    </div>
  );
}
