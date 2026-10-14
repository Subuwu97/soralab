// Source monitor (look at a clip from the Project panel, mark In/Out, then Insert or Overwrite into the timeline) and
// Program monitor (the sequence, drawn by the Engine, with safe margins and direct drag-to-position of the selected clip).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconButton, Select, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { assetSrc } from '../../lib/doc.js';
import { timecode, parseTimecode, clipEnd, valueAt, setValueAt, STILL_DURATION, clamp } from './model.js';
import { getPeaks, drawPeaks } from '../_media/media.js';

/** Fits a W×H box inside the element, returning its CSS size. */
function useFit(ref, W, H) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const f = () => { const r = el.getBoundingClientRect(); const k = Math.min(r.width / W, r.height / H); setBox({ w: Math.max(1, Math.floor(W * k)), h: Math.max(1, Math.floor(H * k)) }); };
    const ro = new ResizeObserver(f); ro.observe(el); f();
    return () => ro.disconnect();
  }, [ref, W, H]);
  return box;
}

function Timecode({ value, fps, onSet, className }) {
  const [edit, setEdit] = useState(null);
  if (edit !== null) {
    return <input autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} onBlur={() => setEdit(null)} className={cx('w-[96px] bg-input border border-accent rounded px-1 font-mono text-[13px]', className)}
      onKeyDown={(e) => { if (e.key === 'Enter') { const t = parseTimecode(edit, fps); if (t !== null) onSet(t); setEdit(null); } if (e.key === 'Escape') setEdit(null); e.stopPropagation(); }} />;
  }
  return <button type="button" title="Click to type a time" onClick={() => onSet && setEdit(timecode(value, fps))} className={cx('font-mono text-[13px] tabular-nums text-accent', className)}>{timecode(value, fps)}</button>;
}

function Transport({ children }) {
  return <div className="h-9 shrink-0 flex items-center gap-0.5 px-2 border-t border-line bg-panel">{children}</div>;
}

// ---------------------------------------------------------------- program monitor

export function ProgramMonitor({ ed }) {
  const { doc, engine } = ed;
  const wrap = useRef(null);
  const canvas = useRef(null);
  const box = useFit(wrap, doc.width, doc.height);
  const [t, setT] = useState(engine.t);
  const [playing, setPlaying] = useState(false);
  useEffect(() => engine.subscribe((x) => { setT(x); setPlaying(engine.playing); }), [engine]);
  // Canvas resolution: what's on screen (× device pixels), capped by the playback resolution setting.
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !box.w) return;
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(1, (box.w * dpr) / doc.width) * ed.quality;
    c.width = Math.max(2, Math.round(doc.width * k)); c.height = Math.max(2, Math.round(doc.height * k));
    engine.attach(c);
  }, [box.w, doc.width, doc.height, ed.quality, engine]);

  // Drag the selected visual clip to reposition it (sets a keyframe if Position is animated).
  const sel = ed.sel.size === 1 ? doc.clips.find((c) => ed.sel.has(c.id) && c.type !== 'audio') : null;
  const onDown = (e) => {
    ed.focus('timeline');
    if (!sel || ed.readOnly || !(engine.t >= sel.start && engine.t < clipEnd(sel))) return;
    e.preventDefault();
    const k = doc.width / box.w;
    const x0 = e.clientX; const y0 = e.clientY; const ct = engine.t - sel.start;
    const bx = valueAt(sel, 'x', ct); const by = valueAt(sel, 'y', ct);
    const base = doc; const key = `pos-${Date.now()}`;
    const mv = (ev) => {
      let c = setValueAt(sel, 'x', ct, Math.round(bx + (ev.clientX - x0) * k));
      c = setValueAt(c, 'y', ct, Math.round(by + (ev.clientY - y0) * k));
      ed.set({ ...base, clips: base.clips.map((x) => (x.id === sel.id ? c : x)) }, 'Position', { merge: key });
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); ed.commit(); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const fps = doc.fps;
  const step = (n) => { engine.pause(); engine.seek(Math.max(0, Math.round((engine.t + n / fps) * fps) / fps)); };
  return (
    <div className="h-full flex flex-col min-w-0" onPointerDown={() => ed.focus('timeline')}>
      <div className="h-7 shrink-0 flex items-center gap-2 px-2 bg-panel border-b border-line text-[12px]">
        <span className={cx('font-medium', ed.focused === 'timeline' ? 'text-fg' : 'text-fg2')}>Program</span>
        <span className="text-fg3">{doc.width}×{doc.height} · {doc.fps} fps</span>
        <span className="flex-1" />
        <Select small value={String(ed.quality)} onChange={(v) => ed.setQuality(Number(v))} options={[{ value: '1', label: 'Full' }, { value: '0.5', label: '1/2' }, { value: '0.25', label: '1/4' }]} title="Playback resolution" />
        <IconButton icon="guides" label="Safe margins" size={24} active={ed.safe} onClick={() => ed.setSafe(!ed.safe)} />
      </div>
      <div ref={wrap} className="flex-1 min-h-0 grid place-items-center bg-[#08090d] overflow-hidden relative">
        <div className="relative" style={{ width: box.w, height: box.h }}>
          <canvas ref={canvas} onPointerDown={onDown} className={cx('block w-full h-full bg-black', sel && 'cursor-move')} />
          {ed.safe && (
            <>
              <div className="absolute border border-white/45 pointer-events-none" style={{ inset: '5%' }} />
              <div className="absolute border border-white/30 pointer-events-none" style={{ inset: '10%' }} />
              <div className="absolute left-1/2 top-1/2 w-4 h-px -ml-2 bg-white/40 pointer-events-none" /><div className="absolute left-1/2 top-1/2 h-4 w-px -mt-2 bg-white/40 pointer-events-none" />
            </>
          )}
        </div>
      </div>
      <Transport>
        <Timecode value={t} fps={fps} onSet={(x) => engine.seek(x)} className="mr-2" />
        <span className="flex-1" />
        <IconButton icon="marker" label="Add marker (M)" size={28} onClick={ed.addMarker} disabled={ed.readOnly} />
        <IconButton label="Mark In (I)" size={28} onClick={() => ed.markIO('in')}><span className="font-bold text-[13px]">{'{'}</span></IconButton>
        <IconButton label="Mark Out (O)" size={28} onClick={() => ed.markIO('out')}><span className="font-bold text-[13px]">{'}'}</span></IconButton>
        <IconButton icon="skipBack" label="Previous edit (↑)" size={28} onClick={() => ed.jumpEdit(-1)} />
        <IconButton icon="chevronLeft" label="Step back (←)" size={28} onClick={() => step(-1)} />
        <IconButton icon={playing ? 'pause' : 'play'} label="Play / Pause (Space)" size={32} onClick={() => engine.toggle()} className="bg-chip" />
        <IconButton icon="chevronRight" label="Step forward (→)" size={28} onClick={() => step(1)} />
        <IconButton icon="skipForward" label="Next edit (↓)" size={28} onClick={() => ed.jumpEdit(1)} />
        <IconButton icon="camera" label="Export frame (PNG)" size={28} onClick={ed.exportFrame} />
        <span className="flex-1" />
        <span className="font-mono text-[12px] text-fg3 tabular-nums">{timecode(ed.duration, fps)}</span>
      </Transport>
    </div>
  );
}

// ---------------------------------------------------------------- source monitor

export function SourceMonitor({ ed }) {
  const { doc } = ed;
  const m = ed.source ? doc.media.find((x) => x.id === ed.source) : null;
  const media = useRef(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const fps = m?.fps || doc.fps;
  const dur = m ? (m.kind === 'image' ? STILL_DURATION : m.duration || 0) : 0;
  const wave = useRef(null);
  useEffect(() => { setT(m?.mark_in || 0); setPlaying(false); }, [m?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!m || m.kind !== 'audio' || !wave.current) return;
    getPeaks(m.id).then((d) => { const c = wave.current; if (!c) return; c.width = c.clientWidth; c.height = c.clientHeight; drawPeaks(c, d, 0, d.duration, { color: 'rgba(60,207,142,.8)' }); });
  }, [m?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Expose controls so the editor's shortcuts (Space, J/K/L, I/O, arrows) work when the source monitor has focus.
  ed.sourceApi.current = m ? {
    toggle: () => { const el = media.current; if (!el?.play) return; if (el.paused) el.play().catch(() => {}); else el.pause(); },
    seek: (x) => { const v = clamp(x, 0, dur); setT(v); if (media.current?.play) media.current.currentTime = v; },
    step: (n) => { const el = media.current; el?.pause?.(); const v = clamp(Math.round((t + n / fps) * fps) / fps, 0, dur); setT(v); if (el?.play) el.currentTime = v; },
    shuttle: (dir) => { const el = media.current; if (!el?.play) return; if (dir === 0) el.pause(); else if (dir > 0) { el.playbackRate = el.paused ? 1 : Math.min(8, el.playbackRate * 2); el.play().catch(() => {}); } else { el.pause(); const v = Math.max(0, t - 1); setT(v); el.currentTime = v; } },
    t: () => t,
  } : null;
  useEffect(() => {
    const el = media.current;
    if (!el?.play) return undefined;
    let raf;
    const tick = () => { setT(el.currentTime); if (m?.mark_out != null && el.currentTime >= m.mark_out && !el.paused) el.pause(); raf = requestAnimationFrame(tick); };
    const on = () => { setPlaying(true); raf = requestAnimationFrame(tick); };
    const off = () => { setPlaying(false); cancelAnimationFrame(raf); setT(el.currentTime); };
    el.addEventListener('play', on); el.addEventListener('pause', off); el.addEventListener('ended', off);
    return () => { cancelAnimationFrame(raf); el.removeEventListener('play', on); el.removeEventListener('pause', off); el.removeEventListener('ended', off); };
  }, [m?.id, m?.mark_out]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrubBar = useRef(null);
  const scrub = (e) => {
    const go = (ev) => { const r = scrubBar.current.getBoundingClientRect(); ed.sourceApi.current?.seek(((ev.clientX - r.left) / r.width) * dur); };
    media.current?.pause?.();
    go(e);
    const up = () => { window.removeEventListener('pointermove', go); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', go); window.addEventListener('pointerup', up);
  };
  const inn = m?.mark_in; const out = m?.mark_out;
  return (
    <div className="h-full flex flex-col min-w-0" onPointerDown={() => ed.focus('source')}>
      <div className="h-7 shrink-0 flex items-center gap-2 px-2 bg-panel border-b border-line text-[12px]">
        <span className={cx('font-medium', ed.focused === 'source' ? 'text-fg' : 'text-fg2')}>Source{m ? ':' : ''}</span>
        <span className="text-fg2 truncate">{m?.name || ''}</span>
      </div>
      <div className="flex-1 min-h-0 grid place-items-center bg-[#08090d] overflow-hidden relative">
        {!m ? <div className="text-fg3 text-sm text-center px-6"><Icon name="video" size={26} className="mx-auto mb-2" />Double-click a clip in the Project panel to view it here.</div>
          : m.kind === 'video' ? <video key={m.id} ref={media} src={assetSrc(m.id)} className="max-w-full max-h-full" preload="auto" playsInline onLoadedMetadata={(e) => { e.currentTarget.currentTime = t; }} />
            : m.kind === 'audio' ? <div className="w-full h-full relative"><canvas ref={wave} className="absolute inset-0 w-full h-full" /><audio key={m.id} ref={media} src={assetSrc(m.id)} preload="auto" /></div>
              : <img src={assetSrc(m.id)} alt="" className="max-w-full max-h-full" />}
        {m && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
            {m.kind === 'video' && (
              <>
                <span draggable title="Drag video only" className="h-6 px-2 rounded bg-black/60 text-[11px] text-white flex items-center gap-1 cursor-grab"
                  onDragStart={(e) => { e.dataTransfer.setData('application/x-cut-media', JSON.stringify({ ids: [m.id], only: 'video', range: { in: inn ?? 0, out: out ?? dur } })); ed.dragInfo.current = { duration: (out ?? dur) - (inn ?? 0) }; }}><Icon name="video" size={12} />Video</span>
                {m.has_audio && <span draggable title="Drag audio only" className="h-6 px-2 rounded bg-black/60 text-[11px] text-white flex items-center gap-1 cursor-grab"
                  onDragStart={(e) => { e.dataTransfer.setData('application/x-cut-media', JSON.stringify({ ids: [m.id], only: 'audio', range: { in: inn ?? 0, out: out ?? dur } })); ed.dragInfo.current = { duration: (out ?? dur) - (inn ?? 0) }; }}><Icon name="audio" size={12} />Audio</span>}
              </>
            )}
          </div>
        )}
      </div>
      {/* scrub bar with the In/Out range */}
      <div ref={scrubBar} className="h-4 shrink-0 relative bg-panel-2 cursor-pointer" onPointerDown={m ? scrub : undefined}>
        {m && dur > 0 && (inn != null || out != null) && <div className="absolute top-0 bottom-0 bg-accent/30" style={{ left: `${((inn ?? 0) / dur) * 100}%`, right: `${100 - ((out ?? dur) / dur) * 100}%` }} />}
        {m && dur > 0 && <div className="absolute top-0 bottom-0 w-0.5 bg-[#ff4d6a]" style={{ left: `${(t / dur) * 100}%` }} />}
      </div>
      <Transport>
        <Timecode value={t} fps={fps} onSet={(x) => ed.sourceApi.current?.seek(x)} />
        <span className="flex-1" />
        <IconButton label="Mark In (I)" size={28} disabled={!m} onClick={() => ed.markSource('in', t)}><span className="font-bold text-[13px]">{'{'}</span></IconButton>
        <IconButton label="Mark Out (O)" size={28} disabled={!m} onClick={() => ed.markSource('out', t)}><span className="font-bold text-[13px]">{'}'}</span></IconButton>
        <IconButton icon="chevronLeft" label="Step back" size={28} disabled={!m} onClick={() => ed.sourceApi.current?.step(-1)} />
        <IconButton icon={playing ? 'pause' : 'play'} label="Play / Pause" size={32} disabled={!m || m.kind === 'image'} onClick={() => ed.sourceApi.current?.toggle()} className="bg-chip" />
        <IconButton icon="chevronRight" label="Step forward" size={28} disabled={!m} onClick={() => ed.sourceApi.current?.step(1)} />
        <IconButton icon="import" label="Insert (,)" size={28} disabled={!m || ed.readOnly} onClick={() => ed.sourceEdit('insert')} />
        <IconButton icon="download" label="Overwrite (.)" size={28} disabled={!m || ed.readOnly} onClick={() => ed.sourceEdit('overwrite')} />
        <span className="flex-1" />
        <span className="font-mono text-[12px] text-fg3 tabular-nums" title="In–Out duration">{m ? timecode((out ?? dur) - (inn ?? 0), fps) : ''}</span>
      </Transport>
    </div>
  );
}
