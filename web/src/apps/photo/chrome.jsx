// Photo's tool strip (left) and contextual options bar (top).
import { useRef, useState } from 'react';
import { Select, Slider, Segmented, Toggle, Checkbox, NumberInput, Button, ColorSwatch, ColorPicker, Popover, openMenu, cx } from '../../components/ui.jsx';
import { FontPicker, WeightPicker } from '../../components/Pickers.jsx';
import { keyLabel } from '../../lib/shortcuts.js';
import { Icon, IBtn } from '../_raster/icons.jsx';
import { BLEND_MODES } from '../_raster/model.js';
import { FgBg } from './panels.jsx';

// Tool groups as in Photoshop: each slot shows its current variant; right-click (or long-press) for the others.
export const TOOL_SLOTS = [
  { id: 'move', label: 'Move', icon: 'move', key: 'v' },
  { id: 'marquee', label: 'Marquee', key: 'm', variants: [{ opt: ['marquee', 'shape', 'rect'], label: 'Rectangular Marquee', icon: 'marquee' }, { opt: ['marquee', 'shape', 'ellipse'], label: 'Elliptical Marquee', icon: 'ellipseMarquee' }] },
  { id: 'lasso', label: 'Lasso', key: 'l', variants: [{ opt: ['lasso', 'kind', 'free'], label: 'Lasso', icon: 'lasso' }, { opt: ['lasso', 'kind', 'poly'], label: 'Polygonal Lasso', icon: 'polyLasso' }] },
  { id: 'wand', label: 'Magic Wand', icon: 'wand', key: 'w' },
  { id: 'crop', label: 'Crop', icon: 'crop', key: 'c' },
  { id: 'eyedropper', label: 'Eyedropper', icon: 'eyedropper', key: 'i' },
  { divider: true },
  { id: 'heal', label: 'Spot Healing Brush', icon: 'heal', key: 'j' },
  { id: 'brush', label: 'Brush', key: 'b', variants: [{ tool: 'brush', label: 'Brush', icon: 'brush' }, { tool: 'pencil', label: 'Pencil', icon: 'pencil' }] },
  { id: 'clone', label: 'Clone Stamp', icon: 'stamp', key: 's' },
  { id: 'eraser', label: 'Eraser', icon: 'eraser', key: 'e' },
  { id: 'gradient', label: 'Gradient', key: 'g', variants: [{ tool: 'gradient', label: 'Gradient', icon: 'gradient' }, { tool: 'bucket', label: 'Paint Bucket', icon: 'fill' }] },
  { id: 'blur', label: 'Blur', key: 'r', variants: [{ opt: ['blur', 'mode', 'blur'], label: 'Blur', icon: 'blur' }, { opt: ['blur', 'mode', 'sharpen'], label: 'Sharpen', icon: 'sharpen' }, { opt: ['blur', 'mode', 'smudge'], label: 'Smudge', icon: 'smudge' }] },
  { id: 'dodge', label: 'Dodge', key: 'o', variants: [{ opt: ['dodge', 'mode', 'dodge'], label: 'Dodge', icon: 'dodge' }, { opt: ['dodge', 'mode', 'burn'], label: 'Burn', icon: 'burn' }] },
  { divider: true },
  { id: 'text', label: 'Type', icon: 'text', key: 't' },
  { id: 'shape', label: 'Shape', key: 'u', variants: [{ opt: ['shape', 'shape', 'rect'], label: 'Rectangle', icon: 'rect' }, { opt: ['shape', 'shape', 'ellipse'], label: 'Ellipse', icon: 'ellipse' }, { opt: ['shape', 'shape', 'polygon'], label: 'Polygon', icon: 'polygon' }, { opt: ['shape', 'shape', 'line'], label: 'Line', icon: 'line' }] },
  { divider: true },
  { id: 'hand', label: 'Hand', icon: 'hand', key: 'h' },
  { id: 'zoom', label: 'Zoom', icon: 'zoom', key: 'z' },
];

/** The variant currently shown in a slot. */
export function slotVariant(slot, tool, opts) {
  if (!slot.variants) return { icon: slot.icon, label: slot.label, tool: slot.id };
  for (const v of slot.variants) {
    if (v.tool && v.tool === tool) return { ...v };
    if (v.opt && slot.id === tool && opts[v.opt[0]]?.[v.opt[1]] === v.opt[2]) return { ...v, tool: slot.id };
  }
  const v = slot.variants.find((x) => x.tool && x.tool === slot.lastTool) || slot.variants[0];
  return { ...v, tool: v.tool || slot.id };
}

export function ToolStrip({ tool, opts, setTool, setOpt, fg, bg, setFg, setBg, onPickColor }) {
  const [picking, setPicking] = useState(null); // 'fg' | 'bg'
  const chips = useRef(null);
  return (
    <>
      {TOOL_SLOTS.map((s, i) => {
        if (s.divider) return <div key={i} className="w-6 h-px bg-line my-1 shrink-0" />;
        const v = slotVariant(s, tool, opts);
        const active = tool === s.id || s.variants?.some((x) => x.tool === tool);
        const pickVariant = (x) => { if (x.tool) setTool(x.tool); else { setOpt(x.opt[0], { [x.opt[1]]: x.opt[2] }); setTool(s.id); } };
        const menu = (e) => { e.preventDefault(); if (s.variants) openMenu(e, s.variants.map((x) => ({ label: x.label, icon: x.icon, onClick: () => pickVariant(x), checked: x.tool ? x.tool === tool : tool === s.id && opts[x.opt[0]]?.[x.opt[1]] === x.opt[2] }))); };
        let timer;
        return (
          <div key={s.id} className="relative">
            <IBtn icon={v.icon} label={v.label} shortcut={s.key ? keyLabel(s.key) : undefined} active={active} size={32} iconSize={18}
              onClick={() => setTool(v.tool || s.id)} onContextMenu={menu}
              onPointerDown={(e) => { if (s.variants) timer = setTimeout(() => menu(e), 500); }} onPointerUp={() => clearTimeout(timer)} onPointerLeave={() => clearTimeout(timer)} />
            {s.variants && <span className="absolute right-0.5 bottom-0.5 w-0 h-0 border-l-[4px] border-l-transparent border-b-[4px] border-b-fg3 pointer-events-none" />}
          </div>
        );
      })}
      <div ref={chips} className="mt-2 mb-1"><FgBg fg={fg} bg={bg} editing={null} setEditing={(w) => { onPickColor(w); setPicking(w); }} onSwap={() => { setFg(bg); setBg(fg); }} onReset={() => { setFg('#000000'); setBg('#ffffff'); }} size={20} /></div>
      {picking && (
        <Popover anchor={chips.current} side="right" onClose={() => setPicking(null)}>
          <div className="px-3 pt-2.5 text-[11px] text-fg2">{picking === 'bg' ? 'Background colour' : 'Foreground colour'}</div>
          <ColorPicker value={picking === 'bg' ? bg : fg} alpha={false} onChange={(c) => (picking === 'bg' ? setBg : setFg)(c.slice(0, 7))} />
        </Popover>
      )}
    </>
  );
}

const Sep = () => <span className="w-px h-5 bg-line mx-1 shrink-0" />;
const Lbl = ({ children }) => <span className="text-[11.5px] text-fg2 shrink-0">{children}</span>;
const Mini = ({ label, value, onChange, min = 0, max = 100, unit, width = 80 }) => (
  <span className="flex items-center gap-1.5 shrink-0">
    <Lbl>{label}</Lbl>
    <input type="range" className="sl-range" style={{ width }} min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
    <NumberInput value={value} onChange={onChange} min={min} max={max} unit={unit} width={unit ? 60 : 46} />
  </span>
);
const SelModes = ({ value, onChange }) => (
  <Segmented value={value || 'replace'} onChange={onChange} options={[
    { value: 'replace', icon: 'square', title: 'New selection' }, { value: 'add', icon: 'plus', title: 'Add to selection (Shift)' },
    { value: 'subtract', icon: 'minus', title: 'Subtract from selection (Alt)' }, { value: 'intersect', icon: 'boolean', title: 'Intersect with selection (Shift+Alt)' }]} />
);

/** Options for the active tool. o = this tool's options, set(patch). */
export function OptionsBar({ tool, o, set, transform, crop, onCropApply, onCropCancel, onTransformApply, onTransformCancel, hasSel, onSelectAndMask }) {
  if (transform) {
    const i = transform.info();
    return (
      <>
        <Icon name="transform" size={16} className="text-fg2" /><Lbl>Free Transform</Lbl><Sep />
        <NumberInput label="X" value={i.x} width={60} onChange={(v) => transform.moveTo(v, i.y)} />
        <NumberInput label="Y" value={i.y} width={60} onChange={(v) => transform.moveTo(i.x, v)} />
        <NumberInput label="W" value={Math.round(Math.abs(i.sx) * 1000) / 10} unit="%" width={64} onChange={(v) => transform.set({ sx: Math.sign(i.sx) * v / 100 })} />
        <NumberInput label="H" value={Math.round(Math.abs(i.sy) * 1000) / 10} unit="%" width={64} onChange={(v) => transform.set({ sy: Math.sign(i.sy) * v / 100 })} />
        <NumberInput label="Angle" value={Math.round(i.rot * 10) / 10} unit="°" width={64} onChange={(v) => transform.set({ rot: v })} />
        <IBtn icon="flipH" size={28} label="Flip horizontal" onClick={() => transform.flip('h')} />
        <IBtn icon="flipV" size={28} label="Flip vertical" onClick={() => transform.flip('v')} />
        <span className="flex-1" />
        <span className="text-[11px] text-fg3 mr-2">Drag handles to scale (Shift: free), outside to rotate · Enter applies</span>
        <Button size="sm" variant="ghost" icon="close" onClick={onTransformCancel}>Cancel</Button>
        <Button size="sm" variant="primary" icon="check" onClick={onTransformApply}>Apply</Button>
      </>
    );
  }
  const brushBasics = (
    <>
      <Mini label="Size" value={o.size} min={1} max={2500} unit="px" onChange={(v) => set({ size: v })} />
      {'hardness' in o && <Mini label="Hardness" value={Math.round(o.hardness * 100)} min={0} max={100} unit="%" width={56} onChange={(v) => set({ hardness: v / 100 })} />}
    </>
  );
  switch (tool) {
    case 'brush': case 'pencil': case 'eraser': case 'clone':
      return (
        <>
          {brushBasics}<Sep />
          {tool !== 'eraser' && <><Lbl>Mode</Lbl><Select small value={o.blend || 'source-over'} onChange={(v) => set({ blend: v })} options={BLEND_MODES} /></>}
          {tool === 'eraser' && <Segmented value={o.mode || 'brush'} onChange={(v) => set({ mode: v })} options={[{ value: 'brush', label: 'Brush' }, { value: 'pencil', label: 'Pencil' }]} />}
          <Mini label="Opacity" value={Math.round(o.opacity * 100)} min={1} max={100} unit="%" width={56} onChange={(v) => set({ opacity: v / 100 })} />
          {tool !== 'pencil' && <Mini label="Flow" value={Math.round(o.flow * 100)} min={1} max={100} unit="%" width={56} onChange={(v) => set({ flow: v / 100 })} />}
          {tool !== 'pencil' && <Mini label="Spacing" value={o.spacing} min={1} max={200} unit="%" width={50} onChange={(v) => set({ spacing: v })} />}
          {tool !== 'pencil' && <Mini label="Smoothing" value={o.smoothing || 0} min={0} max={100} unit="%" width={50} onChange={(v) => set({ smoothing: v })} />}
          {tool === 'brush' && <IBtn icon="airbrush" size={28} label="Airbrush build-up" active={!!o.airbrush} onClick={() => set({ airbrush: !o.airbrush })} />}
          <IBtn icon="pen" size={28} label="Pen pressure controls size" active={o.pressureSize !== false} onClick={() => set({ pressureSize: o.pressureSize === false })} />
          <IBtn icon="drop" size={28} label="Pen pressure controls opacity" active={!!o.pressureOpacity} onClick={() => set({ pressureOpacity: !o.pressureOpacity })} />
          {tool === 'clone' && <Checkbox checked={o.aligned !== false} onChange={(v) => set({ aligned: v })} label="Aligned" />}
          {tool === 'clone' && <span className="text-[11px] text-fg3">Alt+click sets the source</span>}
        </>
      );
    case 'heal': return <><Mini label="Size" value={o.size} min={1} max={1000} unit="px" onChange={(v) => set({ size: v })} /><span className="text-[11px] text-fg3">Paint over a blemish; it’s patched from similar texture nearby.</span></>;
    case 'dodge': return (
      <>
        {brushBasics}<Sep />
        <Segmented value={o.mode || 'dodge'} onChange={(v) => set({ mode: v })} options={[{ value: 'dodge', label: 'Dodge' }, { value: 'burn', label: 'Burn' }]} />
        <Lbl>Range</Lbl><Select small value={o.range} onChange={(v) => set({ range: v })} options={[{ value: 'shadows', label: 'Shadows' }, { value: 'midtones', label: 'Midtones' }, { value: 'highlights', label: 'Highlights' }]} />
        <Mini label="Exposure" value={o.exposure} min={1} max={100} unit="%" width={56} onChange={(v) => set({ exposure: v })} />
      </>
    );
    case 'blur': return (
      <>
        {brushBasics}<Sep />
        <Segmented value={o.mode || 'blur'} onChange={(v) => set({ mode: v })} options={[{ value: 'blur', label: 'Blur' }, { value: 'sharpen', label: 'Sharpen' }, { value: 'smudge', label: 'Smudge' }]} />
        <Mini label="Strength" value={o.strength} min={1} max={100} unit="%" width={56} onChange={(v) => set({ strength: v })} />
      </>
    );
    case 'marquee': return (
      <>
        <SelModes value={o.mode} onChange={(v) => set({ mode: v })} /><Sep />
        <Segmented value={o.shape} onChange={(v) => set({ shape: v })} options={[{ value: 'rect', icon: 'marquee', title: 'Rectangle' }, { value: 'ellipse', icon: 'ellipseMarquee', title: 'Ellipse' }]} />
        <NumberInput label="Feather" value={o.feather} min={0} max={500} unit="px" width={60} onChange={(v) => set({ feather: v })} />
        {hasSel && <Button size="sm" variant="ghost" onClick={onSelectAndMask}>Modify selection…</Button>}
      </>
    );
    case 'lasso': return (
      <>
        <SelModes value={o.mode} onChange={(v) => set({ mode: v })} /><Sep />
        <Segmented value={o.kind} onChange={(v) => set({ kind: v })} options={[{ value: 'free', label: 'Freehand' }, { value: 'poly', label: 'Polygonal' }]} />
        <NumberInput label="Feather" value={o.feather} min={0} max={500} unit="px" width={60} onChange={(v) => set({ feather: v })} />
        {o.kind === 'poly' && <span className="text-[11px] text-fg3">Click points; double-click, Enter or click the start to close.</span>}
      </>
    );
    case 'wand': return (
      <>
        <SelModes value={o.mode} onChange={(v) => set({ mode: v })} /><Sep />
        <NumberInput label="Tolerance" value={o.tolerance} min={0} max={255} width={56} onChange={(v) => set({ tolerance: v })} />
        <Checkbox checked={o.antiAlias} onChange={(v) => set({ antiAlias: v })} label="Anti-alias" />
        <Checkbox checked={o.contiguous} onChange={(v) => set({ contiguous: v })} label="Contiguous" />
        <Checkbox checked={o.merged} onChange={(v) => set({ merged: v })} label="Sample all layers" />
      </>
    );
    case 'crop': return (
      <>
        <Lbl>Ratio</Lbl><Select small value={o.ratio || 'free'} onChange={(v) => set({ ratio: v })} options={[{ value: 'free', label: 'Free' }, { value: '1:1', label: '1:1 (Square)' }, { value: '4:3', label: '4:3' }, { value: '3:2', label: '3:2' }, { value: '16:9', label: '16:9' }, { value: '4:5', label: '4:5' }, { value: '9:16', label: '9:16' }]} />
        <Checkbox checked={o.deletePixels !== false} onChange={(v) => set({ deletePixels: v })} label="Delete cropped pixels" />
        <span className="flex-1" />
        {crop && <><Button size="sm" variant="ghost" icon="close" onClick={onCropCancel}>Reset</Button><Button size="sm" variant="primary" icon="check" onClick={onCropApply}>Crop</Button></>}
      </>
    );
    case 'eyedropper': return (
      <>
        <Lbl>Sample size</Lbl><Select small value={String(o.size || 1)} onChange={(v) => set({ size: Number(v) })} options={[{ value: '1', label: 'Point' }, { value: '3', label: '3 × 3 average' }, { value: '5', label: '5 × 5 average' }, { value: '11', label: '11 × 11 average' }]} />
        <Lbl>Sample</Lbl><Select small value={o.sample || 'merged'} onChange={(v) => set({ sample: v })} options={[{ value: 'merged', label: 'All layers' }, { value: 'layer', label: 'Current layer' }]} />
        <span className="text-[11px] text-fg3">Alt+click sets the background colour</span>
      </>
    );
    case 'bucket': return (
      <>
        <NumberInput label="Tolerance" value={o.tolerance} min={0} max={255} width={56} onChange={(v) => set({ tolerance: v })} />
        <Mini label="Opacity" value={Math.round(o.opacity * 100)} min={1} max={100} unit="%" width={56} onChange={(v) => set({ opacity: v / 100 })} />
        <Checkbox checked={o.contiguous} onChange={(v) => set({ contiguous: v })} label="Contiguous" />
        <Checkbox checked={o.merged} onChange={(v) => set({ merged: v })} label="All layers" />
      </>
    );
    case 'gradient': return (
      <>
        <Select small value={o.colors} onChange={(v) => set({ colors: v })} options={[{ value: 'fgbg', label: 'Foreground to Background' }, { value: 'fgtrans', label: 'Foreground to Transparent' }, { value: 'bw', label: 'Black, White' }]} />
        <Segmented value={o.type} onChange={(v) => set({ type: v })} options={[{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }, { value: 'reflected', label: 'Reflected' }]} />
        <Lbl>Mode</Lbl><Select small value={o.blend || 'source-over'} onChange={(v) => set({ blend: v })} options={BLEND_MODES} />
        <Mini label="Opacity" value={Math.round(o.opacity * 100)} min={1} max={100} unit="%" width={56} onChange={(v) => set({ opacity: v / 100 })} />
        <Checkbox checked={o.reverse} onChange={(v) => set({ reverse: v })} label="Reverse" />
      </>
    );
    case 'text': return (
      <>
        <FontPicker value={o.font} weight={o.weight} onChange={(f) => set({ font: f })} width={170} />
        <WeightPicker family={o.font} value={o.weight} onChange={(w) => set({ weight: w })} />
        <NumberInput label="Size" value={o.size} min={1} max={2000} unit="px" width={64} onChange={(v) => set({ size: v })} />
        <Segmented value={o.align} onChange={(v) => set({ align: v })} options={[{ value: 'left', icon: 'alignLeft', title: 'Left' }, { value: 'center', icon: 'alignCenterH', title: 'Centre' }, { value: 'right', icon: 'alignRight', title: 'Right' }]} />
        <span className="text-[11px] text-fg3">Click to type; click existing text to edit. Colour = foreground.</span>
      </>
    );
    case 'shape': return (
      <>
        <Segmented value={o.shape} onChange={(v) => set({ shape: v })} options={[{ value: 'rect', icon: 'rect', title: 'Rectangle' }, { value: 'ellipse', icon: 'ellipse', title: 'Ellipse' }, { value: 'polygon', icon: 'polygon', title: 'Polygon' }, { value: 'line', icon: 'line', title: 'Line' }]} />
        <Lbl>Fill</Lbl><FillChoice value={o.fill} onChange={(v) => set({ fill: v })} />
        <Lbl>Stroke</Lbl><FillChoice value={o.stroke} onChange={(v) => set({ stroke: v })} />
        <NumberInput label="Width" value={o.strokeWidth} min={0} max={200} unit="px" width={58} onChange={(v) => set({ strokeWidth: v })} />
        {o.shape === 'rect' && <NumberInput label="Radius" value={o.radius} min={0} max={1000} unit="px" width={58} onChange={(v) => set({ radius: v })} />}
        {o.shape === 'polygon' && <NumberInput label="Sides" value={o.sides} min={3} max={24} width={46} onChange={(v) => set({ sides: v })} />}
      </>
    );
    case 'move': return (
      <>
        <Checkbox checked={o.autoSelect} onChange={(v) => set({ autoSelect: v })} label="Auto-select layer" />
        <span className="text-[11px] text-fg3">Ctrl+click picks the layer under the pointer · arrow keys nudge · drag guides from the rulers</span>
      </>
    );
    case 'zoom': return <span className="text-[11px] text-fg3">Click to zoom in, Alt+click to zoom out · Ctrl+0 fit · Ctrl+1 100%</span>;
    case 'hand': return <span className="text-[11px] text-fg3">Drag to pan. Hold Space with any tool to pan.</span>;
    default: return null;
  }
}

function FillChoice({ value, onChange }) {
  const kind = value === 'none' ? 'none' : value === 'fg' || !value ? 'fg' : 'custom';
  return (
    <span className="flex items-center gap-1">
      <Select small value={kind} onChange={(k) => onChange(k === 'custom' ? '#5AB4FF' : k)} options={[{ value: 'none', label: 'None' }, { value: 'fg', label: 'Foreground' }, { value: 'custom', label: 'Colour' }]} />
      {kind === 'custom' && <ColorSwatch value={value} onChange={onChange} size={22} />}
    </span>
  );
}

export const DEFAULT_OPTS = {
  brush: { size: 30, hardness: 0.8, opacity: 1, flow: 1, spacing: 15, smoothing: 10, pressureSize: true, pressureOpacity: false, blend: 'source-over' },
  pencil: { size: 4, opacity: 1, flow: 1, spacing: 5, pressureSize: false, blend: 'source-over' },
  eraser: { size: 50, hardness: 0.6, opacity: 1, flow: 1, spacing: 15, mode: 'brush' },
  clone: { size: 60, hardness: 0.5, opacity: 1, flow: 1, spacing: 15, aligned: true, blend: 'source-over' },
  heal: { size: 40 },
  dodge: { size: 80, hardness: 0.3, mode: 'dodge', range: 'midtones', exposure: 40, spacing: 20 },
  blur: { size: 60, hardness: 0.3, mode: 'blur', strength: 50, spacing: 20 },
  marquee: { shape: 'rect', mode: 'replace', feather: 0 },
  lasso: { kind: 'free', mode: 'replace', feather: 0 },
  wand: { tolerance: 32, contiguous: true, merged: false, antiAlias: true, mode: 'replace' },
  crop: { ratio: 'free', deletePixels: true },
  eyedropper: { size: 1, sample: 'merged' },
  bucket: { tolerance: 32, contiguous: true, merged: false, opacity: 1 },
  gradient: { type: 'linear', colors: 'fgbg', opacity: 1, reverse: false, blend: 'source-over' },
  text: { font: 'Inter', size: 72, weight: 400, align: 'left' },
  shape: { shape: 'rect', fill: 'fg', stroke: 'none', strokeWidth: 4, radius: 0, sides: 6 },
  move: { autoSelect: false },
};
export { cx };
