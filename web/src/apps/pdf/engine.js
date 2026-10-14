// The PDF engine: loading documents with pdf.js, the page list (order/rotation/inserted/blank pages), coordinates,
// and building the output with pdf-lib — the source asset is never changed; every edit is applied on export.
//
// Coordinates: every annotation is stored in "base" page space = pdf.js viewport at scale 1 with the page's own
// /Rotate applied, origin top-left, in points. The user's extra rotation (entry.rot) is applied only on screen/export.
// The legacy build carries polyfills (e.g. Map.getOrInsertComputed) that current browsers may not have yet.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFPage, StandardFonts, degrees, rgb, PDFName, PDFString, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, drawObject, pushGraphicsState, popGraphicsState } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { zipSync } from 'fflate';
import { parse } from '../../lib/color.js';
import { fontData } from '../../lib/fonts.js';
import { canvasBlob } from '../../lib/doc.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
export { pdfjs };

// ---------------------------------------------------------------- loading

const cache = new Map(); // asset id → Promise<{ pdf, bytes, pages: [{ w, h, rotate, vt }] }>
/** Loads a PDF asset once: the pdf.js document, a copy of its bytes (for pdf-lib), and each page's base size. */
export function loadAsset(id) {
  if (!cache.has(id)) {
    cache.set(id, (async () => {
      const r = await fetch(`/api/assets/${id}/file`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('Couldn’t open the PDF file.');
      const bytes = new Uint8Array(await r.arrayBuffer());
      return openBytes(bytes);
    })());
    cache.get(id).catch(() => cache.delete(id));
  }
  return cache.get(id);
}
export async function openBytes(bytes) {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    pages.push({ w: vp.width, h: vp.height, rotate: p.rotate, vt: vp.transform });
  }
  return { pdf, bytes, pages };
}

/** The page list: saved order, or every page of the source / the blank pages. */
export function pageList(data, docs) {
  if (Array.isArray(data.pages)) return data.pages;
  if (data.source) return (docs.source?.pages || []).map((_, i) => ({ id: `s${i}`, src: 'source', i, rot: 0 }));
  const b = data.blank || { width: 612, height: 792, count: 1 };
  return Array.from({ length: b.count || 1 }, (_, i) => ({ id: `b${i}`, src: 'blank', i, rot: 0, w: b.width, h: b.height }));
}

/** Base size and transform of a page entry. */
export function entryInfo(e, docs) {
  if (e.src === 'blank') return { w: e.w || 612, h: e.h || 792, rotate: 0, vt: [1, 0, 0, -1, 0, e.h || 792], doc: null };
  const d = docs[e.src];
  const p = d?.pages[e.i];
  if (!p) return { w: 612, h: 792, rotate: 0, vt: [1, 0, 0, -1, 0, 792], doc: null, missing: true };
  return { ...p, doc: d };
}

// ---------------------------------------------------------------- coordinates

/** Base page coords → displayed (rotated by r, scaled by z). Returns a CSS/SVG matrix [a,b,c,d,e,f]. */
export function viewMatrix(w, h, r, z = 1) {
  const m = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, h, 0], 180: [-1, 0, 0, -1, w, h], 270: [0, -1, 1, 0, 0, w] }[((r % 360) + 360) % 360];
  return m.map((v) => v * z);
}
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
export const displaySize = (w, h, r) => (r % 180 ? [h, w] : [w, h]);

// ---------------------------------------------------------------- text, search, outline

const textCache = new WeakMap();
/** Text items of a page with base-space boxes: [{ str, x, y, w, h }] and the joined page string with item offsets. */
export async function pageText(doc, i) {
  let m = textCache.get(doc.pdf);
  if (!m) { m = new Map(); textCache.set(doc.pdf, m); }
  if (!m.has(i)) {
    m.set(i, (async () => {
      const page = await doc.pdf.getPage(i + 1);
      const tc = await page.getTextContent();
      const vt = doc.pages[i].vt;
      const items = []; let text = '';
      for (const it of tc.items) {
        if (!('str' in it)) continue;
        const tr = pdfjs.Util.transform(vt, it.transform);
        const fh = Math.hypot(tr[2], tr[3]) || Math.hypot(it.transform[2], it.transform[3]);
        const w = it.width * Math.hypot(vt[0], vt[1]);
        items.push({ str: it.str, x: tr[4], y: tr[5] - fh, w, h: fh * 1.15, start: text.length });
        text += it.str + (it.hasEOL ? '\n' : '');
      }
      return { items, text };
    })());
  }
  return m.get(i);
}

/** Finds a query in a page: [{ rects: [[x,y,w,h]…], text }] in base coordinates. */
export function findInPage(pt, q, { matchCase } = {}) {
  if (!q) return [];
  const hay = matchCase ? pt.text : pt.text.toLowerCase();
  const needle = matchCase ? q : q.toLowerCase();
  const out = [];
  let k = hay.indexOf(needle);
  while (k >= 0) {
    const end = k + needle.length;
    const rects = [];
    for (const it of pt.items) {
      const s = it.start; const e = s + it.str.length;
      if (e <= k || s >= end || !it.str.length) continue;
      const a = Math.max(k, s) - s; const b = Math.min(end, e) - s;
      rects.push([it.x + it.w * (a / it.str.length), it.y, it.w * ((b - a) / it.str.length), it.h]);
    }
    out.push({ rects, text: pt.text.slice(Math.max(0, k - 30), end + 30).replace(/\n/g, ' ') });
    k = hay.indexOf(needle, end);
  }
  return out;
}

/** The outline (bookmarks) with each entry's page index in the source. */
export async function outline(doc) {
  const raw = await doc.pdf.getOutline().catch(() => null);
  if (!raw) return [];
  const walk = async (items) => Promise.all(items.map(async (it) => {
    let page = null;
    try {
      const dest = typeof it.dest === 'string' ? await doc.pdf.getDestination(it.dest) : it.dest;
      if (dest?.[0]) page = typeof dest[0] === 'number' ? dest[0] : await doc.pdf.getPageIndex(dest[0]);
    } catch { /* external or broken link */ }
    return { title: it.title, page, items: it.items?.length ? await walk(it.items) : [] };
  }));
  return walk(raw);
}

/** Form fields of the source, from pdf.js (positions) — [{ name, type, rect (base), options, value, radioValue, multiline }] per page. */
export async function formFields(doc) {
  const out = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const page = await doc.pdf.getPage(i + 1);
    const anns = await page.getAnnotations({ intent: 'display' }).catch(() => []);
    const vp = page.getViewport({ scale: 1 });
    const list = [];
    for (const a of anns) {
      if (a.subtype !== 'Widget' || !a.fieldName || a.hidden) continue;
      const vt = vp.transform;
      const [x1, y1] = apply(vt, a.rect[0], a.rect[1]); const [x2, y2] = apply(vt, a.rect[2], a.rect[3]);
      const rect = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
      let type = null;
      if (a.fieldType === 'Tx') type = 'text';
      else if (a.fieldType === 'Btn' && a.checkBox) type = 'checkbox';
      else if (a.fieldType === 'Btn' && a.radioButton) type = 'radio';
      else if (a.fieldType === 'Ch') type = 'choice';
      if (!type) continue;
      list.push({ id: a.id, name: a.fieldName, type, rect, value: a.fieldValue, radioValue: a.buttonValue, exportValue: a.exportValue, options: (a.options || []).map((o) => ({ value: o.exportValue, label: o.displayValue })), multiline: !!a.multiLine, readOnly: !!a.readOnly, maxLen: a.maxLen || undefined });
    }
    out.push(list);
  }
  return out;
}

// ---------------------------------------------------------------- rendering pages with pdf.js

/** Renders a page entry into a canvas at scale (px per point), including the user rotation. */
export async function renderEntry(e, docs, scale, { canvas, annotations = true, signal } = {}) {
  const info = entryInfo(e, docs);
  const c = canvas || document.createElement('canvas');
  const rot = ((e.rot || 0) % 360 + 360) % 360;
  if (!info.doc) {
    const [w, h] = displaySize(info.w, info.h, rot);
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }
  const page = await info.doc.pdf.getPage(e.i + 1);
  const vp = page.getViewport({ scale, rotation: (page.rotate + rot) % 360 });
  c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
  const task = page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp, annotationMode: annotations === 'forms' ? pdfjs.AnnotationMode.ENABLE_FORMS : annotations ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE });
  signal?.addEventListener('abort', () => task.cancel());
  await task.promise;
  return c;
}

// ---------------------------------------------------------------- export helpers

const rgbOf = (hex) => { const c = parse(hex || '#000000'); return [c.r / 255, c.g / 255, c.b / 255]; };
const n = (v) => (Math.round(v * 1000) / 1000).toString();
const winAnsi = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\xa0-\xff\n]/g, '?');
const pdfStr = (s) => `(${winAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;

export const STAMPS = {
  approved: { label: 'APPROVED', color: '#1f9d55' }, draft: { label: 'DRAFT', color: '#3b6fd6' }, confidential: { label: 'CONFIDENTIAL', color: '#d62f3a' },
  final: { label: 'FINAL', color: '#1f9d55' }, notapproved: { label: 'NOT APPROVED', color: '#d62f3a' }, forcomment: { label: 'FOR COMMENT', color: '#3b6fd6' },
  received: { label: 'RECEIVED', color: '#7a4fd6' }, void: { label: 'VOID', color: '#d62f3a' },
};

/** Approximate Helvetica width (for wrapping free text in appearance streams). */
const helvW = (s, size) => [...s].reduce((w, ch) => w + (/[il.,:;'|!]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.83 : /[A-Z]/.test(ch) ? 0.67 : ch === ' ' ? 0.28 : 0.55), 0) * size;
function wrapLines(text, size, width) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const t = line ? `${line} ${word}` : word;
      if (helvW(t, size) > width && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}

/**
 * Builds the output PDF from the project data.
 *   docs: { source: loaded, [insertedId]: loaded }
 *   opts: { flattenForm, flattenAnnots, comments (include markup), pick: [entry indexes], rasterize: entry ids to turn into images, onProgress }
 */
export async function buildPdf(data, docs, opts = {}) {
  const { flattenForm = false, flattenAnnots = false, comments = true, onProgress } = opts;
  const out = data.source ? await PDFDocument.load(docs.source.bytes, { ignoreEncryption: true, updateMetadata: false }) : await PDFDocument.create();
  out.registerFontkit(fontkit);
  out.setProducer('SoraLab PDF (pdf-lib)');
  // 1. forms
  if (data.source) {
    let form = null;
    try { form = out.getForm(); } catch { /* no form */ }
    if (form) {
      for (const [name, v] of Object.entries(data.form || {})) {
        try {
          const f = form.getField(name);
          if (f instanceof PDFTextField) f.setText(v ? String(v) : '');
          else if (f instanceof PDFCheckBox) { if (v) f.check(); else f.uncheck(); }
          else if (f instanceof PDFRadioGroup) { if (v) f.select(String(v)); else f.clear(); }
          else if (f instanceof PDFDropdown) { if (v) f.select(String(v)); else f.clear(); }
          else if (f instanceof PDFOptionList) { if (v) f.select(String(v)); }
        } catch { /* field missing or value not allowed */ }
      }
      try {
        if (Object.keys(data.form || {}).length) form.updateFieldAppearances(await out.embedFont(StandardFonts.Helvetica));
        if (flattenForm) form.flatten();
      } catch (e) { console.warn('form', e); }
    }
  }
  // 2. pages in the new order
  const list = pageList(data, docs);
  const chosen = opts.pick ? opts.pick.map((k) => list[k]).filter(Boolean) : list;
  const orig = out.getPages();
  const used = new Set();
  const ins = {};
  const placed = [];
  for (const e of chosen) {
    let page;
    if (e.src === 'source') {
      if (!orig[e.i]) continue;
      if (used.has(e.i)) [page] = await out.copyPages(out, [e.i]);
      else { page = orig[e.i]; used.add(e.i); }
    } else if (e.src === 'blank') {
      page = PDFPage.create(out); page.setSize(e.w || 612, e.h || 792);
    } else {
      const d = docs[e.src];
      if (!d) continue;
      ins[e.src] ||= await PDFDocument.load(d.bytes, { ignoreEncryption: true });
      [page] = await out.copyPages(ins[e.src], [e.i]);
    }
    placed.push({ e, page });
  }
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  for (const { e, page } of placed) {
    out.addPage(page);
    const info = entryInfo(e, docs);
    if (e.rot) page.setRotation(degrees(((info.rotate || 0) + e.rot) % 360));
  }
  // 3. annotations, signatures, redactions
  const helv = out.context.register(out.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  let textFont = null;
  const fontFor = async () => {
    if (!textFont) { const buf = await fontData('Inter', 400).catch(() => null); textFont = buf ? await out.embedFont(buf, { subset: true }) : await out.embedFont(StandardFonts.Helvetica); }
    return textFont;
  };
  const imgCache = new Map();
  const imageFor = async (asset) => {
    if (!imgCache.has(asset)) imgCache.set(asset, (async () => {
      const r = await fetch(`/api/assets/${asset}/file`, { credentials: 'same-origin' });
      const b = new Uint8Array(await r.arrayBuffer());
      if (b[0] === 0xff && b[1] === 0xd8) return out.embedJpg(b);
      if (b[0] === 0x89) return out.embedPng(b);
      const img = await createImageBitmap(new Blob([b]));
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0);
      return out.embedPng(new Uint8Array(await (await canvasBlob(c)).arrayBuffer()));
    })());
    return imgCache.get(asset);
  };
  const byPage = new Map();
  for (const a of data.annotations || []) { if (!byPage.has(a.page)) byPage.set(a.page, []); byPage.get(a.page).push(a); }
  let k = 0;
  for (const { e, page } of placed) {
    const info = entryInfo(e, docs);
    const inv = invert(info.vt);
    const P = (x, y) => apply(inv, x, y);
    const rectPdf = (x, y, w, h) => { const [ax, ay] = P(x, y); const [bx, by] = P(x + w, y + h); return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]; };
    for (const a of byPage.get(e.id) || []) {
      if (a.type === 'redact') {
        if (!a.applied) continue;
        const [x1, y1, x2, y2] = rectPdf(a.x, a.y, a.w, a.h);
        page.drawRectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1, color: rgb(0, 0, 0) });
        continue;
      }
      if (a.type === 'image') {
        const img = await imageFor(a.asset).catch(() => null);
        if (!img) continue;
        const [x1, y1, x2, y2] = rectPdf(a.x, a.y, a.w, a.h);
        page.drawImage(img, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
        continue;
      }
      if (a.type === 'text') {
        const font = await fontFor();
        const size = a.size || 12;
        const lines = String(a.text || '').split('\n');
        lines.forEach((line, li) => {
          const [x, y] = P(a.x, a.y + size * 0.85 + li * size * 1.2);
          let t = line;
          if (font.name === 'Helvetica') t = winAnsi(t);
          if (t) page.drawText(t, { x, y, size, font, color: rgb(...rgbOf(a.color || '#000000')) });
        });
        continue;
      }
      if (!comments) continue;
      const made = annotationDict(out, a, rectPdf, P, helv);
      if (!made) continue;
      if (flattenAnnots && made.ap) {
        const name = page.node.newXObject('SlAnnot', made.ap);
        page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState());
      } else {
        page.node.addAnnot(out.context.register(made.dict));
      }
    }
    k++;
    onProgress?.(k / placed.length * 0.9, `Page ${k} of ${placed.length}`);
  }
  let bytes = await out.save();
  // 4. pages flattened to images (true redaction / compression)
  const raster = new Set(opts.rasterize || []);
  if (raster.size) {
    const idx = placed.map((p, i) => (raster.has(p.e.id) ? i : -1)).filter((i) => i >= 0);
    if (idx.length) bytes = await rasterizePages(bytes, idx, { dpi: opts.dpi || 150, quality: opts.quality ?? 0.85 });
  }
  onProgress?.(1);
  return bytes;
}

/** A real PDF annotation for a markup item, with an appearance stream so every viewer shows it the same. */
function annotationDict(out, a, rectPdf, P, helv) {
  const ctx = out.context;
  const color = rgbOf(a.color || '#ffd400');
  const opacity = a.opacity ?? (a.type === 'highlight' ? 0.4 : 1);
  const width = a.width || 2;
  let rect; let content = ''; let extra = {};
  const res = { ExtGState: { GS0: { Type: 'ExtGState', CA: opacity, ca: opacity, ...(a.type === 'highlight' ? { BM: 'Multiply' } : {}) } }, Font: { Helv: helv } };
  const sc = `${n(color[0])} ${n(color[1])} ${n(color[2])} RG`; const fc = `${n(color[0])} ${n(color[1])} ${n(color[2])} rg`;
  if (['highlight', 'underline', 'strike'].includes(a.type)) {
    const quads = []; const boxes = [];
    for (const [x, y, w, h] of a.rects || []) {
      const [x1, y1] = P(x, y); const [x2, y2] = P(x + w, y); const [x3, y3] = P(x, y + h); const [x4, y4] = P(x + w, y + h);
      quads.push(x1, y1, x2, y2, x3, y3, x4, y4);
      boxes.push(rectPdf(x, y, w, h));
    }
    if (!boxes.length) return null;
    rect = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
    for (const [x1, y1, x2, y2] of boxes) {
      const h = y2 - y1;
      if (a.type === 'highlight') content += `${fc} ${n(x1)} ${n(y1)} ${n(x2 - x1)} ${n(h)} re f\n`;
      else if (a.type === 'underline') content += `${sc} ${n(Math.max(0.6, h / 14))} w ${n(x1)} ${n(y1 + h * 0.08)} m ${n(x2)} ${n(y1 + h * 0.08)} l S\n`;
      else content += `${sc} ${n(Math.max(0.6, h / 14))} w ${n(x1)} ${n(y1 + h * 0.45)} m ${n(x2)} ${n(y1 + h * 0.45)} l S\n`;
    }
    extra = { Subtype: { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' }[a.type], QuadPoints: quads };
  } else if (a.type === 'note') {
    rect = rectPdf(a.x, a.y, 20, 20);
    const [x1, y1, x2, y2] = rect;
    content = `${fc} 0 0 0 RG 0.6 w ${n(x1 + 1)} ${n(y1 + 4)} ${n(x2 - x1 - 2)} ${n(y2 - y1 - 5)} re B ${n(x1 + 5)} ${n(y1 + 4)} m ${n(x1 + 4)} ${n(y1)} l ${n(x1 + 9)} ${n(y1 + 4)} l f 0 0 0 rg ${n(x1 + 4)} ${n(y2 - 6)} m ${n(x2 - 4)} ${n(y2 - 6)} l S ${n(x1 + 4)} ${n(y2 - 10)} m ${n(x2 - 4)} ${n(y2 - 10)} l S ${n(x1 + 4)} ${n(y2 - 14)} m ${n(x2 - 8)} ${n(y2 - 14)} l S\n`;
    extra = { Subtype: 'Text', Name: 'Comment', Open: false };
  } else if (a.type === 'freetext') {
    rect = rectPdf(a.x, a.y, a.w, a.h);
    const size = a.size || 12; const [x1, , x2, y2] = rect;
    const tc = rgbOf(a.textColor || a.color || '#000000');
    const lines = wrapLines(a.text, size, x2 - x1 - 6);
    if (a.fill) { const f = rgbOf(a.fill); content += `${n(f[0])} ${n(f[1])} ${n(f[2])} rg ${n(x1)} ${n(rect[1])} ${n(x2 - x1)} ${n(y2 - rect[1])} re f\n`; }
    if (a.border) content += `${sc} 1 w ${n(x1 + 0.5)} ${n(rect[1] + 0.5)} ${n(x2 - x1 - 1)} ${n(y2 - rect[1] - 1)} re S\n`;
    content += `BT /Helv ${n(size)} Tf ${n(tc[0])} ${n(tc[1])} ${n(tc[2])} rg ${n(size * 1.2)} TL ${n(x1 + 3)} ${n(y2 - 3 - size * 0.9)} Td ${lines.map((l) => `${pdfStr(l)} Tj T*`).join(' ')} ET\n`;
    extra = { Subtype: 'FreeText', DA: PDFString.of(`/Helv ${size} Tf ${n(tc[0])} ${n(tc[1])} ${n(tc[2])} rg`) };
  } else if (a.type === 'rect' || a.type === 'ellipse') {
    rect = rectPdf(a.x, a.y, a.w, a.h);
    const [x1, y1, x2, y2] = rect; const hw = width / 2;
    const fill = a.fill ? rgbOf(a.fill) : null;
    const op = fill ? 'B' : 'S';
    const fillOp = fill ? `${n(fill[0])} ${n(fill[1])} ${n(fill[2])} rg ` : '';
    if (a.type === 'rect') content = `${sc} ${fillOp}${n(width)} w ${n(x1 + hw)} ${n(y1 + hw)} ${n(x2 - x1 - width)} ${n(y2 - y1 - width)} re ${op}\n`;
    else {
      const cx = (x1 + x2) / 2; const cy = (y1 + y2) / 2; const rx = (x2 - x1) / 2 - hw; const ry = (y2 - y1) / 2 - hw; const kk = 0.5523;
      content = `${sc} ${fillOp}${n(width)} w ${n(cx - rx)} ${n(cy)} m ${n(cx - rx)} ${n(cy + ry * kk)} ${n(cx - rx * kk)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c ${n(cx + rx * kk)} ${n(cy + ry)} ${n(cx + rx)} ${n(cy + ry * kk)} ${n(cx + rx)} ${n(cy)} c ${n(cx + rx)} ${n(cy - ry * kk)} ${n(cx + rx * kk)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c ${n(cx - rx * kk)} ${n(cy - ry)} ${n(cx - rx)} ${n(cy - ry * kk)} ${n(cx - rx)} ${n(cy)} c ${op}\n`;
    }
    extra = { Subtype: a.type === 'rect' ? 'Square' : 'Circle', BS: { W: width }, ...(fill ? { IC: fill } : {}) };
  } else if (a.type === 'line' || a.type === 'arrow') {
    const [x1, y1] = P(a.x1, a.y1); const [x2, y2] = P(a.x2, a.y2);
    const pad = width * 4 + 4;
    rect = [Math.min(x1, x2) - pad, Math.min(y1, y2) - pad, Math.max(x1, x2) + pad, Math.max(y1, y2) + pad];
    content = `${sc} ${fc} ${n(width)} w 1 J ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S\n`;
    if (a.type === 'arrow') {
      const ang = Math.atan2(y2 - y1, x2 - x1); const L = Math.max(8, width * 4);
      const p1 = [x2 - L * Math.cos(ang - 0.45), y2 - L * Math.sin(ang - 0.45)]; const p2 = [x2 - L * Math.cos(ang + 0.45), y2 - L * Math.sin(ang + 0.45)];
      content += `${n(p1[0])} ${n(p1[1])} m ${n(x2)} ${n(y2)} l ${n(p2[0])} ${n(p2[1])} l h f\n`;
    }
    extra = { Subtype: 'Line', L: [x1, y1, x2, y2], BS: { W: width }, ...(a.type === 'arrow' ? { LE: [PDFName.of('None'), PDFName.of('ClosedArrow')] } : {}) };
  } else if (a.type === 'ink') {
    const paths = (a.paths || []).map((pts) => pts.map(([x, y]) => P(x, y)));
    const all = paths.flat();
    if (!all.length) return null;
    const pad = width + 2;
    rect = [Math.min(...all.map((p) => p[0])) - pad, Math.min(...all.map((p) => p[1])) - pad, Math.max(...all.map((p) => p[0])) + pad, Math.max(...all.map((p) => p[1])) + pad];
    content = `${sc} ${n(width)} w 1 J 1 j ${paths.map((pts) => pts.map(([x, y], i) => `${n(x)} ${n(y)} ${i ? 'l' : 'm'}`).join(' ') + ' S').join(' ')}\n`;
    extra = { Subtype: 'Ink', InkList: paths.map((pts) => pts.flat()), BS: { W: width } };
  } else if (a.type === 'stamp') {
    rect = rectPdf(a.x, a.y, a.w, a.h);
    const [x1, y1, x2, y2] = rect;
    const st = STAMPS[a.stamp] || { label: a.label || 'STAMP', color: a.color };
    const c = rgbOf(st.color);
    const size = Math.min((y2 - y1) * 0.5, (x2 - x1) / Math.max(4, st.label.length) * 1.5);
    const tw = helvW(st.label, size) * 1.05;
    content = `${n(c[0])} ${n(c[1])} ${n(c[2])} RG ${n(c[0])} ${n(c[1])} ${n(c[2])} rg 2.5 w ${n(x1 + 2)} ${n(y1 + 2)} ${n(x2 - x1 - 4)} ${n(y2 - y1 - 4)} re S BT /Helv ${n(size)} Tf ${n((x1 + x2) / 2 - tw / 2)} ${n((y1 + y2) / 2 - size * 0.35)} Td ${pdfStr(st.label)} Tj ET\n`;
    extra = { Subtype: 'Stamp', Name: PDFName.of(st.label.replace(/\s/g, '')) };
  } else return null;
  const bbox = rect;
  const ap = ctx.register(ctx.stream(`/GS0 gs\n${content}`, { Type: 'XObject', Subtype: 'Form', BBox: bbox, Resources: res }));
  const dict = ctx.obj({
    Type: 'Annot', Rect: rect, C: color, CA: opacity, F: 4, M: PDFString.fromDate(new Date(a.created || Date.now())),
    ...(a.author ? { T: PDFString.of(winAnsi(a.author)) } : {}), ...(a.text || a.comment ? { Contents: PDFString.of(winAnsi(a.comment || a.text)) } : {}),
    AP: { N: ap }, ...extra,
  });
  return { dict, ap };
}

/** Replaces pages (by index) with images of themselves: removes the text underneath for real. */
export async function rasterizePages(bytes, indexes, { dpi = 150, quality = 0.85, onProgress } = {}) {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const src = await task.promise;
  const out = await PDFDocument.load(bytes, { ignoreEncryption: true });
  let k = 0;
  for (const i of indexes) {
    const p = await src.getPage(i + 1);
    const vp1 = p.getViewport({ scale: 1 });
    const c = document.createElement('canvas');
    const vp = p.getViewport({ scale: dpi / 72 });
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise;
    const jpg = await out.embedJpg(new Uint8Array(await (await canvasBlob(c, 'image/jpeg', quality)).arrayBuffer()));
    const np = PDFPage.create(out); np.setSize(vp1.width, vp1.height);
    np.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    out.insertPage(i, np);
    out.removePage(i + 1);
    k++;
    onProgress?.(k / indexes.length);
  }
  task.destroy();
  return out.save();
}

/** Pages of a finished PDF as PNG/JPEG (a ZIP for several). */
export async function pdfToImages(bytes, { format = 'png', dpi = 150, quality = 0.9, name = 'Page', onProgress } = {}) {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const src = await task.promise;
  const files = {}; let only = null;
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  for (let i = 1; i <= src.numPages; i++) {
    const p = await src.getPage(i);
    const vp = p.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await p.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
    const blob = await canvasBlob(c, type, quality);
    if (src.numPages === 1) only = blob;
    else files[`${name}-${String(i).padStart(3, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`] = new Uint8Array(await blob.arrayBuffer());
    onProgress?.(i / src.numPages, `Page ${i} of ${src.numPages}`);
  }
  task.destroy();
  return only || new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

/** "1-3, 4-6; 7-" → [[0,1,2],[3,4,5],[6…]] (each comma/semicolon part is one file). */
export function parseRanges(str, count) {
  return String(str || '').split(/[;,]/).map((part) => {
    const m = /^\s*(\d*)\s*(?:-\s*(\d*))?\s*$/.exec(part);
    if (!m || (!m[1] && !m[2])) return null;
    const a = m[1] ? +m[1] : 1; const b = m[2] !== undefined ? (m[2] ? +m[2] : count) : a;
    const out = [];
    for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.push(i - 1);
    return out.length ? out : null;
  }).filter(Boolean);
}

/** Splits a finished PDF into several (a ZIP). */
export async function splitPdf(bytes, groups, name = 'Part') {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const files = {};
  for (let g = 0; g < groups.length; g++) {
    const d = await PDFDocument.create();
    const pages = await d.copyPages(src, groups[g]);
    pages.forEach((p) => d.addPage(p));
    files[`${name}-${g + 1} (pages ${groups[g][0] + 1}-${groups[g][groups[g].length - 1] + 1}).pdf`] = await d.save();
  }
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
