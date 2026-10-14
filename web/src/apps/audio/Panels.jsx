// Right-hand panels: Track (mixer strip, effects rack, ducking), Clip (gain, fades, envelope), Master (rack, loudness
// meter, Match loudness) and Markers. The EQ gets a draggable frequency-response curve.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Slider, Select, NumberInput, Toggle, Checkbox, Button, IconButton, Segmented, TextInput, openMenu, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { FX, FX_ORDER, EQ_TYPES, PRESETS, newEffect, eqResponse } from './effects.js';
import { updateTrack, updateClip, findClip, fmtDb, clamp, SHAPES, uid, fileById } from './model.js';
import { Meter, useFrame, frameLevels, fmtClock } from './parts.jsx';

const Row = ({ label, children }) => (
  <div className="grid grid-cols-[84px_1fr] items-center gap-2 min-h-8"><span className="text-xs text-fg2 truncate">{label}</span><div className="min-w-0">{children}</div></div>
);
const Section = ({ title, actions, children }) => (
  <section className="border-b border-line">
    <div className="flex items-center h-8 px-3 gap-1"><span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-fg2">{title}</span>{actions}</div>
    <div className="px-3 pb-3 flex flex-col gap-1.5">{children}</div>
  </section>
);

export default function Panels({ doc, edit, commit, canEdit, engine, selTrack, sel, tab, setTab, actions }) {
  const clipIds = [...sel];
  const one = clipIds.length === 1 ? findClip(doc, clipIds[0]) : null;
  const track = doc.tracks.find((t) => t.id === selTrack) || doc.tracks[0];
  return (
    <div className="flex flex-col min-h-full">
      <div className="p-2 border-b border-line sticky top-0 bg-panel z-10">
        <Segmented value={tab} onChange={setTab} className="w-full [&>button]:flex-1"
          options={[{ value: 'track', label: 'Track' }, { value: 'clip', label: 'Clip' }, { value: 'master', label: 'Master' }, { value: 'markers', label: 'Markers' }]} />
      </div>
      {tab === 'track' && (track ? <TrackPanel doc={doc} t={track} edit={edit} commit={commit} canEdit={canEdit} /> : <Empty>Add a track to see its settings.</Empty>)}
      {tab === 'clip' && (one ? <ClipPanel doc={doc} f={one} edit={edit} commit={commit} canEdit={canEdit} actions={actions} />
        : <Empty>{clipIds.length > 1 ? `${clipIds.length} clips selected.` : 'Select a clip to set its gain, fades and envelope.'}</Empty>)}
      {tab === 'master' && <MasterPanel doc={doc} edit={edit} commit={commit} canEdit={canEdit} engine={engine} actions={actions} />}
      {tab === 'markers' && <MarkersPanel doc={doc} edit={edit} canEdit={canEdit} engine={engine} actions={actions} />}
    </div>
  );
}
const Empty = ({ children }) => <p className="p-4 text-sm text-fg2">{children}</p>;

// ---------------------------------------------------------------- track

function TrackPanel({ doc, t, edit, commit, canEdit }) {
  const set = (patch, label, merge) => edit(updateTrack(doc, t.id, patch), label, merge ? { merge: `${merge}-${t.id}` } : undefined);
  const dk = doc.duck;
  const isTarget = dk?.target === t.id;
  const setDuck = (patch, label, merge) => edit({ ...doc, duck: { on: true, target: t.id, sources: [], amount: -14, threshold: -42, attack: 0.15, release: 0.8, ...(isTarget ? dk : {}), ...patch } }, label, merge ? { merge } : undefined);
  return (
    <>
      <Section title="Track">
        <Row label="Name"><TextInput value={t.name} disabled={!canEdit} onChange={(e) => set({ name: e.target.value }, 'Rename track', 'name')} onBlur={commit} className="!h-7" /></Row>
        <Slider label="Volume" value={t.volume} min={-60} max={12} step={0.1} unit="dB" reset={0} disabled={!canEdit} onChange={(v) => set({ volume: v }, 'Track volume', 'vol')} onCommit={commit} />
        <Slider label="Pan" value={Math.round(t.pan * 100)} min={-100} max={100} step={1} reset={0} disabled={!canEdit} onChange={(v) => set({ pan: v / 100 }, 'Track pan', 'pan')} onCommit={commit} />
        <div className="flex gap-3 pt-1">
          <Checkbox label="Mute" checked={t.mute} onChange={(v) => canEdit && set({ mute: v }, 'Mute')} />
          <Checkbox label="Solo" checked={t.solo} onChange={(v) => canEdit && set({ solo: v }, 'Solo')} />
        </div>
      </Section>
      <Rack title={`${t.name} effects`} effects={t.effects} canEdit={canEdit} commit={commit}
        onChange={(effects, label, merge) => edit(updateTrack(doc, t.id, { effects }), label, merge ? { merge } : undefined)} />
      <Section title="Ducking" actions={isTarget && <Toggle checked={dk.on} onChange={(v) => canEdit && setDuck({ on: v }, v ? 'Ducking on' : 'Ducking off')} />}>
        {!isTarget ? (
          <>
            <p className="text-xs text-fg2">Turn this track down automatically while other tracks have sound — for music under voices.</p>
            <Button size="sm" icon="volume" disabled={!canEdit || doc.tracks.length < 2} onClick={() => setDuck({ on: true, sources: doc.tracks.filter((x) => x.id !== t.id).map((x) => x.id) }, 'Duck under voices')}>Duck this track</Button>
            {dk?.target && <p className="text-[11px] text-fg3">(Replaces ducking on “{doc.tracks.find((x) => x.id === dk.target)?.name || 'another track'}”.)</p>}
          </>
        ) : (
          <>
            <span className="text-xs text-fg2">Duck under</span>
            <div className="flex flex-col gap-1">
              {doc.tracks.filter((x) => x.id !== t.id).map((x) => (
                <Checkbox key={x.id} label={x.name} checked={dk.sources.includes(x.id)}
                  onChange={(v) => canEdit && setDuck({ sources: v ? [...dk.sources, x.id] : dk.sources.filter((s) => s !== x.id) }, 'Ducking sources')} />
              ))}
            </div>
            <Slider label="Amount" value={dk.amount} min={-40} max={0} step={0.5} unit="dB" disabled={!canEdit} onChange={(v) => setDuck({ amount: v }, 'Duck amount', 'duck-amt')} onCommit={commit} />
            <Slider label="Sensitivity" value={dk.threshold} min={-70} max={-6} step={0.5} unit="dB" disabled={!canEdit} onChange={(v) => setDuck({ threshold: v }, 'Duck threshold', 'duck-thr')} onCommit={commit} />
            <Slider label="Fade down" value={dk.attack} min={0.02} max={2} step={0.01} unit="s" disabled={!canEdit} onChange={(v) => setDuck({ attack: v }, 'Duck attack', 'duck-att')} onCommit={commit} />
            <Slider label="Fade up" value={dk.release} min={0.05} max={4} step={0.01} unit="s" disabled={!canEdit} onChange={(v) => setDuck({ release: v }, 'Duck release', 'duck-rel')} onCommit={commit} />
            <Button size="xs" variant="ghost" icon="close" disabled={!canEdit} onClick={() => edit({ ...doc, duck: null }, 'Remove ducking')}>Remove ducking</Button>
          </>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- effects rack

export function Rack({ title, effects, onChange, commit, canEdit }) {
  const addMenu = (e) => openMenu(e, FX_ORDER.map((type) => ({ label: FX[type].name, onClick: () => onChange([...effects, newEffect(type)], `Add ${FX[type].name}`) })));
  const presetMenu = (e) => openMenu(e, [
    { heading: 'Replace the rack with' },
    ...Object.entries(PRESETS).map(([id, p]) => ({ label: p.name, onClick: () => onChange(p.make(), `Preset: ${p.name}`) })),
    { divider: true },
    { label: 'Clear rack', icon: 'trash', disabled: !effects.length, onClick: () => onChange([], 'Clear effects') },
  ]);
  const setFx = (id, patch, label, merge) => onChange(effects.map((x) => (x.id === id ? { ...x, ...patch } : x)), label, merge);
  const move = (i, d) => { const l = [...effects]; const [x] = l.splice(i, 1); l.splice(i + d, 0, x); onChange(l, 'Reorder effects'); };
  return (
    <Section title={title} actions={canEdit && (
      <>
        <Button size="xs" variant="ghost" icon="presets" onClick={presetMenu}>Presets</Button>
        <IconButton icon="plus" label="Add effect" size={24} onClick={addMenu} />
      </>
    )}>
      {!effects.length && <p className="text-xs text-fg3">No effects. Add one with +, or pick a preset (Podcast voice, Telephone, Radio, Big room).</p>}
      {effects.map((fx, i) => (
        <EffectCard key={fx.id} fx={fx} canEdit={canEdit} commit={commit} defaultOpen={effects.length <= 2 || i === effects.length - 1}
          onParams={(params, merge) => setFx(fx.id, { params }, FX[fx.type]?.name || 'Effect', merge)}
          onToggle={() => setFx(fx.id, { on: !fx.on }, fx.on ? 'Bypass effect' : 'Enable effect')}
          menu={(e) => openMenu(e, [
            { label: 'Move up', disabled: i === 0, onClick: () => move(i, -1) },
            { label: 'Move down', disabled: i === effects.length - 1, onClick: () => move(i, 1) },
            { label: 'Reset', onClick: () => setFx(fx.id, { params: newEffect(fx.type).params }, 'Reset effect') },
            { divider: true },
            { label: 'Remove', icon: 'trash', danger: true, onClick: () => onChange(effects.filter((x) => x.id !== fx.id), 'Remove effect') },
          ])} />
      ))}
    </Section>
  );
}

function EffectCard({ fx, canEdit, commit, onParams, onToggle, menu, defaultOpen }) {
  const def = FX[fx.type];
  const [open, setOpen] = useState(defaultOpen);
  if (!def) return null;
  const mk = (k) => `${fx.id}-${k}`;
  return (
    <div className={cx('rounded-md border border-line bg-panel-2/60', !fx.on && 'opacity-60')} data-effect={fx.type}>
      <div className="flex items-center gap-1 h-8 px-1.5">
        <button type="button" title={fx.on ? 'Bypass' : 'Enable'} disabled={!canEdit} onClick={onToggle}
          className={cx('w-5 h-5 rounded-full grid place-items-center border', fx.on ? 'border-accent text-accent' : 'border-line text-fg3')}>
          <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M12 3v8" /><path d="M6.3 7.5a8 8 0 1 0 11.4 0" /></svg>
        </button>
        <button type="button" className="flex-1 text-left text-[12.5px] font-medium truncate" onClick={() => setOpen(!open)}>{def.name}</button>
        <IconButton icon={open ? 'chevronUp' : 'chevronDown'} label={open ? 'Collapse' : 'Expand'} size={22} onClick={() => setOpen(!open)} />
        {canEdit && <IconButton icon="more" label="Effect options" size={22} onClick={menu} />}
      </div>
      {open && (
        <div className="px-2 pb-2 flex flex-col gap-1">
          {fx.type === 'eq' && <EqEditor params={fx.params} canEdit={canEdit} commit={commit} onChange={(p, k) => onParams(p, mk(k))} />}
          {def.params.map((p) => (
            <ParamSlider key={p.key} p={p} value={fx.params[p.key]} disabled={!canEdit} onChange={(v) => onParams({ ...fx.params, [p.key]: v }, mk(p.key))} onCommit={commit} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A labelled slider; log-scaled for frequencies. */
function ParamSlider({ p, value, onChange, onCommit, disabled }) {
  const toPos = p.log ? (v) => Math.log(v / p.min) / Math.log(p.max / p.min) : (v) => (v - p.min) / (p.max - p.min);
  const fromPos = p.log ? (x) => Math.round(p.min * (p.max / p.min) ** x) : (x) => Math.round((p.min + x * (p.max - p.min)) / p.step) * p.step;
  return (
    <div className={cx('flex flex-col gap-0.5', disabled && 'opacity-50 pointer-events-none')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg2" onDoubleClick={() => { onChange(p.def); onCommit?.(); }}>{p.label}</span>
        <NumberInput value={value} min={p.min} max={p.max} step={p.log ? 1 : p.step} unit={p.unit} width={p.unit ? 70 : 56} onChange={onChange} onCommit={onCommit} />
      </div>
      <input type="range" className="sl-range" min={0} max={1} step={0.001} value={toPos(value)} aria-label={p.label}
        onChange={(e) => onChange(+fromPos(Number(e.target.value)).toFixed(4))} onPointerUp={() => onCommit?.()} onDoubleClick={() => { onChange(p.def); onCommit?.(); }} />
    </div>
  );
}

// ---------------------------------------------------------------- EQ curve

const FREQS = (() => { const n = 240; const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 20 * 1000 ** (i / (n - 1)); return a; })();
const BAND_COLORS = ['#ff8fb1', '#ffc36b', '#7ee081', '#5AB4FF', '#c79bff'];
const EQ_RANGE = 18;

function EqEditor({ params, onChange, commit, canEdit }) {
  const cv = useRef(null);
  const W = 244; const H = 120;
  const fx = (f) => (Math.log10(f / 20) / 3) * W;
  const xf = (x) => 20 * 1000 ** clamp(x / W, 0, 1);
  const gy = (g) => H / 2 - (g / EQ_RANGE) * (H / 2 - 6);
  const yg = (y) => clamp(((H / 2 - y) / (H / 2 - 6)) * EQ_RANGE, -EQ_RANGE, EQ_RANGE);
  const bands = params.bands || [];
  const usesGain = (b) => ['peaking', 'lowshelf', 'highshelf'].includes(b.type);
  const resp = useMemo(() => eqResponse(params, FREQS), [params]);

  useEffect(() => {
    const c = cv.current; const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#121318'; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.font = '9px Inter, sans-serif'; g.fillStyle = 'rgba(255,255,255,.35)';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(fx(f)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(f >= 1000 ? `${f / 1000}k` : f, x + 2, H - 3); }
    for (const db of [-12, -6, 0, 6, 12]) { const y = Math.round(gy(db)) + 0.5; g.strokeStyle = db ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.beginPath();
    for (let i = 0; i < FREQS.length; i++) { const x = fx(FREQS[i]); const y = gy(clamp(resp[i], -EQ_RANGE - 6, EQ_RANGE + 6)); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.strokeStyle = '#00e4bb'; g.lineWidth = 2; g.stroke();
    g.lineTo(W, gy(0)); g.lineTo(0, gy(0)); g.closePath(); g.fillStyle = 'rgba(0,228,187,.12)'; g.fill();
    bands.forEach((b, i) => {
      const x = fx(b.f); const y = gy(usesGain(b) ? b.g : 0);
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2);
      g.fillStyle = b.on ? BAND_COLORS[i % 5] : 'rgba(255,255,255,.25)'; g.fill();
      g.fillStyle = '#000'; g.font = 'bold 8px Inter, sans-serif'; g.fillText(String(i + 1), x - 2.5, y + 3);
    });
  }, [resp, bands]); // eslint-disable-line react-hooks/exhaustive-deps

  const setBand = (i, patch, key) => onChange({ ...params, bands: bands.map((b, k) => (k === i ? { ...b, ...patch } : b)) }, key || `band${i}`);
  const down = (e) => {
    if (!canEdit) return;
    const r = cv.current.getBoundingClientRect(); const x = e.clientX - r.left; const y = e.clientY - r.top;
    const i = bands.findIndex((b) => Math.hypot(fx(b.f) - x, gy(usesGain(b) ? b.g : 0) - y) < 9);
    if (i < 0) return;
    e.preventDefault();
    const key = `drag${uid()}`;
    const move = (ev) => {
      const nx = ev.clientX - r.left; const ny = ev.clientY - r.top;
      setBand(i, { f: Math.round(xf(nx)), ...(usesGain(bands[i]) ? { g: Math.round(yg(ny) * 10) / 10 } : {}) }, key);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); commit(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const wheel = (e) => {
    if (!canEdit) return;
    const r = cv.current.getBoundingClientRect(); const x = e.clientX - r.left; const y = e.clientY - r.top;
    const i = bands.findIndex((b) => Math.hypot(fx(b.f) - x, gy(usesGain(b) ? b.g : 0) - y) < 12);
    if (i >= 0) setBand(i, { q: clamp(Math.round(bands[i].q * Math.exp(-e.deltaY * 0.002) * 100) / 100, 0.1, 18) }, `q${i}`);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <canvas ref={cv} style={{ width: W, height: H }} className="rounded border border-line cursor-pointer self-center" onPointerDown={down} onWheel={wheel} title="Drag a band; scroll on it to change Q" data-testid="eq-curve" />
      {bands.map((b, i) => (
        <div key={i} className="flex items-center gap-1">
          <button type="button" disabled={!canEdit} onClick={() => setBand(i, { on: !b.on })} title={b.on ? 'Band on' : 'Band off'}
            className="w-4 h-4 rounded-full text-[8px] font-bold text-black shrink-0" style={{ background: b.on ? BAND_COLORS[i % 5] : 'rgba(255,255,255,.2)' }}>{i + 1}</button>
          <Select small value={b.type} onChange={(v) => setBand(i, { type: v })} options={EQ_TYPES.map(([v, l]) => ({ value: v, label: l }))} className="!w-[78px] !text-[11px]" disabled={!canEdit} />
          <NumberInput value={b.f} min={20} max={20000} step={1} width={52} onChange={(v) => setBand(i, { f: v })} onCommit={commit} title="Frequency (Hz)" disabled={!canEdit} />
          <NumberInput value={b.g} min={-EQ_RANGE} max={EQ_RANGE} step={0.1} width={40} onChange={(v) => setBand(i, { g: v })} onCommit={commit} title="Gain (dB)" disabled={!canEdit || !usesGain(b)} />
          <NumberInput value={b.q} min={0.1} max={18} step={0.01} width={36} onChange={(v) => setBand(i, { q: v })} onCommit={commit} title="Q" disabled={!canEdit} />
          {bands.length > 3 && canEdit && <IconButton icon="close" label="Remove band" size={18} onClick={() => onChange({ ...params, bands: bands.filter((_, k) => k !== i) }, 'bands')} />}
        </div>
      ))}
      {bands.length < 5 && canEdit && <Button size="xs" variant="ghost" icon="plus" onClick={() => onChange({ ...params, bands: [...bands, { type: 'peaking', f: 1000, g: 0, q: 1, on: true }] }, 'bands')}>Add band</Button>}
    </div>
  );
}

// ---------------------------------------------------------------- clip

function ClipPanel({ doc, f, edit, commit, canEdit, actions }) {
  const c = f.clip;
  const set = (patch, label, merge) => edit(updateClip(doc, c.id, patch), label, merge ? { merge: `${merge}-${c.id}` } : undefined);
  const file = fileById(doc, c.asset);
  return (
    <>
      <Section title="Clip">
        <Row label="Name"><TextInput value={c.name} disabled={!canEdit} onChange={(e) => set({ name: e.target.value }, 'Rename clip', 'name')} onBlur={commit} className="!h-7" /></Row>
        <Row label="Source"><span className="text-xs text-fg truncate block" title={file?.name}>{file?.name || c.asset}</span></Row>
        <Row label="Start"><NumberInput value={c.start} min={0} step={0.001} unit="s" width={90} disabled={!canEdit} onChange={(v) => set({ start: v }, 'Move clip', 'start')} onCommit={commit} /></Row>
        <Row label="Length"><span className="text-xs tabular-nums">{fmtClock(c.dur)}</span></Row>
        <Slider label="Clip gain" value={c.gain} min={-40} max={24} step={0.1} unit="dB" reset={0} disabled={!canEdit} onChange={(v) => set({ gain: v }, 'Clip gain', 'gain')} onCommit={commit} />
        <Button size="sm" icon="wave" onClick={() => actions.openClip(c.id)}>Open in Waveform editor</Button>
      </Section>
      <Section title="Fades">
        {['fadeIn', 'fadeOut'].map((k) => (
          <div key={k} className="flex items-center gap-1.5">
            <span className="text-xs text-fg2 w-16">{k === 'fadeIn' ? 'Fade in' : 'Fade out'}</span>
            <NumberInput value={c[k].d} min={0} max={c.dur} step={0.01} unit="s" width={66} disabled={!canEdit} onChange={(v) => set({ [k]: { ...c[k], d: v } }, 'Fade', k)} onCommit={commit} />
            <Select small value={c[k].shape} onChange={(v) => set({ [k]: { ...c[k], shape: v } }, 'Fade shape')} options={SHAPES.map(([v, l]) => ({ value: v, label: l }))} className="flex-1 min-w-0" disabled={!canEdit} />
          </div>
        ))}
        <p className="text-[11px] text-fg3">Drag the white squares on a clip to fade. Overlapping clips on a track crossfade automatically (equal power).</p>
      </Section>
      <Section title="Volume envelope" actions={canEdit && c.env.length > 0 && <Button size="xs" variant="ghost" onClick={() => set({ env: [] }, 'Reset envelope')}>Reset</Button>}>
        <p className="text-xs text-fg2">{c.env.length ? `${c.env.length} point${c.env.length > 1 ? 's' : ''}.` : 'Flat (0 dB).'} Click the yellow line on a selected clip to add a point, drag to move it, double-click or Alt+click to remove.</p>
        {c.env.map((p, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <span className="w-14 tabular-nums text-fg2">{fmtClock(c.start + p.t - c.in)}</span>
            <NumberInput value={p.v} min={-60} max={12} step={0.1} unit="dB" width={70} disabled={!canEdit}
              onChange={(v) => set({ env: c.env.map((x, k) => (k === i ? { ...x, v } : x)) }, 'Envelope', `env${i}`)} onCommit={commit} />
            {canEdit && <IconButton icon="close" label="Remove point" size={20} onClick={() => set({ env: c.env.filter((_, k) => k !== i) }, 'Remove envelope point')} />}
          </div>
        ))}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- master

function MasterPanel({ doc, edit, commit, canEdit, engine, actions }) {
  const m = doc.master;
  const refs = { momentary: useRef(null), short: useRef(null), integrated: useRef(null) };
  const fmt = (v) => (Number.isFinite(v) && v > -70 ? v.toFixed(1) : '—');
  useFrame((ts) => {
    const lv = frameLevels(engine, ts);
    for (const k of ['momentary', 'short', 'integrated']) if (refs[k].current && lv.lufs) refs[k].current.textContent = fmt(lv.lufs[k]);
  }, [engine]);
  const getL = useCallback((lv) => lv.master[0], []); const getR = useCallback((lv) => lv.master[1], []);
  return (
    <>
      <Section title="Loudness">
        <div className="flex gap-3 items-stretch">
          <div className="flex gap-1 h-28">
            <Meter engine={engine} get={getL} vertical className="w-2.5 h-full" />
            <Meter engine={engine} get={getR} vertical className="w-2.5 h-full" />
          </div>
          <div className="flex-1 grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 content-center text-xs" data-testid="loudness">
            <span className="text-fg2">Momentary</span><span className="tabular-nums font-mono text-fg"><span ref={refs.momentary}>—</span> LUFS</span>
            <span className="text-fg2">Short-term</span><span className="tabular-nums font-mono text-fg"><span ref={refs.short}>—</span> LUFS</span>
            <span className="text-fg2">Integrated</span><span className="tabular-nums font-mono text-accent font-semibold"><span ref={refs.integrated}>—</span> LUFS</span>
          </div>
        </div>
        <p className="text-[11px] text-fg3">Measured while playing (approximate, K-weighted). Integrated restarts each time you press Play.</p>
        <Button size="sm" icon="normalize" disabled={!canEdit} onClick={actions.matchLoudness} title="Renders the mix, measures it, and sets the master so it reads −16 LUFS (podcast standard), with a −1 dB limiter">Match loudness (−16 LUFS)</Button>
      </Section>
      <Section title="Master">
        <Slider label="Volume" value={m.volume} min={-60} max={12} step={0.1} unit="dB" reset={0} disabled={!canEdit} onChange={(v) => edit({ ...doc, master: { ...m, volume: v } }, 'Master volume', { merge: 'master-vol' })} onCommit={commit} />
      </Section>
      <Rack title="Master effects" effects={m.effects} canEdit={canEdit} commit={commit} onChange={(effects, label, merge) => edit({ ...doc, master: { ...m, effects } }, label, merge ? { merge } : undefined)} />
    </>
  );
}

// ---------------------------------------------------------------- markers

function MarkersPanel({ doc, edit, canEdit, engine, actions }) {
  const list = [...doc.markers].sort((a, b) => a.t - b.t);
  return (
    <Section title="Markers" actions={canEdit && <Button size="xs" variant="ghost" icon="plus" onClick={() => actions.addMarker(engine.position)}>Add (M)</Button>}>
      {!list.length && <p className="text-xs text-fg3">Press M while playing (or stopped) to drop a marker at the playhead.</p>}
      {list.map((m) => (
        <div key={m.id} className="flex items-center gap-1.5 group">
          <button type="button" onClick={() => engine.seek(m.t)} className="text-[11px] tabular-nums font-mono text-sun w-16 text-left hover:underline">{fmtClock(m.t)}</button>
          <TextInput value={m.name} disabled={!canEdit} className="!h-6 !text-xs flex-1" onChange={(e) => edit({ ...doc, markers: doc.markers.map((k) => (k.id === m.id ? { ...k, name: e.target.value } : k)) }, 'Rename marker', { merge: `mk-${m.id}` })} />
          {canEdit && <IconButton icon="close" label="Delete marker" size={20} onClick={() => edit({ ...doc, markers: doc.markers.filter((k) => k.id !== m.id) }, 'Delete marker')} />}
        </div>
      ))}
    </Section>
  );
}
