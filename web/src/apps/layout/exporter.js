// Export: vector PDF (pdf-lib, real text with embedded font subsets), PNG/JPEG per page, and printing.
import { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, moveTo, appendBezierCurve, closePath, setCharacterSpacing } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { zipSync } from 'fflate';
import { fontData } from '../../lib/fonts.js';
import { parse } from '../../lib/color.js';
import { itemsOnPage, colorOf } from './model.js';
import { getImage, loadAllImages, renderPageCanvas } from './render.js';
import { canvasBlob } from '../../lib/doc.js';
import { appById } from '../../lib/apps.js';

/** "1-3, 5, 8-" → page indexes (0-based) within n pages. Empty or "all" → every page. */
export function parseRange(str, n) {
  const s = String(str || '').trim().toLowerCase();
  if (!s || s === 'all') return Array.from({ length: n }, (_, i) => i);
  const out = [];
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) { const a = m[1] ? +m[1] : 1; const b = m[2] ? +m[2] : n; for (let i = a; i <= b; i++) if (i >= 1 && i <= n) out.push(i - 1); }
    else if (/^\d+$/.test(part) && +part >= 1 && +part <= n) out.push(+part - 1);
  }
  return [...new Set(out)];
}

const toRgb = (hex) => { const c = parse(hex); return rgb(c.r / 255, c.g / 255, c.b / 255); };
const alphaOf = (hex) => parse(hex).a ?? 1;

function svgShape(it) {
  const { x, y, w, h } = it;
  if (it.type === 'ellipse' || it.shape === 'ellipse') {
    const rx = Math.abs(w / 2); const ry = Math.abs(h / 2); const cx = x + w / 2; const cy = y + h / 2;
    return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
  }
  if (it.type === 'line') return `M ${x} ${y} L ${x + w} ${y + h}`;
  const r = Math.min(it.radius || 0, Math.abs(w) / 2, Math.abs(h) / 2);
  if (!r) return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  return `M ${x + r} ${y} L ${x + w - r} ${y} A ${r} ${r} 0 0 1 ${x + w} ${y + r} L ${x + w} ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} L ${x + r} ${y + h} A ${r} ${r} 0 0 1 ${x} ${y + h - r} L ${x} ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

/** Image bytes ready for pdf-lib (PNG or JPEG; anything else is converted through a canvas). */
async function imageForPdf(pdf, id, cache) {
  if (cache.has(id)) return cache.get(id);
  const p = (async () => {
    const r = await fetch(`/api/assets/${id}/web`, { credentials: 'same-origin' });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50) return await pdf.embedPng(buf);
      if (buf[0] === 0xff && buf[1] === 0xd8) return await pdf.embedJpg(buf);
    } catch { /* fall through to canvas conversion */ }
    const img = getImage(id);
    if (!img) return null;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return pdf.embedPng(new Uint8Array(await (await canvasBlob(c, 'image/png')).arrayBuffer()));
  })();
  cache.set(id, p);
  return p;
}

/**
 * Builds the PDF. opts: { range, bleed (include bleed), marks (crop marks), onProgress }
 */
export async function exportPdf(doc, layout, { range = 'all', bleed = false, marks = false, onProgress, title } = {}) {
  await loadAllImages(doc);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title || 'Layout'); pdf.setCreator(`SoraLab ${appById('layout')?.name || 'Layout'}`); pdf.setProducer('SoraLab (pdf-lib)');
  const fonts = new Map();
  let fallback = null;
  const fontFor = async (a) => {
    const key = `${a.font}|${a.weight}|${a.italic ? 'i' : 'n'}`;
    if (!fonts.has(key)) {
      fonts.set(key, (async () => {
        const data = await fontData(a.font, a.weight, a.italic ? 'italic' : 'normal').catch(() => null);
        if (data) { try { return await pdf.embedFont(data, { subset: true }); } catch { /* unsupported font file */ } }
        fallback ||= await pdf.embedFont(StandardFonts.Helvetica);
        return fallback;
      })());
    }
    return fonts.get(key);
  };
  const imgCache = new Map();
  const pages = parseRange(range, doc.pages.length);
  const b = bleed || marks ? doc.bleed || 0 : 0;
  const slug = marks ? 24 : 0;
  const off = b + slug;
  const W = doc.width + off * 2; const H = doc.height + off * 2;
  let n = 0;
  for (const i of pages) {
    const page = pdf.addPage([W, H]);
    page.setTrimBox(off, off, doc.width, doc.height);
    if (b) page.setBleedBox(off - b, off - b, doc.width + b * 2, doc.height + b * 2);
    const Y = (y) => H - off - y; // page points (y down) → PDF (y up)
    const { master, own } = itemsOnPage(doc, i);
    for (const it of [...master, ...own]) {
      if (it.hidden) continue;
      const fill = colorOf(doc, it.fill); const stroke = colorOf(doc, it.stroke);
      const op = it.opacity ?? 1;
      if (fill && it.type !== 'line') page.drawSvgPath(svgShape(it), { x: off, y: H - off, color: toRgb(fill), opacity: op * alphaOf(fill), borderWidth: 0 });
      if (it.type === 'image' && it.asset) {
        const img = await imageForPdf(pdf, it.asset, imgCache).catch(() => null);
        if (img) {
          const w = (it.iw || img.width) * (it.cs || 1); const h = (it.ih || img.height) * (it.csy || it.cs || 1);
          page.pushOperators(pushGraphicsState());
          if (it.shape === 'ellipse') {
            const k = 0.5523; const rx = it.w / 2; const ry = it.h / 2; const cx = off + it.x + rx; const cy = Y(it.y + ry);
            page.pushOperators(moveTo(cx - rx, cy), appendBezierCurve(cx - rx, cy + ry * k, cx - rx * k, cy + ry, cx, cy + ry), appendBezierCurve(cx + rx * k, cy + ry, cx + rx, cy + ry * k, cx + rx, cy),
              appendBezierCurve(cx + rx, cy - ry * k, cx + rx * k, cy - ry, cx, cy - ry), appendBezierCurve(cx - rx * k, cy - ry, cx - rx, cy - ry * k, cx - rx, cy), closePath());
          } else page.pushOperators(rectangle(off + it.x, Y(it.y + it.h), it.w, it.h));
          page.pushOperators(clip(), endPath());
          page.drawImage(img, { x: off + it.x + (it.cx || 0), y: Y(it.y + (it.cy || 0) + h), width: w, height: h, opacity: op });
          page.pushOperators(popGraphicsState());
        }
      }
      if (it.type === 'text') {
        for (const line of layout.lines(it.id, i)) {
          const pieces = [...(line.drop ? [{ ...line.drop, y: line.drop.y }] : []), ...line.pieces.map((p) => ({ ...p, y: line.y }))];
          // Neighbouring pieces in the same style become one string, spaces included, so the PDF's text copies and searches as words.
          const groups = [];
          for (const p of pieces) {
            if (!p.text) continue;
            const last = groups[groups.length - 1];
            const key = JSON.stringify(p.a);
            if (last && last.key === key && last.y === p.y && Math.abs(last.x + last.w - p.x) < 0.01) { last.text += p.text; last.w += p.w; }
            else if (last && p.text === ' ' && last.y === p.y) { last.text += ' '; last.w = Infinity; }
            else groups.push({ key, a: p.a, x: p.x, y: p.y, w: p.w, text: p.text });
          }
          for (const g of groups) {
            if (!g.text.trim()) continue;
            const a = g.a;
            const color = colorOf(doc, a.color) || '#000000';
            const font = await fontFor(a);
            const tracking = (a.tracking || 0) * a.size / 1000;
            if (tracking) page.pushOperators(setCharacterSpacing(tracking));
            let txt = g.text;
            if (font === fallback) txt = txt.replace(/[^\x20-\x7e\xa0-\xff]/g, '?'); // the standard font only covers WinAnsi
            page.drawText(txt, { x: off + it.x + g.x, y: Y(it.y + g.y - (a.baseline || 0)), size: a.size, font, color: toRgb(color), opacity: op * alphaOf(color) });
            if (tracking) page.pushOperators(setCharacterSpacing(0));
          }
          for (const p of pieces) {
            const a = p.a;
            const color = colorOf(doc, a.color) || '#000000';
            const t = Math.max(0.5, a.size / 18);
            if (a.underline && p.w) page.drawRectangle({ x: off + it.x + p.x, y: Y(it.y + p.y + a.size * 0.12 + t), width: p.w, height: t, color: toRgb(color), opacity: op });
            if (a.strike && p.w) page.drawRectangle({ x: off + it.x + p.x, y: Y(it.y + p.y - a.size * 0.3 + t), width: p.w, height: t, color: toRgb(color), opacity: op });
          }
        }
      }
      if (stroke && (it.sw ?? 1) > 0) {
        page.drawSvgPath(svgShape(it), { x: off, y: H - off, borderColor: toRgb(stroke), borderWidth: it.sw ?? 1, borderOpacity: op * alphaOf(stroke), ...(it.dash ? { borderDashArray: [it.sw * 3, it.sw * 2] } : {}) });
      }
    }
    if (marks) drawCropMarks(page, off, doc.width, doc.height, b);
    n++;
    onProgress?.(n / pages.length, `Page ${n} of ${pages.length}`);
  }
  const bytes = await pdf.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

function drawCropMarks(page, off, w, h, b) {
  const gap = b + 3; const len = 14; const k = rgb(0, 0, 0); const t = 0.25;
  for (const [x, sx] of [[off, -1], [off + w, 1]]) {
    for (const [y, sy] of [[off, -1], [off + h, 1]]) {
      page.drawLine({ start: { x: x + sx * gap, y }, end: { x: x + sx * (gap + len), y }, thickness: t, color: k });
      page.drawLine({ start: { x, y: y + sy * gap }, end: { x, y: y + sy * (gap + len) }, thickness: t, color: k });
    }
  }
}

/** PNG/JPEG of each page; a ZIP when there's more than one. */
export async function exportImages(doc, layout, { format = 'png', dpi = 150, range = 'all', quality = 0.9, onProgress, name = 'Page' } = {}) {
  await loadAllImages(doc);
  const pages = parseRange(range, doc.pages.length);
  const files = {};
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  let only = null;
  for (let k = 0; k < pages.length; k++) {
    const c = renderPageCanvas(doc, pages[k], layout, { scale: dpi / 72 });
    const blob = await canvasBlob(c, type, quality);
    if (pages.length === 1) only = blob;
    else files[`${name}-${String(pages[k] + 1).padStart(3, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`] = new Uint8Array(await blob.arrayBuffer());
    onProgress?.((k + 1) / pages.length, `Page ${k + 1} of ${pages.length}`);
  }
  if (only) return only;
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

/** Prints through the browser: pages rendered at 150 ppi into a print-only frame sized to the page. */
export async function printDoc(doc, layout, { range = 'all' } = {}) {
  await loadAllImages(doc);
  const pages = parseRange(range, doc.pages.length);
  const urls = [];
  for (const i of pages) urls.push(URL.createObjectURL(await canvasBlob(renderPageCanvas(doc, i, layout, { scale: 150 / 72 }), 'image/png')));
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(`<!doctype html><html><head><style>@page{size:${doc.width}pt ${doc.height}pt;margin:0}html,body{margin:0;padding:0}img{display:block;width:${doc.width}pt;height:${doc.height}pt;page-break-after:always;break-after:page}</style></head><body>${urls.map((u) => `<img src="${u}">`).join('')}</body></html>`);
  d.close();
  await Promise.all([...d.images].map((im) => (im.complete ? null : new Promise((r) => { im.onload = r; im.onerror = r; }))));
  f.contentWindow.focus();
  f.contentWindow.print();
  setTimeout(() => { f.remove(); urls.forEach(URL.revokeObjectURL); }, 60000);
}
