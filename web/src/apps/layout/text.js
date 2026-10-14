// Stories (the text that flows through threaded frames) and the line breaker.
//
// A story keeps its text as one string with '\n' between paragraphs, so a caret is just an offset:
//   { text, runs: [{ n, cs, a }], paras: [{ ps, a }], frames: [itemId…] }
// runs cover the whole text (sum of n === text.length); there is one paras entry per paragraph.
// Text is measured on a canvas with the real fonts (lib/fonts.js) and broken greedily into lines,
// column by column and frame by frame, going around text-wrap objects.
import { charAttrs, paraAttrs, PAGE_NUM, LINE_BREAK, colorOf } from './model.js';

const sameAttrs = (x, y) => x.cs === y.cs && JSON.stringify(x.a || {}) === JSON.stringify(y.a || {});

/** Merges neighbouring runs that look the same and drops empty ones. */
function tidy(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.n) continue;
    const last = out[out.length - 1];
    if (last && sameAttrs(last, r)) out[out.length - 1] = { ...last, n: last.n + r.n };
    else out.push(r);
  }
  return out;
}

/** Splits runs so that a boundary falls exactly at pos. Returns [runs, index of the first run at/after pos]. */
function splitAt(runs, pos) {
  const out = [];
  let at = 0; let idx = -1;
  for (const r of runs) {
    if (idx < 0 && pos > at && pos < at + r.n) {
      out.push({ ...r, n: pos - at }); idx = out.length; out.push({ ...r, n: at + r.n - pos });
    } else {
      if (idx < 0 && pos <= at) idx = out.length;
      out.push(r);
    }
    at += r.n;
  }
  if (idx < 0) idx = out.length;
  return [out, idx];
}

export const paraCountBefore = (text, pos) => { let n = 0; for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) n++; return n; };
/** [start, end) of paragraph i (end excludes its '\n'). */
export function paraRange(story, i) {
  let s = 0; let k = 0;
  while (k < i) { const j = story.text.indexOf('\n', s); if (j < 0) break; s = j + 1; k++; }
  const e = story.text.indexOf('\n', s);
  return [s, e < 0 ? story.text.length : e];
}
export const paraAt = (story, pos) => paraCountBefore(story.text, pos);

/** The run (attributes) that applies at pos: the character before it, or the one after it at the start of a paragraph. */
export function runAt(story, pos) {
  if (!story.runs.length) return null;
  const idx = pos === 0 || story.text[pos - 1] === '\n' ? pos : pos - 1;
  let at = 0;
  for (const r of story.runs) { if (idx < at + r.n) return r; at += r.n; }
  return story.runs[story.runs.length - 1];
}

export const emptyStory = (ps = 'ps-basic', frames = []) => ({ text: '', runs: [], paras: [{ ps, a: {} }], frames });

/** Inserts plain text at pos. attrs = { cs, a } for the new characters (default: the run at pos). */
export function insertText(story, pos, str, attrs) {
  if (!str) return story;
  const base = attrs || runAt(story, pos) || { cs: null, a: {} };
  const [split, idx] = splitAt(story.runs, pos);
  split.splice(idx, 0, { n: str.length, cs: base.cs || null, a: base.a || {} });
  const pi = paraCountBefore(story.text, pos);
  const breaks = (str.match(/\n/g) || []).length;
  const paras = story.paras.slice();
  if (breaks) { const p = paras[pi]; paras.splice(pi + 1, 0, ...Array.from({ length: breaks }, () => ({ ps: p.ps, a: { ...p.a } }))); }
  return { ...story, text: story.text.slice(0, pos) + str + story.text.slice(pos), runs: tidy(split), paras };
}

/** Deletes [a, b). Paragraphs that merge keep the attributes of the first. */
export function deleteRange(story, a, b) {
  if (b <= a) return story;
  let [r1] = [story.runs];
  let i1; let i2;
  [r1, i1] = splitAt(r1, a);
  [r1, i2] = splitAt(r1, b);
  r1.splice(i1, i2 - i1);
  const p0 = paraCountBefore(story.text, a);
  const removed = (story.text.slice(a, b).match(/\n/g) || []).length;
  const paras = story.paras.slice();
  paras.splice(p0 + 1, removed);
  return { ...story, text: story.text.slice(0, a) + story.text.slice(b), runs: tidy(r1), paras };
}

/** Copies [a, b) as a fragment { text, runs, paras } (paras for each paragraph touched). */
export function sliceStory(story, a, b) {
  let [r] = splitAt(story.runs, a); let i1; let i2;
  [r, i1] = splitAt(r, a); [r, i2] = splitAt(r, b);
  const p0 = paraCountBefore(story.text, a);
  const p1 = paraCountBefore(story.text, b);
  return { text: story.text.slice(a, b), runs: r.slice(i1, i2), paras: story.paras.slice(p0, p1 + 1) };
}

/** Inserts a fragment (with its formatting) at pos. */
export function insertFragment(story, pos, frag) {
  let s = insertText(story, pos, frag.text, { cs: null, a: {} });
  // restore the fragment's runs over the inserted range
  let [r, i1] = splitAt(s.runs, pos); let i2;
  [r, i2] = splitAt(r, pos + frag.text.length);
  r.splice(i1, i2 - i1, ...frag.runs);
  s = { ...s, runs: tidy(r) };
  const p0 = paraCountBefore(s.text, pos);
  const paras = s.paras.slice();
  frag.paras.slice(1).forEach((p, k) => { paras[p0 + 1 + k] = { ...p }; });
  return { ...s, paras };
}

/** Changes character formatting of [a, b): patch merges into run.a (null removes a key); cs sets the character style. */
export function formatChars(story, a, b, { patch, cs, clear } = {}) {
  if (b <= a) return story;
  let [r] = [story.runs]; let i1; let i2;
  [r, i1] = splitAt(r, a); [r, i2] = splitAt(r, b);
  for (let i = i1; i < i2; i++) {
    let na = clear ? {} : { ...r[i].a };
    if (patch) for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined) delete na[k]; else na[k] = v; }
    r[i] = { ...r[i], a: na, ...(cs !== undefined ? { cs } : {}) };
  }
  return { ...story, runs: tidy(r) };
}

/** Changes paragraphs touched by [a, b]: patch merges into para.a; ps sets the style (clear drops overrides). */
export function formatParas(story, a, b, { patch, ps, clear } = {}) {
  const p0 = paraCountBefore(story.text, a); const p1 = paraCountBefore(story.text, b);
  const paras = story.paras.map((p, i) => {
    if (i < p0 || i > p1) return p;
    let na = clear ? {} : { ...p.a };
    if (patch) for (const [k, v] of Object.entries(patch)) { if (v === null || v === undefined) delete na[k]; else na[k] = v; }
    return { ps: ps || p.ps, a: na };
  });
  let s = { ...story, paras };
  // Applying a paragraph style with "clear overrides" also clears local character formatting.
  if (clear && ps) { const [s0] = paraRange(story, p0); const [, e1] = paraRange(story, p1); s = formatChars(s, s0, e1, { clear: true, cs: null }); }
  return s;
}

/** Character attributes that apply at a caret (for the type controls). */
export function attrsAt(doc, story, pos) {
  const pi = Math.min(paraAt(story, pos), story.paras.length - 1);
  return { char: charAttrs(doc, story.paras[pi], runAt(story, pos)), para: story.paras[pi], run: runAt(story, pos), pi };
}

/** Word boundaries around pos (double-click selection). */
export function wordAt(text, pos) {
  const isW = (c) => c && /[\p{L}\p{N}_'’-]/u.test(c);
  let a = pos; let b = pos;
  while (a > 0 && isW(text[a - 1])) a--;
  while (b < text.length && isW(text[b])) b++;
  return [a, b];
}

// ---------------------------------------------------------------- measuring

let mctx = null;
const ctx2d = () => (mctx ||= document.createElement('canvas').getContext('2d'));
const widthCache = new Map();
const metricCache = new Map();

export const fontCss = (a, size = a.size) => `${a.italic ? 'italic ' : ''}${a.weight || 400} ${size}px "${a.font}"`;
const tr = (a) => (a.tracking || 0) * a.size / 1000;

/** Width of text in a style (tracking included after every character, like canvas letterSpacing). */
export function measure(a, text) {
  if (!text) return 0;
  const key = `${fontCss(a)}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    const c = ctx2d(); c.font = fontCss(a);
    w = c.measureText(text).width;
    if (widthCache.size > 60000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w + tr(a) * [...text].length;
}
/** Ascent/descent as a fraction of the font size. */
export function fontMetrics(a) {
  const key = `${a.italic ? 'i' : 'n'}${a.weight}|${a.font}`;
  let m = metricCache.get(key);
  if (!m) {
    const c = ctx2d(); c.font = fontCss(a, 100);
    const t = c.measureText('Hxgjpy');
    m = { asc: (t.fontBoundingBoxAscent || 80) / 100, desc: (t.fontBoundingBoxDescent || 20) / 100, cap: (c.measureText('H').actualBoundingBoxAscent || 70) / 100 };
    metricCache.set(key, m);
  }
  return m;
}
/** Forget measurements (after fonts finish loading). */
let fontGen = 0;
export const measureGeneration = () => fontGen;
export function clearMeasureCache() { widthCache.clear(); metricCache.clear(); fontGen++; }

export const leadingOf = (a) => (a.leading == null ? a.size * 1.2 : a.leading);
const display = (a, s) => (a.caps ? s.toUpperCase() : s);

// ---------------------------------------------------------------- tokenising a paragraph

// Tokens: { k: 'w' (word piece group) | 's' (space) | 't' (tab) | 'br' (forced break), pieces: [{ text, src, start, a, w }], w }
function tokenize(doc, story, pi, start, end, pageNo) {
  const para = story.paras[pi];
  const tokens = [];
  // walk the runs overlapping [start, end)
  const segs = [];
  let at = 0;
  for (const r of story.runs) {
    const s = Math.max(at, start); const e = Math.min(at + r.n, end);
    if (e > s) segs.push({ s, e, a: charAttrs(doc, para, r) });
    at += r.n;
    if (at >= end) break;
  }
  let word = null;
  const flush = () => { if (word) { word.w = word.pieces.reduce((n, p) => n + p.w, 0); tokens.push(word); word = null; } };
  for (const seg of segs) {
    let i = seg.s;
    while (i < seg.e) {
      const c = story.text[i];
      if (c === ' ' || c === '\t' || c === LINE_BREAK) {
        flush();
        const k = c === ' ' ? 's' : c === '\t' ? 't' : 'br';
        const w = k === 's' ? measure(seg.a, ' ') : 0;
        tokens.push({ k, w, pieces: [{ text: k === 's' ? ' ' : '', src: 1, start: i, a: seg.a, w }] });
        i++;
        continue;
      }
      // a word piece: up to the next space or the end of this run (a hyphen ends a word so lines can break after it)
      let j = i;
      while (j < seg.e && !/[ \t\u2028]/.test(story.text[j]) && story.text[j] !== PAGE_NUM) { j++; if (story.text[j - 1] === '-' || story.text[j - 1] === '—') break; }
      if (j === i && story.text[i] === PAGE_NUM) {
        word ||= { k: 'w', pieces: [] };
        const t = String(pageNo ?? '#');
        word.pieces.push({ text: t, src: 1, start: i, a: seg.a, w: measure(seg.a, t), special: true });
        i++;
        continue;
      }
      const raw = story.text.slice(i, j);
      word ||= { k: 'w', pieces: [] };
      word.pieces.push({ text: display(seg.a, raw), src: raw.length, start: i, a: seg.a, w: measure(seg.a, display(seg.a, raw)) });
      i = j;
      if (/[-—]$/.test(raw)) flush();
    }
  }
  flush();
  return tokens;
}

/** Splits an over-long word token so that its first part fits in width (emergency break). */
function splitToken(tok, width) {
  const pieces = []; let used = 0;
  for (let pi = 0; pi < tok.pieces.length; pi++) {
    const p = tok.pieces[pi];
    if (used + p.w <= width) { pieces.push(p); used += p.w; continue; }
    if (p.special) break;
    let k = 0;
    while (k < p.text.length && used + measure(p.a, p.text.slice(0, k + 1)) <= width) k++;
    if (!k && !pieces.length) k = 1; // always place at least one character
    if (k) {
      const head = { ...p, text: p.text.slice(0, k), src: k, w: measure(p.a, p.text.slice(0, k)) };
      const tail = { ...p, text: p.text.slice(k), src: p.src - k, start: p.start + k, w: measure(p.a, p.text.slice(k)) };
      pieces.push(head);
      const rest = [tail, ...tok.pieces.slice(pi + 1)];
      return [{ k: 'w', pieces, w: pieces.reduce((n, x) => n + x.w, 0) }, { k: 'w', pieces: rest, w: rest.reduce((n, x) => n + x.w, 0) }];
    }
    break;
  }
  const rest = tok.pieces.slice(pieces.length);
  return [{ k: 'w', pieces, w: used }, rest.length ? { k: 'w', pieces: rest, w: rest.reduce((n, x) => n + x.w, 0) } : null];
}

// ---------------------------------------------------------------- the line breaker

/**
 * Lays a story out through its frames.
 *   frames: [{ id, w, h, cols, gutter, inset, pageNo, excl: [{ x, y, w, h, jump }] }] in thread order (frame-relative exclusions)
 * Returns { frames: { [id]: { lines } }, overset, end } where each line is
 *   { x, y (baseline), w (slot width), top, bottom, start, end, pi, pieces: [{ x, text, a, start, src, w }], last, drop? }
 */
export function layoutStory(doc, story, frames) {
  const out = { frames: {}, overset: false, end: 0 };
  const text = story.text;
  const pcount = story.paras.length;
  let pi = 0;
  let tokens = null; let ti = 0; let lineInPara = 0; let paraStart = 0; let paraEnd = 0; let pa = null; let dropW = 0; let dropPiece = null; let pendingTok = null;
  let paraFirstAttrs = null;

  const startPara = (pageNo) => {
    [paraStart, paraEnd] = paraRange(story, pi);
    pa = paraAttrs(doc, story.paras[pi]);
    paraFirstAttrs = charAttrs(doc, story.paras[pi], runAt(story, paraStart + (paraEnd > paraStart ? 1 : 0)) || null);
    tokens = tokenize(doc, story, pi, paraStart, paraEnd, pageNo);
    ti = 0; lineInPara = 0; pendingTok = null; dropW = 0; dropPiece = null;
    // Drop cap: the first characters, big enough to span dropLines lines.
    if (pa.dropLines >= 2 && tokens.length && tokens[0].k === 'w') {
      const t0 = tokens[0];
      const p0 = t0.pieces[0];
      const n = Math.min(pa.dropChars || 1, p0.src);
      const a = p0.a;
      const m = fontMetrics(a);
      const lead = leadingOf(a);
      const capSize = (m.cap * a.size + (pa.dropLines - 1) * lead) / m.cap;
      const da = { ...a, size: capSize, tracking: 0 };
      const dtext = p0.text.slice(0, n);
      dropPiece = { text: dtext, src: n, start: p0.start, a: da, w: measure(da, dtext), lines: pa.dropLines };
      dropW = dropPiece.w + a.size * 0.2;
      const rest = { ...p0, text: p0.text.slice(n), src: p0.src - n, start: p0.start + n, w: measure(a, p0.text.slice(n)) };
      const pieces = rest.src > 0 ? [rest, ...t0.pieces.slice(1)] : t0.pieces.slice(1);
      tokens[0] = { k: 'w', pieces, w: pieces.reduce((s, x) => s + x.w, 0) };
      if (!pieces.length) tokens.shift();
    }
  };

  let frameIdx = 0;
  let firstFrameLine = true;
  for (const fr of frames) {
    const lines = [];
    out.frames[fr.id] = { lines };
    if (pi >= pcount) { frameIdx++; continue; }
    const inset = fr.inset || 0;
    const cols = Math.max(1, fr.cols || 1);
    const gutter = fr.gutter ?? 12;
    const innerW = fr.w - inset * 2;
    const colW = (innerW - gutter * (cols - 1)) / cols;
    const bottom = fr.h - inset;
    for (let c = 0; c < cols && pi < pcount; c++) {
      const cx = inset + c * (colW + gutter);
      let y = inset; // top of the next line
      let firstInCol = true;
      let prevBaseline = null;
      while (pi < pcount) {
        if (!tokens) {
          startPara(fr.pageNo);
          if (!firstInCol) { y += pa.spaceBefore; if (prevBaseline !== null) prevBaseline += pa.spaceBefore; }
        }
        // line height from the first characters on the line (refined once after fitting)
        const peekA = (pendingTok || tokens[ti])?.pieces?.[0]?.a || paraFirstAttrs;
        let lead = leadingOf(peekA); let asc = fontMetrics(peekA).asc * peekA.size; let desc = fontMetrics(peekA).desc * peekA.size;
        let attempt = 0; let placed = null;
        while (attempt < 3) {
          const baseline = prevBaseline === null ? y + asc : Math.max(prevBaseline + lead, y + asc);
          const top = baseline - asc; const bot = baseline + desc;
          if (bot > bottom + 0.01) { placed = 'nofit'; break; }
          // available slots across the column at this band
          const slots = freeSlots(cx, cx + colW, top, bot, fr.excl);
          if (!slots.length) {
            // jump below the obstacle
            const next = Math.min(...fr.excl.filter((e) => e.y + e.h > top && e.y < bot).map((e) => e.y + e.h));
            if (!Number.isFinite(next) || next <= y) { placed = 'nofit'; break; }
            y = next; prevBaseline = null; attempt = 0; continue;
          }
          // widest slot wins (bounding-box wrap flows into the larger side)
          const slot = slots.reduce((m, s) => (s[1] - s[0] > m[1] - m[0] ? s : m));
          const indL = pa.indentL + (lineInPara === 0 ? pa.firstIndent : 0) + (dropPiece && lineInPara < dropPiece.lines ? dropW : 0);
          const avail = slot[1] - slot[0] - indL - pa.indentR;
          const fit = fitLine(tokens, ti, pendingTok, Math.max(4, avail));
          // actual line metrics
          let L = 0; let A = 0; let D = 0;
          for (const t of fit.tokens) for (const p of t.pieces) { L = Math.max(L, leadingOf(p.a)); const m = fontMetrics(p.a); A = Math.max(A, m.asc * p.a.size + Math.max(0, p.a.baseline || 0)); D = Math.max(D, m.desc * p.a.size); }
          if (!fit.tokens.length) { L = lead; A = asc; D = desc; }
          if ((L > lead + 0.01 || A > asc + 0.01) && attempt < 2) { lead = Math.max(L, lead); asc = Math.max(A, asc); desc = Math.max(D, desc); attempt++; continue; }
          placed = { baseline, slot, indL, avail, fit, top, bot: baseline + Math.max(D, desc) };
          break;
        }
        if (placed === 'nofit' || !placed) break; // column full: continue in the next column / frame
        const { baseline, slot, indL, avail, fit } = placed;
        const isLast = fit.endsPara;
        const lineStart = fit.tokens[0]?.pieces[0]?.start ?? (tokens[ti]?.pieces[0]?.start ?? paraEnd);
        // positions
        const content = trimTrailing(fit.tokens);
        const natural = content.reduce((n, t) => n + t.w, 0);
        const extra = avail - natural;
        let x = slot[0] + indL;
        let spaceAdd = 0;
        const align = pa.align;
        if (align === 'center') x += extra / 2;
        else if (align === 'right') x += extra;
        else if ((align === 'justify' && !isLast && !fit.forced) || align === 'justify-all') {
          const spaces = content.filter((t) => t.k === 's').length;
          if (spaces && extra > 0) spaceAdd = extra / spaces;
        }
        const pieces = [];
        for (const t of fit.tokens) {
          if (t.k === 't') { // tabs jump to the next 36pt stop
            const rel = x - slot[0];
            const nx = slot[0] + (Math.floor(rel / 36) + 1) * 36;
            pieces.push({ ...t.pieces[0], x, w: nx - x });
            x = nx; continue;
          }
          for (const p of t.pieces) {
            const w = p.w + (t.k === 's' && content.includes(t) ? spaceAdd : 0);
            pieces.push({ ...p, x, w });
            x += w;
          }
        }
        let end = fit.endPos ?? (pieces.length ? pieces[pieces.length - 1].start + pieces[pieces.length - 1].src : lineStart);
        if (isLast) end = paraEnd;
        const line = { x: slot[0] + indL, y: baseline, w: avail, top: placed.top, bottom: placed.bot, start: Math.min(lineStart, end), end, pi, pieces, last: isLast, col: c, lead };
        if (dropPiece && lineInPara === 0) line.drop = { ...dropPiece, x: slot[0] + pa.indentL, y: baseline + (dropPiece.lines - 1) * lead };
        if (dropPiece && lineInPara === 0) line.start = dropPiece.start;
        lines.push(line);
        firstInCol = false; firstFrameLine = false;
        prevBaseline = baseline; y = placed.bot;
        lineInPara++;
        ti = fit.ti; pendingTok = fit.pending;
        if (isLast) {
          y = baseline + Math.max(desc, 0) + pa.spaceAfter;
          prevBaseline = baseline + pa.spaceAfter;
          pi++; tokens = null;
          out.end = paraEnd + 1;
        } else {
          out.end = end;
        }
      }
    }
    frameIdx++;
  }
  if (pi < pcount) out.overset = true;
  out.end = Math.min(out.end, text.length);
  return out;
}

const trimTrailing = (toks) => { let k = toks.length; while (k && (toks[k - 1].k === 's' || toks[k - 1].k === 'br')) k--; return toks.slice(0, k); };

/** Free x-intervals of [x0, x1] for a band [top, bot] after removing exclusion rectangles. */
function freeSlots(x0, x1, top, bot, excl) {
  let slots = [[x0, x1]];
  for (const e of excl || []) {
    if (e.y >= bot || e.y + e.h <= top) continue;
    if (e.jump) return [];
    const next = [];
    for (const [a, b] of slots) {
      if (e.x >= b || e.x + e.w <= a) { next.push([a, b]); continue; }
      if (e.x > a) next.push([a, e.x]);
      if (e.x + e.w < b) next.push([e.x + e.w, b]);
    }
    slots = next;
  }
  return slots.filter(([a, b]) => b - a >= 18);
}

/** Greedy fit: takes tokens from ti while they fit in width. */
function fitLine(tokens, ti, pending, width) {
  const taken = [];
  let w = 0; let i = ti; let pend = pending;
  let forced = false;
  while (true) {
    const t = pend || tokens[i];
    if (!t) break;
    if (t.k === 'br') { taken.push(t); if (!pend) i++; pend = null; forced = true; break; }
    if (t.k === 's' || t.k === 't') { taken.push(t); w += t.k === 't' ? 36 : t.w; if (pend) pend = null; else i++; continue; }
    if (w + t.w <= width + 0.01) { taken.push(t); w += t.w; if (pend) pend = null; else i++; continue; }
    // doesn't fit
    if (!trimTrailing(taken).length) {
      // a single word wider than the line: break it
      const [head, tail] = splitToken(t, width - w);
      taken.push(head);
      if (pend) pend = tail; else { i++; pend = tail; }
    }
    break;
  }
  // swallow spaces after the last word so the next line doesn't start with one
  while (!pend && tokens[i] && tokens[i].k === 's' && !forced) { taken.push(tokens[i]); i++; }
  const endsPara = !pend && i >= tokens.length;
  const lastP = taken.length ? taken[taken.length - 1].pieces[taken[taken.length - 1].pieces.length - 1] : null;
  return { tokens: taken, ti: i, pending: pend, endsPara, forced, endPos: lastP ? lastP.start + lastP.src : undefined };
}

// ---------------------------------------------------------------- caret geometry

/** x of the caret at pos within a line (frame-relative). */
export function caretX(line, pos) {
  if (line.drop && pos <= line.drop.start + line.drop.src) return pos <= line.drop.start ? line.drop.x : line.x;
  for (const p of line.pieces) {
    if (pos >= p.start && pos < p.start + p.src) {
      if (p.special || !p.text) return p.x + (pos > p.start ? p.w : 0);
      const k = pos - p.start;
      return p.x + (k ? measure(p.a, p.text.slice(0, k)) : 0);
    }
  }
  const last = line.pieces[line.pieces.length - 1];
  if (!last) return line.x;
  if (last.text === '' || (last.text === ' ' && pos >= last.start + last.src && line.last === false)) return last.x + (pos > last.start ? last.w : 0);
  return last.x + last.w;
}

/** Text offset nearest to x within a line. */
export function posAtX(line, x) {
  if (line.drop && x < line.x) return line.drop.start;
  let best = line.start; let bd = Infinity;
  for (const p of line.pieces) {
    for (let k = 0; k <= p.src; k++) {
      const cx = p.special || !p.text ? p.x + (k ? p.w : 0) : p.x + (k ? measure(p.a, p.text.slice(0, k)) : 0);
      const d = Math.abs(cx - x);
      if (d < bd) { bd = d; best = p.start + k; }
    }
  }
  if (!line.pieces.length) return line.start;
  // the caret can't sit after a line's trailing space unless it's the paragraph end
  if (!line.last && best >= line.end && line.end > line.start) best = Math.min(best, line.end - (/[ ]$/.test(line.pieces[line.pieces.length - 1].text) ? 1 : 0));
  return Math.max(line.start, Math.min(best, line.end));
}

// ---------------------------------------------------------------- drawing

/** Draws laid-out lines of one frame onto a 2D context (already translated to the frame's top-left, in points). */
export function drawLines(ctx, doc, lines, sel) {
  for (const line of lines) {
    if (sel) {
      // selection highlight behind the text
      const a = Math.max(sel[0], line.start); const b = Math.min(sel[1], line.end + (line.last ? 0 : 0));
      if (b > a || (sel[0] <= line.end && sel[1] > line.end && line.last)) {
        const x1 = caretX(line, a); const x2 = b > a ? caretX(line, b) : x1;
        const extraEnd = sel[1] > line.end && line.last ? 4 : 0;
        ctx.fillStyle = 'rgba(80,150,255,.35)';
        ctx.fillRect(x1, line.top, Math.max(1, x2 - x1 + extraEnd), line.bottom - line.top);
      }
    }
    if (line.drop) drawPiece(ctx, doc, { ...line.drop, x: line.drop.x }, line.drop.y);
    for (const p of line.pieces) if (p.text && p.text !== ' ') drawPiece(ctx, doc, p, line.y);
    // underline / strike through spaces too
    for (const p of line.pieces) if (p.text === ' ' && (p.a.underline || p.a.strike)) decorate(ctx, doc, p, line.y);
  }
}
function drawPiece(ctx, doc, p, baseline) {
  const a = p.a;
  ctx.font = fontCss(a);
  ctx.letterSpacing = `${tr(a)}px`;
  ctx.fillStyle = colorOf(doc, a.color) || '#000';
  ctx.fillText(p.text, p.x, baseline - (a.baseline || 0));
  decorate(ctx, doc, p, baseline);
}
function decorate(ctx, doc, p, baseline) {
  const a = p.a;
  if (!a.underline && !a.strike) return;
  ctx.fillStyle = colorOf(doc, a.color) || '#000';
  const t = Math.max(0.5, a.size / 18);
  if (a.underline) ctx.fillRect(p.x, baseline + a.size * 0.12, p.w, t);
  if (a.strike) ctx.fillRect(p.x, baseline - a.size * 0.3, p.w, t);
}
