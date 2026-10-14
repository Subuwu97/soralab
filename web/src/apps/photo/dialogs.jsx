// Photo's dialogs: Image Size, Canvas Size, filters (live preview on the canvas), destructive adjustments,
// and a small numeric prompt (Feather, Expand…). They're rendered by the editor so they can drive previews.
import { useEffect, useRef, useState } from 'react';
import { Modal, Button, NumberInput, Select, Slider, Toggle, Checkbox, cx } from '../../components/ui.jsx';
import { FILTERS, filterDefaults } from '../_raster/filters.js';
import { ADJUSTMENTS, defaultsFor } from '../_raster/adjust.js';
import { AdjustEditor } from './panels.jsx';

export function ImageSizeDialog({ doc, onApply, onClose }) {
  const [w, setW] = useState(doc.width); const [h, setH] = useState(doc.height);
  const [lock, setLock] = useState(true); const [unit, setUnit] = useState('px');
  const ratio = doc.width / doc.height;
  const pct = unit === '%';
  const sw = (v) => { const px = pct ? Math.round(doc.width * v / 100) : v; setW(px); if (lock) setH(Math.max(1, Math.round(px / ratio))); };
  const sh = (v) => { const px = pct ? Math.round(doc.height * v / 100) : v; setH(px); if (lock) setW(Math.max(1, Math.round(px * ratio))); };
  const mp = (w * h * 4 / 1048576).toFixed(1);
  return (
    <Modal title="Image Size" onClose={onClose} width={420}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={w * h > 16384 * 16384} onClick={() => onApply(w, h)}>OK</Button></>}>
      <div className="text-xs text-fg2 mb-3">Current: {doc.width} × {doc.height} px · New: {w} × {h} px ({mp} MB)</div>
      <div className="grid grid-cols-[80px_1fr] gap-3 items-center">
        <span className="text-sm text-fg2">Width</span><NumberInput value={pct ? Math.round(w / doc.width * 1000) / 10 : w} onChange={sw} min={1} max={pct ? 1000 : 16384} unit={unit} width={110} />
        <span className="text-sm text-fg2">Height</span><NumberInput value={pct ? Math.round(h / doc.height * 1000) / 10 : h} onChange={sh} min={1} max={pct ? 1000 : 16384} unit={unit} width={110} />
        <span className="text-sm text-fg2">Units</span><Select value={unit} onChange={setUnit} options={[{ value: 'px', label: 'Pixels' }, { value: '%', label: 'Percent' }]} />
        <span />
        <Checkbox checked={lock} onChange={setLock} label="Constrain proportions" />
      </div>
      <p className="text-[11px] text-fg3 mt-3">Resamples every pixel layer (bicubic-quality smoothing). Text and shapes stay editable.</p>
    </Modal>
  );
}

const ANCHORS = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];
export function CanvasSizeDialog({ doc, onApply, onClose }) {
  const [w, setW] = useState(doc.width); const [h, setH] = useState(doc.height); const [anchor, setAnchor] = useState('c');
  const [rel, setRel] = useState(false);
  return (
    <Modal title="Canvas Size" onClose={onClose} width={420}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onApply(rel ? doc.width + w : w, rel ? doc.height + h : h, anchor)}>OK</Button></>}>
      <div className="text-xs text-fg2 mb-3">Current: {doc.width} × {doc.height} px</div>
      <div className="grid grid-cols-[80px_1fr] gap-3 items-center">
        <span className="text-sm text-fg2">Width</span><NumberInput value={w} onChange={setW} min={rel ? -doc.width + 1 : 1} max={16384} unit="px" width={110} />
        <span className="text-sm text-fg2">Height</span><NumberInput value={h} onChange={setH} min={rel ? -doc.height + 1 : 1} max={16384} unit="px" width={110} />
        <span />
        <Checkbox checked={rel} onChange={(v) => { setRel(v); setW(v ? 0 : doc.width); setH(v ? 0 : doc.height); }} label="Relative" />
        <span className="text-sm text-fg2">Anchor</span>
        <div className="grid grid-cols-3 gap-1 w-24">
          {ANCHORS.map((a) => <button key={a} type="button" aria-label={`Anchor ${a}`} onClick={() => setAnchor(a)} className={cx('w-7 h-7 rounded border', a === anchor ? 'bg-accent border-accent' : 'bg-input border-line hover:bg-hover')} />)}
        </div>
      </div>
    </Modal>
  );
}

/** Filter settings with live preview. onPreview(params) is called (debounced) while sliders move. */
export function FilterDialog({ id, onPreview, onApply, onClose, busy, target }) {
  const f = FILTERS[id];
  const [p, setP] = useState(() => filterDefaults(id));
  const [preview, setPreview] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => onPreview(preview ? p : null), 220);
    return () => clearTimeout(t);
  }, [p, preview]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FloatPanel title={f.label.replace('…', '')} onClose={onClose} width={340}
      footer={<><span className="flex-1 text-xs text-fg3">{busy ? 'Rendering preview…' : target}</span><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onApply(p)}>OK</Button></>}>
      <div className="flex flex-col gap-3">
        {f.params.map((q) => (q.type === 'toggle'
          ? <Toggle key={q.key} checked={p[q.key]} onChange={(v) => setP({ ...p, [q.key]: v })} label={q.label} />
          : <Slider key={q.key} label={q.label} value={p[q.key]} min={q.min} max={q.max} step={q.step || 1} unit={q.unit} reset={q.default} onChange={(v) => setP({ ...p, [q.key]: v })} />))}
        {!f.params.length && <p className="text-sm text-fg2">No settings.</p>}
        <Checkbox checked={preview} onChange={setPreview} label="Preview" />
      </div>
    </FloatPanel>
  );
}

/** Image → Adjustments: the same settings as adjustment layers, applied to the pixels. */
export function AdjustDialog({ kind, histo, onPreview, onApply, onClose }) {
  const [adj, setAdj] = useState(() => defaultsFor(kind));
  const first = useRef(true);
  useEffect(() => {
    if (first.current && kind !== 'invert') { first.current = false; return undefined; }
    const t = setTimeout(() => onPreview(adj), 120);
    return () => clearTimeout(t);
  }, [adj]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FloatPanel title={ADJUSTMENTS[kind].label} onClose={onClose} width={300}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onApply(adj)}>OK</Button></>}>
      <AdjustEditor adj={adj} onChange={setAdj} histo={histo} />
    </FloatPanel>
  );
}

export function NumberDialog({ title, label, value: v0, min = 0, max = 500, unit = 'px', onApply, onClose }) {
  const [v, setV] = useState(v0);
  return (
    <Modal title={title} onClose={onClose} width={340}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onApply(v)}>OK</Button></>}>
      <div className="flex items-center gap-3"><span className="text-sm text-fg2">{label}</span><NumberInput value={v} onChange={setV} min={min} max={max} unit={unit} width={100} /></div>
    </Modal>
  );
}

/** A dialog that floats beside the canvas without dimming it, so previews stay visible. */
function FloatPanel({ title, onClose, width = 320, footer, children }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} style={{ width }} className="fixed right-[300px] top-24 z-[900] bg-panel border border-line rounded-xl shadow-[0_24px_80px_rgba(0,0,0,.55)] sl-pop flex flex-col max-h-[80vh]">
      <div className="flex items-center px-4 h-11 border-b border-line"><h2 className="font-head font-semibold text-[14px] flex-1">{title}</h2></div>
      <div className="p-4 overflow-auto scroll-thin">{children}</div>
      <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-line">{footer}</div>
    </div>
  );
}
