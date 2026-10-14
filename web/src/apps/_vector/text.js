// Text layout for the vector engine. Lines are measured with a canvas using the real fonts (loaded on demand),
// so the editor, bounds, SVG/PNG/PDF export and outlines all agree on where lines break and sit.
import { ensureFont } from '../../lib/fonts.js';

export const DEFAULT_FONT = { family: 'Inter', weight: 400, style: 'normal', size: 36, tracking: 0, leading: 0, align: 'left' };
export const fontOf = (n) => ({ ...DEFAULT_FONT, ...(n.font || {}) });
export const leadingOf = (f) => f.leading || Math.round(f.size * 1.2 * 100) / 100;
export const cssFont = (f) => `${f.style === 'italic' ? 'italic ' : ''}${f.weight} ${f.size}px "${f.family}"`;

// ---------------------------------------------------------------- font loading (re-layout when a font arrives)

const listeners = new Set();
const requested = new Set();
let fontVersion = 0;
export const onFontsChanged = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getFontVersion = () => fontVersion;
/** Asks for a font; when it finishes loading, cached layouts are dropped and listeners re-render. */
export function requestFont(f) {
  const key = `${f.family}|${f.weight}|${f.style}`;
  if (requested.has(key)) return;
  requested.add(key);
  ensureFont(f.family, f.weight, f.style).then((ok) => { if (ok) { fontVersion++; cache.clear(); listeners.forEach((fn) => fn()); } });
}
/** Loads every font used by nodes (export waits for this). */
export async function loadFonts(nodes) {
  const seen = new Map();
  const walk = (list) => { for (const n of list || []) { if (n.type === 'text') { const f = fontOf(n); seen.set(`${f.family}|${f.weight}|${f.style}`, f); } walk(n.children); } };
  walk(nodes);
  await Promise.all([...seen.values()].map((f) => ensureFont(f.family, f.weight, f.style)));
  cache.clear();
}

// ---------------------------------------------------------------- measuring

let ctx = null;
const measureCtx = () => (ctx ||= document.createElement('canvas').getContext('2d'));
function measurer(f) {
  const c = measureCtx();
  c.font = cssFont(f);
  const track = (f.tracking * f.size) / 1000;
  const m = c.measureText('Hgjy');
  const ascent = m.fontBoundingBoxAscent ?? f.size * 0.8;
  const descent = m.fontBoundingBoxDescent ?? f.size * 0.2;
  return { width: (s) => (s.length ? c.measureText(s).width + track * s.length : 0), ascent, descent };
}

const cache = new Map();
/**
 * Lays out a text node in its local space (origin top-left). Returns
 * { lines: [{ text, x, y (baseline), w }], w, h, anchor, ax } — anchor/ax say how each tspan is anchored (SVG text-anchor).
 */
export function layoutText(n) {
  const f = fontOf(n);
  requestFont(f);
  const key = `${n.text}\u0001${cssFont(f)}|${f.tracking}|${f.leading}|${f.align}|${n.mode}|${n.w}|${n.h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const M = measurer(f);
  const lead = leadingOf(f);
  const raw = String(n.text ?? '').split('\n');
  let lines = [];
  if (n.mode === 'area' && n.w > 0) {
    for (const para of raw) {
      const words = para.split(/(\s+)/);
      let cur = '';
      for (const w of words) {
        const next = cur + w;
        if (cur && M.width(next.trimEnd()) > n.w && w.trim()) { lines.push(cur.trimEnd()); cur = w.trimStart(); }
        else cur = next;
        // A single word longer than the box: break it by characters.
        while (M.width(cur) > n.w && cur.length > 1) {
          let k = cur.length - 1;
          while (k > 1 && M.width(cur.slice(0, k)) > n.w) k--;
          lines.push(cur.slice(0, k)); cur = cur.slice(k);
        }
      }
      lines.push(cur.trimEnd());
    }
  } else lines = raw;
  const widths = lines.map((s) => M.width(s));
  const maxW = Math.max(1, ...widths);
  const boxW = n.mode === 'area' ? n.w : maxW;
  const top = (lead - (M.ascent + M.descent)) / 2 + M.ascent;
  const anchor = f.align === 'center' ? 'middle' : f.align === 'right' ? 'end' : 'start';
  const ax = anchor === 'middle' ? boxW / 2 : anchor === 'end' ? boxW : 0;
  const out = {
    lines: lines.map((s, i) => ({ text: s, y: top + i * lead, w: widths[i], x: anchor === 'middle' ? ax - widths[i] / 2 : anchor === 'end' ? ax - widths[i] : 0 })),
    w: boxW, h: n.mode === 'area' ? Math.max(n.h || 0, lines.length * lead) : Math.max(lead, lines.length * lead), anchor, ax, lead, ascent: M.ascent,
  };
  if (cache.size > 2000) cache.clear();
  cache.set(key, out);
  return out;
}
