// The multitrack view: time ruler (seek, loop strip, markers), track headers (mute/solo/arm, volume, pan, meter) and the
// lanes. Lanes are drawn on one viewport-sized canvas (fast with long sessions and many clips); a transparent scroller
// over it gives native scrollbars and receives the pointer, and we hit-test clips, edges, fade handles and envelopes.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { openMenu, promptDialog, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import {
  clipEnd, effectiveFades, fadeShape, envDb, dbToGain, sessionEnd, clamp, fmtDb, SHAPES, updateClip, updateTrack, moveClips, splitAt,
  splitClip, sortClips, uid, TRACK_COLORS,
} from './model.js';
import { computeDuck } from './engine.js';
import { Meter, MiniSlider, useFrame, rulerStep, fmtRuler, fmtClock } from './parts.jsx';

export const HEADER_W = 236;
const RULER_H = 38; const LOOP_H = 11; const MARK_H = 12;
const HDR = 16; // clip header strip
const ENV_TOP = 12; const ENV_BOTTOM = -48; // dB at the top and bottom of a clip's body
const MIN_PPS = 0.5; const MAX_PPS = 8000;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

export default function Timeline({
  engine, doc, edit, commit, canEdit, sel, setSel, selTrack, setSelTrack, timeSel, setTimeSel, tool, snap, pps, setPps,
  armed, toggleArm, actions, apiRef, playing, recording, files,
}) {
  const scroller = useRef(null); const canvas = useRef(null); const ruler = useRef(null); const headInner = useRef(null);
  const playhead = useRef(null); const rulerHead = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const [waveV, setWaveV] = useState(0);
  const docRef = useRef(doc); docRef.current = doc;
  const ppsRef = useRef(pps); ppsRef.current = pps;
  const pendingScroll = useRef(null);
  const drag = useRef(null);

  // ------------------------------------------------------------ layout
  const tops = useMemo(() => { const a = []; let y = 0; for (const t of doc.tracks) { a.push(y); y += t.height; } a.push(y); return a; }, [doc.tracks]);
  const end = sessionEnd(doc);
  const contentW = Math.max(size.w, (Math.max(end, 30) + 30) * pps);
  const contentH = tops[tops.length - 1] + 90;

  useLayoutEffect(() => {
    const el = scroller.current;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => engine.on((w) => { if (w === 'wave') setWaveV((v) => v + 1); }), [engine]);

  const duck = useMemo(() => computeDuck(doc, (id) => engine.mips.get(id)), [doc.tracks, doc.duck, waveV]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom keeping a time under a screen x.
  const zoomTo = useCallback((next, anchorX = size.w / 2) => {
    const p = clamp(next, MIN_PPS, MAX_PPS);
    const el = scroller.current;
    const t = (el.scrollLeft + anchorX) / ppsRef.current;
    pendingScroll.current = t * p - anchorX;
    setPps(p);
  }, [setPps, size.w]);
  useLayoutEffect(() => {
    if (pendingScroll.current !== null) { scroller.current.scrollLeft = Math.max(0, pendingScroll.current); pendingScroll.current = null; draw(); }
  });

  useEffect(() => {
    apiRef.current = {
      zoomIn: () => zoomTo(ppsRef.current * 1.5), zoomOut: () => zoomTo(ppsRef.current / 1.5),
      fit: () => { const e = Math.max(5, sessionEnd(docRef.current)); pendingScroll.current = 0; setPps(clamp((size.w - 20) / e, MIN_PPS, MAX_PPS)); },
      zoomSel: (a, b) => { const p = clamp((size.w - 40) / Math.max(0.01, b - a), MIN_PPS, MAX_PPS); pendingScroll.current = a * p - 20; setPps(p); },
      reveal: (t) => { const el = scroller.current; const x = t * ppsRef.current; if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 30) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.2); },
      width: () => size.w,
    };
  });

  // Ctrl/⌘ + wheel zooms (needs a non-passive listener to stop the page zoom).
  useEffect(() => {
    const el = scroller.current;
    const wheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomTo(ppsRef.current * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomTo]);

  // ------------------------------------------------------------ geometry helpers
  const trackAtY = (y) => { for (let i = 0; i < doc.tracks.length; i++) if (y >= tops[i] && y < tops[i + 1]) return i; return -1; };
  const envY = (db, top, h) => top + ((ENV_TOP - clamp(db, ENV_BOTTOM, ENV_TOP)) / (ENV_TOP - ENV_BOTTOM)) * h;
  const yToDb = (y, top, h) => { const db = ENV_TOP - ((y - top) / h) * (ENV_TOP - ENV_BOTTOM); return db <= ENV_BOTTOM + 0.5 ? -60 : clamp(db, ENV_BOTTOM, ENV_TOP); };
  const fileDur = (id) => engine.ready.get(id)?.duration || files.find((f) => f.id === id)?.duration || Infinity;
  const point = (e) => { const r = scroller.current.getBoundingClientRect(); const el = scroller.current; return { x: e.clientX - r.left + el.scrollLeft, y: e.clientY - r.top + el.scrollTop, vx: e.clientX - r.left }; };

  /** What's under content point (x, y). */
  const hit = (x, y) => {
    const ti = trackAtY(y);
    if (ti < 0) return { type: 'none', ti };
    const t = doc.tracks[ti]; const top = tops[ti] + 2; const h = t.height - 4; const hdr = Math.min(HDR, h / 3);
    const time = x / pps;
    const cl = [...t.clips].reverse();
    for (const c of cl) {
      const x0 = c.start * pps; const x1 = clipEnd(c) * pps;
      if (x < x0 - 4 || x > x1 + 4) continue;
      const { fi, fo } = effectiveFades(t, c);
      if (canEdit && y < top + hdr + 7) {
        if (Math.abs(x - (x0 + fi.d * pps)) <= 7) return { type: 'fadeIn', ti, clip: c };
        if (Math.abs(x - (x1 - fo.d * pps)) <= 7) return { type: 'fadeOut', ti, clip: c };
      }
      if (x < x0 || x > x1) continue;
      const bodyTop = top + hdr; const bodyH = h - hdr;
      if (canEdit) {
        for (let i = 0; i < c.env.length; i++) {
          const p = c.env[i]; const px = (c.start + p.t - c.in) * pps; const py = envY(p.v, bodyTop, bodyH);
          if (Math.hypot(px - x, py - y) <= 6) return { type: 'envPoint', ti, clip: c, index: i };
        }
        if (y > top + hdr && (x - x0 < 6 || x1 - x < 6) && x1 - x0 > 16) return { type: x - x0 < 6 ? 'trimL' : 'trimR', ti, clip: c };
        if (y > bodyTop + 2 && Math.abs(envY(envDb(c.env, c.in + time - c.start), bodyTop, bodyH) - y) <= 4) return { type: 'envLine', ti, clip: c };
      }
      return { type: 'clip', ti, clip: c };
    }
    return { type: 'empty', ti };
  };

  /** Snap candidates (seconds) — clip edges, playhead, markers, loop and selection edges. */
  const snapList = (exclude = new Set()) => {
    const l = [0, engine.position];
    for (const t of doc.tracks) for (const c of t.clips) if (!exclude.has(c.id)) l.push(c.start, clipEnd(c));
    for (const m of doc.markers) l.push(m.t);
    if (doc.loop) l.push(doc.loop.start, doc.loop.end);
    if (timeSel) l.push(timeSel.start, timeSel.end);
    return l;
  };
  const snapT = (t, list) => {
    if (!snap) return t;
    let best = t; let bd = 8 / pps;
    for (const s of list) { const d = Math.abs(s - t); if (d < bd) { bd = d; best = s; } }
    return best;
  };

  // ------------------------------------------------------------ drawing
  const draw = useCallback(() => {
    const cv = canvas.current; const el = scroller.current;
    if (!cv || !el) return;
    const W = el.clientWidth; const H = el.clientHeight; const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const sx = el.scrollLeft; const sy = el.scrollTop; const d = docRef.current; const P = ppsRef.current;
    const line = css('--line') || 'rgba(255,255,255,.08)';
    const X = (t) => t * P - sx;
    // lanes
    d.tracks.forEach((t, i) => {
      const y = tops[i] - sy;
      if (y > H || y + t.height < 0) return;
      g.fillStyle = t.id === selTrack ? 'rgba(90,180,255,.07)' : i % 2 ? 'rgba(255,255,255,.018)' : 'rgba(0,0,0,0)';
      g.fillRect(0, y, W, t.height);
      g.fillStyle = line; g.fillRect(0, y + t.height - 1, W, 1);
    });
    // grid
    const step = rulerStep(P);
    g.fillStyle = 'rgba(255,255,255,.035)';
    for (let t = Math.floor(sx / P / step) * step; X(t) < W; t += step) g.fillRect(Math.round(X(t)), 0, 1, H);
    // loop and time selection
    if (d.loop && d.loop.end > d.loop.start) { g.fillStyle = d.loop.on ? 'rgba(255,195,107,.06)' : 'rgba(255,255,255,.025)'; g.fillRect(X(d.loop.start), 0, (d.loop.end - d.loop.start) * P, H); }
    if (timeSel && timeSel.end > timeSel.start) {
      g.fillStyle = 'rgba(90,180,255,.13)'; g.fillRect(X(timeSel.start), 0, (timeSel.end - timeSel.start) * P, H);
      g.fillStyle = 'rgba(90,180,255,.6)'; g.fillRect(X(timeSel.start), 0, 1, H); g.fillRect(X(timeSel.end), 0, 1, H);
    }
    // clips
    g.font = '600 11px Inter, system-ui, sans-serif'; g.textBaseline = 'middle';
    d.tracks.forEach((t, i) => {
      const top = tops[i] - sy + 2; const h = t.height - 4;
      if (top > H || top + h < 0) return;
      const hdr = Math.min(HDR, h / 3); const bodyTop = top + hdr; const bodyH = h - hdr; const bottom = top + h;
      for (const c of t.clips) {
        const x0 = X(c.start); const x1 = X(clipEnd(c));
        if (x1 < -2 || x0 > W + 2) continue;
        const s = sel.has(c.id); const w = Math.max(1, x1 - x0);
        g.save();
        g.beginPath(); g.roundRect(x0, top, w, h, 4); g.clip();
        g.fillStyle = rgba(t.color, s ? 0.34 : 0.2); g.fillRect(x0, top, w, h);
        g.fillStyle = rgba(t.color, s ? 0.95 : 0.6); g.fillRect(x0, top, w, hdr);
        if (w > 30 && hdr >= 10) {
          g.fillStyle = '#071318';
          const gainTxt = c.gain ? `  ${fmtDb(c.gain)} dB` : '';
          g.fillText(`${c.name}${gainTxt}`, Math.max(x0, 0) + 5, top + hdr / 2 + 0.5, Math.max(10, Math.min(x1, W) - Math.max(x0, 0) - 10));
        }
        // waveform (only the visible part)
        const vx0 = Math.max(x0, 0); const vx1 = Math.min(x1, W);
        if (vx1 > vx0 && bodyH > 6) {
          const a = c.in + (vx0 - x0) / P; const b = c.in + (vx1 - x0) / P;
          engine.drawWave(g, c.asset, a, b, vx0, bodyTop + 2, vx1 - vx0, bodyH - 4, { color: s ? 'rgba(255,255,255,.88)' : rgba(t.color, 0.95), gain: dbToGain(c.gain) });
        }
        // fades
        const { fi, fo } = effectiveFades(t, c);
        const fadePath = (fx0, fx1, dir, f) => {
          g.beginPath();
          const n = Math.max(2, Math.ceil(Math.abs(fx1 - fx0) / 3));
          for (let k = 0; k <= n; k++) { const u = k / n; const xx = fx0 + (fx1 - fx0) * u; const yy = bottom - fadeShape(dir === 'in' ? u : 1 - u, f.shape) * bodyH; if (k) g.lineTo(xx, yy); else g.moveTo(xx, yy); }
          g.strokeStyle = f.xfade ? '#5AB4FF' : 'rgba(255,255,255,.85)'; g.lineWidth = 1.25; g.stroke();
          g.lineTo(dir === 'in' ? fx1 : fx1, bodyTop); g.lineTo(fx0, bodyTop); g.closePath();
          g.fillStyle = f.xfade ? 'rgba(90,180,255,.16)' : 'rgba(0,0,0,.32)'; g.fill();
        };
        if (fi.d > 0) fadePath(x0, x0 + fi.d * P, 'in', fi);
        if (fo.d > 0) fadePath(x1 - fo.d * P, x1, 'out', fo);
        // envelope
        if (c.env.length || s) {
          g.beginPath();
          const pts = [{ x: x0, v: envDb(c.env, c.in) }, ...c.env.map((p) => ({ x: x0 + (p.t - c.in) * P, v: p.v })), { x: x1, v: envDb(c.env, c.in + c.dur) }];
          pts.forEach((p, k) => { const yy = envY(p.v, bodyTop, bodyH); if (k) g.lineTo(p.x, yy); else g.moveTo(p.x, yy); });
          g.strokeStyle = '#ffd34d'; g.lineWidth = 1.25; g.stroke();
          g.fillStyle = '#ffd34d';
          for (const p of c.env) { const px = x0 + (p.t - c.in) * P; if (px >= x0 - 3 && px <= x1 + 3) { g.beginPath(); g.arc(px, envY(p.v, bodyTop, bodyH), 3.5, 0, Math.PI * 2); g.fill(); } }
        }
        g.restore();
        // fade handles (outside the clip mask so they're grabbable at the edge)
        if (canEdit && hdr >= 10) {
          g.fillStyle = '#fff';
          for (const hx of [x0 + fi.d * P, x1 - fo.d * P]) { g.fillRect(hx - 4, top + hdr - 4, 8, 8); }
          g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1;
          for (const hx of [x0 + fi.d * P, x1 - fo.d * P]) g.strokeRect(hx - 4 + 0.5, top + hdr - 4 + 0.5, 7, 7);
        }
        g.strokeStyle = s ? '#ffffff' : rgba(t.color, 0.7); g.lineWidth = s ? 1.5 : 1;
        g.beginPath(); g.roundRect(x0 + 0.5, top + 0.5, w - 1, h - 1, 4); g.stroke();
      }
      // ducking curve on the target track
      if (duck && d.duck?.target === t.id) {
        g.beginPath();
        const i0 = Math.max(0, Math.floor((sx / P) * duck.rate)); const i1 = Math.min(duck.data.length, Math.ceil(((sx + W) / P) * duck.rate) + 1);
        for (let k = i0; k < i1; k++) { const xx = X(k / duck.rate); const yy = top + 3 + (1 - duck.data[k]) * (h - 6) * 0.5; if (k === i0) g.moveTo(xx, yy); else g.lineTo(xx, yy); }
        g.strokeStyle = 'rgba(255,154,60,.75)'; g.setLineDash([4, 3]); g.lineWidth = 1; g.stroke(); g.setLineDash([]);
      }
    });
    // recording take in progress
    if (recording && engine.rec) {
      const xr0 = X(engine.rec.from); const xr1 = X(engine.position);
      d.tracks.forEach((t, i) => { if (!armed.has(t.id)) return; g.fillStyle = 'rgba(255,77,94,.28)'; g.fillRect(xr0, tops[i] - sy + 2, Math.max(0, xr1 - xr0), t.height - 4); });
    }
    // markers
    g.strokeStyle = 'rgba(255,195,107,.55)'; g.setLineDash([3, 4]);
    for (const m of d.markers) { const xx = Math.round(X(m.t)) + 0.5; if (xx < 0 || xx > W) continue; g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, H); g.stroke(); }
    g.setLineDash([]);
    drawRuler();
  }, [tops, selTrack, sel, timeSel, duck, canEdit, recording, armed, engine]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawRuler = () => {
    const cv = ruler.current; const el = scroller.current;
    if (!cv || !el) return;
    const W = el.clientWidth; const H = RULER_H; const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const sx = el.scrollLeft; const P = ppsRef.current; const d = docRef.current; const X = (t) => t * P - sx;
    // loop strip
    g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(0, 0, W, LOOP_H);
    if (d.loop && d.loop.end > d.loop.start) {
      g.fillStyle = d.loop.on ? 'rgba(255,195,107,.85)' : 'rgba(255,195,107,.3)';
      g.fillRect(X(d.loop.start), 1, (d.loop.end - d.loop.start) * P, LOOP_H - 2);
    }
    if (timeSel && timeSel.end > timeSel.start) { g.fillStyle = 'rgba(90,180,255,.35)'; g.fillRect(X(timeSel.start), LOOP_H, (timeSel.end - timeSel.start) * P, H - LOOP_H); }
    // ticks
    const step = rulerStep(P); const minor = step / 5;
    const fg2 = css('--fg2') || '#a8adbd';
    g.fillStyle = fg2; g.font = '10.5px Inter, system-ui, sans-serif'; g.textBaseline = 'top';
    for (let t = Math.floor(sx / P / minor) * minor; X(t) < W; t += minor) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      const xx = Math.round(X(t)) + 0.5;
      g.fillRect(xx, major ? H - 12 : H - 5, 1, major ? 12 : 5);
      if (major) g.fillText(fmtRuler(Math.max(0, t), step), xx + 3, LOOP_H + MARK_H + 1);
    }
    // markers
    for (const m of d.markers) {
      const xx = X(m.t); if (xx < -100 || xx > W) continue;
      g.fillStyle = '#FFC36B'; g.beginPath(); g.moveTo(xx, LOOP_H); g.lineTo(xx + 7, LOOP_H); g.lineTo(xx + 7, LOOP_H + 7); g.lineTo(xx, LOOP_H + 11); g.closePath(); g.fill();
      g.fillStyle = '#FFC36B'; g.font = '10px Inter, system-ui, sans-serif'; g.fillText(m.name, xx + 9, LOOP_H + 1);
      g.font = '10.5px Inter, system-ui, sans-serif'; g.fillStyle = fg2;
    }
    g.fillStyle = css('--line') || 'rgba(255,255,255,.08)'; g.fillRect(0, H - 1, W, 1);
  };

  useEffect(() => { draw(); }, [draw, doc, pps, size, waveV]);

  // Playhead (moved every frame without React), auto-scroll while playing, and redraw during recording.
  useFrame(() => {
    const el = scroller.current; if (!el) return;
    const pos = engine.position; const x = pos * ppsRef.current - el.scrollLeft;
    const vis = x >= -1 && x <= el.clientWidth + 1;
    for (const ph of [playhead.current, rulerHead.current]) { if (!ph) continue; ph.style.transform = `translateX(${Math.round(x)}px)`; ph.style.display = vis ? '' : 'none'; }
    if (engine.playing && (x > el.clientWidth - 24 || x < 0) && !drag.current) el.scrollLeft = Math.max(0, pos * ppsRef.current - 40);
    if (recording) draw();
  }, [engine, draw, recording]);

  const onScroll = () => {
    if (headInner.current) headInner.current.style.transform = `translateY(${-scroller.current.scrollTop}px)`;
    draw();
  };

  // ------------------------------------------------------------ pointer: lanes
  const setCursor = (c) => { if (scroller.current) scroller.current.style.cursor = c; };
  const onMove = (e) => {
    if (drag.current) return;
    const p = point(e); const hh = hit(p.x, p.y);
    if (tool === 'razor') return setCursor('crosshair');
    if (tool === 'time') return setCursor('text');
    setCursor({ trimL: 'ew-resize', trimR: 'ew-resize', fadeIn: 'col-resize', fadeOut: 'col-resize', envPoint: 'grab', envLine: 'copy', clip: canEdit ? 'grab' : 'default' }[hh.type] || 'text');
  };

  const begin = (e, onDrag, onUp) => {
    const el = scroller.current;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => onDrag(ev);
    const up = (ev) => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); drag.current = null; onUp?.(ev); commit(); draw(); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };

  const onDown = (e) => {
    if (e.button !== 0) return;
    // Clicks on the scrollbars shouldn't start edits.
    const el = scroller.current; const r = el.getBoundingClientRect();
    if (e.clientX - r.left > el.clientWidth || e.clientY - r.top > el.clientHeight) return;
    const p = point(e); const hh = hit(p.x, p.y); const t = p.x / pps;
    const key = uid('drag');
    if (hh.ti >= 0) setSelTrack(doc.tracks[hh.ti].id);

    // Razor: split the clip (Shift: every track) at the click.
    if (tool === 'razor' && canEdit) {
      const at = snapT(t, snapList());
      if (e.shiftKey) { const [nd, n] = splitAt(doc, at); if (n) edit(nd, 'Split'); }
      else if (hh.clip) { const [nd] = splitClip(doc, hh.clip.id, at); edit(nd, 'Split'); }
      return;
    }

    // Time selection (empty space, or anywhere with the Time Selection tool).
    if (tool === 'time' || hh.type === 'empty' || hh.type === 'none' || (!canEdit && hh.type !== 'none')) {
      if (!e.shiftKey && tool !== 'time') setSel(new Set());
      const list = snapList(); const t0 = snapT(t, list);
      let moved = false;
      drag.current = { kind: 'time' };
      begin(e, (ev) => {
        const q = point(ev); const t1 = snapT(Math.max(0, q.x / pps), list);
        if (Math.abs(q.x - p.x) > 3) moved = true;
        if (moved) setTimeSel({ start: Math.min(t0, t1), end: Math.max(t0, t1) });
      }, () => { if (!moved) { setTimeSel(null); engine.seek(t0); } else if (!engine.playing) engine.seek(Math.min(t0, Math.max(0, point(e).x / pps))); });
      return;
    }

    const c = hh.clip;
    // Selection
    let selection = sel;
    if (hh.type === 'clip' || hh.type === 'trimL' || hh.type === 'trimR') {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { selection = new Set(sel); if (selection.has(c.id)) selection.delete(c.id); else selection.add(c.id); }
      else if (!sel.has(c.id)) selection = new Set([c.id]);
      setSel(selection);
    } else if (!sel.has(c.id)) { selection = new Set([c.id]); setSel(selection); }

    const base = doc; const ti0 = hh.ti;
    if (hh.type === 'clip') {
      if (!selection.has(c.id)) return;
      const ids = [...selection];
      const orig = base.tracks.flatMap((tr, i) => tr.clips.filter((x) => selection.has(x.id)).map((x) => ({ c: x, ti: i })));
      const list = snapList(new Set(ids));
      const minStart = Math.min(...orig.map((o) => o.c.start));
      const tiMin = Math.min(...orig.map((o) => o.ti)); const tiMax = Math.max(...orig.map((o) => o.ti));
      let started = false;
      drag.current = { kind: 'move' };
      setCursor('grabbing');
      begin(e, (ev) => {
        const q = point(ev);
        if (!started && Math.hypot(q.x - p.x, q.y - p.y) < 4) return;
        started = true;
        let dt = (q.x - p.x) / pps;
        dt = Math.max(dt, -minStart);
        // Snap whichever edge of the grabbed clip lands nearest a snap point.
        if (snap) {
          const s0 = c.start + dt; const s1 = clipEnd(c) + dt;
          const a = snapT(s0, list) - s0; const b = snapT(s1, list) - s1;
          const pick = Math.abs(a) <= Math.abs(b) ? a : b;
          if (Math.abs(pick) < 8 / pps) dt += pick;
        }
        let dTi = trackAtY(q.y) - ti0;
        if (trackAtY(q.y) < 0) dTi = q.y < 0 ? -tiMin : base.tracks.length - 1 - tiMax;
        dTi = clamp(dTi, -tiMin, base.tracks.length - 1 - tiMax);
        edit(moveClips(base, orig.map((o) => ({ id: o.c.id, start: Math.max(0, o.c.start + dt), trackId: base.tracks[o.ti + dTi].id }))), 'Move clip', { merge: key });
      });
      return;
    }
    if (hh.type === 'trimL' || hh.type === 'trimR') {
      const list = snapList(new Set([c.id])); const fd = fileDur(c.asset);
      drag.current = { kind: 'trim' };
      begin(e, (ev) => {
        const tt = snapT(Math.max(0, point(ev).x / pps), list);
        if (hh.type === 'trimL') {
          const ns = clamp(tt, c.start - c.in, clipEnd(c) - 0.02);
          edit(updateClip(base, c.id, { start: ns, in: c.in + (ns - c.start), dur: clipEnd(c) - ns }), 'Trim clip', { merge: key });
        } else {
          const ne = clamp(tt, c.start + 0.02, c.start + (fd - c.in));
          edit(updateClip(base, c.id, { dur: ne - c.start }), 'Trim clip', { merge: key });
        }
      });
      return;
    }
    if (hh.type === 'fadeIn' || hh.type === 'fadeOut') {
      drag.current = { kind: 'fade' };
      begin(e, (ev) => {
        const tt = point(ev).x / pps;
        if (hh.type === 'fadeIn') edit(updateClip(base, c.id, { fadeIn: { ...c.fadeIn, d: clamp(tt - c.start, 0, c.dur - c.fadeOut.d) } }), 'Fade in', { merge: key });
        else edit(updateClip(base, c.id, { fadeOut: { ...c.fadeOut, d: clamp(clipEnd(c) - tt, 0, c.dur - c.fadeIn.d) } }), 'Fade out', { merge: key });
      });
      return;
    }
    if (hh.type === 'envPoint' || hh.type === 'envLine') {
      const tr = base.tracks[ti0]; const top = tops[ti0] + 2; const h = tr.height - 4; const hdr = Math.min(HDR, h / 3);
      let env = [...c.env]; let idx = hh.index;
      if (e.altKey && hh.type === 'envPoint') { env.splice(idx, 1); edit(updateClip(base, c.id, { env }), 'Remove envelope point'); return; }
      if (hh.type === 'envLine') {
        const srcT = c.in + (t - c.start);
        env.push({ t: srcT, v: envDb(c.env, srcT) }); env.sort((a, b) => a.t - b.t); idx = env.findIndex((x) => x.t === srcT);
        edit(updateClip(base, c.id, { env }), 'Add envelope point', { merge: key });
      }
      drag.current = { kind: 'env' };
      begin(e, (ev) => {
        const q = point(ev);
        const lo = idx > 0 ? env[idx - 1].t + 0.001 : c.in; const hi = idx < env.length - 1 ? env[idx + 1].t - 0.001 : c.in + c.dur;
        const nt = clamp(c.in + q.x / pps - c.start, lo, hi);
        const nv = yToDb(q.y, top + hdr, h - hdr);
        const next = env.map((x, k) => (k === idx ? { t: nt, v: Math.round(nv * 10) / 10 } : x));
        edit(updateClip(base, c.id, { env: next }), 'Envelope', { merge: key });
      });
    }
  };

  const onDoubleClick = (e) => {
    const p = point(e); const hh = hit(p.x, p.y);
    if (hh.type === 'envPoint' && canEdit) { edit(updateClip(doc, hh.clip.id, { env: hh.clip.env.filter((_, i) => i !== hh.index) }), 'Remove envelope point'); return; }
    if (hh.clip && hh.type === 'clip') actions.openClip(hh.clip.id);
  };

  const onContext = (e) => {
    e.preventDefault();
    const p = point(e); const hh = hit(p.x, p.y); const t = p.x / pps;
    if (hh.clip) {
      const c = hh.clip;
      if (!sel.has(c.id)) setSel(new Set([c.id]));
      const ids = sel.has(c.id) ? [...sel] : [c.id];
      const shapeItems = (which) => SHAPES.map(([v, l]) => ({ label: l, checked: c[which].shape === v, onClick: () => edit(updateClip(doc, c.id, { [which]: { ...c[which], shape: v } }), 'Fade shape') }));
      openMenu(e, [
        { label: 'Open in Waveform editor', icon: 'wave', onClick: () => actions.openClip(c.id) },
        { divider: true },
        { label: 'Split at playhead', icon: 'razor', shortcut: 'Ctrl+K', disabled: !canEdit, onClick: () => actions.split(ids) },
        { label: 'Split here', icon: 'scissors', disabled: !canEdit, onClick: () => { const [nd] = splitClip(doc, c.id, t); edit(nd, 'Split'); } },
        { label: 'Duplicate', icon: 'duplicate', disabled: !canEdit, onClick: () => actions.duplicate(ids) },
        { label: 'Copy', icon: 'copy', onClick: () => actions.copy(ids) },
        { divider: true },
        { label: 'Fade in shape', icon: 'fadeIn', disabled: !canEdit, items: shapeItems('fadeIn') },
        { label: 'Fade out shape', icon: 'fadeOut', disabled: !canEdit, items: shapeItems('fadeOut') },
        { label: 'Remove fades', disabled: !canEdit, onClick: () => edit(updateClip(doc, c.id, { fadeIn: { ...c.fadeIn, d: 0 }, fadeOut: { ...c.fadeOut, d: 0 } }), 'Remove fades') },
        { label: 'Reset volume envelope', disabled: !canEdit || !c.env.length, onClick: () => edit(updateClip(doc, c.id, { env: [] }), 'Reset envelope') },
        { label: 'Clip gain', disabled: !canEdit, items: [+6, +3, -3, -6].map((v) => ({ label: `${v > 0 ? '+' : ''}${v} dB`, onClick: () => edit(updateClip(doc, c.id, { gain: clamp(c.gain + v, -40, 24) }), 'Clip gain') })).concat([{ label: 'Reset to 0 dB', onClick: () => edit(updateClip(doc, c.id, { gain: 0 }), 'Clip gain') }]) },
        { label: 'Rename…', icon: 'edit', disabled: !canEdit, onClick: async () => { const n = await promptDialog({ title: 'Rename clip', label: 'Name', value: c.name }); if (n) edit(updateClip(doc, c.id, { name: n }), 'Rename clip'); } },
        { divider: true },
        { label: 'Delete', icon: 'trash', shortcut: 'Del', danger: true, disabled: !canEdit, onClick: () => actions.del(ids) },
      ]);
      return;
    }
    const tr = hh.ti >= 0 ? doc.tracks[hh.ti] : null;
    openMenu(e, [
      { label: 'Paste here', icon: 'copy', disabled: !canEdit || !actions.canPaste(), onClick: () => actions.paste(t, tr?.id) },
      { label: 'Add marker here', icon: 'marker', disabled: !canEdit, onClick: () => actions.addMarker(t) },
      { label: 'Set playhead here', icon: 'play', onClick: () => engine.seek(t) },
      { divider: true },
      { label: 'Add track', icon: 'plus', disabled: !canEdit, onClick: () => actions.addTrack() },
    ]);
  };

  // Media bin / desktop files dropped on the lanes.
  const onDragOver = (e) => {
    if (!canEdit) return;
    if ([...e.dataTransfer.types].some((x) => x === 'application/x-sl-asset' || x === 'Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  };
  const onDrop = (e) => {
    if (!canEdit) return;
    e.preventDefault();
    const p = point(e); const ti = trackAtY(p.y);
    const t = snapT(Math.max(0, p.x / pps), snapList());
    const trackId = ti >= 0 ? doc.tracks[ti].id : null;
    const raw = e.dataTransfer.getData('application/x-sl-asset');
    if (raw) actions.place(JSON.parse(raw), trackId, t);
    else if (e.dataTransfer.files.length) actions.uploadAndPlace([...e.dataTransfer.files], trackId, t);
  };

  // ------------------------------------------------------------ pointer: ruler
  const onRulerDown = (e) => {
    const el = scroller.current; const r = ruler.current.getBoundingClientRect();
    const x = e.clientX - r.left + el.scrollLeft; const y = e.clientY - r.top; const t = Math.max(0, x / pps);
    const list = snapList(); const key = uid('ruler');
    const cap = (onDrag, onUp) => {
      const target = e.currentTarget; target.setPointerCapture(e.pointerId);
      const move = (ev) => onDrag(Math.max(0, (ev.clientX - r.left + el.scrollLeft) / pps));
      const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); onUp?.(); commit(); };
      target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
    };
    if (y < LOOP_H && canEdit) {
      const l = doc.loop; const near = (a) => l && Math.abs(a * pps - x) < 6;
      let fixed = snapT(t, list);
      if (near(l?.start)) fixed = l.end; else if (near(l?.end)) fixed = l.start;
      else if (l && t > l.start && t < l.end && e.detail === 2) { edit({ ...doc, loop: { ...l, on: !l.on } }, l.on ? 'Loop off' : 'Loop on'); return; }
      cap((tt) => {
        const s = snapT(tt, list); const a = Math.min(fixed, s); const b = Math.max(fixed, s);
        if (b - a > 0.02) edit({ ...docRef.current, loop: { start: a, end: b, on: true } }, 'Set loop', { merge: key });
      });
      return;
    }
    const m = doc.markers.find((mk) => y >= LOOP_H && y < LOOP_H + MARK_H && x >= mk.t * pps - 2 && x <= mk.t * pps + 9);
    if (m) {
      if (e.detail === 2) { promptDialog({ title: 'Rename marker', label: 'Name', value: m.name }).then((n) => { if (n) edit({ ...docRef.current, markers: docRef.current.markers.map((k) => (k.id === m.id ? { ...k, name: n } : k)) }, 'Rename marker'); }); return; }
      engine.seek(m.t);
      if (!canEdit) return;
      cap((tt) => { const s = snapT(tt, list.filter((v) => v !== m.t)); edit({ ...docRef.current, markers: docRef.current.markers.map((k) => (k.id === m.id ? { ...k, t: s } : k)) }, 'Move marker', { merge: key }); });
      return;
    }
    engine.seek(snapT(t, list));
    cap((tt) => engine.seek(tt));
  };
  const onRulerContext = (e) => {
    e.preventDefault();
    const el = scroller.current; const r = ruler.current.getBoundingClientRect();
    const x = e.clientX - r.left + el.scrollLeft; const t = Math.max(0, x / pps);
    const m = doc.markers.find((mk) => Math.abs(mk.t * pps - x) < 8);
    openMenu(e, [
      ...(m ? [{ label: `Delete marker “${m.name}”`, icon: 'trash', danger: true, disabled: !canEdit, onClick: () => edit({ ...doc, markers: doc.markers.filter((k) => k.id !== m.id) }, 'Delete marker') }, { divider: true }] : []),
      { label: 'Add marker here', icon: 'marker', disabled: !canEdit, onClick: () => actions.addMarker(t) },
      { label: doc.loop?.on ? 'Turn loop off' : 'Turn loop on', icon: 'loop', disabled: !canEdit || !doc.loop, onClick: () => edit({ ...doc, loop: { ...doc.loop, on: !doc.loop.on } }, 'Loop') },
      { label: 'Clear loop', disabled: !canEdit || !doc.loop, onClick: () => edit({ ...doc, loop: null }, 'Clear loop') },
    ]);
  };

  return (
    <div className="h-full flex flex-col min-w-0 bg-work">
      <div className="flex shrink-0 border-b border-line bg-panel" style={{ height: RULER_H }}>
        <div style={{ width: HEADER_W }} className="shrink-0 border-r border-line flex items-center gap-1 px-2 text-[11px] text-fg2">
          <span className="font-mono tabular-nums text-fg text-[12px]" title="Session length">{fmtClock(end, false)}</span>
          <span className="flex-1" />
          {canEdit && <button type="button" onClick={() => actions.addTrack()} className="h-6 px-1.5 rounded hover:bg-hover flex items-center gap-1" title="Add track"><Icon name="plus" size={13} />Track</button>}
        </div>
        <div className="relative flex-1 min-w-0 overflow-hidden">
          <canvas ref={ruler} className="absolute inset-0 cursor-pointer" onPointerDown={onRulerDown} onContextMenu={onRulerContext} data-testid="ruler" />
          <div ref={rulerHead} className="absolute top-0 bottom-0 left-0 pointer-events-none" style={{ width: 0 }}>
            <div className="absolute -left-[6px] bottom-0 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-[#ff5c6c]" />
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div style={{ width: HEADER_W }} className="shrink-0 border-r border-line bg-panel overflow-hidden relative">
          <div ref={headInner}>
            {doc.tracks.map((t) => (
              <TrackHeader key={t.id} t={t} doc={doc} engine={engine} edit={edit} commit={commit} canEdit={canEdit} selected={selTrack === t.id}
                onSelect={() => setSelTrack(t.id)} armed={armed.has(t.id)} toggleArm={() => toggleArm(t.id)} actions={actions} />
            ))}
            {canEdit && (
              <button type="button" onClick={() => actions.addTrack()} className="w-full h-10 text-[12px] text-fg3 hover:text-fg hover:bg-hover flex items-center justify-center gap-1.5">
                <Icon name="plus" size={14} />Add track
              </button>
            )}
          </div>
        </div>
        <div className="relative flex-1 min-w-0">
          <canvas ref={canvas} className="absolute left-0 top-0 pointer-events-none" />
          <div ref={scroller} className="absolute inset-0 overflow-auto scroll-thin" data-testid="lanes"
            onScroll={onScroll} onPointerDown={onDown} onPointerMove={onMove} onDoubleClick={onDoubleClick} onContextMenu={onContext} onDragOver={onDragOver} onDrop={onDrop}>
            <div style={{ width: contentW, height: contentH }} />
          </div>
          <div ref={playhead} className="absolute top-0 left-0 pointer-events-none" style={{ height: size.h, width: 0 }}>
            <div className="absolute top-0 bottom-0 -left-px w-px bg-[#ff5c6c]" />
          </div>
          {!doc.tracks.some((t) => t.clips.length) && (
            <div className="absolute inset-x-0 top-1/3 text-center pointer-events-none text-fg3 text-sm">
              <Icon name="audio" size={30} className="mx-auto mb-2 opacity-60" />
              Drag files here from the Files panel, use <b className="text-fg2">Import</b>, or arm a track and press <b className="text-fg2">Record</b>.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- track header

function TrackHeader({ t, doc, engine, edit, commit, canEdit, selected, onSelect, armed, toggleArm, actions }) {
  const key = (k) => `${k}-${t.id}`;
  const set = (patch, label, merge) => edit(updateTrack(doc, t.id, patch), label, merge ? { merge: key(merge) } : undefined);
  const getLevel = useCallback((lv) => (armed ? lv.input : lv.tracks.get(t.id)), [armed, t.id]);
  const compact = t.height < 78;
  const resize = (e) => {
    e.stopPropagation(); e.preventDefault();
    const y0 = e.clientY; const h0 = t.height; const mk = uid('h');
    const move = (ev) => edit(updateTrack(doc, t.id, { height: clamp(h0 + ev.clientY - y0, 44, 320) }), 'Track height', { merge: mk });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); commit(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const menu = (e) => {
    e.preventDefault();
    const i = doc.tracks.findIndex((x) => x.id === t.id);
    openMenu(e, [
      { label: 'Rename…', icon: 'edit', disabled: !canEdit, onClick: () => actions.renameTrack(t.id) },
      { label: 'Colour', icon: 'palette', disabled: !canEdit, items: TRACK_COLORS.map((c) => ({ label: c, checked: t.color === c, onClick: () => set({ color: c }, 'Track colour') })) },
      { label: 'Duplicate track', icon: 'duplicate', disabled: !canEdit, onClick: () => actions.duplicateTrack(t.id) },
      { label: 'Move up', disabled: !canEdit || i === 0, onClick: () => actions.moveTrack(t.id, -1) },
      { label: 'Move down', disabled: !canEdit || i === doc.tracks.length - 1, onClick: () => actions.moveTrack(t.id, 1) },
      { divider: true },
      { label: 'Delete track', icon: 'trash', danger: true, disabled: !canEdit, onClick: () => actions.deleteTrack(t.id) },
    ]);
  };
  const btn = (on, label, title, onClick, color) => (
    <button type="button" title={title} onClick={(e) => { e.stopPropagation(); onClick(); }} disabled={!canEdit && label !== 'R'}
      className={cx('w-6 h-5 rounded text-[10.5px] font-bold transition', on ? color : 'bg-chip text-fg2 hover:text-fg hover:bg-chip-hover')}>{label}</button>
  );
  return (
    <div style={{ height: t.height }} onPointerDown={onSelect} onContextMenu={menu} data-track={t.name}
      className={cx('relative border-b border-line flex flex-col gap-1 pl-3 pr-2 py-1.5', selected ? 'bg-active/40' : '')}>
      <div className="absolute left-0 top-0 bottom-0 w-[4px]" style={{ background: t.color }} />
      <div className="flex items-center gap-1 min-w-0">
        <button type="button" className="flex-1 min-w-0 text-left text-[12.5px] font-medium truncate hover:text-accent" title="Double-click to rename"
          onDoubleClick={() => canEdit && actions.renameTrack(t.id)}>{t.name}</button>
        {t.effects.length > 0 && <span className="text-[9.5px] font-semibold px-1 rounded bg-accent/20 text-accent" title={`${t.effects.filter((x) => x.on).length} effects on`}>FX</span>}
        {btn(t.mute, 'M', 'Mute', () => set({ mute: !t.mute }, t.mute ? 'Unmute' : 'Mute'), 'bg-[#e8a33a] text-black')}
        {btn(t.solo, 'S', 'Solo', () => set({ solo: !t.solo }, t.solo ? 'Unsolo' : 'Solo'), 'bg-[#e8d43a] text-black')}
        {btn(armed, 'R', 'Arm for recording', toggleArm, 'bg-[#ff4d5e] text-white')}
      </div>
      {!compact && (
        <>
          <MiniSlider label="Vol" value={t.volume} min={-60} max={12} step={0.1} format={fmtDb} disabled={!canEdit}
            onChange={(v) => set({ volume: v }, 'Track volume', 'vol')} onCommit={commit} />
          <MiniSlider label="Pan" value={t.pan} min={-1} max={1} step={0.01} disabled={!canEdit}
            format={(v) => (Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'}${Math.round(Math.abs(v) * 100)}`)}
            onChange={(v) => set({ pan: v }, 'Track pan', 'pan')} onCommit={commit} />
        </>
      )}
      <Meter engine={engine} get={getLevel} className="h-1.5 mt-auto" />
      {canEdit && <div className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize" onPointerDown={resize} />}
    </div>
  );
}

export { sortClips };
