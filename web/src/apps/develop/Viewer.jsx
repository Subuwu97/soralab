// The Develop view's image: a WebGL2 canvas with overlays for crop, local masks (linear / radial / brush), the
// white-balance eyedropper and the before/after split. Zoom with Z (fit ↔ 1:1), the mouse wheel, or drag to pan.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Spinner, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { Renderer, fragToQ } from './engine.js';
import { frameOf, cropRectInFull, cropFromFullRect, constrainCrop, aspectValue, orientedSize, apply, inv, mul, neutralize, toLinear, clamp, isRaw } from './model.js';
import { loadPhotoImage, getAsset, brushCanvas, drawStroke, loadLut, BRUSH_EDGE } from './media.js';

export default function Viewer({
  photo, settings, tool, maskSel, brush, before, split, setSplit, zoom, setZoom, clip, showOverlay, readOnly,
  onCrop, onMask, onAddMask, onWB, onHistogram, onSizeKnown,
}) {
  const box = useRef(null);
  const canvas = useRef(null);
  const r = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [status, setStatus] = useState({ loading: true });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState(null); // brush cursor
  const img = useRef(null);
  const [glError, setGlError] = useState(null);
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    try { r.current = new Renderer(canvas.current); if (import.meta.env.DEV) window.__hikari = r.current; } catch (e) { setGlError(e.message); }
    return () => { r.current?.dispose(); r.current = null; };
  }, []);

  // Load the photo.
  const [srcKey, setSrcKey] = useState(null);
  useEffect(() => {
    let off = false;
    setStatus({ loading: true });
    setSrcKey(null);
    (async () => {
      try {
        const a = await getAsset(photo.asset_id, { fresh: true });
        if (a.web_status === 'processing') setStatus({ loading: true, processing: true });
        const im = await loadPhotoImage(photo.asset_id);
        if (off || !r.current) return;
        await r.current.setSource(im);
        if (off) return;
        img.current = im;
        onSizeKnown?.(photo, im.naturalWidth, im.naturalHeight);
        setSrcKey(photo.asset_id);
        setStatus({ loading: false });
      } catch (e) { if (!off) setStatus({ loading: false, error: e.message }); }
    })();
    return () => { off = true; };
  }, [photo.asset_id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPan({ x: 0, y: 0 }); }, [photo.id]);

  const sw = r.current?.w || photo.width || 1; const sh = r.current?.h || photo.height || 1;
  const cropMode = tool === 'crop';
  const frame = useMemo(() => frameOf(sw, sh, settings, { full: cropMode }), [sw, sh, settings.crop, settings.orient, cropMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // View: fit, or a zoom factor (1 = one image pixel per device pixel).
  const pad = cropMode ? 48 : 24;
  const fit = Math.max(0.01, Math.min((size.w - pad * 2) / frame.outW, (size.h - pad * 2) / frame.outH));
  const s = zoom === 'fit' ? fit : zoom / dpr;
  const iw = frame.outW * s; const ih = frame.outH * s;
  const clampPan = (p) => ({ x: iw <= size.w ? 0 : clamp(p.x, (size.w - iw) / 2, (iw - size.w) / 2), y: ih <= size.h ? 0 : clamp(p.y, (size.h - ih) / 2, (ih - size.h) / 2) });
  const P = clampPan(pan);
  const ox = (size.w - iw) / 2 + P.x; const oy = (size.h - ih) / 2 + P.y;
  const V = useMemo(() => [1 / iw, 0, -ox / iw, 0, 1 / ih, -oy / ih], [iw, ih, ox, oy]);
  const toSrc = useCallback((x, y) => { const [qx, qy] = apply(V, x, y); return apply(frame.M, qx, qy); }, [V, frame]);
  const fromSrcM = useMemo(() => inv(mul(frame.M, V)), [frame, V]);
  const fromSrc = useCallback((u, v) => apply(fromSrcM, u, v), [fromSrcM]);

  // Brush mask rasters (rebuilt when strokes change; painting updates them incrementally).
  const brushes = useRef(new Map()); // mask id → { strokes, canvas }
  useEffect(() => {
    const ren = r.current;
    if (!ren?.src) return;
    const seen = new Set();
    for (const m of settings.masks || []) {
      if (m.type !== 'brush') continue;
      seen.add(m.id);
      let b = brushes.current.get(m.id);
      if (!b || b.strokes !== m.strokes || b.src !== srcKey) {
        b = { strokes: m.strokes, src: srcKey, canvas: brushCanvas(m, ren.w, ren.h, BRUSH_EDGE, b?.canvas) };
        brushes.current.set(m.id, b);
        b.dirty = true;
      }
      if (b.dirty || b.channel !== m.channel) { ren.setBrush(m.channel ?? 0, b.canvas); b.dirty = false; b.channel = m.channel; }
    }
    for (const id of [...brushes.current.keys()]) if (!seen.has(id)) brushes.current.delete(id);
  }, [settings.masks, srcKey]);

  // LUT profile
  const [lutReady, setLutReady] = useState(null);
  useEffect(() => {
    const id = settings.lut?.asset_id;
    if (!id) return;
    let off = false;
    loadLut(id).then((l) => { if (!off && r.current) { r.current.setLut(l, id); setLutReady(id); } }).catch(() => {});
    return () => { off = true; };
  }, [settings.lut?.asset_id]);

  // Draw: draft while things are changing, full quality when they settle.
  const lastChange = useRef(0);
  const prevSettings = useRef(null);
  const raf = useRef(0);
  const idleTimer = useRef(0);
  const splitQ = before === 'full' ? 2 : before === 'split' ? (split * size.w - ox) / iw : -1;
  const showMaskIdx = showOverlay && maskSel ? (settings.masks || []).filter((m) => m.visible !== false).findIndex((m) => m.id === maskSel) : -1;
  const drawNow = useCallback((draft) => {
    const ren = r.current;
    if (!ren?.src || !size.w) return;
    const W = Math.round(size.w * dpr); const H = Math.round(size.h * dpr);
    ren.draw({ settings, frame, Q: fragToQ(V, H, dpr), width: W, height: H, draft, split: splitQ, clip, showMask: showMaskIdx, lutOn: !!settings.lut && lutReady === settings.lut.asset_id });
    onHistogram?.(ren.histogram());
  }, [settings, frame, V, size, dpr, splitQ, clip, showMaskIdx, lutReady, onHistogram]);
  useEffect(() => {
    if (!srcKey) return undefined;
    const changed = prevSettings.current && prevSettings.current.id === photo.id && prevSettings.current.s !== settings;
    prevSettings.current = { id: photo.id, s: settings };
    if (changed) lastChange.current = performance.now();
    const draft = performance.now() - lastChange.current < 250;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => drawNow(draft));
    clearTimeout(idleTimer.current);
    if (draft) idleTimer.current = setTimeout(() => drawNow(false), 260);
    return undefined;
  }, [drawNow, srcKey, photo.id, settings]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); clearTimeout(idleTimer.current); }, []);

  // ---------------------------------------------------------------- pointer interactions
  const drag = useRef(null);
  const local = (e) => { const b = box.current.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const activeMask = (settings.masks || []).find((m) => m.id === maskSel);
  const L = Math.max(sw, sh);

  const startDrag = (e, kind, data = {}) => {
    e.stopPropagation(); e.preventDefault();
    const [x, y] = local(e);
    drag.current = { kind, x0: x, y0: y, ...data };
    box.current.setPointerCapture?.(e.pointerId);
  };

  const onDown = (e) => {
    if (e.button !== 0 || status.loading) return;
    const [x, y] = local(e);
    const [u, v] = toSrc(x, y);
    const inside = u >= 0 && v >= 0 && u <= 1 && v <= 1;
    if (tool === 'wb' && inside && !readOnly) {
      // Average a 5×5 patch of the original and neutralise it.
      const c = document.createElement('canvas'); c.width = 5; c.height = 5;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const im = img.current; const kx = im.naturalWidth / sw; const ky = im.naturalHeight / sh;
      ctx.drawImage(im, u * sw * kx - 2.5 * kx, v * sh * ky - 2.5 * ky, 5 * kx, 5 * ky, 0, 0, 5, 5);
      const d = ctx.getImageData(0, 0, 5, 5).data;
      let R = 0; let G = 0; let B = 0;
      for (let i = 0; i < d.length; i += 4) { R += toLinear(d[i] / 255); G += toLinear(d[i + 1] / 255); B += toLinear(d[i + 2] / 255); }
      onWB?.(neutralize(R, G, B));
      return;
    }
    if (['linear', 'radial'].includes(tool) && !readOnly) {
      startDrag(e, `new-${tool}`, { u0: u, v0: v });
      return;
    }
    if (tool === 'brush' && !readOnly && activeMask?.type === 'brush') {
      const erase = e.altKey || brush.erase;
      const stroke = { size: brush.size / L, feather: brush.feather, flow: brush.flow, erase, pts: [+u.toFixed(5), +v.toFixed(5)] };
      startDrag(e, 'paint', { stroke, mask: activeMask });
      paintTo(stroke, 0);
      return;
    }
    if (before === 'split' && Math.abs(x - split * size.w) < 8) { startDrag(e, 'split'); return; }
    // Pan when the image is bigger than the view.
    if (iw > size.w || ih > size.h) startDrag(e, 'pan', { p0: P });
  };

  const paintTo = (stroke, from) => {
    const b = brushes.current.get(drag.current.mask.id);
    if (!b) return;
    const ctx = b.canvas.getContext('2d');
    drawStroke(ctx, stroke, b.canvas.width, b.canvas.height, from);
    r.current.setBrush(drag.current.mask.channel ?? 0, b.canvas);
    drawNow(true);
  };

  const onMove = (e) => {
    const [x, y] = local(e);
    if (tool === 'brush') setHover({ x, y });
    const d = drag.current;
    if (!d) return;
    const dx = x - d.x0; const dy = y - d.y0;
    if (d.kind === 'pan') setPan(clampPan({ x: d.p0.x + dx, y: d.p0.y + dy }));
    else if (d.kind === 'split') setSplit(clamp(x / size.w, 0.02, 0.98));
    else if (d.kind === 'paint') {
      const [u, v] = toSrc(x, y);
      const n = d.stroke.pts.length;
      d.stroke.pts.push(+u.toFixed(5), +v.toFixed(5));
      paintTo(d.stroke, n);
    } else if (d.kind === 'new-radial' || d.kind === 'new-linear') {
      if (Math.hypot(dx, dy) < 4) return;
      const [u, v] = toSrc(x, y);
      let geo;
      if (d.kind === 'new-linear') geo = { x0: d.u0, y0: d.v0, x1: u, y1: v };
      else {
        // Axis-aligned on screen: the screen x direction in source space gives the angle.
        const [ua, va] = toSrc(d.x0 + 1, d.y0); const ang = Math.atan2((va - d.v0) * sh, (ua - d.u0) * sw);
        const pxPerScreen = Math.hypot((ua - d.u0) * sw, (va - d.v0) * sh);
        geo = { cx: d.u0, cy: d.v0, rx: Math.max(4, Math.abs(dx)) * pxPerScreen / L, ry: Math.max(4, Math.abs(dy)) * pxPerScreen / L, angle: (ang * 180) / Math.PI, feather: 50 };
      }
      if (!d.created) { d.created = onAddMask?.(d.kind.slice(4), geo); }
      else onMask?.({ ...d.created, geo }, false);
      if (d.created) d.created = { ...d.created, geo };
    } else if (d.kind === 'mask-handle') {
      const [u, v] = toSrc(x, y);
      const m = d.mask; const g = { ...m.geo };
      if (m.type === 'linear') {
        if (d.h === 'p0') { g.x0 = u; g.y0 = v; } else if (d.h === 'p1') { g.x1 = u; g.y1 = v; } else {
          const [u0, v0] = toSrc(d.x0, d.y0); const du = u - u0; const dv = v - v0;
          g.x0 = m.geo.x0 + du; g.y0 = m.geo.y0 + dv; g.x1 = m.geo.x1 + du; g.y1 = m.geo.y1 + dv;
        }
      } else {
        const px = (u - m.geo.cx) * sw; const py = (v - m.geo.cy) * sh;
        const a = (m.geo.angle * Math.PI) / 180;
        const along = px * Math.cos(a) + py * Math.sin(a); const across = -px * Math.sin(a) + py * Math.cos(a);
        if (d.h === 'center') { const [u0, v0] = toSrc(d.x0, d.y0); g.cx = m.geo.cx + u - u0; g.cy = m.geo.cy + v - v0; }
        else if (d.h === 'rx') g.rx = Math.max(2, Math.abs(along)) / L;
        else if (d.h === 'ry') g.ry = Math.max(2, Math.abs(across)) / L;
        else if (d.h === 'rot') g.angle = (Math.atan2(py, px) * 180) / Math.PI;
      }
      d.last = { ...m, geo: g };
      onMask?.(d.last, false);
    } else if (d.kind.startsWith('crop')) cropDrag(d, x, y, e);
  };

  const onUp = (e) => {
    const d = drag.current;
    drag.current = null;
    box.current.releasePointerCapture?.(e.pointerId);
    if (!d) return;
    if (d.kind === 'paint') {
      const m = d.mask;
      onMask?.({ ...m, strokes: [...(m.strokes || []), d.stroke] }, true, d.stroke.erase ? 'Erase brush' : 'Brush stroke');
    } else if (d.kind === 'mask-handle' && d.last) onMask?.(d.last, true);
    else if ((d.kind === 'new-radial' || d.kind === 'new-linear') && d.created) onMask?.(d.created, true);
    else if (d.kind.startsWith('crop') && d.last) onCrop?.(d.last, true);
  };

  const onWheel = (e) => {
    if (status.loading) return;
    if (e.ctrlKey || e.metaKey || zoom === 'fit') {
      const [x, y] = local(e);
      const cur = zoom === 'fit' ? fit * dpr : zoom;
      const nz = clamp(cur * Math.exp(-e.deltaY * 0.002), fit * dpr * 0.999, 8);
      if (nz <= fit * dpr * 1.001) { setZoom('fit'); setPan({ x: 0, y: 0 }); return; }
      // Keep the point under the cursor still.
      const ns = nz / dpr; const k = ns / s;
      const cxp = size.w / 2; const cyp = size.h / 2;
      setPan({ x: (x - cxp) - (x - cxp - P.x) * k, y: (y - cyp) - (y - cyp - P.y) * k });
      setZoom(nz);
    } else setPan(clampPan({ x: P.x - e.deltaX, y: P.y - e.deltaY }));
  };
  useEffect(() => {
    const el = box.current;
    const f = (e) => e.preventDefault();
    el.addEventListener('wheel', f, { passive: false });
    return () => el.removeEventListener('wheel', f);
  }, []);

  // ---------------------------------------------------------------- crop
  const cropR = cropMode ? cropRectInFull(sw, sh, settings) : null;
  const [W0, H0] = orientedSize(sw, sh, settings.orient);
  const cropDrag = (d, x, y, e) => {
    const dqx = (x - d.x0) / iw; const dqy = (y - d.y0) / ih;
    const c0 = d.crop0; const r0 = d.rect0;
    let crop;
    if (d.kind === 'crop-rotate') {
      const cxs = ox + (r0.x + r0.w / 2) * iw; const cys = oy + (r0.y + r0.h / 2) * ih;
      const a0 = Math.atan2(d.y0 - cys, d.x0 - cxs); const a1 = Math.atan2(y - cys, x - cxs);
      const ang = clamp(c0.angle - ((a1 - a0) * 180) / Math.PI, -45, 45);
      crop = constrainCrop(sw, sh, settings, { ...c0, angle: Math.round(ang * 10) / 10 });
    } else {
      let { x: rx, y: ry, w: rw, h: rh } = r0;
      if (d.kind === 'crop-move') { rx += dqx; ry += dqy; rx = clamp(rx, 0, 1 - rw); ry = clamp(ry, 0, 1 - rh); }
      else {
        const hdl = d.h;
        let x0 = rx; let y0 = ry; let x1 = rx + rw; let y1 = ry + rh;
        if (hdl.includes('w')) x0 = clamp(x0 + dqx, 0, x1 - 0.02);
        if (hdl.includes('e')) x1 = clamp(x1 + dqx, x0 + 0.02, 1);
        if (hdl.includes('n')) y0 = clamp(y0 + dqy, 0, y1 - 0.02);
        if (hdl.includes('s')) y1 = clamp(y1 + dqy, y0 + 0.02, 1);
        // Fixed aspect: px ratio W/H in the full frame.
        const ar = aspectValue(settings.crop.aspect, W0, H0, (r0.w * frame.outW) / (r0.h * frame.outH));
        if (ar && !e.shiftKey) {
          let pw = (x1 - x0) * frame.outW; let ph = (y1 - y0) * frame.outH;
          if (hdl.length === 2) { if (pw / ph > ar) pw = ph * ar; else ph = pw / ar; }
          else if (hdl === 'e' || hdl === 'w') ph = pw / ar; else pw = ph * ar;
          const nw = pw / frame.outW; const nh = ph / frame.outH;
          if (hdl.includes('w')) x0 = x1 - nw; else if (hdl.includes('e')) x1 = x0 + nw; else { const m = (x0 + x1) / 2; x0 = m - nw / 2; x1 = m + nw / 2; }
          if (hdl.includes('n')) y0 = y1 - nh; else if (hdl.includes('s')) y1 = y0 + nh; else { const m = (y0 + y1) / 2; y0 = m - nh / 2; y1 = m + nh / 2; }
        }
        rx = x0; ry = y0; rw = x1 - x0; rh = y1 - y0;
      }
      crop = constrainCrop(sw, sh, settings, cropFromFullRect(sw, sh, { ...settings, crop: c0 }, { x: rx, y: ry, w: rw, h: rh }));
    }
    d.last = crop;
    onCrop?.(crop, false);
  };
  const cropDown = (e, kind, h) => {
    if (readOnly) return;
    startDrag(e, kind, { h, crop0: settings.crop, rect0: cropR });
  };

  // ---------------------------------------------------------------- render
  const cursor = tool === 'wb' ? 'crosshair' : tool === 'brush' ? 'none' : ['linear', 'radial'].includes(tool) ? 'crosshair' : (iw > size.w || ih > size.h) ? 'grab' : 'default';
  const ready = !status.loading && !status.error && srcKey;
  const shown = (settings.masks || []).filter((m) => m.visible !== false);

  return (
    <div ref={box} className="absolute inset-0 overflow-hidden bg-work touch-none" style={{ cursor }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)} onWheel={onWheel}
      onDoubleClick={(e) => { if (!tool && !e.target.closest('[data-handle]')) setZoom(zoom === 'fit' ? 1 : 'fit'); }}>
      <canvas ref={canvas} data-develop-canvas="" className="absolute inset-0 pointer-events-none" style={{ width: size.w, height: size.h, opacity: ready ? 1 : 0 }} />
      {glError && <div className="absolute inset-0 grid place-items-center text-sm text-danger p-6 text-center">{glError}</div>}
      {status.loading && !glError && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-2 text-sm text-fg2">
            <Spinner size={24} />
            {status.processing ? <span>Processing on the server — making a browser-friendly copy…</span> : <span>Loading {photo.name}…</span>}
            {status.processing && isRaw(photo) && <span className="text-xs text-fg3 max-w-sm text-center">RAW files are decoded with ffmpeg, so results depend on its support for this camera.</span>}
          </div>
        </div>
      )}
      {status.error && <div className="absolute inset-0 grid place-items-center text-sm text-danger"><div className="flex items-center gap-2"><Icon name="warning" />{status.error}</div></div>}

      {ready && (
        <svg className="absolute inset-0 pointer-events-none" width={size.w} height={size.h}>
          {cropMode && cropR && (() => {
            const x = ox + cropR.x * iw; const y = oy + cropR.y * ih; const w = cropR.w * iw; const h = cropR.h * ih;
            const hs = [['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y], ['e', x + w, y + h / 2], ['se', x + w, y + h], ['s', x + w / 2, y + h], ['sw', x, y + h], ['w', x, y + h / 2]];
            const curs = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
            return (
              <g>
                <path d={`M0 0H${size.w}V${size.h}H0Z M${x} ${y}V${y + h}H${x + w}V${y}Z`} fill="rgba(0,0,0,.6)" fillRule="evenodd" className="pointer-events-auto" style={{ cursor: 'alias' }}
                  onPointerDown={(e) => cropDown(e, 'crop-rotate')} />
                <rect x={x} y={y} width={w} height={h} fill="transparent" stroke="#fff" strokeWidth={1} className="pointer-events-auto" style={{ cursor: 'move' }} onPointerDown={(e) => cropDown(e, 'crop-move')} />
                {[1, 2].map((i) => <g key={i} stroke="rgba(255,255,255,.45)" strokeWidth={0.75}><line x1={x + (w * i) / 3} y1={y} x2={x + (w * i) / 3} y2={y + h} /><line x1={x} y1={y + (h * i) / 3} x2={x + w} y2={y + (h * i) / 3} /></g>)}
                {hs.map(([k, hx, hy]) => (
                  <rect key={k} data-handle="" x={hx - 6} y={hy - 6} width={12} height={12} fill="#fff" stroke="#000" strokeOpacity={0.5} className="pointer-events-auto" style={{ cursor: curs[k] }}
                    onPointerDown={(e) => cropDown(e, 'crop-size', k)} />
                ))}
              </g>
            );
          })()}

          {!cropMode && maskSel && shown.map((m) => {
            if (m.type === 'brush') return null;
            const sel = m.id === maskSel;
            if (!sel) {
              const [px, py] = m.type === 'linear' ? fromSrc((m.geo.x0 + m.geo.x1) / 2, (m.geo.y0 + m.geo.y1) / 2) : fromSrc(m.geo.cx, m.geo.cy);
              return <circle key={m.id} cx={px} cy={py} r={5} fill="#888" stroke="#fff" strokeWidth={1.5} />;
            }
            const handle = (h) => (e) => { if (!readOnly) startDrag(e, 'mask-handle', { h, mask: m }); };
            if (m.type === 'linear') {
              const g = m.geo;
              const p0 = fromSrc(g.x0, g.y0); const p1 = fromSrc(g.x1, g.y1);
              const dxl = p1[0] - p0[0]; const dyl = p1[1] - p0[1]; const len = Math.hypot(dxl, dyl) || 1;
              const nx = (-dyl / len) * 2000; const ny = (dxl / len) * 2000;
              const line = (p, dash) => <line x1={p[0] - nx} y1={p[1] - ny} x2={p[0] + nx} y2={p[1] + ny} stroke="#fff" strokeWidth={1.2} strokeDasharray={dash} style={{ filter: 'drop-shadow(0 0 1px #000)' }} />;
              const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
              return (
                <g key={m.id}>
                  {line(p0)}{line(mid, '4 4')}{line(p1)}
                  <circle data-handle="" cx={p0[0]} cy={p0[1]} r={6} fill="#fff" stroke="#000" className="pointer-events-auto cursor-move" onPointerDown={handle('p0')} />
                  <circle data-handle="" cx={p1[0]} cy={p1[1]} r={6} fill="#fff" stroke="#000" className="pointer-events-auto cursor-move" onPointerDown={handle('p1')} />
                  <circle data-handle="" cx={mid[0]} cy={mid[1]} r={7} fill="#5ab4ff" stroke="#fff" strokeWidth={2} className="pointer-events-auto cursor-move" onPointerDown={handle('mid')} />
                </g>
              );
            }
            const g = m.geo; const a = (g.angle * Math.PI) / 180;
            const c = fromSrc(g.cx, g.cy);
            const ax = fromSrc(g.cx + (Math.cos(a) * g.rx * L) / sw, g.cy + (Math.sin(a) * g.rx * L) / sh);
            const ay = fromSrc(g.cx + (-Math.sin(a) * g.ry * L) / sw, g.cy + (Math.cos(a) * g.ry * L) / sh);
            const rot = fromSrc(g.cx + (Math.cos(a) * g.rx * L * 1.25) / sw, g.cy + (Math.sin(a) * g.rx * L * 1.25) / sh);
            const RX = Math.hypot(ax[0] - c[0], ax[1] - c[1]); const RY = Math.hypot(ay[0] - c[0], ay[1] - c[1]);
            const deg = (Math.atan2(ax[1] - c[1], ax[0] - c[0]) * 180) / Math.PI;
            const f = 1 - g.feather / 100;
            return (
              <g key={m.id}>
                <ellipse cx={c[0]} cy={c[1]} rx={RX} ry={RY} transform={`rotate(${deg} ${c[0]} ${c[1]})`} fill="none" stroke="#fff" strokeWidth={1.3} style={{ filter: 'drop-shadow(0 0 1px #000)' }} />
                {f < 0.98 && <ellipse cx={c[0]} cy={c[1]} rx={RX * f} ry={RY * f} transform={`rotate(${deg} ${c[0]} ${c[1]})`} fill="none" stroke="#fff" strokeOpacity={0.6} strokeDasharray="3 4" />}
                <line x1={ax[0]} y1={ax[1]} x2={rot[0]} y2={rot[1]} stroke="#fff" strokeOpacity={0.6} />
                <circle data-handle="" cx={c[0]} cy={c[1]} r={7} fill="#5ab4ff" stroke="#fff" strokeWidth={2} className="pointer-events-auto cursor-move" onPointerDown={handle('center')} />
                <circle data-handle="" cx={ax[0]} cy={ax[1]} r={5.5} fill="#fff" stroke="#000" className="pointer-events-auto cursor-pointer" onPointerDown={handle('rx')} />
                <circle data-handle="" cx={ay[0]} cy={ay[1]} r={5.5} fill="#fff" stroke="#000" className="pointer-events-auto cursor-pointer" onPointerDown={handle('ry')} />
                <circle data-handle="" cx={rot[0]} cy={rot[1]} r={5} fill="#000" stroke="#fff" className="pointer-events-auto" style={{ cursor: 'alias' }} onPointerDown={handle('rot')} />
              </g>
            );
          })}

          {tool === 'brush' && hover && (
            <g>
              <circle cx={hover.x} cy={hover.y} r={brush.size * s} fill="none" stroke="#fff" strokeWidth={1.2} style={{ filter: 'drop-shadow(0 0 1px #000)' }} />
              <circle cx={hover.x} cy={hover.y} r={brush.size * s * (1 - brush.feather / 100)} fill="none" stroke="#fff" strokeOpacity={0.6} strokeDasharray="2 3" />
              {brush.erase && <line x1={hover.x - 4} y1={hover.y} x2={hover.x + 4} y2={hover.y} stroke="#fff" />}
            </g>
          )}

          {before === 'split' && (
            <g>
              <line x1={split * size.w} y1={0} x2={split * size.w} y2={size.h} stroke="#fff" strokeWidth={1.5} style={{ filter: 'drop-shadow(0 0 2px #000)' }} />
              <rect data-handle="" x={split * size.w - 8} y={0} width={16} height={size.h} fill="transparent" className="pointer-events-auto" style={{ cursor: 'ew-resize' }}
                onPointerDown={(e) => startDrag(e, 'split')} />
            </g>
          )}
        </svg>
      )}
      {ready && before === 'split' && (
        <>
          <span className="absolute top-2 px-2 py-0.5 rounded bg-black/60 text-white text-[11px]" style={{ right: size.w - split * size.w + 8 }}>Before</span>
          <span className="absolute top-2 px-2 py-0.5 rounded bg-black/60 text-white text-[11px]" style={{ left: split * size.w + 8 }}>After</span>
        </>
      )}
      {ready && before === 'full' && <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 text-white text-[11px]">Before</span>}
      {ready && tool === 'brush' && activeMask?.type !== 'brush' && (
        <div className={cx('absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-black/70 text-white text-xs')}>Select or add a brush mask to paint</div>
      )}
    </div>
  );
}
