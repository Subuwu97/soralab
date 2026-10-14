// The Cut document: media bin, tracks, clips, markers and the sequence settings — plus every edit as a pure function
// (doc in, doc out) so each one is a single undo step. Times are seconds; a clip uses `duration * speed` seconds of
// its source starting at `in`. Tracks keep their order within each kind: video[0] is V1 (the bottom layer), audio[0] is A1.
//
// doc = { v, width, height, fps, master, bins, media, tracks, clips, markers, io: { in, out } }
// clip = { id, track, type: video|audio|image|title|color, asset_id, name, start, in, duration, speed, link,
//          transform: { x, y, scale, rotation }, opacity, crop: { l, t, r, b }, fade_in, fade_out, effects: [...],
//          volume, pan, keyframes: { x, y, scale, rotation, opacity, volume: [{ t, v }] }, transition_in: { type, duration },
//          title: {...} (title clips), color (colour mattes) }

export const uid = (p = '') => `${p}${Math.random().toString(36).slice(2, 10)}`;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const EPS = 1e-4;
export const STILL_DURATION = 5;

// ---------------------------------------------------------------- time

export const frame = (fps) => 1 / (fps || 30);
export const snapFrame = (t, fps) => Math.round(t * (fps || 30)) / (fps || 30);
/** 00:00:12:05 */
export function timecode(t, fps = 30) {
  const f = Math.round(fps) || 30;
  const total = Math.max(0, Math.round((t || 0) * fps));
  const fr = total % f; const s = Math.floor(total / f);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(fr)}`;
}
/** Parses 1:02, 00:01:02:10, 62.5 or 120f into seconds (null if it isn't a time). */
export function parseTimecode(str, fps = 30) {
  const s = String(str).trim();
  if (/^\d+f$/i.test(s)) return parseInt(s, 10) / fps;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(/[:;]/).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// ---------------------------------------------------------------- documents

export function newTrack(kind, n, extra = {}) {
  return { id: uid('t'), kind, name: `${kind === 'video' ? 'V' : 'A'}${n}`, hidden: false, lock: false, mute: false, solo: false, volume: 1, pan: 0, ...extra };
}

export function emptyDoc({ width = 1920, height = 1080, fps = 30 } = {}) {
  return {
    v: 1, width, height, fps, master: 1,
    bins: [], media: [],
    tracks: [newTrack('video', 1), newTrack('video', 2), newTrack('video', 3), newTrack('audio', 1), newTrack('audio', 2), newTrack('audio', 3)],
    clips: [], markers: [], io: { in: null, out: null },
  };
}

/** Saved data (or {}) → a complete document. */
export function fromSaved(data, docMeta) {
  const base = emptyDoc({ width: docMeta?.width || 1920, height: docMeta?.height || 1080, fps: Number(docMeta?.meta?.fps) || 30 });
  if (!data || typeof data !== 'object' || !Array.isArray(data.tracks)) return base;
  return {
    ...base, ...data,
    bins: data.bins || [], media: data.media || [], clips: (data.clips || []).map(normClip), markers: data.markers || [],
    io: data.io || { in: null, out: null },
  };
}
export const hasContent = (data) => !!(data && Array.isArray(data.tracks) && ((data.clips || []).length || (data.media || []).length));

export function normClip(c) {
  return {
    speed: 1, in: 0, opacity: 1, volume: 1, pan: 0, fade_in: 0, fade_out: 0, effects: [], keyframes: {},
    transform: { x: 0, y: 0, scale: 1, rotation: 0 }, crop: { l: 0, t: 0, r: 0, b: 0 }, ...c,
  };
}

export const tracksOf = (doc, kind) => doc.tracks.filter((t) => t.kind === kind);
export const trackById = (doc, id) => doc.tracks.find((t) => t.id === id);
export const clipsOn = (doc, trackId) => doc.clips.filter((c) => c.track === trackId).sort((a, b) => a.start - b.start);
export const clipEnd = (c) => c.start + c.duration;
export const seqDuration = (doc) => doc.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
export const mediaOf = (doc, assetId) => doc.media.find((m) => m.id === assetId);
export const isVisual = (c) => c.type !== 'audio';

/** How long the source of a clip is, in source seconds (Infinity for stills, titles and mattes). */
export function sourceLength(doc, c) {
  if (!c.asset_id || c.type === 'image' || c.type === 'title') return Infinity;
  const m = mediaOf(doc, c.asset_id);
  return m?.duration || Infinity;
}

/** The track's kind accepts this clip type? */
export const fitsTrack = (track, type) => (track.kind === 'audio' ? type === 'audio' : type !== 'audio');

// ---------------------------------------------------------------- media

export function mediaFromAsset(a, bin = null) {
  return { id: a.id, name: a.name, kind: a.kind, duration: a.duration || null, width: a.width || null, height: a.height || null, fps: a.fps || null,
    has_audio: a.kind === 'audio' ? true : !!a.has_audio, bin, mark_in: null, mark_out: null };
}

export function addMedia(doc, assets, bin = null) {
  const have = new Set(doc.media.map((m) => m.id));
  return { ...doc, media: [...doc.media, ...assets.filter((a) => !have.has(a.id) && ['video', 'audio', 'image'].includes(a.kind)).map((a) => mediaFromAsset(a, bin))] };
}

/** The clips a media item makes when placed: video (+ linked audio), audio, or a still. `range` = { in, out } of the source. */
export function clipsForMedia(m, { start, vTrack, aTrack, range }) {
  const link = uid('l');
  const src = m.kind === 'image' ? null : m.duration || 0;
  const inn = range?.in ?? (m.mark_in ?? 0);
  const out = range?.out ?? (m.mark_out ?? (src ?? inn + STILL_DURATION));
  const dur = Math.max(0.04, out - inn);
  const base = { asset_id: m.id, name: m.name, start, in: m.kind === 'image' ? 0 : inn, duration: m.kind === 'image' ? (range?.out ? dur : STILL_DURATION) : dur };
  const out2 = [];
  if (m.kind === 'video' && vTrack) out2.push(normClip({ ...base, id: uid('c'), track: vTrack, type: 'video', link: m.has_audio && aTrack ? link : undefined }));
  if (m.kind === 'image' && vTrack) out2.push(normClip({ ...base, id: uid('c'), track: vTrack, type: 'image' }));
  if ((m.kind === 'audio' || (m.kind === 'video' && m.has_audio)) && aTrack) out2.push(normClip({ ...base, id: uid('c'), track: aTrack, type: 'audio', link: m.kind === 'video' && vTrack ? link : undefined }));
  return out2;
}

// ---------------------------------------------------------------- core edits

/** Splits a clip at timeline time t; returns [left, right] (or null if t isn't inside it). */
export function splitClip(c, t) {
  if (t <= c.start + EPS || t >= clipEnd(c) - EPS) return null;
  const d = t - c.start;
  const kf = (side) => Object.fromEntries(Object.entries(c.keyframes || {}).map(([k, list]) => [k, side === 'l'
    ? list.filter((x) => x.t <= d + EPS)
    : list.filter((x) => x.t >= d - EPS).map((x) => ({ ...x, t: x.t - d }))]));
  const left = { ...c, duration: d, fade_out: 0, keyframes: kf('l') };
  const right = { ...c, id: uid('c'), start: t, in: c.in + d * (c.speed || 1), duration: c.duration - d, fade_in: 0, transition_in: null, keyframes: kf('r') };
  return [left, right];
}

/** Clears [a, b) on a track (overwrite): clips there are trimmed, split or removed. `keep` = ids left alone. */
export function clearRange(clips, trackId, a, b, keep = new Set()) {
  const out = [];
  for (const c of clips) {
    if (c.track !== trackId || keep.has(c.id) || clipEnd(c) <= a + EPS || c.start >= b - EPS) { out.push(c); continue; }
    if (c.start < a - EPS && clipEnd(c) > b + EPS) { // spans the range: keep both ends
      const [l, r] = splitClip(c, a);
      const [, rr] = splitClip(r, b);
      out.push(l, { ...rr, link: c.link ? `${c.link}-r` : undefined });
    } else if (c.start < a - EPS) out.push({ ...c, duration: a - c.start, fade_out: 0 });
    else if (clipEnd(c) > b + EPS) { const [, r] = splitClip(c, b); out.push({ ...r, id: c.id }); }
    // else: fully covered → removed
  }
  return out;
}

/** Re-links the right halves of split linked pairs (clearRange gives them a `-r` link) so they stay together. */
const fixLinks = (clips) => {
  const n = {};
  for (const c of clips) if (c.link) n[c.link] = (n[c.link] || 0) + 1;
  return clips.map((c) => (c.link && n[c.link] < 2 ? { ...c, link: undefined } : c));
};

/** Places clips with overwrite (clears their ranges first). */
export function overwrite(doc, newClips) {
  let clips = doc.clips;
  for (const c of newClips) clips = clearRange(clips, c.track, c.start, clipEnd(c));
  return { ...doc, clips: fixLinks([...clips, ...newClips]) };
}

/** Inserts clips at t: everything on their tracks from t on moves right by `len` (clips under t are split). */
export function insertAt(doc, newClips, t, len) {
  const tracks = new Set(newClips.map((c) => c.track));
  let clips = [];
  for (const c of doc.clips) {
    if (!tracks.has(c.track)) { clips.push(c); continue; }
    const parts = splitClip(c, t);
    if (parts) clips.push(parts[0], { ...parts[1], start: parts[1].start + len });
    else clips.push(c.start >= t - EPS ? { ...c, start: c.start + len } : c);
  }
  clips = [...clips, ...newClips];
  return { ...doc, clips: fixLinks(clips) };
}

/** Deletes clips; ripple closes the gap they leave on their tracks. */
export function deleteClips(doc, ids, { ripple = false } = {}) {
  const del = doc.clips.filter((c) => ids.has(c.id));
  let clips = doc.clips.filter((c) => !ids.has(c.id));
  if (ripple) {
    // Per track, close each removed range (latest first so times stay valid).
    const byTrack = {};
    for (const c of del) (byTrack[c.track] ||= []).push([c.start, clipEnd(c)]);
    for (const [tid, ranges] of Object.entries(byTrack)) {
      for (const [a, b] of ranges.sort((x, y) => y[0] - x[0])) {
        const len = b - a;
        clips = clips.map((c) => (c.track === tid && c.start >= b - EPS ? { ...c, start: c.start - len } : c));
      }
    }
  }
  return { ...doc, clips: fixLinks(clips) };
}

/** Removes an empty gap [a, b) on a track by moving later clips left (Premiere: select gap, Delete). */
export function closeGap(doc, trackId, a, b) {
  const len = b - a;
  return { ...doc, clips: doc.clips.map((c) => (c.track === trackId && c.start >= b - EPS ? { ...c, start: c.start - len } : c)) };
}

/** Cuts clips at t (Ctrl+K). ids: which clips (default: every clip under t on unlocked tracks). */
export function razorAt(doc, t, ids = null) {
  const locked = new Set(doc.tracks.filter((x) => x.lock).map((x) => x.id));
  const linkMap = {};
  const clips = [];
  for (const c of doc.clips) {
    if (locked.has(c.track) || (ids && !ids.has(c.id))) { clips.push(c); continue; }
    const parts = splitClip(c, t);
    if (!parts) { clips.push(c); continue; }
    if (c.link) { linkMap[c.link] ||= uid('l'); parts[1].link = linkMap[c.link]; }
    clips.push(...parts);
  }
  return { ...doc, clips };
}

/** The clip on a track at time t. */
export const clipAt = (doc, trackId, t) => doc.clips.find((c) => c.track === trackId && c.start <= t + EPS && clipEnd(c) > t + EPS);

/** Every edit point (clip starts and ends) sorted, for Up/Down and snapping. */
export function editPoints(doc) {
  const s = new Set([0]);
  for (const c of doc.clips) { s.add(+c.start.toFixed(4)); s.add(+clipEnd(c).toFixed(4)); }
  return [...s].sort((a, b) => a - b);
}

/** Ripple trim to the playhead: Q trims the head of clips under t, W the tail; later clips move to close the gap. */
export function rippleTrimTo(doc, t, side) {
  const locked = new Set(doc.tracks.filter((x) => x.lock).map((x) => x.id));
  const under = doc.clips.filter((c) => !locked.has(c.track) && c.start < t - EPS && clipEnd(c) > t + EPS);
  if (!under.length) return doc;
  let clips = doc.clips;
  if (side === 'head') {
    // Remove [start, t) from each; the whole timeline after shifts left by the largest trim on that track.
    for (const u of under) {
      const d = t - u.start;
      clips = clips.map((c) => {
        if (c.id === u.id) { const [, r] = splitClip(c, t); return { ...r, id: c.id, start: c.start, transition_in: c.transition_in, link: c.link }; }
        if (c.track === u.track && c.start >= clipEnd(u) - EPS) return { ...c, start: c.start - d };
        return c;
      });
    }
  } else {
    for (const u of under) {
      const d = clipEnd(u) - t;
      clips = clips.map((c) => {
        if (c.id === u.id) return { ...c, duration: t - c.start, fade_out: 0 };
        if (c.track === u.track && c.start >= clipEnd(u) - EPS) return { ...c, start: c.start - d };
        return c;
      });
    }
  }
  return { ...doc, clips };
}

// ---------------------------------------------------------------- keyframes

export const KF_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume'];
/** Base (unkeyframed) value of a property. */
export function baseValue(c, prop) {
  if (prop === 'x' || prop === 'y' || prop === 'scale' || prop === 'rotation') return c.transform?.[prop] ?? (prop === 'scale' ? 1 : 0);
  return c[prop] ?? 1;
}
/** Interpolated value at clip time ct (keyframes are linear and held at the ends, matching the server). */
export function valueAt(c, prop, ct) {
  const list = c.keyframes?.[prop];
  if (!list || list.length < 2) return list?.length === 1 ? list[0].v : baseValue(c, prop);
  const k = [...list].sort((a, b) => a.t - b.t);
  if (ct <= k[0].t) return k[0].v;
  for (let i = 0; i < k.length - 1; i++) {
    if (ct < k[i + 1].t) return k[i].v + (k[i + 1].v - k[i].v) * ((ct - k[i].t) / Math.max(1e-6, k[i + 1].t - k[i].t));
  }
  return k[k.length - 1].v;
}
/** Sets a property at clip time ct: updates the keyframe there (or adds one) if the property is animated, else the base value. */
export function setValueAt(c, prop, ct, v) {
  const list = c.keyframes?.[prop];
  if (!list?.length) {
    if (['x', 'y', 'scale', 'rotation'].includes(prop)) return { ...c, transform: { ...c.transform, [prop]: v } };
    return { ...c, [prop]: v };
  }
  const i = list.findIndex((k) => Math.abs(k.t - ct) < 1 / 120);
  const next = i >= 0 ? list.map((k, j) => (j === i ? { ...k, v } : k)) : [...list, { t: ct, v }].sort((a, b) => a.t - b.t);
  return { ...c, keyframes: { ...c.keyframes, [prop]: next } };
}
export function toggleAnimate(c, prop, ct) {
  const list = c.keyframes?.[prop];
  if (list?.length) { // turning animation off keeps the current value
    const v = valueAt(c, prop, ct);
    const { [prop]: _, ...rest } = c.keyframes;
    return setValueAt({ ...c, keyframes: rest }, prop, ct, v);
  }
  return { ...c, keyframes: { ...(c.keyframes || {}), [prop]: [{ t: ct, v: baseValue(c, prop) }] } };
}
export function toggleKeyAt(c, prop, ct) {
  const list = c.keyframes?.[prop] || [];
  const i = list.findIndex((k) => Math.abs(k.t - ct) < 1 / 120);
  if (i >= 0) return { ...c, keyframes: { ...c.keyframes, [prop]: list.filter((_, j) => j !== i) } };
  return { ...c, keyframes: { ...(c.keyframes || {}), [prop]: [...list, { t: ct, v: valueAt(c, prop, ct) }].sort((a, b) => a.t - b.t) } };
}

// ---------------------------------------------------------------- effects

// One-to-one with the server renderer's effect list (server/src/render.js effectFilters).
export const EFFECTS = [
  { type: 'brightness', label: 'Brightness', group: 'Color', min: -1, max: 1, step: 0.01, def: 0.1 },
  { type: 'contrast', label: 'Contrast', group: 'Color', min: 0, max: 3, step: 0.01, def: 1.2 },
  { type: 'saturation', label: 'Saturation', group: 'Color', min: 0, max: 3, step: 0.01, def: 1.3 },
  { type: 'exposure', label: 'Exposure', group: 'Color', min: -3, max: 3, step: 0.05, def: 0.5 },
  { type: 'temperature', label: 'Temperature', group: 'Color', min: 2000, max: 12000, step: 50, def: 5000, unit: 'K' },
  { type: 'hue', label: 'Hue', group: 'Color', min: -180, max: 180, step: 1, def: 30, unit: '°' },
  { type: 'grayscale', label: 'Black & White', group: 'Color' },
  { type: 'sepia', label: 'Sepia', group: 'Color' },
  { type: 'invert', label: 'Invert', group: 'Color' },
  { type: 'lut', label: 'LUT (.cube)', group: 'Color', lut: true },
  { type: 'blur', label: 'Gaussian Blur', group: 'Blur & Sharpen', min: 0, max: 60, step: 0.5, def: 6 },
  { type: 'sharpen', label: 'Sharpen', group: 'Blur & Sharpen', min: 0, max: 5, step: 0.1, def: 1 },
  { type: 'denoise', label: 'Denoise', group: 'Blur & Sharpen', min: 0, max: 20, step: 0.5, def: 4 },
  { type: 'vignette', label: 'Vignette', group: 'Stylize', min: 0, max: 1.5, step: 0.05, def: 0.6 },
  { type: 'pixelate', label: 'Mosaic', group: 'Stylize', min: 2, max: 64, step: 1, def: 12 },
  { type: 'flip_h', label: 'Horizontal Flip', group: 'Transform' },
  { type: 'flip_v', label: 'Vertical Flip', group: 'Transform' },
  { type: 'chroma_key', label: 'Chroma Key', group: 'Keying', key: true },
];
export const effectDef = (type) => EFFECTS.find((e) => e.type === type);
export function newEffect(type) {
  const d = effectDef(type);
  return { id: uid('e'), type, enabled: true, ...(d.def !== undefined ? { value: d.def } : {}), ...(d.key ? { color: '#00ff00', similarity: 0.15, blend: 0.05 } : {}) };
}

export const VIDEO_TRANSITIONS = [
  { type: 'dissolve', label: 'Cross Dissolve' },
  { type: 'dip_black', label: 'Dip to Black' },
  { type: 'dip_white', label: 'Dip to White' },
];
export const AUDIO_TRANSITIONS = [{ type: 'crossfade', label: 'Constant Power' }];
export const transitionLabel = (t) => [...VIDEO_TRANSITIONS, ...AUDIO_TRANSITIONS].find((x) => x.type === t)?.label || t;

/** The clip that ends where c starts on the same track (the outgoing side of c's transition). */
export const prevAdjacent = (doc, c) => doc.clips.find((p) => p.track === c.track && p.id !== c.id && Math.abs(clipEnd(p) - c.start) < 0.02);
export const nextAdjacent = (doc, c) => doc.clips.find((p) => p.track === c.track && p.id !== c.id && Math.abs(p.start - clipEnd(c)) < 0.02);

/**
 * The same transition logic as the server (render.js applyTransitions), for the preview: returns the track's clips with
 * dissolves extended into their neighbours plus _xin / _xout / _dip_in / _dip_out.
 */
export function resolveTrack(doc, clips, isAudio) {
  const list = clips.map((c) => ({ ...c })).sort((a, b) => a.start - b.start);
  for (let i = 0; i < list.length; i++) {
    const c = list[i]; const tr = c.transition_in;
    if (!tr?.type) continue;
    const prev = list.slice(0, i).reverse().find((p) => Math.abs(clipEnd(p) - c.start) < 0.02);
    const d = clamp(tr.duration || 1, 0.04, 10);
    if (!prev) { if (!isAudio && tr.type.startsWith('dip')) c._dip_in = { d, color: tr.type === 'dip_white' ? '#ffffff' : '#000000' }; else c.fade_in = Math.max(c.fade_in || 0, d); continue; }
    if (tr.type === 'dip_black' || tr.type === 'dip_white') {
      const color = tr.type === 'dip_white' ? '#ffffff' : '#000000';
      const h = Math.min(d / 2, prev.duration, c.duration);
      prev._dip_out = { d: h, color }; c._dip_in = { d: h, color };
      continue;
    }
    const sp = c.speed || 1; const psp = prev.speed || 1;
    const a = Math.max(0, Math.min(d / 2, c.in / sp));
    const b = Math.max(0, Math.min(d / 2, (sourceLength(doc, prev) - (prev.in + prev.duration * psp)) / psp));
    if (a + b < 0.02) continue;
    c.start -= a; c.in -= a * sp; c.duration += a; c._shift = a;
    prev.duration += b;
    c._xin = a + b;
    if (isAudio) prev._xout = a + b;
  }
  for (const c of list) if (c._shift) c.keyframes = Object.fromEntries(Object.entries(c.keyframes || {}).map(([k, l]) => [k, l.map((x) => ({ ...x, t: x.t + c._shift }))]));
  return list;
}

// ---------------------------------------------------------------- titles

export const TITLE_DEFAULT = {
  text: 'Your title', font: 'Montserrat', size: 96, weight: 700, italic: false, color: '#ffffff', align: 'center',
  x: 0.5, y: 0.5, line: 1.15, tracking: 0,
  box: false, boxColor: '#000000b3', boxPad: 24, boxRadius: 10,
  shadow: true, stroke: 0, strokeColor: '#000000',
  anim_in: 'fade', anim_out: 'fade', anim_dur: 0.5,
};
export const CAPTION_DEFAULT = { ...TITLE_DEFAULT, text: 'Caption', font: 'Inter', size: 44, weight: 600, y: 0.88, box: true, boxColor: '#000000b3', boxPad: 14, boxRadius: 6, shadow: false, anim_in: 'none', anim_out: 'none' };

/**
 * A clip as it renders: title animations become fades / position keyframes (the same in the preview and the export).
 */
export function effective(c, doc) {
  if (c.type !== 'title' || !c.title) return c;
  const t = c.title; const d = clamp(t.anim_dur ?? 0.5, 0.05, c.duration / 2);
  let out = { ...c };
  if (t.anim_in === 'fade' || t.anim_in?.startsWith('slide')) out.fade_in = Math.max(out.fade_in || 0, d);
  if (t.anim_out === 'fade' || t.anim_out?.startsWith('slide')) out.fade_out = Math.max(out.fade_out || 0, d);
  const slide = (dir) => (dir === 'slide_up' ? ['y', doc.height * 0.08] : dir === 'slide_left' ? ['x', doc.width * 0.12] : dir === 'slide_right' ? ['x', -doc.width * 0.12] : null);
  const kf = { ...(out.keyframes || {}) };
  const sIn = slide(t.anim_in); const sOut = slide(t.anim_out);
  for (const prop of ['x', 'y']) {
    if (kf[prop]?.length) continue; // the person's own keyframes win
    const base = baseValue(c, prop);
    const list = [];
    if (sIn?.[0] === prop) list.push({ t: 0, v: base + sIn[1] }, { t: d, v: base });
    if (sOut?.[0] === prop) { if (!list.length) list.push({ t: 0, v: base }); list.push({ t: c.duration - d, v: base }, { t: c.duration, v: base - sOut[1] }); }
    if (list.length) kf[prop] = list;
  }
  out.keyframes = kf;
  return out;
}

// ---------------------------------------------------------------- captions (SRT)

export function parseSrt(text) {
  const out = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map((s) => s.trim().split(/\s/)[0]);
    const t = (s) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : null; };
    const start = t(a); const end = t(b);
    const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (start !== null && end !== null && end > start && body) out.push({ start, end, text: body });
  }
  return out;
}
export function toSrt(items) {
  const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
  return items.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
}

// ---------------------------------------------------------------- solo / mute

/** Whether a track contributes to the output (hidden / muted / not soloed while others are). */
export function trackAudible(doc, t) {
  if (t.mute) return false;
  const solo = doc.tracks.some((x) => x.kind === t.kind && x.solo);
  return !solo || t.solo;
}
export function trackVisible(doc, t) {
  if (t.hidden) return false;
  const solo = doc.tracks.some((x) => x.kind === 'video' && x.solo);
  return !solo || t.solo;
}

// ---------------------------------------------------------------- server render spec

/**
 * Builds the timeline spec for server/src/render.js. opts: { width, height, range: { start, end }, output, titleAsset(clip) }.
 * Positions are in sequence pixels, so they're scaled when the export size differs.
 */
export function buildSpec(doc, { width = doc.width, height = doc.height, range, output, titleAsset }) {
  const k = width / doc.width;
  const kfScaled = (c) => {
    const out = {};
    for (const [p, l] of Object.entries(c.keyframes || {})) {
      if (!l?.length) continue;
      out[p] = l.map((x) => ({ t: +x.t.toFixed(4), v: (p === 'x' || p === 'y') ? x.v * k : x.v }));
    }
    return out;
  };
  const effects = (c) => (c.effects || []).filter((e) => e.enabled !== false).map(({ id, enabled, ...e }) => e);
  const video = tracksOf(doc, 'video').map((t) => ({
    hidden: !trackVisible(doc, t),
    clips: clipsOn(doc, t.id).map((c0) => {
      const c = effective(c0, doc);
      const base = {
        start: +c.start.toFixed(4), duration: +c.duration.toFixed(4), opacity: c.opacity, fade_in: c.fade_in || 0, fade_out: c.fade_out || 0,
        transform: { x: (c.transform?.x || 0) * k, y: (c.transform?.y || 0) * k, scale: c.transform?.scale ?? 1, rotation: c.transform?.rotation || 0, fit: 'contain' },
        crop: c.crop, effects: effects(c), keyframes: kfScaled(c), transition_in: c.transition_in || undefined,
      };
      if (c.type === 'color') return { ...base, color: c.color || '#000000' };
      if (c.type === 'title') return { ...base, asset_id: titleAsset(c0) };
      return { ...base, asset_id: c.asset_id, in: +(c.in || 0).toFixed(4), speed: c.speed || 1, mute: true };
    }).filter((c) => c.asset_id || c.color),
  }));
  const audio = tracksOf(doc, 'audio').map((t) => ({
    mute: !trackAudible(doc, t), volume: t.volume ?? 1, pan: t.pan || 0,
    clips: clipsOn(doc, t.id).map((c) => ({
      asset_id: c.asset_id, start: +c.start.toFixed(4), in: +(c.in || 0).toFixed(4), duration: +c.duration.toFixed(4), speed: c.speed || 1,
      volume: c.volume ?? 1, pan: c.pan || 0, fade_in: c.fade_in || 0, fade_out: c.fade_out || 0, mute: !!c.mute,
      keyframes: c.keyframes?.volume?.length ? { volume: c.keyframes.volume } : undefined, transition_in: c.transition_in || undefined,
    })),
  }));
  return {
    width: Math.round(width / 2) * 2, height: Math.round(height / 2) * 2, fps: doc.fps, duration: seqDuration(doc), background: '#000000',
    master_volume: doc.master ?? 1, video, audio, ...(range ? { range } : {}), output,
  };
}
