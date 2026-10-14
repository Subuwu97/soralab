// The PDF viewer: pages rendered by pdf.js (only those near the screen), a selectable text layer, form fields,
// and an SVG overlay with comments, markup, signatures, redactions and search hits. Drawing tools create annotations here.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSize, toast } from '../../components/ui.jsx';
import { pdfjs, renderEntry, viewMatrix, apply, invert, displaySize, STAMPS } from './engine.js';
import { assetSrc } from '../../lib/doc.js';
import { ensureFont } from '../../lib/fonts.js';

const TEXT_TOOLS = ['select', 'highlight', 'underline', 'strike'];
const CREATE_TOOLS = ['note', 'freetext', 'rect', 'ellipse', 'line', 'arrow', 'ink', 'stamp', 'text', 'sign', 'initials', 'date', 'redact'];
const BOX_TYPES = ['freetext', 'rect', 'ellipse', 'stamp', 'image', 'redact'];

let mctx = null;
/** Box of a Fill & Sign text item (measured with the same font it's exported in). */
export function textBox(a) {
  mctx ||= document.createElement('canvas').getContext('2d');
  const size = a.size || 12;
  mctx.font = `${size}px Inter, sans-serif`;
  const lines = String(a.text || ' ').split('\n');
  const w = Math.max(size, ...lines.map((l) => mctx.measureText(l || ' ').width)) + 2;
  return { x: a.x, y: a.y, w, h: lines.length * size * 1.2 };
}

/** Bounding box of any annotation in base coordinates. */
export function annBox(a) {
  if (a.rects) {
    const xs = a.rects.flatMap((r) => [r[0], r[0] + r[2]]); const ys = a.rects.flatMap((r) => [r[1], r[1] + r[3]]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (a.type === 'note') return { x: a.x, y: a.y, w: 20, h: 20 };
  if (a.type === 'text') return textBox(a);
  if (a.type === 'line' || a.type === 'arrow') return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  if (a.type === 'ink') {
    const pts = a.paths.flat();
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

/** Moves an annotation by dx/dy (base units). */
export function moved(a, dx, dy) {
  if (a.rects) return { rects: a.rects.map(([x, y, w, h]) => [x + dx, y + dy, w, h]) };
  if (a.type === 'line' || a.type === 'arrow') return { x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
  if (a.type === 'ink') return { paths: a.paths.map((p) => p.map(([x, y]) => [x + dx, y + dy])) };
  return { x: a.x + dx, y: a.y + dy };
}

export default function Viewer({ ed, ref }) {
  const scroller = useRef(null);
  const size = useSize(scroller);
  const { list, infos, zoom } = ed;
  const [visible, setVisible] = useState(() => new Set([0, 1, 2]));
  const pageEls = useRef({});

  // Fit width / page
  useEffect(() => {
    if (!ed.fit || !size.width || !infos.length) return;
    const i = Math.min(ed.cur, infos.length - 1);
    if (ed.fit === 'width') {
      const maxW = Math.max(...list.map((e, k) => displaySize(infos[k].w, infos[k].h, e.rot || 0)[0]));
      ed.setZoom(Math.max(0.1, (size.width - 56) / maxW));
    } else {
      const [w, h] = displaySize(infos[i].w, infos[i].h, list[i].rot || 0);
      ed.setZoom(Math.max(0.1, Math.min((size.width - 56) / w, (size.height - 32) / h)));
    }
  }, [ed.fit, size.width, size.height, infos, list]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the reading position when zooming.
  const prevZoom = useRef(zoom);
  useLayoutEffect(() => {
    const s = scroller.current;
    if (s && prevZoom.current !== zoom) { s.scrollTop *= zoom / prevZoom.current; s.scrollLeft *= zoom / prevZoom.current; }
    prevZoom.current = zoom;
  }, [zoom]);

  // Which pages are near the screen (only those render).
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      setVisible((v) => {
        const n = new Set(v);
        for (const en of entries) { const k = Number(en.target.dataset.idx); if (en.isIntersecting) n.add(k); else n.delete(k); }
        return n;
      });
    }, { root: scroller.current, rootMargin: '600px 0px' });
    Object.values(pageEls.current).forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [list, ed.scrollMode]);

  const onScroll = () => {
    if (ed.scrollMode !== 'continuous') return;
    const s = scroller.current;
    const y = s.scrollTop + s.clientHeight * 0.35;
    let best = 0;
    for (const [k, el] of Object.entries(pageEls.current)) if (el && el.offsetTop <= y) best = Math.max(best, Number(k));
    if (best !== ed.cur) ed.setCur(best);
  };

  const scrollToPage = useCallback((i, yOff = 0) => {
    if (ed.scrollMode === 'single') { ed.setCur(i); requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = Math.max(0, yOff - 80); }); return; }
    const el = pageEls.current[i];
    if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - 16 + yOff;
  }, [ed]);
  useImperativeHandle(ref, () => ({
    scrollToPage,
    reveal: (i, rect) => {
      ed.setCur(i);
      const e = list[i]; const inf = infos[i];
      const m = viewMatrix(inf.w, inf.h, e.rot || 0, zoom);
      const [, y] = rect ? apply(m, rect[0], rect[1]) : [0, 0];
      setTimeout(() => scrollToPage(i, Math.max(0, y - (scroller.current?.clientHeight || 400) / 3)), 0);
    },
  }), [scrollToPage, list, infos, zoom, ed]);

  // Ctrl/⌘ + wheel zooms; the hand tool drags the view.
  useEffect(() => {
    const s = scroller.current;
    if (!s) return undefined;
    const wheel = (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); ed.zoomBy(Math.exp(-e.deltaY * 0.002)); } };
    s.addEventListener('wheel', wheel, { passive: false });
    return () => s.removeEventListener('wheel', wheel);
  }, [ed]);
  const pan = useRef(null);
  const onPointerDown = (e) => {
    if (ed.tool !== 'hand') return;
    pan.current = { x: e.clientX, y: e.clientY, l: scroller.current.scrollLeft, t: scroller.current.scrollTop };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => { if (pan.current) { scroller.current.scrollLeft = pan.current.l - (e.clientX - pan.current.x); scroller.current.scrollTop = pan.current.t - (e.clientY - pan.current.y); } };

  const shown = ed.scrollMode === 'single' ? [Math.min(ed.cur, list.length - 1)] : list.map((_, k) => k);
  return (
    <div ref={scroller} className="absolute inset-0 overflow-auto scroll-thin bg-work" onScroll={onScroll} data-testid="pdf-scroller"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { pan.current = null; }} style={{ cursor: ed.tool === 'hand' ? 'grab' : undefined }}>
      <style>{TEXT_LAYER_CSS}</style>
      <div className="flex flex-col items-center gap-4 py-4 min-w-fit px-6">
        {shown.map((k) => (
          <PageView key={list[k].id} ed={ed} idx={k} e={list[k]} info={infos[k]} zoom={zoom} visible={visible.has(k) || ed.scrollMode === 'single'}
            elRef={(el) => { pageEls.current[k] = el; }} />
        ))}
      </div>
      {ed.scrollMode === 'single' && list.length > 1 && (
        <div className="sticky bottom-3 flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex items-center gap-2 bg-menu/90 border border-line rounded-full px-3 h-8 text-xs shadow">
            <button type="button" onClick={() => ed.goTo(Math.max(0, ed.cur - 1))} disabled={ed.cur === 0} className="disabled:opacity-40">‹ Prev</button>
            <span className="text-fg2">{ed.cur + 1} / {list.length}</span>
            <button type="button" onClick={() => ed.goTo(Math.min(list.length - 1, ed.cur + 1))} disabled={ed.cur >= list.length - 1} className="disabled:opacity-40">Next ›</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one page

function PageView({ ed, idx, e, info, zoom, visible, elRef }) {
  const rot = e.rot || 0;
  const [w, h] = displaySize(info.w, info.h, rot);
  const W = Math.round(w * zoom); const H = Math.round(h * zoom);
  const canvas = useRef(null);
  const textDiv = useRef(null);
  const box = useRef(null);
  const [rendered, setRendered] = useState(null);
  const m = useMemo(() => viewMatrix(info.w, info.h, rot, zoom), [info.w, info.h, rot, zoom]);
  const inv = useMemo(() => invert(m), [m]);

  // the page image
  useEffect(() => {
    if (!visible) return undefined;
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        // form widgets are drawn as live fields on top, so leave them out of the image
        const tmp = await renderEntry(e, ed.docs, zoom * dpr, { signal: ac.signal, annotations: e.src === 'source' && ed.fields[e.i]?.length ? 'forms' : true });
        if (ac.signal.aborted || !canvas.current) return;
        const c = canvas.current;
        c.width = tmp.width; c.height = tmp.height;
        c.getContext('2d').drawImage(tmp, 0, 0);
        setRendered(`${zoom}|${rot}`);
      } catch (err) { if (err?.name !== 'RenderingCancelledException') console.warn(err); }
    }, rendered ? 120 : 0);
    return () => { clearTimeout(t); ac.abort(); };
  }, [visible, zoom, rot, e.src, e.i, ed.docs, ed.fields]); // eslint-disable-line react-hooks/exhaustive-deps

  // the selectable text layer
  useEffect(() => {
    const div = textDiv.current;
    if (!visible || !info.doc || !div) return undefined;
    let tl = null; let off = false;
    (async () => {
      const page = await info.doc.pdf.getPage(e.i + 1);
      if (off) return;
      const vp = page.getViewport({ scale: zoom, rotation: (page.rotate + rot) % 360 });
      div.replaceChildren();
      tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: div, viewport: vp });
      await tl.render().catch(() => {});
    })();
    return () => { off = true; tl?.cancel(); };
  }, [visible, zoom, rot, info.doc, e.i]);

  const toBase = useCallback((clientX, clientY) => {
    const r = box.current.getBoundingClientRect();
    return apply(inv, clientX - r.left, clientY - r.top);
  }, [inv]);

  // Highlight / underline / strike the selected text when the mouse is released.
  const onMouseUp = () => {
    if (!['highlight', 'underline', 'strike'].includes(ed.tool) || !ed.canEdit) return;
    setTimeout(() => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !textDiv.current?.contains(s.anchorNode)) return;
      const rects = [];
      for (let k = 0; k < s.rangeCount; k++) {
        for (const r of s.getRangeAt(k).getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          const [x1, y1] = toBase(r.left, r.top); const [x2, y2] = toBase(r.right, r.bottom);
          rects.push([Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)]);
        }
      }
      const merged = mergeRects(rects);
      if (!merged.length) return;
      const text = s.toString();
      s.removeAllRanges();
      ed.addAnn({ type: ed.tool, page: e.id, rects: merged, color: ed.toolOpts[ed.tool], quote: text.slice(0, 500) }, { highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough' }[ed.tool]);
    }, 0);
  };

  // ---------------------------------------------------------------- creating with tools
  const [draft, setDraft] = useState(null);
  const capture = ed.canEdit && CREATE_TOOLS.includes(ed.tool);
  const onCapDown = async (ev) => {
    const [x, y] = toBase(ev.clientX, ev.clientY);
    const t = ed.tool; const o = ed.toolOpts;
    if (t === 'note') { const a = ed.addAnn({ type: 'note', page: e.id, x: x - 10, y: y - 10, color: o.note, text: '' }, 'Sticky note'); ed.setEditing(a.id); ed.setTool('select'); return; }
    if (t === 'stamp') { const st = STAMPS[o.stamp]; ed.addAnn({ type: 'stamp', page: e.id, stamp: o.stamp, x: x - 80, y: y - 22, w: 160, h: 44, color: st.color }, 'Stamp'); return; }
    if (t === 'text' || t === 'date') {
      const text = t === 'date' ? new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
      await ensureFont('Inter', 400);
      const a = ed.addAnn({ type: 'text', page: e.id, x, y: y - (o.size || 12) * 0.6, text, size: o.size || 12, color: o.text }, t === 'date' ? 'Add date' : 'Add text');
      if (t === 'text') ed.setEditing(a.id);
      ed.setTool('select');
      return;
    }
    if (t === 'sign' || t === 'initials') {
      const kind = t === 'sign' ? 'signature' : 'initials';
      let s = o[kind];
      if (!s) s = await ed.newSignature(kind);
      if (!s) return;
      const wTarget = kind === 'signature' ? 160 : 60;
      const hh = wTarget * (s.h / s.w);
      ed.addAnn({ type: 'image', sig: kind, page: e.id, asset: s.asset, x: x - wTarget / 2, y: y - hh / 2, w: wTarget, h: hh }, kind === 'signature' ? 'Sign' : 'Initials');
      ed.setTool('select');
      return;
    }
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setDraft({ t, x0: x, y0: y, x1: x, y1: y, pts: [[x, y]] });
  };
  const onCapMove = (ev) => {
    if (!draft) return;
    const [x, y] = toBase(ev.clientX, ev.clientY);
    setDraft((d) => ({ ...d, x1: x, y1: y, pts: d.t === 'ink' ? [...d.pts, [x, y]] : d.pts }));
  };
  const onCapUp = () => {
    const d = draft; setDraft(null);
    if (!d) return;
    const o = ed.toolOpts;
    let r = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
    const tiny = r.w < 4 && r.h < 4;
    if (d.t === 'ink') { if (d.pts.length > 1) ed.addAnn({ type: 'ink', page: e.id, paths: [simplify(d.pts, 0.6 / zoom)], color: o.ink, width: o.width }, 'Draw'); return; }
    if (d.t === 'line' || d.t === 'arrow') { if (!tiny) ed.addAnn({ type: d.t, page: e.id, x1: d.x0, y1: d.y0, x2: d.x1, y2: d.y1, color: o[d.t], width: o.width }, d.t === 'arrow' ? 'Arrow' : 'Line'); return; }
    if (d.t === 'freetext') {
      if (tiny) r = { x: d.x0, y: d.y0, w: 180, h: 40 };
      const a = ed.addAnn({ type: 'freetext', page: e.id, ...r, text: '', size: o.size || 12, textColor: o.freetext, color: o.freetext, border: false }, 'Text box');
      ed.setEditing(a.id); ed.setTool('select');
      return;
    }
    if (tiny) return;
    if (d.t === 'redact') { ed.addAnn({ type: 'redact', page: e.id, ...r, applied: false }, 'Mark for redaction'); return; }
    ed.addAnn({ type: d.t, page: e.id, ...r, color: o[d.t], width: o.width, fill: null }, d.t === 'rect' ? 'Rectangle' : 'Oval');
  };

  // ---------------------------------------------------------------- moving / resizing annotations
  const dragAnn = (ev, a, mode) => {
    if (ed.tool !== 'select' || !ed.canEdit) { ed.setSel(a.id); return; }
    ev.stopPropagation(); ev.preventDefault();
    ed.setSel(a.id);
    const [sx, sy] = toBase(ev.clientX, ev.clientY);
    const key = `drag-${a.id}-${Date.now()}`;
    let movedAny = false;
    const move = (me) => {
      const [x, y] = toBase(me.clientX, me.clientY);
      const dx = x - sx; const dy = y - sy;
      if (!movedAny && Math.hypot(dx, dy) * zoom < 2) return;
      movedAny = true;
      if (mode === 'move') ed.updateAnn(a.id, moved(a, dx, dy), 'Move', key);
      else if (mode === 'p1') ed.updateAnn(a.id, { x1: a.x1 + dx, y1: a.y1 + dy }, 'Resize', key);
      else if (mode === 'p2') ed.updateAnn(a.id, { x2: a.x2 + dx, y2: a.y2 + dy }, 'Resize', key);
      else if (mode === 'size') {
        let nw = Math.max(8, a.w + dx); let nh = Math.max(8, a.h + dy);
        if (a.type === 'image' || a.type === 'stamp') nh = nw * (a.h / a.w);
        ed.updateAnn(a.id, { w: nw, h: nh }, 'Resize', key);
      } else if (mode === 'tsize') ed.updateAnn(a.id, { size: Math.max(5, Math.round((a.size || 12) * (1 + dy / Math.max(10, textBox(a).h)) * 2) / 2) }, 'Text size', key);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const anns = ed.data.annotations.filter((a) => a.page === e.id);
  const hits = ed.search.hits.filter((x) => x.page === idx);
  const curHit = ed.search.hits[ed.search.idx];
  const fields = e.src === 'source' ? ed.fields[e.i] || [] : [];
  const interactive = ed.tool === 'select';
  const hs = 7 / zoom; // handle size in base units

  return (
    <div ref={(el) => { box.current = el; elRef(el); }} data-idx={idx} data-page={idx + 1} className="relative bg-white shadow-[0_2px_14px_rgba(0,0,0,.45)] shrink-0" style={{ width: W, height: H }}
      onMouseUp={onMouseUp} onPointerDown={() => { if (ed.tool === 'select') { ed.setSel(null); } ed.setCur(idx); }}>
      <canvas ref={canvas} className="absolute inset-0" style={{ width: W, height: H }} />
      {!rendered && visible && info.doc && <div className="absolute inset-0 grid place-items-center text-[#999] text-xs">Loading…</div>}
      {info.doc && <div ref={textDiv} className="textLayer" style={{ '--total-scale-factor': zoom, '--scale-round-x': '1px', '--scale-round-y': '1px', pointerEvents: TEXT_TOOLS.includes(ed.tool) ? 'auto' : 'none' }} />}
      <svg width={W} height={H} className="absolute inset-0 overflow-visible" style={{ pointerEvents: 'none' }}>
        <g transform={`matrix(${m.join(' ')})`}>
          {hits.map((hit, k) => hit.rects.map((r, j) => <rect key={`${k}-${j}`} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={hit === curHit ? 'rgba(255,120,0,.55)' : 'rgba(255,200,0,.35)'} />))}
          {anns.map((a) => <AnnShape key={a.id} a={a} ed={ed} selected={ed.sel === a.id} editing={ed.editing === a.id} interactive={interactive} zoom={zoom}
            onDown={(ev, mode) => dragAnn(ev, a, mode)} hs={hs} />)}
          {draft && <Draft d={draft} ed={ed} zoom={zoom} />}
        </g>
      </svg>
      {fields.length > 0 && <FormLayer ed={ed} fields={fields} m={m} info={info} />}
      {capture && (
        <div className="absolute inset-0" style={{ cursor: ed.tool === 'ink' ? 'crosshair' : ['note', 'stamp', 'sign', 'initials', 'date', 'text'].includes(ed.tool) ? 'copy' : 'crosshair', touchAction: 'none' }}
          onPointerDown={(ev) => { ev.stopPropagation(); onCapDown(ev); }} onPointerMove={onCapMove} onPointerUp={onCapUp} />
      )}
      <span className="absolute -bottom-0.5 right-1 translate-y-full text-[10px] text-fg3 pt-0.5">{idx + 1}</span>
    </div>
  );
}

function Draft({ d, ed, zoom }) {
  const o = ed.toolOpts;
  const r = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), width: Math.abs(d.x1 - d.x0), height: Math.abs(d.y1 - d.y0) };
  const sw = o.width;
  if (d.t === 'ink') return <polyline points={d.pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={o.ink} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />;
  if (d.t === 'line' || d.t === 'arrow') return <line x1={d.x0} y1={d.y0} x2={d.x1} y2={d.y1} stroke={o[d.t]} strokeWidth={sw} />;
  if (d.t === 'ellipse') return <ellipse cx={r.x + r.width / 2} cy={r.y + r.height / 2} rx={r.width / 2} ry={r.height / 2} fill="none" stroke={o.ellipse} strokeWidth={sw} />;
  if (d.t === 'redact') return <rect {...r} fill="rgba(220,30,40,.15)" stroke="#dc1e28" strokeWidth={1 / zoom} />;
  return <rect {...r} fill="none" stroke={o[d.t] || '#1f6feb'} strokeWidth={d.t === 'rect' ? sw : 1 / zoom} strokeDasharray={d.t === 'freetext' ? `${4 / zoom}` : undefined} />;
}

// ---------------------------------------------------------------- drawing one annotation

function AnnShape({ a, ed, selected, editing, interactive, zoom, onDown, hs }) {
  const pe = interactive ? 'all' : 'none';
  const down = (mode) => (ev) => onDown(ev, mode);
  const dbl = (ev) => { ev.stopPropagation(); if (['freetext', 'text', 'note'].includes(a.type) && ed.canEdit) ed.setEditing(a.id); };
  const common = { style: { pointerEvents: pe, cursor: interactive ? 'move' : undefined }, onPointerDown: down('move'), onDoubleClick: dbl };
  const b = annBox(a);
  let shape = null;
  const color = a.color || '#ffd400';
  const op = a.opacity ?? 1;
  switch (a.type) {
    case 'highlight': shape = <g {...common} opacity={op}>{a.rects.map((r, k) => <rect key={k} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={color} fillOpacity={0.4} style={{ mixBlendMode: 'multiply' }} />)}</g>; break;
    case 'underline': shape = <g {...common} opacity={op}>{a.rects.map((r, k) => <g key={k}><rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill="transparent" /><line x1={r[0]} x2={r[0] + r[2]} y1={r[1] + r[3] * 0.92} y2={r[1] + r[3] * 0.92} stroke={color} strokeWidth={Math.max(0.6, r[3] / 14)} /></g>)}</g>; break;
    case 'strike': shape = <g {...common} opacity={op}>{a.rects.map((r, k) => <g key={k}><rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill="transparent" /><line x1={r[0]} x2={r[0] + r[2]} y1={r[1] + r[3] * 0.55} y2={r[1] + r[3] * 0.55} stroke={color} strokeWidth={Math.max(0.6, r[3] / 14)} /></g>)}</g>; break;
    case 'note': shape = (
      <g {...common} onClick={() => ed.setSel(a.id)}>
        <title>{`${a.author || ''}: ${a.text || '(empty note)'}`}</title>
        <rect x={a.x + 1} y={a.y + 1} width={18} height={15} rx={2} fill={color} stroke="#5a4a00" strokeWidth={0.8} />
        <path d={`M${a.x + 5} ${a.y + 16} L${a.x + 5} ${a.y + 20} L${a.x + 9} ${a.y + 16}`} fill={color} stroke="#5a4a00" strokeWidth={0.8} />
        <path d={`M${a.x + 4} ${a.y + 5.5} h12 M${a.x + 4} ${a.y + 8.5} h12 M${a.x + 4} ${a.y + 11.5} h8`} stroke="#5a4a00" strokeWidth={0.9} />
      </g>
    ); break;
    case 'freetext': shape = (
      <g {...common}>
        <rect x={a.x} y={a.y} width={a.w} height={a.h} fill={a.fill || 'transparent'} stroke={a.border ? color : selected || editing ? 'transparent' : 'rgba(31,111,235,.0)'} strokeWidth={1} />
        {!editing && <foreignObject x={a.x} y={a.y} width={a.w} height={a.h} style={{ pointerEvents: 'none' }}>
          <div style={{ fontFamily: 'Helvetica, Arial, sans-serif', fontSize: a.size || 12, lineHeight: 1.2, color: a.textColor || color, padding: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.text || <span style={{ opacity: 0.45 }}>Type here</span>}</div>
        </foreignObject>}
      </g>
    ); break;
    case 'text': shape = (
      <g {...common}>
        <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="transparent" />
        {!editing && String(a.text || '').split('\n').map((l, k) => <text key={k} x={a.x} y={a.y + (a.size || 12) * (0.85 + k * 1.2)} fontFamily="Inter, sans-serif" fontSize={a.size || 12} fill={a.color || '#000'} style={{ whiteSpace: 'pre' }}>{l}</text>)}
      </g>
    ); break;
    case 'rect': shape = <rect {...common} x={a.x} y={a.y} width={a.w} height={a.h} fill={a.fill || 'transparent'} stroke={color} strokeWidth={a.width || 2} opacity={op} />; break;
    case 'ellipse': shape = <ellipse {...common} cx={a.x + a.w / 2} cy={a.y + a.h / 2} rx={a.w / 2} ry={a.h / 2} fill={a.fill || 'transparent'} stroke={color} strokeWidth={a.width || 2} opacity={op} />; break;
    case 'line': case 'arrow': {
      const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1); const L = Math.max(8, (a.width || 2) * 4);
      shape = (
        <g {...common} opacity={op}>
          <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="transparent" strokeWidth={Math.max(8 / zoom, a.width || 2)} />
          <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={color} strokeWidth={a.width || 2} strokeLinecap="round" />
          {a.type === 'arrow' && <path d={`M${a.x2 - L * Math.cos(ang - 0.45)} ${a.y2 - L * Math.sin(ang - 0.45)} L${a.x2} ${a.y2} L${a.x2 - L * Math.cos(ang + 0.45)} ${a.y2 - L * Math.sin(ang + 0.45)} Z`} fill={color} />}
        </g>
      ); break;
    }
    case 'ink': shape = <g {...common} opacity={op}>{a.paths.map((p, k) => <g key={k}><polyline points={p.map((q) => q.join(',')).join(' ')} fill="none" stroke="transparent" strokeWidth={Math.max(8 / zoom, a.width || 2)} /><polyline points={p.map((q) => q.join(',')).join(' ')} fill="none" stroke={color} strokeWidth={a.width || 2} strokeLinecap="round" strokeLinejoin="round" /></g>)}</g>; break;
    case 'stamp': {
      const st = STAMPS[a.stamp] || { label: 'STAMP', color };
      const fs = Math.min(a.h * 0.5, a.w / Math.max(4, st.label.length) * 1.5);
      shape = (
        <g {...common}>
          <rect x={a.x + 2} y={a.y + 2} width={a.w - 4} height={a.h - 4} rx={4} fill="rgba(255,255,255,.01)" stroke={st.color} strokeWidth={2.5} />
          <text x={a.x + a.w / 2} y={a.y + a.h / 2 + fs * 0.35} textAnchor="middle" fontFamily="Helvetica, Arial, sans-serif" fontWeight="700" fontSize={fs} fill={st.color}>{st.label}</text>
        </g>
      ); break;
    }
    case 'image': shape = <image {...common} href={assetSrc(a.asset)} x={a.x} y={a.y} width={a.w} height={a.h} preserveAspectRatio="none" />; break;
    case 'redact': shape = a.applied
      ? <rect {...common} x={a.x} y={a.y} width={a.w} height={a.h} fill="#000" />
      : <g {...common}><rect x={a.x} y={a.y} width={a.w} height={a.h} fill="rgba(220,30,40,.18)" stroke="#dc1e28" strokeWidth={1.2 / zoom} strokeDasharray={`${4 / zoom}`} /><text x={a.x + 3 / zoom} y={a.y + 10 / zoom} fontSize={9 / zoom} fill="#dc1e28">Redact</text></g>;
      break;
    default: return null;
  }
  return (
    <g>
      {shape}
      {selected && !editing && (
        <g style={{ pointerEvents: 'none' }}>
          <rect x={b.x - 2 / zoom} y={b.y - 2 / zoom} width={b.w + 4 / zoom} height={b.h + 4 / zoom} fill="none" stroke="#1f6feb" strokeWidth={1 / zoom} strokeDasharray={`${3 / zoom}`} />
        </g>
      )}
      {selected && interactive && ed.canEdit && !editing && (BOX_TYPES.includes(a.type) || a.type === 'text') && (
        <rect x={b.x + b.w - hs / 2} y={b.y + b.h - hs / 2} width={hs} height={hs} fill="#fff" stroke="#1f6feb" strokeWidth={1 / zoom} style={{ pointerEvents: 'all', cursor: 'nwse-resize' }} onPointerDown={down(a.type === 'text' ? 'tsize' : 'size')} />
      )}
      {selected && interactive && ed.canEdit && (a.type === 'line' || a.type === 'arrow') && [['p1', a.x1, a.y1], ['p2', a.x2, a.y2]].map(([k, x, y]) => (
        <rect key={k} x={x - hs / 2} y={y - hs / 2} width={hs} height={hs} fill="#fff" stroke="#1f6feb" strokeWidth={1 / zoom} style={{ pointerEvents: 'all', cursor: 'move' }} onPointerDown={down(k)} />
      ))}
      {editing && (a.type === 'freetext' || a.type === 'text') && <InlineText a={a} ed={ed} />}
    </g>
  );
}

function InlineText({ a, ed }) {
  const b = a.type === 'text' ? { ...textBox(a), w: Math.max(textBox(a).w + 40, 160), h: textBox(a).h + 8 } : a;
  const ref = useRef(null);
  useEffect(() => { const t = ref.current; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }, []);
  return (
    <foreignObject x={b.x} y={b.y} width={b.w} height={Math.max(b.h, (a.size || 12) * 1.4)} style={{ pointerEvents: 'all' }}>
      <textarea ref={ref} value={a.text || ''} placeholder={a.type === 'text' ? 'Type text' : 'Type here'}
        onChange={(ev) => ed.updateAnn(a.id, { text: ev.target.value }, 'Edit text', `txt-${a.id}`)}
        onBlur={() => { ed.setEditing(null); if (!a.text && a.type === 'text') ed.deleteAnn(a.id); }}
        onKeyDown={(ev) => { if (ev.key === 'Escape') ev.currentTarget.blur(); ev.stopPropagation(); }}
        onPointerDown={(ev) => ev.stopPropagation()}
        style={{ width: '100%', height: '100%', resize: 'none', border: '1px dashed #1f6feb', outline: 'none', background: 'rgba(255,255,255,.6)', padding: a.type === 'text' ? 0 : 3, margin: 0, lineHeight: 1.2, overflow: 'hidden',
          fontFamily: a.type === 'text' ? 'Inter, sans-serif' : 'Helvetica, Arial, sans-serif', fontSize: a.size || 12, color: a.textColor || a.color || '#000' }} />
    </foreignObject>
  );
}

// ---------------------------------------------------------------- form fields

function defaultValue(f) {
  if (f.type === 'checkbox') return !!f.value && f.value !== 'Off';
  if (f.type === 'radio') return f.value && f.value !== 'Off' ? f.value : null;
  if (f.type === 'choice') return Array.isArray(f.value) ? f.value[0] || '' : f.value || '';
  return f.value || '';
}
function FormLayer({ ed, fields, m, info }) {
  const set = (name, v, label = 'Fill form') => ed.change((d) => ({ ...d, form: { ...d.form, [name]: v } }), label, `form-${name}`);
  const val = (f) => (f.name in ed.data.form ? ed.data.form[f.name] : defaultValue(f));
  const dis = !ed.canEdit || ed.tool === 'hand';
  return (
    <div className="absolute left-0 top-0" style={{ width: info.w, height: info.h, transform: `matrix(${m.join(',')})`, transformOrigin: '0 0', pointerEvents: 'none' }}>
      {fields.map((f) => {
        const [x, y, w, h] = f.rect;
        const st = { position: 'absolute', left: x, top: y, width: w, height: h, pointerEvents: dis ? 'none' : 'auto', fontSize: Math.max(7, Math.min(14, h * 0.62)) };
        const cls = 'bg-[rgba(204,215,255,.55)] hover:bg-[rgba(190,205,255,.8)] focus:bg-[rgba(255,255,255,.95)] text-black outline-none border border-[rgba(80,110,220,.6)] focus:border-[#1f6feb] px-[2px] rounded-[1px]';
        if (f.type === 'checkbox') return <input key={f.id} type="checkbox" data-field={f.name} title={f.name} checked={!!val(f)} disabled={f.readOnly} onChange={(ev) => set(f.name, ev.target.checked)} style={{ ...st, margin: 0, accentColor: '#1f6feb' }} />;
        if (f.type === 'radio') return <input key={f.id} type="radio" data-field={f.name} title={`${f.name}: ${f.radioValue}`} name={`r-${f.name}`} checked={val(f) === f.radioValue} disabled={f.readOnly} onChange={() => set(f.name, f.radioValue)} style={{ ...st, margin: 0, accentColor: '#1f6feb' }} />;
        if (f.type === 'choice') return (
          <select key={f.id} data-field={f.name} title={f.name} value={val(f)} disabled={f.readOnly} onChange={(ev) => set(f.name, ev.target.value)} className={cls} style={{ ...st, padding: 0 }}>
            <option value="">—</option>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        );
        return f.multiline
          ? <textarea key={f.id} data-field={f.name} title={f.name} value={val(f)} maxLength={f.maxLen} disabled={f.readOnly} onChange={(ev) => set(f.name, ev.target.value)} className={cls} style={{ ...st, resize: 'none' }} />
          : <input key={f.id} type="text" data-field={f.name} title={f.name} value={val(f)} maxLength={f.maxLen} disabled={f.readOnly} onChange={(ev) => set(f.name, ev.target.value)} className={cls} style={st} />;
      })}
    </div>
  );
}

// ---------------------------------------------------------------- helpers

/** Joins the many small rectangles a text selection produces into one per line. */
function mergeRects(rects) {
  const sorted = rects.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < Math.max(2, r[3] * 0.4) && r[0] <= last[0] + last[2] + r[3] * 0.8) {
      const x1 = Math.min(last[0], r[0]); const x2 = Math.max(last[0] + last[2], r[0] + r[2]);
      const y1 = Math.min(last[1], r[1]); const y2 = Math.max(last[1] + last[3], r[1] + r[3]);
      out[out.length - 1] = [x1, y1, x2 - x1, y2 - y1];
    } else out.push(r);
  }
  return out;
}

/** Drops points closer than eps to their neighbour (keeps freehand strokes light). */
function simplify(pts, eps) {
  const out = [pts[0]];
  for (const p of pts.slice(1)) { const q = out[out.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p); }
  if (out.length === 1) out.push(pts[pts.length - 1]);
  return out.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}

export { toast };

// pdf.js text layer styles (from pdf_viewer.css, trimmed): transparent text over the page image for selection.
const TEXT_LAYER_CSS = `
.textLayer{position:absolute;text-align:initial;inset:0;overflow:clip;opacity:1;line-height:1;-webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:CanvasText;z-index:0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
.textLayer :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;-webkit-user-select:text;user-select:text}
.textLayer > :not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
.textLayer .markedContent{display:contents}
.textLayer ::selection{background:rgba(31,111,235,.3);color:transparent}
.textLayer br::selection{background:transparent}
.textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;user-select:none}
.textLayer.selecting .endOfContent{top:0}
.textLayer[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}
.textLayer[data-main-rotation="180"]{transform:rotate(180deg) translate(-100%,-100%)}
.textLayer[data-main-rotation="270"]{transform:rotate(270deg) translateX(-100%)}
`;
