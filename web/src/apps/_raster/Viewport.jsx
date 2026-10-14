// The canvas area both editors use: shows the composite on a checkerboard, zooms/pans/rotates the view, draws
// marching ants, guides, rulers and whatever the active tool wants on top, and turns pointer input (mouse, pen with
// pressure/tilt, touch) into document coordinates for the tool.
//
// view = { zoom, cx, cy, rot, flip } — (cx, cy) is the document point at the centre of the viewport.
// tool = { cursor, down(p, e), move(p, e), up(p, e), hover(p), cancel(), overlay(ctx, api), brushSize() }
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { outline } from './selection.js';

export const fitView = (doc, w, h, rot = 0) => {
  const z = Math.min((w - 48) / doc.width, (h - 48) / doc.height);
  return { zoom: Math.max(0.01, Math.min(z, 32)), cx: doc.width / 2, cy: doc.height / 2, rot, flip: false };
};
export function viewMatrix(v, w, h) {
  return new DOMMatrix().translate(w / 2, h / 2).rotate(v.rot || 0).scale(v.zoom * (v.flip ? -1 : 1), v.zoom).translate(-v.cx, -v.cy);
}
/** New view where doc point under screen (sx, sy) stays put while zoom/rotation change. */
export function anchorView(v, next, sx, sy, w, h) {
  const d = viewMatrix(v, w, h).inverse().transformPoint(new DOMPoint(sx, sy));
  const n = { ...v, ...next };
  const lin = new DOMMatrix().rotate(n.rot || 0).scale(n.zoom * (n.flip ? -1 : 1), n.zoom).inverse();
  const off = lin.transformPoint(new DOMPoint(sx - w / 2, sy - h / 2));
  return { ...n, cx: d.x - off.x, cy: d.y - off.y };
}
const ZOOMS = [0.01, 0.02, 0.03, 0.05, 0.0667, 0.0833, 0.125, 0.1667, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64];
export const stepZoom = (z, dir) => (dir > 0 ? ZOOMS.find((s) => s > z * 1.001) || 64 : [...ZOOMS].reverse().find((s) => s < z / 1.001) || 0.01);

let checker = null;
function checkerPattern(ctx) {
  if (!checker) {
    checker = document.createElement('canvas'); checker.width = 16; checker.height = 16;
    const c = checker.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 16, 16); c.fillStyle = '#d6d6d6'; c.fillRect(0, 0, 8, 8); c.fillRect(8, 8, 8, 8);
  }
  return ctx.createPattern(checker, 'repeat');
}

const Viewport = forwardRef(function Viewport({
  renderer, doc, view, onView, tool, readOnly, rulers = false, showGuides = true, onFrame, onDropFiles, onUndo, onRedo,
  onGuidesChange, gestureRotate = false, background, spaceHeld, extraOverlay, className, onContextMenu, showSelection = true,
}, ref) {
  const wrap = useRef(null); const main = useRef(null); const over = useRef(null);
  const rulerX = useRef(null); const rulerY = useRef(null);
  const S = useRef({ dirtyMain: true, dirtyOver: true, w: 0, h: 0, hover: null, ants: 0, down: null, touches: new Map(), gesture: null, guideDrag: null });
  const props = useRef({});
  props.current = { renderer, doc, view, onView, tool, readOnly, onFrame, onUndo, onRedo, onGuidesChange, gestureRotate, background, spaceHeld, extraOverlay, rulers, showGuides, showSelection };

  const M = () => viewMatrix(props.current.view, S.current.w, S.current.h);
  const toDoc = (sx, sy) => M().inverse().transformPoint(new DOMPoint(sx, sy));
  const toScreen = (x, y) => M().transformPoint(new DOMPoint(x, y));
  const local = (e) => { const r = wrap.current.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; };

  const api = {
    draw: () => { S.current.dirtyMain = true; S.current.dirtyOver = true; },
    overlay: () => { S.current.dirtyOver = true; },
    toDoc, toScreen, matrix: M,
    size: () => ({ w: S.current.w, h: S.current.h }),
    zoomAt: (factor, sx = S.current.w / 2, sy = S.current.h / 2) => {
      const v = props.current.view;
      const z = typeof factor === 'function' ? factor(v.zoom) : v.zoom * factor;
      props.current.onView(anchorView(v, { zoom: Math.max(0.01, Math.min(64, z)) }, sx, sy, S.current.w, S.current.h));
    },
    fit: () => props.current.onView(fitView(props.current.doc, S.current.w, S.current.h, props.current.view.rot)),
    actual: () => props.current.onView({ ...props.current.view, zoom: 1 }),
    get el() { return wrap.current; },
    hover: () => S.current.hover,
  };
  useImperativeHandle(ref, () => api);

  // ---------------------------------------------------------------- sizing and the draw loop
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (!main.current || !over.current) return;
      const first = !S.current.w;
      S.current.w = width; S.current.h = height;
      const dpr = window.devicePixelRatio || 1;
      for (const c of [main.current, over.current]) { c.width = Math.round(width * dpr); c.height = Math.round(height * dpr); c.style.width = `${width}px`; c.style.height = `${height}px`; }
      S.current.dirtyMain = true; S.current.dirtyOver = true;
      if (first && props.current.doc && !props.current.view.zoom) props.current.onView(fitView(props.current.doc, width, height));
    });
    ro.observe(wrap.current);
    let raf = 0; let last = 0;
    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      const p = props.current; const s = S.current;
      if (!p.doc || !s.w || !p.view.zoom || !main.current || !over.current) return;
      p.onFrame?.();
      const r = p.renderer.flush();
      if (r || s.dirtyMain) { drawMain(); s.dirtyMain = false; if (p.rulers) drawRulers(); }
      const sel = p.showSelection && p.doc.sel;
      if (sel && t - last > 110) { s.ants = (s.ants + 1) % 8; last = t; s.dirtyOver = true; }
      if (s.dirtyOver || p.tool?.animated) { drawOverlay(); s.dirtyOver = false; }
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { S.current.dirtyMain = true; S.current.dirtyOver = true; }, [view, doc?.width, doc?.height, background, rulers]);
  useEffect(() => { S.current.dirtyOver = true; }, [doc?.sel, doc?.guides, tool, showSelection, extraOverlay]);

  function drawMain() {
    const { renderer: rd, doc: d, view: v, background: bg } = props.current;
    const c = main.current; const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg || getComputedStyle(document.documentElement).getPropertyValue('--work') || '#121318';
    ctx.fillRect(0, 0, c.width, c.height);
    const m = new DOMMatrix().scale(dpr, dpr).multiply(M());
    // shadow + checkerboard under the document (pattern in screen space so it doesn't scale)
    ctx.save();
    ctx.setTransform(m);
    ctx.beginPath(); ctx.rect(0, 0, d.width, d.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 18 * dpr; ctx.fillStyle = '#888'; ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.fillStyle = checkerPattern(ctx); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.setTransform(m);
    ctx.imageSmoothingEnabled = v.zoom < 2;
    ctx.imageSmoothingQuality = v.zoom < 0.5 ? 'medium' : 'low';
    ctx.drawImage(rd.canvas, 0, 0);
    ctx.restore();
  }

  function drawOverlay() {
    const { doc: d, tool: t, showGuides: sg, extraOverlay: ex, showSelection: ss } = props.current;
    const c = over.current; const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m = M();
    if (ss && d.sel) {
      const p = new Path2D(); p.addPath(outline(d.sel), m);
      ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.setLineDash([]); ctx.stroke(p);
      ctx.strokeStyle = '#000'; ctx.setLineDash([4, 4]); ctx.lineDashOffset = -S.current.ants; ctx.stroke(p); ctx.setLineDash([]);
    }
    if (sg) {
      const gl = [...(d.guides || []), ...(S.current.guideDrag?.temp ? [S.current.guideDrag.temp] : [])];
      ctx.strokeStyle = 'rgba(0,229,255,.9)'; ctx.lineWidth = 1;
      for (const g of gl) {
        const a = g.axis === 'x' ? m.transformPoint(new DOMPoint(g.pos, -1e5)) : m.transformPoint(new DOMPoint(-1e5, g.pos));
        const b = g.axis === 'x' ? m.transformPoint(new DOMPoint(g.pos, 1e5)) : m.transformPoint(new DOMPoint(1e5, g.pos));
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    ex?.(ctx, api);
    t?.overlay?.(ctx, api);
    const h = S.current.hover;
    const size = t?.brushSize?.();
    if (h && size && !props.current.spaceHeld?.current) {
      const r = Math.max(1, (size * props.current.view.zoom) / 2);
      ctx.beginPath(); ctx.arc(h.sx, h.sy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 1; ctx.stroke();
      if (r < 4) { ctx.beginPath(); ctx.moveTo(h.sx - 6, h.sy); ctx.lineTo(h.sx + 6, h.sy); ctx.moveTo(h.sx, h.sy - 6); ctx.lineTo(h.sx, h.sy + 6); ctx.stroke(); }
    }
  }

  function drawRulers() {
    const { doc: d, view: v } = props.current;
    for (const [cv, axis] of [[rulerX.current, 'x'], [rulerY.current, 'y']]) {
      if (!cv) continue;
      const dpr = window.devicePixelRatio || 1;
      const len = axis === 'x' ? S.current.w : S.current.h;
      cv.width = Math.round((axis === 'x' ? len : 20) * dpr); cv.height = Math.round((axis === 'x' ? 20 : len) * dpr);
      cv.style.width = `${axis === 'x' ? len : 20}px`; cv.style.height = `${axis === 'x' ? 20 : len}px`;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#1d1f26'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.strokeStyle = '#6c7184'; ctx.fillStyle = '#a8adbd'; ctx.font = '9px Inter, sans-serif'; ctx.lineWidth = 1;
      if (v.rot % 360) continue; // rulers only make sense unrotated
      const z = v.zoom * (axis === 'x' && v.flip ? -1 : 1);
      const origin = axis === 'x' ? S.current.w / 2 - v.cx * z : S.current.h / 2 - v.cy * v.zoom;
      const zz = Math.abs(z);
      const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
      const step = steps.find((s) => s * zz >= 60) || 5000;
      const start = Math.floor((-origin / (axis === 'x' ? z : v.zoom)) / step) * step - step;
      ctx.beginPath();
      for (let u = start; ; u += step / 10) {
        const p = origin + u * (axis === 'x' ? z : v.zoom);
        if ((axis === 'x' ? z : v.zoom) > 0 ? p > len : p < 0) break;
        if (u > 1e6) break;
        const major = Math.abs(Math.round(u / step) * step - u) < 1e-6;
        const tick = major ? 20 : Math.abs(Math.round(u / (step / 2)) * (step / 2) - u) < 1e-6 ? 8 : 4;
        if (axis === 'x') { ctx.moveTo(p + 0.5, 20); ctx.lineTo(p + 0.5, 20 - tick); if (major) ctx.fillText(String(Math.round(u)), p + 3, 9); }
        else { ctx.moveTo(20, p + 0.5); ctx.lineTo(20 - tick, p + 0.5); if (major) { ctx.save(); ctx.translate(9, p + 3); ctx.rotate(-Math.PI / 2); ctx.fillText(String(Math.round(u)), 0, 0); ctx.restore(); } }
      }
      ctx.stroke();
      if (d) { /* nothing else */ }
    }
  }

  // ---------------------------------------------------------------- input
  const pointOf = (e) => {
    const { sx, sy } = local(e);
    const d = toDoc(sx, sy);
    const pen = e.pointerType === 'pen';
    return {
      x: d.x, y: d.y, sx, sy, pressure: pen || e.pointerType === 'touch' ? (e.pressure || (e.pointerType === 'touch' ? 1 : 0.5)) : 1,
      tiltX: e.tiltX || 0, tiltY: e.tiltY || 0, pointerType: e.pointerType, button: e.button,
      shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey, t: e.timeStamp,
    };
  };

  const guideAt = (sx, sy) => {
    const { doc: d } = props.current;
    if (!props.current.showGuides) return null;
    const m = M();
    for (let i = (d.guides || []).length - 1; i >= 0; i--) {
      const g = d.guides[i];
      const p = m.transformPoint(new DOMPoint(g.pos, g.pos));
      if ((g.axis === 'x' && Math.abs(p.x - sx) < 4) || (g.axis === 'y' && Math.abs(p.y - sy) < 4)) return i;
    }
    return null;
  };

  const capture = (e) => { try { wrap.current.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ } };
  const startPan = (e) => {
    const s = S.current; const v = props.current.view;
    s.down = { pan: true, x: e.clientX, y: e.clientY, v };
  };
  const doPan = (e) => {
    const s = S.current; const v = s.down.v;
    const lin = new DOMMatrix().rotate(v.rot || 0).scale(v.zoom * (v.flip ? -1 : 1), v.zoom).inverse();
    const d = lin.transformPoint(new DOMPoint(e.clientX - s.down.x, e.clientY - s.down.y));
    props.current.onView({ ...v, cx: v.cx - d.x, cy: v.cy - d.y });
  };

  const onPointerDown = (e) => {
    const s = S.current; const p = props.current;
    if (e.pointerType === 'touch') {
      if (s.penActive) return; // palm rejection
      s.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
      capture(e);
      if (s.touches.size >= 2) {
        // second finger: whatever the first finger started becomes a gesture
        if (s.down?.tool) { p.tool?.cancel?.(); s.down = null; }
        s.gesture = { v: p.view, start: gestureInfo(), t0: Math.min(...[...s.touches.values()].map((q) => q.t0)), fingers: s.touches.size, moved: false };
        return;
      }
    }
    if (e.pointerType === 'pen') s.penActive = true;
    if (e.button === 2) return;
    capture(e);
    const { sx, sy } = local(e);
    if (e.button === 1 || p.spaceHeld?.current || p.tool?.id === 'hand') { e.preventDefault(); startPan(e); return; }
    if (p.onGuidesChange && !p.readOnly && (p.tool?.id === 'move' || e.ctrlKey || e.metaKey)) {
      const gi = guideAt(sx, sy);
      if (gi !== null) { s.guideDrag = { index: gi, temp: { ...p.doc.guides[gi] } }; s.down = { guide: true }; return; }
    }
    if (!p.tool?.down) return;
    s.down = { tool: true, id: e.pointerId };
    p.tool.down(pointOf(e), e, api);
    s.dirtyOver = true;
  };
  const onPointerMove = (e) => {
    const s = S.current; const p = props.current;
    if (e.pointerType === 'touch' && s.touches.has(e.pointerId)) {
      const q = s.touches.get(e.pointerId); q.x = e.clientX; q.y = e.clientY;
      if (s.gesture) {
        const g = gestureInfo(); const st = s.gesture.start;
        if (Math.hypot(g.cx - st.cx, g.cy - st.cy) > 8 || Math.abs(g.dist - st.dist) > 8) s.gesture.moved = true;
        if (!s.gesture.moved) return;
        const r = wrap.current.getBoundingClientRect();
        let v = s.gesture.v;
        const k = g.dist / Math.max(1, st.dist);
        const rotd = p.gestureRotate ? ((g.angle - st.angle) * 180) / Math.PI : 0;
        // keep the doc point under the starting centre under the moving centre
        const d0 = viewMatrix(v, s.w, s.h).inverse().transformPoint(new DOMPoint(st.cx - r.left, st.cy - r.top));
        v = { ...v, zoom: Math.max(0.01, Math.min(64, v.zoom * k)), rot: (v.rot || 0) + rotd };
        const lin = new DOMMatrix().rotate(v.rot).scale(v.zoom * (v.flip ? -1 : 1), v.zoom).inverse();
        const off = lin.transformPoint(new DOMPoint(g.cx - r.left - s.w / 2, g.cy - r.top - s.h / 2));
        p.onView({ ...v, cx: d0.x - off.x, cy: d0.y - off.y });
        return;
      }
    }
    const { sx, sy } = local(e);
    s.hover = { sx, sy };
    if (s.down?.pan) { doPan(e); return; }
    if (s.down?.guide) {
      const d = toDoc(sx, sy); const g = s.guideDrag.temp;
      g.pos = Math.round(g.axis === 'x' ? d.x : d.y); s.dirtyOver = true; return;
    }
    if (s.down?.tool) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) p.tool.move?.(pointOf(ev), ev, api);
      s.dirtyOver = true;
      return;
    }
    p.tool?.hover?.(pointOf(e), e, api);
    s.dirtyOver = true;
    // cursor feedback over guides
    if (p.onGuidesChange && p.tool?.id === 'move') { const gi = guideAt(sx, sy); wrap.current.style.cursor = gi !== null ? (p.doc.guides[gi].axis === 'x' ? 'ew-resize' : 'ns-resize') : ''; }
  };
  const onPointerUp = (e) => {
    const s = S.current; const p = props.current;
    if (e.pointerType === 'pen') s.penActive = false;
    if (e.pointerType === 'touch' && s.touches.has(e.pointerId)) {
      s.touches.delete(e.pointerId);
      if (s.gesture) {
        if (!s.touches.size) {
          const g = s.gesture; s.gesture = null;
          if (!g.moved && e.timeStamp - g.t0 < 350) { if (g.fingers === 2) p.onUndo?.(); else if (g.fingers >= 3) p.onRedo?.(); }
        } else s.gesture.fingers = Math.max(s.gesture.fingers, s.touches.size + 1);
        return;
      }
    }
    if (s.down?.guide) {
      const { index, temp } = s.guideDrag; s.guideDrag = null; s.down = null;
      const { sx, sy } = local(e);
      const outside = sx < 0 || sy < 0 || sx > s.w || sy > s.h || temp.pos < 0 || temp.pos > (temp.axis === 'x' ? p.doc.width : p.doc.height);
      const list = [...(p.doc.guides || [])];
      if (index === -1) { if (!outside) list.push(temp); } else if (outside) list.splice(index, 1); else list[index] = temp;
      p.onGuidesChange?.(list);
      s.dirtyOver = true;
      return;
    }
    if (s.down?.tool) p.tool?.up?.(pointOf(e), e, api);
    s.down = null;
    s.dirtyOver = true;
  };
  const gestureInfo = () => {
    const pts = [...S.current.touches.values()];
    const a = pts[0]; const b = pts[1] || pts[0];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  };

  const onWheel = (e) => {
    const p = props.current; const s = S.current;
    const { sx, sy } = local(e);
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const f = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.012 : 0.004));
      api.zoomAt(f, sx, sy);
    } else {
      const v = p.view;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX; const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      const lin = new DOMMatrix().rotate(v.rot || 0).scale(v.zoom * (v.flip ? -1 : 1), v.zoom).inverse();
      const d = lin.transformPoint(new DOMPoint(dx, dy));
      p.onView({ ...v, cx: v.cx + d.x, cy: v.cy + d.y });
    }
    s.dirtyOver = true;
  };
  useEffect(() => {
    const el = wrap.current;
    const w = (e) => { e.preventDefault(); onWheel(e); };
    el.addEventListener('wheel', w, { passive: false });
    // Safari trackpad pinch
    const gs = (e) => e.preventDefault();
    el.addEventListener('gesturestart', gs);
    return () => { el.removeEventListener('wheel', w); el.removeEventListener('gesturestart', gs); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startRulerGuide = (axis) => (e) => {
    const p = props.current;
    if (p.readOnly || !p.onGuidesChange) return;
    e.preventDefault();
    capture(e);
    S.current.guideDrag = { index: -1, temp: { axis, pos: -1 } };
    S.current.down = { guide: true };
  };

  const cursor = tool?.brushSize?.() ? 'none' : tool?.cursor || 'default';
  return (
    <div className={`absolute inset-0 flex flex-col ${className || ''}`}>
      {rulers && (
        <div className="h-5 shrink-0 flex">
          <div className="w-5 h-5 bg-panel border-r border-b border-line" />
          <canvas ref={rulerX} className="flex-1 h-5 border-b border-line cursor-s-resize" onPointerDown={startRulerGuide('y')} />
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        {rulers && <canvas ref={rulerY} className="w-5 shrink-0 border-r border-line cursor-e-resize" onPointerDown={startRulerGuide('x')} />}
        <div ref={wrap} className="relative flex-1 min-w-0 overflow-hidden touch-none" style={{ cursor }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onPointerLeave={() => { S.current.hover = null; S.current.dirtyOver = true; }}
          onContextMenu={(e) => { e.preventDefault(); onContextMenu?.(e, pointOf(e)); }}
          onDragOver={(e) => { if (onDropFiles && e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
          onDrop={(e) => { if (!onDropFiles || !e.dataTransfer?.files?.length) return; e.preventDefault(); const { sx, sy } = local(e); onDropFiles([...e.dataTransfer.files], toDoc(sx, sy)); }}>
          <canvas ref={main} className="absolute inset-0" />
          <canvas ref={over} className="absolute inset-0 pointer-events-none" />
        </div>
      </div>
    </div>
  );
});
export default Viewport;
