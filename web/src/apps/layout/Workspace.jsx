// The layout workspace: spreads on a pasteboard drawn on one canvas, with rulers, guides, snapping, frame handles,
// text-thread ports, the loaded-text cursor, and text editing (our own caret + a hidden textarea for typing/IME/clipboard).
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSize } from '../../components/ui.jsx';
import { useKeyHeld, isMac } from '../../lib/shortcuts.js';
import { spreads, pageSide, pageMargins, columnGuides, itemsOnPage, bounds, findItem, uid, PAGE_NUM, LINE_BREAK, colorOf } from './model.js';
import { drawItem, getImage } from './render.js';
import { caretX, posAtX, wordAt, paraRange, paraAt, emptyStory } from './text.js';
import * as ops from './ops.js';

const GAP = 40; // points between spreads
const HANDLE = 4; // half-size of a handle in screen px

/** Where every page sits on the pasteboard (points). Parent pages are shown on their own when being edited. */
export function computeSlots(doc, masterEdit) {
  const W = doc.width; const H = doc.height;
  if (masterEdit) {
    const sides = doc.facing ? ['L', 'R'] : ['R'];
    return sides.map((s) => ({ key: `m${s}`, where: 'm', pageId: masterEdit, side: s, idx: null, gx: doc.facing ? (s === 'L' ? -W : 0) : -W / 2, gy: 0, spread: 0 }));
  }
  const out = [];
  let y = 0;
  spreads(doc).forEach((sp, si) => {
    sp.forEach((i) => {
      const side = pageSide(doc, i);
      out.push({ key: doc.pages[i].id, where: i, pageId: doc.pages[i].id, side, idx: i, gx: doc.facing ? (side === 'L' ? -W : 0) : -W / 2, gy: y, spread: si });
    });
    y += H + GAP;
  });
  return out;
}

const handlesOf = (r) => [[r.x, r.y], [r.x + r.w / 2, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h / 2], [r.x + r.w, r.y + r.h], [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y + r.h / 2]];
const HANDLE_CURSORS = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'];

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1; const dy = y2 - y1; const l = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export default function Workspace({ ed, ref }) {
  const { doc, layout, slots, opts } = ed;
  const wrap = useRef(null); const cv = useRef(null); const rtop = useRef(null); const rleft = useRef(null); const ta = useRef(null);
  const size = useSize(wrap);
  const view = ed.view || { zoom: 1, x: 0, y: 0 };
  const z = view.zoom;
  const drag = useRef(null);
  const [ov, setOv] = useState(null); // transient overlay: { marquee, create, guide, snap }
  const space = useKeyHeld('space');
  const [cursor, setCursor] = useState('default');
  const [blinkKey, setBlinkKey] = useState(0);
  const RULER = opts.rulers ? 20 : 0;

  const slotByPage = useMemo(() => new Map(slots.filter((s) => s.idx !== null).map((s) => [s.pageId, s])), [slots]);
  const slotOf = useCallback((it) => {
    if (!it) return null;
    if (ed.masterEdit) return slots.find((s) => s.side === (doc.facing ? it.side || 'R' : 'R')) || slots[0];
    return slotByPage.get(it.page) || null;
  }, [slots, slotByPage, ed.masterEdit, doc.facing]);
  const editableOn = useCallback((slot) => (ed.masterEdit
    ? doc.items.filter((it) => it.page === ed.masterEdit && (!doc.facing || (it.side || 'R') === slot.side))
    : doc.items.filter((it) => it.page === slot.pageId)), [doc, ed.masterEdit]);
  const masterOn = useCallback((slot) => (ed.masterEdit || slot.idx === null ? [] : itemsOnPage(doc, slot.idx).master), [doc, ed.masterEdit]);

  const toDoc = useCallback((cx, cy) => { const r = cv.current.getBoundingClientRect(); return { x: (cx - r.left - view.x) / z, y: (cy - r.top - view.y) / z }; }, [view.x, view.y, z]);
  const slotAt = useCallback((p, nearest = true) => {
    let best = null; let bd = Infinity;
    for (const s of slots) {
      const dx = Math.max(s.gx - p.x, 0, p.x - (s.gx + doc.width)); const dy = Math.max(s.gy - p.y, 0, p.y - (s.gy + doc.height));
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = s; }
    }
    return bd === 0 || nearest ? best : null;
  }, [slots, doc.width, doc.height]);
  const gRect = useCallback((it) => { const s = slotOf(it); const b = bounds(it); return s ? { x: s.gx + b.x, y: s.gy + b.y, w: b.w, h: b.h } : null; }, [slotOf]);

  // ---------------------------------------------------------------- view helpers

  const setView = ed.setView;
  const fit = useCallback((kind = 'page', slotIdx) => {
    if (!size.width || !slots.length) return;
    const cur = slots.find((s) => s.idx === (slotIdx ?? ed.curPage)) || slots[0];
    const group = kind === 'spread' ? slots.filter((s) => s.spread === cur.spread) : [cur];
    const x0 = Math.min(...group.map((s) => s.gx)); const x1 = Math.max(...group.map((s) => s.gx + doc.width));
    const y0 = cur.gy; const y1 = cur.gy + doc.height;
    const W = size.width - RULER; const Hh = size.height - RULER;
    const zz = Math.min((W - 60) / (x1 - x0), (Hh - 60) / (y1 - y0));
    setView({ zoom: zz, x: RULER + (W - (x1 - x0) * zz) / 2 - x0 * zz, y: RULER + (Hh - (y1 - y0) * zz) / 2 - y0 * zz });
  }, [size.width, size.height, slots, doc.width, doc.height, ed.curPage, setView, RULER]);
  const zoomAt = useCallback((nz, sx, sy) => {
    nz = Math.max(0.05, Math.min(40, nz));
    const px = sx ?? size.width / 2; const py = sy ?? size.height / 2;
    setView((v) => { const vv = v || view; return { zoom: nz, x: px - (px - vv.x) * (nz / vv.zoom), y: py - (py - vv.y) * (nz / vv.zoom) }; });
  }, [size.width, size.height, setView, view]);

  useEffect(() => { if (!ed.view && size.width) fit(doc.facing && doc.pages.length > 1 ? 'page' : 'page', 0); }, [size.width, ed.view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Current page = the page closest to the middle of the window.
  useEffect(() => {
    if (!size.width || ed.masterEdit) return;
    const c = { x: (size.width / 2 - view.x) / z, y: (size.height / 2 - view.y) / z };
    const s = slotAt(c);
    if (s && s.idx !== null && s.idx !== ed.curPage) ed.setCurPage(s.idx);
  }, [view, size, slotAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const showRect = useCallback((r, pad = 40) => {
    const W = size.width; const Hh = size.height;
    setView((v) => {
      const vv = v || view;
      const sx = r.x * vv.zoom + vv.x; const sy = r.y * vv.zoom + vv.y;
      let { x, y } = vv;
      if (sx < RULER + pad || sx + r.w * vv.zoom > W - pad) x = (W + RULER) / 2 - (r.x + r.w / 2) * vv.zoom;
      if (sy < RULER + pad || sy + r.h * vv.zoom > Hh - pad) y = (Hh + RULER) / 2 - (r.y + r.h / 2) * vv.zoom;
      return x === vv.x && y === vv.y ? vv : { ...vv, x, y };
    });
  }, [size, setView, view, RULER]);

  useImperativeHandle(ref, () => ({
    fit, zoomBy: (f) => zoomAt(z * f), zoomTo: (v) => zoomAt(v),
    showPage: (i) => { const s = slots.find((x) => x.idx === i); if (s) setView((v) => ({ ...(v || view), y: RULER + 30 - s.gy * (v || view).zoom })); },
    showItem: (id) => { const r = gRect(findItem(doc, id)); if (r) showRect(r); },
    editableIds: () => slots.flatMap((s) => editableOn(s)).map((it) => it.id).filter((v, i, a) => a.indexOf(v) === i),
  }), [fit, zoomAt, z, slots, setView, view, gRect, doc, showRect, editableOn, RULER]);

  // ---------------------------------------------------------------- drawing

  const caret = useMemo(() => {
    if (!ed.edit) return null;
    const loc = ed.locate(ed.edit.sid, ed.edit.f);
    if (!loc) return null;
    const s = ed.masterEdit ? slotOf(loc.it) : slots.find((x) => x.where === loc.where);
    if (!s) return null;
    return { x: s.gx + loc.it.x + caretX(loc.line, ed.edit.f), y: s.gy + loc.it.y + loc.line.top, h: loc.line.bottom - loc.line.top };
  }, [ed.edit, ed.locate, slots, slotOf, ed.masterEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the caret visible while typing
  useEffect(() => { if (caret && ed.edit) showRect({ x: caret.x - 10, y: caret.y, w: 20, h: caret.h }, 20); setBlinkKey((k) => k + 1); }, [ed.edit?.f, ed.edit?.sid]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const c = cv.current;
    if (!c || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(size.width * dpr); const Hh = Math.round(size.height * dpr);
    if (c.width !== W || c.height !== Hh) { c.width = W; c.height = Hh; }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const light = document.documentElement.classList.contains('light');
    ctx.fillStyle = opts.preview ? (light ? '#9a9ca5' : '#3a3b40') : (light ? '#c9cbd2' : '#2b2c31');
    ctx.fillRect(0, 0, W, Hh);
    const px = 1 / z; // one screen pixel in points
    const visible = (s) => (s.gx + doc.width) * z + view.x > 0 && s.gx * z + view.x < size.width && (s.gy + doc.height) * z + view.y > 0 && s.gy * z + view.y < size.height;
    const vis = slots.filter(visible);
    const at = (s) => ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (view.x + s.gx * z), dpr * (view.y + s.gy * z));
    // paper (and the bleed line) first so items hanging off a page aren't covered by its neighbour
    for (const s of vis) {
      at(s);
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(3 * px, 3 * px, doc.width, doc.height);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, doc.width, doc.height);
    }
    const editRange = ed.edit && ed.range && ed.range[1] > ed.range[0] ? ed.range : null;
    for (const s of vis) {
      at(s);
      const list = [...masterOn(s), ...editableOn(s)];
      for (const it of list) {
        drawItem(ctx, doc, it, { lines: it.type === 'text' ? layout.lines(it.id, s.where) : null, placeholder: !opts.preview, zoom: z, sel: editRange && it.type === 'text' && it.story === ed.edit.sid ? editRange : null });
      }
    }
    if (!opts.preview) {
      for (const s of vis) {
        at(s);
        ctx.lineWidth = px;
        // bleed
        // bleed goes around the whole spread, not each page
        const group = vis.filter((x) => x.spread === s.spread);
        if (doc.bleed && group[0] === s) {
          const x0 = Math.min(...group.map((g) => g.gx)) - s.gx; const x1 = Math.max(...group.map((g) => g.gx)) - s.gx + doc.width;
          ctx.strokeStyle = 'rgba(230,40,40,.8)'; ctx.strokeRect(x0 - doc.bleed, -doc.bleed, x1 - x0 + doc.bleed * 2, doc.height + doc.bleed * 2);
        }
        ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.strokeRect(0, 0, doc.width, doc.height);
        if (opts.guides) {
          const m = pageMargins(doc, s.idx ?? 0, s.side);
          ctx.strokeStyle = '#d94ed9'; ctx.strokeRect(m.left, m.top, doc.width - m.left - m.right, doc.height - m.top - m.bottom);
          ctx.strokeStyle = '#8c63ff';
          for (const x of columnGuides(doc, m)) { ctx.beginPath(); ctx.moveTo(x, m.top); ctx.lineTo(x, doc.height - m.bottom); ctx.stroke(); }
          ctx.strokeStyle = '#33c7e6';
          for (const g of guidesOf(s)) { ctx.beginPath(); if (g.o === 'h') { ctx.moveTo(-20, g.p); ctx.lineTo(doc.width + 20, g.p); } else { ctx.moveTo(g.p, -20); ctx.lineTo(g.p, doc.height + 20); } ctx.stroke(); }
        }
        if (opts.edges) {
          ctx.strokeStyle = 'rgba(70,140,255,.55)';
          for (const it of [...masterOn(s), ...editableOn(s)]) {
            if ((it.type === 'text' || (it.type === 'image')) && !colorOf(doc, it.stroke)) { ctx.setLineDash(masterOn(s).includes(it) ? [3 * px, 3 * px] : []); ctx.strokeRect(it.x, it.y, it.w, it.h); }
          }
          ctx.setLineDash([]);
        }
        // overset text: a red + in the out-port of the last frame
        for (const it of [...masterOn(s), ...editableOn(s)]) {
          if (it.type !== 'text') continue;
          const st = doc.stories[it.story];
          if (!st || st.frames[st.frames.length - 1] !== it.id || !layout.overset[it.story]) continue;
          const [ox, oy] = [it.x + it.w, it.y + it.h - 18 * px];
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e0303a'; ctx.lineWidth = px;
          ctx.fillRect(ox - 4 * px, oy - 4 * px, 8 * px, 8 * px); ctx.strokeRect(ox - 4 * px, oy - 4 * px, 8 * px, 8 * px);
          ctx.fillStyle = '#e0303a'; ctx.fillRect(ox - 3 * px, oy - 0.5 * px, 6 * px, px); ctx.fillRect(ox - 0.5 * px, oy - 3 * px, px, 6 * px);
        }
      }
    }
    // selection
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = (gx, gy) => [gx * z + view.x, gy * z + view.y];
    const accent = '#3b8bff';
    const selItems = ed.selItems;
    for (const it of selItems) {
      const r = gRect(it);
      if (!r) continue;
      const [x, y] = S(r.x, r.y);
      ctx.strokeStyle = it.masterRef ? '#d94ed9' : accent; ctx.lineWidth = 1;
      if (it.type === 'line') {
        const s = slotOf(it); const [a, b] = S(s.gx + it.x, s.gy + it.y); const [c, d] = S(s.gx + it.x + it.w, s.gy + it.y + it.h);
        ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke();
        if (selItems.length === 1) for (const [hx, hy] of [[a, b], [c, d]]) { ctx.fillStyle = '#fff'; ctx.fillRect(hx - HANDLE, hy - HANDLE, HANDLE * 2, HANDLE * 2); ctx.strokeRect(hx - HANDLE + 0.5, hy - HANDLE + 0.5, HANDLE * 2 - 1, HANDLE * 2 - 1); }
        continue;
      }
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(r.w * z), Math.round(r.h * z));
      if (ed.tool === 'direct' && it.type === 'image' && it.asset && selItems.length === 1) {
        // the image inside its frame (brown, like InDesign's direct selection)
        const [cx, cy] = S(r.x + (it.cx || 0), r.y + (it.cy || 0));
        const cw = (it.iw || 1) * (it.cs || 1) * z; const ch = (it.ih || 1) * (it.csy || it.cs || 1) * z;
        ctx.strokeStyle = '#c9772b'; ctx.strokeRect(cx + 0.5, cy + 0.5, cw, ch);
        ctx.globalAlpha = 0.35; const img = getImage(it.asset); if (img) ctx.drawImage(img, cx, cy, cw, ch); ctx.globalAlpha = 1;
        continue;
      }
      if (selItems.length === 1 && ed.tool !== 'type') {
        for (const [hx, hy] of handlesOf({ x, y, w: r.w * z, h: r.h * z })) { ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(hx) - HANDLE, Math.round(hy) - HANDLE, HANDLE * 2, HANDLE * 2); ctx.strokeStyle = accent; ctx.strokeRect(Math.round(hx) - HANDLE + 0.5, Math.round(hy) - HANDLE + 0.5, HANDLE * 2 - 1, HANDLE * 2 - 1); }
      }
      if (it.type === 'text') drawPorts(ctx, it, x, y, r.w * z, r.h * z);
    }
    // text threads of the selected/edited story
    if (opts.threads && !opts.preview) {
      const sids = new Set([...selItems.filter((x) => x.type === 'text').map((x) => x.story), ...(ed.edit ? [ed.edit.sid] : [])]);
      for (const sid of sids) {
        const fr = (doc.stories[sid]?.frames || []).map((id) => findItem(doc, id)).filter(Boolean);
        for (let k = 0; k < fr.length - 1; k++) {
          const a = gRect(fr[k]); const b = gRect(fr[k + 1]);
          if (!a || !b) continue;
          const [x1, y1] = S(a.x + a.w, a.y + a.h - 18 / z); const [x2, y2] = S(b.x, b.y + 18 / z);
          ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x1, y1);
          ctx.bezierCurveTo(x1 + 40, y1, x2 - 40, y2, x2, y2); ctx.stroke();
        }
      }
    }
    function drawPorts(c, it, x, y, w, hh) {
      const st = doc.stories[it.story];
      if (!st) return;
      const idx = st.frames.indexOf(it.id);
      const over = layout.overset[it.story] && idx === st.frames.length - 1;
      for (const [px2, py2, kind] of [[x, y + 18, 'in'], [x + w, y + hh - 18, 'out']]) {
        c.fillStyle = '#fff'; c.strokeStyle = over && kind === 'out' ? '#e0303a' : accent;
        c.fillRect(px2 - 5, py2 - 5, 10, 10); c.strokeRect(px2 - 4.5, py2 - 4.5, 9, 9);
        const linked = kind === 'in' ? idx > 0 : idx < st.frames.length - 1;
        if (linked) { c.fillStyle = accent; c.beginPath(); c.moveTo(px2 - 2.5, py2 - 3); c.lineTo(px2 + 3, py2); c.lineTo(px2 - 2.5, py2 + 3); c.fill(); }
        if (over && kind === 'out') { c.fillStyle = '#e0303a'; c.fillRect(px2 - 3, py2 - 0.5, 6, 1.5); c.fillRect(px2 - 0.75, py2 - 3, 1.5, 6); }
      }
    }
    // transient overlays
    if (ov?.marquee || ov?.create) {
      const r = ov.marquee || ov.create;
      const [x, y] = S(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1));
      ctx.strokeStyle = ov.marquee ? '#8aa' : accent; ctx.setLineDash(ov.marquee ? [4, 3] : []);
      if (ov.create?.line) { const [a, b] = S(r.x0, r.y0); const [c2, d] = S(r.x1, r.y1); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c2, d); ctx.stroke(); }
      else ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(r.x1 - r.x0) * z, Math.abs(r.y1 - r.y0) * z);
      ctx.setLineDash([]);
    }
    if (ov?.guide) {
      ctx.strokeStyle = '#33c7e6'; ctx.beginPath();
      if (ov.guide.o === 'h') { const y = ov.guide.p * z + view.y; ctx.moveTo(0, y); ctx.lineTo(size.width, y); } else { const x = ov.guide.p * z + view.x; ctx.moveTo(x, 0); ctx.lineTo(x, size.height); }
      ctx.stroke();
    }
    for (const sl of ov?.snap || []) {
      ctx.strokeStyle = '#ff3d9a'; ctx.beginPath();
      if (sl.o === 'v') { const x = sl.p * z + view.x; ctx.moveTo(x, 0); ctx.lineTo(x, size.height); } else { const y = sl.p * z + view.y; ctx.moveTo(0, y); ctx.lineTo(size.width, y); }
      ctx.stroke();
    }
  });

  function guidesOf(s) {
    if (ed.masterEdit) return doc.masters.find((m) => m.id === ed.masterEdit)?.guides || [];
    const p = doc.pages[s.idx];
    const mg = p.master ? doc.masters.find((m) => m.id === p.master)?.guides || [] : [];
    return [...mg, ...(p.guides || [])];
  }

  // ---------------------------------------------------------------- rulers

  const origin = useMemo(() => {
    if (ed.masterEdit) return slots[0];
    return slots.find((s) => s.idx === ed.curPage) || slots[0];
  }, [slots, ed.curPage, ed.masterEdit]);
  useLayoutEffect(() => {
    if (!opts.rulers || !size.width || !origin) return;
    const dpr = window.devicePixelRatio || 1;
    const light = document.documentElement.classList.contains('light');
    for (const [el, horiz] of [[rtop.current, true], [rleft.current, false]]) {
      if (!el) continue;
      const len = horiz ? size.width : size.height;
      el.width = (horiz ? len : RULER) * dpr; el.height = (horiz ? RULER : len) * dpr;
      const c = el.getContext('2d');
      // the left ruler is the top one turned 90° clockwise
      if (horiz) c.setTransform(dpr, 0, 0, dpr, 0, 0); else c.setTransform(0, dpr, -dpr, 0, RULER * dpr, 0);
      c.fillStyle = light ? '#eceef3' : '#24262c'; c.fillRect(0, 0, len, RULER);
      c.fillStyle = light ? '#5a5f70' : '#8b90a0'; c.font = '9px Inter, sans-serif';
      const o = horiz ? origin.gx * z + view.x : origin.gy * z + view.y;
      const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
      const major = steps.find((s) => s * z >= 50) || 1000;
      const minor = major / (major >= 10 && String(major)[0] === '5' ? 5 : 10);
      const start = Math.floor((-o) / z / minor) * minor;
      for (let v = start; v * z + o < len; v += minor) {
        const p = Math.round(v * z + o) + 0.5;
        const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        const t = isMajor ? RULER : (Math.abs(v / (major / 2) - Math.round(v / (major / 2))) < 1e-6 ? RULER * 0.45 : RULER * 0.25);
        c.fillRect(Math.floor(p), RULER - t, 1, t);
        if (isMajor) c.fillText(String(Math.round(v)), p + 2, 9);
      }
      c.fillRect(0, RULER - 1, len, 1);
    }
  });

  // ---------------------------------------------------------------- snapping

  const snapTargets = useCallback((slot, exclude) => {
    const m = pageMargins(doc, slot.idx ?? 0, slot.side);
    const xs = [0, doc.width, doc.width / 2, m.left, doc.width - m.right, ...columnGuides(doc, m)];
    const ys = [0, doc.height, doc.height / 2, m.top, doc.height - m.bottom];
    for (const g of guidesOf(slot)) (g.o === 'h' ? ys : xs).push(g.p);
    for (const it of [...masterOn(slot), ...editableOn(slot)]) {
      if (exclude.has(it.id)) continue;
      const b = bounds(it);
      xs.push(b.x, b.x + b.w, b.x + b.w / 2); ys.push(b.y, b.y + b.h, b.y + b.h / 2);
    }
    return { xs: xs.map((v) => v + slot.gx), ys: ys.map((v) => v + slot.gy) };
  }, [doc, masterOn, editableOn]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Best snap offset for a set of candidate values against targets (within 6 screen px). */
  const snap1 = (vals, targets) => {
    let best = null;
    const thr = 6 / z;
    for (const v of vals) for (const t of targets) { const d = t - v; if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, p: t }; }
    return best;
  };

  // ---------------------------------------------------------------- hit testing

  const hitItem = useCallback((p, { includeMaster } = {}) => {
    const s = slotAt(p);
    if (!s) return null;
    const lx = p.x - s.gx; const ly = p.y - s.gy;
    const tol = 4 / z;
    const test = (it) => {
      if (it.hidden || it.locked) return false;
      if (it.type === 'line') return distToSeg(lx, ly, it.x, it.y, it.x + it.w, it.y + it.h) <= Math.max(tol, (it.sw || 1) / 2);
      const b = bounds(it);
      return lx >= b.x - tol && lx <= b.x + b.w + tol && ly >= b.y - tol && ly <= b.y + b.h + tol;
    };
    // also look on neighbouring pages of the same spread (items can hang over the spine)
    const group = slots.filter((x) => x.spread === s.spread);
    for (const g of [s, ...group.filter((x) => x !== s)]) {
      const lx2 = p.x - g.gx; const ly2 = p.y - g.gy;
      const own = editableOn(g);
      for (let i = own.length - 1; i >= 0; i--) {
        const it = own[i];
        const b = bounds(it);
        const ok = it.type === 'line' ? distToSeg(lx2, ly2, it.x, it.y, it.x + it.w, it.y + it.h) <= Math.max(tol, (it.sw || 1) / 2)
          : lx2 >= b.x - tol && lx2 <= b.x + b.w + tol && ly2 >= b.y - tol && ly2 <= b.y + b.h + tol;
        if (ok && !it.hidden && !it.locked) return { it, slot: g };
      }
    }
    if (includeMaster) {
      const ms = masterOn(s);
      for (let i = ms.length - 1; i >= 0; i--) if (test(ms[i])) return { it: ms[i], slot: s, master: true };
    }
    return null;
  }, [slotAt, slots, editableOn, masterOn, z]);

  const hitHandle = useCallback((sx, sy) => {
    if (ed.selItems.length !== 1 || ed.tool === 'type') return null;
    const it = ed.selItems[0];
    const s = slotOf(it);
    if (!s) return null;
    if (it.type === 'line') {
      const pts = [[s.gx + it.x, s.gy + it.y], [s.gx + it.x + it.w, s.gy + it.y + it.h]];
      for (let k = 0; k < 2; k++) { const hx = pts[k][0] * z + view.x; const hy = pts[k][1] * z + view.y; if (Math.abs(hx - sx) <= HANDLE + 2 && Math.abs(hy - sy) <= HANDLE + 2) return { it, k, line: true }; }
      return null;
    }
    const r = gRect(it);
    const hs = handlesOf({ x: r.x * z + view.x, y: r.y * z + view.y, w: r.w * z, h: r.h * z });
    for (let k = 0; k < 8; k++) if (Math.abs(hs[k][0] - sx) <= HANDLE + 2 && Math.abs(hs[k][1] - sy) <= HANDLE + 2) return { it, k };
    return null;
  }, [ed.selItems, ed.tool, slotOf, gRect, z, view.x, view.y]);

  const hitPort = useCallback((sx, sy) => {
    for (const it of ed.selItems) {
      if (it.type !== 'text') continue;
      const r = gRect(it);
      if (!r) continue;
      const x = r.x * z + view.x; const y = r.y * z + view.y; const w = r.w * z; const hh = r.h * z;
      if (Math.abs(sx - (x + w)) <= 7 && Math.abs(sy - (y + hh - 18)) <= 7) return { it, kind: 'out' };
      if (Math.abs(sx - x) <= 7 && Math.abs(sy - (y + 18)) <= 7) return { it, kind: 'in' };
    }
    return null;
  }, [ed.selItems, gRect, z, view.x, view.y]);

  const hitGuide = useCallback((p) => {
    if (!opts.guides || opts.preview) return null;
    const s = slotAt(p, false);
    if (!s) return null;
    const own = ed.masterEdit ? doc.masters.find((m) => m.id === ed.masterEdit)?.guides || [] : doc.pages[s.idx].guides || [];
    const tol = 3 / z;
    const k = own.findIndex((g) => Math.abs((g.o === 'h' ? p.y - s.gy : p.x - s.gx) - g.p) <= tol);
    return k >= 0 ? { slot: s, k, g: own[k] } : null;
  }, [opts.guides, opts.preview, slotAt, ed.masterEdit, doc, z]);

  /** Text position under a point inside a text frame. */
  const textPos = useCallback((it, slot, p) => {
    const lines = layout.lines(it.id, slot.where);
    const lx = p.x - slot.gx - it.x; const ly = p.y - slot.gy - it.y;
    const st = doc.stories[it.story];
    if (!lines.length) return st.frames.indexOf(it.id) === 0 ? 0 : st.text.length;
    let best = lines[0]; let bd = Infinity;
    for (const l of lines) {
      const d = ly < l.top ? l.top - ly : ly > l.bottom ? ly - l.bottom : 0;
      const dx = lx < l.x - 2 ? 0 : 0;
      if (d + dx < bd || (d === 0 && bd === 0 && lx >= l.x)) { if (d < bd || (d === 0 && Math.abs(l.x - lx) < Math.abs(best.x - lx))) best = l; bd = Math.min(bd, d); }
    }
    // with several columns, prefer the line whose column contains x
    const inBand = lines.filter((l) => ly >= l.top && ly <= l.bottom);
    if (inBand.length > 1) best = inBand.find((l) => lx >= l.x - 6 && lx <= l.x + l.w + 6) || best;
    else if (!inBand.length) {
      const cands = lines.filter((l) => lx >= l.x - 6 && lx <= l.x + l.w + 6);
      if (cands.length) best = cands.reduce((m, l) => (Math.abs((l.top + l.bottom) / 2 - ly) < Math.abs((m.top + m.bottom) / 2 - ly) ? l : m));
    }
    return posAtX(best, lx);
  }, [layout, doc]);

  // ---------------------------------------------------------------- creating things

  const createItem = (slot, r, type) => {
    const base = { id: uid('f'), page: ed.masterEdit || slot.pageId, ...(ed.masterEdit && doc.facing ? { side: slot.side } : {}), fill: null, stroke: null, sw: 1, wrap: { mode: 'none', off: 0 } };
    const x = r.x - slot.gx; const y = r.y - slot.gy;
    if (type === 'line') return { ...base, type: 'line', x, y, w: r.w, h: r.h, stroke: 'black', sw: 1 };
    if (type === 'text') return { ...base, type: 'text', x, y, w: r.w, h: r.h, story: null, cols: 1, gutter: doc.columns.gutter, inset: 0 };
    if (type === 'frame') return { ...base, type: 'image', x, y, w: r.w, h: r.h };
    return { ...base, type, x, y, w: r.w, h: r.h, fill: 'sw-grey', stroke: 'black', sw: 1 };
  };

  const addText = (slot, r, sid) => {
    let fid;
    ed.change((d) => {
      const it = createItem(slot, r, 'text');
      fid = it.id;
      if (sid && d.stories[sid]) {
        it.story = sid;
        return { ...d, items: [...d.items, it], stories: { ...d.stories, [sid]: { ...d.stories[sid], frames: [...d.stories[sid].frames, it.id] } } };
      }
      const nsid = uid('s');
      it.story = nsid;
      return { ...d, items: [...d.items, it], stories: { ...d.stories, [nsid]: emptyStory('ps-basic', [it.id]) } };
    }, sid ? 'Thread text' : 'New text frame');
    return fid;
  };

  // ---------------------------------------------------------------- pointer handling

  const clicks = useRef({ t: 0, x: 0, y: 0, n: 0 });
  const onPointerDown = (e) => {
    if (e.button === 2) return;
    // count clicks ourselves (pointerdown has no click count) for double/triple-click text selection
    const c = clicks.current; const now = performance.now();
    c.n = now - c.t < 450 && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 5 ? c.n + 1 : 1;
    Object.assign(c, { t: now, x: e.clientX, y: e.clientY });
    e = { ...e, detail: c.n, clientX: e.clientX, clientY: e.clientY, button: e.button, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, pointerId: e.pointerId };
    const p = toDoc(e.clientX, e.clientY);
    const r = cv.current.getBoundingClientRect();
    const sx = e.clientX - r.left; const sy = e.clientY - r.top;
    cv.current.setPointerCapture(e.pointerId);
    const can = ed.canEdit;
    if (e.button === 1 || space.current || ed.tool === 'hand' || (!can && ed.tool !== 'zoom')) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: view };
      setCursor('grabbing');
      return;
    }
    if (ed.tool === 'zoom') { zoomAt(z * (e.altKey ? 0.5 : 2), sx, sy); return; }
    const slot = slotAt(p);
    if (ed.placing) { drag.current = { kind: 'create', type: 'place', p0: p, slot }; return; }
    if (ed.loaded) {
      const hit = hitItem(p);
      if (hit && hit.it.type === 'text') {
        if (hit.it.story === findItem(doc, ed.loaded.from)?.story) return;
        ed.change((d) => ops.threadFrames(d, ed.loaded.from, hit.it.id), 'Thread frames');
        ed.setLoaded(null); ed.setSel([hit.it.id]);
        return;
      }
      drag.current = { kind: 'create', type: 'thread', p0: p, slot };
      return;
    }
    if (ed.tool === 'type') {
      const hit = hitItem(p);
      if (hit && hit.it.type === 'text') { startText(hit, p, e); return; }
      drag.current = { kind: 'create', type: 'text', p0: p, slot };
      return;
    }
    if (['frame', 'rect', 'ellipse', 'line'].includes(ed.tool)) { drag.current = { kind: 'create', type: ed.tool, p0: p, slot }; return; }
    // selection / direct selection
    const port = hitPort(sx, sy);
    if (port) {
      if (port.kind === 'out') { ed.setLoaded({ from: port.it.id }); }
      return;
    }
    const hh = hitHandle(sx, sy);
    if (hh) { drag.current = { kind: hh.line ? 'lineEnd' : 'resize', k: hh.k, id: hh.it.id, orig: { ...hh.it }, p0: p, doc, key: uid('r') }; return; }
    const hit = hitItem(p, { includeMaster: true });
    if (hit?.master) {
      if (e.shiftKey && (e.ctrlKey || e.metaKey)) {
        let nid;
        ed.change((d) => { const r2 = ops.overrideMasterItem(d, hit.slot.idx, hit.it.id); nid = r2.id; return r2.doc; }, 'Override parent item');
        setTimeout(() => nid && ed.setSel([nid]), 0);
        return;
      }
    }
    if (hit && !hit.master) {
      const it = hit.it;
      if (ed.tool === 'direct' && it.type === 'image' && it.asset) {
        ed.setSel([it.id]);
        drag.current = { kind: 'content', id: it.id, orig: { ...it }, p0: p, key: uid('c') };
        return;
      }
      let ids = ed.sel.includes(it.id) ? ed.sel : [it.id];
      if (e.shiftKey) { ids = ed.sel.includes(it.id) ? ed.sel.filter((x) => x !== it.id) : [...ed.sel, it.id]; ed.setSel(ids); return; }
      ed.setSel(ids);
      drag.current = { kind: 'move', ids, p0: p, doc, alt: e.altKey, key: uid('m'), moved: false };
      return;
    }
    const g = hitGuide(p);
    if (g && can) { drag.current = { kind: 'guide', o: g.g.o, slot: g.slot, k: g.k, key: uid('g') }; return; }
    if (!e.shiftKey) ed.setSel([]);
    drag.current = { kind: 'marquee', p0: p, base: e.shiftKey ? ed.sel : [] };
  };

  const startText = (hit, p, e) => {
    const pos = textPos(hit.it, hit.slot, p);
    const st = doc.stories[hit.it.story];
    let a = pos; let f = pos;
    if (e.detail === 2) [a, f] = wordAt(st.text, pos);
    else if (e.detail >= 3) [a, f] = paraRange(st, paraAt(st, pos));
    else if (e.shiftKey && ed.edit?.sid === hit.it.story) a = ed.edit.a;
    ed.pending.current = null;
    ed.h.commit();
    ed.setEdit({ sid: hit.it.story, a, f });
    ed.setSel([hit.it.id]);
    drag.current = { kind: 'text', sid: hit.it.story, a, word: e.detail === 2 };
    setTimeout(() => ta.current?.focus({ preventScroll: true }), 0);
  };

  const onPointerMove = (e) => {
    const p = toDoc(e.clientX, e.clientY);
    const d = drag.current;
    if (!d) { hover(e, p); return; }
    if (d.kind === 'pan') { setView({ ...d.v, x: d.v.x + e.clientX - d.sx, y: d.v.y + e.clientY - d.sy }); return; }
    if (d.kind === 'marquee') { setOv({ marquee: { x0: d.p0.x, y0: d.p0.y, x1: p.x, y1: p.y } }); return; }
    if (d.kind === 'create') {
      let x1 = p.x; let y1 = p.y;
      if (e.shiftKey && d.type !== 'line') { const s = Math.max(Math.abs(x1 - d.p0.x), Math.abs(y1 - d.p0.y)); x1 = d.p0.x + Math.sign(x1 - d.p0.x || 1) * s; y1 = d.p0.y + Math.sign(y1 - d.p0.y || 1) * s; }
      if (e.shiftKey && d.type === 'line') { const ang = Math.round(Math.atan2(y1 - d.p0.y, x1 - d.p0.x) / (Math.PI / 4)) * (Math.PI / 4); const L = Math.hypot(x1 - d.p0.x, y1 - d.p0.y); x1 = d.p0.x + Math.cos(ang) * L; y1 = d.p0.y + Math.sin(ang) * L; }
      if (opts.snap && d.slot && d.type !== 'line') {
        const t = snapTargets(d.slot, new Set());
        const sxv = snap1([x1], t.xs); const syv = snap1([y1], t.ys);
        if (sxv) x1 += sxv.d; if (syv) y1 += syv.d;
      }
      d.p1 = { x: x1, y: y1 };
      setOv({ create: { x0: d.p0.x, y0: d.p0.y, x1, y1, line: d.type === 'line' } });
      return;
    }
    if (d.kind === 'text') {
      // drag-select, possibly into other frames of the story
      const hit = hitItem(p);
      let pos = null;
      if (hit && hit.it.type === 'text' && hit.it.story === d.sid) pos = textPos(hit.it, hit.slot, p);
      else {
        const fr = (doc.stories[d.sid]?.frames || []).map((id) => findItem(doc, id)).filter(Boolean);
        const it = fr.find((f) => { const r = gRect(f); return r && p.y >= r.y && p.y <= r.y + r.h; }) || null;
        if (it) pos = textPos(it, slotOf(it), p);
      }
      if (pos !== null) {
        const st = doc.stories[d.sid];
        if (d.word) { const [wa, wb] = wordAt(st.text, pos); ed.setEdit({ sid: d.sid, a: pos < d.a ? Math.max(...wordAt(st.text, d.a)) : Math.min(...wordAt(st.text, d.a)), f: pos < d.a ? wa : wb }); }
        else ed.setEdit({ sid: d.sid, a: d.a, f: pos });
      }
      return;
    }
    if (d.kind === 'move') {
      let dx = p.x - d.p0.x; let dy = p.y - d.p0.y;
      if (!d.moved && Math.hypot(dx, dy) * z < 3) return;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (!d.moved) {
        d.moved = true;
        if (d.alt) { const r2 = ops.cloneItems(d.doc, d.ids); d.doc = r2.doc; d.ids = r2.ids; ed.setSel(r2.ids); }
      }
      const items = d.ids.map((id) => findItem(d.doc, id)).filter(Boolean);
      const snaps = [];
      if (opts.snap && items.length) {
        const s0 = slotOf(items[0]);
        if (s0) {
          const rs = items.map((it) => { const b = bounds(it); return { x: s0.gx + b.x + dx, y: s0.gy + b.y + dy, w: b.w, h: b.h }; });
          const x0 = Math.min(...rs.map((r) => r.x)); const x1 = Math.max(...rs.map((r) => r.x + r.w));
          const y0 = Math.min(...rs.map((r) => r.y)); const y1 = Math.max(...rs.map((r) => r.y + r.h));
          const t = snapTargets(s0, new Set(d.ids));
          const sxv = snap1([x0, (x0 + x1) / 2, x1], t.xs); const syv = snap1([y0, (y0 + y1) / 2, y1], t.ys);
          if (sxv) { dx += sxv.d; snaps.push({ o: 'v', p: sxv.p }); }
          if (syv) { dy += syv.d; snaps.push({ o: 'h', p: syv.p }); }
        }
      }
      setOv(snaps.length ? { snap: snaps } : null);
      const set = new Set(d.ids);
      d.dx = dx; d.dy = dy;
      ed.change(() => ({ ...d.doc, items: d.doc.items.map((it) => (set.has(it.id) ? { ...it, x: it.x + dx, y: it.y + dy } : it)) }), d.alt ? 'Duplicate' : 'Move', d.key);
      return;
    }
    if (d.kind === 'content') {
      const dx = p.x - d.p0.x; const dy = p.y - d.p0.y;
      ed.change((doc2) => ops.updateItems(doc2, [d.id], { cx: (d.orig.cx || 0) + dx, cy: (d.orig.cy || 0) + dy }), 'Move content', d.key);
      return;
    }
    if (d.kind === 'lineEnd') {
      const o = d.orig; const dx = p.x - d.p0.x; const dy = p.y - d.p0.y;
      const patch = d.k === 0 ? { x: o.x + dx, y: o.y + dy, w: o.w - dx, h: o.h - dy } : { w: o.w + dx, h: o.h + dy };
      ed.change((doc2) => ops.updateItems(doc2, [d.id], patch), 'Resize', d.key);
      return;
    }
    if (d.kind === 'resize') {
      const o = d.orig; const s = slotOf(o);
      let px = p.x - s.gx; let py = p.y - s.gy;
      if (opts.snap) {
        const t = snapTargets(s, new Set([o.id]));
        const sxv = snap1([px + s.gx], t.xs); const syv = snap1([py + s.gy], t.ys);
        if (sxv) px += sxv.d; if (syv) py += syv.d;
      }
      let x0 = o.x; let y0 = o.y; let x1 = o.x + o.w; let y1 = o.y + o.h;
      const k = d.k;
      if ([0, 6, 7].includes(k)) x0 = px; if ([2, 3, 4].includes(k)) x1 = px;
      if ([0, 1, 2].includes(k)) y0 = py; if ([4, 5, 6].includes(k)) y1 = py;
      if (e.shiftKey && [0, 2, 4, 6].includes(k)) {
        const ar = o.w / o.h; const w = x1 - x0; const hh = y1 - y0;
        if (Math.abs(w / ar) > Math.abs(hh)) { const nh = Math.abs(w / ar) * Math.sign(hh || 1); if ([0, 2].includes(k)) y0 = y1 - nh; else y1 = y0 + nh; }
        else { const nw = Math.abs(hh * ar) * Math.sign(w || 1); if ([0, 6].includes(k)) x0 = x1 - nw; else x1 = x0 + nw; }
      }
      const nr = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
      ed.change((doc2) => ops.updateItems(doc2, [d.id], (it) => {
        let patch = nr;
        if (it.type === 'image' && it.asset && (it.autoFit || e.altKey)) patch = { ...nr, ...ed.fitImage({ ...it, ...nr }, it.fit || 'fill') };
        // shift-drag scales the picture with a proportional frame, like InDesign's Shift+Ctrl drag
        else if (it.type === 'image' && it.asset && e.shiftKey && (e.ctrlKey || e.metaKey)) { const f = nr.w / o.w; patch = { ...nr, cs: (o.cs || 1) * f, csy: o.csy ? o.csy * f : undefined, cx: (o.cx || 0) * f, cy: (o.cy || 0) * f }; }
        return patch;
      }), 'Resize', d.key);
      return;
    }
    if (d.kind === 'guide') {
      setOv({ guide: { o: d.o, p: d.o === 'h' ? p.y : p.x } });
      d.p = p;
      return;
    }
    if (d.kind === 'newguide') {
      setOv({ guide: { o: d.o, p: d.o === 'h' ? p.y : p.x } });
      d.p = p;
    }
  };

  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const p = toDoc(e.clientX, e.clientY);
    setCursor('default');
    if (d.kind === 'marquee') {
      setOv(null);
      const r = { x0: Math.min(d.p0.x, p.x), y0: Math.min(d.p0.y, p.y), x1: Math.max(d.p0.x, p.x), y1: Math.max(d.p0.y, p.y) };
      if ((r.x1 - r.x0) * z < 3 && (r.y1 - r.y0) * z < 3) return;
      const ids = [];
      for (const s of slots) for (const it of editableOn(s)) { const g = gRect(it); if (g && g.x < r.x1 && g.x + g.w > r.x0 && g.y < r.y1 && g.y + g.h > r.y0) ids.push(it.id); }
      ed.setSel([...new Set([...d.base, ...ids])]);
      return;
    }
    if (d.kind === 'create') {
      setOv(null);
      const p1 = d.p1 || p;
      let r = { x: Math.min(d.p0.x, p1.x), y: Math.min(d.p0.y, p1.y), w: Math.abs(p1.x - d.p0.x), h: Math.abs(p1.y - d.p0.y) };
      const tiny = r.w * z < 4 && r.h * z < 4;
      const slot = slotAt(d.p0);
      if (!slot) return;
      if (d.type === 'line') {
        if (tiny) return;
        const it = createItem(slot, { x: d.p0.x, y: d.p0.y, w: p1.x - d.p0.x, h: p1.y - d.p0.y }, 'line');
        ed.change((doc2) => ops.addItems(doc2, [it]), 'New line'); ed.setSel([it.id]);
        return;
      }
      if (d.type === 'place') {
        const [a, ...rest] = ed.placing;
        const iw = a.width || 800; const ih = a.height || 600;
        if (tiny) {
          // natural size at 150 ppi, limited to the page's margins
          const m = pageMargins(doc, slot.idx ?? 0, slot.side);
          const maxW = doc.width - m.left - m.right; const maxH = doc.height - m.top - m.bottom;
          const sc = Math.min(72 / 150, maxW / iw, maxH / ih);
          r = { x: d.p0.x, y: d.p0.y, w: iw * sc, h: ih * sc };
        }
        const base = { ...createItem(slot, r, 'frame'), asset: a.id, iw, ih, fit: 'fill' };
        const it = { ...base, ...ed.fitImage(base, 'fill') };
        ed.change((doc2) => ops.addItems(doc2, [it]), 'Place image');
        ed.setSel([it.id]);
        ed.setPlacing(rest.length ? rest : null);
        return;
      }
      if (d.type === 'thread' || (d.type === 'text' && tiny && false)) {
        if (tiny) {
          // click: a frame from the click down to the bottom margin, across the column
          const m = pageMargins(doc, slot.idx ?? 0, slot.side);
          const lx = d.p0.x - slot.gx; const ly = d.p0.y - slot.gy;
          const cols = [m.left, ...columnGuides(doc, m), doc.width - m.right];
          let c0 = m.left; let c1 = doc.width - m.right;
          for (let k = 0; k < cols.length; k += 2) if (lx >= cols[k] - 1 && lx <= cols[k + 1] + 1) { c0 = cols[k]; c1 = cols[k + 1]; }
          const top = Math.max(m.top, Math.min(ly, doc.height - m.bottom - 20));
          r = { x: slot.gx + c0, y: slot.gy + top, w: c1 - c0, h: doc.height - m.bottom - top };
        }
        const from = findItem(doc, ed.loaded.from);
        const fid = addText(slot, r, from?.story);
        ed.setLoaded(null); ed.setSel([fid]);
        return;
      }
      if (tiny) {
        if (d.type === 'text') return;
        r = { x: d.p0.x, y: d.p0.y, w: 72, h: 72 };
      }
      if (d.type === 'text') {
        const fid = addText(slot, r);
        const sid = undefined; // story id resolved after the change lands
        setTimeout(() => {
          const it = ed.h.get().items.find((x) => x.id === fid);
          if (it) { ed.setEdit({ sid: it.story, a: 0, f: 0 }); ed.setSel([fid]); ta.current?.focus({ preventScroll: true }); }
        }, 0);
        void sid;
        return;
      }
      const it = createItem(slot, r, d.type);
      ed.change((doc2) => ops.addItems(doc2, [it]), d.type === 'frame' ? 'New frame' : d.type === 'ellipse' ? 'New ellipse' : 'New rectangle');
      ed.setSel([it.id]);
      return;
    }
    if (d.kind === 'move') {
      setOv(null);
      if (!d.moved || ed.masterEdit) return;
      // dropped on another page: the item moves to that page (keeping where it is on screen)
      const set = new Set(d.ids);
      ed.change((cur) => {
        let changed = false;
        const items = cur.items.map((it) => {
          if (!set.has(it.id)) return it;
          const s = slotOf(it);
          const b = bounds(it);
          const c = { x: s.gx + b.x + b.w / 2, y: s.gy + b.y + b.h / 2 };
          const t = slotAt(c);
          if (!t || t === s || t.idx === null) return it;
          changed = true;
          return ops.moveItemToPage(it, t.pageId, s.gx - t.gx, s.gy - t.gy);
        });
        return changed ? { ...cur, items } : cur;
      }, 'Move', d.key);
      return;
    }
    if (d.kind === 'guide' || d.kind === 'newguide') {
      setOv(null);
      const pp = d.p;
      const r = cv.current.getBoundingClientRect();
      const inside = e.clientX - r.left > 0 && e.clientY - r.top > 0;
      ed.change((cur) => {
        const s = d.kind === 'guide' ? d.slot : pp && slotAt(pp);
        if (!s) return cur;
        const editGuides = (fn) => (ed.masterEdit
          ? { ...cur, masters: cur.masters.map((m) => (m.id === ed.masterEdit ? { ...m, guides: fn(m.guides || []) } : m)) }
          : { ...cur, pages: cur.pages.map((pg, i) => (i === s.idx ? { ...pg, guides: fn(pg.guides || []) } : pg)) });
        if (d.kind === 'guide') {
          if (!pp || !inside) return editGuides((g) => g.filter((_, k) => k !== d.k));
          const v = d.o === 'h' ? pp.y - s.gy : pp.x - s.gx;
          return editGuides((g) => g.map((x, k) => (k === d.k ? { ...x, p: v } : x)));
        }
        if (!pp || !inside) return cur;
        return editGuides((g) => [...g, { o: d.o, p: d.o === 'h' ? pp.y - s.gy : pp.x - s.gx }]);
      }, d.kind === 'guide' ? 'Move guide' : 'New guide');
    }
  };

  const hover = (e, p) => {
    const r = cv.current.getBoundingClientRect();
    const sx = e.clientX - r.left; const sy = e.clientY - r.top;
    let c = 'default';
    if (space.current || ed.tool === 'hand') c = 'grab';
    else if (ed.tool === 'zoom') c = e.altKey ? 'zoom-out' : 'zoom-in';
    else if (ed.loaded || ed.placing) c = 'copy';
    else if (ed.tool === 'type') { const h2 = hitItem(p); c = h2?.it.type === 'text' ? 'text' : 'crosshair'; }
    else if (['frame', 'rect', 'ellipse', 'line'].includes(ed.tool)) c = 'crosshair';
    else {
      const hh = hitHandle(sx, sy);
      if (hh) c = hh.line ? 'move' : HANDLE_CURSORS[hh.k];
      else if (hitPort(sx, sy)) c = 'pointer';
      else if (ed.tool === 'direct' && hitItem(p)?.it.type === 'image') c = 'grab';
      else if (hitGuide(p)) c = hitGuide(p).g.o === 'h' ? 'row-resize' : 'col-resize';
    }
    if (c !== cursor) setCursor(c);
  };

  const onDoubleClick = (e) => {
    if (!ed.canEdit || ed.tool === 'type') return;
    const p = toDoc(e.clientX, e.clientY);
    const hit = hitItem(p);
    if (!hit) return;
    if (hit.it.type === 'text') { ed.setTool('type'); startText(hit, p, { detail: 1 }); drag.current = null; }
    else if (hit.it.type === 'image') { ed.setTool('direct'); ed.setSel([hit.it.id]); }
  };

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const r = cv.current.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(z * Math.exp(-e.deltaY * 0.0022), e.clientX - r.left, e.clientY - r.top);
    else setView((v) => ({ ...(v || view), x: (v || view).x - (e.shiftKey ? e.deltaY : e.deltaX), y: (v || view).y - (e.shiftKey ? 0 : e.deltaY) }));
  }, [zoomAt, z, setView, view]);
  useEffect(() => {
    const c = cv.current;
    if (!c) return undefined;
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const rulerDown = (o) => (e) => {
    if (!ed.canEdit) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind: 'newguide', o };
  };
  const rulerMove = (e) => { if (drag.current?.kind === 'newguide') onPointerMove(e); };
  const rulerUp = (e) => { if (drag.current?.kind === 'newguide') onPointerUp(e); };

  // ---------------------------------------------------------------- typing

  useEffect(() => { if (ed.edit) ta.current?.focus({ preventScroll: true }); }, [!!ed.edit]); // eslint-disable-line react-hooks/exhaustive-deps
  const composing = useRef(false);
  const onKeyDown = (e) => {
    const E = ed.edit;
    if (!E) return;
    const st = doc.stories[E.sid];
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (composing.current) return;
    if (k === 'Escape') { handled(); const loc = ed.locate(E.sid, E.f); ed.setEdit(null); ed.setTool('select'); if (loc) ed.setSel([loc.it.id]); return; }
    if (mod && !e.shiftKey && k.toLowerCase() === 'z') { handled(); ed.h.undo(); return; }
    if (mod && e.shiftKey && k.toLowerCase() === 'z') { handled(); ed.h.redo(); return; }
    if (mod && !e.shiftKey && !e.altKey && k.toLowerCase() === 'a') { handled(); ed.setEdit({ ...E, a: 0, f: st.text.length }); return; }
    if (!ed.canEdit && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k) && !mod) { handled(); return; }
    const sh = e.shiftKey;
    const collapsed = E.a === E.f;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      handled();
      const dir = k === 'ArrowLeft' ? -1 : 1;
      if (e.altKey && !mod) { ed.applyChar({ tracking: (ed.typeInfo?.char.tracking || 0) + dir * (sh ? 100 : 20) }, 'Tracking'); return; }
      let pos;
      if (!collapsed && !sh) pos = dir < 0 ? Math.min(E.a, E.f) : Math.max(E.a, E.f);
      else if (mod) { pos = E.f; if (dir < 0) { while (pos > 0 && /\s/.test(st.text[pos - 1])) pos--; pos = wordAt(st.text, pos)[0]; if (pos === E.f && pos > 0) pos--; } else { pos = wordAt(st.text, pos)[1]; while (pos < st.text.length && /\s/.test(st.text[pos])) pos++; if (pos === E.f && pos < st.text.length) pos++; } }
      else pos = E.f + dir;
      ed.moveCaret(pos, sh);
      return;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      handled();
      if (e.altKey && !mod) { const a = ed.typeInfo?.char; if (a) ed.applyChar({ leading: Math.max(1, (a.leading ?? a.size * 1.2) + (k === 'ArrowUp' ? -1 : 1) * (sh ? 10 : 2)) }, 'Leading'); return; }
      if (mod) { const pi = paraAt(st, E.f); const [ps, pe] = paraRange(st, pi); ed.moveCaret(k === 'ArrowUp' ? (E.f === ps && pi > 0 ? paraRange(st, pi - 1)[0] : ps) : (pe < st.text.length ? pe + 1 : pe), sh); return; }
      ed.lineMove(k === 'ArrowUp' ? -1 : 1, sh);
      return;
    }
    if (k === 'Home' || k === 'End') {
      handled();
      if (mod) { ed.moveCaret(k === 'Home' ? 0 : st.text.length, sh); return; }
      const loc = ed.locate(E.sid, E.f);
      if (loc) ed.moveCaret(k === 'Home' ? loc.line.start : (loc.line.last ? loc.line.end : Math.max(loc.line.start, loc.line.end - (st.text[loc.line.end - 1] === ' ' ? 1 : 0))), sh);
      return;
    }
    if (k === 'Backspace' || k === 'Delete') { handled(); ed.removeText(k === 'Backspace' ? -1 : 1, mod || e.altKey); return; }
    if (k === 'Enter') { handled(); ed.insert(sh ? LINE_BREAK : '\n'); return; }
    if (k === 'Tab') { handled(); ed.insert('\t'); return; }
    if (mod && sh && !e.altKey) {
      const key = k.toLowerCase();
      const c = ed.typeInfo?.char;
      const map = {
        b: () => ed.applyChar({ weight: (c?.weight || 400) >= 600 ? 400 : 700 }, 'Bold'),
        i: () => ed.applyChar({ italic: !c?.italic }, 'Italic'),
        u: () => ed.applyChar({ underline: !c?.underline }, 'Underline'),
        '/': () => ed.applyChar({ strike: !c?.strike }, 'Strikethrough'),
        k: () => ed.applyChar({ caps: !c?.caps }, 'All caps'),
        l: () => ed.applyPara({ align: 'left' }, 'Align left'), c: () => ed.applyPara({ align: 'center' }, 'Align centre'),
        r: () => ed.applyPara({ align: 'right' }, 'Align right'), j: () => ed.applyPara({ align: 'justify' }, 'Justify'), f: () => ed.applyPara({ align: 'justify-all' }, 'Justify all lines'),
        '>': () => ed.applyChar({ size: Math.min(1296, (c?.size || 11) + 2) }, 'Font size'), '.': () => ed.applyChar({ size: Math.min(1296, (c?.size || 11) + 2) }, 'Font size'),
        '<': () => ed.applyChar({ size: Math.max(1, (c?.size || 11) - 2) }, 'Font size'), ',': () => ed.applyChar({ size: Math.max(1, (c?.size || 11) - 2) }, 'Font size'),
      };
      if (map[key]) { handled(); map[key](); return; }
    }
    if (mod && sh && e.altKey && k.toLowerCase() === 'n') { handled(); ed.insert(PAGE_NUM); return; }
    if (mod && !sh && ['b', 'i', 'u'].includes(k.toLowerCase())) {
      handled();
      const c = ed.typeInfo?.char;
      if (k.toLowerCase() === 'b') ed.applyChar({ weight: (c?.weight || 400) >= 600 ? 400 : 700 }, 'Bold');
      if (k.toLowerCase() === 'i') ed.applyChar({ italic: !c?.italic }, 'Italic');
      if (k.toLowerCase() === 'u') ed.applyChar({ underline: !c?.underline }, 'Underline');
    }
  };
  const onInput = (e) => {
    if (composing.current) return;
    const v = e.target.value;
    e.target.value = '';
    if (v && ed.canEdit) ed.insert(v.replace(/\r?\n/g, '\n'));
  };

  const caretStyle = caret ? { left: caret.x * z + view.x, top: caret.y * z + view.y, height: Math.max(8, caret.h * z) } : null;
  const showCaret = caret && ed.range && ed.range[0] === ed.range[1];

  return (
    <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `${RULER}px 1fr`, gridTemplateRows: `${RULER}px 1fr` }}>
      {opts.rulers ? <>
        <div className="bg-panel border-r border-b border-line" />
        <canvas ref={rtop} style={{ width: '100%', height: RULER }} className="block cursor-row-resize" onPointerDown={rulerDown('h')} onPointerMove={rulerMove} onPointerUp={rulerUp} title="Drag down to make a guide" />
        <canvas ref={rleft} style={{ width: RULER, height: '100%' }} className="block cursor-col-resize" onPointerDown={rulerDown('v')} onPointerMove={rulerMove} onPointerUp={rulerUp} title="Drag across to make a guide" />
      </> : <><div /><div /><div /></>}
      <div ref={wrap} className="relative overflow-hidden" style={{ gridColumn: 2, gridRow: 2 }}>
        <canvas ref={cv} className="absolute inset-0 w-full h-full touch-none" style={{ cursor }} data-testid="layout-canvas"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={onDoubleClick} onContextMenu={(e) => e.preventDefault()} />
        {showCaret && <div key={blinkKey} className="absolute w-px bg-black pointer-events-none sl-caret" style={{ ...caretStyle, mixBlendMode: 'difference', background: '#fff', width: Math.max(1, z * 0.6) }} />}
        <textarea ref={ta} aria-label="Text" className="absolute opacity-0 w-4 h-4 p-0 border-0 resize-none pointer-events-none" style={caretStyle ? { left: caretStyle.left, top: caretStyle.top } : { left: -100, top: 0 }}
          onKeyDown={onKeyDown} onInput={onInput} onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={(e) => { composing.current = false; const v = e.data; e.target.value = ''; if (v) ed.insert(v); }}
          onCopy={(e) => { const t = ed.textCopy(false); if (t !== null) { e.clipboardData.setData('text/plain', t); e.preventDefault(); } }}
          onCut={(e) => { const t = ed.textCopy(true); if (t !== null) { e.clipboardData.setData('text/plain', t); e.preventDefault(); } }}
          onPaste={(e) => { e.preventDefault(); ed.textPaste(e.clipboardData.getData('text/plain')); }}
          onBlur={() => { /* keep the edit; clicking panels shouldn't end it */ }} />
        <style>{'@keyframes sl-blink{0%,49%{opacity:1}50%,100%{opacity:0}}.sl-caret{animation:sl-blink 1s step-end infinite}'}</style>
      </div>
    </div>
  );
}
