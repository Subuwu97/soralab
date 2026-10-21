// The 2D rig's workspace: the WebGL view of the model with an overlay for meshes, deformer handles and tool feedback,
// and the pointer tools —
//   Select (V)  pick parts (click; Shift adds), drag to move a part or a deformer's rest position
//   Mesh (M)    rest-pose mesh editing: click empty space inside the part to add a vertex, drag vertices, Delete removes
//   Deform (D)  shape the selected part / deformer at the current parameter key (records a keyform); soft falloff
//   Lasso (L)   draw around an area of the selected part to split it into its own part
//   Fill behind (F)  paint where hidden colour is needed; the texture's edge colours grow into the brushed area
//   Hand (H, or hold Space) pans; the wheel zooms.
import { useEffect, useRef, useState } from 'react';
import { useSize, toast } from '../../../components/ui.jsx';
import { useKeyHeld } from '../../../lib/shortcuts.js';
import { Renderer2D } from './render.js';
import { evaluate, jacobian, invMap, warpScreenPts, rotationHandles, mapThrough } from './deform.js';
import { PhysicsSim } from './physics.js';
import { cachedPixels, texPixels } from './textures.js';
import { defaults, warpRest } from './model.js';
import { bary } from './mesh.js';

const ACCENT = '#5AB4FF'; const PIN = '#ff8fb1'; const WARP = '#ffc36b';

export default function Viewport({
  doc, values, tool, canEdit, sel, setSel, vsel, setVsel, opts, editTarget, physics, view, setView,
  onMovePart, onMoveDeformer, onMesh, onForm, onCommit, onLasso, onFill, onPick,
}) {
  const box = useRef(null); const glc = useRef(null); const ovc = useRef(null);
  const size = useSize(box);
  const dpr = window.devicePixelRatio || 1;
  const W = size.width || 800; const H = size.height || 600;
  const r = useRef(null); const ev = useRef(null); const sim = useRef(new PhysicsSim());
  const drag = useRef(null);
  const space = useKeyHeld('space');
  const [hover, setHover] = useState(null); const [cursor, setCursor] = useState(null);
  const [live, setLive] = useState(null); // lasso points / brush points in canvas space
  const [, bump] = useState(0);
  const rest = tool === 'mesh' || tool === 'lasso' || tool === 'fill';
  const shownValues = useRef(values);

  // fit the canvas on first show
  useEffect(() => {
    if (!view && size.width) setView({ s: Math.min((W - 40) / doc.width, (H - 40) / doc.height), tx: (W - doc.width * Math.min((W - 40) / doc.width, (H - 40) / doc.height)) / 2, ty: 20 });
  }, [size.width, size.height, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = view || { s: 0.25, tx: 0, ty: 0 };

  useEffect(() => {
    try { r.current = new Renderer2D(glc.current, { onTexture: () => bump((n) => n + 1) }); } catch (e) { toast(e.message, { type: 'error' }); }
    return () => r.current?.dispose();
  }, []);
  // texture pixels for picking and the texture tools
  useEffect(() => { for (const p of doc.parts) if (p.tex && !cachedPixels(p.tex)) texPixels(p.tex).catch(() => {}); }, [doc.parts]);

  // ---------------------------------------------------------------- drawing
  const draw = () => {
    const gl = glc.current; const ov = ovc.current; if (!gl || !ov || !r.current) return;
    const cw = Math.round(W * dpr); const ch = Math.round(H * dpr);
    if (gl.width !== cw || gl.height !== ch) { gl.width = cw; gl.height = ch; }
    if (ov.width !== cw || ov.height !== ch) { ov.width = cw; ov.height = ch; }
    let vals = rest ? defaults(doc) : values;
    if (physics && !rest) { vals = { ...values }; sim.current.step(doc, vals, 1 / 60); }
    shownValues.current = vals;
    ev.current = evaluate(doc, vals, ev.current);
    r.current.prune(doc);
    r.current.draw(doc, ev.current, { s: v.s * dpr, tx: v.tx * dpr, ty: v.ty * dpr }, { bg: null });
    drawOverlay(ov.getContext('2d'));
  };
  const S = (p) => [v.tx + p[0] * v.s, v.ty + p[1] * v.s];
  function drawOverlay(ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    // canvas bounds
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([4, 4]); ctx.strokeRect(v.tx + 0.5, v.ty + 0.5, doc.width * v.s, doc.height * v.s); ctx.setLineDash([]);
    const e = ev.current; if (!e) return;
    const part = sel?.type === 'part' ? doc.parts.find((p) => p.id === sel.id) : null;
    const def = sel?.type === 'deformer' ? doc.deformers.find((d) => d.id === sel.id) : null;
    if (hover && hover !== sel?.id && tool === 'select') { const st = e.parts.get(hover); if (st) outline(ctx, st.verts, 'rgba(90,180,255,.55)'); }
    for (const id of sel?.more || []) { const st = e.parts.get(id); if (st) outline(ctx, st.verts, 'rgba(90,180,255,.7)'); }
    if (part) {
      const st = e.parts.get(part.id);
      if (st && part.mesh) {
        const showMesh = tool === 'mesh' || tool === 'deform' || opts.showMesh;
        if (showMesh) {
          ctx.strokeStyle = 'rgba(90,180,255,.55)'; ctx.lineWidth = 1; ctx.beginPath();
          const t = part.mesh.t; const vv = st.verts;
          for (let i = 0; i < t.length; i += 3) { const a = S([vv[t[i] * 2], vv[t[i] * 2 + 1]]); const b = S([vv[t[i + 1] * 2], vv[t[i + 1] * 2 + 1]]); const c = S([vv[t[i + 2] * 2], vv[t[i + 2] * 2 + 1]]); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.closePath(); }
          ctx.stroke();
          const pins = new Set(part.mesh.pins || []);
          for (let i = 0; i < vv.length; i += 2) {
            const p = S([vv[i], vv[i + 1]]); const k = i / 2;
            ctx.fillStyle = vsel.has(k) ? '#fff' : pins.has(k) ? PIN : ACCENT;
            ctx.beginPath(); ctx.arc(p[0], p[1], vsel.has(k) ? 4 : 2.6, 0, 7); ctx.fill();
            if (pins.has(k)) { ctx.strokeStyle = PIN; ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 7); ctx.stroke(); }
          }
        } else outline(ctx, st.verts, ACCENT);
      }
    }
    if (def) {
      if (def.type === 'warp') {
        const pts = warpScreenPts(e.deformers, def).map(S); const Wc = def.cols + 1;
        ctx.strokeStyle = WARP; ctx.lineWidth = 1.2; ctx.beginPath();
        for (let j = 0; j <= def.rows; j++) for (let i = 0; i <= def.cols; i++) { const p = pts[j * Wc + i]; if (i) { ctx.moveTo(...pts[j * Wc + i - 1]); ctx.lineTo(...p); } if (j) { ctx.moveTo(...pts[(j - 1) * Wc + i]); ctx.lineTo(...p); } }
        ctx.stroke();
        pts.forEach((p, k) => { ctx.fillStyle = vsel.has(k) ? '#fff' : WARP; ctx.fillRect(p[0] - 3, p[1] - 3, 6, 6); });
      } else {
        const hd = rotationHandles(e.deformers, def, 100 / v.s);
        if (hd) {
          const p = S(hd.pivot); const q = S(hd.handle);
          ctx.strokeStyle = WARP; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.stroke();
          ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 7); ctx.stroke(); ctx.fillStyle = WARP; ctx.beginPath(); ctx.arc(q[0], q[1], 5, 0, 7); ctx.fill();
        }
      }
    }
    if (live?.kind === 'lasso' && live.pts.length > 1) {
      ctx.strokeStyle = '#fff'; ctx.setLineDash([5, 4]); ctx.beginPath(); live.pts.forEach((p, i) => (i ? ctx.lineTo(...S(p)) : ctx.moveTo(...S(p)))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    }
    if (live?.kind === 'fill') { ctx.fillStyle = 'rgba(255,195,107,.35)'; for (const p of live.pts) { const q = S(p); ctx.beginPath(); ctx.arc(q[0], q[1], opts.brush * v.s, 0, 7); ctx.fill(); } }
    if (cursor && tool === 'fill') { ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(cursor[0], cursor[1], opts.brush * v.s, 0, 7); ctx.stroke(); }
    if (cursor && tool === 'deform' && opts.soft > 0) { ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(cursor[0], cursor[1], opts.soft * v.s, 0, 7); ctx.stroke(); }
  }
  function outline(ctx, verts, color) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (let i = 0; i < verts.length; i += 2) { x0 = Math.min(x0, verts[i]); x1 = Math.max(x1, verts[i]); y0 = Math.min(y0, verts[i + 1]); y1 = Math.max(y1, verts[i + 1]); }
    if (x0 === Infinity) return;
    const a = S([x0, y0]); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.strokeRect(a[0], a[1], (x1 - x0) * v.s, (y1 - y0) * v.s);
  }
  // draw whenever something changes; keep animating while physics previews
  useEffect(() => {
    let raf = requestAnimationFrame(function f() { draw(); if (physics && !rest) raf = requestAnimationFrame(f); });
    return () => cancelAnimationFrame(raf);
  });

  // ---------------------------------------------------------------- picking
  const toCanvas = (e) => { const b = box.current.getBoundingClientRect(); return [(e.clientX - b.left - v.tx) / v.s, (e.clientY - b.top - v.ty) / v.s]; };
  const toLocal = (e) => { const b = box.current.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  function pickPart(p) {
    const e = ev.current; if (!e) return null;
    for (let k = e.order.length - 1; k >= 0; k--) {
      const id = e.order[k]; const part = doc.parts.find((x) => x.id === id); const st = e.parts.get(id);
      if (!part?.mesh || !st.visible || st.opacity < 0.05) continue;
      const t = part.mesh.t; const vv = st.verts;
      for (let i = 0; i < t.length; i += 3) {
        const w = bary(p, [vv[t[i] * 2], vv[t[i] * 2 + 1]], [vv[t[i + 1] * 2], vv[t[i + 1] * 2 + 1]], [vv[t[i + 2] * 2], vv[t[i + 2] * 2 + 1]]);
        if (!w) continue;
        // the texture must actually show something there
        const px = cachedPixels(part.tex); if (!px) return id;
        const rv = part.mesh.v;
        const ux = w[0] * rv[t[i] * 2] + w[1] * rv[t[i + 1] * 2] + w[2] * rv[t[i + 2] * 2] - part.x;
        const uy = w[0] * rv[t[i] * 2 + 1] + w[1] * rv[t[i + 1] * 2 + 1] + w[2] * rv[t[i + 2] * 2 + 1] - part.y;
        const xi = Math.floor((ux / part.w) * px.width); const yi = Math.floor((uy / part.h) * px.height);
        if (xi >= 0 && yi >= 0 && xi < px.width && yi < px.height && px.data[(yi * px.width + xi) * 4 + 3] > 24) return id;
        break;
      }
    }
    return null;
  }
  const nearestVertex = (verts, p, r = 9 / v.s) => { let best = -1; let bd = r * r; for (let i = 0; i < verts.length; i += 2) { const d = (verts[i] - p[0]) ** 2 + (verts[i + 1] - p[1]) ** 2; if (d < bd) { bd = d; best = i / 2; } } return best; };

  // ---------------------------------------------------------------- pointer
  const selPart = sel?.type === 'part' ? doc.parts.find((p) => p.id === sel.id) : null;
  const selDef = sel?.type === 'deformer' ? doc.deformers.find((d) => d.id === sel.id) : null;
  const down = (e) => {
    if (e.button === 1 || tool === 'hand' || space.current) {
      const s0 = toLocal(e); const v0 = v;
      drag.current = { kind: 'pan', move: (ee) => { const s1 = toLocal(ee); setView({ ...v0, tx: v0.tx + s1[0] - s0[0], ty: v0.ty + s1[1] - s0[1] }); } };
      box.current.setPointerCapture(e.pointerId); return;
    }
    if (e.button !== 0) return;
    const p = toCanvas(e); const key = `drag-${Date.now()}`;
    if (tool === 'select') {
      // deformer handles first when one is selected
      if (selDef && canEdit && hitDeformer(selDef, p)) { startMoveDeformer(selDef, p, key); box.current.setPointerCapture(e.pointerId); return; }
      const id = pickPart(p);
      if (!id) { setSel(null); return; }
      if (e.shiftKey && sel?.type === 'part') { setSel({ ...sel, more: [...new Set([...(sel.more || []), id])].filter((x) => x !== sel.id) }); return; }
      setSel({ type: 'part', id }); onPick?.(id);
      if (!canEdit) return;
      drag.current = { kind: 'move', move: (ee) => { const q = toCanvas(ee); onMovePart(id, q[0] - p[0], q[1] - p[1], key); }, up: onCommit };
      box.current.setPointerCapture(e.pointerId); return;
    }
    if (!canEdit) return;
    if (tool === 'mesh') {
      if (!selPart?.mesh) { const id = pickPart(p); if (id) setSel({ type: 'part', id }); return; }
      const vv = selPart.mesh.v; const k = nearestVertex(vv, p);
      if (k >= 0) {
        const nv = e.shiftKey ? new Set(vsel) : new Set(); if (e.shiftKey && vsel.has(k)) nv.delete(k); else nv.add(k);
        setVsel(nv);
        const moving = [...(e.shiftKey ? nv : new Set([...nv, k]))]; const start = vv.slice();
        drag.current = { kind: 'mesh', move: (ee) => { const q = toCanvas(ee); const nvv = start.slice(); for (const i of moving) { nvv[i * 2] = start[i * 2] + q[0] - p[0]; nvv[i * 2 + 1] = start[i * 2 + 1] + q[1] - p[1]; } onMesh(selPart.id, { ...selPart.mesh, v: nvv.map((x) => Math.round(x * 10) / 10) }, 'Move vertices', key); }, up: onCommit };
      } else if (p[0] >= selPart.x - 4 && p[1] >= selPart.y - 4 && p[0] <= selPart.x + selPart.w + 4 && p[1] <= selPart.y + selPart.h + 4) {
        onMesh(selPart.id, { ...selPart.mesh, v: [...vv, Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] }, 'Add vertex', null, { retriangulate: true });
        setVsel(new Set([vv.length / 2]));
      } else setVsel(new Set());
      box.current.setPointerCapture(e.pointerId); return;
    }
    if (tool === 'deform') {
      const obj = selPart || selDef;
      if (!obj) { const id = pickPart(p); if (id) setSel({ type: 'part', id }); return; }
      const target = editTarget(obj); if (!target) return;
      startDeform(obj, target, p, e, key);
      box.current.setPointerCapture(e.pointerId); return;
    }
    if (tool === 'lasso' || tool === 'fill') {
      if (!selPart) { const id = pickPart(p); if (id) setSel({ type: 'part', id }); else toast('Click a part first, then draw on it.'); return; }
      const kind = tool; const pts = [p]; setLive({ kind, pts: [...pts] });
      drag.current = {
        kind, move: (ee) => { const q = toCanvas(ee); const last = pts[pts.length - 1]; if (Math.hypot(q[0] - last[0], q[1] - last[1]) > (kind === 'fill' ? opts.brush / 3 : 3 / v.s)) { pts.push(q); setLive({ kind, pts: [...pts] }); } },
        up: () => { setLive(null); if (kind === 'lasso') { if (pts.length > 2) onLasso(selPart.id, pts); } else onFill(selPart.id, pts, opts.brush); },
      };
      box.current.setPointerCapture(e.pointerId);
    }
  };

  function hitDeformer(d, p) {
    const e = ev.current; const tol = 10 / v.s;
    if (d.type === 'rotation') { const hd = rotationHandles(e.deformers, d, 100 / v.s); return hd && (Math.hypot(p[0] - hd.pivot[0], p[1] - hd.pivot[1]) < tol || Math.hypot(p[0] - hd.handle[0], p[1] - hd.handle[1]) < tol); }
    const pts = warpScreenPts(e.deformers, d); return pts.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol) || (p[0] > d.rect[0] && p[1] > d.rect[1] && p[0] < d.rect[0] + d.rect[2] && p[1] < d.rect[1] + d.rect[3]);
  }
  function startMoveDeformer(d, p, key) {
    // rest edit: a warp's rectangle moves (corner handles resize it), a rotation's pivot moves
    const corner = d.type === 'warp' ? cornerAt(d, p) : -1;
    drag.current = { kind: 'def', move: (ee) => { const q = toCanvas(ee); onMoveDeformer(d.id, q[0] - p[0], q[1] - p[1], corner, key); }, up: onCommit };
  }
  const cornerAt = (d, p) => { const [x, y, w, h] = d.rect; const cs = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]; return cs.findIndex((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) < 10 / v.s); };

  function startDeform(obj, target, p, e, key) {
    const e0 = ev.current; const states = e0.deformers;
    const b = (obj.kf || []).find((x) => x.params.join('|') === target.params.join('|'));
    const start = { ...(b?.forms[target.key] || {}) };
    if (obj.type === 'rotation') {
      const hd = rotationHandles(states, obj, 100 / v.s); if (!hd) return;
      const onPivot = Math.hypot(p[0] - hd.pivot[0], p[1] - hd.pivot[1]) < 10 / v.s;
      const a0 = Math.atan2(p[1] - hd.pivot[1], p[0] - hd.pivot[0]);
      drag.current = { kind: 'form', move: (ee) => {
        const q = toCanvas(ee);
        if (onPivot) { const J = jacobian(states, obj.parent, obj.pivot[0], obj.pivot[1]); const [dx, dy] = invMap(J, q[0] - p[0], q[1] - p[1]); onForm(obj.id, target, (f) => ({ ...f, x: (start.x || 0) + dx, y: (start.y || 0) + dy }), key); return; }
        let da = (Math.atan2(q[1] - hd.pivot[1], q[0] - hd.pivot[0]) - a0) * (180 / Math.PI);
        if (da > 180) da -= 360; if (da < -180) da += 360;
        onForm(obj.id, target, (f) => ({ ...f, a: Math.round(((start.a || 0) + da) * 10) / 10 }), key);
      }, up: onCommit };
      return;
    }
    // points that move: warp grid points or mesh vertices, before their parent chain
    const isWarp = obj.type === 'warp';
    const restPts = isWarp ? Array.from(warpRest(obj)) : obj.mesh.v;
    const pre = restPts.map((x, i) => x + (start.v?.[i] || 0));
    const screen = isWarp ? warpScreenPts(states, obj).flat() : Array.from(e0.parts.get(obj.id).verts);
    let picked = nearestVertex(screen, p);
    const pins = new Set(obj.mesh?.pins || []);
    let weights;
    if (vsel.size && (picked < 0 || vsel.has(picked))) weights = new Map([...vsel].map((k) => [k, 1]));
    else {
      if (picked < 0 && opts.soft <= 0) { toast('Grab a vertex (or turn up the soft radius).'); return; }
      weights = new Map();
      const R = Math.max(opts.soft, 1);
      for (let k = 0; k < screen.length / 2; k++) {
        const d = Math.hypot(screen[k * 2] - p[0], screen[k * 2 + 1] - p[1]);
        if (k === picked) weights.set(k, 1); else if (opts.soft > 0 && d < R) weights.set(k, 0.5 + 0.5 * Math.cos((d / R) * Math.PI));
      }
      if (picked >= 0 && opts.soft <= 0) setVsel(new Set([picked]));
    }
    for (const k of pins) weights.delete(k);
    if (!weights.size) return;
    const parent = obj.parent;
    const Js = new Map([...weights.keys()].map((k) => [k, jacobian(states, parent, pre[k * 2], pre[k * 2 + 1])]));
    drag.current = { kind: 'form', move: (ee) => {
      const q = toCanvas(ee); const dx = q[0] - p[0]; const dy = q[1] - p[1];
      onForm(obj.id, target, (f) => {
        const nv = (start.v ? start.v.slice() : new Array(restPts.length).fill(0));
        while (nv.length < restPts.length) nv.push(0);
        for (const [k, w] of weights) { const [rx, ry] = invMap(Js.get(k), dx * w, dy * w); nv[k * 2] = (start.v?.[k * 2] || 0) + rx; nv[k * 2 + 1] = (start.v?.[k * 2 + 1] || 0) + ry; }
        return { ...f, v: nv };
      }, key);
    }, up: onCommit };
  }

  const move = (e) => {
    const l = toLocal(e); setCursor(l);
    if (drag.current) { drag.current.move(e); return; }
    if (tool === 'select') { const id = pickPart(toCanvas(e)); if (id !== hover) setHover(id); }
  };
  const up = (e) => { const d = drag.current; drag.current = null; d?.up?.(e); };
  const wheel = (e) => {
    const l = toLocal(e); const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const s = Math.max(0.02, Math.min(16, v.s * f));
    setView({ s, tx: l[0] - ((l[0] - v.tx) * s) / v.s, ty: l[1] - ((l[1] - v.ty) * s) / v.s });
  };
  useEffect(() => { const el = box.current; const f = (e) => { e.preventDefault(); wheel(e); }; el.addEventListener('wheel', f, { passive: false }); return () => el.removeEventListener('wheel', f); });

  const cur = tool === 'hand' || space.current ? 'grab' : tool === 'select' ? 'default' : tool === 'fill' ? 'none' : 'crosshair';
  return (
    <div ref={box} className="absolute inset-0 overflow-hidden" style={{ cursor: cur, background: 'repeating-conic-gradient(#1b1c22 0% 25%, #16171c 0% 50%) 50% / 24px 24px' }}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={() => setCursor(null)} data-testid="av-viewport">
      <canvas ref={glc} className="absolute inset-0 w-full h-full" data-testid="av-gl" />
      <canvas ref={ovc} className="absolute inset-0 w-full h-full pointer-events-none" />
      {rest && <div className="absolute top-2 left-2 text-[11px] text-fg2 bg-panel/80 rounded px-2 py-0.5 pointer-events-none">Rest pose (mesh and texture tools work on the unposed model)</div>}
    </div>
  );
}
export { mapThrough };
