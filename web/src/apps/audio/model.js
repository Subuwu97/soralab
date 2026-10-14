// The Audio document: a multitrack session saved as JSON. Sound lives in assets (referenced by id); the session
// only says where each clip sits, how loud it is, and which effects each track runs.
//
//   { v, sampleRate, tracks: [Track], master: { volume, effects }, markers: [{ id, t, name }], loop: { start, end, on } | null,
//     files: [{ id, name, duration, kind }], duck: { on, target, sources, amount, threshold, attack, release } | null }
//   Track: { id, name, color, volume (dB), pan (-1..1), mute, solo, height, effects: [Effect], clips: [Clip] }
//   Clip:  { id, asset, name, start, in, dur, gain (dB), fadeIn: { d, shape }, fadeOut: { d, shape }, env: [{ t, v }] }
//          start = timeline seconds, in = seconds into the source, env times are SOURCE seconds (so trims and splits keep
//          the envelope glued to the sound) and values are dB.
import { newEffect, PRESETS } from './effects.js';

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const EPS = 1e-6;
export const TRACK_COLORS = ['#00e4bb', '#5AB4FF', '#FFC36B', '#FF8FB1', '#8B7CFF', '#7ee081', '#ff9a5c', '#4dd0e1'];
export const TRACK_H = 96;
export const SHAPES = [['linear', 'Linear'], ['log', 'Logarithmic (fast)'], ['exp', 'Exponential (slow)'], ['scurve', 'S-curve'], ['equal', 'Equal power']];

export const dbToGain = (db) => (db <= -60 ? 0 : 10 ** (db / 20));
export const gainToDb = (g) => (g <= 0.001 ? -60 : 20 * Math.log10(g));
export const fmtDb = (db) => (db <= -60 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

export function newTrack(doc, name, extra = {}) {
  const n = (doc?.tracks?.length || 0);
  return { id: uid('t'), name: name || `Track ${n + 1}`, color: TRACK_COLORS[n % TRACK_COLORS.length], volume: 0, pan: 0, mute: false, solo: false, height: TRACK_H, effects: [], clips: [], ...extra };
}

export function newClip(file, start = 0, extra = {}) {
  return {
    id: uid('c'), asset: file.id, name: (file.name || 'Clip').replace(/\.[^.]+$/, ''), start, in: 0, dur: Math.max(0.05, file.duration || 1),
    gain: 0, fadeIn: { d: 0, shape: 'linear' }, fadeOut: { d: 0, shape: 'linear' }, env: [], ...extra,
  };
}

export const fileOf = (asset) => ({ id: asset.id, name: asset.name, duration: asset.duration || 0, kind: asset.kind });

export function emptyDoc(meta = {}) {
  const sampleRate = Number(meta.sampleRate) || 48000;
  const doc = { v: 1, sampleRate, tracks: [], master: { volume: 0, effects: [] }, markers: [], loop: null, files: [], duck: null };
  if (meta.template === 'podcast') {
    // Two voices with a broadcast chain, a music bed that ducks under them, and a safety limiter on the master.
    const host = newTrack(doc, 'Host', { effects: PRESETS.podcast.make() });
    doc.tracks.push(host);
    const guest = newTrack(doc, 'Guest', { effects: PRESETS.podcast.make() });
    doc.tracks.push(guest);
    const music = newTrack(doc, 'Music', { volume: -8 });
    doc.tracks.push(music);
    doc.master.effects = [newEffect('limiter', { ceiling: -1 })];
    doc.duck = { on: true, target: music.id, sources: [host.id, guest.id], amount: -14, threshold: -42, attack: 0.15, release: 0.8 };
  } else {
    for (let i = 0; i < 4; i++) doc.tracks.push(newTrack(doc));
  }
  return doc;
}

export const hasContent = (data) => !!(data && Array.isArray(data.tracks));

/** Saved JSON → a complete document (fills in anything older saves lack). */
export function fromSaved(data, meta = {}) {
  if (!hasContent(data)) return emptyDoc(meta);
  const d = { ...emptyDoc({ sampleRate: data.sampleRate || meta.sampleRate }), ...data };
  d.tracks = data.tracks.map((t, i) => ({
    ...newTrack(null), color: TRACK_COLORS[i % TRACK_COLORS.length], ...t,
    effects: t.effects || [],
    clips: (t.clips || []).map((c) => ({ gain: 0, fadeIn: { d: 0, shape: 'linear' }, fadeOut: { d: 0, shape: 'linear' }, env: [], in: 0, ...c })),
  }));
  d.master = { volume: 0, effects: [], ...(data.master || {}) };
  d.markers = data.markers || [];
  d.files = data.files || [];
  return d;
}

// ---------------------------------------------------------------- queries

export const clipEnd = (c) => c.start + c.dur;
export const allClips = (doc) => doc.tracks.flatMap((t) => t.clips.map((c) => ({ track: t, clip: c })));
export const findClip = (doc, id) => { for (const t of doc.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return { track: t, clip: c }; } return null; };
export const sessionEnd = (doc) => Math.max(0, ...doc.tracks.flatMap((t) => t.clips.map(clipEnd)));
export const fileById = (doc, id) => doc.files.find((f) => f.id === id);

/** Fade lengths actually used: a clip overlapping another on the same track crossfades over the overlap. */
export function effectiveFades(track, clip) {
  let fi = { ...clip.fadeIn }; let fo = { ...clip.fadeOut };
  for (const o of track.clips) {
    if (o.id === clip.id) continue;
    // o overlaps our head
    if (o.start < clip.start && clipEnd(o) > clip.start) {
      const ov = Math.min(clipEnd(o), clipEnd(clip)) - clip.start;
      if (ov > fi.d) fi = { d: ov, shape: 'equal', xfade: true };
    }
    // o overlaps our tail
    if (o.start > clip.start && o.start < clipEnd(clip) && clipEnd(o) > clipEnd(clip)) {
      const ov = clipEnd(clip) - o.start;
      if (ov > fo.d) fo = { d: ov, shape: 'equal', xfade: true };
    }
  }
  fi.d = clamp(fi.d, 0, clip.dur); fo.d = clamp(fo.d, 0, clip.dur);
  return { fi, fo };
}

/** 0..1 → 0..1 for a fade-in of the given shape (fade-outs use shape(1 - x)). */
export function fadeShape(x, shape) {
  x = clamp(x, 0, 1);
  switch (shape) {
    case 'log': return 1 - (1 - x) * (1 - x);
    case 'exp': return x * x;
    case 'scurve': return 0.5 - 0.5 * Math.cos(Math.PI * x);
    case 'equal': return Math.sin((Math.PI / 2) * x);
    default: return x;
  }
}

/** Envelope level (dB) at a source time. */
export function envDb(env, t) {
  if (!env?.length) return 0;
  if (t <= env[0].t) return env[0].v;
  for (let i = 1; i < env.length; i++) {
    if (t <= env[i].t) { const a = env[i - 1]; const b = env[i]; return a.v + ((b.v - a.v) * (t - a.t)) / Math.max(EPS, b.t - a.t); }
  }
  return env[env.length - 1].v;
}

/** Linear gain of a clip at a time relative to its start (fades, crossfades, envelope and clip gain together). */
export function clipGainAt(clip, fades, rel) {
  let g = dbToGain(clip.gain + envDb(clip.env, clip.in + rel));
  if (fades.fi.d > 0 && rel < fades.fi.d) g *= fadeShape(rel / fades.fi.d, fades.fi.shape);
  const left = clip.dur - rel;
  if (fades.fo.d > 0 && left < fades.fo.d) g *= fadeShape(left / fades.fo.d, fades.fo.shape);
  return g;
}

/** True when the gain changes over the clip (so playback needs an automation curve). */
export const clipIsAutomated = (clip, fades) => fades.fi.d > 0 || fades.fo.d > 0 || (clip.env?.length || 0) > 0;

// ---------------------------------------------------------------- edits (all return a new document)

export const mapTracks = (doc, fn) => ({ ...doc, tracks: doc.tracks.map(fn) });
export const updateTrack = (doc, id, patch) => mapTracks(doc, (t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t));
export const updateClip = (doc, id, patch) => mapTracks(doc, (t) => (t.clips.some((c) => c.id === id)
  ? { ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c)) } : t));
export const sortClips = (clips) => [...clips].sort((a, b) => a.start - b.start);

export function addFiles(doc, files) {
  const have = new Set(doc.files.map((f) => f.id));
  return { ...doc, files: [...doc.files, ...files.filter((f) => !have.has(f.id))] };
}

export function addClip(doc, trackId, clip) {
  return updateTrack(doc, trackId, (t) => ({ clips: sortClips([...t.clips, clip]) }));
}

export function deleteClips(doc, ids) {
  const s = new Set(ids);
  return mapTracks(doc, (t) => (t.clips.some((c) => s.has(c.id)) ? { ...t, clips: t.clips.filter((c) => !s.has(c.id)) } : t));
}

/** Splits a clip at a timeline time; returns [doc, newRightClipId]. */
export function splitClip(doc, id, at) {
  const f = findClip(doc, id);
  if (!f) return [doc, null];
  const c = f.clip;
  if (at <= c.start + 0.005 || at >= clipEnd(c) - 0.005) return [doc, null];
  const leftDur = at - c.start;
  const left = { ...c, dur: leftDur, fadeOut: { d: 0, shape: c.fadeOut.shape } , fadeIn: { ...c.fadeIn, d: Math.min(c.fadeIn.d, leftDur) } };
  const right = { ...c, id: uid('c'), start: at, in: c.in + leftDur, dur: c.dur - leftDur, fadeIn: { d: 0, shape: c.fadeIn.shape }, fadeOut: { ...c.fadeOut, d: Math.min(c.fadeOut.d, c.dur - leftDur) } };
  return [updateTrack(doc, f.track.id, (t) => ({ clips: sortClips(t.clips.flatMap((x) => (x.id === id ? [left, right] : [x]))) })), right.id];
}

/** Splits every clip in `ids` (or every clip on all tracks when ids is null) that spans `at`. */
export function splitAt(doc, at, ids = null) {
  let d = doc; let n = 0;
  for (const { clip } of allClips(doc)) {
    if (ids && !ids.includes(clip.id)) continue;
    if (clip.start < at && clipEnd(clip) > at) { const [nd, r] = splitClip(d, clip.id, at); if (r) { d = nd; n++; } }
  }
  return [d, n];
}

/** Moves clips to a new track list (used by drag): moves = [{ id, start, trackId }]. */
export function moveClips(doc, moves) {
  const byId = new Map(moves.map((m) => [m.id, m]));
  const moving = allClips(doc).filter(({ clip }) => byId.has(clip.id)).map(({ clip }) => ({ ...clip, start: Math.max(0, byId.get(clip.id).start) }));
  let d = deleteClips(doc, [...byId.keys()]);
  for (const c of moving) d = addClip(d, byId.get(c.id).trackId, c);
  return d;
}

/** Points every clip using `from` at a new asset (destructive edits): keeps durations inside the new file. */
export function repointClip(doc, clipId, file, { oldDuration }) {
  return updateClip(doc, clipId, (c) => {
    const whole = c.in < 0.001 && Math.abs(c.dur - oldDuration) < 0.01;
    const inn = Math.min(c.in, Math.max(0, file.duration - 0.05));
    const dur = whole ? file.duration : Math.max(0.05, Math.min(c.dur, file.duration - inn));
    return { asset: file.id, in: inn, dur, env: c.env.filter((p) => p.t <= file.duration) };
  });
}

/** Snapshot of everything the session sounds like, for "did the audio change?" checks. */
export const soundKey = (doc) => JSON.stringify([doc.tracks.map((t) => [t.id, t.clips]), doc.duck]);
