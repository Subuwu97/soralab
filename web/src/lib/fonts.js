// Fonts: open-licence families bundled with SoraLab, plus fonts the person uploaded (Fonts page).
//
//   await ensureFont('Montserrat', 700, 'normal')   load before drawing text on a canvas
//   const buf = await fontData('Lora', 400)         the font file (ArrayBuffer) for PDF/SVG export or opentype.js
//   useFonts()                                      [{ family, weights: [..], styles: [..], source: 'builtin'|'mine', category }]
import { useEffect, useState } from 'react';
import { api } from './api.js';

// Latin WOFF files of the bundled families, loaded only when used.
const FILES = import.meta.glob('/node_modules/@fontsource/*/files/*-latin-*.woff', { query: '?url', import: 'default' });

export const BUILTIN = [
  { family: 'Inter', pkg: 'inter', category: 'Sans serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  { family: 'Montserrat', pkg: 'montserrat', category: 'Sans serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  { family: 'Poppins', pkg: 'poppins', category: 'Sans serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  { family: 'Roboto', pkg: 'roboto', category: 'Sans serif', weights: [100, 300, 400, 500, 700, 900], italic: true },
  { family: 'Noto Sans', pkg: 'noto-sans', category: 'Sans serif', weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], italic: true },
  { family: 'Oswald', pkg: 'oswald', category: 'Display', weights: [200, 300, 400, 500, 600, 700], italic: false },
  { family: 'Bebas Neue', pkg: 'bebas-neue', category: 'Display', weights: [400], italic: false },
  { family: 'Orbitron', pkg: 'orbitron', category: 'Display', weights: [400, 500, 600, 700, 800, 900], italic: false },
  { family: 'Playfair Display', pkg: 'playfair-display', category: 'Serif', weights: [400, 500, 600, 700, 800, 900], italic: true },
  { family: 'Lora', pkg: 'lora', category: 'Serif', weights: [400, 500, 600, 700], italic: true },
  { family: 'Merriweather', pkg: 'merriweather', category: 'Serif', weights: [300, 400, 700, 900], italic: true },
  { family: 'Dancing Script', pkg: 'dancing-script', category: 'Script', weights: [400, 500, 600, 700], italic: false },
  { family: 'Pacifico', pkg: 'pacifico', category: 'Script', weights: [400], italic: false },
  { family: 'Source Code Pro', pkg: 'source-code-pro', category: 'Monospace', weights: [200, 300, 400, 500, 600, 700, 800, 900], italic: true },
];
const builtinByFamily = Object.fromEntries(BUILTIN.map((f) => [f.family.toLowerCase(), f]));

const nearest = (list, w) => list.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a), list[0]);

function builtinFile(f, weight, style) {
  const w = nearest(f.weights, weight);
  const st = style === 'italic' && f.italic ? 'italic' : 'normal';
  const key = Object.keys(FILES).find((k) => k.includes(`/@fontsource/${f.pkg}/files/`) && k.endsWith(`-latin-${w}-${st}.woff`))
    || Object.keys(FILES).find((k) => k.includes(`/@fontsource/${f.pkg}/files/`) && k.endsWith(`-latin-${w}-normal.woff`));
  return key ? FILES[key]() : null;
}

let mine = null;
/** The person's uploaded fonts (cached). */
export async function myFonts(force) {
  if (!mine || force) mine = api.get('/api/fonts').catch(() => []);
  return mine;
}

const loaded = new Map();
/** Makes a family/weight/style available to canvas and CSS. Resolves when ready (or when it can't be found). */
export function ensureFont(family, weight = 400, style = 'normal') {
  const key = `${family}|${weight}|${style}`;
  if (loaded.has(key)) return loaded.get(key);
  const p = (async () => {
    const url = await fontUrl(family, weight, style);
    if (!url) return false;
    try {
      const face = new FontFace(family, `url(${url})`, { weight: String(weight), style });
      await face.load();
      document.fonts.add(face);
      return true;
    } catch { return false; }
  })();
  loaded.set(key, p);
  return p;
}

/** URL of the font file that best matches (bundled or uploaded), or null for system fonts. */
export async function fontUrl(family, weight = 400, style = 'normal') {
  const f = builtinByFamily[String(family).toLowerCase()];
  if (f) return builtinFile(f, weight, style);
  const list = (await myFonts()).filter((x) => x.family.toLowerCase() === String(family).toLowerCase());
  if (!list.length) return null;
  const sameStyle = list.filter((x) => x.style === style);
  const pool = sameStyle.length ? sameStyle : list;
  return pool.reduce((a, b) => (Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a)).url;
}

/** The font file's bytes (for embedding in PDFs or turning text into outlines). */
export async function fontData(family, weight = 400, style = 'normal') {
  const url = await fontUrl(family, weight, style);
  if (!url) return null;
  const r = await fetch(url, { credentials: 'same-origin' });
  return r.ok ? r.arrayBuffer() : null;
}

/** Every family you can pick: bundled ones, then yours. */
export function useFonts() {
  const [list, setList] = useState(() => BUILTIN.map((f) => ({ family: f.family, weights: f.weights, italic: f.italic, category: f.category, source: 'builtin' })));
  useEffect(() => {
    let off = false;
    myFonts().then((fonts) => {
      if (off) return;
      const groups = {};
      for (const f of fonts) (groups[f.family] ||= { family: f.family, weights: [], italic: false, category: 'Your fonts', source: 'mine' }).weights.push(f.weight);
      for (const f of fonts) if (f.style === 'italic') groups[f.family].italic = true;
      const yours = Object.values(groups).map((g) => ({ ...g, weights: [...new Set(g.weights)].sort((a, b) => a - b) }));
      setList([...yours, ...BUILTIN.map((f) => ({ family: f.family, weights: f.weights, italic: f.italic, category: f.category, source: 'builtin' }))]);
    });
    return () => { off = true; };
  }, []);
  return list;
}

export const WEIGHT_NAMES = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };
