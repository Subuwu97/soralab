// The Waveform editor: destructive editing of one source file (opened by double-clicking a clip). Edits build up on a
// working copy with their own undo; "Apply" saves the result as a NEW asset and points the clip at it (the original file
// is never touched, and Edit → Undo in the session restores the old asset). Noise reduction and the spectral display run
// in a Web Worker (STFT).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton, Modal, Slider, Spinner, ProgressBar, Toggle, openMenu, promptDialog, confirmDialog, toast, toastError, cx } from '../../components/ui.jsx';
import { Icon } from '../../components/Icons.jsx';
import { saveBlob } from '../../lib/api.js';
import { useShortcuts } from '../../lib/shortcuts.js';
import * as D from './dsp.js';
import { fadeShape, SHAPES, clamp } from './model.js';
import { AIcon, useFrame, fmtClock, rulerStep, fmtRuler } from './parts.jsx';

// ---------------------------------------------------------------- worker

let worker = null; let seq = 0; const pending = new Map();
function call(cmd, data = {}, transfer = [], onProgress) {
  if (!worker) {
    worker = new Worker(new URL('./dsp.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id); if (!p) return;
      if ('progress' in e.data) { p.onProgress?.(e.data.progress); return; }
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.result);
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ id, cmd, ...data }, transfer); });
}

let clipboard = null; // copied audio, shared between files in this tab
const RULER = 22; const OVERVIEW = 30;

export default function WaveEditor({ engine, file, clip, docId, canEdit, onApply, onClose }) {
  const [work, setWork] = useState(null);
  const [error, setError] = useState(null);
  const [undo, setUndo] = useState([]); const [redo, setRedo] = useState([]);
  const [view, setView] = useState({ from: 0, to: 1 });
  const [selR, setSelR] = useState(null); // { a, b } seconds
  const [cursor, setCursor] = useState(0);
  const [spectral, setSpectral] = useState(() => { try { return localStorage.getItem('au-spectral') === '1'; } catch { return false; } });
  const [print, setPrint] = useState(null);
  const [busy, setBusy] = useState(null); // { label, p }
  const [nrOpen, setNrOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const mip = useRef(null);
  const wrap = useRef(null); const cv = useRef(null); const sp = useRef(null); const ov = useRef(null); const head = useRef(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const play = useRef(null);
  const specImg = useRef(null);
  const workRef = useRef(null); workRef.current = work;

  useEffect(() => { try { localStorage.setItem('au-spectral', spectral ? '1' : '0'); } catch { /* private mode */ } }, [spectral]);

  // Load the source.
  useEffect(() => {
    let off = false;
    setWork(null); setError(null); setUndo([]); setRedo([]); setSelR(null); setCursor(0);
    engine.load(file.id).then((b) => {
      if (off) return;
      const a = D.fromBuffer(b);
      setWork(a); setView({ from: 0, to: Math.max(0.01, D.durationOf(a)) });
    }).catch((e) => !off && setError(e));
    return () => { off = true; };
  }, [engine, file.id]);

  const dur = work ? D.durationOf(work) : 0;
  const sr = work?.sampleRate || 48000;
  const dirty = undo.length > 0;

  useEffect(() => { if (work) mip.current = D.mipmap(work, 64); }, [work]);
  // Mono copy for the spectrogram worker.
  useEffect(() => {
    if (!work) return;
    const n = D.lengthOf(work); const mono = new Float32Array(n);
    for (const c of work.channels) for (let i = 0; i < n; i++) mono[i] += c[i] / work.channels.length;
    specImg.current = null;
    call('set', { key: 'wave', mono }, [mono.buffer]).then(() => drawSpectrogram());
  }, [work]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = wrap.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [work]);

  // ------------------------------------------------------------ geometry
  const waveH = Math.max(80, spectral ? Math.round((size.h - RULER - OVERVIEW) * 0.45) : size.h - RULER - OVERVIEW);
  const specH = spectral ? Math.max(60, size.h - RULER - OVERVIEW - waveH) : 0;
  const pps = size.w / Math.max(1e-4, view.to - view.from);
  const X = (t) => (t - view.from) * pps;
  const T = (x) => clamp(view.from + x / pps, 0, dur);
  const samples = (t) => clamp(Math.round(t * sr), 0, work ? D.lengthOf(work) : 0);
  const range = () => (selR && selR.b - selR.a > 1e-4 ? [samples(selR.a), samples(selR.b)] : null);

  // ------------------------------------------------------------ drawing
  const draw = useCallback(() => {
    const c = cv.current; const a = workRef.current; if (!c || !a) return;
    const W = size.w; const H = RULER + waveH; const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr; c.height = H * dpr; c.style.width = `${W}px`; c.style.height = `${H}px`;
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#101116'; g.fillRect(0, 0, W, H);
    // ruler
    g.fillStyle = '#1d1f26'; g.fillRect(0, 0, W, RULER);
    const step = rulerStep(pps, 90);
    g.fillStyle = '#a8adbd'; g.font = '10.5px Inter, sans-serif'; g.textBaseline = 'top';
    for (let t = Math.floor(view.from / step) * step; X(t) < W; t += step) { const x = Math.round(X(t)) + 0.5; g.fillRect(x, RULER - 8, 1, 8); g.fillText(fmtRuler(Math.max(0, t), step), x + 3, 4); g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(x, RULER, 1, H); g.fillStyle = '#a8adbd'; }
    // selection
    if (selR) { g.fillStyle = 'rgba(90,180,255,.2)'; g.fillRect(X(selR.a), RULER, (selR.b - selR.a) * pps, H); }
    // channels
    const nch = a.channels.length; const lane = waveH / nch; const m = mip.current; const spp = (view.to - view.from) / W;
    for (let ch = 0; ch < nch; ch++) {
      const top = RULER + ch * lane; const mid = top + lane / 2; const half = lane / 2 - 3;
      g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(0, Math.round(mid), W, 1);
      if (ch) { g.fillStyle = 'rgba(255,255,255,.1)'; g.fillRect(0, Math.round(top), W, 1); }
      const data = a.channels[ch];
      g.fillStyle = '#00e4bb';
      const raw = spp * sr < 128;
      if (spp * sr < 4) {
        // Very zoomed in: draw the actual samples as a line with dots.
        g.strokeStyle = '#00e4bb'; g.lineWidth = 1.25; g.beginPath();
        const i0 = Math.max(0, Math.floor(view.from * sr) - 1); const i1 = Math.min(data.length, Math.ceil(view.to * sr) + 1);
        for (let i = i0; i < i1; i++) { const x = X(i / sr); const y = mid - data[i] * half; if (i === i0) g.moveTo(x, y); else g.lineTo(x, y); }
        g.stroke();
        if (spp * sr < 0.25) for (let i = i0; i < i1; i++) g.fillRect(X(i / sr) - 1.5, mid - data[i] * half - 1.5, 3, 3);
        continue;
      }
      for (let x = 0; x < W; x++) {
        const t0 = view.from + x * spp; const t1 = t0 + spp;
        let lo = 0; let hi = 0;
        if (raw || !m) {
          const i0 = Math.max(0, Math.floor(t0 * sr)); const i1 = Math.min(data.length, Math.ceil(t1 * sr));
          for (let i = i0; i < i1; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        } else {
          // mipmap holds min/max across channels; good enough per lane when zoomed out
          const b0 = Math.floor((t0 * sr) / m.block); const b1 = Math.min(m.lo.length, Math.ceil((t1 * sr) / m.block));
          for (let b = b0; b < b1; b++) { if (m.lo[b] < lo) lo = m.lo[b]; if (m.hi[b] > hi) hi = m.hi[b]; }
        }
        const y0 = mid - Math.min(1, hi) * half; const y1 = mid - Math.max(-1, lo) * half;
        g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }
    if (selR) { g.fillStyle = 'rgba(90,180,255,.9)'; g.fillRect(Math.round(X(selR.a)), RULER, 1, H); g.fillRect(Math.round(X(selR.b)), RULER, 1, H); }
    // overview
    const o = ov.current; if (o) {
      o.width = W * dpr; o.height = OVERVIEW * dpr; o.style.width = `${W}px`; o.style.height = `${OVERVIEW}px`;
      const q = o.getContext('2d'); q.setTransform(dpr, 0, 0, dpr, 0, 0);
      q.fillStyle = '#17181e'; q.fillRect(0, 0, W, OVERVIEW);
      const ospp = dur / W; q.fillStyle = 'rgba(0,228,187,.55)';
      if (m) for (let x = 0; x < W; x++) {
        const b0 = Math.floor((x * ospp * sr) / m.block); const b1 = Math.min(m.lo.length, Math.max(b0 + 1, Math.ceil(((x + 1) * ospp * sr) / m.block)));
        let lo = 0; let hi = 0; for (let b = b0; b < b1; b++) { if (m.lo[b] < lo) lo = m.lo[b]; if (m.hi[b] > hi) hi = m.hi[b]; }
        q.fillRect(x, OVERVIEW / 2 - hi * (OVERVIEW / 2 - 2), 1, Math.max(1, (hi - lo) * (OVERVIEW / 2 - 2)));
      }
      q.strokeStyle = '#5AB4FF'; q.lineWidth = 1.5; q.strokeRect((view.from / dur) * W + 0.75, 0.75, Math.max(3, ((view.to - view.from) / dur) * W) - 1.5, OVERVIEW - 1.5);
    }
    // spectrogram (cached image, re-requested when the view changes)
    const s = sp.current; if (s && spectral) {
      s.width = W * dpr; s.height = specH * dpr; s.style.width = `${W}px`; s.style.height = `${specH}px`;
      const q = s.getContext('2d'); q.setTransform(dpr, 0, 0, dpr, 0, 0);
      q.fillStyle = '#08090f'; q.fillRect(0, 0, W, specH);
      const img = specImg.current;
      if (img && img.from === view.from && img.to === view.to) { q.imageSmoothingEnabled = true; q.drawImage(img.canvas, 0, 0, W, specH); }
      if (selR) { q.fillStyle = 'rgba(90,180,255,.18)'; q.fillRect(X(selR.a), 0, (selR.b - selR.a) * pps, specH); }
      q.fillStyle = 'rgba(255,255,255,.55)'; q.font = '9.5px Inter, sans-serif';
      for (const f of [100, 1000, 5000, 10000]) { if (f > sr / 2) continue; const y = specH * (1 - Math.log(f / 30) / Math.log(sr / 2 / 30)); q.fillText(f >= 1000 ? `${f / 1000}k` : String(f), 3, y); }
    }
  }, [size, waveH, specH, view, selR, spectral, dur, sr, pps]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawSpectrogram = useCallback(async () => {
    if (!spectral || !workRef.current) return;
    const v = view; const cols = Math.min(1400, Math.max(64, Math.round(size.w))); const rows = Math.min(256, Math.max(48, Math.round(specH)));
    try {
      const img = await call('spectrogram', { key: 'wave', sampleRate: sr, from: Math.floor(v.from * sr), to: Math.ceil(v.to * sr), cols, rows });
      const c = document.createElement('canvas'); c.width = cols; c.height = rows;
      c.getContext('2d').putImageData(new ImageData(img, cols, rows), 0, 0);
      specImg.current = { canvas: c, from: v.from, to: v.to };
      draw();
    } catch { /* worker busy or data replaced: next change redraws */ }
  }, [spectral, view, size.w, specH, sr, draw]);

  useEffect(() => { draw(); }, [draw, work]);
  useEffect(() => { const t = setTimeout(drawSpectrogram, 120); return () => clearTimeout(t); }, [drawSpectrogram]);

  // Playhead
  useFrame(() => {
    const el = head.current; if (!el) return;
    const t = play.current ? play.current.position() : cursor;
    const x = X(t);
    el.style.transform = `translateX(${Math.round(x)}px)`; el.style.display = x < 0 || x > size.w ? 'none' : '';
  }, [cursor, view, size.w]);

  // ------------------------------------------------------------ edits
  const apply = (next, label) => {
    setUndo((u) => [...u.slice(-14), { a: work, label, sel: selR }]); setRedo([]);
    setWork(next);
  };
  const undoLocal = () => {
    if (!undo.length) return false;
    const last = undo[undo.length - 1];
    setRedo((r) => [...r, { a: work, label: last.label, sel: selR }]); setUndo((u) => u.slice(0, -1)); setWork(last.a); setSelR(last.sel);
    return true;
  };
  const redoLocal = () => {
    if (!redo.length) return false;
    const last = redo[redo.length - 1];
    setUndo((u) => [...u, { a: work, label: last.label, sel: selR }]); setRedo((r) => r.slice(0, -1)); setWork(last.a);
    return true;
  };
  const need = (r) => { if (!r) toast('Select a range first (drag across the waveform).'); return r; };
  const whole = () => range() || [0, D.lengthOf(work)];

  const ops = {
    cut: () => { const r = need(range()); if (!r) return; clipboard = D.slice(work, ...r); apply(D.remove(work, ...r), 'Cut'); setSelR(null); setCursor(r[0] / sr); },
    copy: () => { const r = need(range()); if (!r) return; clipboard = D.slice(work, ...r); toast('Copied'); },
    paste: () => {
      if (!clipboard) { toast('Nothing copied yet.'); return; }
      const r = range() || [samples(cursor), samples(cursor)];
      const clip = clipboard.sampleRate === sr ? clipboard : resample(clipboard, sr);
      apply(D.insert(work, r[0], r[1], clip), 'Paste'); setSelR({ a: r[0] / sr, b: (r[0] + D.lengthOf(clip)) / sr });
    },
    del: () => { const r = need(range()); if (!r) return; apply(D.remove(work, ...r), 'Delete'); setSelR(null); setCursor(r[0] / sr); },
    silence: () => { const r = need(range()); if (r) apply(D.silence(work, ...r), 'Silence'); },
    amplify: async () => {
      const v = await promptDialog({ title: 'Amplify', label: 'Gain (dB, negative to turn down)', value: '3' });
      const db = parseFloat(v); if (!Number.isFinite(db)) return;
      apply(D.gainRange(work, ...whole(), clamp(db, -60, 40)), `Amplify ${db} dB`);
    },
    normalize: (e) => openMenu(e, [
      { heading: range() ? 'Normalize the selection' : 'Normalize the whole file' },
      ...[-0.1, -1, -3].map((db) => ({ label: `Peak to ${db} dBFS`, onClick: () => apply(D.normalizePeakRange(work, ...whole(), db), 'Normalize (peak)') })),
      { divider: true },
      ...[[-14, 'streaming music'], [-16, 'podcast'], [-19, 'mono podcast'], [-23, 'EBU R128 broadcast']].map(([l, what]) => ({
        label: `Loudness to ${l} LUFS (${what})`,
        onClick: () => { const [s, en] = whole(); const before = D.integratedLoudness(D.slice(work, s, en)); apply(D.normalizeLoudnessRange(work, s, en, l), 'Normalize (loudness)'); toast(`${Number.isFinite(before) ? before.toFixed(1) : '−∞'} → ${l} LUFS`); },
      })),
    ]),
    fade: (e, dir) => {
      const r = need(range()); if (!r) return;
      openMenu(e, SHAPES.map(([v, l]) => ({ label: l, onClick: () => apply(D.fade(work, ...r, dir, (x) => fadeShape(x, v)), dir === 'in' ? 'Fade in' : 'Fade out') })));
    },
    reverse: () => apply(D.reverse(work, ...whole()), 'Reverse'),
    invert: () => apply(D.invert(work, ...whole()), 'Invert'),
    capture: async () => {
      const r = need(range()); if (!r) return;
      if (r[1] - r[0] < 2048) { toast('Select at least 50 ms of noise.'); return; }
      const part = D.slice(work, ...r);
      setPrint(await call('print', { channels: part.channels }, part.channels.map((c) => c.buffer)));
      toast('Noise print captured — now select what to clean (or nothing for the whole file) and choose Noise Reduction.', { type: 'success' });
    },
    reduce: async (opts) => {
      setNrOpen(false);
      const [s, en] = whole();
      setBusy({ label: 'Reducing noise…', p: 0 });
      try {
        const part = D.slice(work, s, en);
        const outs = await call('denoise', { channels: part.channels, print, opts }, part.channels.map((c) => c.buffer), (p) => setBusy({ label: 'Reducing noise…', p }));
        const next = { sampleRate: sr, channels: work.channels.map((c, i) => { const o = c.slice(); o.set(outs[i], s); return o; }) };
        apply(next, 'Noise reduction');
      } catch (e) { toastError(e, 'Noise reduction failed'); }
      setBusy(null);
    },
  };

  // ------------------------------------------------------------ transport
  const stopPlay = () => { engine.stopPreview(); if (play.current) setCursor(selR ? selR.a : cursor); play.current = null; setPlaying(false); };
  const togglePlay = async () => {
    if (play.current) { stopPlay(); return; }
    const b = D.toBuffer(work);
    const from = selR ? selR.a : cursor; const to = selR ? selR.b : dur;
    play.current = await engine.preview(b, from, to, () => { play.current = null; setPlaying(false); });
    setPlaying(true);
  };
  useEffect(() => () => engine.stopPreview(), [engine]);

  // ------------------------------------------------------------ save
  const save = async () => {
    setBusy({ label: 'Saving the edited file…', p: 0 });
    try {
      const base = file.name.replace(/\.[^.]+$/, '').replace(/ \(edited( \d+)?\)$/, '');
      const blob = D.encodeWav(work, 24);
      const asset = await saveBlob(blob, `${base} (edited).wav`, { docId, isExport: false, onProgress: (p) => setBusy({ label: 'Saving the edited file…', p }) });
      engine.putBuffer(asset.id, D.toBuffer(work));
      onApply({ ...asset, duration: asset.duration || dur }, D.durationOf(undo[0]?.a || work));
      setUndo([]); setRedo([]);
      toast('Applied — the clip now uses the edited file. Undo in the session to go back.', { type: 'success' });
    } catch (e) { toastError(e, 'Couldn’t save the edit'); }
    setBusy(null);
  };
  const close = async () => {
    stopPlay();
    if (dirty && canEdit) {
      const ok = await confirmDialog({ title: 'Apply your edits?', message: 'The clip will use a new edited copy of this file (the original stays as it is).', confirm: 'Apply', cancel: 'Discard' });
      if (ok) await save();
    }
    onClose();
  };

  // ------------------------------------------------------------ pointer
  const selDrag = (e) => {
    if (e.button !== 0 || !work) return;
    const r = cv.current.getBoundingClientRect(); const x0 = e.clientX - r.left; const t0 = T(x0);
    const anchor = e.shiftKey && selR ? (Math.abs(t0 - selR.a) < Math.abs(t0 - selR.b) ? selR.b : selR.a) : t0;
    if (e.shiftKey && selR) setSelR({ a: Math.min(anchor, t0), b: Math.max(anchor, t0) }); else { setSelR(null); setCursor(t0); }
    if (play.current) stopPlay();
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const move = (ev) => { const t = T(ev.clientX - r.left); if (Math.abs(ev.clientX - e.clientX) > 2) setSelR({ a: Math.min(anchor, t), b: Math.max(anchor, t) }); };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const ovDrag = (e) => {
    const r = ov.current.getBoundingClientRect(); const span = view.to - view.from;
    const go = (cx) => { const c = (clamp(cx - r.left, 0, r.width) / r.width) * dur; const f = clamp(c - span / 2, 0, Math.max(0, dur - span)); setView({ from: f, to: f + span }); };
    go(e.clientX);
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const move = (ev) => go(ev.clientX); const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const zoom = (k, at = size.w / 2) => {
    const t = T(at); const span = clamp((view.to - view.from) / k, 64 / sr, dur);
    let f = t - (at / size.w) * span; f = clamp(f, 0, Math.max(0, dur - span));
    setView({ from: f, to: f + span });
  };
  useEffect(() => {
    const el = wrap.current; if (!el) return undefined;
    const wheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoom(Math.exp(-e.deltaY * 0.003), e.clientX - r.left);
      else {
        const span = view.to - view.from; const d = ((e.deltaX || e.deltaY) / size.w) * span;
        const f = clamp(view.from + d, 0, Math.max(0, dur - span)); setView({ from: f, to: f + span });
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  useShortcuts({
    space: () => { togglePlay(); },
    delete: () => canEdit && ops.del(), backspace: () => canEdit && ops.del(),
    'mod+x': () => canEdit && ops.cut(), 'mod+c': () => ops.copy(), 'mod+v': () => canEdit && ops.paste(),
    'mod+a': () => setSelR({ a: 0, b: dur }),
    home: () => { setCursor(0); setView((v) => ({ from: 0, to: v.to - v.from })); }, end: () => setCursor(dur),
    escape: () => { if (selR) setSelR(null); else close(); },
    '=': () => zoom(1.5), '-': () => zoom(1 / 1.5), '\\': () => setView({ from: 0, to: dur }),
  }, [work, selR, cursor, undo, redo, view, dur, canEdit, print]);

  // Undo/redo of unapplied edits. Listens in the capture phase so it runs before the editor shell's Ctrl+Z (which undoes
  // the session); with nothing local to undo, the key falls through to the shell.
  const undoRef = useRef(); undoRef.current = { undoLocal, redoLocal };
  useEffect(() => {
    const down = (e) => {
      if (!(e.ctrlKey || e.metaKey) || document.querySelector('[role=dialog][aria-modal=true]')) return;
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
      const k = e.key.toLowerCase();
      const done = k === 'z' && !e.shiftKey ? undoRef.current.undoLocal() : (k === 'z' && e.shiftKey) || k === 'y' ? undoRef.current.redoLocal() : false;
      if (done) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, []);

  if (error) return <div className="h-full grid place-items-center text-sm text-danger">{error.message}</div>;
  if (!work) return <div className="h-full grid place-items-center"><Spinner size={26} /></div>;

  const tb = (icon, label, onClick, opts = {}) => (
    <IconButton key={label} label={label} size={30} onClick={onClick} disabled={opts.edit !== false && !canEdit} shortcut={opts.shortcut} active={opts.active}>
      {opts.a ? <AIcon name={icon} size={17} /> : <Icon name={icon} size={17} />}
    </IconButton>
  );
  const sep = (k) => <span key={k} className="w-px h-5 bg-line mx-1" />;
  const selDur = selR ? selR.b - selR.a : 0;
  return (
    <div className="h-full flex flex-col bg-work" data-testid="wave-editor">
      <div className="h-10 shrink-0 flex items-center gap-0.5 px-2 border-b border-line bg-panel overflow-x-auto no-scrollbar">
        <Button size="sm" variant="ghost" icon="back" onClick={close}>Multitrack</Button>
        <span className="text-[13px] font-medium truncate max-w-56 mx-2" title={file.name}>{file.name}</span>
        {sep(1)}
        {tb(playing ? 'stop' : 'play', playing ? 'Stop' : 'Play (selection)', togglePlay, { edit: false, shortcut: 'Space' })}
        {sep(2)}
        {tb('scissors', 'Cut', ops.cut, { shortcut: 'Ctrl+X' })}
        {tb('copy', 'Copy', ops.copy, { edit: false, shortcut: 'Ctrl+C' })}
        {tb('paste', 'Paste', ops.paste, { a: true, shortcut: 'Ctrl+V' })}
        {tb('trash', 'Delete', ops.del, { shortcut: 'Del' })}
        {tb('silence', 'Silence', ops.silence, { a: true })}
        {sep(3)}
        {tb('amplify', 'Amplify…', ops.amplify, { a: true })}
        {tb('normalize', 'Normalize…', ops.normalize)}
        {tb('fadeIn', 'Fade in (selection)', (e) => ops.fade(e, 'in'))}
        {tb('fadeOut', 'Fade out (selection)', (e) => ops.fade(e, 'out'))}
        {tb('reverse', 'Reverse', ops.reverse, { a: true })}
        {tb('invert', 'Invert polarity', ops.invert, { a: true })}
        {sep(4)}
        <Button size="sm" variant="ghost" icon="noise" disabled={!canEdit} onClick={ops.capture} title="Select a stretch of pure noise first">Capture noise print</Button>
        <Button size="sm" variant="ghost" disabled={!canEdit || !print} onClick={() => setNrOpen(true)} title={print ? 'Reduce noise in the selection (or the whole file)' : 'Capture a noise print first'}>Noise Reduction…</Button>
        {sep(5)}
        {tb('spectral', 'Spectral frequency display', () => setSpectral(!spectral), { edit: false, active: spectral })}
        {tb('zoomIn', 'Zoom in', () => zoom(1.5), { edit: false, shortcut: '=' })}
        {tb('zoomOut', 'Zoom out', () => zoom(1 / 1.5), { edit: false, shortcut: '-' })}
        {tb('fit', 'Zoom to fit', () => setView({ from: 0, to: dur }), { edit: false, shortcut: '\\' })}
        {selR && tb('zoom', 'Zoom to selection', () => setView({ from: selR.a, to: Math.max(selR.a + 64 / sr, selR.b) }), { edit: false })}
        <span className="flex-1" />
        {dirty && <span className="text-[11px] text-warn mr-2 whitespace-nowrap">{undo.length} unapplied edit{undo.length > 1 ? 's' : ''}</span>}
        <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => { setWork(undo[0].a); setUndo([]); setRedo([]); }}>Discard</Button>
        <Button size="sm" variant="primary" icon="check" disabled={!dirty || !canEdit} onClick={save} data-testid="apply-edit">Apply</Button>
      </div>
      <div ref={wrap} className="flex-1 min-h-0 relative overflow-hidden">
        <canvas ref={ov} className="block cursor-pointer" onPointerDown={ovDrag} title="Overview — drag to scroll" />
        <canvas ref={cv} className="block cursor-text" onPointerDown={selDrag} onDoubleClick={() => setSelR({ a: 0, b: dur })} data-testid="wave-canvas" />
        {spectral && <canvas ref={sp} className="block cursor-text" onPointerDown={selDrag} data-testid="spectral" />}
        <div ref={head} className="absolute left-0 pointer-events-none" style={{ top: OVERVIEW, height: size.h - OVERVIEW, width: 0 }}>
          <div className="absolute top-0 bottom-0 w-px bg-[#ff5c6c]" />
        </div>
        {busy && (
          <div className="absolute inset-0 grid place-items-center bg-black/40">
            <div className="bg-panel border border-line rounded-lg p-4 w-72 flex flex-col gap-2 text-sm"><div className="flex items-center gap-2"><Spinner />{busy.label}</div><ProgressBar value={busy.p} /></div>
          </div>
        )}
      </div>
      <div className="h-7 shrink-0 flex items-center gap-5 px-3 border-t border-line bg-panel text-[11px] text-fg2 tabular-nums whitespace-nowrap overflow-hidden">
        <span>Cursor <b className="text-fg font-mono">{fmtClock(cursor)}</b></span>
        <span>Selection <b className="text-fg font-mono">{selR ? `${fmtClock(selR.a)} – ${fmtClock(selR.b)}` : '—'}</b>{selR && <> · <b className="text-fg font-mono">{fmtClock(selDur)}</b></>}</span>
        <span>Length <b className="text-fg font-mono">{fmtClock(dur)}</b></span>
        <span>{sr / 1000} kHz · {work.channels.length === 1 ? 'Mono' : 'Stereo'}</span>
        {print && <span className="text-accent">Noise print captured</span>}
        <span className="flex-1" />
        <span>Clip “{clip?.name}”</span>
      </div>
      {nrOpen && <NoiseDialog onClose={() => setNrOpen(false)} onRun={ops.reduce} scope={range() ? 'the selection' : 'the whole file'} />}
    </div>
  );
}

function NoiseDialog({ onClose, onRun, scope }) {
  const [o, setO] = useState(() => { try { return { reduction: 18, sensitivity: 6, smoothing: 0.6, ...JSON.parse(localStorage.getItem('au-nr') || '{}') }; } catch { return { reduction: 18, sensitivity: 6, smoothing: 0.6 }; } });
  const run = () => { try { localStorage.setItem('au-nr', JSON.stringify(o)); } catch { /* private mode */ } onRun(o); };
  return (
    <Modal title="Noise Reduction" onClose={onClose} width={400}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={run} data-testid="nr-run">Reduce noise</Button></>}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg2">Spectral gating against the captured noise print, applied to {scope}.</p>
        <Slider label="Reduce by" value={o.reduction} min={3} max={40} step={1} unit="dB" onChange={(v) => setO({ ...o, reduction: v })} />
        <Slider label="Sensitivity" value={o.sensitivity} min={0} max={18} step={0.5} unit="dB" onChange={(v) => setO({ ...o, sensitivity: v })} />
        <Slider label="Smoothing" value={Math.round(o.smoothing * 100)} min={0} max={95} step={1} unit="%" onChange={(v) => setO({ ...o, smoothing: v / 100 })} />
        <p className="text-[11px] text-fg3">Higher sensitivity removes more but can dull quiet sounds; more smoothing avoids warbly “musical noise”.</p>
      </div>
    </Modal>
  );
}

/** Linear-interpolation resample (for pasting audio copied from a file at another rate). */
function resample(a, sr) {
  const k = a.sampleRate / sr; const n = Math.round(D.lengthOf(a) / k);
  return { sampleRate: sr, channels: a.channels.map((c) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i * k; const i0 = Math.floor(x); const f = x - i0; o[i] = (c[i0] || 0) * (1 - f) + (c[i0 + 1] || 0) * f; } return o; }) };
}
