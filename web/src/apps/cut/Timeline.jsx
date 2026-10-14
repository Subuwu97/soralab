// The timeline: a ruler (playhead, markers, In/Out), video tracks (top = highest) above audio tracks, track headers with
// eye / lock / mute / solo, and clips with filmstrips and waveforms. One scroll container holds it all; the headers and
// ruler stick to its edges. Every tool's drag is computed from the document at pointer-down so each drag is one undo step.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconButton, openMenu, promptDialog, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { tracksOf, clipsOn, clipEnd, splitClip, editPoints, uid, EPS, timecode, transitionLabel, trackById, fitsTrack, closeGap } from './model.js';
import { trim, ripple, roll, slip, slide, move } from './edits.js';
import { getPeaks, frameUrl, drawPeaks } from '../_media/media.js';

const HEAD = 176;
const RULER = 28;
const ROW = { video: 58, audio: 58 };
const SNAP_PX = 9;
const TYPE_COLORS = { video: '#5b5bd6', image: '#7a55c9', title: '#c2508a', color: '#c0662e', audio: '#2f8f6b' };

/** Window drag helper: calls move(dx, dy, e) then up(e). */
function drag(e, onMove, onUp, threshold = 0) {
  const x0 = e.clientX; const y0 = e.clientY;
  let started = threshold === 0;
  const mv = (ev) => {
    if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < threshold) return;
    started = true;
    onMove(ev.clientX - x0, ev.clientY - y0, ev);
  };
  const up = (ev) => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); onUp?.(ev, started); };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
}

function niceStep(pps) {
  const steps = [1 / 30, 2 / 30, 5 / 30, 10 / 30, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  return steps.find((s) => s * pps >= 70) || 3600;
}

// ---------------------------------------------------------------- ruler

function Ruler({ ed, pps, scrollLeft, width, onScrub }) {
  const ref = useRef(null);
  const { doc } = ed;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr); c.height = RULER * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, RULER);
    const t0 = scrollLeft / pps; const t1 = (scrollLeft + width) / pps;
    // In/Out range
    const { in: i, out: o } = doc.io || {};
    if (i != null || o != null) {
      const a = ((i ?? 0) * pps) - scrollLeft; const b = ((o ?? Math.max(t1, (i ?? 0))) * pps) - scrollLeft;
      ctx.fillStyle = 'rgba(90,180,255,.22)'; ctx.fillRect(a, 0, b - a, RULER);
      ctx.fillStyle = '#5AB4FF';
      if (i != null) ctx.fillRect(a, 0, 2, RULER);
      if (o != null) ctx.fillRect(b - 2, 0, 2, RULER);
    }
    const step = niceStep(pps);
    const minor = step / 5;
    ctx.strokeStyle = 'rgba(160,170,200,.45)'; ctx.fillStyle = 'rgba(200,205,225,.85)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * pps - scrollLeft) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.moveTo(x, RULER); ctx.lineTo(x, major ? RULER - 12 : RULER - 5);
      if (major) ctx.fillText(timecode(t, doc.fps).replace(/^00:/, ''), x + 3, 11);
    }
    ctx.stroke();
    for (const m of doc.markers || []) {
      const x = m.t * pps - scrollLeft;
      if (x < -10 || x > width + 10) continue;
      ctx.fillStyle = m.color || '#3ccf8e';
      ctx.beginPath(); ctx.moveTo(x - 5, 14); ctx.lineTo(x + 5, 14); ctx.lineTo(x + 5, 21); ctx.lineTo(x, 26); ctx.lineTo(x - 5, 21); ctx.closePath(); ctx.fill();
    }
  }, [doc.io, doc.markers, doc.fps, pps, scrollLeft, width]);
  return (
    <canvas ref={ref} style={{ width, height: RULER, position: 'sticky', left: HEAD }} className="block cursor-text"
      onPointerDown={onScrub}
      onDoubleClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const t = (e.clientX - r.left + scrollLeft) / pps;
        const m = (ed.doc.markers || []).find((x) => Math.abs(x.t - t) * pps < 6);
        if (m) ed.editMarker(m);
      }} />
  );
}

// ---------------------------------------------------------------- clip contents

const Filmstrip = memo(({ c, pps, visA, visB, h }) => {
  // Thumbnails at a fixed width, only for the part on screen.
  const tw = Math.round(h * 16 / 9);
  const x0 = Math.max(0, Math.floor((visA - c.start) * pps / tw)); const x1 = Math.ceil((Math.min(visB, clipEnd(c)) - c.start) * pps / tw);
  const out = [];
  const step = Math.max(0.25, Math.min(4, tw / pps / 2));
  for (let i = x0; i < x1 && out.length < 60; i++) {
    const t = (c.in || 0) + ((i * tw + tw / 2) / pps) * (c.speed || 1);
    out.push(<img key={i} src={frameUrl(c.asset_id, t, 160, step)} alt="" draggable={false} loading="lazy"
      style={{ position: 'absolute', left: i * tw, top: 0, width: tw, height: h, objectFit: 'cover' }} />);
  }
  return <div className="absolute inset-0 overflow-hidden opacity-80 pointer-events-none">{out}</div>;
});

function Waveform({ c, pps, visA, visB, h }) {
  const ref = useRef(null);
  const [data, setData] = useState(null);
  useEffect(() => { let off = false; getPeaks(c.asset_id).then((d) => { if (!off) setData(d); }); return () => { off = true; }; }, [c.asset_id]);
  const a = Math.max(c.start, visA - 50 / pps); const b = Math.min(clipEnd(c), visB + 50 / pps);
  const w = Math.max(0, Math.min(6000, Math.round((b - a) * pps)));
  useLayoutEffect(() => {
    if (!ref.current || !w) return;
    ref.current.width = w; ref.current.height = h;
    const sp = c.speed || 1;
    drawPeaks(ref.current, data, (c.in || 0) + (a - c.start) * sp, (c.in || 0) + (b - c.start) * sp, { color: 'rgba(220,255,236,.78)', gain: c.volume ?? 1 });
  }, [data, w, h, a, b, c.in, c.speed, c.start, c.volume]);
  if (!w) return null;
  return <canvas ref={ref} className="absolute pointer-events-none" style={{ left: (a - c.start) * pps, top: 0, width: w, height: h }} />;
}

const ClipView = memo(({ c, pps, selected, visA, visB, h, readOnly, missing }) => {
  const x = c.start * pps; const w = Math.max(2, c.duration * pps);
  const color = TYPE_COLORS[c.type] || '#555';
  const fade = (v) => Math.min(w / 2, (v || 0) * pps);
  return (
    <div data-clip={c.id} className={cx('absolute top-[3px] rounded-[4px] overflow-hidden group', selected ? 'ring-2 ring-white z-[2]' : 'ring-1 ring-black/40')}
      style={{ left: x, width: w, height: h - 6, background: `linear-gradient(${color}, ${color}cc)` }}>
      {c.type === 'video' && w > 20 && <div className="absolute inset-x-0 top-4 bottom-0"><Filmstrip c={c} pps={pps} visA={visA} visB={visB} h={h - 22} /></div>}
      {c.type === 'image' && <div className="absolute inset-x-0 top-4 bottom-0 opacity-70 pointer-events-none" style={{ backgroundImage: `url(/api/assets/${c.asset_id}/thumb)`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x' }} />}
      {c.type === 'audio' && w > 4 && <div className="absolute inset-x-0 top-3.5 bottom-0"><Waveform c={c} pps={pps} visA={visA} visB={visB} h={h - 20} /></div>}
      {c.type === 'color' && <div className="absolute inset-x-1 top-5 bottom-1 rounded-sm pointer-events-none" style={{ background: c.color }} />}
      {c.type === 'title' && <div className="absolute inset-x-1 top-4 bottom-0 text-[11px] text-white/85 truncate pointer-events-none flex items-center gap-1"><Icon name="text" size={12} />{(c.title?.text || '').split('\n')[0]}</div>}
      <div className="absolute inset-x-0 top-0 h-4 px-1.5 text-[10.5px] leading-4 text-white truncate pointer-events-none bg-black/25 flex items-center gap-1">
        {c.link && <Icon name="link" size={10} />}{missing && <Icon name="warning" size={10} />}
        {(c.effects || []).length > 0 && <span className="text-[9px] font-bold text-sun">fx</span>}
        <span className="truncate">{c.name || (c.type === 'title' ? 'Title' : c.type === 'color' ? 'Color Matte' : '')}</span>
        {(c.speed || 1) !== 1 && <span className="text-white/70">{Math.round((c.speed || 1) * 100)}%</span>}
      </div>
      {/* fade ramps */}
      {c.fade_in > 0 && <svg className="absolute left-0 top-0 pointer-events-none" width={fade(c.fade_in)} height={h - 6} preserveAspectRatio="none" viewBox="0 0 10 10"><path d="M0 10L10 0V10Z" fill="rgba(0,0,0,.35)" /></svg>}
      {c.fade_out > 0 && <svg className="absolute right-0 top-0 pointer-events-none" width={fade(c.fade_out)} height={h - 6} preserveAspectRatio="none" viewBox="0 0 10 10"><path d="M0 0L10 10H0Z" fill="rgba(0,0,0,.35)" /></svg>}
      {!readOnly && (
        <>
          <div data-part="left" className="absolute left-0 top-0 bottom-0 w-[6px] cursor-ew-resize hover:bg-white/30" />
          <div data-part="right" className="absolute right-0 top-0 bottom-0 w-[6px] cursor-ew-resize hover:bg-white/30" />
          {w > 40 && <div data-part="fadein" title="Drag to fade in" className="absolute top-0 w-2.5 h-2.5 bg-white/80 rounded-br-sm opacity-0 group-hover:opacity-100 cursor-pointer" style={{ left: fade(c.fade_in) }} />}
          {w > 40 && <div data-part="fadeout" title="Drag to fade out" className="absolute top-0 w-2.5 h-2.5 bg-white/80 rounded-bl-sm opacity-0 group-hover:opacity-100 cursor-pointer" style={{ right: fade(c.fade_out) }} />}
        </>
      )}
    </div>
  );
});

// ---------------------------------------------------------------- track header

function TrackHeader({ ed, track, h }) {
  const { readOnly } = ed;
  const set = (patch, label) => ed.updateTrack(track.id, patch, label);
  const T = ({ on, icon, label, onClick, text, tone }) => (
    <button type="button" title={label} aria-pressed={on} onClick={onClick} disabled={readOnly}
      className={cx('w-6 h-6 rounded grid place-items-center text-[11px] font-bold transition shrink-0', on ? tone || 'bg-accent text-[#06121f]' : 'text-fg2 hover:bg-hover hover:text-fg')}>
      {icon ? <Icon name={icon} size={14} /> : text}
    </button>
  );
  const isVideo = track.kind === 'video';
  return (
    <div className={cx('h-full flex items-center gap-0.5 px-1.5 border-r border-line', ed.targets?.has(track.id) ? 'bg-panel-2' : 'bg-panel')} style={{ height: h }}
      onContextMenu={(e) => openMenu(e, [
        { label: 'Rename…', icon: 'edit', disabled: readOnly, onClick: async () => { const n = await promptDialog({ title: 'Rename track', label: 'Name', value: track.name }); if (n) set({ name: n }, 'Rename track'); } },
        { label: `Add ${isVideo ? 'video' : 'audio'} track`, icon: 'plus', disabled: readOnly, onClick: () => ed.addTrack(track.kind) },
        { label: 'Delete track', icon: 'trash', danger: true, disabled: readOnly || tracksOf(ed.doc, track.kind).length < 2, onClick: () => ed.deleteTrack(track.id) },
      ])}>
      <button type="button" className={cx('w-9 h-6 rounded text-[11px] font-bold shrink-0', ed.targets?.has(track.id) ? 'bg-accent-2 text-white' : 'bg-chip text-fg2')}
        title="Target track (where Insert / Overwrite place clips)" onClick={() => ed.toggleTarget(track.id)}>{track.name.slice(0, 4)}</button>
      {isVideo ? <T on={!track.hidden} icon={track.hidden ? 'eyeOff' : 'eye'} label="Toggle track output" onClick={() => set({ hidden: !track.hidden }, 'Toggle track output')} tone="bg-transparent text-fg" />
        : <T on={track.mute} text="M" label="Mute track" onClick={() => set({ mute: !track.mute }, 'Mute track')} tone="bg-[#2f8f6b] text-white" />}
      <T on={track.solo} text="S" label="Solo track" onClick={() => set({ solo: !track.solo }, 'Solo track')} tone="bg-sun text-black" />
      {isVideo && <T on={track.mute} text="M" label="Mute this track’s clip sound" onClick={() => set({ mute: !track.mute }, 'Mute track')} tone="bg-[#2f8f6b] text-white" />}
      <T on={track.lock} icon={track.lock ? 'lock' : 'unlock'} label="Lock track" onClick={() => set({ lock: !track.lock }, 'Lock track')} tone="bg-danger/80 text-white" />
      <span className="flex-1 min-w-0 text-[11px] text-fg3 truncate pl-1" onDoubleClick={async () => { if (readOnly) return; const n = await promptDialog({ title: 'Rename track', label: 'Name', value: track.name }); if (n) set({ name: n }, 'Rename track'); }}>
        {track.name.length > 4 ? track.name : ''}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- timeline

export default function Timeline({ ed }) {
  const { doc, engine, pps, setPps, readOnly } = ed;
  const scroller = useRef(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [vw, setVw] = useState(800);
  const [snapX, setSnapX] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [ghost, setGhost] = useState(null);
  const playhead = useRef(null);
  const ppsRef = useRef(pps); ppsRef.current = pps;

  const video = tracksOf(doc, 'video'); const audio = tracksOf(doc, 'audio');
  const rows = useMemo(() => [...[...video].reverse(), ...audio], [video, audio]);
  const duration = Math.max(...doc.clips.map(clipEnd), 0);
  const contentW = Math.max(vw - HEAD, (duration + 30) * pps);
  const visA = scrollLeft / pps; const visB = (scrollLeft + vw) / pps;

  useLayoutEffect(() => {
    const el = scroller.current;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el); setVw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Playhead: moved directly (no re-render) and followed while playing.
  useEffect(() => engine.subscribe((t) => {
    const el = playhead.current; const sc = scroller.current;
    if (!el || !sc) return;
    const x = t * ppsRef.current;
    el.style.transform = `translateX(${x}px)`;
    el.style.visibility = x < sc.scrollLeft - 1 ? 'hidden' : 'visible'; // behind the track headers
    if (engine.playing) {
      const vis = sc.clientWidth - HEAD;
      if (x > sc.scrollLeft + vis - 40) sc.scrollLeft = x - 60;
      else if (x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - vis + 60);
    }
  }), [engine]);
  useLayoutEffect(() => {
    if (!playhead.current) return;
    playhead.current.style.transform = `translateX(${engine.t * pps}px)`;
    playhead.current.style.visibility = engine.t * pps < scrollLeft - 1 ? 'hidden' : 'visible';
  }, [pps, engine, scrollLeft]);

  // Zoom keeping a point (time under the mouse, or the playhead) in place.
  const zoomTo = useCallback((next, anchorT, anchorX) => {
    const p = Math.max(0.5, Math.min(2000, next));
    setPps(p);
    requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollLeft = Math.max(0, anchorT * p - anchorX); });
  }, [setPps]);
  ed.timelineApi.current = {
    zoom: (f) => { const t = engine.t; const sc = scroller.current; zoomTo(pps * f, t, t * pps - sc.scrollLeft); },
    fit: () => { const w = (scroller.current?.clientWidth || 800) - HEAD - 40; zoomTo(w / Math.max(5, duration), 0, 0); },
    reveal: (t) => { const sc = scroller.current; if (!sc) return; const x = t * pps; if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - HEAD - 20) sc.scrollLeft = Math.max(0, x - (sc.clientWidth - HEAD) / 2); },
  };
  useEffect(() => {
    const el = scroller.current;
    const wheel = (e) => {
      if (!e.altKey && !e.ctrlKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left - HEAD;
      const t = (x + el.scrollLeft) / ppsRef.current;
      zoomTo(ppsRef.current * (e.deltaY < 0 ? 1.2 : 1 / 1.2), t, x);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomTo]);

  const tAt = (clientX) => {
    const r = scroller.current.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - HEAD + scroller.current.scrollLeft) / pps);
  };
  const rowAt = (clientY) => {
    const r = scroller.current.getBoundingClientRect();
    let y = clientY - r.top - RULER + scroller.current.scrollTop;
    for (const t of rows) { const h = ROW[t.kind] + (t === audio[0] ? 6 : 0); if (y < h) return t; y -= h; }
    return null;
  };

  // Snapping: playhead, edit points, markers and In/Out within a few pixels.
  const snapPoints = useCallback((exclude = new Set()) => {
    const pts = [engine.t, ...(doc.markers || []).map((m) => m.t)];
    if (doc.io?.in != null) pts.push(doc.io.in);
    if (doc.io?.out != null) pts.push(doc.io.out);
    for (const c of doc.clips) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
    return pts;
  }, [doc, engine]);
  const snapT = (t, pts) => {
    if (!ed.snap) return { t, hit: null };
    let best = null;
    for (const p of pts) if (Math.abs(p - t) * pps < SNAP_PX && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
    return best === null ? { t, hit: null } : { t: best, hit: best };
  };
  const snapDelta = (edges, dt, pts) => {
    if (!ed.snap) return { dt, hit: null };
    let best = null;
    for (const e of edges) for (const p of pts) { const d = p - (e + dt); if (Math.abs(d) * pps < SNAP_PX && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, p }; }
    return best ? { dt: dt + best.d, hit: best.p } : { dt, hit: null };
  };

  const group = (c, alt) => {
    const ids = new Set([c.id]);
    if (c.link && ed.linkedSel && !alt) for (const x of doc.clips) if (x.link === c.link) ids.add(x.id);
    return ids;
  };
  const locked = (c) => trackById(doc, c.track)?.lock;

  const scrub = (e) => {
    e.preventDefault();
    const pts = editPoints(doc).concat((doc.markers || []).map((m) => m.t));
    const go = (ev) => { const t = tAt(ev.clientX); const s = ev.shiftKey || ed.snap ? snapT(t, pts) : { t }; engine.seek(Math.round(s.t * doc.fps) / doc.fps); };
    engine.pause();
    go(e);
    drag(e, (_dx, _dy, ev) => go(ev));
  };

  const onLaneDown = (e, track) => {
    if (e.button !== 0) return;
    ed.focus('timeline');
    const tool = ed.tool;
    const el = e.target.closest('[data-clip]');
    const part = e.target.closest('[data-part]')?.dataset.part || 'body';
    const c = el ? doc.clips.find((x) => x.id === el.dataset.clip) : null;
    const t = tAt(e.clientX);
    const key = uid('drag');
    const commit = () => { ed.commit(); setSnapX(null); };

    if (tool === 'hand' || e.button === 1) {
      const s0 = scroller.current.scrollLeft;
      drag(e, (dx) => { scroller.current.scrollLeft = s0 - dx; });
      return;
    }
    if (tool === 'zoom') { const x = e.clientX - scroller.current.getBoundingClientRect().left - HEAD; zoomTo(pps * (e.altKey ? 1 / 1.6 : 1.6), t, x); return; }
    if (!c) {
      // Empty track: a marquee, or a click that selects the gap under it.
      ed.setSelTransition(null);
      const r = scroller.current.getBoundingClientRect();
      const ox = e.clientX - r.left + scroller.current.scrollLeft; const oy = e.clientY - r.top + scroller.current.scrollTop;
      drag(e, (dx, dy) => setMarquee({ x: Math.min(ox, ox + dx), y: Math.min(oy, oy + dy), w: Math.abs(dx), h: Math.abs(dy) }), (ev, moved) => {
        setMarquee(null);
        if (!moved) {
          const before = clipsOn(doc, track.id).filter((x) => clipEnd(x) <= t + EPS);
          const after = clipsOn(doc, track.id).filter((x) => x.start >= t - EPS);
          const a = before.length ? Math.max(...before.map(clipEnd)) : 0;
          if (after.length && !readOnly) ed.setSel(new Set(), { gap: { track: track.id, a, b: Math.min(...after.map((x) => x.start)) } });
          else ed.setSel(new Set());
          return;
        }
        const t0 = Math.min(t, tAt(ev.clientX)); const t1 = Math.max(t, tAt(ev.clientX));
        const ra = rows.indexOf(track); const rb = rows.indexOf(rowAt(ev.clientY) || rows[rows.length - 1]);
        const inRows = new Set(rows.slice(Math.min(ra, rb), Math.max(ra, rb) + 1).map((x) => x.id));
        const ids = new Set(doc.clips.filter((x) => inRows.has(x.track) && x.start < t1 && clipEnd(x) > t0).map((x) => x.id));
        ed.setSel(ev.shiftKey ? new Set([...ed.sel, ...ids]) : ids);
      }, 4);
      return;
    }

    if (part === 'transition') { ed.setSelTransition(c.id); ed.setSel(new Set()); return; }
    ed.setSelTransition(null);
    if (readOnly) { ed.setSel(group(c, e.altKey)); return; }

    if (tool === 'razor') {
      if (locked(c)) return;
      const s = snapT(t, snapPoints());
      const ids = e.shiftKey ? null : group(c, e.altKey);
      ed.razor(s.t, ids);
      return;
    }

    // Selection
    const g = group(c, e.altKey);
    let ids;
    if (e.shiftKey) { ids = new Set(ed.sel); const has = ids.has(c.id); for (const x of g) if (has) ids.delete(x); else ids.add(x); ed.setSel(ids); return; }
    ids = ed.sel.has(c.id) && tool === 'select' && part === 'body' ? new Set([...ed.sel, ...g]) : g;
    ed.setSel(ids);
    if (locked(c)) return;
    const base = doc;
    const pts = snapPoints(ids);

    if (part === 'fadein' || part === 'fadeout') {
      drag(e, (dx) => {
        const v = Math.max(0, Math.min(c.duration / 2, (part === 'fadein' ? (c.fade_in || 0) + dx / pps : (c.fade_out || 0) - dx / pps)));
        ed.set({ ...base, clips: base.clips.map((x) => (x.id === c.id ? { ...x, [part === 'fadein' ? 'fade_in' : 'fade_out']: Math.round(v * doc.fps) / doc.fps } : x)) }, part === 'fadein' ? 'Fade in' : 'Fade out', { merge: key });
      }, commit);
      return;
    }

    if (part === 'left' || part === 'right') {
      const side = part;
      const editIds = new Set([...g].filter((id) => { const x = doc.clips.find((y) => y.id === id); return side === 'left' ? Math.abs(x.start - c.start) < 0.02 : Math.abs(clipEnd(x) - clipEnd(c)) < 0.02; }));
      const edge = side === 'left' ? c.start : clipEnd(c);
      const fn = tool === 'ripple' ? ripple : tool === 'roll' ? roll : trim;
      const label = tool === 'ripple' ? 'Ripple edit' : tool === 'roll' ? 'Rolling edit' : 'Trim';
      drag(e, (dx) => {
        const s = snapDelta([edge], dx / pps, pts);
        setSnapX(s.hit);
        ed.set(fn(base, editIds, side, Math.round(s.dt * doc.fps) / doc.fps), label, { merge: key });
        engine.seek(engine.t); // redraw the monitor
      }, commit);
      return;
    }

    if (tool === 'slip') {
      drag(e, (dx) => ed.set(slip(base, ids, Math.round((dx / pps) * doc.fps) / doc.fps), 'Slip', { merge: key }), commit);
      return;
    }
    if (tool === 'slide') {
      const edges = [...ids].flatMap((id) => { const x = doc.clips.find((y) => y.id === id); return [x.start, clipEnd(x)]; });
      drag(e, (dx) => { const s = snapDelta(edges, dx / pps, pts); setSnapX(s.hit); ed.set(slide(base, ids, Math.round(s.dt * doc.fps) / doc.fps), 'Slide', { merge: key }); }, commit);
      return;
    }
    // Move (Alt-drag duplicates). Clips change track within their kind as you drag up/down.
    const edges = [...ids].flatMap((id) => { const x = doc.clips.find((y) => y.id === id); return [x.start, clipEnd(x)]; });
    const kind = track.kind;
    const kindRows = tracksOf(doc, kind);
    const row0 = kindRows.findIndex((x) => x.id === track.id);
    const copy = e.altKey;
    drag(e, (dx, _dy, ev) => {
      const s = snapDelta(edges, dx / pps, pts);
      setSnapX(s.hit);
      const over = rowAt(ev.clientY);
      const dRow = over && over.kind === kind ? kindRows.findIndex((x) => x.id === over.id) - row0 : 0;
      const r = move(base, ids, Math.round(s.dt * doc.fps) / doc.fps, dRow, kind, { copy });
      ed.set(r.doc, copy ? 'Duplicate clips' : 'Move clips', { merge: key });
      if (copy) ed.setSel(r.ids);
    }, commit, 3);
  };

  // Media, effects and transitions dropped from the panels.
  const onDragOver = (e, track) => {
    const types = e.dataTransfer.types;
    if (readOnly || track.lock) return;
    if (types.includes('application/x-cut-media')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const s = snapT(tAt(e.clientX), snapPoints());
      const len = Number(ed.dragInfo.current?.duration) || 5;
      setGhost({ track: track.id, t: s.t, len });
      setSnapX(s.hit);
    } else if (types.includes('application/x-cut-effect') || types.includes('application/x-cut-transition')) e.preventDefault();
  };
  const onDrop = (e, track) => {
    setGhost(null); setSnapX(null);
    if (readOnly || track.lock) return;
    const media = e.dataTransfer.getData('application/x-cut-media');
    const t = snapT(tAt(e.clientX), snapPoints()).t;
    if (media) { e.preventDefault(); ed.placeMedia(JSON.parse(media), { track: track.id, t, insert: e.ctrlKey || e.metaKey }); return; }
    const el = e.target.closest('[data-clip]');
    const c = el && doc.clips.find((x) => x.id === el.dataset.clip);
    const fx = e.dataTransfer.getData('application/x-cut-effect');
    if (fx && c) { e.preventDefault(); ed.addEffect([c.id], fx); return; }
    const tr = e.dataTransfer.getData('application/x-cut-transition');
    if (tr && c) {
      e.preventDefault();
      // Near the clip's start: on its in-point; near its end: on the next clip's in-point (or a fade out).
      const atEnd = t > c.start + c.duration / 2;
      ed.applyTransition(c, atEnd ? 'out' : 'in', tr);
    }
  };

  const gapSel = ed.gap;
  let y = 0;
  return (
    <div className="h-full flex flex-col min-h-0">
      <div ref={scroller} className="flex-1 min-h-0 overflow-auto scroll-thin relative bg-work" onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setGhost(null); }}>
        <div style={{ width: HEAD + contentW, position: 'relative' }}>
          {/* ruler */}
          <div className="sticky top-0 z-20 flex bg-panel border-b border-line" style={{ height: RULER }}>
            <div className="sticky left-0 z-30 bg-panel border-r border-line flex items-center px-2 shrink-0" style={{ width: HEAD }}>
              <TimecodeLabel engine={engine} fps={doc.fps} />
            </div>
            <Ruler ed={ed} pps={pps} scrollLeft={scrollLeft} width={Math.max(0, vw - HEAD)} onScrub={scrub} />
          </div>
          {rows.map((track) => {
            const h = ROW[track.kind];
            const sep = track === audio[0];
            const top = y + (sep ? 6 : 0); y = top + h;
            const clips = clipsOn(doc, track.id).filter((c) => clipEnd(c) >= visA - 1 && c.start <= visB + 1);
            return (
              <div key={track.id} className={cx('flex relative', sep && 'border-t-[6px] border-panel-2')} style={{ height: h + (sep ? 6 : 0) }}>
                <div className="sticky left-0 z-10 shrink-0" style={{ width: HEAD }}><TrackHeader ed={ed} track={track} h={h} /></div>
                <div className={cx('relative border-b border-line/70', track.lock && 'bg-[repeating-linear-gradient(45deg,transparent_0_6px,rgba(255,255,255,.03)_6px_12px)]')} style={{ width: contentW, height: h }}
                  onPointerDown={(e) => onLaneDown(e, track)} onDragOver={(e) => onDragOver(e, track)} onDrop={(e) => onDrop(e, track)}
                  data-track={track.id} data-kind={track.kind}>
                  {gapSel?.track === track.id && <div className="absolute top-1 bottom-1 bg-accent/25 border border-accent/60 rounded" style={{ left: gapSel.a * pps, width: (gapSel.b - gapSel.a) * pps }} />}
                  {clips.map((c) => (
                    <ClipView key={c.id} c={c} pps={pps} h={h} visA={visA} visB={visB} selected={ed.sel.has(c.id)}
                      readOnly={readOnly || track.lock} missing={c.asset_id && c.type !== 'title' && !doc.media.some((m) => m.id === c.asset_id)} />
                  ))}
                  {clips.filter((c) => c.transition_in).map((c) => {
                    const d = c.transition_in.duration; const prev = doc.clips.some((p) => p.track === c.track && Math.abs(clipEnd(p) - c.start) < 0.02);
                    const left = (prev ? c.start - d / 2 : c.start) * pps; const w = Math.max(10, (prev ? d : d / 2) * pps);
                    return (
                      <div key={`tr-${c.id}`} data-clip={c.id} data-part="transition" title={`${transitionLabel(c.transition_in.type)} · ${d}s`}
                        className={cx('absolute z-[3] rounded-sm cursor-pointer text-[9.5px] text-white flex items-center justify-center overflow-hidden border',
                          ed.selTransition === c.id ? 'bg-accent/80 border-white' : 'bg-accent-2/75 border-white/40 hover:bg-accent-2')}
                        style={{ left, width: w, top: h - 24, height: 16, backgroundImage: 'linear-gradient(to top right, transparent 48%, rgba(255,255,255,.55) 50%, transparent 52%)' }}>
                        {w > 70 ? transitionLabel(c.transition_in.type) : ''}
                      </div>
                    );
                  })}
                  {ghost?.track === track.id && <div className="absolute top-1 bottom-1 rounded border-2 border-dashed border-white/80 bg-white/10 pointer-events-none" style={{ left: ghost.t * pps, width: ghost.len * pps }} />}
                </div>
              </div>
            );
          })}
          {!doc.clips.length && (
            <div className="absolute z-[5] pointer-events-none grid place-items-center text-fg2 text-sm" style={{ top: RULER + 30, left: HEAD + scrollLeft, width: Math.max(200, vw - HEAD), height: 120 }}>
              <div className="text-center"><Icon name="import" size={26} className="mx-auto mb-2" />Import media to start — then drag it here from the Project panel.</div>
            </div>
          )}
          {/* playhead, snap line, marquee */}
          <div className="absolute top-0 bottom-0 z-[25] pointer-events-none" style={{ left: HEAD }}>
            <div ref={playhead} className="absolute top-0 bottom-0 w-px bg-[#ff4d6a]" style={{ minHeight: y + RULER }}>
              <div className="absolute -left-[6px] top-0 w-[13px] h-3 bg-[#ff4d6a]" style={{ clipPath: 'polygon(0 0,100% 0,100% 55%,50% 100%,0 55%)' }} />
            </div>
            {snapX !== null && <div className="absolute top-0 w-px bg-sun" style={{ left: snapX * pps, height: y + RULER }} />}
          </div>
          {marquee && <div className="absolute z-30 border border-accent bg-accent/15 pointer-events-none" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        </div>
      </div>
      <div className="h-7 shrink-0 flex items-center gap-1 px-2 border-t border-line bg-panel">
        <IconButton icon="plus" label="Add video track" size={22} disabled={readOnly} onClick={() => ed.addTrack('video')}><span /></IconButton>
        <span className="text-[11px] text-fg3 mr-2">Video</span>
        <IconButton icon="plus" label="Add audio track" size={22} disabled={readOnly} onClick={() => ed.addTrack('audio')} />
        <span className="text-[11px] text-fg3">Audio</span>
        <span className="flex-1" />
        <IconButton icon="zoomOut" label="Zoom out (-)" size={22} onClick={() => ed.timelineApi.current.zoom(1 / 1.5)} />
        <input type="range" className="sl-range w-28" min={0} max={1} step={0.001} value={Math.log(pps / 0.5) / Math.log(4000)} aria-label="Zoom"
          onChange={(e) => { const p = 0.5 * 4000 ** Number(e.target.value); const sc = scroller.current; const t = engine.t; zoomTo(p, t, t * pps - sc.scrollLeft); }} />
        <IconButton icon="zoomIn" label="Zoom in (+)" size={22} onClick={() => ed.timelineApi.current.zoom(1.5)} />
        <IconButton icon="fit" label="Zoom to fit (\)" size={22} onClick={() => ed.timelineApi.current.fit()} />
      </div>
    </div>
  );
}

function TimecodeLabel({ engine, fps }) {
  const ref = useRef(null);
  useEffect(() => {
    const f = (t) => { if (ref.current) ref.current.textContent = timecode(t, fps); };
    f(engine.t);
    return engine.subscribe(f);
  }, [engine, fps]);
  return <span ref={ref} className="font-mono text-[13px] text-accent tabular-nums" />;
}

export { closeGap, splitClip, fitsTrack };
