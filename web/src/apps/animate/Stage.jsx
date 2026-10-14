// Sora ANI's stage: draws the current frame (with onion skins), and the drawing tools — selection / free transform,
// brush, pencil, line, rectangle, oval, paint bucket, eraser, eyedropper, text — plus hand and zoom.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { drawTimeline, layerElements, keyAt, worldBounds, hitElement, localBounds, elMatrix } from '../_anim/stage.js';
import { onMediaLoaded } from '../_anim/media.js';
import { simplify, rectPoly, ellipsePoly, apply, invert } from '../_anim/geom.js';
import { ensureFont } from '../../lib/fonts.js';
import { useSize, toast } from '../../components/ui.jsx';
import { shapeFrom, uid } from './model.js';
import { bucketShape, erase, pixelAt } from './paint.js';

const HANDLE = 7;

export default function Stage({
  doc, tl, symId, frame, active, setActive, sel, setSel, tool, opts, setOpts, onion, canEdit, playing,
  editEls, editingText, setEditingText, zoom, setZoom,
}) {
  const box = useRef(null);
  const canvas = useRef(null);
  const size = useSize(box);
  const [pan, setPan] = useState([0, 0]);
  const [live, setLiveState] = useState(null); // in-progress drawing: { kind, pts, a, b }
  const liveRef = useRef(null);
  const setLive = (v) => { liveRef.current = typeof v === 'function' ? v(liveRef.current) : v; setLiveState(liveRef.current); };
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState(null);
  const dpr = window.devicePixelRatio || 1;
  const W = size.width || 800; const H = size.height || 500;
  const fit = Math.max(0.05, Math.min((W - 60) / doc.width, (H - 60) / doc.height));
  const scale = zoom === 'fit' ? fit : zoom;
  const ox = (W - doc.width * scale) / 2 + pan[0]; const oy = (H - doc.height * scale) / 2 + pan[1];
  const origin = symId ? [doc.width / 2, doc.height / 2] : [0, 0]; // symbols are edited around their registration point
  useEffect(() => { if (zoom === 'fit') setPan([0, 0]); }, [zoom]);
  useEffect(() => onMediaLoaded(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    const fonts = new Set();
    for (const l of tl.layers) for (const k of l.frames) for (const e of k.els) if (e.type === 'text') fonts.add(`${e.font || 'Inter'}|${e.weight || 400}`);
    Promise.all([...fonts].map((f) => { const [fam, w] = f.split('|'); return ensureFont(fam, Number(w)); })).then(() => setTick((n) => n + 1));
  }, [tl]);

  const toStage = (e) => { const r = box.current.getBoundingClientRect(); return [(e.clientX - r.left - ox) / scale - origin[0], (e.clientY - r.top - oy) / scale - origin[1]]; };
  const toScreen = (p) => [ox + (p[0] + origin[0]) * scale, oy + (p[1] + origin[1]) * scale];

  // ---------------------------------------------------------------- render
  useLayoutEffect(() => {
    const c = canvas.current; if (!c) return;
    const cw = Math.round(W * dpr); const ch = Math.round(H * dpr);
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const view = () => ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + origin[0] * scale), dpr * (oy + origin[1] * scale));
    // stage
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(ox + 4, oy + 6, doc.width * scale, doc.height * scale);
    ctx.fillStyle = doc.bg || '#fff'; ctx.fillRect(ox, oy, doc.width * scale, doc.height * scale);
    // onion skins: earlier frames tinted blue, later ones green, fading with distance
    if (onion.on && !playing) {
      const tmp = scratchCanvas(cw, ch); const tctx = tmp.getContext('2d');
      const draw = (f, color, k) => {
        tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.clearRect(0, 0, cw, ch);
        tctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (ox + origin[0] * scale), dpr * (oy + origin[1] * scale));
        drawTimeline(tctx, doc, tl, f, { doc });
        tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.globalCompositeOperation = 'source-atop'; tctx.fillStyle = color; tctx.globalAlpha = 0.65; tctx.fillRect(0, 0, cw, ch);
        tctx.globalCompositeOperation = 'source-over'; tctx.globalAlpha = 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = k; ctx.drawImage(tmp, 0, 0); ctx.globalAlpha = 1;
      };
      for (let i = onion.before; i >= 1; i--) if (frame - i >= 0) draw(frame - i, '#3b7bff', 0.5 * (1 - (i - 1) / (onion.before + 1)));
      for (let i = onion.after; i >= 1; i--) draw(frame + i, '#2fbf5a', 0.5 * (1 - (i - 1) / (onion.after + 1)));
    }
    view();
    drawTimeline(ctx, doc, tl, frame, { doc });
    // pasteboard: dim whatever hangs outside the stage
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(30,30,36,.72)';
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(ox, oy, doc.width * scale, doc.height * scale); ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.strokeRect(ox - 0.5, oy - 0.5, doc.width * scale + 1, doc.height * scale + 1);
    // live strokes
    if (live && (live.kind === 'brush' || live.kind === 'pencil')) {
      view(); ctx.beginPath(); live.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.strokeStyle = live.kind === 'brush' ? opts.fill : opts.stroke; ctx.lineWidth = live.kind === 'brush' ? opts.brush : opts.sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
    }
  }, [doc, tl, frame, W, H, dpr, scale, ox, oy, onion, live, tick, playing, symId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- helpers
  const activeLayer = tl.layers.find((l) => l.id === active);
  const els = activeLayer ? layerElements(activeLayer, frame) : [];
  const selEls = els.filter((e) => sel.includes(e.id));
  const layerLocked = !activeLayer || activeLayer.locked || !activeLayer.visible;
  const guardEdit = () => {
    if (!canEdit) return false;
    if (layerLocked) { toast(activeLayer?.locked ? 'This layer is locked.' : 'This layer is hidden.'); return false; }
    return true;
  };
  /** Topmost element under the point on a visible, unlocked layer → { layer, el }. */
  const pick = (p) => {
    for (const l of tl.layers) {
      if (!l.visible || l.locked) continue;
      const list = layerElements(l, frame);
      for (let i = list.length - 1; i >= 0; i--) if (hitElement(doc, list[i], p, 4 / scale)) return { layer: l, el: list[i] };
    }
    return null;
  };

  function capture(e, move, up) {
    const el = e.currentTarget; el.setPointerCapture?.(e.pointerId);
    const mv = (ev) => move(toStage(ev), ev);
    const u = (ev) => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', u); el.removeEventListener('pointercancel', u); up(toStage(ev), ev); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', u); el.addEventListener('pointercancel', u);
  }
  const startPan = (e) => {
    const x0 = e.clientX; const y0 = e.clientY; const p0 = pan;
    const el = e.currentTarget; el.setPointerCapture?.(e.pointerId);
    const mv = (ev) => setPan([p0[0] + ev.clientX - x0, p0[1] + ev.clientY - y0]);
    const u = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', u); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', u);
  };
  const spaceHeld = useRef(false);
  useEffect(() => {
    const d = (e) => { if (e.code === 'Space' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) spaceHeld.current = true; };
    const u = (e) => { if (e.code === 'Space') spaceHeld.current = false; };
    window.addEventListener('keydown', d); window.addEventListener('keyup', u);
    return () => { window.removeEventListener('keydown', d); window.removeEventListener('keyup', u); };
  }, []);

  // selection handles (single element)
  const one = selEls.length === 1 ? selEls[0] : null;
  let handles = null;
  if (one && tool === 'select') {
    const b = localBounds(doc, one); const M = elMatrix(one);
    const pts = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], se: [b.x + b.w, b.y + b.h], sw: [b.x, b.y + b.h], n: [b.x + b.w / 2, b.y], s: [b.x + b.w / 2, b.y + b.h], e: [b.x + b.w, b.y + b.h / 2], w: [b.x, b.y + b.h / 2] };
    handles = { b, M, pts, scr: Object.fromEntries(Object.entries(pts).map(([k, p]) => [k, toScreen(apply(M, p))])), reg: toScreen([one.x || 0, one.y || 0]) };
  }

  const onDown = (e) => {
    if (e.button === 1 || tool === 'hand' || spaceHeld.current) { startPan(e); return; }
    if (e.button !== 0) return;
    const p = toStage(e);
    if (tool === 'zoom') { const z = Math.max(0.05, Math.min(32, scale * (e.altKey ? 0.5 : 2))); setPan([-(p[0] + origin[0] - doc.width / 2) * z, -(p[1] + origin[1] - doc.height / 2) * z]); setZoom(z); return; }
    if (tool === 'select') return selectDown(e, p);
    if (tool === 'eyedropper') {
      const hit = pick(p);
      if (hit?.el.type === 'shape') { setOpts((o) => ({ ...o, fill: hit.el.fill || o.fill, stroke: hit.el.stroke || o.stroke })); toast('Picked colour'); }
      else { const r = box.current.getBoundingClientRect(); setOpts((o) => ({ ...o, fill: pixelAt(canvas.current, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr) })); }
      return;
    }
    if (!guardEdit()) return;
    if (tool === 'brush' || tool === 'pencil') {
      setLive({ kind: tool, pts: [p] });
      capture(e, (q) => setLive((l) => l && { ...l, pts: [...l.pts, q] }), () => {
        const l = liveRef.current;
        setLive(null);
        if (l) {
          let pts = simplify(l.pts, (tool === 'brush' ? 0.8 : 0.5) / scale * (opts.smooth / 50 + 0.2));
          if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.1, pts[0][1]]];
          const style = tool === 'brush' ? { stroke: opts.fill, sw: opts.brush, fill: null, smooth: true } : { stroke: opts.stroke, sw: opts.sw, fill: null, smooth: opts.smooth > 0 };
          const el = shapeFrom([{ pts, closed: false }], style);
          editEls((list) => [...list, el], tool === 'brush' ? 'Brush stroke' : 'Pencil stroke');
        }
      });
      return;
    }
    if (tool === 'line' || tool === 'rect' || tool === 'oval') {
      setLive({ kind: tool, a: p, b: p });
      capture(e, (q, ev) => setLive((l) => l && { ...l, b: constrain(l.a, q, ev.shiftKey, tool) }), (q, ev) => {
        const b = constrain(p, q, ev.shiftKey, tool);
        setLive(null);
        if (Math.hypot(b[0] - p[0], b[1] - p[1]) < 2 / scale) return;
        let sub;
        if (tool === 'line') sub = { pts: [p, b], closed: false };
        else if (tool === 'rect') sub = rectPoly((p[0] + b[0]) / 2, (p[1] + b[1]) / 2, Math.abs(b[0] - p[0]), Math.abs(b[1] - p[1]), opts.radius || 0);
        else sub = ellipsePoly((p[0] + b[0]) / 2, (p[1] + b[1]) / 2, Math.abs(b[0] - p[0]), Math.abs(b[1] - p[1]), 72);
        const style = tool === 'line' ? { stroke: opts.stroke, sw: opts.sw, fill: null } : { fill: opts.fillOn ? opts.fill : null, stroke: opts.strokeOn ? opts.stroke : null, sw: opts.strokeOn ? opts.sw : 0 };
        editEls((list) => [...list, shapeFrom([sub], style)], { line: 'Line', rect: 'Rectangle', oval: 'Oval' }[tool]);
      });
      return;
    }
    if (tool === 'bucket') {
      const hit = pick(p);
      if (hit && hit.layer.id === active && hit.el.type === 'shape' && hit.el.subs.some((s) => s.closed) && (hit.el.fill || hitElement(doc, { ...hit.el, fill: '#000' }, p, 0))) {
        editEls((list) => list.map((x) => (x.id === hit.el.id ? { ...x, fill: opts.fill } : x)), 'Paint bucket');
        return;
      }
      const el = bucketShape(doc, activeLayer, frame, p, opts.fill, opts.gap, origin);
      if (!el) { toast('No closed area there — close the gap in the lines, or pick a larger gap size.'); return; }
      editEls((list) => [el, ...list], 'Paint bucket');
      return;
    }
    if (tool === 'eraser') {
      setLive({ kind: 'eraser', pts: [p] });
      capture(e, (q) => setLive((l) => l && { ...l, pts: [...l.pts, q] }), () => {
        const l = liveRef.current;
        setLive(null);
        if (l) editEls((list) => erase(list, l.pts, opts.eraser / 2), 'Erase');
      });
      return;
    }
    if (tool === 'text') {
      e.preventDefault();
      const hit = pick(p);
      if (hit?.el.type === 'text') { setActive(hit.layer.id); setSel([hit.el.id]); setEditingText(hit.el.id); return; }
      const el = { id: uid(), type: 'text', text: 'Text', font: opts.font || 'Inter', weight: 700, size: opts.fontSize || 48, color: opts.fill, x: p[0], y: p[1], sx: 1, sy: 1, r: 0, alpha: 1 };
      editEls((list) => [...list, el], 'Text');
      setSel([el.id]); setEditingText(el.id);
    }
  };

  function selectDown(e, p) {
    // handles first
    if (handles && canEdit && !layerLocked) {
      const r = box.current.getBoundingClientRect(); const sp = [e.clientX - r.left, e.clientY - r.top];
      const near = (q, d = HANDLE + 3) => Math.hypot(q[0] - sp[0], q[1] - sp[1]) <= d;
      for (const k of Object.keys(handles.scr)) if (near(handles.scr[k])) { dragScale(e, k); return; }
      for (const k of ['nw', 'ne', 'se', 'sw']) if (near(handles.scr[k], 24) && !hitElement(doc, one, p, 0)) { dragRotate(e); return; }
    }
    const hit = pick(p);
    if (!hit) {
      if (!e.shiftKey) setSel([]);
      setLive({ kind: 'marquee', a: p, b: p });
      capture(e, (q) => setLive((l) => l && { ...l, b: q }), (q) => {
        setLive(null);
        const x0 = Math.min(p[0], q[0]); const x1 = Math.max(p[0], q[0]); const y0 = Math.min(p[1], q[1]); const y1 = Math.max(p[1], q[1]);
        if (x1 - x0 < 1 && y1 - y0 < 1) return;
        const ids = els.filter((el) => { const b = worldBounds(doc, el); return b.x >= x0 && b.y >= y0 && b.x + b.w <= x1 && b.y + b.h <= y1; }).map((el) => el.id);
        setSel(e.shiftKey ? [...new Set([...sel, ...ids])] : ids);
      });
      return;
    }
    if (hit.layer.id !== active) setActive(hit.layer.id);
    let ids = sel;
    if (e.shiftKey) { setSel(sel.includes(hit.el.id) ? sel.filter((x) => x !== hit.el.id) : [...sel, hit.el.id]); return; }
    if (!sel.includes(hit.el.id) || hit.layer.id !== active) { ids = [hit.el.id]; setSel(ids); }
    if (!canEdit || hit.layer.locked) return;
    const start = new Map(layerElements(hit.layer, frame).filter((x) => ids.includes(x.id)).map((x) => [x.id, [x.x || 0, x.y || 0]]));
    const merge = `move-${Date.now()}`; let moved = false;
    capture(e, (q, ev) => {
      let d = [q[0] - p[0], q[1] - p[1]];
      if (ev.shiftKey) d = Math.abs(d[0]) > Math.abs(d[1]) ? [d[0], 0] : [0, d[1]];
      if (!moved && Math.hypot(d[0], d[1]) * scale < 2) return;
      moved = true;
      editEls((list) => list.map((x) => (start.has(x.id) ? { ...x, x: +(start.get(x.id)[0] + d[0]).toFixed(2), y: +(start.get(x.id)[1] + d[1]).toFixed(2) } : x)), 'Move', merge, hit.layer.id);
    }, () => {});
  }
  function dragScale(e, k) {
    const el = one; const pts = handles.pts[k];
    const sx0 = el.sx ?? 1; const sy0 = el.sy ?? 1;
    const U = [Math.cos((el.r || 0) * Math.PI / 180), Math.sin((el.r || 0) * Math.PI / 180)];
    const merge = `scale-${Date.now()}`;
    capture(e, (q, ev) => {
      // pointer in the element's unscaled, unrotated frame around its registration point
      const d = [q[0] - (el.x || 0), q[1] - (el.y || 0)];
      const lx = d[0] * U[0] + d[1] * U[1]; const ly = -d[0] * U[1] + d[1] * U[0];
      let sx = /[ew]/.test(k) && Math.abs(pts[0]) > 1e-6 ? lx / pts[0] : sx0;
      let sy = /[ns]/.test(k) && Math.abs(pts[1]) > 1e-6 ? ly / pts[1] : sy0;
      if (ev.shiftKey && k.length === 2) { const f = Math.max(Math.abs(sx / sx0), Math.abs(sy / sy0)); sx = sx0 * f * Math.sign(sx || 1); sy = sy0 * f * Math.sign(sy || 1); }
      editEls((list) => list.map((x) => (x.id === el.id ? { ...x, sx: +sx.toFixed(4), sy: +sy.toFixed(4) } : x)), 'Scale', merge);
    }, () => {});
  }
  function dragRotate(e) {
    const el = one; const c = [el.x || 0, el.y || 0]; const r0 = el.r || 0;
    const p0 = toStage(e); const a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
    const merge = `rot-${Date.now()}`;
    capture(e, (q, ev) => {
      let r = r0 + ((Math.atan2(q[1] - c[1], q[0] - c[0]) - a0) * 180) / Math.PI;
      if (ev.shiftKey) r = Math.round(r / 45) * 45;
      editEls((list) => list.map((x) => (x.id === el.id ? { ...x, r: +r.toFixed(2) } : x)), 'Rotate', merge);
    }, () => {});
  }

  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const r = box.current.getBoundingClientRect(); const mx = e.clientX - r.left; const my = e.clientY - r.top;
      const s1 = Math.max(0.05, Math.min(32, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const cx = (mx - ox) / scale; const cy = (my - oy) / scale;
      setPan([mx - cx * s1 - (W - doc.width * s1) / 2, my - cy * s1 - (H - doc.height * s1) / 2]); setZoom(s1);
    } else setPan(([x, y]) => [x - e.deltaX, y - e.deltaY]);
  };

  const cursor = { hand: 'grab', zoom: 'zoom-in', brush: 'crosshair', pencil: 'crosshair', line: 'crosshair', rect: 'crosshair', oval: 'crosshair', bucket: 'cell', eraser: 'none', eyedropper: 'copy', text: 'text' }[tool] || 'default';
  const g = `translate(${ox + origin[0] * scale} ${oy + origin[1] * scale}) scale(${scale})`;
  const nss = { vectorEffect: 'non-scaling-stroke' };
  const textEl = editingText && els.find((x) => x.id === editingText);

  return (
    <div ref={box} className="absolute inset-0 overflow-hidden bg-work" style={{ cursor }} onPointerDown={onDown} onWheel={onWheel}
      onPointerMove={(e) => tool === 'eraser' && setHover(toStage(e))} onPointerLeave={() => setHover(null)}
      onDoubleClick={(e) => { if (tool !== 'select' || !canEdit) return; const hit = pick(toStage(e)); if (hit?.el.type === 'text') setEditingText(hit.el.id); else if (hit?.el.type === 'symbol') box.current.dispatchEvent(new CustomEvent('sl-edit-symbol', { bubbles: true, detail: hit.el.symbol })); }}
      onContextMenu={(e) => e.preventDefault()} data-testid="stage">
      <canvas ref={canvas} className="absolute inset-0" style={{ width: W, height: H }} data-testid="stage-canvas" />
      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        {symId && <g transform={`translate(${ox + origin[0] * scale} ${oy + origin[1] * scale})`} stroke="#222" strokeWidth={1}><path d="M-8 0h16M0 -8v16" /><circle r={3} fill="#fff" /></g>}
        {selEls.filter((x) => x !== one).map((x) => { const b = worldBounds(doc, x); return <g key={x.id} transform={g}><rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="#2f8bff" strokeWidth={1} style={nss} /></g>; })}
        {handles && (
          <>
            <path d={['nw', 'ne', 'se', 'sw'].map((k, i) => `${i ? 'L' : 'M'}${handles.scr[k].join(' ')}`).join('') + 'Z'} fill="none" stroke="#2f8bff" strokeWidth={1.25} />
            {canEdit && Object.entries(handles.scr).map(([k, p]) => <rect key={k} x={p[0] - HANDLE / 2} y={p[1] - HANDLE / 2} width={HANDLE} height={HANDLE} fill="#fff" stroke="#2f8bff" />)}
            <circle cx={handles.reg[0]} cy={handles.reg[1]} r={4} fill="#fff" stroke="#2f8bff" />
          </>
        )}
        {live?.kind === 'marquee' && <g transform={g}><rect x={Math.min(live.a[0], live.b[0])} y={Math.min(live.a[1], live.b[1])} width={Math.abs(live.b[0] - live.a[0])} height={Math.abs(live.b[1] - live.a[1])} fill="rgba(47,139,255,.1)" stroke="#2f8bff" style={nss} strokeDasharray="4 3" /></g>}
        {live && ['line', 'rect', 'oval'].includes(live.kind) && (
          <g transform={g} fill={live.kind !== 'line' && opts.fillOn ? opts.fill : 'none'} fillOpacity={0.6} stroke={opts.strokeOn || live.kind === 'line' ? opts.stroke : '#2f8bff'} strokeWidth={live.kind === 'line' || opts.strokeOn ? opts.sw : 1}>
            {live.kind === 'line' && <line x1={live.a[0]} y1={live.a[1]} x2={live.b[0]} y2={live.b[1]} strokeLinecap="round" />}
            {live.kind === 'rect' && <rect x={Math.min(live.a[0], live.b[0])} y={Math.min(live.a[1], live.b[1])} width={Math.abs(live.b[0] - live.a[0])} height={Math.abs(live.b[1] - live.a[1])} rx={opts.radius || 0} />}
            {live.kind === 'oval' && <ellipse cx={(live.a[0] + live.b[0]) / 2} cy={(live.a[1] + live.b[1]) / 2} rx={Math.abs(live.b[0] - live.a[0]) / 2} ry={Math.abs(live.b[1] - live.a[1]) / 2} />}
          </g>
        )}
        {live?.kind === 'eraser' && <g transform={g}><path d={live.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('')} fill="none" stroke="rgba(255,80,80,.45)" strokeWidth={opts.eraser} strokeLinecap="round" strokeLinejoin="round" /></g>}
        {tool === 'eraser' && hover && <g transform={g}><circle cx={hover[0]} cy={hover[1]} r={opts.eraser / 2} fill="none" stroke="#222" strokeWidth={1} style={nss} /><circle cx={hover[0]} cy={hover[1]} r={opts.eraser / 2 + 1 / scale} fill="none" stroke="#fff" strokeWidth={1} style={nss} /></g>}
      </svg>
      {textEl && (() => {
        const p = toScreen([textEl.x || 0, textEl.y || 0]);
        return (
          <textarea ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; setTimeout(() => { el.focus(); el.select(); }, 30); } }} defaultValue={textEl.text} spellCheck={false} data-testid="text-edit"
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => { const v = e.target.value; editEls((list) => list.map((x) => (x.id === textEl.id ? { ...x, text: v } : x)), 'Edit text', `txt-${textEl.id}`); }}
            onBlur={() => setEditingText(null)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') e.currentTarget.blur(); }}
            className="absolute z-10 min-w-40 min-h-12 p-2 rounded-md bg-panel/95 border border-accent text-sm text-fg outline-none shadow-xl"
            style={{ left: Math.max(4, p[0]), top: Math.max(4, p[1] + (textEl.size || 48) * scale * 1.3) }} />
        );
      })()}
      <div className="absolute left-2 bottom-2 text-[11px] text-fg3 bg-panel/80 rounded px-1.5 py-0.5 pointer-events-none">{Math.round(scale * 100)}%{symId ? ' · editing symbol' : ''}</div>
    </div>
  );
}

function constrain(a, b, shift, tool) {
  if (!shift) return b;
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  if (tool === 'line') { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4); const d = Math.hypot(dx, dy); return [a[0] + Math.cos(ang) * d, a[1] + Math.sin(ang) * d]; }
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return [a[0] + Math.sign(dx || 1) * m, a[1] + Math.sign(dy || 1) * m];
}

let scratch = null;
function scratchCanvas(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  return scratch;
}
export { keyAt, invert };
