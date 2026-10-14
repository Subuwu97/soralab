// Layers panel shared by both editors: thumbnails (and mask thumbnails), visibility, lock, blend mode and opacity,
// clipping indicators, groups, rename, drag to reorder (or drop into a group), and a context menu.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Slider, openMenu, cx } from '../../components/ui.jsx';
import { Icon, IBtn } from './icons.jsx';
import { BLEND_MODES, GROUP_BLEND_MODES, updateLayer, moveLayer, findLayer } from './model.js';
import { layerThumb } from './render.js';
import { ADJUSTMENTS } from './adjust.js';

const thumbCache = new WeakMap();
function Thumb({ layer, doc, renderer, which = 'content', size = 34, active, onClick, title }) {
  const key = which === 'mask' ? layer.mask : layer;
  const [url, setUrl] = useState(() => thumbCache.get(key) || null);
  useEffect(() => {
    if (thumbCache.has(key)) { setUrl(thumbCache.get(key)); return undefined; }
    // thumbnails are cheap but not free: wait until edits settle
    const t = setTimeout(() => {
      try { const c = layerThumb(renderer, layer, doc, size * 2, which); const u = c ? c.toDataURL() : null; thumbCache.set(key, u); setUrl(u); } catch { /* layer went away */ }
    }, 250);
    return () => clearTimeout(t);
  }, [key, doc.width, doc.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const aspect = doc.width / doc.height;
  const w = aspect >= 1 ? size : Math.round(size * aspect); const h = aspect >= 1 ? Math.round(size / aspect) : size;
  return (
    <button type="button" onClick={onClick} title={title} className={cx('shrink-0 grid place-items-center rounded-[3px] overflow-hidden', active ? 'ring-2 ring-accent' : 'ring-1 ring-line')} style={{ width: size, height: size }}>
      {layer.type === 'adjust' && which !== 'mask'
        ? <span className="w-full h-full grid place-items-center bg-panel-2 text-fg2"><Icon name={ADJUSTMENTS[layer.adj.kind]?.icon || 'adjust'} size={16} /></span>
        : layer.type === 'fill' && which !== 'mask'
          ? <span className="w-full h-full" style={{ background: layer.fill.kind === 'gradient' ? `linear-gradient(${90 - (layer.fill.angle ?? 90)}deg, ${(layer.fill.colors || []).join(',')})` : layer.fill.color }} />
          : layer.type === 'text' && which !== 'mask'
            ? <span className="w-full h-full grid place-items-center bg-panel-2 text-fg font-serif text-[15px]">T</span>
            : <span className="checker block" style={{ width: w, height: h }}>{url && <img src={url} alt="" className="block w-full h-full" />}</span>}
    </button>
  );
}

function rowsOf(layers, depth = 0, out = []) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    out.push({ l, depth, clipped: l.clip && i > 0 });
    if (l.type === 'group' && l.open) rowsOf(l.children, depth + 1, out);
  }
  return out;
}

export default function LayersPanel({
  doc, activeId, onSelect, target = 'pix', onTarget, commit, renderer, readOnly, compact, contextItems, onLoadSelection,
  onNewLayer, onNewGroup, onDelete, onAddMask, adjustMenu, fxMenu, onDuplicate, height,
}) {
  const rows = useMemo(() => rowsOf(doc.layers), [doc.layers]);
  const active = findLayer(doc.layers, activeId);
  const [renaming, setRenaming] = useState(null);
  const [drag, setDrag] = useState(null); // { id, over, where }
  const listRef = useRef(null);
  const set = (id, patch, label, merge) => !readOnly && commit(updateLayer(doc, id, patch), label, merge ? { merge } : undefined);

  const startDrag = (e, l) => {
    if (readOnly || e.button !== 0 || e.target.closest('button,input,select')) return;
    const y0 = e.clientY; let started = false; let state = null;
    const move = (ev) => {
      if (!started && Math.abs(ev.clientY - y0) < 5) return;
      started = true;
      const els = [...listRef.current.querySelectorAll('[data-layer-row]')];
      const hit = els.find((el) => { const r = el.getBoundingClientRect(); return ev.clientY >= r.top && ev.clientY < r.bottom; });
      if (!hit) { state = { id: l.id }; setDrag(state); return; }
      const r = hit.getBoundingClientRect(); const id = hit.dataset.layerRow;
      const tl = findLayer(doc.layers, id); const f = (ev.clientY - r.top) / r.height;
      const where = tl?.type === 'group' && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'above' : 'below';
      state = { id: l.id, over: id, where }; setDrag(state);
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDrag(null);
      if (started && state?.over && state.over !== l.id) {
        const next = moveLayer(doc.layers, l.id, { [state.where]: state.over });
        if (next !== doc.layers) commit({ ...doc, layers: next }, 'Move layer');
      }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  return (
    <div className="flex flex-col" style={height ? { height } : undefined}>
      {active && !compact && (
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <Select small value={active.blend} disabled={readOnly || active.type === 'adjust' && false} onChange={(v) => set(active.id, { blend: v }, 'Blend mode')}
            options={active.type === 'group' ? GROUP_BLEND_MODES : BLEND_MODES} className="flex-1 min-w-0" />
          <OpacityBox value={active.opacity} disabled={readOnly} onChange={(v) => set(active.id, { opacity: v }, 'Opacity', `op-${active.id}`)} />
        </div>
      )}
      {active && compact && (
        <div className="px-2 pb-2 flex flex-col gap-1">
          <Slider label="Opacity" value={Math.round(active.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => set(active.id, { opacity: v / 100 }, 'Opacity', `op-${active.id}`)} disabled={readOnly} />
          <Select small value={active.blend} disabled={readOnly} onChange={(v) => set(active.id, { blend: v }, 'Blend mode')} options={active.type === 'group' ? GROUP_BLEND_MODES : BLEND_MODES} />
        </div>
      )}
      {active && (
        <div className="flex items-center gap-0.5 px-2 pb-1.5 text-[11px] text-fg3">
          <span className="mr-1">Lock</span>
          <IBtn icon="lockAlpha" size={22} label="Lock transparent pixels" active={active.lockAlpha} disabled={readOnly || active.type !== 'bitmap'} onClick={() => set(active.id, { lockAlpha: !active.lockAlpha }, 'Lock transparency')} />
          <IBtn icon="lock" size={22} label="Lock all" active={active.locked} disabled={readOnly} onClick={() => set(active.id, { locked: !active.locked }, 'Lock layer')} />
          <IBtn icon="clipArrow" size={22} label="Clip to layer below (Alt+Ctrl+G)" active={active.clip} disabled={readOnly} onClick={() => set(active.id, { clip: !active.clip }, active.clip ? 'Release clipping mask' : 'Create clipping mask')} />
        </div>
      )}
      <div ref={listRef} className="flex-1 min-h-24 overflow-y-auto scroll-thin border-t border-line" role="listbox" aria-label="Layers">
        {rows.map(({ l, depth, clipped }) => {
          const isActive = l.id === activeId;
          const d = drag && drag.over === l.id ? drag.where : null;
          return (
            <div key={l.id} data-layer-row={l.id} role="option" aria-selected={isActive}
              onPointerDown={(e) => startDrag(e, l)}
              onClick={() => { onSelect(l.id); if (target === 'mask' && !l.mask) onTarget?.('pix'); }}
              onContextMenu={(e) => { e.preventDefault(); onSelect(l.id); const items = contextItems?.(l); if (items?.length) openMenu(e, items); }}
              className={cx('relative flex items-center gap-1.5 h-11 pr-2 border-b border-line/60 select-none',
                isActive ? 'bg-active' : 'hover:bg-hover', drag?.id === l.id && 'opacity-50', d === 'into' && 'ring-2 ring-inset ring-accent')}
              style={{ paddingLeft: 4 + depth * 14 }}>
              {d === 'above' && <span className="absolute left-0 right-0 top-0 h-0.5 bg-accent" />}
              {d === 'below' && <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-accent" />}
              <button type="button" aria-label={l.visible ? 'Hide layer' : 'Show layer'} title={l.visible ? 'Hide' : 'Show'}
                onClick={(e) => { e.stopPropagation(); set(l.id, { visible: !l.visible }, l.visible ? 'Hide layer' : 'Show layer'); }}
                className={cx('w-6 h-6 grid place-items-center rounded hover:bg-hover shrink-0', l.visible ? 'text-fg2' : 'text-fg3')}>
                <Icon name={l.visible ? 'eye' : 'eyeOff'} size={14} />
              </button>
              {l.type === 'group'
                ? <button type="button" onClick={(e) => { e.stopPropagation(); commit(updateLayer(doc, l.id, { open: !l.open }), l.open ? 'Collapse group' : 'Expand group'); }} className="w-4 text-fg2 shrink-0" aria-label={l.open ? 'Collapse' : 'Expand'}>
                  <Icon name={l.open ? 'chevronDown' : 'chevronRight'} size={13} />
                </button> : null}
              {clipped && <Icon name="clipArrow" size={13} className="text-fg2 shrink-0" />}
              {l.type === 'group'
                ? <span className="w-[34px] h-[34px] grid place-items-center text-fg2 shrink-0"><Icon name="folder" size={20} /></span>
                : <Thumb layer={l} doc={doc} renderer={renderer} active={isActive && target === 'pix' && !!l.mask}
                  title={onLoadSelection ? 'Ctrl+click: load as selection' : undefined}
                  onClick={(e) => { if ((e.ctrlKey || e.metaKey) && onLoadSelection) { e.stopPropagation(); onLoadSelection(l); return; } onTarget?.('pix'); }} />}
              {l.mask && (
                <span className="relative">
                  <Thumb layer={l} doc={doc} renderer={renderer} which="mask" active={isActive && target === 'mask'} title="Layer mask (Shift+click: disable)"
                    onClick={(e) => { e.stopPropagation(); onSelect(l.id); if (e.shiftKey) set(l.id, { mask: { ...l.mask, enabled: !l.mask.enabled } }, l.mask.enabled ? 'Disable mask' : 'Enable mask'); else onTarget?.('mask'); }} />
                  {!l.mask.enabled && <span className="absolute inset-0 grid place-items-center pointer-events-none"><Icon name="close" size={30} className="text-danger" stroke={2.5} /></span>}
                </span>
              )}
              <div className="flex-1 min-w-0" onDoubleClick={(e) => { e.stopPropagation(); if (!readOnly) setRenaming(l.id); }}>
                {renaming === l.id ? (
                  <input autoFocus defaultValue={l.name} className="w-full h-6 px-1 rounded bg-input border border-accent/60 text-[13px] outline-none"
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = l.name; e.currentTarget.blur(); } e.stopPropagation(); }}
                    onBlur={(e) => { const v = e.currentTarget.value.trim(); setRenaming(null); if (v && v !== l.name) set(l.id, { name: v }, 'Rename layer'); }} />
                ) : (
                  <div className={cx('text-[13px] truncate', !l.visible && 'text-fg3')}>{l.name}</div>
                )}
                {!compact && (l.blend !== 'source-over' && l.blend !== 'pass-through' || l.opacity < 1) && (
                  <div className="text-[10.5px] text-fg3 truncate">{l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : ''}</div>
                )}
              </div>
              {l.fx && Object.values(l.fx).some((f) => f?.on) && <span className="text-[11px] italic font-semibold text-fg2" title="Layer effects">fx</span>}
              {(l.locked || l.lockAlpha) && <Icon name="lock" size={12} className={l.locked ? 'text-fg2' : 'text-fg3'} />}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-0.5 px-1.5 py-1 border-t border-line">
        {fxMenu && <IBtn icon="fx" size={26} label="Layer effects" disabled={readOnly || !active} onClick={fxMenu} />}
        {onAddMask && <IBtn icon="maskAdd" size={26} label="Add layer mask" disabled={readOnly || !active} onClick={onAddMask} />}
        {adjustMenu && <IBtn icon="adjustLayer" size={26} label="New fill or adjustment layer" disabled={readOnly} onClick={adjustMenu} />}
        {onNewGroup && <IBtn icon="folderPlus" size={26} label="New group (Ctrl+G)" disabled={readOnly} onClick={onNewGroup} />}
        {onDuplicate && <IBtn icon="duplicate" size={26} label="Duplicate layer (Ctrl+J)" disabled={readOnly || !active} onClick={onDuplicate} />}
        {onNewLayer && <IBtn icon="newLayer" size={26} label="New layer (Ctrl+Shift+N)" disabled={readOnly} onClick={onNewLayer} />}
        {onDelete && <IBtn icon="trash" size={26} label="Delete layer" disabled={readOnly || !active} onClick={onDelete} />}
      </div>
    </div>
  );
}

function OpacityBox({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex items-center gap-1">
      <span className="text-[11px] text-fg3">Opacity</span>
      <button type="button" disabled={disabled} onClick={() => setOpen(!open)} className="h-7 w-14 rounded bg-input border border-line text-[12px] tabular-nums">{Math.round(value * 100)}%</button>
      {open && (
        <div className="absolute right-0 top-8 z-20 w-44 p-2 rounded-lg bg-menu border border-line shadow-xl" onPointerLeave={() => setOpen(false)}>
          <Slider value={Math.round(value * 100)} min={0} max={100} unit="%" onChange={(v) => onChange(v / 100)} />
        </div>
      )}
    </div>
  );
}
