// Export: standalone SVG (fonts embedded or text as outlines), PNG/JPEG via the browser's SVG renderer, and vector PDF
// drawn with pdf-lib (paths, gradients as PDF shadings, embedded subset fonts, images, clipping masks, opacity/blend).
import * as opentype from 'opentype.js';
import { PDFDocument, PDFName, PDFOperator, StandardFonts, pushGraphicsState, popGraphicsState, moveTo, appendBezierCurve, closePath, lineTo,
  fill, stroke, fillAndStroke, clip, clipEvenOdd, endPath, setFillingRgbColor, setStrokingRgbColor, setLineWidth, setLineCap, setLineJoin,
  setDashPattern, concatTransformationMatrix, setGraphicsState, setCharacterSpacing, drawObject, LineCapStyle, LineJoinStyle } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { zipSync } from 'fflate';
import { fontData } from '../../lib/fonts.js';
import { canvasBlob } from '../../lib/doc.js';
import { parse } from '../../lib/color.js';
import { I, mul, apply, translate, segments, localSubpaths, mapSubpaths, parsePathData, samplePath, pointAtLength, isIdentity } from './geom.js';
import { layoutText, fontOf, loadFonts } from './text.js';
import { svgDocument } from './render.js';
import { artboardsOf, walk } from './model.js';

// ---------------------------------------------------------------- shared caches

const fontBytes = new Map();
const fontKey = (f) => `${f.family}|${f.weight}|${f.style}`;
function getFontBytes(f) {
  const k = fontKey(f);
  if (!fontBytes.has(k)) fontBytes.set(k, fontData(f.family, f.weight, f.style).catch(() => null));
  return fontBytes.get(k);
}
const otFonts = new Map();
async function getOtFont(f) {
  const k = fontKey(f);
  if (!otFonts.has(k)) otFonts.set(k, getFontBytes(f).then((b) => (b ? opentype.parse(b) : null)).catch(() => null));
  return otFonts.get(k);
}
const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

const assetBlobs = new Map();
export function assetBlob(id) {
  if (!assetBlobs.has(id)) assetBlobs.set(id, fetch(`/api/assets/${id}/web`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.blob() : null)).catch(() => null));
  return assetBlobs.get(id);
}

/** Every node that will be drawn for these roots, including symbol contents. */
function usedNodes(doc, roots) {
  const out = []; const syms = new Set();
  const visit = (list) => walk(list, (n) => { out.push(n); if (n.type === 'instance' && !syms.has(n.symbol)) { syms.add(n.symbol); visit(doc.symbols.find((s) => s.id === n.symbol)?.children || []); } if (n.type === 'repeat') visit(n.cell.children); });
  visit(roots);
  return out;
}

/** @font-face rules with the font files inlined (so SVG-as-image and exported SVGs show the right type). */
export async function fontFaceCss(nodes) {
  const fonts = new Map();
  for (const n of nodes) if (n.type === 'text') { const f = fontOf(n); fonts.set(fontKey(f), f); }
  const rules = await Promise.all([...fonts.values()].map(async (f) => {
    const b = await getFontBytes(f);
    return b ? `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:${f.style};src:url(data:font/woff;base64,${b64(b)}) format("woff");}` : '';
  }));
  return rules.join('');
}
async function assetDataUrls(nodes) {
  const map = new Map();
  await Promise.all(nodes.filter((n) => n.type === 'image' && n.asset).map(async (n) => { const b = await assetBlob(n.asset); if (b) map.set(n.asset, await blobToDataUrl(b)); }));
  return map;
}

// ---------------------------------------------------------------- text → outlines

function cmdsToD(cmds, m) {
  const P = (x, y) => { const p = apply(m, x, y); return `${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`; };
  let d = '';
  for (const c of cmds) {
    if (c.type === 'M') d += `M${P(c.x, c.y)}`;
    else if (c.type === 'L') d += `L${P(c.x, c.y)}`;
    else if (c.type === 'C') d += `C${P(c.x1, c.y1)} ${P(c.x2, c.y2)} ${P(c.x, c.y)}`;
    else if (c.type === 'Q') d += `Q${P(c.x1, c.y1)} ${P(c.x, c.y)}`;
    else if (c.type === 'Z') d += 'Z';
  }
  return d;
}
/** Glyph outlines of a text node as path data in the node's local space (null if the font can't be read). */
export async function textOutline(n) {
  const f = fontOf(n);
  const font = await getOtFont(f);
  if (!font) return null;
  const k = f.size / font.unitsPerEm; const track = (f.tracking * f.size) / 1000;
  const glyphRun = (s) => [...s].map((ch) => font.charToGlyph(ch));
  let d = '';
  if (n.mode === 'path') {
    const samples = samplePath(parsePathData(n.pathD || ''));
    const total = samples[samples.length - 1]?.len || 0;
    let pos = ((n.startOffset || 0) / 100) * total;
    for (const g of glyphRun(String(n.text || '').replace(/\n/g, ' '))) {
      const adv = g.advanceWidth * k;
      if (pos + adv / 2 > total) break;
      const p = pointAtLength(samples, pos + adv / 2);
      const m = mul([Math.cos(p.angle), Math.sin(p.angle), -Math.sin(p.angle), Math.cos(p.angle), p.x, p.y], translate(-adv / 2, 0));
      d += cmdsToD(g.getPath(0, 0, f.size).commands, m);
      pos += adv + track;
    }
    return d;
  }
  const L = layoutText(n);
  for (const line of L.lines) {
    let x = line.x; let prev = null;
    for (const g of glyphRun(line.text)) {
      if (prev) { try { x += font.getKerningValue(prev, g) * k; } catch { /* no kerning table */ } }
      d += cmdsToD(g.getPath(x, line.y, f.size).commands, I);
      x += g.advanceWidth * k + track; prev = g;
    }
  }
  return d;
}
async function outlinesFor(nodes) {
  const map = new Map();
  await Promise.all(nodes.filter((n) => n.type === 'text').map(async (n) => { const d = await textOutline(n); if (d !== null) map.set(n.id, d); }));
  return map;
}

// ---------------------------------------------------------------- SVG and raster

/** A self-contained SVG string for an artboard. outlines: text as paths; otherwise fonts are embedded. */
export async function artboardSvg(doc, ab, { outlines = false, embedFonts = true, width, height } = {}) {
  const nodes = usedNodes(doc, [ab]);
  await loadFonts(nodes);
  const [assets, outl, css] = await Promise.all([assetDataUrls(nodes), outlines ? outlinesFor(nodes) : null, !outlines && embedFonts ? fontFaceCss(nodes) : '']);
  return svgDocument(doc, [{ ...ab, clip: true }], { x: ab.x, y: ab.y, w: ab.w, h: ab.h }, { assetUrl: (id) => assets.get(id) || '', outlines: outl, style: css, width, height });
}

/** Draws an artboard into a canvas at a scale (fonts and images inlined so the browser renders them). */
export async function rasterize(doc, ab, scale = 1, { background } = {}) {
  const w = Math.max(1, Math.round(ab.w * scale)); const h = Math.max(1, Math.round(ab.h * scale));
  const svg = await artboardSvg(doc, ab, { width: w, height: h });
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Couldn’t draw this artboard.')); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (background) { g.fillStyle = background; g.fillRect(0, 0, w, h); }
  g.drawImage(img, 0, 0, w, h);
  return c;
}

const safeName = (s) => String(s || 'Artboard').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Artboard';
/** Which artboards an export covers: 'all', or one id (default: the first). */
export const pickArtboards = (doc, which) => { const all = artboardsOf(doc); return which === 'all' ? all : [all.find((a) => a.id === which) || all[0]].filter(Boolean); };

async function many(list, one, ext, onProgress) {
  if (list.length === 1) return one(list[0]);
  const files = {};
  for (let i = 0; i < list.length; i++) {
    onProgress?.(i / list.length, `Artboard ${i + 1} of ${list.length}…`);
    const b = await one(list[i]);
    let name = `${safeName(list[i].name)}.${ext}`; let k = 2;
    while (files[name]) name = `${safeName(list[i].name)} ${k++}.${ext}`;
    files[name] = new Uint8Array(await b.arrayBuffer());
  }
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

export async function exportSvg(doc, which, { outlines } = {}, onProgress) {
  return many(pickArtboards(doc, which), async (ab) => new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${await artboardSvg(doc, ab, { outlines })}`], { type: 'image/svg+xml' }), 'svg', onProgress);
}
export async function exportRaster(doc, which, { scale = 1, type = 'image/png', quality = 0.92 } = {}, onProgress) {
  return many(pickArtboards(doc, which), async (ab) => {
    const c = await rasterize(doc, ab, scale, { background: type === 'image/jpeg' ? '#ffffff' : null });
    return canvasBlob(c, type, quality);
  }, type === 'image/jpeg' ? 'jpg' : 'png', onProgress);
}

// ---------------------------------------------------------------- PDF

const PDF_BLEND = { multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten', 'color-dodge': 'ColorDodge', 'color-burn': 'ColorBurn', 'hard-light': 'HardLight', 'soft-light': 'SoftLight', difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity' };
const rgb01 = (c) => { const p = parse(c); return { r: p.r / 255, g: p.g / 255, b: p.b / 255, a: p.a ?? 1 }; };

/** Vector PDF, one page per artboard. */
export async function exportPdf(doc, which = 'all', onProgress) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setProducer('SoraLab'); pdf.setCreator('SoraLab');
  const list = pickArtboards(doc, which);
  const fonts = new Map(); const images = new Map();
  const pdfFont = async (f) => {
    const k = fontKey(f);
    if (!fonts.has(k)) fonts.set(k, (async () => { const b = await getFontBytes(f); try { return b ? await pdf.embedFont(b, { subset: true }) : null; } catch { return null; } })().then((x) => x || pdf.embedFont(StandardFonts.Helvetica)));
    return fonts.get(k);
  };
  const pdfImage = async (id) => {
    if (!images.has(id)) images.set(id, (async () => {
      const b = await assetBlob(id); if (!b) return null;
      const bytes = new Uint8Array(await b.arrayBuffer());
      if (b.type === 'image/png') return pdf.embedPng(bytes);
      if (b.type === 'image/jpeg') return pdf.embedJpg(bytes);
      const bmp = await createImageBitmap(b); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
      return pdf.embedPng(new Uint8Array(await (await canvasBlob(c)).arrayBuffer()));
    })().catch(() => null));
    return images.get(id);
  };

  for (let pi = 0; pi < list.length; pi++) {
    onProgress?.(pi / list.length, `Page ${pi + 1} of ${list.length}…`);
    const ab = list[pi];
    const nodes = usedNodes(doc, [ab]);
    await loadFonts(nodes);
    const page = pdf.addPage([ab.w, ab.h]);
    const ctx = pdf.context;
    const ops = [];
    const push = (...o) => ops.push(...o);
    let gsN = 0; let shN = 0;
    const res = () => page.node.Resources();
    const gstate = (o, blend) => {
      const dict = { Type: 'ExtGState' };
      if (o !== undefined) { dict.ca = o; dict.CA = o; }
      if (blend && PDF_BLEND[blend]) dict.BM = PDF_BLEND[blend];
      return page.node.newExtGState(`GS${gsN++}`, ctx.obj(dict));
    };
    const shading = (f, box) => {
      const stops = (f.stops?.length ? f.stops : [{ o: 0, color: '#000' }, { o: 1, color: '#000' }]).slice().sort((a, b) => a.o - b.o);
      const C = (s) => { const c = rgb01(s.color); return [c.r, c.g, c.b]; };
      const fns = []; const bounds = []; const enc = [];
      for (let i = 0; i < stops.length - 1; i++) { fns.push(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: C(stops[i]), C1: C(stops[i + 1]), N: 1 })); if (i > 0) bounds.push(stops[i].o); enc.push(0, 1); }
      const fn = stops.length < 2 ? ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: C(stops[0]), C1: C(stops[0]), N: 1 })
        : ctx.obj({ FunctionType: 3, Domain: [stops[0].o, stops[stops.length - 1].o], Functions: fns, Bounds: bounds, Encode: enc });
      let sh;
      if (f.type === 'radial') sh = ctx.obj({ ShadingType: 3, ColorSpace: 'DeviceRGB', Coords: [f.cx ?? 0.5, f.cy ?? 0.5, 0, f.cx ?? 0.5, f.cy ?? 0.5, f.r ?? 0.5], Function: fn, Extend: [true, true] });
      else { const a = ((f.angle || 0) * Math.PI) / 180; const c = Math.cos(a) / 2; const s = Math.sin(a) / 2; sh = ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [0.5 - c, 0.5 - s, 0.5 + c, 0.5 + s], Function: fn, Extend: [true, true] }); }
      const r = res(); let dict = r.lookup(PDFName.of('Shading'));
      if (!dict) { dict = ctx.obj({}); r.set(PDFName.of('Shading'), dict); }
      const name = `Sh${shN++}`;
      dict.set(PDFName.of(name), ctx.register(sh));
      // The shading is defined in a unit square mapped onto the object's box (like objectBoundingBox in SVG).
      return [concatTransformationMatrix(box.w || 1, 0, 0, box.h || 1, box.x, box.y), PDFOperator.of('sh', [PDFName.of(name)])];
    };
    const pathOps = (sps) => {
      const o = [];
      for (const sp of sps) {
        if (!sp.pts.length) continue;
        o.push(moveTo(sp.pts[0].x, sp.pts[0].y));
        for (const [, b, c, e] of segments(sp)) o.push(appendBezierCurve(b.x, b.y, c.x, c.y, e.x, e.y));
        if (sp.closed) o.push(closePath());
      }
      return o;
    };
    const strokeOps = (st) => {
      const c = rgb01(st.color);
      return [setStrokingRgbColor(c.r, c.g, c.b), setLineWidth(st.width), setLineCap({ round: LineCapStyle.Round, square: LineCapStyle.Projecting }[st.cap] ?? LineCapStyle.Butt),
        setLineJoin({ round: LineJoinStyle.Round, bevel: LineJoinStyle.Bevel }[st.join] ?? LineJoinStyle.Miter), setDashPattern(st.dash || [], 0)];
    };
    const sbox = (sps) => { let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; for (const sp of sps) for (const p of sp.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; };

    // Geometry for clip paths (world space).
    const clipOpsOf = (n, M) => {
      if (n.type === 'group') return n.children.flatMap((c) => clipOpsOf(c, M));
      const sps = localSubpaths(n);
      if (sps) return pathOps(mapSubpaths(sps, mul(M, n.t || I)));
      if (n.type === 'text') { const L = layoutText(n); return pathOps(mapSubpaths([{ closed: true, pts: [{ x: 0, y: 0 }, { x: L.w, y: 0 }, { x: L.w, y: L.h }, { x: 0, y: L.h }].map((p) => ({ ...p, ix: p.x, iy: p.y, ox: p.x, oy: p.y })) }], mul(M, n.t || I))); }
      return [];
    };

    const drawNode = async (n, M, overrides) => {
      if (n.hidden) return;
      const ov = overrides?.[n.id];
      if (ov) { n = { ...n, ...(ov.text !== undefined ? { text: ov.text } : {}), ...(ov.fill !== undefined ? { fill: ov.fill } : {}), ...(ov.hidden !== undefined ? { hidden: ov.hidden } : {}) }; if (n.hidden) return; }
      push(pushGraphicsState());
      if ((n.opacity ?? 1) < 1 || (n.blend && n.blend !== 'normal')) push(setGraphicsState(gstate(n.opacity ?? 1, n.blend)));
      if (n.type === 'group') {
        if (n.clip && n.children.length > 1) {
          const mask = n.children[n.children.length - 1];
          push(...clipOpsOf(mask, M), mask.fillRule === 'evenodd' ? clipEvenOdd() : clip(), endPath());
          for (const c of n.children.slice(0, -1)) await drawNode(c, M, overrides);
        } else for (const c of n.children) await drawNode(c, M, overrides);
      } else if (n.type === 'instance') {
        const sym = doc.symbols.find((s) => s.id === n.symbol);
        for (const c of sym?.children || []) await drawNode(c, mul(M, n.t), n.overrides);
      } else if (n.type === 'repeat') {
        for (let r = 0; r < n.rows; r++) for (let c = 0; c < n.cols; c++) {
          const k = r * n.cols + c;
          const ovs = n.texts?.[k] ? Object.fromEntries(Object.entries(n.texts[k]).map(([id, text]) => [id, { text }])) : null;
          for (const x of n.cell.children) await drawNode(x, mul(mul(M, n.t), translate(c * (n.cell.w + n.gx), r * (n.cell.h + n.gy))), ovs);
        }
      } else if (n.type === 'image') {
        const img = await pdfImage(n.asset);
        if (img) {
          push(concatTransformationMatrix(...mul(M, n.t)));
          push(moveTo(0, 0), lineTo(n.w, 0), lineTo(n.w, n.h), lineTo(0, n.h), closePath(), clip(), endPath());
          const s = n.fit === 'stretch' ? null : Math.max(n.w / img.width, n.h / img.height);
          const iw = s ? img.width * s : n.w; const ih = s ? img.height * s : n.h;
          const name = page.node.newXObject('Im', img.ref);
          push(concatTransformationMatrix(iw, 0, 0, -ih, (n.w - iw) / 2, (n.h - ih) / 2 + ih), drawObject(name));
        }
      } else if (n.type === 'text') {
        await drawText(n, mul(M, n.t));
      } else {
        const sps = mapSubpaths(localSubpaths(n), mul(M, n.t || I));
        const f = n.fill; const st = n.stroke?.color && n.stroke.width > 0 ? n.stroke : null;
        const evenodd = n.fillRule === 'evenodd';
        if (f && f.type !== 'none') {
          if (f.type === 'solid') {
            const c = rgb01(f.color);
            push(pushGraphicsState());
            if (c.a < 1) push(setGraphicsState(gstate(c.a)));
            push(setFillingRgbColor(c.r, c.g, c.b), ...pathOps(sps), evenodd ? PDFOperator.of('f*') : fill(), popGraphicsState());
          } else {
            push(pushGraphicsState(), ...pathOps(sps), evenodd ? clipEvenOdd() : clip(), endPath());
            // Gradient box: the object's local box through its matrix (keeps gradients rotating with the object).
            const lb = sbox(localSubpaths(n)); const m = mul(M, n.t || I);
            push(concatTransformationMatrix(...m), ...shading(f, lb), popGraphicsState());
          }
        }
        if (st) {
          const sc = rgb01(st.color);
          const closed = sps.every((sp) => sp.closed);
          push(pushGraphicsState());
          if (sc.a < 1) push(setGraphicsState(gstate(sc.a)));
          if (closed && st.align === 'inside') push(...pathOps(sps), clip(), endPath(), ...strokeOps({ ...st, width: st.width * 2 }));
          else push(...strokeOps(st));
          push(...pathOps(sps), stroke(), popGraphicsState());
        }
      }
      push(popGraphicsState());
    };
    void fillAndStroke;

    const drawText = async (n, m) => {
      const f = fontOf(n);
      const font = await pdfFont(f);
      const fillc = n.fill?.type === 'solid' ? n.fill.color : n.fill?.stops?.[0]?.color || null;
      if (!fillc) return;
      const c = rgb01(fillc);
      push(pushGraphicsState(), concatTransformationMatrix(...m));
      if (c.a < 1) push(setGraphicsState(gstate(c.a)));
      const track = (f.tracking * f.size) / 1000;
      const glyph = (txt, x, y, angle = 0) => {
        // Text is drawn in a flipped frame so it reads upright inside our y-down page space.
        const cs = Math.cos(angle); const sn = Math.sin(angle);
        push(pushGraphicsState(), concatTransformationMatrix(cs, sn, sn, -cs, x, y));
        if (track) push(setCharacterSpacing(track));
        page.pushOperators(...ops.splice(0));
        page.drawText(txt, { x: 0, y: 0, size: f.size, font, color: { type: 'RGB', red: c.r, green: c.g, blue: c.b } });
        push(popGraphicsState());
      };
      if (n.mode === 'path') {
        const samples = samplePath(parsePathData(n.pathD || ''));
        const total = samples[samples.length - 1]?.len || 0;
        let pos = ((n.startOffset || 0) / 100) * total;
        for (const ch of String(n.text || '').replace(/\n/g, ' ')) {
          let adv = 0; try { adv = font.widthOfTextAtSize(ch, f.size); } catch { continue; }
          if (pos + adv / 2 > total) break;
          const p = pointAtLength(samples, pos + adv / 2);
          const a = p.angle;
          glyph(ch, p.x - (Math.cos(a) * adv) / 2, p.y - (Math.sin(a) * adv) / 2, a);
          pos += adv + track;
        }
      } else {
        const L = layoutText(n);
        for (const line of L.lines) {
          if (!line.text) continue;
          let w = line.w; try { w = font.widthOfTextAtSize(line.text, f.size) + track * line.text.length; } catch { /* missing glyphs */ }
          const x = L.anchor === 'middle' ? L.ax - w / 2 : L.anchor === 'end' ? L.ax - w : 0;
          try { glyph(line.text, x, line.y); } catch { push(popGraphicsState()); }
        }
      }
      push(popGraphicsState());
    };

    // Page space: y down, origin at the artboard's corner.
    push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, -ab.x, ab.h + ab.y));
    if (ab.bg) { const c = rgb01(ab.bg); push(setFillingRgbColor(c.r, c.g, c.b), moveTo(ab.x, ab.y), lineTo(ab.x + ab.w, ab.y), lineTo(ab.x + ab.w, ab.y + ab.h), lineTo(ab.x, ab.y + ab.h), closePath(), fill()); }
    for (const n of ab.children) await drawNode(n, I, null);
    push(popGraphicsState());
    page.pushOperators(...ops.splice(0));
  }
  void isIdentity;
  const bytes = await pdf.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

/** A small canvas of the first artboard for project lists. */
export async function thumbnail(doc, max = 480) {
  const ab = artboardsOf(doc)[0];
  if (!ab) return null;
  return rasterize(doc, ab, Math.min(1, max / Math.max(ab.w, ab.h)), { background: '#ffffff' });
}

/** The export formats offered by an app (one artboard at a time, or all of them zipped / as PDF pages). */
export function exportFormats(doc, { pdf = true, raster = true, label = 'Artboard', current } = {}) {
  const abs = artboardsOf(doc);
  const one = { key: 'which', label, type: 'select', default: current && abs.some((a) => a.id === current) ? current : abs[0]?.id, choices: abs.map((a) => [a.id, a.name]) };
  const scale = { key: 'scale', label: 'Size', type: 'select', default: 1, choices: [[1, '1×'], [2, '2×'], [3, '3×']] };
  const multi = abs.length > 1;
  const all = (l) => `${l} — all ${label.toLowerCase()}s (.zip)`;
  return [
    ...(raster ? [{ id: 'png', label: 'PNG image', ext: 'png', kind: 'image', options: [one, scale] },
      { id: 'jpg', label: 'JPEG image', ext: 'jpg', kind: 'image', options: [one, scale, { key: 'quality', label: 'Quality', type: 'range', default: 90, min: 30, max: 100, unit: '%' }] }] : []),
    { id: 'svg', label: 'SVG', ext: 'svg', kind: 'image', options: [one, { key: 'outlines', label: 'Text as outlines', type: 'toggle', default: false }] },
    ...(pdf ? [{ id: 'pdf', label: multi ? `PDF — all ${label.toLowerCase()}s` : 'PDF', ext: 'pdf', kind: 'document', note: 'Vector PDF with embedded fonts, one page per artboard. Shadows and blurs aren’t included in PDFs.' }] : []),
    ...(multi && raster ? [{ id: 'png-all', label: all('PNG'), ext: 'zip', kind: 'archive', options: [scale] }] : []),
    ...(multi ? [{ id: 'svg-all', label: all('SVG'), ext: 'zip', kind: 'archive', options: [{ key: 'outlines', label: 'Text as outlines', type: 'toggle', default: false }] }] : []),
  ];
}
export async function renderExport(doc, id, o, onProgress) {
  if (id === 'png') return exportRaster(doc, o.which, { scale: o.scale, type: 'image/png' }, onProgress);
  if (id === 'jpg') return exportRaster(doc, o.which, { scale: o.scale, type: 'image/jpeg', quality: (o.quality || 90) / 100 }, onProgress);
  if (id === 'svg') return exportSvg(doc, o.which, { outlines: o.outlines }, onProgress);
  if (id === 'pdf') return exportPdf(doc, 'all', onProgress);
  if (id === 'png-all') return exportRaster(doc, 'all', { scale: o.scale, type: 'image/png' }, onProgress);
  if (id === 'svg-all') return exportSvg(doc, 'all', { outlines: o.outlines }, onProgress);
  throw new Error('Unknown format');
}
