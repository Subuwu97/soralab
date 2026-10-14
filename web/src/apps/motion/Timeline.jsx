// The Timeline panel: layer rows with switches (visibility, solo, lock, blend mode, track matte, parent), twirl-down
// properties with stopwatches and keyframes (drag, box-select, ease), layer bars (slide, trim), work area and playhead.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icons.jsx';
import { NumberInput, ColorSwatch, openMenu, cx, useSize } from '../../components/ui.jsx';
import { isAnimated, keyedValue, valueAt, toggleStopwatch, setValueAt, keyIndexAt } from '../_anim/keyframes.js';
import { checkExpression, seedOf } from '../_anim/expr.js';
import { BLEND_MODES, worldMatrix as worldOf } from '../_anim/comp.js';
import { propGroups, getPath, updatePath, fmtTC, snapT, layerKeyTimes, LABELS } from './model.js';

const LEFT = 520;
const PAD = 10; // room left of time 0 so the first keyframe isn't clipped
const ROW = 22;
export const keyId = (lid, path, t) => `${lid}|${path}|${Math.round(t * 1e4)}`;
export const parseKeyId = (s) => { const [lid, path, t] = s.split('|'); return { lid, path, t: Number(t) / 1e4 }; };

const TYPE_ICON = { solid: 'square', shape: 'shapes', text: 'text', image: 'image', video: 'video', audio: 'audio', null: 'frame', adjustment: 'adjust', precomp: 'layers' };
const Stopwatch = ({ on }) => (
  <svg viewBox="0 0 16 16" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={1.4} className={on ? 'text-accent' : ''}>
    <circle cx="8" cy="9" r="5.5" fill={on ? 'currentColor' : 'none'} fillOpacity={on ? 0.25 : 0} /><path d="M8 9V6M6.5 2h3M12 4.5l1-1" />
  </svg>
);

/** Rows to show: layers, then (when twirled open or revealed with P/S/R/T/A/U) property groups and properties. */
function buildRows(comp, twirl, reveal) {
  const rows = [];
  comp.layers.forEach((layer, index) => {
    rows.push({ kind: 'layer', layer, index, key: layer.id });
    const rv = reveal[layer.id];
    const groups = propGroups(layer);
    if (rv?.length) {
      const props = groups.flatMap((g) => g.props).filter((p) => rv.includes(p.path));
      for (const p of props) { rows.push({ kind: 'prop', layer, prop: p, depth: 1, key: `${layer.id}:${p.path}` }); if (getPath(layer, p.path)?.x !== undefined) rows.push({ kind: 'expr', layer, prop: p, depth: 1, key: `${layer.id}:${p.path}:x` }); }
    } else if (twirl[layer.id]) {
      for (const g of groups) {
        const gk = `${layer.id}:${g.key}`;
        rows.push({ kind: 'group', layer, group: g, key: gk, open: !!twirl[gk] });
        if (twirl[gk]) for (const p of g.props) { rows.push({ kind: 'prop', layer, prop: p, depth: 2, key: `${layer.id}:${p.path}` }); if (getPath(layer, p.path)?.x !== undefined) rows.push({ kind: 'expr', layer, prop: p, depth: 2, key: `${layer.id}:${p.path}:x` }); }
      }
    }
  });
  return rows;
}

export default function Timeline({
  project, comp, time, seek, sel, setSel, selKeys, setSelKeys, twirl, setTwirl, reveal, editComp, editLayer, canEdit, selProp, setSelProp,
  height, setHeight, endMerge, playing,
}) {
  const area = useRef(null);
  const scroller = useRef(null);
  const size = useSize(area);
  const trackW = Math.max(100, (size.width || 900) - LEFT - 12 - PAD * 2);
  const [zoom, setZoom] = useState(1); // 1 = whole comp fits
  const [start, setStart] = useState(0);
  const pps = (trackW / comp.duration) * zoom;
  const visDur = trackW / pps;
  useEffect(() => { setStart((s) => Math.max(0, Math.min(s, comp.duration - visDur))); }, [zoom, comp.duration, visDur]);
  // keep the playhead in view while playing
  useEffect(() => { if (playing && (time > start + visDur || time < start)) setStart(Math.max(0, Math.min(time, comp.duration - visDur))); }, [time, playing]); // eslint-disable-line react-hooks/exhaustive-deps
  const tx = (t) => (t - start) * pps + PAD;
  const xt = (x) => (x - PAD) / pps + start;
  const rows = useMemo(() => buildRows(comp, twirl, reveal), [comp, twirl, reveal]);
  const [box, setBox] = useState(null);

  const scrub = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const go = (ev) => seek(Math.max(0, Math.min(comp.duration - 1 / comp.fps, snapT(xt(ev.clientX - r.left), comp.fps))));
    go(e);
    const mv = (ev) => go(ev);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const onWheel = (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) {
      e.preventDefault();
      const r = area.current.getBoundingClientRect();
      const mt = xt(e.clientX - r.left - LEFT);
      const z = Math.max(1, Math.min(200, zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
      const npps = (trackW / comp.duration) * z;
      setZoom(z); setStart(Math.max(0, mt - (e.clientX - r.left - LEFT) / npps));
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      setStart((s) => Math.max(0, Math.min(comp.duration - visDur, s + (e.deltaX || e.deltaY) / pps)));
    }
  };
  useEffect(() => {
    const el = area.current;
    const f = (e) => { if (e.ctrlKey || e.altKey || e.metaKey) e.preventDefault(); };
    el?.addEventListener('wheel', f, { passive: false });
    return () => el?.removeEventListener('wheel', f);
  }, []);

  // ---------------------------------------------------------------- keyframe drag / box select
  const startKeyDrag = (e, id) => {
    e.stopPropagation();
    if (!canEdit) return;
    let current = selKeys;
    if (e.shiftKey) { current = selKeys.includes(id) ? selKeys.filter((k) => k !== id) : [...selKeys, id]; setSelKeys(current); return; }
    if (!selKeys.includes(id)) { current = [id]; setSelKeys(current); }
    const x0 = e.clientX; let last = 0;
    const merge = `keys-${Date.now()}`;
    const keys = current.map(parseKeyId);
    const mv = (ev) => {
      const dt = snapT((ev.clientX - x0) / pps, comp.fps);
      if (dt === last) return;
      last = dt;
      editComp((c) => {
        const layers = c.layers.map((l) => {
          const mine = keys.filter((k) => k.lid === l.id);
          if (!mine.length) return l;
          let out = l;
          for (const path of [...new Set(mine.map((k) => k.path))]) {
            const ts = mine.filter((k) => k.path === path).map((k) => k.t);
            out = updatePath(out, path, (p) => {
              const orig = getPath(l, path);
              const moved = orig.k.map((k) => (ts.some((t) => Math.abs(t - k.t) < 1e-4) ? { ...k, t: Math.max(0, +(k.t + dt).toFixed(5)) } : k));
              // a moved key replaces an unmoved key at the same time
              const kept = moved.filter((k, i) => moved.findIndex((o) => Math.abs(o.t - k.t) < 1e-4) === i || ts.some((t) => Math.abs(t + dt - k.t) < 1e-4));
              return { ...p, k: kept.sort((a, b) => a.t - b.t) };
            });
          }
          return out;
        });
        return { ...c, layers };
      }, 'Move keyframes', merge);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (last) setSelKeys(keys.map((k) => keyId(k.lid, k.path, Math.max(0, k.t + last))));
      endMerge();
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const startBox = (e) => {
    if (e.button !== 0) return;
    const r = scroller.current.getBoundingClientRect();
    const y0 = e.clientY - r.top + scroller.current.scrollTop; const x0 = e.clientX - r.left - LEFT;
    const add = e.shiftKey;
    setBox({ x0, y0, x1: x0, y1: y0 });
    const mv = (ev) => setBox({ x0, y0, x1: ev.clientX - r.left - LEFT, y1: ev.clientY - r.top + scroller.current.scrollTop });
    const up = (ev) => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      setBox(null);
      const x1 = ev.clientX - r.left - LEFT; const y1 = ev.clientY - r.top + scroller.current.scrollTop;
      if (Math.abs(x1 - x0) < 3 && Math.abs(y1 - y0) < 3) { if (!add) setSelKeys([]); seek(Math.max(0, Math.min(comp.duration - 1 / comp.fps, snapT(xt(x0), comp.fps)))); return; }
      const ta = xt(Math.min(x0, x1)); const tb = xt(Math.max(x0, x1));
      const ra = Math.floor(Math.min(y0, y1) / ROW); const rb = Math.floor(Math.max(y0, y1) / ROW);
      const ids = [];
      rows.forEach((row, i) => {
        if (i < ra || i > rb || row.kind !== 'prop') return;
        for (const k of getPath(row.layer, row.prop.path)?.k || []) if (k.t >= ta && k.t <= tb) ids.push(keyId(row.layer.id, row.prop.path, k.t));
      });
      setSelKeys(add ? [...new Set([...selKeys, ...ids])] : ids);
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  // ---------------------------------------------------------------- layer bar drag (slide / trim)
  const startBarDrag = (e, layer, mode) => {
    e.stopPropagation();
    if (!sel.includes(layer.id)) setSel(e.shiftKey ? [...sel, layer.id] : [layer.id]);
    if (!canEdit || layer.locked) return;
    const x0 = e.clientX; const merge = `bar-${Date.now()}`; let last = 0;
    const mv = (ev) => {
      let dt = snapT((ev.clientX - x0) / pps, comp.fps);
      if (dt === last) return; last = dt;
      editLayer(layer.id, () => {
        const l = layer;
        if (mode === 'slide') {
          dt = Math.max(dt, -l.out + 1 / comp.fps);
          const shiftKeys = (o) => {
            // every animated property inside the layer moves with it
            const walk = (v) => {
              if (Array.isArray(v)) return v.map(walk);
              if (v && typeof v === 'object') {
                if (Array.isArray(v.k) && 'v' in v) return { ...v, k: v.k.map((k) => ({ ...k, t: +(k.t + dt).toFixed(5) })) };
                return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
              }
              return v;
            };
            return walk(o);
          };
          const moved = shiftKeys({ tr: l.tr, shape: l.shape, text: l.text, masks: l.masks, effects: l.effects, color: l.color, volume: l.volume });
          return { ...l, ...Object.fromEntries(Object.entries(moved).filter(([, v]) => v !== undefined)), in: +(l.in + dt).toFixed(5), out: +(l.out + dt).toFixed(5), start: +(l.start + dt).toFixed(5) };
        }
        const media = l.type === 'video' || l.type === 'audio';
        const dur = media && l.mediaDuration ? l.mediaDuration : Infinity;
        if (mode === 'in') return { ...l, in: Math.min(l.out - 1 / comp.fps, Math.max(media ? l.start : -Infinity, l.in + dt)) };
        return { ...l, out: Math.max(l.in + 1 / comp.fps, Math.min(media ? l.start + dur : Infinity, l.out + dt)) };
      }, mode === 'slide' ? 'Slide layer' : 'Trim layer', merge);
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); endMerge(); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  const startWorkDrag = (e, mode) => {
    e.stopPropagation();
    if (!canEdit) return;
    const x0 = e.clientX; const w0 = comp.work || [0, comp.duration]; const merge = `work-${Date.now()}`;
    const mv = (ev) => {
      const dt = snapT((ev.clientX - x0) / pps, comp.fps);
      let w;
      if (mode === 'a') w = [Math.max(0, Math.min(w0[1] - 1 / comp.fps, w0[0] + dt)), w0[1]];
      else if (mode === 'b') w = [w0[0], Math.min(comp.duration, Math.max(w0[0] + 1 / comp.fps, w0[1] + dt))];
      else { const d = Math.max(-w0[0], Math.min(comp.duration - w0[1], dt)); w = [w0[0] + d, w0[1] + d]; }
      editComp((c) => ({ ...c, work: w }), 'Work area', merge);
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); endMerge(); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  const startResize = (e) => {
    const y0 = e.clientY; const h0 = height;
    const mv = (ev) => setHeight(Math.max(140, Math.min(window.innerHeight - 220, h0 - (ev.clientY - y0))));
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  // ruler ticks
  const ticks = useMemo(() => {
    const fpsStep = 1 / comp.fps;
    const steps = [fpsStep, fpsStep * 2, fpsStep * 5, 0.5, 1, 2, 5, 10, 30, 60];
    const step = steps.find((s) => s * pps >= 60) || 60;
    const out = [];
    for (let t = Math.floor(start / step) * step; t <= start + visDur + step; t += step) if (t >= -1e-9 && t <= comp.duration + 1e-9) out.push(+t.toFixed(6));
    return { step, out };
  }, [comp.fps, comp.duration, pps, start, visDur]);

  const work = comp.work || [0, comp.duration];

  return (
    <div ref={area} className="flex flex-col select-none relative" style={{ height }} onWheel={onWheel} data-testid="timeline">
      <div className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize z-20" onPointerDown={startResize} />
      {/* header: timecode + ruler */}
      <div className="flex h-9 shrink-0 border-b border-line">
        <div style={{ width: LEFT }} className="shrink-0 flex items-center gap-0.5 pl-2 pr-1 border-r border-line">
          <span className="font-mono text-[15px] text-accent tabular-nums" data-testid="timecode">{fmtTC(time, comp.fps)}</span>
          <span className="text-[11px] text-fg3 tabular-nums ml-2">{Math.round(time * comp.fps)} / {Math.round(comp.duration * comp.fps)} · {comp.fps} fps</span>
          <div className="flex-1" />
          <span className="text-[10.5px] text-fg3 w-[86px]">Mode</span>
          <span className="text-[10.5px] text-fg3 w-[86px]">Track matte</span>
          <span className="text-[10.5px] text-fg3 w-[86px]">Parent</span>
        </div>
        <div className="flex-1 relative overflow-hidden cursor-pointer" onPointerDown={scrub}>
          {/* work area bar */}
          <div className="absolute top-0 h-2.5 bg-accent/35 rounded-sm" style={{ left: tx(work[0]), width: Math.max(2, tx(work[1]) - tx(work[0])) }} onPointerDown={(e) => startWorkDrag(e, 'move')} title="Work area — drag to move; drag its ends to set in/out (B / N)">
            <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-accent/80 rounded-l-sm" onPointerDown={(e) => startWorkDrag(e, 'a')} />
            <div className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-accent/80 rounded-r-sm" onPointerDown={(e) => startWorkDrag(e, 'b')} />
          </div>
          {ticks.out.map((t) => (
            <div key={t} className="absolute bottom-0 border-l border-fg3/40 text-[10px] text-fg3 pl-1 h-5 leading-[12px]" style={{ left: tx(t) }}>
              {ticks.step < 1 && Math.abs(t - Math.round(t)) > 1e-6 ? `${Math.round((t % 1) * comp.fps)}f` : fmtTC(t, comp.fps).replace(/:00$/, '')}
            </div>
          ))}
          <div className="absolute top-0 bottom-0 w-px bg-[#ff4f7b]" style={{ left: tx(time) }}>
            <div className="absolute -left-[5px] top-2 w-[11px] h-3 bg-[#ff4f7b] rounded-b" />
          </div>
        </div>
      </div>
      {/* rows */}
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scroll-thin relative">
        <div className="relative" style={{ height: Math.max(rows.length * ROW, 40) }}>
          {rows.map((row) => (
            <Row key={row.key} row={row} comp={comp} project={project} time={time} tx={tx} sel={sel} setSel={setSel} selKeys={selKeys} canEdit={canEdit}
              twirl={twirl} setTwirl={setTwirl} editLayer={editLayer} startKeyDrag={startKeyDrag} startBarDrag={startBarDrag} startBox={startBox} seek={seek}
              selProp={selProp} setSelProp={setSelProp} endMerge={endMerge} setSelKeys={setSelKeys} />
          ))}
          {!rows.length && <div className="absolute inset-0 grid place-items-center text-[12px] text-fg3">No layers yet — draw a shape, add text (Ctrl+T), or use Layer → New.</div>}
          {box && <div className="absolute border border-accent bg-accent/10 pointer-events-none" style={{ left: LEFT + Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
          <div className="absolute top-0 bottom-0 w-px bg-[#ff4f7b] pointer-events-none" style={{ left: LEFT + tx(time), display: tx(time) < 0 || tx(time) > trackW + 10 ? 'none' : undefined }} />
          {/* outside the work area */}
          <div className="absolute top-0 bottom-0 bg-black/25 pointer-events-none" style={{ left: LEFT, width: Math.max(0, tx(work[0])) }} />
          <div className="absolute top-0 bottom-0 right-0 bg-black/25 pointer-events-none" style={{ left: LEFT + Math.max(0, tx(work[1])) }} />
        </div>
      </div>
      <div className="h-6 shrink-0 border-t border-line flex items-center gap-2 px-2 text-[11px] text-fg3">
        <span className="whitespace-nowrap">{comp.layers.length} layer{comp.layers.length === 1 ? '' : 's'}{selKeys.length ? ` · ${selKeys.length} keyframe${selKeys.length === 1 ? '' : 's'} selected` : ''}</span>
        <div className="flex-1" />
        <Icon name="zoomOut" size={13} />
        <input type="range" className="sl-range w-40" min={0} max={Math.log(200)} step={0.01} value={Math.log(zoom)} onChange={(e) => setZoom(Math.exp(Number(e.target.value)))} aria-label="Timeline zoom" />
        <Icon name="zoomIn" size={13} />
      </div>
    </div>
  );
}

const Row = memo(function Row({ row, comp, project, time, tx, sel, setSel, selKeys, canEdit, twirl, setTwirl, editLayer, startKeyDrag, startBarDrag, startBox, seek, selProp, setSelProp, endMerge, setSelKeys }) {
  const { layer } = row;
  const selected = sel.includes(layer.id);
  if (row.kind === 'layer') return <LayerRow {...{ row, comp, project, time, tx, selected, sel, setSel, canEdit, twirl, setTwirl, editLayer, startBarDrag, startBox }} />;
  if (row.kind === 'group') {
    return (
      <div className="flex border-b border-line/40" style={{ height: ROW }}>
        <div style={{ width: LEFT, paddingLeft: 52 }} className="shrink-0 flex items-center gap-1 text-[12px] text-fg2 border-r border-line bg-panel">
          <button type="button" className="flex items-center gap-1 hover:text-fg" onClick={() => setTwirl((t) => ({ ...t, [row.key]: !t[row.key] }))}>
            <Icon name={row.open ? 'chevronDown' : 'chevronRight'} size={12} />{row.group.group}
          </button>
        </div>
        <div className="flex-1 relative" onPointerDown={startBox} />
      </div>
    );
  }
  const p = getPath(layer, row.prop.path);
  if (!p) return null;
  if (row.kind === 'expr') return <ExprRow layer={layer} prop={row.prop} p={p} depth={row.depth} editLayer={editLayer} canEdit={canEdit} startBox={startBox} />;
  return <PropRow {...{ row, layer, p, comp, time, tx, selKeys, canEdit, editLayer, startKeyDrag, startBox, seek, selProp, setSelProp, endMerge, setSelKeys }} />;
});

function LayerRow({ row, comp, project, time, tx, selected, sel, setSel, canEdit, twirl, setTwirl, editLayer, startBarDrag, startBox }) {
  const { layer, index } = row;
  const [renaming, setRenaming] = useState(false);
  const open = twirl[layer.id];
  const keys = useMemo(() => layerKeyTimes(layer), [layer]);
  const others = comp.layers.filter((l) => l.id !== layer.id);
  const sw = (on, icon, title, f, testid) => (
    <button type="button" title={title} data-testid={testid} onClick={(e) => { e.stopPropagation(); if (canEdit) f(); }} className={cx('w-[18px] h-[18px] grid place-items-center rounded hover:bg-hover', on ? 'text-fg' : 'text-fg3/50')}>
      <Icon name={icon} size={12} />
    </button>
  );
  const set = (patch, label) => editLayer(layer.id, (l) => ({ ...l, ...patch }), label);
  const select = (e) => {
    if (e.shiftKey) setSel(selected ? sel.filter((x) => x !== layer.id) : [...sel, layer.id]);
    else if (e.ctrlKey || e.metaKey) setSel(selected ? sel.filter((x) => x !== layer.id) : [...sel, layer.id]);
    else setSel([layer.id]);
  };
  const small = 'h-[18px] w-[86px] text-[11px] rounded bg-input border border-line text-fg px-1 outline-none';
  return (
    <div className={cx('flex border-b border-line/60', selected ? 'bg-accent/15' : '')} style={{ height: ROW }} data-testid={`layer-row-${index + 1}`}>
      <div style={{ width: LEFT }} className={cx('shrink-0 flex items-center gap-0.5 pr-1 border-r border-line', selected ? 'bg-accent/15' : 'bg-panel')} onPointerDown={select}
        onContextMenu={(e) => { e.preventDefault(); select(e); }}>
        {layer.type === 'audio' ? sw(layer.audioOn !== false, 'volume', 'Audio', () => set({ audioOn: layer.audioOn === false }, 'Toggle audio'))
          : sw(layer.enabled !== false, 'eye', 'Video (show/hide)', () => set({ enabled: layer.enabled === false }, 'Toggle visibility'), `eye-${index + 1}`)}
        {sw(layer.solo, 'dot', 'Solo', () => set({ solo: !layer.solo }, 'Solo'))}
        {sw(layer.locked, 'lock', 'Lock', () => set({ locked: !layer.locked }, 'Lock'))}
        <button type="button" className="w-3 h-3 rounded-sm mx-1 shrink-0" style={{ background: layer.label }} title="Label colour"
          onClick={(e) => { e.stopPropagation(); if (canEdit) openMenu(e, LABELS.map((c) => ({ label: c, icon: 'square', onClick: () => set({ label: c }, 'Label') }))); }} />
        <span className="w-5 text-[11px] text-fg3 tabular-nums text-right shrink-0">{index + 1}</span>
        <button type="button" className="w-4 grid place-items-center text-fg2 hover:text-fg shrink-0" onClick={(e) => { e.stopPropagation(); setTwirl((t) => ({ ...t, [layer.id]: !t[layer.id] })); }} aria-label="Twirl" data-testid={`twirl-${index + 1}`}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        <Icon name={TYPE_ICON[layer.type] || 'layer'} size={12} className="text-fg3 shrink-0" />
        {renaming ? (
          <input autoFocus defaultValue={layer.name} className="flex-1 min-w-0 h-[18px] text-[12px] bg-input border border-accent rounded px-1 outline-none"
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => { setRenaming(false); if (e.target.value.trim() && e.target.value !== layer.name) set({ name: e.target.value.trim() }, 'Rename layer'); }}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(false); }} />
        ) : (
          <span className={cx('flex-1 min-w-0 truncate text-[12px] pl-1', layer.enabled === false && 'text-fg3', layer.matte && 'italic')} onDoubleClick={() => canEdit && setRenaming(true)}>
            {layer.motionBlur && <span title="Motion blur" className="text-accent mr-1">◐</span>}{layer.name}
          </span>
        )}
        {layer.type !== 'audio' && layer.type !== 'null' ? (
          <>
            <select className={small} value={layer.blend || 'normal'} disabled={!canEdit} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => set({ blend: e.target.value }, 'Blend mode')} title="Blend mode">
              {BLEND_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select className={small} value={layer.matte ? `${layer.matte.layer}|${layer.matte.mode}` : ''} disabled={!canEdit} onPointerDown={(e) => e.stopPropagation()} title="Track matte" data-testid={`matte-${index + 1}`}
              onChange={(e) => { const [lid, mode] = e.target.value.split('|'); set({ matte: lid ? { layer: lid, mode } : null }, 'Track matte'); }}>
              <option value="">No matte</option>
              {others.filter((o) => o.type !== 'audio').map((o) => (
                <optgroup key={o.id} label={`${comp.layers.indexOf(o) + 1}. ${o.name}`}>
                  {[['alpha', 'Alpha'], ['alphaInv', 'Alpha inverted'], ['luma', 'Luma'], ['lumaInv', 'Luma inverted']].map(([m, ml]) => <option key={m} value={`${o.id}|${m}`}>{`${comp.layers.indexOf(o) + 1} · ${ml}`}</option>)}
                </optgroup>
              ))}
            </select>
          </>
        ) : <span className="w-[176px]" />}
        <select className={small} value={layer.parent || ''} disabled={!canEdit} onPointerDown={(e) => e.stopPropagation()} title="Parent (pick whip)"
          onChange={(e) => editLayer(layer.id, (l) => reparent(l, e.target.value || null, comp, time), 'Parent')}>
          <option value="">None</option>
          {others.filter((o) => !isDescendant(comp, o, layer.id)).map((o) => <option key={o.id} value={o.id}>{`${comp.layers.indexOf(o) + 1}. ${o.name}`}</option>)}
        </select>
      </div>
      <div className="flex-1 relative overflow-hidden" onPointerDown={startBox}>
        <div className={cx('absolute top-[3px] bottom-[3px] rounded-[3px] cursor-move', selected ? 'ring-1 ring-white/70' : '')}
          style={{ left: tx(layer.in), width: Math.max(3, tx(layer.out) - tx(layer.in)), background: `${layer.label || '#5eb0e0'}${selected ? 'aa' : '66'}` }}
          onPointerDown={(e) => startBarDrag(e, layer, 'slide')} data-testid={`bar-${index + 1}`}>
          <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => startBarDrag(e, layer, 'in')} />
          <div className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize" onPointerDown={(e) => startBarDrag(e, layer, 'out')} />
          {!open && keys.map((t) => <span key={t} className="absolute top-1/2 w-[5px] h-[5px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-white/70 pointer-events-none" style={{ left: tx(t) - tx(layer.in) }} />)}
        </div>
      </div>
    </div>
  );
}

const isDescendant = (comp, layer, ancestorId, depth = 0) => {
  if (layer.id === ancestorId) return true;
  if (!layer.parent || depth > 32) return false;
  const p = comp.layers.find((l) => l.id === layer.parent);
  return p ? isDescendant(comp, p, ancestorId, depth + 1) : false;
};

/** Parenting without a jump: keeps the layer where it is by converting its position into the new parent's space (at t). */
function reparent(l, parentId, comp, t) {
  // Only static transforms are compensated (like After Effects, keyframes stay as they are).
  const world = (id) => { const p = comp.layers.find((x) => x.id === id); return p ? worldOf(p, comp, t) : [1, 0, 0, 1, 0, 0]; };
  if (isAnimated(l.tr.position)) return { ...l, parent: parentId };
  const oldW = world(l.parent); const newW = world(parentId);
  const pos = keyedValue(l.tr.position, t);
  const g = [oldW[0] * pos[0] + oldW[2] * pos[1] + oldW[4], oldW[1] * pos[0] + oldW[3] * pos[1] + oldW[5]];
  const det = newW[0] * newW[3] - newW[1] * newW[2] || 1e-9;
  const x = g[0] - newW[4]; const y = g[1] - newW[5];
  const np = [(newW[3] * x - newW[2] * y) / det, (-newW[1] * x + newW[0] * y) / det];
  return { ...l, parent: parentId, tr: { ...l.tr, position: { ...l.tr.position, v: np } } };
}

function Diamond({ k, selected, onPointerDown, left, prev }) {
  const ease = k.in === 'ease' || k.out === 'ease' || k.bz;
  const hold = k.out === 'hold';
  return (
    <span onPointerDown={onPointerDown} title={`${k.t.toFixed(2)} s`} data-testid="key"
      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[11px] h-[11px] grid place-items-center cursor-pointer z-[1]" style={{ left }}>
      {hold ? <span className={cx('w-[8px] h-[8px]', selected ? 'bg-accent' : 'bg-fg2')} />
        : ease ? <span className={cx('w-[9px] h-[9px] rounded-full border-2', selected ? 'border-accent bg-accent/40' : 'border-fg2')} />
          : <span className={cx('w-[8px] h-[8px] rotate-45', selected ? 'bg-accent' : 'bg-fg2')} />}
      {prev}
    </span>
  );
}

function PropRow({ row, layer, p, comp, time, tx, selKeys, canEdit, editLayer, startKeyDrag, startBox, seek, selProp, setSelProp, endMerge, setSelKeys }) {
  const { prop, depth } = row;
  const animated = isAnimated(p);
  const shown = valueAt(p, time, { seed: seedOf(`${layer.id}|${prop.path}`), fps: comp.fps, comp });
  const set = (v, merge) => editLayer(layer.id, (l) => updatePath(l, prop.path, (q) => setValueAt(q, time, v)), `Change ${prop.label}`, merge);
  const mk = `val-${layer.id}-${prop.path}`;
  const isSel = selProp?.lid === layer.id && selProp?.path === prop.path;
  const onKey = animated && keyIndexAt(p, time) >= 0;
  const nav = (dir) => {
    const ts = p.k.map((k) => k.t);
    const t = dir < 0 ? [...ts].reverse().find((x) => x < time - 1e-4) : ts.find((x) => x > time + 1e-4);
    if (t !== undefined) seek(t);
  };
  const editor = (() => {
    const dis = !canEdit;
    const num = (v, f, o = {}) => <NumberInput value={+Number(v).toFixed(2)} onChange={(x) => f(x)} onCommit={endMerge} step={o.step || (prop.type === 'num' && prop.step) || 1} min={o.min ?? prop.min} max={o.max ?? prop.max} width={56} disabled={dis} unit={o.unit} />;
    if (prop.type === 'point' || prop.type === 'scale') {
      return <span className="flex gap-1">{num(shown[0], (x) => set([x, shown[1]], mk), { unit: prop.type === 'scale' ? '%' : '' })}{num(shown[1], (x) => set([shown[0], x], mk), { unit: prop.type === 'scale' ? '%' : '' })}</span>;
    }
    if (prop.type === 'color') return <ColorSwatch value={shown} size={18} onChange={(c) => canEdit && set(c, mk)} onCommit={endMerge} />;
    return num(shown, (x) => set(x, mk), { unit: prop.type === 'angle' ? '°' : prop.type === 'percent' ? '%' : '' });
  })();
  return (
    <div className={cx('flex border-b border-line/30', isSel && 'bg-hover')} style={{ height: ROW }} data-testid={`prop-${prop.path}`}>
      <div style={{ width: LEFT, paddingLeft: depth * 26 + 10 }} className={cx('shrink-0 flex items-center gap-1.5 border-r border-line text-[12px]', isSel ? 'bg-hover' : 'bg-panel')} onPointerDown={() => setSelProp({ lid: layer.id, path: prop.path })}>
        <button type="button" title="Stopwatch: animate this property (Alt+click: expression)" className="text-fg2 hover:text-fg" data-testid={`stopwatch-${prop.path}`}
          onClick={(e) => {
            if (!canEdit) return;
            if (e.altKey) { editLayer(layer.id, (l) => updatePath(l, prop.path, (q) => (q.x !== undefined ? (({ x, ...r }) => r)(q) : { ...q, x: 'value' })), 'Expression'); return; } // eslint-disable-line no-unused-vars
            editLayer(layer.id, (l) => updatePath(l, prop.path, (q) => toggleStopwatch(q, time)), animated ? `Stop animating ${prop.label}` : `Animate ${prop.label}`);
          }}>
          <Stopwatch on={animated} />
        </button>
        {p.x !== undefined && <span className="text-[10px] font-semibold text-[#ff4f7b]" title="Has an expression">=</span>}
        <span className="truncate text-fg2 flex-1 min-w-0">{prop.label}</span>
        {animated && (
          <span className="flex items-center text-fg3">
            <button type="button" className="hover:text-fg" onClick={() => nav(-1)} aria-label="Previous keyframe"><Icon name="chevronLeft" size={12} /></button>
            <button type="button" className={cx('hover:text-fg', onKey && 'text-accent')} aria-label="Add or remove keyframe"
              onClick={() => canEdit && editLayer(layer.id, (l) => updatePath(l, prop.path, (q) => { const i = keyIndexAt(q, time); if (i >= 0) { const k = q.k.filter((_, j) => j !== i); return k.length ? { ...q, k } : { ...q, k: undefined, v: q.k[i].v }; } return setValueAt({ ...q, k: [...q.k, { t: time, v: keyedValue(q, time), in: 'linear', out: 'linear' }].sort((a, b) => a.t - b.t) }, time, keyedValue(q, time)); }), 'Keyframe')}>
              <span className={cx('block w-[7px] h-[7px] rotate-45 mx-0.5', onKey ? 'bg-accent' : 'border border-current')} />
            </button>
            <button type="button" className="hover:text-fg" onClick={() => nav(1)} aria-label="Next keyframe"><Icon name="chevronRight" size={12} /></button>
          </span>
        )}
        <span className="shrink-0 pr-1" onPointerDown={(e) => e.stopPropagation()}>{editor}</span>
      </div>
      <div className="flex-1 relative overflow-hidden" onPointerDown={startBox}>
        {(p.k || []).map((k, i) => {
          const id = keyId(layer.id, prop.path, k.t);
          const next = p.k[i + 1];
          return (
            <span key={`${k.t}-${i}`}>
              {next && k.out === 'hold' && <span className="absolute top-1/2 h-px bg-fg3/60 pointer-events-none" style={{ left: tx(k.t), width: tx(next.t) - tx(k.t) }} />}
              <Diamond k={k} left={tx(k.t)} selected={selKeys.includes(id)} onPointerDown={(e) => { if (e.button === 2) { if (!selKeys.includes(id)) setSelKeys([id]); return; } startKeyDrag(e, id); }} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ExprRow({ layer, prop, p, depth, editLayer, canEdit, startBox }) {
  const [text, setText] = useState(p.x);
  useEffect(() => setText(p.x), [p.x]);
  const err = checkExpression(text);
  return (
    <div className="flex border-b border-line/30" style={{ height: ROW }}>
      <div style={{ width: LEFT, paddingLeft: depth * 26 + 28 }} className="shrink-0 flex items-center gap-1 border-r border-line bg-panel">
        <span className="text-[10.5px] text-fg3 shrink-0">Expression:</span>
        <input value={text} readOnly={!canEdit} spellCheck={false} data-testid={`expr-${prop.path}`}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== p.x && editLayer(layer.id, (l) => updatePath(l, prop.path, (q) => ({ ...q, x: text })), 'Edit expression')}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
          className={cx('flex-1 min-w-0 h-[18px] text-[11.5px] font-mono rounded bg-input border px-1 outline-none', err ? 'border-danger text-danger' : 'border-line text-[#ffb3c4]')} title={err || 'e.g. wiggle(2, 30) · loopOut() · time*90'} />
      </div>
      <div className="flex-1 relative text-[11px] text-danger px-2 leading-[22px] truncate" onPointerDown={startBox}>{err}</div>
    </div>
  );
}
