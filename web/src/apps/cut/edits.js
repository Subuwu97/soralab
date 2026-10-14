// Timeline drag edits as pure functions of the document at drag start (`base`) and the drag distance `dt` in seconds.
// Each clamps dt so every clip involved stays valid (inside its source media, at least one frame long, not running into
// neighbours), applying the same dt to linked clips so picture and sound stay in sync.
import { clipEnd, clearRange, sourceLength, clipsOn, EPS, uid, trackById, tracksOf } from './model.js';

const minDur = (doc) => 1 / (doc.fps || 30);
const byId = (doc) => new Map(doc.clips.map((c) => [c.id, c]));
const neighbours = (doc, c, ids) => {
  const same = clipsOn(doc, c.track).filter((x) => !ids.has(x.id));
  const prevEnd = Math.max(0, ...same.filter((x) => clipEnd(x) <= c.start + EPS).map(clipEnd));
  const nextStart = Math.min(Infinity, ...same.filter((x) => x.start >= clipEnd(c) - EPS).map((x) => x.start));
  return { prevEnd, nextStart };
};
const lo = (a, b) => Math.max(a, b);
const hi = (a, b) => Math.min(a, b);
const map = (doc, fn) => ({ ...doc, clips: doc.clips.map((c) => { const x = fn(c); return x !== c && x.in < 0 ? { ...x, in: 0 } : x; }) });
// Stills, titles and mattes have no source to run out of, so their `in` never limits an edit.
const headRoom = (base, c) => (Number.isFinite(sourceLength(base, c)) ? -c.in / (c.speed || 1) : -Infinity);

/** Trim an edge (Selection tool). side: 'left' | 'right'. */
export function trim(base, ids, side, dt) {
  const m = byId(base); let a = -Infinity; let b = Infinity;
  for (const id of ids) {
    const c = m.get(id); const sp = c.speed || 1; const src = sourceLength(base, c); const { prevEnd, nextStart } = neighbours(base, c, ids);
    if (side === 'left') {
      a = lo(a, prevEnd - c.start); a = lo(a, headRoom(base, c));
      b = hi(b, c.duration - minDur(base));
    } else {
      a = lo(a, minDur(base) - c.duration);
      b = hi(b, nextStart - clipEnd(c)); b = hi(b, (src - c.in) / sp - c.duration);
    }
  }
  const d = Math.max(a, Math.min(b, dt));
  return map(base, (c) => {
    if (!ids.has(c.id)) return c;
    if (side === 'left') return { ...c, start: c.start + d, in: c.in + d * (c.speed || 1), duration: c.duration - d, keyframes: shiftKf(c.keyframes, -d) };
    return { ...c, duration: c.duration + d };
  });
}

const shiftKf = (kf, d) => (kf ? Object.fromEntries(Object.entries(kf).map(([k, l]) => [k, l.map((x) => ({ ...x, t: x.t + d }))])) : kf);

/** Ripple edit (B): trims an edge and moves everything after it on the same tracks, so no gap opens. */
export function ripple(base, ids, side, dt) {
  const m = byId(base); let a = -Infinity; let b = Infinity;
  for (const id of ids) {
    const c = m.get(id); const sp = c.speed || 1; const src = sourceLength(base, c);
    if (side === 'left') { a = lo(a, headRoom(base, c)); b = hi(b, c.duration - minDur(base)); }
    else { a = lo(a, minDur(base) - c.duration); b = hi(b, (src - c.in) / sp - c.duration); }
  }
  const d = Math.max(a, Math.min(b, dt));
  const edits = [...ids].map((id) => m.get(id));
  return map(base, (c) => {
    if (ids.has(c.id)) {
      if (side === 'left') return { ...c, in: c.in + d * (c.speed || 1), duration: c.duration - d, keyframes: shiftKf(c.keyframes, -d) };
      return { ...c, duration: c.duration + d };
    }
    const e = edits.find((x) => x.track === c.track && c.start >= clipEnd(x) - EPS);
    if (e) return { ...c, start: c.start + (side === 'left' ? -d : d) };
    return c;
  });
}

/** Pairs of clips meeting at the edit point on the given edge, for each clip id. */
function editPairs(doc, ids, side) {
  const m = byId(doc); const pairs = [];
  for (const id of ids) {
    const c = m.get(id);
    const other = doc.clips.find((x) => x.track === c.track && x.id !== c.id && (side === 'right' ? Math.abs(x.start - clipEnd(c)) < 0.02 : Math.abs(clipEnd(x) - c.start) < 0.02));
    if (other) pairs.push(side === 'right' ? [c, other] : [other, c]);
  }
  return pairs;
}

/** Rolling edit (N): moves an edit point — the outgoing clip gets longer as the incoming one gets shorter. */
export function roll(base, ids, side, dt) {
  const pairs = editPairs(base, ids, side);
  if (!pairs.length) return trim(base, ids, side, dt);
  let a = -Infinity; let b = Infinity;
  for (const [A, B] of pairs) {
    a = lo(a, minDur(base) - A.duration); a = lo(a, headRoom(base, B));
    b = hi(b, B.duration - minDur(base)); b = hi(b, (sourceLength(base, A) - A.in) / (A.speed || 1) - A.duration);
  }
  const d = Math.max(a, Math.min(b, dt));
  const As = new Set(pairs.map((p) => p[0].id)); const Bs = new Set(pairs.map((p) => p[1].id));
  return map(base, (c) => {
    if (As.has(c.id)) return { ...c, duration: c.duration + d };
    if (Bs.has(c.id)) return { ...c, start: c.start + d, in: c.in + d * (c.speed || 1), duration: c.duration - d, keyframes: shiftKf(c.keyframes, -d) };
    return c;
  });
}

/** Slip (Y): same place and length on the timeline, different part of the source. */
export function slip(base, ids, dt) {
  const m = byId(base); let a = -Infinity; let b = Infinity;
  for (const id of ids) {
    const c = m.get(id); const sp = c.speed || 1; const src = sourceLength(base, c);
    if (!Number.isFinite(src)) continue;
    // dragging right shows earlier frames (in decreases)
    a = lo(a, (c.in + c.duration * sp - src) / sp); b = hi(b, c.in / sp);
  }
  const d = Math.max(a, Math.min(b, dt));
  return map(base, (c) => (ids.has(c.id) && Number.isFinite(sourceLength(base, c)) ? { ...c, in: c.in - d * (c.speed || 1) } : c));
}

/** Slide (U): moves a clip between its neighbours, which get longer / shorter to fill around it. */
export function slide(base, ids, dt) {
  const m = byId(base); let a = -Infinity; let b = Infinity;
  const prevs = new Map(); const nexts = new Map();
  for (const id of ids) {
    const c = m.get(id);
    const p = base.clips.find((x) => x.track === c.track && !ids.has(x.id) && Math.abs(clipEnd(x) - c.start) < 0.02);
    const n = base.clips.find((x) => x.track === c.track && !ids.has(x.id) && Math.abs(x.start - clipEnd(c)) < 0.02);
    const { prevEnd, nextStart } = neighbours(base, c, ids);
    if (p) { prevs.set(p.id, c.id); a = lo(a, minDur(base) - p.duration); b = hi(b, (sourceLength(base, p) - p.in) / (p.speed || 1) - p.duration); }
    else a = lo(a, prevEnd - c.start);
    if (n) { nexts.set(n.id, c.id); a = lo(a, headRoom(base, n)); b = hi(b, n.duration - minDur(base)); }
    else b = hi(b, nextStart - clipEnd(c));
  }
  const d = Math.max(a, Math.min(b, dt));
  return map(base, (c) => {
    if (ids.has(c.id)) return { ...c, start: c.start + d };
    if (prevs.has(c.id)) return { ...c, duration: c.duration + d };
    if (nexts.has(c.id)) return { ...c, start: c.start + d, in: c.in + d * (c.speed || 1), duration: c.duration - d, keyframes: shiftKf(c.keyframes, -d) };
    return c;
  });
}

/**
 * Moves (or with copy, duplicates) clips by dt and dRow tracks (within each clip's kind), overwriting what's underneath.
 * rowsKind = the kind whose clips change track ('video' | 'audio'); locked tracks are skipped.
 */
export function move(base, ids, dt, dRow = 0, rowsKind = null, { copy = false } = {}) {
  const moving = base.clips.filter((c) => ids.has(c.id));
  const d = Math.max(dt, -Math.min(...moving.map((c) => c.start)));
  const lists = { video: tracksOf(base, 'video'), audio: tracksOf(base, 'audio') };
  // Keep dRow within the tracks that exist.
  let r = dRow;
  if (rowsKind && r) {
    for (const c of moving) {
      const list = lists[trackById(base, c.track).kind];
      if (trackById(base, c.track).kind !== rowsKind) continue;
      const i = list.findIndex((t) => t.id === c.track);
      r = Math.max(-i, Math.min(list.length - 1 - i, r));
    }
  }
  const links = {};
  const moved = moving.map((c) => {
    const kind = trackById(base, c.track).kind;
    let track = c.track;
    if (kind === rowsKind && r) {
      const list = lists[kind];
      const t = list[list.findIndex((x) => x.id === c.track) + r];
      if (t && !t.lock) track = t.id;
    }
    const link = copy && c.link ? (links[c.link] ||= uid('l')) : c.link;
    return { ...c, id: copy ? uid('c') : c.id, link, start: c.start + d, track };
  });
  let clips = copy ? base.clips : base.clips.filter((c) => !ids.has(c.id));
  for (const c of moved) clips = clearRange(clips, c.track, c.start, clipEnd(c));
  return { doc: { ...base, clips: [...clips, ...moved] }, ids: new Set(moved.map((c) => c.id)), dt: d };
}
