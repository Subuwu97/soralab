// Renders the scene graph to SVG markup. The same code draws the editor canvas (with data-id attributes for hit testing),
// previews, thumbnails and exports, so what you see is what you export.
import { I, isIdentity, matStr, pathData, localSubpaths, translate, mul } from './geom.js';
import { layoutText, fontOf, leadingOf } from './text.js';
import { parse } from '../../lib/color.js';

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (v) => String(Math.round((v || 0) * 100) / 100);

/** "#rrggbbaa" → { c: '#rrggbb', a } so exports work in viewers without 8-digit hex. */
export function splitColor(col) {
  if (!col) return { c: 'none', a: 1 };
  const p = parse(col);
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return { c: `#${h(p.r)}${h(p.g)}${h(p.b)}`, a: p.a ?? 1 };
}

// Saved documents can come from anyone (shared projects, imported .sora files): every value that lands in an SVG
// attribute is escaped or checked against a list, so a crafted file can't add markup to the page.
const sid = (v) => String(v).replace(/[^\w-]/g, '_');
const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];
export const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

function gradientDef(id, f) {
  const stops = (f.stops || []).map((s) => { const { c, a } = splitColor(s.color); return `<stop offset="${n2(s.o)}" stop-color="${c}"${a < 1 ? ` stop-opacity="${n2(a)}"` : ''}/>`; }).join('');
  if (f.type === 'radial') return `<radialGradient id="${id}" cx="${n2(f.cx ?? 0.5)}" cy="${n2(f.cy ?? 0.5)}" r="${n2(f.r ?? 0.5)}">${stops}</radialGradient>`;
  const a = ((f.angle || 0) * Math.PI) / 180; const c = Math.cos(a) / 2; const s = Math.sin(a) / 2;
  return `<linearGradient id="${id}" x1="${n2(0.5 - c)}" y1="${n2(0.5 - s)}" x2="${n2(0.5 + c)}" y2="${n2(0.5 + s)}">${stops}</linearGradient>`;
}
/** Fill attributes plus any gradient definition. */
function fillAttrs(fill, id) {
  if (!fill || fill.type === 'none') return { attrs: 'fill="none"', defs: '' };
  if (fill.type === 'solid') { const { c, a } = splitColor(fill.color); return { attrs: `fill="${c}"${a < 1 ? ` fill-opacity="${n2(a)}"` : ''}`, defs: '' }; }
  return { attrs: `fill="url(#${id})"`, defs: gradientDef(id, fill) };
}
function strokeAttrs(st, widthMul = 1) {
  if (!st || !st.color || !(st.width > 0)) return '';
  const { c, a } = splitColor(st.color);
  let s = ` stroke="${c}" stroke-width="${n2(st.width * widthMul)}"`;
  if (a < 1) s += ` stroke-opacity="${n2(a)}"`;
  if (st.cap && st.cap !== 'butt' && CAPS.includes(st.cap)) s += ` stroke-linecap="${st.cap}"`;
  if (st.join && st.join !== 'miter' && JOINS.includes(st.join)) s += ` stroke-linejoin="${st.join}"`;
  if (st.dash?.length) s += ` stroke-dasharray="${st.dash.map(n2).join(' ')}"`;
  return s;
}
function filterDef(id, effects) {
  const on = (effects || []).filter((e) => e.on !== false);
  if (!on.length) return '';
  let prev = 'SourceGraphic'; let body = ''; let k = 0;
  for (const e of on) {
    const out = `e${k++}`;
    if (e.type === 'blur') body += `<feGaussianBlur in="${prev}" stdDeviation="${n2((e.radius || 0) / 2)}" result="${out}"/>`;
    if (e.type === 'shadow') { const { c, a } = splitColor(e.color || '#00000080'); body += `<feDropShadow in="${prev}" dx="${n2(e.x)}" dy="${n2(e.y)}" stdDeviation="${n2((e.blur || 0) / 2)}" flood-color="${c}" flood-opacity="${n2(a)}" result="${out}"/>`; }
    prev = out;
  }
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${body}</filter>`;
}

/** Geometry-only markup of a leaf (no paint), in local space with its matrix applied. */
function geometry(n, ctx, extra = '') {
  const tr = isIdentity(n.t) ? '' : ` transform="${matStr(n.t)}"`;
  switch (n.type) {
    case 'rect': return `<rect width="${n2(n.w)}" height="${n2(n.h)}"${n.r ? ` rx="${n2(Math.min(n.r, n.w / 2, n.h / 2))}"` : ''}${tr}${extra}/>`;
    case 'ellipse': return `<ellipse cx="${n2(n.w / 2)}" cy="${n2(n.h / 2)}" rx="${n2(n.w / 2)}" ry="${n2(n.h / 2)}"${tr}${extra}/>`;
    case 'path': case 'polygon': case 'star': return `<path d="${pathData(localSubpaths(n))}"${n.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}${tr}${extra}/>`;
    case 'image': return `<rect width="${n2(n.w)}" height="${n2(n.h)}"${tr}${extra}/>`;
    case 'text': return textMarkup(n, ctx, tr, extra);
    default: return '';
  }
}

function textMarkup(n, ctx, tr, extra) {
  const outline = ctx.outlines?.get(n.id);
  if (outline !== undefined) return `<path d="${outline}"${tr}${extra}/>`;
  const f = fontOf(n);
  const fontAttrs = ` font-family="${esc(f.family)}" font-size="${n2(f.size)}"${f.weight !== 400 ? ` font-weight="${f.weight}"` : ''}${f.style === 'italic' ? ' font-style="italic"' : ''}${f.tracking ? ` letter-spacing="${n2((f.tracking * f.size) / 1000)}"` : ''}`;
  if (n.mode === 'path') {
    const pid = `${ctx.prefix}tp-${sid(n.id)}`;
    return `<path id="${pid}" d="${esc(n.pathD || '')}" fill="none" stroke="none"${tr}/><text${fontAttrs}${extra} xml:space="preserve"><textPath href="#${pid}" startOffset="${n2(n.startOffset || 0)}%">${esc(n.text)}</textPath></text>`;
  }
  const L = layoutText(n);
  const tspans = L.lines.map((l) => `<tspan x="${n2(L.ax)}" y="${n2(l.y)}">${esc(l.text) || ' '}</tspan>`).join('');
  return `<text${fontAttrs}${L.anchor !== 'start' ? ` text-anchor="${L.anchor}"` : ''}${tr}${extra} xml:space="preserve">${tspans}</text>`;
}

/** Fill + stroke of a leaf honouring stroke alignment (inside/outside need a clip or mask). */
function paintLeaf(n, ctx) {
  const pid = `${ctx.prefix}${sid(n.id)}`;
  if (n.type === 'image') {
    const tr = isIdentity(n.t) ? '' : ` transform="${matStr(n.t)}"`;
    const href = ctx.assetUrl ? ctx.assetUrl(n.asset) : '';
    let s = `<image href="${esc(href)}" width="${n2(n.w)}" height="${n2(n.h)}" preserveAspectRatio="${n.fit === 'stretch' ? 'none' : 'xMidYMid slice'}"${tr}/>`;
    if (n.stroke?.color && n.stroke.width > 0) s += geometry(n, ctx, ` fill="none"${strokeAttrs(n.stroke)}`);
    return s;
  }
  const fill = fillAttrs(n.fill, `${pid}-f`);
  const st = n.stroke;
  const hasStroke = st && st.color && st.width > 0;
  const closed = n.type !== 'path' || n.subpaths.every((sp) => sp.closed);
  const align = hasStroke && closed && n.type !== 'text' ? st.align || 'center' : 'center';
  let s = fill.defs;
  if (align === 'center') s += geometry(n, ctx, ` ${fill.attrs}${strokeAttrs(st)}`);
  else {
    s += geometry(n, ctx, ` ${fill.attrs}`);
    if (align === 'inside') s += `<clipPath id="${pid}-sc">${geometry(n, ctx)}</clipPath><g clip-path="url(#${pid}-sc)">${geometry(n, ctx, ` fill="none"${strokeAttrs(st, 2)}`)}</g>`;
    else s += `<mask id="${pid}-sm" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><rect x="-100000" y="-100000" width="200000" height="200000" fill="#fff"/>${geometry(n, ctx, ' fill="#000"')}</mask><g mask="url(#${pid}-sm)">${geometry(n, ctx, ` fill="none"${strokeAttrs(st, 2)}`)}</g>`;
  }
  // Easier clicking in the editor: thin or unfilled shapes get an invisible wide hit line, text gets its box.
  if (ctx.ids) {
    if (n.type === 'text' && n.mode !== 'path') { const L = layoutText(n); s += `<rect width="${n2(L.w)}" height="${n2(L.h)}" fill="transparent"${isIdentity(n.t) ? '' : ` transform="${matStr(n.t)}"`}/>`; }
    else if (n.type !== 'text' && (!n.fill || n.fill.type === 'none')) s += geometry(n, ctx, ' fill="none" stroke="transparent" stroke-width="10" vector-effect="non-scaling-stroke" pointer-events="stroke"');
  }
  return s;
}

/** Wrapper attributes shared by every node: id, opacity, blend mode, effects. */
function wrap(n, ctx, inner) {
  const pid = `${ctx.prefix}${sid(n.id)}`;
  const fx = filterDef(`${pid}-fx`, n.effects);
  let a = '';
  if (ctx.ids) a += ` data-id="${esc(n.id)}"`;
  if (n.opacity !== undefined && n.opacity < 1) a += ` opacity="${n2(n.opacity)}"`;
  if (n.blend && n.blend !== 'normal' && BLENDS.includes(n.blend)) a += ` style="mix-blend-mode:${n.blend}"`;
  if (fx) a += ` filter="url(#${pid}-fx)"`;
  return `${fx}<g${a}>${inner}</g>`;
}

/** Markup for the mask of a clipping group. */
function clipGeometry(n, ctx) {
  if (n.type === 'group') return n.children.map((c) => clipGeometry(c, ctx)).join('');
  if (n.type === 'instance' || n.type === 'repeat') return '';
  return geometry(n, ctx);
}

export function renderNode(n, ctx) {
  if (n.hidden || ctx.hide?.has(n.id)) return '';
  const ov = ctx.overrides?.[n.id];
  if (ov) { n = { ...n, ...(ov.text !== undefined ? { text: ov.text } : {}), ...(ov.fill !== undefined ? { fill: ov.fill } : {}), ...(ov.hidden !== undefined ? { hidden: ov.hidden } : {}) }; if (n.hidden) return ''; }
  const cacheable = ctx.cache && !ov;
  if (cacheable) { const c = ctx.cache.get(n); if (c !== undefined) return c; }
  let out;
  switch (n.type) {
    case 'artboard': {
      const kids = n.children.map((c) => renderNode(c, ctx)).join('');
      const cid = `${ctx.prefix}${sid(n.id)}-ab`;
      const bg = n.bg ? (() => { const { c, a } = splitColor(n.bg); return `<rect x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(n.w)}" height="${n2(n.h)}" fill="${c}"${a < 1 ? ` fill-opacity="${n2(a)}"` : ''}${ctx.ids ? ` data-abbg="${esc(n.id)}"` : ''}/>`;
      })() : (ctx.ids ? `<rect x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(n.w)}" height="${n2(n.h)}" fill="transparent" data-abbg="${esc(n.id)}"/>` : '');
      out = n.clip
        ? `<g${ctx.ids ? ` data-artboard="${esc(n.id)}"` : ''} style="isolation:isolate"><clipPath id="${cid}"><rect x="${n2(n.x)}" y="${n2(n.y)}" width="${n2(n.w)}" height="${n2(n.h)}"/></clipPath>${bg}<g clip-path="url(#${cid})">${kids}</g></g>`
        : `<g${ctx.ids ? ` data-artboard="${esc(n.id)}"` : ''} style="isolation:isolate">${bg}${kids}</g>`;
      break;
    }
    case 'group': {
      if (n.clip && n.children.length > 1) {
        const mask = n.children[n.children.length - 1];
        const cid = `${ctx.prefix}${sid(n.id)}-clip`;
        const kids = n.children.slice(0, -1).map((c) => renderNode(c, ctx)).join('');
        // The mask's own stroke (if any) draws on top, like Illustrator.
        const maskStroke = mask.stroke?.color && mask.stroke.width > 0 && !mask.hidden ? geometry(mask, ctx, ` fill="none"${strokeAttrs(mask.stroke)}`) : '';
        out = wrap(n, ctx, `<clipPath id="${cid}">${clipGeometry(mask, ctx)}</clipPath><g clip-path="url(#${cid})">${kids}</g>${maskStroke}${ctx.ids ? `<g data-id="${esc(mask.id)}">${geometry(mask, ctx, ' fill="none" stroke="transparent" stroke-width="8" vector-effect="non-scaling-stroke"')}</g>` : ''}`);
      } else out = wrap(n, ctx, n.children.map((c) => renderNode(c, ctx)).join(''));
      break;
    }
    case 'instance': {
      const sym = ctx.doc?.symbols?.find((s) => s.id === n.symbol);
      const sub = { ...ctx, ids: false, cache: null, prefix: `${ctx.prefix}${sid(n.id)}-`, overrides: n.overrides || {} };
      const inner = sym ? sym.children.map((c) => renderNode(c, sub)).join('') : '';
      out = wrap(n, ctx, `<g${isIdentity(n.t) ? '' : ` transform="${matStr(n.t)}"`}>${inner}${ctx.ids ? hitBox(sym ? null : n) : ''}</g>`);
      break;
    }
    case 'repeat': {
      let inner = '';
      for (let r = 0; r < n.rows; r++) for (let c = 0; c < n.cols; c++) {
        const k = r * n.cols + c;
        const sub = { ...ctx, ids: false, cache: null, prefix: `${ctx.prefix}${sid(n.id)}-${k}-`, overrides: n.texts?.[k] ? Object.fromEntries(Object.entries(n.texts[k]).map(([id, text]) => [id, { text }])) : null };
        inner += `<g transform="${matStr(translate(c * (n.cell.w + n.gx), r * (n.cell.h + n.gy)))}">${n.cell.children.map((x) => renderNode(x, sub)).join('')}</g>`;
      }
      const tr = isIdentity(n.t) ? '' : ` transform="${matStr(n.t)}"`;
      out = wrap(n, ctx, `<g${tr}>${inner}${ctx.ids ? `<rect width="${n2(n.cols * (n.cell.w + n.gx) - n.gx)}" height="${n2(n.rows * (n.cell.h + n.gy) - n.gy)}" fill="transparent"/>` : ''}</g>`);
      break;
    }
    default: out = wrap(n, ctx, paintLeaf(n, ctx));
  }
  if (cacheable) ctx.cache.set(n, out);
  return out;
}
const hitBox = () => '';

/** A context for renderNode. */
export function renderContext(doc, opts = {}) {
  return { doc, prefix: opts.prefix || '', ids: !!opts.ids, assetUrl: opts.assetUrl || ((id) => `/api/assets/${id}/web`), outlines: opts.outlines || null, hide: opts.hide || null, cache: opts.cache || null, overrides: null };
}

/** Standalone SVG for one artboard (or any rectangle). extraDefs is placed first (fonts). */
export function svgDocument(doc, nodes, rect, opts = {}) {
  const ctx = renderContext(doc, opts);
  const body = nodes.map((n) => renderNode(n, ctx)).join('');
  const w = opts.width || rect.w; const h = opts.height || rect.h;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n2(w)}" height="${n2(h)}" viewBox="${n2(rect.x)} ${n2(rect.y)} ${n2(rect.w)} ${n2(rect.h)}">${opts.style ? `<style>${opts.style}</style>` : ''}${body}</svg>`;
}

export { I, mul, leadingOf };
