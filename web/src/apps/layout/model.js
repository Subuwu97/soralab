// Layout's document model: pages, parent (master) pages, frames, stories, styles and swatches — plain JSON, measured in points.
//
//   doc = {
//     v, width, height, facing, margins: { top, bottom, inside, outside }, columns: { count, gutter }, bleed, startPage,
//     pages:   [{ id, master: 'A' | null, guides: [{ o: 'v' | 'h', p }] }],
//     masters: [{ id: 'A', name: 'Parent', guides: [] }],                   items on a parent have page = 'A' and side 'L' | 'R'
//     items:   [{ id, page, type: 'text' | 'image' | 'rect' | 'ellipse' | 'line', x, y, w, h, fill, stroke, sw, … }],
//     stories: { id: { text, runs: [{ n, cs, a }], paras: [{ ps, a }], frames: [itemId…] } },   see text.js
//     paraStyles: [{ id, name, basedOn, a }], charStyles: [{ id, name, a }], swatches: [{ id, name, hex }],
//   }
// Items are stored in stacking order (first = bottom). A page item with `masterRef` overrides that parent item on its page.

export const uid = (p = 'i') => `${p}${Math.random().toString(36).slice(2, 9)}`;
export const PAGE_NUM = '\uE000'; // marker character: the current page number
export const LINE_BREAK = '\u2028'; // forced line break (Shift+Enter)

export const CHAR_KEYS = ['font', 'weight', 'italic', 'size', 'leading', 'tracking', 'color', 'underline', 'strike', 'baseline', 'caps'];
export const PARA_KEYS = ['align', 'indentL', 'indentR', 'firstIndent', 'spaceBefore', 'spaceAfter', 'dropLines', 'dropChars'];
export const DEFAULT_CHAR = { font: 'Lora', weight: 400, italic: false, size: 11, leading: null, tracking: 0, color: 'black', underline: false, strike: false, baseline: 0, caps: false };
export const DEFAULT_PARA = { align: 'left', indentL: 0, indentR: 0, firstIndent: 0, spaceBefore: 0, spaceAfter: 0, dropLines: 0, dropChars: 1 };

export const DEFAULT_SWATCHES = [
  { id: 'paper', name: 'Paper', hex: '#ffffff' },
  { id: 'black', name: 'Black', hex: '#1a1a1a' },
  { id: 'sw-red', name: 'C=0 M=100 Y=100 K=0', hex: '#ed1c24' },
  { id: 'sw-blue', name: 'C=100 M=60 Y=0 K=0', hex: '#0067b1' },
  { id: 'sw-yellow', name: 'C=0 M=10 Y=100 K=0', hex: '#ffd200' },
  { id: 'sw-green', name: 'C=75 M=5 Y=100 K=0', hex: '#3aaa35' },
  { id: 'sw-grey', name: 'Black 20%', hex: '#d1d3d4' },
];

export const DEFAULT_PARA_STYLES = [
  { id: 'ps-basic', name: '[Basic Paragraph]', basedOn: null, a: { font: 'Lora', size: 11, leading: 15 } },
  { id: 'ps-body', name: 'Body', basedOn: 'ps-basic', a: { align: 'justify', firstIndent: 14 } },
  { id: 'ps-h1', name: 'Heading 1', basedOn: 'ps-basic', a: { font: 'Montserrat', weight: 700, size: 26, leading: 30, spaceAfter: 10 } },
  { id: 'ps-h2', name: 'Heading 2', basedOn: 'ps-h1', a: { size: 16, leading: 20, spaceBefore: 8, spaceAfter: 6 } },
  { id: 'ps-caption', name: 'Caption', basedOn: 'ps-basic', a: { font: 'Inter', size: 8, leading: 10, italic: false, color: 'black' } },
];
export const DEFAULT_CHAR_STYLES = [
  { id: 'cs-em', name: 'Emphasis', a: { italic: true } },
  { id: 'cs-strong', name: 'Strong', a: { weight: 700 } },
];

export const pick = (o, keys) => { const r = {}; if (o) for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };

// ---------------------------------------------------------------- new documents

/** A fresh document from the project's size and preset (meta.pages, meta.facing): one text frame inside the margins on page 1. */
export function newDocument(projectDoc = {}) {
  const meta = projectDoc.meta || {};
  const width = projectDoc.width || 612; const height = projectDoc.height || 792;
  const count = Math.max(1, Math.min(500, meta.pages || projectDoc.pages || 1));
  const facing = !!meta.facing;
  const margins = { top: 36, bottom: 36, inside: 36, outside: 36 };
  const doc = {
    v: 1, width, height, facing, margins, columns: { count: 1, gutter: 12 }, bleed: 9, startPage: 1,
    pages: Array.from({ length: count }, () => ({ id: uid('p'), master: 'A', guides: [] })),
    masters: [{ id: 'A', name: 'Parent', guides: [] }],
    items: [], stories: {},
    paraStyles: structuredClone(DEFAULT_PARA_STYLES), charStyles: structuredClone(DEFAULT_CHAR_STYLES), swatches: structuredClone(DEFAULT_SWATCHES),
  };
  const sid = uid('s');
  const fid = uid('f');
  doc.stories[sid] = { text: '', runs: [], paras: [{ ps: 'ps-basic', a: {} }], frames: [fid] };
  const m = pageMargins(doc, 0);
  doc.items.push({ id: fid, page: doc.pages[0].id, type: 'text', x: m.left, y: m.top, w: width - m.left - m.right, h: height - m.top - m.bottom, story: sid, cols: 1, gutter: 12, inset: 0, fill: null, stroke: null, sw: 1, wrap: { mode: 'none', off: 0 } });
  return doc;
}

/** Fills in anything an older or hand-made document is missing. */
export function normalizeDoc(d, projectDoc) {
  if (!d || !Array.isArray(d.pages) || !d.pages.length) return newDocument(projectDoc);
  const doc = { ...d };
  doc.margins ||= { top: 36, bottom: 36, inside: 36, outside: 36 };
  doc.columns ||= { count: 1, gutter: 12 };
  doc.bleed ??= 9; doc.startPage ||= 1;
  doc.masters ||= [];
  doc.items ||= []; doc.stories ||= {};
  doc.paraStyles ||= structuredClone(DEFAULT_PARA_STYLES);
  doc.charStyles ||= structuredClone(DEFAULT_CHAR_STYLES);
  doc.swatches ||= structuredClone(DEFAULT_SWATCHES);
  return doc;
}

// ---------------------------------------------------------------- pages and spreads

/** 'L' or 'R' — with facing pages, page 1 is a right-hand page. */
export const pageSide = (doc, i) => (doc.facing ? ((i + doc.startPage) % 2 === 0 ? 'L' : 'R') : 'R');
export const pageNumber = (doc, i) => i + (doc.startPage || 1);

/** Spreads: arrays of page indexes. Facing: [0], [1,2], [3,4]… (or starting left when startPage is even). */
export function spreads(doc) {
  if (!doc.facing) return doc.pages.map((_, i) => [i]);
  const out = [];
  let cur = [];
  doc.pages.forEach((_, i) => {
    if (pageSide(doc, i) === 'L' && cur.length) { out.push(cur); cur = []; }
    cur.push(i);
    if (pageSide(doc, i) === 'R') { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Margins of a page with inside/outside resolved to left/right. */
export function pageMargins(doc, i, side) {
  const s = side || pageSide(doc, i);
  const m = doc.margins;
  if (!doc.facing) return { top: m.top, bottom: m.bottom, left: m.inside, right: m.outside };
  return s === 'L' ? { top: m.top, bottom: m.bottom, left: m.outside, right: m.inside } : { top: m.top, bottom: m.bottom, left: m.inside, right: m.outside };
}

/** Column guides (x positions, page-relative) inside the margins. */
export function columnGuides(doc, margins) {
  const { count, gutter } = doc.columns;
  if (count <= 1) return [];
  const w = doc.width - margins.left - margins.right;
  const cw = (w - gutter * (count - 1)) / count;
  const xs = [];
  for (let c = 1; c < count; c++) { const x = margins.left + c * cw + (c - 1) * gutter; xs.push(x, x + gutter); }
  return xs;
}

/** Items that show on page i: the parent's items (unless overridden) then the page's own. */
export function itemsOnPage(doc, i) {
  const page = doc.pages[i];
  const own = doc.items.filter((it) => it.page === page.id);
  const overridden = new Set(own.map((it) => it.masterRef).filter(Boolean));
  const side = pageSide(doc, i);
  const master = page.master ? doc.items.filter((it) => it.page === page.master && (!doc.facing || (it.side || 'R') === side) && !overridden.has(it.id)) : [];
  return { master, own };
}

export const masterById = (doc, id) => doc.masters.find((m) => m.id === id);
export const masterLabel = (m) => `${m.id}-${m.name}`;

// ---------------------------------------------------------------- colours

/** A colour value is a swatch id or a hex string; null means none. */
export function colorOf(doc, v) {
  if (!v) return null;
  if (v[0] === '#') return v;
  const s = doc.swatches.find((x) => x.id === v);
  return s ? s.hex : null;
}

// ---------------------------------------------------------------- styles

const psCache = new WeakMap();
/** Paragraph style attributes with its "based on" chain merged in. */
export function paraStyleAttrs(doc, id) {
  let m = psCache.get(doc.paraStyles);
  if (!m) { m = new Map(); psCache.set(doc.paraStyles, m); }
  if (m.has(id)) return m.get(id);
  const chain = [];
  let s = doc.paraStyles.find((x) => x.id === id);
  const seen = new Set();
  while (s && !seen.has(s.id)) { seen.add(s.id); chain.unshift(s); s = s.basedOn ? doc.paraStyles.find((x) => x.id === s.basedOn) : null; }
  const out = Object.assign({}, ...chain.map((x) => x.a));
  m.set(id, out);
  return out;
}
export const charStyleAttrs = (doc, id) => (id ? doc.charStyles.find((x) => x.id === id)?.a || {} : {});

/** Resolved paragraph attributes. */
export const paraAttrs = (doc, para) => ({ ...DEFAULT_PARA, ...pick(paraStyleAttrs(doc, para.ps), PARA_KEYS), ...pick(para.a, PARA_KEYS) });
/** Resolved character attributes for a run inside a paragraph. */
export const charAttrs = (doc, para, run) => ({
  ...DEFAULT_CHAR, ...pick(paraStyleAttrs(doc, para.ps), CHAR_KEYS), ...pick(para.a, CHAR_KEYS), ...charStyleAttrs(doc, run?.cs), ...(run?.a || {}),
});

// ---------------------------------------------------------------- geometry helpers

export const bounds = (it) => (it.type === 'line'
  ? { x: Math.min(it.x, it.x + it.w), y: Math.min(it.y, it.y + it.h), w: Math.abs(it.w), h: Math.abs(it.h) }
  : { x: it.x, y: it.y, w: it.w, h: it.h });

export const findItem = (doc, id) => doc.items.find((it) => it.id === id);
export const pageIndexOf = (doc, pageId) => doc.pages.findIndex((p) => p.id === pageId);
