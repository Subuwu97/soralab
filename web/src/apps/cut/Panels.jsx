// Right-hand panels: Effect Controls (motion, opacity, crop, speed, audio, keyframes, effects, title text, transitions),
// Effects (drag or click to apply), Audio Track Mixer (faders, pan, mute/solo, meters) and Markers. Plus the meters.
import { useEffect, useRef, useState } from 'react';
import { IconButton, Button, NumberInput, Slider, Select, Toggle, ColorSwatch, TextInput, PanelSection, Segmented, Tabs, openMenu, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { FontPicker, WeightPicker, pickAssets } from '../../components/Pickers.jsx';
import { EFFECTS, effectDef, VIDEO_TRANSITIONS, AUDIO_TRANSITIONS, transitionLabel, valueAt, timecode, tracksOf, clipEnd, clamp, prevAdjacent } from './model.js';

/** Playhead time, re-rendering at most ~20 times a second. */
export function useEngineTime(engine) {
  const [t, setT] = useState(engine.t);
  useEffect(() => {
    let pending = false;
    return engine.subscribe((x) => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; setT(engine.t); }, 50);
      if (!engine.playing) { setT(x); }
    });
  }, [engine]);
  return t;
}

const dB = (g) => (g <= 0.0001 ? -Infinity : 20 * Math.log10(g));
const fromDb = (d) => (d <= -60 ? 0 : 10 ** (d / 20));
const fmtDb = (g) => { const d = dB(g); return Number.isFinite(d) ? `${d >= 0 ? '+' : ''}${d.toFixed(1)} dB` : '-∞'; };

// ---------------------------------------------------------------- keyframe rows

function KfRow({ ed, c, prop, label, ct, min, max, step = 1, unit, scale = 1, precision, toDisplay, fromDisplay }) {
  const list = c.keyframes?.[prop] || [];
  const animated = list.length > 0;
  const v = valueAt(c, prop, ct);
  const disp = toDisplay ? toDisplay(v) : v * scale;
  const set = (x, commit) => ed.setProp(c.id, prop, fromDisplay ? fromDisplay(x) : x / scale, ct, commit);
  const onKey = list.some((k) => Math.abs(k.t - ct) < 1 / 120);
  const prev = [...list].reverse().find((k) => k.t < ct - 1e-3); const next = list.find((k) => k.t > ct + 1e-3);
  return (
    <div className="flex items-center gap-1 h-8">
      <button type="button" title={animated ? 'Stop animating (keeps the current value)' : 'Animate: add keyframes'} disabled={ed.readOnly}
        onClick={() => ed.toggleAnimate(c.id, prop, ct)} className={cx('w-5 h-5 grid place-items-center rounded', animated ? 'text-accent' : 'text-fg3 hover:text-fg')}>
        <Icon name="clock" size={13} />
      </button>
      <span className="text-[12px] text-fg2 w-[70px] truncate">{label}</span>
      <NumberInput value={+disp.toFixed(precision ?? 2)} onChange={(x) => set(x, false)} onCommit={(x) => set(x, true)} min={min} max={max} step={step} unit={unit} width={66} disabled={ed.readOnly} />
      {animated && (
        <span className="flex items-center ml-auto">
          <IconButton icon="chevronLeft" label="Previous keyframe" size={20} disabled={!prev} onClick={() => ed.engine.seek(c.start + prev.t)} />
          <button type="button" title={onKey ? 'Remove keyframe' : 'Add keyframe'} onClick={() => ed.toggleKey(c.id, prop, ct)} disabled={ed.readOnly}
            className={cx('w-5 h-5 grid place-items-center', onKey ? 'text-accent' : 'text-fg3 hover:text-fg')}><Icon name="keyframe" size={12} fill={onKey ? 'currentColor' : 'none'} /></button>
          <IconButton icon="chevronRight" label="Next keyframe" size={20} disabled={!next} onClick={() => ed.engine.seek(c.start + next.t)} />
        </span>
      )}
      {animated && <KfLane c={c} list={list} ct={ct} ed={ed} />}
    </div>
  );
}
function KfLane({ c, list, ct, ed }) {
  return (
    <div className="relative w-16 h-4 rounded bg-panel-2 shrink-0 cursor-pointer" title="Keyframes on this clip — click to move the playhead"
      onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); ed.engine.seek(c.start + ((e.clientX - r.left) / r.width) * c.duration); }}>
      {list.map((k, i) => <span key={i} className="absolute top-1/2 w-2 h-2 -ml-1 -mt-1 rotate-45 bg-accent" style={{ left: `${(k.t / c.duration) * 100}%` }} />)}
      <span className="absolute top-0 bottom-0 w-px bg-[#ff4d6a]" style={{ left: `${clamp(ct / c.duration, 0, 1) * 100}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- effect controls

function EffectParams({ ed, c, e }) {
  const d = effectDef(e.type) || {};
  const up = (patch, commit) => ed.updateEffect(c.id, e.id, patch, commit);
  return (
    <div className={cx('rounded-md border border-line mb-2', e.enabled === false && 'opacity-60')}>
      <div className="flex items-center gap-1 h-7 px-1.5 bg-panel-2 rounded-t-md">
        <button type="button" title={e.enabled === false ? 'Turn on' : 'Turn off'} disabled={ed.readOnly} onClick={() => up({ enabled: e.enabled === false }, true)}
          className={cx('w-5 h-5 grid place-items-center rounded text-[10px] font-bold', e.enabled === false ? 'text-fg3' : 'text-sun')}>fx</button>
        <span className="text-[12px] flex-1 truncate">{d.label || e.type}</span>
        <IconButton icon="trash" label="Remove effect" size={20} disabled={ed.readOnly} onClick={() => ed.removeEffect(c.id, e.id)} />
      </div>
      <div className="px-2 py-1.5 flex flex-col gap-1.5">
        {d.min !== undefined && <Slider label="Amount" value={e.value} min={d.min} max={d.max} step={d.step} unit={d.unit} onChange={(v) => up({ value: v }, false)} onCommit={(v) => up({ value: v }, true)} reset={d.def} disabled={ed.readOnly} />}
        {d.key && (
          <>
            <div className="flex items-center gap-2"><span className="text-xs text-fg2 flex-1">Key colour</span><ColorSwatch value={e.color} alpha={false} onChange={(v) => up({ color: v }, false)} onCommit={(v) => up({ color: v }, true)} /></div>
            <Slider label="Similarity" value={e.similarity} min={0.01} max={0.6} step={0.01} onChange={(v) => up({ similarity: v }, false)} onCommit={(v) => up({ similarity: v }, true)} disabled={ed.readOnly} />
            <Slider label="Blend" value={e.blend} min={0} max={0.5} step={0.01} onChange={(v) => up({ blend: v }, false)} onCommit={(v) => up({ blend: v }, true)} disabled={ed.readOnly} />
          </>
        )}
        {d.lut && (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="flex-1 truncate text-fg2">{e.asset_name || 'No LUT chosen'}</span>
            <Button size="xs" disabled={ed.readOnly} onClick={async () => {
              const [a] = (await pickAssets({ title: 'Choose a .cube LUT', multiple: false, docId: ed.docId })) || [];
              if (a) up({ asset_id: a.id, asset_name: a.name }, true);
            }}>Choose…</Button>
          </div>
        )}
        {['sharpen', 'denoise', 'lut'].includes(e.type) && <div className="text-[10.5px] text-fg3">Shown in the export (not in the live preview).</div>}
      </div>
    </div>
  );
}

function TitleControls({ ed, c }) {
  const t = c.title || {};
  const up = (patch, commit = true) => ed.updateTitle(c.id, patch, commit);
  return (
    <PanelSection title="Text" id="cut-title">
      <textarea value={t.text || ''} disabled={ed.readOnly} rows={3} onChange={(e) => up({ text: e.target.value }, false)} onBlur={() => ed.commit()}
        className="w-full rounded-md bg-input border border-line text-sm p-2 outline-none focus:border-accent/70 resize-y mb-2" />
      <div className="flex items-center gap-1.5 mb-2">
        <FontPicker value={t.font} weight={t.weight} onChange={(f) => up({ font: f })} width={150} />
        <WeightPicker family={t.font} value={t.weight} onChange={(w) => up({ weight: w })} />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <NumberInput label="Size" value={t.size} min={8} max={600} onChange={(v) => up({ size: v }, false)} onCommit={(v) => up({ size: v })} width={52} />
        <ColorSwatch value={t.color} onChange={(v) => up({ color: v }, false)} onCommit={(v) => up({ color: v })} title="Text colour" />
        <IconButton icon="italic" label="Italic" size={26} active={t.italic} onClick={() => up({ italic: !t.italic })} />
        <Segmented value={t.align} onChange={(v) => up({ align: v })} options={[{ value: 'left', icon: 'alignLeft', title: 'Left' }, { value: 'center', icon: 'alignCenterH', title: 'Centre' }, { value: 'right', icon: 'alignRight', title: 'Right' }]} />
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <NumberInput label="X %" value={Math.round((t.x ?? 0.5) * 100)} min={0} max={100} onChange={(v) => up({ x: v / 100 }, false)} onCommit={(v) => up({ x: v / 100 })} width={52} />
        <NumberInput label="Y %" value={Math.round((t.y ?? 0.5) * 100)} min={0} max={100} onChange={(v) => up({ y: v / 100 }, false)} onCommit={(v) => up({ y: v / 100 })} width={52} />
        <NumberInput label="Leading" value={t.line ?? 1.15} step={0.05} min={0.6} max={3} onChange={(v) => up({ line: v }, false)} onCommit={(v) => up({ line: v })} width={52} />
        <NumberInput label="Tracking" value={t.tracking ?? 0} min={-20} max={100} onChange={(v) => up({ tracking: v }, false)} onCommit={(v) => up({ tracking: v })} width={52} />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Toggle checked={t.box} onChange={(v) => up({ box: v })} label="Background" />
        {t.box && <ColorSwatch value={t.boxColor} onChange={(v) => up({ boxColor: v }, false)} onCommit={(v) => up({ boxColor: v })} title="Background colour" />}
        {t.box && <NumberInput label="Pad" value={t.boxPad ?? 20} min={0} max={200} onChange={(v) => up({ boxPad: v }, false)} onCommit={(v) => up({ boxPad: v })} width={44} />}
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Toggle checked={t.shadow} onChange={(v) => up({ shadow: v })} label="Shadow" />
        <NumberInput label="Stroke" value={t.stroke || 0} min={0} max={30} onChange={(v) => up({ stroke: v }, false)} onCommit={(v) => up({ stroke: v })} width={44} />
        {t.stroke > 0 && <ColorSwatch value={t.strokeColor} onChange={(v) => up({ strokeColor: v }, false)} onCommit={(v) => up({ strokeColor: v })} title="Stroke colour" />}
      </div>
      <div className="grid grid-cols-[60px_1fr] gap-x-2 gap-y-1.5 items-center text-[12px]">
        {[['anim_in', 'In'], ['anim_out', 'Out']].map(([k, l]) => (
          <span key={k} className="contents">
            <span className="text-fg2">Animate {l.toLowerCase()}</span>
            <Select small value={t[k] || 'none'} onChange={(v) => up({ [k]: v })} options={[{ value: 'none', label: 'None' }, { value: 'fade', label: 'Fade' }, { value: 'slide_up', label: 'Slide up + fade' }, { value: 'slide_left', label: 'Slide left + fade' }, { value: 'slide_right', label: 'Slide right + fade' }]} />
          </span>
        ))}
        <span className="text-fg2">Duration</span>
        <NumberInput value={t.anim_dur ?? 0.5} step={0.1} min={0.1} max={5} unit="s" onChange={(v) => up({ anim_dur: v }, false)} onCommit={(v) => up({ anim_dur: v })} width={60} />
      </div>
    </PanelSection>
  );
}

export function EffectControls({ ed }) {
  const { doc } = ed;
  const t = useEngineTime(ed.engine);
  if (ed.selTransition) {
    const c = doc.clips.find((x) => x.id === ed.selTransition);
    if (!c?.transition_in) return <Empty />;
    const isAudio = c.type === 'audio';
    const prev = prevAdjacent(doc, c);
    return (
      <div className="p-3 flex flex-col gap-3">
        <div className="text-[13px] font-medium flex items-center gap-2"><Icon name="transition" size={16} />{transitionLabel(c.transition_in.type)}</div>
        <div className="text-[11px] text-fg3">{prev ? `${prev.name || 'Clip'} → ${c.name || 'Clip'}` : `Start of ${c.name || 'clip'}`}</div>
        <Select value={c.transition_in.type} onChange={(v) => ed.setTransition(c.id, { ...c.transition_in, type: v })} options={(isAudio ? AUDIO_TRANSITIONS : VIDEO_TRANSITIONS).map((x) => ({ value: x.type, label: x.label }))} disabled={ed.readOnly} />
        <div className="flex items-center gap-2"><span className="text-[12px] text-fg2 flex-1">Duration</span>
          <NumberInput value={c.transition_in.duration} min={0.1} max={10} step={0.05} unit="s" width={70} disabled={ed.readOnly} onCommit={(v) => ed.setTransition(c.id, { ...c.transition_in, duration: v })} /></div>
        <div className="text-[11px] text-fg3">Centred on the cut. Clips need spare frames (handles) past the cut for a full-length dissolve.</div>
        <Button icon="trash" variant="outline" size="sm" disabled={ed.readOnly} onClick={() => ed.setTransition(c.id, null)}>Remove transition</Button>
      </div>
    );
  }
  const c = ed.sel.size ? doc.clips.find((x) => ed.sel.has(x.id) && x.type !== 'audio') || doc.clips.find((x) => ed.sel.has(x.id)) : null;
  if (!c) return <Empty />;
  const ct = clamp(t - c.start, 0, c.duration);
  const visual = c.type !== 'audio';
  const audioClip = visual ? (c.link ? doc.clips.find((x) => x.link === c.link && x.type === 'audio') : null) : c;
  const up = (patch, label, commit = true) => ed.updateClip(c.id, patch, label, commit);
  return (
    <div>
      <div className="px-3 py-2 border-b border-line">
        <div className="text-[13px] font-medium truncate">{c.name || (c.type === 'title' ? 'Title' : c.type === 'color' ? 'Color Matte' : 'Clip')}</div>
        <div className="text-[11px] text-fg3 font-mono">{timecode(c.start, doc.fps)} → {timecode(clipEnd(c), doc.fps)} · {timecode(c.duration, doc.fps)}</div>
        {!(t >= c.start && t < clipEnd(c)) && <div className="text-[11px] text-warn mt-1">The playhead isn’t over this clip — keyframes are set at its nearest end.</div>}
      </div>
      {c.type === 'title' && <TitleControls ed={ed} c={c} />}
      {c.type === 'color' && (
        <PanelSection title="Color Matte" id="cut-matte">
          <div className="flex items-center gap-2"><span className="text-[12px] text-fg2 flex-1">Colour</span><ColorSwatch value={c.color} alpha={false} onChange={(v) => up({ color: v }, 'Matte colour', false)} onCommit={(v) => up({ color: v }, 'Matte colour')} /></div>
        </PanelSection>
      )}
      {visual && (
        <PanelSection title="Motion" id="cut-motion">
          <KfRow ed={ed} c={c} prop="x" label="Position X" ct={ct} step={1} unit="px" precision={0} />
          <KfRow ed={ed} c={c} prop="y" label="Position Y" ct={ct} step={1} unit="px" precision={0} />
          <KfRow ed={ed} c={c} prop="scale" label="Scale" ct={ct} min={1} max={2000} step={1} unit="%" scale={100} precision={0} />
          <KfRow ed={ed} c={c} prop="rotation" label="Rotation" ct={ct} step={1} unit="°" precision={1} />
          <Button size="xs" variant="ghost" icon="refresh" disabled={ed.readOnly} onClick={() => up({ transform: { x: 0, y: 0, scale: 1, rotation: 0 }, keyframes: { ...c.keyframes, x: undefined, y: undefined, scale: undefined, rotation: undefined } }, 'Reset motion')}>Reset</Button>
        </PanelSection>
      )}
      {visual && (
        <PanelSection title="Opacity" id="cut-opacity">
          <KfRow ed={ed} c={c} prop="opacity" label="Opacity" ct={ct} min={0} max={100} step={1} unit="%" scale={100} precision={0} />
          <div className="grid grid-cols-2 gap-2 mt-1">
            <NumberInput label="Fade in" value={c.fade_in || 0} min={0} max={c.duration / 2} step={0.05} unit="s" width={56} disabled={ed.readOnly} onCommit={(v) => up({ fade_in: v }, 'Fade in')} />
            <NumberInput label="Fade out" value={c.fade_out || 0} min={0} max={c.duration / 2} step={0.05} unit="s" width={56} disabled={ed.readOnly} onCommit={(v) => up({ fade_out: v }, 'Fade out')} />
          </div>
        </PanelSection>
      )}
      {visual && c.type !== 'title' && (
        <PanelSection title="Crop" id="cut-crop" defaultOpen={false}>
          <div className="grid grid-cols-2 gap-2">
            {[['l', 'Left'], ['t', 'Top'], ['r', 'Right'], ['b', 'Bottom']].map(([k, l]) => (
              <NumberInput key={k} label={l} value={Math.round((c.crop?.[k] || 0) * 100)} min={0} max={90} unit="%" width={54} disabled={ed.readOnly}
                onChange={(v) => up({ crop: { ...c.crop, [k]: v / 100 } }, 'Crop', false)} onCommit={(v) => up({ crop: { ...c.crop, [k]: v / 100 } }, 'Crop')} />
            ))}
          </div>
        </PanelSection>
      )}
      {(c.type === 'video' || c.type === 'audio') && (
        <PanelSection title="Speed" id="cut-speed">
          <div className="flex items-center gap-2">
            <NumberInput label="Speed" value={Math.round((c.speed || 1) * 100)} min={5} max={1600} unit="%" width={66} disabled={ed.readOnly} onCommit={(v) => ed.setSpeed(c.id, v / 100)} />
            <span className="text-[11px] text-fg3">Linked clips change too; sound keeps its pitch.</span>
          </div>
        </PanelSection>
      )}
      {audioClip && (
        <PanelSection title="Audio" id="cut-audio">
          <KfRow ed={ed} c={audioClip} prop="volume" label="Volume" ct={clamp(t - audioClip.start, 0, audioClip.duration)} min={-60} max={15} step={0.5} unit="dB" precision={1}
            toDisplay={(g) => Math.max(-60, dB(g))} fromDisplay={fromDb} />
          <div className="flex items-center gap-2 h-8"><span className="w-5" /><span className="text-[12px] text-fg2 w-[70px]">Pan</span>
            <NumberInput value={Math.round((audioClip.pan || 0) * 100)} min={-100} max={100} width={66} disabled={ed.readOnly} onCommit={(v) => ed.updateClip(audioClip.id, { pan: v / 100 }, 'Pan')} /><span className="text-[11px] text-fg3">L −100 … R +100</span></div>
          <div className="grid grid-cols-2 gap-2 mt-1">
            <NumberInput label="Fade in" value={audioClip.fade_in || 0} min={0} max={audioClip.duration / 2} step={0.05} unit="s" width={56} disabled={ed.readOnly} onCommit={(v) => ed.updateClip(audioClip.id, { fade_in: v }, 'Audio fade in')} />
            <NumberInput label="Fade out" value={audioClip.fade_out || 0} min={0} max={audioClip.duration / 2} step={0.05} unit="s" width={56} disabled={ed.readOnly} onCommit={(v) => ed.updateClip(audioClip.id, { fade_out: v }, 'Audio fade out')} />
          </div>
          <div className="mt-2"><Toggle checked={!!audioClip.mute} onChange={(v) => ed.updateClip(audioClip.id, { mute: v }, 'Mute clip')} label="Mute clip" disabled={ed.readOnly} /></div>
        </PanelSection>
      )}
      {visual && (
        <PanelSection title={`Effects (${(c.effects || []).length})`} id="cut-fx" actions={!ed.readOnly && (
          <IconButton icon="plus" label="Add effect" size={22} onClick={(e) => openMenu(e, groups().map(([g, list]) => ({ label: g, items: list.map((x) => ({ label: x.label, onClick: () => ed.addEffect([c.id], x.type) })) })))} />
        )}>
          {(c.effects || []).length ? c.effects.map((e) => <EffectParams key={e.id} ed={ed} c={c} e={e} />) : <div className="text-[12px] text-fg3">Drag an effect here from the Effects panel, or use +.</div>}
        </PanelSection>
      )}
    </div>
  );
}

const Empty = () => <div className="p-6 text-center text-[12px] text-fg3"><Icon name="sliders" size={24} className="mx-auto mb-2" />Select a clip (or a transition) in the timeline to see its controls.</div>;
const groups = () => {
  const g = {};
  for (const e of EFFECTS) (g[e.group] ||= []).push(e);
  return Object.entries(g);
};

// ---------------------------------------------------------------- effects browser

export function EffectsBrowser({ ed }) {
  const [q, setQ] = useState('');
  const match = (l) => !q || l.toLowerCase().includes(q.toLowerCase());
  const Row = ({ label, icon, data, onClick }) => (
    <div draggable={!ed.readOnly} onDragStart={(e) => e.dataTransfer.setData(data[0], data[1])} onDoubleClick={onClick} title="Drag onto a clip, or double-click to apply to the selection"
      className="flex items-center gap-2 h-7 px-3 text-[12px] hover:bg-hover cursor-grab">
      <Icon name={icon} size={14} className="text-fg3" />{label}
    </div>
  );
  const sel = [...ed.sel];
  return (
    <div>
      <div className="p-2 border-b border-line"><TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search effects" className="!h-7 text-[12px]" /></div>
      {groups().map(([g, list]) => list.some((x) => match(x.label)) && (
        <PanelSection key={g} title={`Video Effects · ${g}`} id={`cut-fxg-${g}`}>
          <div className="-mx-3">{list.filter((x) => match(x.label)).map((x) => <Row key={x.type} label={x.label} icon="fx" data={['application/x-cut-effect', x.type]} onClick={() => ed.addEffect(sel, x.type)} />)}</div>
        </PanelSection>
      ))}
      <PanelSection title="Video Transitions" id="cut-vtr">
        <div className="-mx-3">{VIDEO_TRANSITIONS.filter((x) => match(x.label)).map((x) => <Row key={x.type} label={x.label} icon="transition" data={['application/x-cut-transition', x.type]} onClick={() => ed.applyToSelection(x.type)} />)}</div>
      </PanelSection>
      <PanelSection title="Audio Transitions" id="cut-atr">
        <div className="-mx-3">{AUDIO_TRANSITIONS.filter((x) => match(x.label)).map((x) => <Row key={x.type} label={`${x.label} (crossfade)`} icon="wave" data={['application/x-cut-transition', x.type]} onClick={() => ed.applyToSelection(x.type)} />)}</div>
      </PanelSection>
      <div className="p-3 text-[11px] text-fg3">Tip: Ctrl+D adds a Cross Dissolve at the edit nearest the playhead on the selected clip; Ctrl+Shift+D adds an audio crossfade.</div>
    </div>
  );
}

// ---------------------------------------------------------------- meters + mixer

/** A vertical stereo meter drawn from the engine's levels every frame. */
export function Meter({ engine, trackId, height = 140, width = 14 }) {
  const ref = useRef(null);
  useEffect(() => {
    let raf; const hold = [0, 0];
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current; if (!c) return;
      const lv = trackId ? engine.meters.tracks[trackId] || [0, 0] : engine.meters.master;
      const ctx = c.getContext('2d'); const w = c.width; const h = c.height;
      ctx.clearRect(0, 0, w, h);
      const bw = (w - 1) / 2;
      [0, 1].forEach((ch) => {
        const v = engine.playing ? lv[ch] : 0;
        hold[ch] = Math.max(v, hold[ch] * 0.96);
        const db = v > 0 ? 20 * Math.log10(v) : -60;
        const y = h * (1 - clamp((db + 60) / 60, 0, 1));
        const g = ctx.createLinearGradient(0, h, 0, 0);
        g.addColorStop(0, '#2fbf71'); g.addColorStop(0.75, '#e6d34a'); g.addColorStop(1, '#ff4d4d');
        ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(ch * (bw + 1), 0, bw, h);
        ctx.fillStyle = g; ctx.fillRect(ch * (bw + 1), y, bw, h - y);
        const hdb = hold[ch] > 0 ? 20 * Math.log10(hold[ch]) : -60;
        ctx.fillStyle = hdb > -0.5 ? '#ff4d4d' : '#ddd';
        ctx.fillRect(ch * (bw + 1), h * (1 - clamp((hdb + 60) / 60, 0, 1)), bw, 1);
      });
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [engine, trackId]);
  return <canvas ref={ref} width={width} height={height} style={{ width, height }} className="block" />;
}

function Fader({ value, onChange, onCommit, disabled }) {
  // -60..+12 dB on a vertical slider
  const d = Math.max(-60, dB(value));
  return (
    <input type="range" min={-60} max={12} step={0.5} value={Number.isFinite(d) ? d : -60} disabled={disabled} aria-label="Volume"
      onChange={(e) => onChange(fromDb(Number(e.target.value)))} onPointerUp={(e) => onCommit(fromDb(Number(e.target.value)))} onDoubleClick={() => onCommit(1)}
      className="sl-range" style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 18, height: 140 }} />
  );
}

function Strip({ ed, name, value, onChange, onCommit, pan, onPan, id, mute, solo, onMute, onSolo, master }) {
  return (
    <div className={cx('w-[74px] shrink-0 flex flex-col items-center gap-1.5 py-2 border-r border-line', master && 'bg-panel-2')}>
      <span className="text-[11px] font-medium truncate w-full text-center px-1">{name}</span>
      {onPan ? <input type="range" min={-1} max={1} step={0.05} value={pan || 0} title={`Pan ${Math.round((pan || 0) * 100)}`} className="sl-range w-14" disabled={ed.readOnly}
        onChange={(e) => onPan(Number(e.target.value), false)} onPointerUp={(e) => onPan(Number(e.target.value), true)} onDoubleClick={() => onPan(0, true)} /> : <span className="h-4" />}
      <div className="flex items-end gap-1"><Fader value={value} onChange={onChange} onCommit={onCommit} disabled={ed.readOnly} /><Meter engine={ed.engine} trackId={id} height={140} width={12} /></div>
      <span className="text-[10.5px] text-fg2 tabular-nums">{fmtDb(value)}</span>
      {onMute && (
        <div className="flex gap-1">
          <button type="button" onClick={onMute} disabled={ed.readOnly} className={cx('w-6 h-5 rounded text-[10px] font-bold', mute ? 'bg-[#2f8f6b] text-white' : 'bg-chip text-fg2')}>M</button>
          <button type="button" onClick={onSolo} disabled={ed.readOnly} className={cx('w-6 h-5 rounded text-[10px] font-bold', solo ? 'bg-sun text-black' : 'bg-chip text-fg2')}>S</button>
        </div>
      )}
    </div>
  );
}

export function Mixer({ ed }) {
  const { doc } = ed;
  const tracks = tracksOf(doc, 'audio');
  return (
    <div className="flex overflow-x-auto scroll-thin">
      {tracks.map((t) => (
        <Strip ed={ed} key={t.id} id={t.id} name={t.name} value={t.volume ?? 1} pan={t.pan}
          onChange={(v) => ed.updateTrack(t.id, { volume: v }, 'Track volume', { merge: `vol-${t.id}` })} onCommit={(v) => { ed.updateTrack(t.id, { volume: v }, 'Track volume', { merge: `vol-${t.id}` }); ed.commit(); }}
          onPan={(v, commit) => { ed.updateTrack(t.id, { pan: v }, 'Track pan', { merge: `pan-${t.id}` }); if (commit) ed.commit(); }}
          mute={t.mute} solo={t.solo} onMute={() => ed.updateTrack(t.id, { mute: !t.mute }, 'Mute track')} onSolo={() => ed.updateTrack(t.id, { solo: !t.solo }, 'Solo track')} />
      ))}
      <Strip ed={ed} master name="Master" value={doc.master ?? 1} id={null}
        onChange={(v) => ed.set({ ...ed.doc, master: v }, 'Master volume', { merge: 'master' })} onCommit={(v) => { ed.set({ ...ed.doc, master: v }, 'Master volume', { merge: 'master' }); ed.commit(); }} />
    </div>
  );
}

// ---------------------------------------------------------------- markers

export function MarkersPanel({ ed }) {
  const { doc } = ed;
  const list = [...(doc.markers || [])].sort((a, b) => a.t - b.t);
  return (
    <div>
      <div className="p-2 flex gap-2 border-b border-line"><Button size="sm" icon="marker" disabled={ed.readOnly} onClick={ed.addMarker}>Add marker (M)</Button></div>
      {!list.length && <div className="p-4 text-[12px] text-fg3">Press M to drop a marker at the playhead.</div>}
      {list.map((m) => (
        <div key={m.id} className="flex items-center gap-2 h-9 px-2 border-b border-line/60 hover:bg-hover cursor-pointer" onClick={() => ed.engine.seek(m.t)}>
          <span className="w-2.5 h-2.5 rotate-45 shrink-0" style={{ background: m.color || '#3ccf8e' }} />
          <span className="font-mono text-[11px] text-accent">{timecode(m.t, doc.fps)}</span>
          <span className="flex-1 truncate text-[12px]">{m.name || 'Marker'}</span>
          <IconButton icon="edit" label="Edit marker" size={22} disabled={ed.readOnly} onClick={(e) => { e.stopPropagation(); ed.editMarker(m); }} />
          <IconButton icon="trash" label="Delete marker" size={22} disabled={ed.readOnly} onClick={(e) => { e.stopPropagation(); ed.deleteMarker(m.id); }} />
        </div>
      ))}
    </div>
  );
}

export function RightPanels({ ed }) {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('cut-panel') || 'controls'; } catch { return 'controls'; } });
  const set = (t) => { setTab(t); try { localStorage.setItem('cut-panel', t); } catch { /* private mode */ } };
  useEffect(() => { if (ed.panelRequest?.tab) set(ed.panelRequest.tab); }, [ed.panelRequest]);
  return (
    <div className="h-full flex flex-col">
      <Tabs className="px-1 shrink-0 sticky top-0 bg-panel z-10" value={tab} onChange={set} tabs={[{ value: 'controls', label: 'Controls' }, { value: 'effects', label: 'Effects' }, { value: 'mixer', label: 'Mixer' }, { value: 'markers', label: 'Markers' }]} />
      <div className="flex-1 min-h-0">
        {tab === 'controls' && <EffectControls ed={ed} />}
        {tab === 'effects' && <EffectsBrowser ed={ed} />}
        {tab === 'mixer' && <Mixer ed={ed} />}
        {tab === 'markers' && <MarkersPanel ed={ed} />}
      </div>
    </div>
  );
}
