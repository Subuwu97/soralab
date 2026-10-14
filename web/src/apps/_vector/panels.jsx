// Panels shared by the vector apps: tool strip, Properties (transform, appearance, character, paragraph, shape,
// image, symbol instance), Layers, Swatches, Align, Pathfinder, Symbols and Artboards.
import { useMemo, useRef, useState } from 'react';
import { IconButton, NumberInput, Select, Segmented, Slider, ColorSwatch, PanelSection, Toggle, Button, TextInput, openMenu, promptDialog, cx, libraryColorStore } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { FontPicker, WeightPicker, pickAssets } from '../../components/Pickers.jsx';
import { Tool, ToolDivider } from '../../components/EditorShell.jsx';
import { keyLabel } from '../../lib/shortcuts.js';
import { useFonts } from '../../lib/fonts.js';
import { find, findNode, bounds, boundsOf, solid, linear, radial, strokeOf, removeIds, insertInto, walk, transformNode, artboardsOf, updateIn } from './model.js';
import { decompose, translate, rotate, scale, unionRects, isIdentity } from './geom.js';
import { renderNode, renderContext, BLENDS } from './render.js';
import { fontOf } from './text.js';

// Extra icons this engine needs (drawn like Icons.jsx: 24×24 strokes).
const V = {
  unite: ['M4 4h10v6h6v10H10v-6H4z'], minusFront: ['M4 4h10v6h-4v4H4z', 'M10 10h10v10H10z'], intersect: ['M4 4h10v10H4z', 'M10 10h10v10H10z', 'M10 10h4v4h-4z'],
  exclude: ['M4 4h10v6h-4v4H4zM14 10h6v10H10v-6h4z'], divide: ['M4 4h10v10H4z', 'M10 10h10v10H10z', 'M10 14h4M14 10v4'],
  stroke: ['M5 5h14v14H5z', 'M9 9h6v6H9z'], swap: ['M7 7h8l-3-3M17 17H9l3 3'], ungroup: ['M3 3h7v7H3z', 'M14 14h7v7h-7z'],
  instance: ['M12 3l4 4-4 4-4-4z', 'M12 13l4 4-4 4-4-4z'], repeat: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  convert: ['M12 12h.01', 'M4 20 12 12 20 4', 'M8 8l8 8'], spaceH: ['M4 4v16M20 4v16', 'M8 8h3v8H8zM13 8h3v8h-3z'], spaceV: ['M4 4h16M4 20h16', 'M8 8h8v3H8zM8 13h8v3H8z'],
};
export function VIcon({ name, size = 18, className }) {
  const d = V[name];
  if (!d) return <Icon name={name} size={size} className={className} />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={`shrink-0 ${className || ''}`} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((x, i) => <path key={i} d={x} />)}
    </svg>
  );
}

const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- tool strip

/** tools: [{ id, icon, label, key } | 'divider'] */
export function ToolStrip({ ed, tools }) {
  return (
    <>
      {tools.map((t, i) => (t === 'divider' ? <ToolDivider key={`d${i}`} />
        : <Tool key={t.id} icon={t.icon} label={t.label} shortcut={t.key} active={ed.tool === t.id} onClick={() => ed.setTool(t.id)}>{t.vicon && <VIcon name={t.vicon} size={18} />}</Tool>))}
      <ToolDivider />
      <FillStrokeWidget ed={ed} />
    </>
  );
}

/** Illustrator's fill/stroke squares: they show (and set) the selection's colours, or the defaults for new shapes. */
function FillStrokeWidget({ ed }) {
  const n = ed.selNodes.find((x) => x.type !== 'group') || null;
  const fill = n ? n.fill : ed.style.fill;
  const st = n ? n.stroke : ed.style.stroke;
  const setFill = (c, commit) => {
    const f = c ? solid(c) : null;
    if (ed.sel.length) { ed.setProps({ fill: f }, 'Fill', { merge: `fill-${ed.sel.join()}` }); if (commit) ed.h.commit(); }
    ed.setStyle((s) => ({ ...s, fill: f, ...(n?.type === 'text' && f ? { textFill: f } : {}) }));
  };
  const setStroke = (c, commit) => {
    const v = c ? { ...(st || strokeOf(c, 1)), color: c } : null;
    if (ed.sel.length) { ed.setProps({ stroke: v }, 'Stroke', { merge: `stroke-${ed.sel.join()}` }); if (commit) ed.h.commit(); }
    ed.setStyle((s) => ({ ...s, stroke: v }));
  };
  const fc = fill?.type === 'solid' ? fill.color : fill?.stops?.[0]?.color || null;
  return (
    <div className="relative w-9 h-10 mt-1 shrink-0" title="Fill and stroke">
      <div className="absolute right-0 bottom-0"><ColorSwatch value={st?.color || null} none onChange={(c) => setStroke(c)} onCommit={(c) => setStroke(c, true)} size={20} title="Stroke" className="ring-4 ring-inset ring-panel" /></div>
      <div className="absolute left-0 top-0"><ColorSwatch value={fc} none onChange={(c) => setFill(c)} onCommit={(c) => setFill(c, true)} size={20} title="Fill" /></div>
    </div>
  );
}

// ---------------------------------------------------------------- fill and stroke editors

export function FillEditor({ value, onChange, onCommit, allowNone = true }) {
  const f = value || { type: 'none' };
  const kind = f.type || 'none';
  const set = (v, commit) => { onChange(v); if (commit) onCommit?.(v); };
  const stops = f.stops || [];
  const css = kind === 'linear' ? `linear-gradient(90deg, ${stops.map((s) => `${s.color} ${s.o * 100}%`).join(',')})` : kind === 'radial' ? `radial-gradient(circle, ${stops.map((s) => `${s.color} ${s.o * 100}%`).join(',')})` : null;
  const toKind = (k) => {
    const base = kind === 'solid' ? f.color : stops[0]?.color || '#000000';
    if (k === 'none') return null;
    if (k === 'solid') return solid(base);
    const st = stops.length >= 2 ? stops : [{ o: 0, color: base }, { o: 1, color: '#ffffff' }];
    return k === 'linear' ? { ...linear(f.angle ?? 90), stops: st } : { ...radial(), stops: st };
  };
  return (
    <div className="flex flex-col gap-2">
      <Segmented value={kind} onChange={(k) => set(toKind(k), true)} options={[...(allowNone ? [{ value: 'none', label: 'None' }] : []), { value: 'solid', label: 'Solid' }, { value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }]} />
      {kind === 'solid' && <div className="flex items-center gap-2"><ColorSwatch value={f.color} onChange={(c) => set(solid(c))} onCommit={(c) => set(solid(c), true)} /><span className="text-xs font-mono text-fg2 uppercase">{f.color}</span></div>}
      {(kind === 'linear' || kind === 'radial') && (
        <>
          <div className="h-4 rounded border border-line checker overflow-hidden"><div className="w-full h-full" style={{ background: css }} /></div>
          {stops.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <ColorSwatch value={s.color} size={22} onChange={(c) => set({ ...f, stops: stops.map((x, j) => (j === i ? { ...x, color: c } : x)) })} onCommit={(c) => set({ ...f, stops: stops.map((x, j) => (j === i ? { ...x, color: c } : x)) }, true)} />
              <NumberInput value={Math.round(s.o * 100)} unit="%" min={0} max={100} width={54} onChange={(v) => set({ ...f, stops: stops.map((x, j) => (j === i ? { ...x, o: v / 100 } : x)) })} onCommit={(v) => set({ ...f, stops: stops.map((x, j) => (j === i ? { ...x, o: v / 100 } : x)) }, true)} />
              <span className="flex-1" />
              {stops.length > 2 && <IconButton icon="minus" label="Remove stop" size={22} onClick={() => set({ ...f, stops: stops.filter((_, j) => j !== i) }, true)} />}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button size="xs" variant="ghost" icon="plus" onClick={() => set({ ...f, stops: [...stops, { o: 1, color: stops[stops.length - 1]?.color || '#ffffff' }].sort((a, b) => a.o - b.o) }, true)}>Stop</Button>
            <Button size="xs" variant="ghost" icon="swap" onClick={() => set({ ...f, stops: stops.map((s) => ({ ...s, o: 1 - s.o })).reverse() }, true)}>Reverse</Button>
            {kind === 'linear' && <NumberInput label="∠" value={f.angle || 0} unit="°" min={-360} max={360} width={52} onChange={(v) => set({ ...f, angle: v })} onCommit={(v) => set({ ...f, angle: v }, true)} />}
          </div>
        </>
      )}
    </div>
  );
}

function StrokeEditor({ value, onChange, onCommit }) {
  const st = value;
  const set = (patch, commit) => { const v = st ? { ...st, ...patch } : strokeOf('#000000', 1, patch); onChange(v); if (commit) onCommit?.(v); };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ColorSwatch value={st?.color || null} none onChange={(c) => (c ? set({ color: c }) : onChange(null))} onCommit={(c) => (c ? set({ color: c }, true) : (onChange(null), onCommit?.(null)))} />
        <NumberInput label="W" value={st?.width ?? 0} min={0} max={500} step={0.5} unit="px" width={60} onChange={(v) => set({ width: v })} onCommit={(v) => set({ width: v }, true)} />
        <Select small value={st?.align || 'center'} onChange={(v) => set({ align: v }, true)} options={[{ value: 'center', label: 'Center' }, { value: 'inside', label: 'Inside' }, { value: 'outside', label: 'Outside' }]} />
      </div>
      {st && (
        <div className="flex items-center gap-2 flex-wrap">
          <Segmented value={st.cap || 'butt'} onChange={(v) => set({ cap: v }, true)} options={[{ value: 'butt', label: 'Butt' }, { value: 'round', label: 'Round' }, { value: 'square', label: 'Proj' }]} />
          <Segmented value={st.join || 'miter'} onChange={(v) => set({ join: v }, true)} options={[{ value: 'miter', label: 'Miter' }, { value: 'round', label: 'Round' }, { value: 'bevel', label: 'Bevel' }]} />
          <label className="flex items-center gap-1.5 text-xs text-fg2">Dash
            <input className="w-24 h-7 rounded bg-input border border-line text-[12px] px-1.5" placeholder="e.g. 6 4" defaultValue={(st.dash || []).join(' ')} key={(st.dash || []).join(' ')}
              onBlur={(e) => set({ dash: e.target.value.split(/[\s,]+/).map(Number).filter((x) => x > 0) }, true)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </label>
        </div>
      )}
    </div>
  );
}

function EffectsEditor({ value = [], onChange, onCommit }) {
  const sh = value.find((e) => e.type === 'shadow');
  const bl = value.find((e) => e.type === 'blur');
  const put = (type, e, commit) => { const v = [...value.filter((x) => x.type !== type), ...(e ? [e] : [])]; onChange(v); if (commit) onCommit?.(v); };
  return (
    <div className="flex flex-col gap-2">
      <Toggle checked={!!sh && sh.on !== false} label="Drop shadow" onChange={(on) => put('shadow', on ? { type: 'shadow', x: 0, y: 6, blur: 14, color: '#00000059', ...(sh || {}), on: true } : sh ? { ...sh, on: false } : null, true)} />
      {sh && sh.on !== false && (
        <div className="flex items-center gap-1.5 flex-wrap pl-1">
          <ColorSwatch value={sh.color} size={22} onChange={(c) => put('shadow', { ...sh, color: c })} onCommit={(c) => put('shadow', { ...sh, color: c }, true)} />
          <NumberInput label="X" value={sh.x} width={40} onChange={(v) => put('shadow', { ...sh, x: v })} onCommit={(v) => put('shadow', { ...sh, x: v }, true)} />
          <NumberInput label="Y" value={sh.y} width={40} onChange={(v) => put('shadow', { ...sh, y: v })} onCommit={(v) => put('shadow', { ...sh, y: v }, true)} />
          <NumberInput label="Blur" value={sh.blur} min={0} width={40} onChange={(v) => put('shadow', { ...sh, blur: v })} onCommit={(v) => put('shadow', { ...sh, blur: v }, true)} />
        </div>
      )}
      <Toggle checked={!!bl && bl.on !== false} label="Blur" onChange={(on) => put('blur', on ? { type: 'blur', radius: 6, ...(bl || {}), on: true } : bl ? { ...bl, on: false } : null, true)} />
      {bl && bl.on !== false && <Slider label="Radius" value={bl.radius} min={0} max={100} unit="px" onChange={(v) => put('blur', { ...bl, radius: v })} onCommit={(v) => put('blur', { ...bl, radius: v }, true)} />}
    </div>
  );
}

// ---------------------------------------------------------------- properties

/** The Properties panel. extraTop/extraArtboard let apps add their own sections (prototype settings, etc.). */
export function PropertiesPanel({ ed, artboardExtra, nodeExtra, labels = {} }) {
  const n = ed.selNodes;
  const single = n.length === 1 ? n[0] : null;
  const leafs = useMemo(() => { const out = []; walk(n, (x) => { if (x.type !== 'group') out.push(x); }); return out; }, [n]);
  const styleSrc = leafs.find((x) => x.type !== 'image') || single;
  const key = ed.sel.join();
  const ch = (patch, label, commit) => { ed.setProps(patch, label, { merge: `${label}-${key}` }); if (commit) ed.h.commit(); };
  const ro = ed.readOnly;
  if (!ed.doc) return null;
  if (!n.length) {
    const ab = artboardsOf(ed.doc).find((a) => a.id === ed.activeAb);
    if (ed.scope) {
      const sym = ed.doc.symbols.find((s) => s.id === ed.scope);
      return (
        <PanelSection title={labels.symbol || 'Symbol'} id="v-sym">
          <div className="text-sm mb-2">Editing <b>{sym?.name}</b></div>
          <p className="text-xs text-fg2 mb-3">Changes update every instance. Double-click outside the artwork or press Esc to finish.</p>
          <Button size="sm" variant="primary" icon="check" onClick={ed.exitSymbol}>Done</Button>
        </PanelSection>
      );
    }
    return ab ? <ArtboardProps ed={ed} ab={ab} extra={artboardExtra} label={labels.artboard || 'Artboard'} /> : null;
  }
  const b = ed.selBounds || { x: 0, y: 0, w: 0, h: 0 };
  const rot = single && single.t && !['path', 'group'].includes(single.type) ? r2(decompose(single.t).rotation) : 0;
  const setBox = (k, v, commit) => {
    if (ro) return;
    let M;
    if (k === 'x') M = translate(v - b.x, 0);
    else if (k === 'y') M = translate(0, v - b.y);
    else if (k === 'w') { const s = Math.max(0.01, v) / (b.w || 1); M = scale(s, ed.opts.lockRatio ? s : 1, b.x, b.y); }
    else if (k === 'h') { const s = Math.max(0.01, v) / (b.h || 1); M = scale(ed.opts.lockRatio ? s : 1, s, b.x, b.y); }
    else if (k === 'r') M = rotate(v - rot, b.x + b.w / 2, b.y + b.h / 2);
    ed.transformSel(M, 'Transform', { merge: `box-${k}-${key}` });
    if (commit) ed.h.commit();
  };
  return (
    <>
      <PanelSection title="Transform" id="v-transform">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <NumberInput label="X" value={r2(b.x)} width={70} onChange={(v) => setBox('x', v)} onCommit={(v) => setBox('x', v, true)} disabled={ro} />
          <NumberInput label="Y" value={r2(b.y)} width={70} onChange={(v) => setBox('y', v)} onCommit={(v) => setBox('y', v, true)} disabled={ro} />
          <NumberInput label="W" value={r2(b.w)} width={70} min={0} onChange={(v) => setBox('w', v)} onCommit={(v) => setBox('w', v, true)} disabled={ro} />
          <NumberInput label="H" value={r2(b.h)} width={70} min={0} onChange={(v) => setBox('h', v)} onCommit={(v) => setBox('h', v, true)} disabled={ro} />
          <NumberInput label="∠" value={rot} unit="°" width={70} onChange={(v) => setBox('r', v)} onCommit={(v) => setBox('r', v, true)} disabled={ro} />
          <div className="flex items-center gap-0.5">
            <IconButton icon="link2" label="Constrain proportions" size={26} active={!!ed.opts.lockRatio} onClick={() => ed.setOpts((o) => ({ ...o, lockRatio: !o.lockRatio }))} />
            <IconButton icon="flipH" label="Flip horizontal" size={26} onClick={() => ed.reflectSel('h')} disabled={ro} />
            <IconButton icon="flipV" label="Flip vertical" size={26} onClick={() => ed.reflectSel('v')} disabled={ro} />
          </div>
        </div>
      </PanelSection>
      {single?.type === 'rect' && (
        <PanelSection title="Rectangle" id="v-rect">
          <NumberInput label="Corner radius" value={single.r || 0} min={0} unit="px" width={70} onChange={(v) => ch({ r: v }, 'Corner Radius')} onCommit={(v) => ch({ r: v }, 'Corner Radius', true)} disabled={ro} />
        </PanelSection>
      )}
      {single?.type === 'polygon' && <PanelSection title="Polygon" id="v-poly"><NumberInput label="Sides" value={single.sides} min={3} max={60} width={60} onChange={(v) => ch({ sides: v }, 'Sides')} onCommit={(v) => ch({ sides: v }, 'Sides', true)} disabled={ro} /></PanelSection>}
      {single?.type === 'star' && (
        <PanelSection title="Star" id="v-star">
          <div className="flex gap-3">
            <NumberInput label="Points" value={single.points} min={3} max={60} width={50} onChange={(v) => ch({ points: v }, 'Points')} onCommit={(v) => ch({ points: v }, 'Points', true)} disabled={ro} />
            <NumberInput label="Inner" value={Math.round(single.inner * 100)} min={5} max={100} unit="%" width={56} onChange={(v) => ch({ inner: v / 100 }, 'Inner Radius')} onCommit={(v) => ch({ inner: v / 100 }, 'Inner Radius', true)} disabled={ro} />
          </div>
        </PanelSection>
      )}
      {leafs.some((x) => x.type === 'text') && <TextProps ed={ed} texts={leafs.filter((x) => x.type === 'text')} ro={ro} />}
      {single?.type === 'image' && (
        <PanelSection title="Image" id="v-image">
          <div className="flex items-center gap-2">
            <Button size="sm" icon="image" disabled={ro} onClick={async () => { const [a] = (await pickAssets({ kinds: ['image'], multiple: false, docId: ed.project.doc?.id, title: 'Replace image' })) || []; if (a) ch({ asset: a.id, name: a.name }, 'Replace Image', true); }}>Replace…</Button>
            <Select small value={single.fit === 'stretch' ? 'stretch' : 'fill'} onChange={(v) => ch({ fit: v }, 'Image Fit', true)} options={[{ value: 'fill', label: 'Fill (crop)' }, { value: 'stretch', label: 'Stretch' }]} />
          </div>
        </PanelSection>
      )}
      {single?.type === 'instance' && <InstanceProps ed={ed} inst={single} ro={ro} label={labels.symbol || 'Symbol'} />}
      {single?.type === 'repeat' && (
        <PanelSection title="Repeat grid" id="v-repeat">
          <div className="grid grid-cols-2 gap-1.5">
            <NumberInput label="Columns" value={single.cols} min={1} max={50} width={44} onChange={(v) => ch({ cols: v }, 'Repeat Grid')} onCommit={(v) => ch({ cols: v }, 'Repeat Grid', true)} disabled={ro} />
            <NumberInput label="Rows" value={single.rows} min={1} max={50} width={44} onChange={(v) => ch({ rows: v }, 'Repeat Grid')} onCommit={(v) => ch({ rows: v }, 'Repeat Grid', true)} disabled={ro} />
            <NumberInput label="Gap X" value={single.gx} width={44} onChange={(v) => ch({ gx: v }, 'Repeat Grid')} onCommit={(v) => ch({ gx: v }, 'Repeat Grid', true)} disabled={ro} />
            <NumberInput label="Gap Y" value={single.gy} width={44} onChange={(v) => ch({ gy: v }, 'Repeat Grid')} onCommit={(v) => ch({ gy: v }, 'Repeat Grid', true)} disabled={ro} />
          </div>
        </PanelSection>
      )}
      {nodeExtra?.(single, n)}
      {styleSrc && styleSrc.type !== 'instance' && styleSrc.type !== 'repeat' && (
        <PanelSection title="Appearance" id="v-appearance">
          <div className="text-[11px] uppercase tracking-wider text-fg3 mb-1">Fill</div>
          {styleSrc.type === 'image' ? <p className="text-xs text-fg3 mb-2">Images keep their pixels.</p> : (
            <div className={cx('mb-3', ro && 'pointer-events-none opacity-60')}><FillEditor value={styleSrc.fill} onChange={(f) => ch({ fill: f }, 'Fill')} onCommit={(f) => ch({ fill: f }, 'Fill', true)} /></div>
          )}
          <div className="text-[11px] uppercase tracking-wider text-fg3 mb-1">Stroke</div>
          <div className={cx('mb-3', ro && 'pointer-events-none opacity-60')}><StrokeEditor value={styleSrc.stroke} onChange={(s) => ch({ stroke: s }, 'Stroke')} onCommit={(s) => ch({ stroke: s }, 'Stroke', true)} /></div>
          {styleSrc.type === 'path' && styleSrc.subpaths.length > 1 && <div className="mb-2"><Segmented value={styleSrc.fillRule || 'nonzero'} onChange={(v) => ch({ fillRule: v }, 'Fill Rule', true)} options={[{ value: 'nonzero', label: 'Non-zero' }, { value: 'evenodd', label: 'Even-odd' }]} /></div>}
        </PanelSection>
      )}
      <PanelSection title="Layer" id="v-layer">
        <div className={cx('flex flex-col gap-2', ro && 'pointer-events-none opacity-60')}>
          <Slider label="Opacity" value={Math.round((single?.opacity ?? n[0].opacity ?? 1) * 100)} min={0} max={100} unit="%" onChange={(v) => ed.setProps({ opacity: v / 100 }, 'Opacity', { merge: `op-${key}` })} onCommit={() => ed.h.commit()} />
          <div className="flex items-center gap-2"><span className="text-xs text-fg2 w-16">Blend</span><Select small value={single?.blend || n[0].blend || 'normal'} onChange={(v) => ed.setProps({ blend: v }, 'Blend Mode')} options={BLENDS.map((x) => ({ value: x, label: x.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) }))} /></div>
          <div className="text-[11px] uppercase tracking-wider text-fg3 mt-1">Effects</div>
          <EffectsEditor value={single?.effects || n[0].effects || []} onChange={(v) => ed.setProps({ effects: v }, 'Effects', { merge: `fx-${key}` })} onCommit={() => ed.h.commit()} />
        </div>
      </PanelSection>
    </>
  );
}

function TextProps({ ed, texts, ro }) {
  const t = texts[0];
  const f = fontOf(t);
  const ids = texts.map((x) => x.id);
  const setFont = (patch, label, commit) => {
    ed.change((r) => { let nr = r; for (const id of ids) nr = updateIn(nr, id, (x) => ({ ...x, font: { ...fontOf(x), ...patch } })); return nr; }, label, { merge: `font-${label}-${ids.join()}` });
    if (commit) ed.h.commit();
    ed.setStyle((s) => ({ ...s, font: { ...(s.font || {}), ...patch } }));
  };
  return (
    <>
      <PanelSection title="Character" id="v-char">
        <div className={cx('flex flex-col gap-2', ro && 'pointer-events-none opacity-60')}>
          <FontPicker value={f.family} weight={f.weight} onChange={(v) => setFont({ family: v }, 'Font', true)} width={230} />
          <div className="flex items-center gap-2">
            <WeightPicker family={f.family} value={f.weight} onChange={(v) => setFont({ weight: v }, 'Font Weight', true)} className="flex-1" />
            <IconButton icon="italic" label="Italic" size={26} active={f.style === 'italic'} onClick={() => setFont({ style: f.style === 'italic' ? 'normal' : 'italic' }, 'Italic', true)} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <NumberInput label="Size" value={f.size} min={1} max={2000} unit="px" width={62} onChange={(v) => setFont({ size: v }, 'Font Size')} onCommit={(v) => setFont({ size: v }, 'Font Size', true)} />
            <NumberInput label="Lead" value={f.leading || Math.round(f.size * 1.2)} min={0} unit="px" width={62} onChange={(v) => setFont({ leading: v }, 'Leading')} onCommit={(v) => setFont({ leading: v }, 'Leading', true)} />
            <NumberInput label="Track" value={f.tracking} min={-500} max={2000} step={5} width={62} onChange={(v) => setFont({ tracking: v }, 'Tracking')} onCommit={(v) => setFont({ tracking: v }, 'Tracking', true)} title="Tracking (1/1000 em)" />
          </div>
        </div>
      </PanelSection>
      <PanelSection title="Paragraph" id="v-para">
        <div className={cx('flex flex-col gap-2', ro && 'pointer-events-none opacity-60')}>
          <Segmented value={f.align} onChange={(v) => setFont({ align: v }, 'Align Text', true)} options={[{ value: 'left', icon: 'alignLeft', title: 'Left' }, { value: 'center', icon: 'alignCenterH', title: 'Centre' }, { value: 'right', icon: 'alignRight', title: 'Right' }]} />
          {texts.length === 1 && t.mode !== 'path' && (
            <Segmented value={t.mode} onChange={(v) => ed.updateNode(t.id, (x) => (v === 'area' ? { ...x, mode: 'area', w: Math.max(40, ed.bounds(x).w + 4), h: ed.bounds(x).h } : { ...x, mode: 'point' }), 'Text Type')}
              options={[{ value: 'point', label: 'Point text' }, { value: 'area', label: 'Area text' }]} />
          )}
          {texts.length === 1 && t.mode === 'path' && <Slider label="Start on path" value={t.startOffset || 0} min={0} max={100} unit="%" onChange={(v) => ed.updateNode(t.id, { startOffset: v }, 'Path Text', { merge: `po-${t.id}` })} onCommit={() => ed.h.commit()} />}
        </div>
      </PanelSection>
    </>
  );
}

function InstanceProps({ ed, inst, ro, label }) {
  const sym = ed.doc.symbols.find((s) => s.id === inst.symbol);
  const editable = [];
  walk(sym?.children || [], (x) => { if (x.type === 'text' || ((x.type !== 'group') && x.name)) editable.push(x); });
  const setOv = (id, patch, commit) => { ed.updateNode(inst.id, (n) => ({ ...n, overrides: { ...(n.overrides || {}), [id]: { ...(n.overrides?.[id] || {}), ...patch } } }), 'Override', { merge: `ov-${inst.id}-${id}` }); if (commit) ed.h.commit(); };
  return (
    <PanelSection title={label} id="v-inst">
      <div className="text-sm mb-2 flex items-center gap-2"><VIcon name="instance" size={15} className="text-accent" />{sym?.name || 'Missing'}</div>
      <div className="flex gap-2 mb-3">
        <Button size="sm" icon="edit" onClick={() => ed.editSymbol(inst.symbol)} disabled={ro}>Edit {label.toLowerCase()}</Button>
        <Button size="sm" variant="ghost" onClick={ed.detachInstance} disabled={ro}>Detach</Button>
      </div>
      {editable.length > 0 && <div className="text-[11px] uppercase tracking-wider text-fg3 mb-1">Overrides</div>}
      {editable.slice(0, 12).map((x) => (
        <div key={x.id} className="flex items-center gap-2 mb-1.5">
          {x.type === 'text'
            ? <TextInput value={inst.overrides?.[x.id]?.text ?? x.text} disabled={ro} onChange={(e) => setOv(x.id, { text: e.target.value })} onBlur={() => ed.h.commit()} className="!h-7 text-[13px]" />
            : <><ColorSwatch value={(inst.overrides?.[x.id]?.fill ?? x.fill)?.color || null} size={22} onChange={(c) => setOv(x.id, { fill: solid(c) })} onCommit={(c) => setOv(x.id, { fill: solid(c) }, true)} /><span className="text-xs text-fg2 truncate flex-1">{x.name}</span></>}
          {inst.overrides?.[x.id] && <IconButton icon="refresh" size={22} label="Reset override" onClick={() => ed.updateNode(inst.id, (n) => { const o = { ...(n.overrides || {}) }; delete o[x.id]; return { ...n, overrides: o }; }, 'Reset Override')} />}
        </div>
      ))}
    </PanelSection>
  );
}

function ArtboardProps({ ed, ab, extra, label }) {
  const ro = ed.readOnly;
  const set = (patch, l, commit) => { ed.updateArtboard(ab.id, patch, l, { merge: `ab-${l}-${ab.id}` }); if (commit) ed.h.commit(); };
  return (
    <>
      <PanelSection title={label} id="v-artboard">
        <div className={cx('flex flex-col gap-2', ro && 'pointer-events-none opacity-60')}>
          <TextInput value={ab.name} onChange={(e) => set({ name: e.target.value }, 'Rename')} onBlur={() => ed.h.commit()} className="!h-7 text-[13px]" />
          <div className="grid grid-cols-2 gap-1.5">
            <NumberInput label="X" value={ab.x} width={64} onChange={(v) => set({ x: v }, 'Move Artboard')} onCommit={(v) => set({ x: v }, 'Move Artboard', true)} />
            <NumberInput label="Y" value={ab.y} width={64} onChange={(v) => set({ y: v }, 'Move Artboard')} onCommit={(v) => set({ y: v }, 'Move Artboard', true)} />
            <NumberInput label="W" value={ab.w} min={1} width={64} onChange={(v) => set({ w: v }, 'Resize Artboard')} onCommit={(v) => set({ w: v }, 'Resize Artboard', true)} />
            <NumberInput label="H" value={ab.h} min={1} width={64} onChange={(v) => set({ h: v }, 'Resize Artboard')} onCommit={(v) => set({ h: v }, 'Resize Artboard', true)} />
          </div>
          <div className="flex items-center gap-2"><span className="text-xs text-fg2 w-20">Background</span><ColorSwatch value={ab.bg} none onChange={(c) => set({ bg: c }, 'Background')} onCommit={(c) => set({ bg: c }, 'Background', true)} /></div>
          <div className="flex gap-2 mt-1">
            <Button size="xs" variant="ghost" icon="duplicate" onClick={() => ed.duplicateArtboard(ab.id)}>Duplicate</Button>
            <Button size="xs" variant="ghost" icon="trash" onClick={() => ed.deleteArtboard(ab.id)}>Delete</Button>
          </div>
        </div>
      </PanelSection>
      {extra?.(ab)}
    </>
  );
}

// ---------------------------------------------------------------- layers

const TYPE_ICON = { artboard: 'artboard', group: 'group', path: 'pen', rect: 'rect', ellipse: 'ellipse', polygon: 'polygon', star: 'starShape', text: 'text', image: 'image', instance: 'component', repeat: 'grid' };
export const nodeLabel = (n) => n.name || (n.type === 'text' ? (n.text || 'Text').slice(0, 30) : n.type === 'group' && n.clip ? 'Clip group' : { path: 'Path', rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', image: 'Image', group: 'Group', instance: 'Instance', repeat: 'Repeat grid' }[n.type] || n.type);

export function LayersPanel({ ed }) {
  const [open, setOpen] = useState({});
  const [dragId, setDragId] = useState(null);
  const [drop, setDrop] = useState(null); // { id, pos: 'above' | 'below' | 'inside' }
  const [rename, setRename] = useState(null);
  if (!ed.doc) return null;
  const root = ed.root;
  const selSet = new Set(ed.sel);
  const isOpen = (n) => open[n.id] ?? (n.type === 'artboard');

  const moveTo = (ids, target, pos) => {
    if (ids.includes(target.id)) return;
    const r = ed.root;
    const tf = find(r, target.id);
    if (!tf) return;
    // No dropping a group into itself.
    for (const id of ids) { const f = find(r, id); if (f && [...tf.chain, tf.node].some((c) => c.id === id)) return; }
    const moving = ids.map((id) => findNode(r, id)).filter(Boolean);
    if (moving.some((m) => m.type === 'artboard') && (pos === 'inside' || tf.parent)) return;
    if (pos !== 'inside' && tf.node.type === 'artboard' && moving.some((m) => m.type !== 'artboard')) pos = 'inside';
    ed.change((rr) => {
      let nr = removeIds(rr, ids);
      if (pos === 'inside') return insertInto(nr, target.id, moving);
      const f = find(nr, target.id);
      const idx = f.index + (pos === 'above' ? 1 : 0); // "above" in the list = later in paint order
      return insertInto(nr, f.parent?.id || null, moving, idx);
    }, 'Reorder');
  };

  const rows = [];
  const visit = (list, depth) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      rows.push({ n, depth });
      if (n.children && isOpen(n)) visit(n.children, depth + 1);
    }
  };
  visit(root, 0);

  return (
    <div className="text-[13px] select-none" onDragEnd={() => { setDragId(null); setDrop(null); }}>
      {rows.map(({ n, depth }) => {
        const sel = selSet.has(n.id) || (n.type === 'artboard' && ed.activeAb === n.id && !ed.sel.length);
        const container = n.children && n.type !== 'artboard' ? true : n.type === 'artboard';
        return (
          <div key={n.id} draggable={!ed.readOnly && rename !== n.id}
            onDragStart={(e) => { const ids = selSet.has(n.id) ? ed.sel : [n.id]; setDragId(ids); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', n.id); }}
            onDragOver={(e) => { if (!dragId) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); const y = (e.clientY - r.top) / r.height; setDrop({ id: n.id, pos: container && y > 0.25 && y < 0.75 ? 'inside' : y < 0.5 ? 'above' : 'below' }); }}
            onDrop={(e) => { e.preventDefault(); if (dragId && drop) moveTo(dragId, n, drop.pos); setDragId(null); setDrop(null); }}
            onClick={(e) => {
              if (n.type === 'artboard') { ed.setActiveAb(n.id); if (!e.shiftKey) ed.setSel([]); return; }
              const ids = e.shiftKey || e.metaKey || e.ctrlKey ? (selSet.has(n.id) ? ed.sel.filter((x) => x !== n.id) : [...ed.sel, n.id]) : [n.id];
              ed.setSel(ids);
            }}
            onDoubleClick={() => !ed.readOnly && setRename(n.id)}
            className={cx('relative flex items-center h-7 pr-1 gap-1 cursor-default border-y border-transparent', sel ? 'bg-active' : 'hover:bg-hover',
              drop?.id === n.id && drop.pos === 'inside' && 'outline outline-1 outline-accent -outline-offset-1')}
            style={{ paddingLeft: 4 + depth * 14 }}>
            {drop?.id === n.id && drop.pos !== 'inside' && <span className={cx('absolute left-0 right-0 h-0.5 bg-accent', drop.pos === 'above' ? 'top-0' : 'bottom-0')} />}
            {n.children ? <button type="button" className="w-4 text-fg3 hover:text-fg" onClick={(e) => { e.stopPropagation(); setOpen((o) => ({ ...o, [n.id]: !isOpen(n) })); }}><Icon name={isOpen(n) ? 'chevronDown' : 'chevronRight'} size={12} /></button> : <span className="w-4" />}
            <Icon name={n.type === 'group' && n.clip ? 'mask' : TYPE_ICON[n.type] || 'square'} size={14} className={n.type === 'instance' ? 'text-accent' : 'text-fg2'} />
            {rename === n.id
              ? <input autoFocus defaultValue={n.name || nodeLabel(n)} className="flex-1 min-w-0 h-6 bg-input border border-accent rounded px-1 text-[13px]"
                onBlur={(e) => { const v = e.target.value.trim(); setRename(null); if (n.type === 'artboard') ed.updateArtboard(n.id, { name: v || n.name }, 'Rename'); else ed.updateNode(n.id, { name: v }, 'Rename'); }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRename(null); e.stopPropagation(); }} onClick={(e) => e.stopPropagation()} />
              : <span className={cx('flex-1 truncate', n.hidden && 'text-fg3', n.type === 'artboard' && 'font-medium')}>{nodeLabel(n)}</span>}
            {n.type !== 'artboard' && !ed.readOnly && (
              <>
                <IconButton icon={n.locked ? 'lock' : 'unlock'} label={n.locked ? 'Unlock' : 'Lock'} size={22} iconSize={13} className={n.locked ? '' : 'opacity-0 hover:opacity-100'} onClick={(e) => { e.stopPropagation(); ed.setFlag('locked', !n.locked, [n.id]); }} />
                <IconButton icon={n.hidden ? 'eyeOff' : 'eye'} label={n.hidden ? 'Show' : 'Hide'} size={22} iconSize={13} className={n.hidden ? '' : 'opacity-60'} onClick={(e) => { e.stopPropagation(); ed.setFlag('hidden', !n.hidden, [n.id]); }} />
              </>
            )}
          </div>
        );
      })}
      {!rows.length && <p className="p-3 text-xs text-fg3">Nothing here yet.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- swatches

export function SwatchesPanel({ ed }) {
  const lib = libraryColorStore.use();
  const sw = ed.doc?.swatches || [];
  const apply = (c, strokeIt) => {
    if (strokeIt) { if (ed.sel.length) ed.setProps((n) => ({ stroke: { ...(n.stroke || strokeOf(c, 1)), color: c } }), 'Stroke'); ed.setStyle((s) => ({ ...s, stroke: { ...(s.stroke || strokeOf(c, 1)), color: c } })); }
    else { if (ed.sel.length) ed.setProps({ fill: solid(c) }, 'Fill'); ed.setStyle((s) => ({ ...s, fill: solid(c) })); }
  };
  const current = ed.selNodes[0]?.fill?.color || ed.style.fill?.color;
  const Grid = ({ colors, removable }) => (
    <div className="flex flex-wrap gap-1">
      {colors.map((c, i) => (
        <button key={`${c}${i}`} type="button" title={`${c} — click: fill · Shift+click: stroke${removable ? ' · Alt+click: remove' : ''}`}
          onClick={(e) => { if (removable && e.altKey && !ed.readOnly) ed.changeDoc((d) => ({ ...d, swatches: d.swatches.filter((_, j) => j !== i) }), 'Delete Swatch'); else apply(c, e.shiftKey); }}
          className="w-5 h-5 rounded-sm checker overflow-hidden border border-line hover:scale-110 transition"><span className="block w-full h-full" style={{ background: c }} /></button>
      ))}
      {removable && !ed.readOnly && current && <IconButton icon="plus" label="Add the current fill as a swatch" size={20} iconSize={13} onClick={() => ed.changeDoc((d) => ({ ...d, swatches: [...d.swatches, current] }), 'New Swatch')} />}
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <Grid colors={sw} removable />
      {lib.length > 0 && <><div className="text-[11px] uppercase tracking-wider text-fg3 mt-1">Libraries</div><Grid colors={lib} /></>}
    </div>
  );
}

// ---------------------------------------------------------------- align / pathfinder

export function AlignPanel({ ed }) {
  const [to, setTo] = useState('auto');
  const dis = !ed.sel.length || ed.readOnly;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-0.5 flex-wrap">
        {[['left', 'alignLeft', 'Align left'], ['hcenter', 'alignCenterH', 'Align horizontal centres'], ['right', 'alignRight', 'Align right'], ['top', 'alignTop', 'Align top'], ['vcenter', 'alignMiddle', 'Align vertical centres'], ['bottom', 'alignBottom', 'Align bottom']].map(([k, ic, l]) => (
          <IconButton key={k} icon={ic} label={l} size={28} disabled={dis} onClick={() => ed.align(k, to)} />
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        <IconButton icon="distributeH" label="Distribute horizontal centres" size={28} disabled={ed.sel.length < 3 || ed.readOnly} onClick={() => ed.distribute('h')} />
        <IconButton icon="distributeV" label="Distribute vertical centres" size={28} disabled={ed.sel.length < 3 || ed.readOnly} onClick={() => ed.distribute('v')} />
        <IconButton label="Distribute horizontal spacing" size={28} disabled={ed.sel.length < 3 || ed.readOnly} onClick={() => ed.distribute('hspace')}><VIcon name="spaceH" size={16} /></IconButton>
        <IconButton label="Distribute vertical spacing" size={28} disabled={ed.sel.length < 3 || ed.readOnly} onClick={() => ed.distribute('vspace')}><VIcon name="spaceV" size={16} /></IconButton>
        <span className="flex-1" />
        <Select small value={to} onChange={setTo} options={[{ value: 'auto', label: 'Auto' }, { value: 'selection', label: 'To selection' }, { value: 'artboard', label: 'To artboard' }]} />
      </div>
    </div>
  );
}

export function PathfinderPanel({ ed }) {
  const dis = ed.sel.length < 2 || ed.readOnly;
  return (
    <div className="flex items-center gap-1">
      {[['unite', 'Unite'], ['subtract', 'Minus Front'], ['intersect', 'Intersect'], ['exclude', 'Exclude'], ['divide', 'Divide']].map(([op, l]) => (
        <IconButton key={op} label={l} size={32} disabled={dis} onClick={() => ed.doPathfinder(op)}><VIcon name={op === 'subtract' ? 'minusFront' : op} size={20} /></IconButton>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- symbols

export function SymbolPreview({ doc, sym, size = 64 }) {
  const html = useMemo(() => {
    const b = unionRects(sym.children.map((c) => bounds(c, doc))) || { x: 0, y: 0, w: 1, h: 1 };
    const ctx = renderContext(doc, { prefix: `sp-${sym.id}-` });
    const pad = Math.max(b.w, b.h) * 0.06;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}" width="${size}" height="${size}">${sym.children.map((c) => renderNode(c, ctx)).join('')}</svg>`;
  }, [doc, sym, size]);
  // eslint-disable-next-line react/no-danger
  return <span className="block" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function SymbolsPanel({ ed, label = 'Symbol' }) {
  const syms = ed.doc?.symbols || [];
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-1.5">
        {syms.map((s) => (
          <button key={s.id} type="button" draggable onDragStart={(e) => e.dataTransfer.setData('application/x-sora-symbol', s.id)}
            title={`${s.name} — double-click to place, right-click for more`}
            onDoubleClick={() => !ed.readOnly && ed.placeSymbol(s.id)}
            onContextMenu={(e) => openMenu(e, [
              { label: 'Place instance', icon: 'plus', onClick: () => ed.placeSymbol(s.id), disabled: ed.readOnly },
              { label: `Edit ${label.toLowerCase()}`, icon: 'edit', onClick: () => ed.editSymbol(s.id), disabled: ed.readOnly },
              { label: 'Rename…', icon: 'edit', disabled: ed.readOnly, onClick: async () => { const v = await promptDialog({ title: `Rename ${label.toLowerCase()}`, label: 'Name', value: s.name }); if (v) ed.changeDoc((d) => ({ ...d, symbols: d.symbols.map((x) => (x.id === s.id ? { ...x, name: v } : x)) }), 'Rename'); } },
              { divider: true },
              { label: 'Delete', icon: 'trash', danger: true, disabled: ed.readOnly, onClick: () => ed.deleteSymbol(s.id) },
            ])}
            className="rounded-md bg-panel-2 hover:bg-hover p-1.5 flex flex-col items-center gap-1 border border-line">
            <span className="checker rounded overflow-hidden"><SymbolPreview doc={ed.doc} sym={s} size={56} /></span>
            <span className="text-[11px] truncate w-full text-center">{s.name}</span>
          </button>
        ))}
      </div>
      {!syms.length && <p className="text-xs text-fg3">Select artwork and click New to make a reusable {label.toLowerCase()}. Edit the master and every instance updates.</p>}
      <div className="flex gap-1.5">
        <Button size="xs" icon="plus" disabled={!ed.sel.length || ed.readOnly || !!ed.scope} onClick={async () => { const v = await promptDialog({ title: `New ${label.toLowerCase()}`, label: 'Name', value: `${label} ${syms.length + 1}` }); if (v) ed.makeSymbol(v); }}>New</Button>
        {ed.scope && <Button size="xs" variant="primary" icon="check" onClick={ed.exitSymbol}>Done editing</Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- artboards list

export function ArtboardsPanel({ ed, label = 'Artboard' }) {
  const abs = ed.doc ? artboardsOf(ed.doc) : [];
  return (
    <div className="flex flex-col">
      {abs.map((a, i) => (
        <div key={a.id} onClick={() => { ed.setActiveAb(a.id); ed.setSel([]); ed.viewportRef.current?.fitRect({ x: a.x, y: a.y, w: a.w, h: a.h }); }}
          className={cx('flex items-center gap-2 h-7 px-1 rounded text-[13px] cursor-default', a.id === ed.activeAb ? 'bg-active' : 'hover:bg-hover')}>
          <span className="text-fg3 w-4 text-right text-[11px]">{i + 1}</span>
          <span className="flex-1 truncate">{a.name}</span>
          <span className="text-[11px] text-fg3">{a.w}×{a.h}</span>
        </div>
      ))}
      {!ed.readOnly && <Button size="xs" variant="ghost" icon="plus" className="mt-1 self-start" onClick={() => ed.addArtboard()}>New {label.toLowerCase()}</Button>}
    </div>
  );
}

export { keyLabel, boundsOf, transformNode, isIdentity, useRef, useFonts };
