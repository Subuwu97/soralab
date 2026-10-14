// Laying out every story in the document and drawing pages: used by the workspace, thumbnails, PNG/JPEG export and print.
import { itemsOnPage, pageNumber, pageSide, colorOf, bounds, pageIndexOf } from './model.js';
import { layoutStory, drawLines, measureGeneration } from './text.js';
import { assetSrc } from '../../lib/doc.js';

// ---------------------------------------------------------------- images

const images = new Map(); // asset id → { img, status: 'loading' | 'ok' | 'error' }
const listeners = new Set();
export const onImagesChanged = (f) => { listeners.add(f); return () => listeners.delete(f); };
/** The loaded image for an asset (or null while it loads; listeners hear when it arrives). */
export function getImage(id) {
  if (!id) return null;
  let e = images.get(id);
  if (!e) {
    e = { img: new Image(), status: 'loading' };
    images.set(id, e);
    e.img.crossOrigin = 'anonymous';
    e.img.onload = () => { e.status = 'ok'; listeners.forEach((f) => f()); };
    e.img.onerror = () => { e.status = 'error'; listeners.forEach((f) => f()); };
    e.img.src = assetSrc(id);
  }
  return e.status === 'ok' ? e.img : null;
}
export const imageStatus = (id) => images.get(id)?.status || 'loading';
/** Waits until every image used in the document has loaded (or failed) — before exporting. */
export async function loadAllImages(doc) {
  const ids = [...new Set(doc.items.filter((it) => it.type === 'image' && it.asset).map((it) => it.asset))];
  ids.forEach(getImage);
  await Promise.all(ids.map((id) => new Promise((r) => {
    const e = images.get(id);
    if (e.status !== 'loading') return r();
    const t = setInterval(() => { if (e.status !== 'loading') { clearInterval(t); r(); } }, 50);
  })));
}

// ---------------------------------------------------------------- layout of all stories

const cache = new WeakMap(); // story → Map(key → result)

/** Frames (frame-relative) for the line breaker, with text-wrap exclusions from other items on the same page. */
function frameSpec(doc, it, shown, pageNo) {
  const excl = [];
  for (const o of shown) {
    if (o.id === it.id || o.id === it.masterRef || !o.wrap || o.wrap.mode === 'none' || o.hidden) continue;
    const b = bounds(o); const off = o.wrap.off || 0;
    excl.push({ x: b.x - off - it.x, y: b.y - off - it.y, w: b.w + off * 2, h: b.h + off * 2, jump: o.wrap.mode === 'jump' });
  }
  return { id: it.id, w: it.w, h: it.h, cols: it.cols || 1, gutter: it.gutter ?? 12, inset: it.inset || 0, pageNo, excl };
}

function runLayout(doc, story, specs) {
  let m = cache.get(story);
  if (!m) { m = new Map(); cache.set(story, m); }
  const key = JSON.stringify([specs, doc.paraStyles, doc.charStyles, doc.swatches.length, measureGeneration()]);
  let r = m.get(key);
  if (!r) {
    r = layoutStory(doc, story, specs);
    if (m.size > 40) m.clear();
    m.set(key, r);
  }
  return r;
}

/**
 * Lays out every story. Returns
 *   { lines(itemId, where) → lines, overset: { storyId: bool }, frameOverset(itemId) }
 * where = page index for items shown on pages, or 'm' when editing a parent page.
 */
export function layoutDoc(doc, { masterView } = {}) {
  const byKey = new Map();
  const overset = {};
  const shownCache = new Map();
  const shownOn = (i) => { if (!shownCache.has(i)) { const { master, own } = itemsOnPage(doc, i); shownCache.set(i, [...master, ...own]); } return shownCache.get(i); };
  const masterIds = new Set(doc.masters.map((m) => m.id));
  for (const [sid, story] of Object.entries(doc.stories)) {
    const frames = story.frames.map((id) => doc.items.find((x) => x.id === id)).filter(Boolean);
    if (!frames.length) continue;
    if (masterIds.has(frames[0].page)) {
      // a parent-page story: laid out once per page that shows it (page numbers differ), and once for the parent itself
      const mid = frames[0].page;
      const sideItems = (side) => doc.items.filter((x) => x.page === mid && (!doc.facing || (x.side || 'R') === side));
      for (const side of doc.facing ? ['L', 'R'] : ['R']) {
        const fs = frames.filter((f) => !doc.facing || (f.side || 'R') === side);
        if (!fs.length) continue;
        const r = runLayout(doc, story, fs.map((f) => frameSpec(doc, f, sideItems(side), mid)));
        for (const f of fs) byKey.set(`${f.id}@m`, r.frames[f.id]?.lines || []);
        overset[sid] ||= r.overset;
      }
      if (masterView) continue;
      doc.pages.forEach((p, i) => {
        if (p.master !== mid) return;
        const shown = shownOn(i);
        const fs = frames.filter((f) => shown.includes(f));
        if (!fs.length) return;
        const r = runLayout(doc, story, fs.map((f) => frameSpec(doc, f, shown, pageNumber(doc, i))));
        for (const f of fs) byKey.set(`${f.id}@${i}`, r.frames[f.id]?.lines || []);
      });
      continue;
    }
    const specs = frames.map((f) => { const i = pageIndexOf(doc, f.page); return frameSpec(doc, f, i >= 0 ? shownOn(i) : [], i >= 0 ? pageNumber(doc, i) : '#'); });
    const r = runLayout(doc, story, specs);
    for (const f of frames) byKey.set(`${f.id}@${pageIndexOf(doc, f.page)}`, r.frames[f.id]?.lines || []);
    overset[sid] = r.overset;
  }
  return {
    lines: (id, where) => byKey.get(`${id}@${where}`) || [],
    overset,
    storyOf: (it) => doc.stories[it.story],
  };
}

// ---------------------------------------------------------------- drawing items

function shapePath(ctx, it) {
  ctx.beginPath();
  if (it.type === 'ellipse' || it.shape === 'ellipse') ctx.ellipse(it.x + it.w / 2, it.y + it.h / 2, Math.abs(it.w / 2), Math.abs(it.h / 2), 0, 0, Math.PI * 2);
  else if (it.type === 'line') { ctx.moveTo(it.x, it.y); ctx.lineTo(it.x + it.w, it.y + it.h); }
  else if (it.radius) ctx.roundRect(it.x, it.y, it.w, it.h, Math.min(it.radius, Math.abs(it.w) / 2, Math.abs(it.h) / 2));
  else ctx.rect(it.x, it.y, it.w, it.h);
}

/**
 * Draws one item in page coordinates.
 * opts: { lines, sel: [a,b] text selection to highlight, placeholder: draw empty-frame X, missing: mark missing images }
 */
export function drawItem(ctx, doc, it, opts = {}) {
  if (it.hidden) return;
  ctx.save();
  if (it.opacity !== undefined && it.opacity < 1) ctx.globalAlpha = it.opacity;
  const fill = colorOf(doc, it.fill); const stroke = colorOf(doc, it.stroke);
  if (fill && it.type !== 'line') { shapePath(ctx, it); ctx.fillStyle = fill; ctx.fill(); }
  if (it.type === 'image') {
    const img = getImage(it.asset);
    if (img) {
      ctx.save(); shapePath(ctx, it); ctx.clip();
      ctx.drawImage(img, it.x + (it.cx || 0), it.y + (it.cy || 0), (it.iw || img.naturalWidth) * (it.cs || 1), (it.ih || img.naturalHeight) * (it.csy || it.cs || 1));
      ctx.restore();
    } else if (opts.placeholder) {
      ctx.strokeStyle = it.asset && imageStatus(it.asset) === 'error' ? '#e0303a' : 'rgba(120,120,140,.7)';
      ctx.lineWidth = 0.5 / (opts.zoom || 1);
      ctx.beginPath(); ctx.moveTo(it.x, it.y); ctx.lineTo(it.x + it.w, it.y + it.h); ctx.moveTo(it.x + it.w, it.y); ctx.lineTo(it.x, it.y + it.h); ctx.stroke();
    }
  }
  if (it.type === 'text' && opts.lines) {
    ctx.save();
    ctx.beginPath(); ctx.rect(it.x - 2000, it.y - 50, it.w + 4000, it.h + 100); // generous clip: drop caps and overhangs may poke out
    ctx.clip();
    ctx.translate(it.x, it.y);
    drawLines(ctx, doc, opts.lines, opts.sel);
    ctx.restore();
  }
  if (stroke && (it.sw ?? 1) > 0) {
    shapePath(ctx, it); ctx.strokeStyle = stroke; ctx.lineWidth = it.sw ?? 1;
    if (it.dash) ctx.setLineDash([it.sw * 3, it.sw * 2]);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draws a whole page (paper + parent items + page items) with its top-left at 0,0 in points. */
export function drawPage(ctx, doc, i, layout, opts = {}) {
  const { master, own } = itemsOnPage(doc, i);
  if (opts.paper !== false) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, doc.width, doc.height); }
  for (const it of [...master, ...own]) drawItem(ctx, doc, it, { ...opts, lines: it.type === 'text' ? layout.lines(it.id, i) : null, sel: opts.selFor?.(it) });
}

/** Renders page i to a new canvas at `scale` px per point (bleed: extra points around the trim). */
export function renderPageCanvas(doc, i, layout, { scale = 1, bleed = 0, background = '#ffffff' } = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((doc.width + bleed * 2) * scale));
  c.height = Math.max(1, Math.round((doc.height + bleed * 2) * scale));
  const ctx = c.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.setTransform(scale, 0, 0, scale, bleed * scale, bleed * scale);
  drawPage(ctx, doc, i, layout, { paper: !!background });
  return c;
}

export { pageSide };
