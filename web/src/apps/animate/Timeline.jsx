// Sora ANI's timeline: layers × frames grid (drawn on a canvas so long animations stay fast), keyframes, spans,
// motion/shape tweens, playhead, onion-skin markers. Click a cell to go there; drag a keyframe to move it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icons.jsx';
import { IconButton, openMenu, useSize, cx } from '../../components/ui.jsx';
import { timelineLength } from '../_anim/stage.js';

const LEFT = 230;
const ROW = 24;
const HEAD = 24;

export default function Timeline({ tl, frame, setFrame, active, setActive, editLayer, editTl, canEdit, playing, onion, setOnion, fps, frameMenu, layerMenu, addLayer, deleteLayer, crumbs, height, setHeight }) {
  const grid = useRef(null);
  const wrap = useRef(null);
  const size = useSize(wrap);
  const [cw, setCw] = useState(14);
  const [scroll, setScroll] = useState(0);
  const [renaming, setRenaming] = useState(null);
  const len = timelineLength(tl);
  const gridW = Math.max(100, size.width || 800);
  const visible = Math.ceil(gridW / cw) + 1;
  const total = Math.max(len + 40, visible);
  useEffect(() => { // keep the playhead in view
    if (frame < scroll) setScroll(frame);
    else if (frame >= scroll + visible - 2) setScroll(Math.max(0, frame - visible + 3));
  }, [frame]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowsH = tl.layers.length * ROW;
  useLayoutEffect(() => {
    const c = grid.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const Wd = gridW; const Hd = HEAD + Math.max(rowsH, (size.height || 200) - 30);
    c.width = Math.round(Wd * dpr); c.height = Math.round(Hd * dpr);
    c.style.width = `${Wd}px`; c.style.height = `${Hd}px`;
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    const panel = col('--color-panel', '#1c1c22'); const line = col('--color-line', '#2e2e36'); const fg2 = col('--color-fg2', '#a0a0aa');
    ctx.fillStyle = panel; ctx.fillRect(0, 0, Wd, Hd);
    const X = (f) => (f - scroll) * cw;
    // header
    ctx.font = '10px Inter, system-ui, sans-serif'; ctx.fillStyle = fg2; ctx.textBaseline = 'middle';
    for (let f = scroll; f < scroll + visible; f++) {
      const x = X(f);
      if ((f + 1) % 5 === 0 || f === 0) { ctx.fillText(String(f + 1), x + 2, HEAD / 2); ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fillRect(x, HEAD, cw, Hd); ctx.fillStyle = fg2; }
      ctx.fillStyle = line; ctx.fillRect(x, HEAD - 5, 1, 5); ctx.fillStyle = fg2;
    }
    if (onion.on) {
      ctx.fillStyle = 'rgba(59,123,255,.35)'; ctx.fillRect(X(Math.max(0, frame - onion.before)), 2, cw * (frame - Math.max(0, frame - onion.before)), 5);
      ctx.fillStyle = 'rgba(47,191,90,.35)'; ctx.fillRect(X(frame + 1), 2, cw * onion.after, 5);
    }
    // rows
    tl.layers.forEach((l, r) => {
      const y = HEAD + r * ROW;
      if (l.id === active) { ctx.fillStyle = 'rgba(90,160,255,.10)'; ctx.fillRect(0, y, Wd, ROW); }
      for (const k of l.frames) {
        const x0 = X(k.i); const x1 = X(k.i + k.len);
        if (x1 < 0 || x0 > Wd) continue;
        const has = k.els.length > 0;
        ctx.fillStyle = k.tween === 'motion' ? 'rgba(146,118,240,.55)' : k.tween === 'shape' ? 'rgba(70,170,95,.55)' : has ? 'rgba(220,220,230,.22)' : 'rgba(220,220,230,.08)';
        ctx.fillRect(x0, y + 2, x1 - x0, ROW - 4);
        ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y + 2.5, x1 - x0 - 1, ROW - 5);
        // keyframe dot
        ctx.beginPath(); ctx.arc(x0 + cw / 2, y + ROW - 8, 3.2, 0, Math.PI * 2);
        if (has) { ctx.fillStyle = '#f2f2f5'; ctx.fill(); } else { ctx.strokeStyle = '#f2f2f5'; ctx.lineWidth = 1.2; ctx.stroke(); }
        // span end marker
        if (k.len > 1 && !k.tween) { ctx.strokeStyle = '#f2f2f5'; ctx.lineWidth = 1; ctx.strokeRect(x1 - cw / 2 - 2.5 + 0.5, y + ROW - 11 + 0.5, 5, 6); }
        if (k.tween && k.len > 1) {
          const nk = l.frames.find((x) => x.i === k.i + k.len);
          ctx.strokeStyle = nk ? '#101014' : '#ff6b6b'; ctx.lineWidth = 1.2; ctx.setLineDash(nk ? [] : [3, 3]);
          ctx.beginPath(); ctx.moveTo(x0 + cw / 2 + 5, y + ROW / 2); ctx.lineTo(x1 - 4, y + ROW / 2); ctx.stroke(); ctx.setLineDash([]);
          if (nk) { ctx.beginPath(); ctx.moveTo(x1 - 4, y + ROW / 2); ctx.lineTo(x1 - 9, y + ROW / 2 - 3); ctx.lineTo(x1 - 9, y + ROW / 2 + 3); ctx.closePath(); ctx.fillStyle = '#101014'; ctx.fill(); }
        }
      }
      ctx.fillStyle = line; ctx.fillRect(0, y + ROW - 1, Wd, 1);
    });
    // playhead
    const px = X(frame);
    ctx.fillStyle = 'rgba(255,79,123,.18)'; ctx.fillRect(px, HEAD, cw, Hd);
    ctx.fillStyle = '#ff4f7b'; ctx.fillRect(px + cw / 2 - 0.5, 0, 1, Hd);
    ctx.fillRect(px, 3, cw, HEAD - 8);
    ctx.fillStyle = '#fff'; ctx.font = '600 9px Inter, system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(frame + 1), px + cw / 2, HEAD / 2 - 1); ctx.textAlign = 'left';
  }, [tl, frame, active, scroll, cw, gridW, size.height, rowsH, onion, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const cellAt = (e) => {
    const r = grid.current.getBoundingClientRect();
    const x = e.clientX - r.left; const y = e.clientY - r.top;
    return { f: Math.max(0, Math.floor(x / cw) + scroll), row: y < HEAD ? -1 : Math.floor((y - HEAD) / ROW) };
  };
  const onDown = (e) => {
    const { f, row } = cellAt(e);
    if (row < 0) { // scrub in the header
      setFrame(f);
      const mv = (ev) => setFrame(cellAt(ev).f);
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      return;
    }
    const layer = tl.layers[row];
    if (!layer) return;
    setActive(layer.id); setFrame(f);
    if (e.button === 2) { openMenu(e, frameMenu(layer, f)); return; }
    // drag a keyframe sideways to move it
    const key = layer.frames.find((k) => k.i === f);
    if (!key || !canEdit || layer.locked) return;
    const merge = `mk-${Date.now()}`; let cur = f;
    const prev = layer.frames.find((x) => x.i + x.len === f);
    const lo = prev ? prev.i + 1 : 0; const hi = key.i + key.len - 1;
    const mv = (ev) => {
      const t = Math.max(lo, Math.min(hi, cellAt(ev).f));
      if (t === cur) return;
      editLayer(layer.id, (l) => moveKeyFrom(l, cur, t), 'Move keyframe', merge);
      cur = t; setFrame(t);
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) { e.preventDefault(); setCw((c) => Math.max(6, Math.min(40, c + (e.deltaY < 0 ? 2 : -2)))); return; }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) setScroll((s) => Math.max(0, Math.min(total - 5, s + Math.sign(e.deltaX || e.deltaY) * 3)));
  };
  const startResize = (e) => {
    const y0 = e.clientY; const h0 = height;
    const mv = (ev) => setHeight(Math.max(120, Math.min(window.innerHeight - 220, h0 - (ev.clientY - y0))));
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  return (
    <div className="flex flex-col relative select-none" style={{ height }} data-testid="an-timeline">
      <div className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize z-20" onPointerDown={startResize} />
      <div className="flex-1 min-h-0 flex">
        <div style={{ width: LEFT }} className="shrink-0 border-r border-line flex flex-col">
          <div style={{ height: HEAD }} className="flex items-center gap-1 px-2 border-b border-line text-[11px] text-fg2">
            {crumbs}
            <div className="flex-1" />
            <Icon name="eye" size={12} className="text-fg3 mr-1" /><Icon name="lock" size={12} className="text-fg3 mr-1" /><span className="w-3 h-3 border border-fg3 rounded-sm" />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar">
            {tl.layers.map((l, i) => (
              <div key={l.id} style={{ height: ROW }} data-testid={`an-layer-${i + 1}`}
                className={cx('flex items-center gap-1 px-2 border-b border-line text-[12px] cursor-default', l.id === active ? 'bg-accent/15 text-fg' : 'text-fg2 hover:bg-hover')}
                onPointerDown={() => setActive(l.id)} onContextMenu={(e) => { e.preventDefault(); setActive(l.id); openMenu(e, layerMenu(l, i)); }}
                onDoubleClick={() => canEdit && setRenaming(l.id)}>
                <Icon name={l.guide ? 'guides' : 'layer'} size={13} className="text-fg3 shrink-0" />
                {renaming === l.id ? (
                  <input autoFocus defaultValue={l.name} className="flex-1 min-w-0 h-5 text-[12px] bg-input border border-accent rounded px-1 outline-none"
                    onBlur={(e) => { setRenaming(null); const v = e.target.value.trim(); if (v && v !== l.name) editLayer(l.id, (x) => ({ ...x, name: v }), 'Rename layer'); }}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); }} />
                ) : <span className="flex-1 truncate">{l.name}</span>}
                {l.id === active && canEdit && !l.locked && <Icon name="pencil" size={11} className="text-accent shrink-0" />}
                <button type="button" className={cx('w-4 grid place-items-center', l.visible ? 'text-fg2' : 'text-danger')} title="Show / hide" onClick={(e) => { e.stopPropagation(); if (canEdit) editLayer(l.id, (x) => ({ ...x, visible: !x.visible }), 'Visibility'); }}>
                  <Icon name={l.visible ? 'eye' : 'eyeOff'} size={12} />
                </button>
                <button type="button" className={cx('w-4 grid place-items-center', l.locked ? 'text-fg' : 'text-fg3/40')} title="Lock" onClick={(e) => { e.stopPropagation(); if (canEdit) editLayer(l.id, (x) => ({ ...x, locked: !x.locked }), 'Lock layer'); }}>
                  <Icon name="lock" size={12} />
                </button>
                <button type="button" className="w-3.5 h-3.5 rounded-sm border shrink-0" title="Outline mode" style={{ borderColor: l.color, background: l.outline ? 'transparent' : l.color }}
                  onClick={(e) => { e.stopPropagation(); if (canEdit) editLayer(l.id, (x) => ({ ...x, outline: !x.outline }), 'Outline mode'); }} />
              </div>
            ))}
          </div>
          <div className="h-7 border-t border-line flex items-center gap-0.5 px-1">
            <IconButton icon="plus" label="New layer" size={24} disabled={!canEdit} onClick={addLayer} />
            <IconButton icon="trash" label="Delete layer" size={24} disabled={!canEdit || tl.layers.length < 2} onClick={deleteLayer} />
            <div className="flex-1" />
            <IconButton icon="onion" label="Onion skin (Alt+Shift+O)" size={24} active={onion.on} onClick={() => setOnion({ ...onion, on: !onion.on })} data-testid="onion" />
            <span className="text-[10.5px] text-fg3" title="Frames before / after">
              <select className="bg-transparent text-fg2" value={onion.before} onChange={(e) => setOnion({ ...onion, before: Number(e.target.value) })} aria-label="Onion frames before">{[1, 2, 3, 4, 5, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select>
              /
              <select className="bg-transparent text-fg2" value={onion.after} onChange={(e) => setOnion({ ...onion, after: Number(e.target.value) })} aria-label="Onion frames after">{[0, 1, 2, 3, 4, 5, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </span>
          </div>
        </div>
        <div ref={wrap} className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden no-scrollbar" onWheel={onWheel}>
          <canvas ref={grid} onPointerDown={onDown} onContextMenu={(e) => e.preventDefault()} data-testid="an-grid" />
        </div>
      </div>
      <div className="h-6 shrink-0 border-t border-line flex items-center gap-3 px-2 text-[11px] text-fg2 whitespace-nowrap">
        <span className="tabular-nums" data-testid="an-frame">Frame {frame + 1} / {len}</span>
        <span className="tabular-nums">{(frame / fps).toFixed(2)} s</span>
        <span>{fps} fps</span>
        <div className="flex-1" />
        <input type="range" className="sl-range w-28" min={0} max={Math.max(0, total - visible)} value={Math.min(scroll, Math.max(0, total - visible))} onChange={(e) => setScroll(Number(e.target.value))} aria-label="Scroll timeline" />
        <Icon name="zoomOut" size={12} /><input type="range" className="sl-range w-20" min={6} max={40} value={cw} onChange={(e) => setCw(Number(e.target.value))} aria-label="Frame width" /><Icon name="zoomIn" size={12} />
      </div>
    </div>
  );
}

function moveKeyFrom(l, from, to) {
  const k = l.frames.find((x) => x.i === from);
  if (!k) return l;
  const prev = l.frames.find((x) => x.i + x.len === from);
  const end = k.i + k.len;
  const t = Math.max(prev ? prev.i + 1 : 0, Math.min(end - 1, to));
  if (t === from) return l;
  return { ...l, frames: l.frames.map((x) => (x === k ? { ...x, i: t, len: end - t } : x === prev ? { ...x, len: t - x.i } : x)) };
}
