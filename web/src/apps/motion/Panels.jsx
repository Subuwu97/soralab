// Right-hand panels for Sora Ugoki: Project (compositions, media, templates), Effects & Presets, and the
// Properties / Effect Controls of the selected layer, with a keyframe velocity (bezier graph) editor.
import { useRef, useState } from 'react';
import { Icon } from '../../components/Icons.jsx';
import { PanelSection, NumberInput, Slider, ColorSwatch, Toggle, Select, Button, IconButton, Segmented, openMenu, promptDialog, cx } from '../../components/ui.jsx';
import { FontPicker, WeightPicker } from '../../components/Pickers.jsx';
import { isAnimated, keyedValue, setValueAt, toggleStopwatch, EASE_PRESETS, segmentBezier } from '../_anim/keyframes.js';
import { EFFECTS, effectGroups } from '../_anim/effects.js';
import { BLEND_MODES } from '../_anim/comp.js';
import { getPath, updatePath, newShape, newEffect, fmtTC } from './model.js';
import { TEMPLATES } from './templates.js';
import { parseKeyId } from './Timeline.jsx';

const Mini = ({ children }) => <div className="text-[10.5px] font-semibold uppercase tracking-wider text-fg3 mt-3 mb-1.5">{children}</div>;

/** An animatable value with a stopwatch: number slider, angle, percent, colour, or point. */
export function PropEditor({ layer, path, def, time, editLayer, canEdit, endMerge }) {
  const p = getPath(layer, path);
  if (!p) return null;
  const v = keyedValue(p, time);
  const animated = isAnimated(p);
  const merge = `pe-${layer.id}-${path}`;
  const set = (x) => canEdit && editLayer(layer.id, (l) => updatePath(l, path, (q) => setValueAt(q, time, x)), `Change ${def.label}`, merge);
  const sw = (
    <button type="button" title="Stopwatch" disabled={!canEdit} className={cx('shrink-0', animated ? 'text-accent' : 'text-fg3 hover:text-fg')}
      onClick={() => editLayer(layer.id, (l) => updatePath(l, path, (q) => toggleStopwatch(q, time)), 'Stopwatch')}>
      <Icon name="clock" size={13} />
    </button>
  );
  if (def.type === 'color') return <div className="flex items-center gap-2 h-7">{sw}<span className="text-xs text-fg2 flex-1">{def.label}</span><ColorSwatch value={v} onChange={set} onCommit={endMerge} size={22} /></div>;
  if (def.type === 'point' || def.type === 'scale') {
    return (
      <div className="flex items-center gap-2 h-7">{sw}<span className="text-xs text-fg2 flex-1 truncate">{def.label}</span>
        <NumberInput value={+v[0].toFixed(1)} onChange={(x) => set([x, v[1]])} onCommit={endMerge} width={54} disabled={!canEdit} />
        <NumberInput value={+v[1].toFixed(1)} onChange={(x) => set([v[0], x])} onCommit={endMerge} width={54} disabled={!canEdit} />
      </div>
    );
  }
  if (def.type === 'angle') return <div className="flex items-center gap-2 h-7">{sw}<span className="text-xs text-fg2 flex-1">{def.label}</span><NumberInput value={+v.toFixed(1)} onChange={set} onCommit={endMerge} unit="°" width={70} disabled={!canEdit} /></div>;
  const min = def.min ?? 0; const max = def.max ?? 100;
  return (
    <div className="flex items-start gap-2">
      <div className="pt-0.5">{sw}</div>
      <Slider className="flex-1" label={def.label} value={+Number(v).toFixed(2)} min={min} max={max} step={def.step || (max - min > 20 ? 1 : 0.1)} onChange={set} onCommit={endMerge} disabled={!canEdit} />
    </div>
  );
}

/** Speed graph for the selected keyframes' outgoing segments: drag the two handles, or pick a preset. */
function EaseGraph({ comp, selKeys, editLayer, canEdit }) {
  const first = selKeys.length ? parseKeyId(selKeys[0]) : null;
  const layer = first && comp.layers.find((l) => l.id === first.lid);
  const p = layer && getPath(layer, first.path);
  const i = p?.k ? p.k.findIndex((k) => Math.abs(k.t - first.t) < 1e-3) : -1;
  const svg = useRef(null);
  if (i < 0) return <p className="text-xs text-fg3">Select a keyframe in the timeline to shape its easing.</p>;
  const k = p.k[i]; const next = p.k[i + 1];
  const bz = next ? segmentBezier(k, next) : null;
  const apply = (b, label = 'Keyframe easing', merge) => {
    if (!canEdit) return;
    for (const id of selKeys) {
      const { lid, path, t } = parseKeyId(id);
      editLayer(lid, (l) => updatePath(l, path, (q) => ({ ...q, k: q.k.map((kk, j) => {
        if (Math.abs(kk.t - t) < 1e-3 && j < q.k.length - 1) return { ...kk, bz: b, out: kk.out === 'hold' ? 'linear' : kk.out };
        return kk;
      }) })), label, merge);
    }
  };
  const W = 220; const H = 150; const pad = 18;
  const X = (x) => pad + x * (W - pad * 2); const Y = (y) => H - pad - y * (H - pad * 2);
  const drag = (which) => (e) => {
    e.preventDefault();
    const r = svg.current.getBoundingClientRect(); const merge = `ease-${Date.now()}`;
    const mv = (ev) => {
      const x = Math.max(0, Math.min(1, (ev.clientX - r.left - pad) / (W - pad * 2)));
      const y = Math.max(-0.6, Math.min(1.6, (H - pad - (ev.clientY - r.top)) / (H - pad * 2)));
      const b = bz.slice(); if (which === 1) { b[0] = +x.toFixed(3); b[1] = +y.toFixed(3); } else { b[2] = +x.toFixed(3); b[3] = +y.toFixed(3); }
      apply(b, 'Keyframe easing', merge);
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  return (
    <div>
      <div className="text-[11px] text-fg2 mb-1">{layer.name} · {first.path.split('/').pop()} at {fmtTC(k.t, comp.fps)}{selKeys.length > 1 ? ` (+${selKeys.length - 1} more)` : ''}</div>
      {bz ? (
        <svg ref={svg} width={W} height={H} className="rounded-md bg-input border border-line touch-none" data-testid="ease-graph">
          <path d={`M${X(0)} ${Y(0)}L${X(1)} ${Y(0)}L${X(1)} ${Y(1)}L${X(0)} ${Y(1)}Z`} fill="none" stroke="var(--color-line, #333)" strokeDasharray="2 3" />
          <path d={`M${X(0)} ${Y(0)}C${X(bz[0])} ${Y(bz[1])} ${X(bz[2])} ${Y(bz[3])} ${X(1)} ${Y(1)}`} fill="none" stroke="#c79bff" strokeWidth={2} />
          <path d={`M${X(0)} ${Y(0)}L${X(bz[0])} ${Y(bz[1])}M${X(1)} ${Y(1)}L${X(bz[2])} ${Y(bz[3])}`} stroke="#888" />
          <circle cx={X(bz[0])} cy={Y(bz[1])} r={6} fill="#ffd35c" className="cursor-grab" onPointerDown={drag(1)} />
          <circle cx={X(bz[2])} cy={Y(bz[3])} r={6} fill="#ffd35c" className="cursor-grab" onPointerDown={drag(2)} />
        </svg>
      ) : <p className="text-xs text-fg3">This is the last keyframe — easing applies to the segment after a keyframe.</p>}
      <div className="flex flex-wrap gap-1 mt-2">
        {Object.entries({ linear: 'Linear', easy: 'Easy Ease', easeIn: 'Ease In', easeOut: 'Ease Out', snappy: 'Snappy', overshoot: 'Overshoot', anticipate: 'Anticipate' }).map(([id, l]) => (
          <Button key={id} size="xs" disabled={!canEdit || !bz} onClick={() => apply(EASE_PRESETS[id], l)}>{l}</Button>
        ))}
        <Button size="xs" disabled={!canEdit} onClick={() => {
          for (const id of selKeys) { const { lid, path, t } = parseKeyId(id); editLayer(lid, (l) => updatePath(l, path, (q) => ({ ...q, k: q.k.map((kk) => (Math.abs(kk.t - t) < 1e-3 ? { ...kk, out: kk.out === 'hold' ? 'linear' : 'hold' } : kk)) })), 'Toggle hold keyframe'); }
        }}>Hold</Button>
      </div>
      {bz && <div className="text-[10.5px] text-fg3 mt-1 font-mono">cubic-bezier({bz.map((x) => +x.toFixed(2)).join(', ')})</div>}
    </div>
  );
}

function ShapeProps({ layer, time, editLayer, canEdit, endMerge }) {
  const sh = layer.shape;
  const set = (fn, label) => editLayer(layer.id, (l) => ({ ...l, shape: fn(l.shape) }), label);
  const pe = (path, def) => <PropEditor layer={layer} path={path} def={def} time={time} editLayer={editLayer} canEdit={canEdit} endMerge={endMerge} />;
  return (
    <>
      <Mini>Contents</Mini>
      {sh.shapes.map((s) => (
        <div key={s.id} className="flex items-center gap-1.5 h-7 text-xs">
          <Icon name={{ rect: 'rect', ellipse: 'ellipse', star: 'starShape', polygon: 'polygon', path: 'pen' }[s.kind]} size={14} className="text-fg2" />
          <span className="flex-1 capitalize">{s.kind}</span>
          <IconButton icon={s.hidden ? 'eyeOff' : 'eye'} size={22} label="Show/hide" disabled={!canEdit} onClick={() => set((x) => ({ ...x, shapes: x.shapes.map((y) => (y.id === s.id ? { ...y, hidden: !y.hidden } : y)) }), 'Toggle shape')} />
          <IconButton icon="trash" size={22} label="Remove" disabled={!canEdit} onClick={() => set((x) => ({ ...x, shapes: x.shapes.filter((y) => y.id !== s.id) }), 'Remove shape')} />
        </div>
      ))}
      <div className="flex gap-1 mt-1">
        {[['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['star', 'Star'], ['polygon', 'Polygon']].map(([k, l]) => (
          <Button key={k} size="xs" icon="plus" disabled={!canEdit} onClick={() => set((x) => ({ ...x, shapes: [...x.shapes, newShape(k)] }), `Add ${l}`)}>{l}</Button>
        ))}
      </div>
      <div className="flex items-center justify-between mt-3"><Toggle label="Fill" checked={sh.fill.on} disabled={!canEdit} onChange={(v) => set((x) => ({ ...x, fill: { ...x.fill, on: v } }), 'Fill')} />
        {sh.fill.on && <Segmented value={sh.fill.gradient?.on ? sh.fill.gradient.type : 'solid'} onChange={(v) => set((x) => ({ ...x, fill: { ...x.fill, gradient: { ...x.fill.gradient, on: v !== 'solid', type: v === 'solid' ? x.fill.gradient.type : v } } }), 'Fill type')}
          options={[{ value: 'solid', label: 'Solid' }, { value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }]} />}
      </div>
      {sh.fill.on && (sh.fill.gradient?.on ? <>{pe('shape/fill/gradient/c0', { label: 'Start colour', type: 'color' })}{pe('shape/fill/gradient/c1', { label: 'End colour', type: 'color' })}{pe('shape/fill/gradient/a', { label: 'Start point', type: 'point' })}{pe('shape/fill/gradient/b', { label: 'End point', type: 'point' })}</>
        : pe('shape/fill/color', { label: 'Colour', type: 'color' }))}
      {sh.fill.on && pe('shape/fill/opacity', { label: 'Fill opacity', type: 'percent', min: 0, max: 100 })}
      <div className="mt-3"><Toggle label="Stroke" checked={sh.stroke.on} disabled={!canEdit} onChange={(v) => set((x) => ({ ...x, stroke: { ...x.stroke, on: v } }), 'Stroke')} /></div>
      {sh.stroke.on && (
        <>
          {pe('shape/stroke/color', { label: 'Colour', type: 'color' })}
          {pe('shape/stroke/width', { label: 'Width', type: 'num', min: 0, max: 200 })}
          <div className="flex items-center gap-2 mt-1 text-xs text-fg2">
            Cap <Select small value={sh.stroke.cap} onChange={(v) => set((x) => ({ ...x, stroke: { ...x.stroke, cap: v } }), 'Line cap')} options={[{ value: 'butt', label: 'Butt' }, { value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }]} />
            Dash <NumberInput value={sh.stroke.dash || 0} min={0} max={500} width={48} onChange={(v) => set((x) => ({ ...x, stroke: { ...x.stroke, dash: v } }), 'Dash')} disabled={!canEdit} />
          </div>
        </>
      )}
      <div className="mt-3 flex items-center gap-2"><Toggle label="Trim Paths" checked={sh.trim.on} disabled={!canEdit} onChange={(v) => set((x) => ({ ...x, trim: { ...x.trim, on: v } }), 'Trim paths')} /></div>
      {sh.trim.on && <>{pe('shape/trim/start', { label: 'Start', type: 'percent', min: 0, max: 100 })}{pe('shape/trim/end', { label: 'End', type: 'percent', min: 0, max: 100 })}{pe('shape/trim/offset', { label: 'Offset', type: 'angle' })}</>}
      <div className="mt-3"><Toggle label="Repeater" checked={sh.repeater.on} disabled={!canEdit} onChange={(v) => set((x) => ({ ...x, repeater: { ...x.repeater, on: v } }), 'Repeater')} /></div>
      {sh.repeater.on && <>{pe('shape/repeater/copies', { label: 'Copies', type: 'num', min: 1, max: 50 })}{pe('shape/repeater/offset', { label: 'Offset', type: 'point' })}{pe('shape/repeater/rotation', { label: 'Rotation', type: 'angle' })}{pe('shape/repeater/scale', { label: 'Scale', type: 'scale' })}{pe('shape/repeater/endOpacity', { label: 'End opacity', type: 'percent', min: 0, max: 100 })}</>}
    </>
  );
}

const ANIM_PRESETS = {
  typewriter: { label: 'Typewriter', anim: { soft: 0, opacity: 0, pos: [0, 0], scale: 100, rot: 0 } },
  fade: { label: 'Fade in by character', anim: { soft: 4, opacity: 0, pos: [0, 0], scale: 100, rot: 0 } },
  rise: { label: 'Rise up by character', anim: { soft: 3, opacity: 0, pos: [0, 60], scale: 100, rot: 0 } },
  pop: { label: 'Pop in', anim: { soft: 2, opacity: 0, pos: [0, 0], scale: 250, rot: 0 } },
  spin: { label: 'Spin in', anim: { soft: 3, opacity: 0, pos: [0, -30], scale: 100, rot: -90 } },
};
function applyAnimPreset(l, id, time, dur = 1.2) {
  const a = ANIM_PRESETS[id].anim;
  const P = (v) => ({ v });
  return { ...l, text: { ...l.text, anim: { on: true, offset: P(0), end: P(100), soft: P(a.soft), opacity: P(a.opacity), pos: P(a.pos), scale: P(a.scale), rot: P(a.rot),
    start: { v: 0, k: [{ t: time, v: 0, in: 'linear', out: 'linear' }, { t: time + dur, v: 100, in: 'linear', out: 'linear' }] } } } };
}

function TextProps({ layer, time, editLayer, canEdit, endMerge }) {
  const tx = layer.text;
  const set = (patch, label, merge) => editLayer(layer.id, (l) => ({ ...l, text: { ...l.text, ...patch } }), label, merge);
  const pe = (path, def) => <PropEditor layer={layer} path={path} def={def} time={time} editLayer={editLayer} canEdit={canEdit} endMerge={endMerge} />;
  return (
    <>
      <textarea value={tx.value} disabled={!canEdit} rows={3} data-testid="text-value" spellCheck={false}
        onChange={(e) => editLayer(layer.id, (l) => ({ ...l, name: (e.target.value.split('\n')[0] || 'Text').slice(0, 32), text: { ...l.text, value: e.target.value } }), 'Edit text', `tv-${layer.id}`)} onBlur={endMerge}
        className="w-full rounded-md bg-input border border-line text-sm p-2 outline-none focus:border-accent/70 mb-2" />
      <div className="flex items-center gap-1.5 mb-2">
        <FontPicker value={tx.font} weight={tx.weight} onChange={(f) => canEdit && set({ font: f }, 'Font')} width={150} />
        <WeightPicker family={tx.font} value={tx.weight} onChange={(w) => canEdit && set({ weight: w }, 'Font weight')} />
      </div>
      <div className="flex items-center gap-2 mb-1">
        <Segmented value={tx.align} onChange={(v) => canEdit && set({ align: v }, 'Align')} options={[{ value: 'left', icon: 'alignLeft', title: 'Left' }, { value: 'center', icon: 'alignCenterH', title: 'Centre' }, { value: 'right', icon: 'alignRight', title: 'Right' }]} />
        <span className="text-xs text-fg2 ml-auto">Leading</span><NumberInput value={tx.leading} step={0.05} min={0.5} max={4} width={50} onChange={(v) => set({ leading: v }, 'Leading', `lead-${layer.id}`)} onCommit={endMerge} disabled={!canEdit} />
      </div>
      {pe('text/size', { label: 'Size', type: 'num', min: 4, max: 600 })}
      {pe('text/color', { label: 'Fill colour', type: 'color' })}
      {pe('text/tracking', { label: 'Tracking', type: 'num', min: -200, max: 1000 })}
      <div className="mt-2"><Toggle label="Stroke" checked={tx.stroke?.on} disabled={!canEdit} onChange={(v) => set({ stroke: { ...tx.stroke, on: v } }, 'Text stroke')} /></div>
      {tx.stroke?.on && <>{pe('text/stroke/color', { label: 'Stroke colour', type: 'color' })}{pe('text/stroke/width', { label: 'Stroke width', type: 'num', min: 0, max: 60 })}</>}
      <Mini>Per-character animator</Mini>
      <div className="flex items-center gap-2 mb-2">
        <Toggle label="Animator" checked={tx.anim?.on} disabled={!canEdit} onChange={(v) => set({ anim: { ...tx.anim, on: v } }, 'Text animator')} />
        <Button size="xs" icon="sparkles" className="ml-auto" disabled={!canEdit} onClick={(e) => openMenu(e, Object.entries(ANIM_PRESETS).map(([id, p]) => ({ label: p.label, onClick: () => editLayer(layer.id, (l) => applyAnimPreset(l, id, time), p.label) })))}>Presets</Button>
      </div>
      {tx.anim?.on && (
        <>
          {pe('text/anim/start', { label: 'Range start', type: 'percent', min: 0, max: 100 })}
          {pe('text/anim/end', { label: 'Range end', type: 'percent', min: 0, max: 100 })}
          {pe('text/anim/offset', { label: 'Offset', type: 'percent', min: -100, max: 100 })}
          {pe('text/anim/soft', { label: 'Softness (characters)', type: 'num', min: 0, max: 20, step: 0.1 })}
          <p className="text-[10.5px] text-fg3 my-1">Characters inside the range take these values:</p>
          {pe('text/anim/opacity', { label: 'Opacity', type: 'percent', min: 0, max: 100 })}
          {pe('text/anim/pos', { label: 'Position offset', type: 'point' })}
          {pe('text/anim/scale', { label: 'Scale', type: 'percent', min: 0, max: 500 })}
          {pe('text/anim/rot', { label: 'Rotation', type: 'angle' })}
        </>
      )}
    </>
  );
}

function EffectControls({ layer, comp, time, editLayer, canEdit, endMerge }) {
  const setFx = (id, fn, label) => editLayer(layer.id, (l) => ({ ...l, effects: l.effects.map((e) => (e.id === id ? fn(e) : e)) }), label);
  const move = (i, d) => editLayer(layer.id, (l) => { const e = l.effects.slice(); const [x] = e.splice(i, 1); e.splice(Math.max(0, Math.min(e.length, i + d)), 0, x); return { ...l, effects: e }; }, 'Reorder effects');
  if (!layer.effects.length) return <p className="text-xs text-fg3">No effects. Add one from Effects &amp; Presets below, or Effect menu.</p>;
  return layer.effects.map((e, i) => {
    const def = EFFECTS[e.type];
    return (
      <div key={e.id} className="mb-3 rounded-md border border-line p-2" data-testid={`fx-${e.type}`}>
        <div className="flex items-center gap-1 mb-1">
          <button type="button" className={cx('text-xs font-semibold', e.on === false ? 'text-fg3 line-through' : 'text-accent')} onClick={() => canEdit && setFx(e.id, (x) => ({ ...x, on: x.on === false }), 'Toggle effect')} title="Turn effect on/off"><Icon name="fx" size={13} className="inline mr-1" />{def.label}</button>
          <div className="flex-1" />
          <IconButton icon="chevronUp" size={20} label="Move up" disabled={!canEdit || i === 0} onClick={() => move(i, -1)} />
          <IconButton icon="chevronDown" size={20} label="Move down" disabled={!canEdit || i === layer.effects.length - 1} onClick={() => move(i, 1)} />
          <IconButton icon="trash" size={20} label="Remove effect" disabled={!canEdit} onClick={() => editLayer(layer.id, (l) => ({ ...l, effects: l.effects.filter((x) => x.id !== e.id) }), 'Remove effect')} />
        </div>
        {Object.entries(def.params).map(([k, d]) => {
          if (d.type === 'toggle') return <Toggle key={k} className="my-1" label={d.label} checked={!!e.params[k]} disabled={!canEdit} onChange={(v) => setFx(e.id, (x) => ({ ...x, params: { ...x.params, [k]: v } }), d.label)} />;
          if (d.type === 'select') return <div key={k} className="flex items-center gap-2 my-1"><span className="text-xs text-fg2 flex-1">{d.label}</span><Select small value={e.params[k]} onChange={(v) => setFx(e.id, (x) => ({ ...x, params: { ...x.params, [k]: v } }), d.label)} options={d.choices.map(([v, l]) => ({ value: v, label: l }))} /></div>;
          return <PropEditor key={k} layer={layer} path={`effects/#${e.id}/params/${k}`} def={d} time={time} editLayer={editLayer} canEdit={canEdit} endMerge={endMerge} />;
        })}
      </div>
    );
  });
}

export function LayerPanel({ project, comp, layer, time, editLayer, canEdit, endMerge, selKeys }) {
  if (!layer) {
    return (
      <PanelSection title="Properties" id="mo-props">
        <p className="text-xs text-fg3">Select a layer to see its properties and effects.</p>
        {selKeys.length > 0 && <><Mini>Keyframe velocity</Mini><EaseGraph comp={comp} selKeys={selKeys} editLayer={editLayer} canEdit={canEdit} /></>}
      </PanelSection>
    );
  }
  const pe = (path, def) => <PropEditor layer={layer} path={path} def={def} time={time} editLayer={editLayer} canEdit={canEdit} endMerge={endMerge} />;
  const set = (patch, label) => editLayer(layer.id, (l) => ({ ...l, ...patch }), label);
  return (
    <>
      {selKeys.length > 0 && (
        <PanelSection title="Keyframe velocity" id="mo-ease"><EaseGraph comp={comp} selKeys={selKeys} editLayer={editLayer} canEdit={canEdit} /></PanelSection>
      )}
      <PanelSection title={`Layer · ${layer.name}`} id="mo-layer">
        <div className="flex items-center gap-2 mb-2 text-xs text-fg2">
          <span className="capitalize">{layer.type === 'precomp' ? 'Precomp' : layer.type}</span>
          <span className="ml-auto">In {fmtTC(layer.in, comp.fps)} · Out {fmtTC(layer.out, comp.fps)}</span>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-fg2">Blend</span>
          <Select small value={layer.blend || 'normal'} onChange={(v) => set({ blend: v }, 'Blend mode')} options={BLEND_MODES.map(([v, l]) => ({ value: v, label: l }))} disabled={!canEdit} />
          <Toggle className="ml-auto whitespace-nowrap" label="Motion blur" checked={!!layer.motionBlur} disabled={!canEdit} onChange={(v) => set({ motionBlur: v }, 'Motion blur')} />
        </div>
        {layer.type === 'solid' && <>{pe('color', { label: 'Colour', type: 'color' })}
          <div className="flex items-center gap-2 text-xs text-fg2 mt-1">Size <NumberInput value={layer.w} min={1} max={16384} width={60} onChange={(v) => set({ w: v }, 'Solid size')} disabled={!canEdit} />×<NumberInput value={layer.h} min={1} max={16384} width={60} onChange={(v) => set({ h: v }, 'Solid size')} disabled={!canEdit} /></div></>}
        {(layer.type === 'video' || layer.type === 'audio') && <>{pe('volume', { label: 'Audio level', type: 'percent', min: 0, max: 200 })}<div className="mt-1"><Toggle label="Audio on" checked={layer.audioOn !== false} disabled={!canEdit} onChange={(v) => set({ audioOn: v }, 'Audio')} /></div></>}
        {layer.type === 'shape' && <ShapeProps layer={layer} time={time} editLayer={editLayer} canEdit={canEdit} endMerge={endMerge} />}
        {layer.type === 'text' && <TextProps layer={layer} time={time} editLayer={editLayer} canEdit={canEdit} endMerge={endMerge} />}
        {layer.type !== 'audio' && (
          <>
            <Mini>Transform</Mini>
            {pe('tr/anchor', { label: 'Anchor point', type: 'point' })}
            {pe('tr/position', { label: 'Position', type: 'point' })}
            {pe('tr/scale', { label: 'Scale %', type: 'scale' })}
            {pe('tr/rotation', { label: 'Rotation', type: 'angle' })}
            {pe('tr/opacity', { label: 'Opacity', type: 'percent', min: 0, max: 100 })}
          </>
        )}
      </PanelSection>
      {layer.masks?.length > 0 && (
        <PanelSection title="Masks" id="mo-masks">
          {layer.masks.map((m, i) => (
            <div key={m.id} className="mb-2 rounded-md border border-line p-2">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-[#ffd35c]" />
                <span className="text-xs flex-1">{m.name || `Mask ${i + 1}`} <span className="text-fg3">({m.kind})</span></span>
                <Select small value={m.mode} disabled={!canEdit} onChange={(v) => editLayer(layer.id, (l) => ({ ...l, masks: l.masks.map((x) => (x.id === m.id ? { ...x, mode: v } : x)) }), 'Mask mode')}
                  options={[{ value: 'add', label: 'Add' }, { value: 'subtract', label: 'Subtract' }, { value: 'intersect', label: 'Intersect' }, { value: 'none', label: 'None' }]} />
                <IconButton icon="trash" size={22} label="Delete mask" disabled={!canEdit} onClick={() => editLayer(layer.id, (l) => ({ ...l, masks: l.masks.filter((x) => x.id !== m.id) }), 'Delete mask')} />
              </div>
              <Toggle label="Inverted" checked={m.inverted} disabled={!canEdit} onChange={(v) => editLayer(layer.id, (l) => ({ ...l, masks: l.masks.map((x) => (x.id === m.id ? { ...x, inverted: v } : x)) }), 'Invert mask')} />
              {pe(`masks/#${m.id}/feather`, { label: 'Feather', type: 'num', min: 0, max: 300 })}
              {pe(`masks/#${m.id}/opacity`, { label: 'Opacity', type: 'percent', min: 0, max: 100 })}
            </div>
          ))}
        </PanelSection>
      )}
      {layer.type !== 'audio' && layer.type !== 'null' && (
        <PanelSection title="Effect Controls" id="mo-fx">
          <EffectControls layer={layer} comp={comp} time={time} editLayer={editLayer} canEdit={canEdit} endMerge={endMerge} />
        </PanelSection>
      )}
    </>
  );
}

export function EffectsPanel({ layer, comp, editLayer, canEdit }) {
  const [q, setQ] = useState('');
  const groups = effectGroups();
  const can = canEdit && layer && !['audio', 'null'].includes(layer.type);
  return (
    <PanelSection title="Effects & Presets" id="mo-effects">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search effects" className="w-full h-7 px-2 rounded-md bg-input border border-line text-[12px] outline-none mb-2" />
      {!can && <p className="text-[11px] text-fg3 mb-2">Select a layer (or an adjustment layer) to apply an effect.</p>}
      {Object.entries(groups).map(([g, list]) => {
        const items = list.filter((x) => x.label.toLowerCase().includes(q.toLowerCase()));
        if (!items.length) return null;
        return (
          <div key={g} className="mb-1.5">
            <div className="text-[10.5px] text-fg3 uppercase tracking-wider">{g}</div>
            {items.map((x) => (
              <button key={x.id} type="button" disabled={!can} data-testid={`add-fx-${x.id}`}
                onClick={() => editLayer(layer.id, (l) => ({ ...l, effects: [...l.effects, newEffect(x.id, comp)] }), `Add ${x.label}`)}
                className="w-full flex items-center gap-2 h-6 px-1.5 rounded text-[12px] text-left hover:bg-hover disabled:opacity-40">
                <Icon name="fx" size={13} className="text-fg3" />{x.label}
              </button>
            ))}
          </div>
        );
      })}
    </PanelSection>
  );
}

export function ProjectPanel({ project, comp, setCompId, canEdit, editProject, onCompSettings, onNewComp, media, onImport, onAddMedia, onTemplate }) {
  return (
    <>
      <PanelSection title="Project" id="mo-project" actions={canEdit && <IconButton icon="plus" size={22} label="New composition" onClick={onNewComp} />}>
        {project.comps.map((c) => (
          <div key={c.id} className={cx('flex items-center gap-2 h-7 px-1.5 rounded text-[12px] cursor-pointer', c.id === comp.id ? 'bg-active' : 'hover:bg-hover')} onClick={() => setCompId(c.id)}
            onContextMenu={(e) => { e.preventDefault(); if (!canEdit) return; openMenu(e, [
              { label: 'Composition settings…', icon: 'settings', onClick: () => onCompSettings(c) },
              { label: 'Rename…', icon: 'edit', onClick: async () => { const n = await promptDialog({ title: 'Rename composition', label: 'Name', value: c.name }); if (n) editProject((p) => ({ ...p, comps: p.comps.map((x) => (x.id === c.id ? { ...x, name: n } : x)) }), 'Rename composition'); } },
              { label: 'Set as main composition', icon: 'star', onClick: () => editProject((p) => ({ ...p, main: c.id }), 'Main composition') },
              { divider: true },
              { label: 'Delete', icon: 'trash', danger: true, disabled: project.comps.length < 2 || project.comps.some((x) => x.layers.some((l) => l.type === 'precomp' && l.comp === c.id)), onClick: () => { editProject((p) => ({ ...p, comps: p.comps.filter((x) => x.id !== c.id), main: p.main === c.id ? p.comps.find((x) => x.id !== c.id).id : p.main }), 'Delete composition'); if (c.id === comp.id) setCompId(null); } },
            ]); }}>
            <Icon name="layers" size={14} className="text-accent" />
            <span className="flex-1 truncate">{c.name}{project.main === c.id && <span className="text-fg3"> · main</span>}</span>
            <span className="text-fg3 text-[10.5px]">{c.width}×{c.height} · {c.duration}s</span>
          </div>
        ))}
        <div className="flex items-center justify-between mt-3 mb-1">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg3">Media</span>
          {canEdit && <Button size="xs" icon="import" onClick={onImport}>Import…</Button>}
        </div>
        {!media.length && <p className="text-[11px] text-fg3">Images, video and sound you import appear here. Click one to add it as a layer.</p>}
        {media.map((a) => (
          <button key={a.id} type="button" disabled={!canEdit} onClick={() => onAddMedia(a)} className="w-full flex items-center gap-2 h-7 px-1.5 rounded text-[12px] text-left hover:bg-hover" title="Add to the composition">
            <Icon name={a.kind === 'image' ? 'image' : a.kind === 'video' ? 'video' : 'audio'} size={14} className="text-fg3" />
            <span className="flex-1 truncate">{a.name}</span>
            <span className="text-fg3 text-[10.5px]">{a.duration ? `${a.duration.toFixed(1)}s` : a.width ? `${a.width}×${a.height}` : ''}</span>
          </button>
        ))}
      </PanelSection>
      <PanelSection title="Templates" id="mo-templates" defaultOpen>
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" disabled={!canEdit} onClick={() => onTemplate(t)} data-testid={`tpl-${t.id}`}
            className="w-full flex items-start gap-2 p-1.5 rounded text-left hover:bg-hover disabled:opacity-50">
            <span className="w-7 h-7 rounded-md bg-accent/20 text-accent grid place-items-center shrink-0"><Icon name={t.icon} size={15} /></span>
            <span className="min-w-0"><span className="block text-[12px] font-medium">{t.name}</span><span className="block text-[10.5px] text-fg3 leading-snug">{t.desc}</span></span>
          </button>
        ))}
      </PanelSection>
    </>
  );
}
