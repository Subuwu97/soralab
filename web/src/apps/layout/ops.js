// Pure document operations (each returns a new document) used by the editor, menus and panels.
import { uid, findItem, pageIndexOf, pageMargins } from './model.js';
import { emptyStory, insertFragment, sliceStory } from './text.js';

const withItems = (doc, items) => ({ ...doc, items });

export function updateItems(doc, ids, patch) {
  const set = new Set(ids);
  return withItems(doc, doc.items.map((it) => (set.has(it.id) ? { ...it, ...(typeof patch === 'function' ? patch(it) : patch) } : it)));
}

export function addItems(doc, items, stories = {}) {
  return { ...doc, items: [...doc.items, ...items], stories: { ...doc.stories, ...stories } };
}

/** Deletes items; text left in a story reflows into its remaining frames. */
export function deleteItems(doc, ids) {
  const set = new Set(ids);
  const stories = { ...doc.stories };
  for (const [sid, s] of Object.entries(stories)) {
    if (!s.frames.some((f) => set.has(f))) continue;
    const frames = s.frames.filter((f) => !set.has(f));
    if (frames.length) stories[sid] = { ...s, frames }; else delete stories[sid];
  }
  return { ...doc, items: doc.items.filter((it) => !set.has(it.id)), stories };
}

/** Stacking order: 'front' | 'back' | 'forward' | 'backward'. */
export function arrange(doc, ids, how) {
  const set = new Set(ids);
  let items = doc.items.slice();
  if (how === 'front') items = [...items.filter((x) => !set.has(x.id)), ...items.filter((x) => set.has(x.id))];
  else if (how === 'back') items = [...items.filter((x) => set.has(x.id)), ...items.filter((x) => !set.has(x.id))];
  else if (how === 'forward') { for (let i = items.length - 2; i >= 0; i--) if (set.has(items[i].id) && !set.has(items[i + 1].id)) [items[i], items[i + 1]] = [items[i + 1], items[i]]; }
  else if (how === 'backward') { for (let i = 1; i < items.length; i++) if (set.has(items[i].id) && !set.has(items[i - 1].id)) [items[i], items[i - 1]] = [items[i - 1], items[i]]; }
  return withItems(doc, items);
}

/**
 * Copies items (with their text). Frames threaded together inside the copy stay threaded; a frame copied
 * without the rest of its thread gets the whole story's text.
 * Returns { doc, ids } with the copies placed after the originals.
 */
export function cloneItems(doc, ids, { dx = 0, dy = 0, page, side, fromDoc } = {}) {
  const src = fromDoc || doc;
  const list = ids.map((id) => findItem(src, id)).filter(Boolean);
  const idMap = new Map(list.map((it) => [it.id, uid('f')]));
  const storyMap = new Map();
  const stories = {};
  const items = [];
  for (const it of list) {
    const copy = { ...structuredClone(it), id: idMap.get(it.id), x: it.x + dx, y: it.y + dy };
    delete copy.masterRef;
    if (page) copy.page = page;
    if (side) copy.side = side;
    if (it.type === 'text') {
      if (!storyMap.has(it.story)) {
        const s = src.stories[it.story];
        const nsid = uid('s');
        storyMap.set(it.story, nsid);
        stories[nsid] = { ...structuredClone(s), frames: s.frames.filter((f) => idMap.has(f)).map((f) => idMap.get(f)) };
      }
      copy.story = storyMap.get(it.story);
    }
    items.push(copy);
  }
  return { doc: addItems(doc, items, stories), ids: items.map((x) => x.id) };
}

// ---------------------------------------------------------------- threading

/** Links frame `toId` after `fromId`. If `toId` starts another story, that story's text is appended. */
export function threadFrames(doc, fromId, toId) {
  const A = findItem(doc, fromId); const B = findItem(doc, toId);
  if (!A || !B || A.type !== 'text' || B.type !== 'text' || A.story === B.story) return doc;
  const sA = doc.stories[A.story]; const sB = doc.stories[B.story];
  if (sB.frames[0] !== B.id) return doc; // B is in the middle of another thread
  let merged = sA;
  if (sB.text.length) {
    const end = merged.text.length;
    merged = insertFragment(merged, end, { text: `\n${sB.text}`, runs: [{ n: 1, cs: null, a: {} }, ...sB.runs], paras: [sA.paras[sA.paras.length - 1], ...sB.paras] });
    if (!sA.text.length) merged = { ...merged, text: merged.text.slice(1), runs: dropFirstChar(merged.runs), paras: merged.paras.slice(1) };
  }
  const at = sA.frames.indexOf(A.id);
  const frames = [...sA.frames.slice(0, at + 1), ...sB.frames, ...sA.frames.slice(at + 1)];
  const stories = { ...doc.stories, [A.story]: { ...merged, frames } };
  delete stories[B.story];
  const moved = new Set(sB.frames);
  return { ...doc, stories, items: doc.items.map((it) => (moved.has(it.id) ? { ...it, story: A.story } : it)) };
}
const dropFirstChar = (runs) => { const r = runs.slice(); if (r[0]) r[0] = { ...r[0], n: r[0].n - 1 }; return r.filter((x) => x.n > 0); };

/** Breaks the thread after a frame: following frames become an empty story (the text stays, overset). */
export function unthreadAfter(doc, fid) {
  const A = findItem(doc, fid);
  const s = A && doc.stories[A.story];
  if (!s) return doc;
  const at = s.frames.indexOf(fid);
  const rest = s.frames.slice(at + 1);
  if (!rest.length) return doc;
  const nsid = uid('s');
  const stories = { ...doc.stories, [A.story]: { ...s, frames: s.frames.slice(0, at + 1) }, [nsid]: emptyStory(s.paras[s.paras.length - 1].ps, rest) };
  const set = new Set(rest);
  return { ...doc, stories, items: doc.items.map((it) => (set.has(it.id) ? { ...it, story: nsid } : it)) };
}

// ---------------------------------------------------------------- parent pages

/** Copies a parent item onto page i so it can be edited there (Ctrl+Shift+click). */
export function overrideMasterItem(doc, i, masterItemId) {
  const m = findItem(doc, masterItemId);
  if (!m) return { doc, id: null };
  const page = doc.pages[i];
  const { doc: d2, ids } = cloneItems(doc, [masterItemId], { page: page.id });
  const id = ids[0];
  const out = { ...d2, items: d2.items.map((it) => (it.id === id ? { ...it, masterRef: masterItemId, side: undefined } : it)) };
  return { doc: out, id };
}

export function newMaster(doc, { name = 'Parent', basedOnId } = {}) {
  const used = new Set(doc.masters.map((m) => m.id));
  let letter = 'A';
  while (used.has(letter)) letter = String.fromCharCode(letter.charCodeAt(0) + 1);
  let d = { ...doc, masters: [...doc.masters, { id: letter, name, guides: [] }] };
  if (basedOnId) {
    const ids = doc.items.filter((it) => it.page === basedOnId).map((it) => it.id);
    d = cloneItems(d, ids, { page: letter }).doc;
  }
  return { doc: d, id: letter };
}

export function deleteMaster(doc, id) {
  const ids = doc.items.filter((it) => it.page === id).map((it) => it.id);
  const d = deleteItems(doc, ids);
  return { ...d, masters: d.masters.filter((m) => m.id !== id), pages: d.pages.map((p) => (p.master === id ? { ...p, master: null } : p)) };
}

export const applyMaster = (doc, idxs, master) => ({ ...doc, pages: doc.pages.map((p, i) => (idxs.includes(i) ? { ...p, master } : p)) });

// ---------------------------------------------------------------- pages

export function addPages(doc, at, count = 1, master) {
  const m = master === undefined ? (doc.pages[Math.max(0, at - 1)]?.master ?? doc.masters[0]?.id ?? null) : master;
  const pages = doc.pages.slice();
  pages.splice(at, 0, ...Array.from({ length: count }, () => ({ id: uid('p'), master: m, guides: [] })));
  return { ...doc, pages };
}

export function deletePages(doc, idxs) {
  if (idxs.length >= doc.pages.length) return doc;
  const ids = new Set(idxs.map((i) => doc.pages[i].id));
  const d = deleteItems(doc, doc.items.filter((it) => ids.has(it.page)).map((it) => it.id));
  return { ...d, pages: d.pages.filter((p) => !ids.has(p.id)) };
}

/** Moves pages (indexes) so they start at position `to` (in the list without them). */
export function movePages(doc, idxs, to) {
  const set = new Set(idxs);
  const moving = doc.pages.filter((_, i) => set.has(i));
  const rest = doc.pages.filter((_, i) => !set.has(i));
  rest.splice(Math.max(0, Math.min(rest.length, to)), 0, ...moving);
  return { ...doc, pages: rest };
}

export function duplicatePage(doc, i) {
  const page = doc.pages[i];
  const np = { ...structuredClone(page), id: uid('p') };
  const pages = doc.pages.slice(); pages.splice(i + 1, 0, np);
  const ids = doc.items.filter((it) => it.page === page.id).map((it) => it.id);
  return cloneItems({ ...doc, pages }, ids, { page: np.id }).doc;
}

/** Moves an item to another page, keeping its place on screen (dx/dy: the page offset difference). */
export const moveItemToPage = (it, pageId, dx, dy) => ({ ...it, page: pageId, x: it.x + dx, y: it.y + dy });

// ---------------------------------------------------------------- styles & swatches

export function replaceStyleRefs(doc, kind, fromId, toId) {
  const stories = {};
  for (const [sid, s] of Object.entries(doc.stories)) {
    stories[sid] = kind === 'para' ? { ...s, paras: s.paras.map((p) => (p.ps === fromId ? { ...p, ps: toId } : p)) }
      : { ...s, runs: s.runs.map((r) => (r.cs === fromId ? { ...r, cs: toId } : r)) };
  }
  return { ...doc, stories };
}

export function deleteSwatch(doc, id) {
  const hex = doc.swatches.find((s) => s.id === id)?.hex || null;
  const swap = (v) => (v === id ? hex : v);
  const fixA = (a) => (a && a.color === id ? { ...a, color: hex } : a);
  const stories = {};
  for (const [sid, s] of Object.entries(doc.stories)) stories[sid] = { ...s, runs: s.runs.map((r) => ({ ...r, a: fixA(r.a) })), paras: s.paras.map((p) => ({ ...p, a: fixA(p.a) })) };
  return {
    ...doc, stories, swatches: doc.swatches.filter((s) => s.id !== id),
    items: doc.items.map((it) => ({ ...it, fill: swap(it.fill), stroke: swap(it.stroke) })),
    paraStyles: doc.paraStyles.map((s) => ({ ...s, a: fixA(s.a) })), charStyles: doc.charStyles.map((s) => ({ ...s, a: fixA(s.a) })),
  };
}

/** A new text frame filling the margins of page i (used by the loaded-text cursor and "add pages to fit"). */
export function marginFrame(doc, i, extra = {}) {
  const m = pageMargins(doc, i);
  return { id: uid('f'), page: doc.pages[i].id, type: 'text', x: m.left, y: m.top, w: doc.width - m.left - m.right, h: doc.height - m.top - m.bottom, cols: doc.columns.count, gutter: doc.columns.gutter, inset: 0, fill: null, stroke: null, sw: 1, wrap: { mode: 'none', off: 0 }, ...extra };
}

/** Adds pages with threaded frames until the story's text fits (smart text reflow, done on request). */
export function autoflow(doc, sid, isOverset, maxPages = 100) {
  let d = doc;
  for (let k = 0; k < maxPages; k++) {
    if (!isOverset(d)) break;
    const s = d.stories[sid];
    const last = findItem(d, s.frames[s.frames.length - 1]);
    const li = pageIndexOf(d, last.page);
    if (li < 0) break;
    const target = li + 1;
    d = addPages(d, target, 1);
    const f = marginFrame(d, target, { story: sid });
    d = { ...d, items: [...d.items, f], stories: { ...d.stories, [sid]: { ...d.stories[sid], frames: [...d.stories[sid].frames, f.id] } } };
  }
  return d;
}

export { sliceStory };
