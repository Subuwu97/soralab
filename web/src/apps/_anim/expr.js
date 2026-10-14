// Expressions-lite: a tiny, safe expression language for properties (no eval / new Function).
//
//   wiggle(2, 30)            random smooth motion: 2 wiggles a second, up to 30 units
//   loopOut()                repeat the keyframes ('cycle' | 'pingpong' | 'offset' | 'continue')
//   time * 90                spin 90° a second;   value + [0, Math.sin(time * 4) * 20]
//   x = time * 2; [x, x]     statements separated by ';' with simple assignments; the last one is the result
//
// Numbers and arrays mix element-wise (+ - * / %). Colours arrive as [r, g, b, a] in 0..1.
// Names: time, value, index, fps, frame, PI, E, thisComp (width/height/duration). Math.* functions work with or without "Math.".
import { colorArr, arrColor } from './keyframes.js';

// ---------------------------------------------------------------- tokenizer + parser (Pratt)

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new Error(`Unexpected "${c}"`);
      out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      out.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    if (c === '"' || c === "'") {
      const j = src.indexOf(c, i + 1);
      if (j < 0) throw new Error('Unclosed string');
      out.push({ t: 'str', v: src.slice(i + 1, j) }); i = j + 1; continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/%()[],;=<>?:.!'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected "${c}"`);
  }
  return out;
}

const BIN = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

function parseProgram(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };

  function primary() {
    const tk = toks[p++];
    if (!tk) throw new Error('Unexpected end');
    if (tk.t === 'num') return { k: 'num', v: tk.v };
    if (tk.t === 'str') return { k: 'str', v: tk.v };
    if (tk.t === 'op' && tk.v === '(') { const e = expr(0); expect(')'); return e; }
    if (tk.t === 'op' && tk.v === '[') {
      const items = [];
      if (!isOp(']')) { do { items.push(expr(0)); } while (isOp(',') && ++p); }
      expect(']');
      return { k: 'arr', items };
    }
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+' || tk.v === '!')) return { k: 'un', op: tk.v, a: unary() };
    if (tk.t === 'id') {
      let name = tk.v;
      while (isOp('.') && toks[p + 1]?.t === 'id') { p++; name += `.${toks[p++].v}`; } // Math.sin, thisComp.width
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) { do { args.push(expr(0)); } while (isOp(',') && ++p); }
        expect(')');
        return { k: 'call', name, args };
      }
      return { k: 'id', name };
    }
    throw new Error(`Unexpected "${tk.v}"`);
  }
  function unary() {
    let e = primary();
    while (isOp('[')) { p++; const i = expr(0); expect(']'); e = { k: 'idx', a: e, i }; }
    return e;
  }
  function expr(minPrec) {
    let left = unary();
    for (;;) {
      const tk = peek();
      if (!tk || tk.t !== 'op') break;
      if (tk.v === '?' && minPrec === 0) { p++; const a = expr(0); expect(':'); const b = expr(0); left = { k: 'tern', c: left, a, b }; continue; }
      const prec = BIN[tk.v];
      if (!prec || prec <= minPrec - 1 || prec < minPrec) break;
      p++;
      left = { k: 'bin', op: tk.v, a: left, b: expr(prec + 1) };
    }
    return left;
  }
  const stmts = [];
  while (p < toks.length) {
    if (isOp(';')) { p++; continue; }
    if (toks[p].t === 'id' && toks[p + 1]?.t === 'op' && toks[p + 1].v === '=' && !(toks[p + 2]?.t === 'op' && toks[p + 2].v === '=')) {
      const name = toks[p].v; p += 2;
      stmts.push({ k: 'set', name, e: expr(0) });
    } else stmts.push(expr(0));
    if (p < toks.length && !isOp(';')) throw new Error(`Unexpected "${toks[p].v}"`);
  }
  if (!stmts.length) throw new Error('Empty expression');
  return stmts;
}

// ---------------------------------------------------------------- noise (deterministic)

function hash(n) { // integer → 0..1
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
export const seedOf = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h | 0; };
/** Smooth 1-D gradient noise in -1..1. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x); const f = x - i;
  const g0 = hash(i * 374761393 + seed) * 2 - 1; const g1 = hash((i + 1) * 374761393 + seed) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return (g0 * f * (1 - u) + g1 * (f - 1) * u) * 2;
}
export function rand(seed, n) { return hash(seed * 31 + n * 7919); }

// ---------------------------------------------------------------- evaluation

const map2 = (a, b, f) => {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => f(x, b[i] ?? 0));
  if (Array.isArray(a)) return a.map((x) => f(x, b));
  if (Array.isArray(b)) return b.map((y) => f(a, y));
  return f(a, b);
};
const num = (v) => (Array.isArray(v) ? v[0] : Number(v) || 0);
const OPS = { '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => (b === 0 ? 0 : a / b), '%': (a, b) => (b === 0 ? 0 : a % b) };

const MATH = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2, abs: Math.abs, floor: Math.floor,
  ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log, min: Math.min, max: Math.max, sign: Math.sign,
};

function loop(env, type, n, out) {
  const k = env.prop?.k;
  if (!k || k.length < 2) return env.value;
  const t = env.time;
  const lastI = k.length - 1;
  const firstI = n > 0 ? Math.max(0, lastI - n) : 0;
  const a = k[out ? firstI : 0].t; const b = k[out ? lastI : Math.min(lastI, n > 0 ? n : lastI)].t;
  const dur = b - a;
  if (dur <= 0 || (out ? t <= b : t >= a)) return env.value;
  const va = env.keyed(a); const vb = env.keyed(b);
  if (type === 'continue') {
    const e = out ? b : a; const d = 1 / (env.fps || 30);
    const vel = map2(env.keyed(out ? e : e + d), env.keyed(out ? e - d : e), (x, y) => (x - y) / d);
    return map2(out ? vb : va, map2(vel, t - e, (x, y) => x * y), (x, y) => x + y);
  }
  const rel = out ? t - a : b - t;
  const cycle = Math.floor(rel / dur);
  let f = rel - cycle * dur;
  if (type === 'pingpong' && cycle % 2 === 1) f = dur - f;
  const v = env.keyed(out ? a + f : b - f);
  if (type === 'offset') return map2(v, map2(vb, va, (x, y) => (x - y) * (out ? cycle : -cycle)), (x, y) => x + y);
  return v;
}

function call(name, args, env) {
  const fn = name.replace(/^Math\./, '');
  const a = args;
  switch (fn) {
    case 'wiggle': {
      const freq = num(a[0]); const amp = a[1] ?? 0; const oct = Math.max(1, Math.min(8, Math.round(num(a[2] ?? 1)))); const mult = num(a[3] ?? 0.5);
      const t = a[4] !== undefined ? num(a[4]) : env.time;
      const base = env.value;
      const dims = Array.isArray(base) ? base.length : 1;
      const off = [];
      for (let d = 0; d < dims; d++) {
        let s = 0; let ampK = 1; let fr = freq; let norm = 0;
        for (let o = 0; o < oct; o++) { s += noise1(t * fr, (env.seed || 0) + d * 1013 + o * 7) * ampK; norm += ampK; ampK *= mult; fr *= 2; }
        off.push((s / Math.max(1, norm)) * (Array.isArray(amp) ? amp[d] ?? 0 : num(amp)));
      }
      return Array.isArray(base) ? base.map((x, d) => x + off[d]) : base + off[0];
    }
    case 'loopOut': return loop(env, a[0] || 'cycle', num(a[1] ?? 0), true);
    case 'loopIn': return loop(env, a[0] || 'cycle', num(a[1] ?? 0), false);
    case 'linear': case 'ease': {
      if (a.length === 3) a.splice(1, 0, 0, 1); // linear(t, v1, v2) → t in 0..1
      const t = num(a[0]); const t0 = num(a[1]); const t1 = num(a[2]);
      let x = t1 === t0 ? 1 : Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
      if (fn === 'ease') x = x * x * (3 - 2 * x);
      return map2(a[3], a[4], (p, q) => p + (q - p) * x);
    }
    case 'clamp': return map2(map2(a[0], a[1], Math.max), a[2], Math.min);
    case 'random': { // changes every frame, the same every render
      const r = rand((env.seed || 0) + (env.randCount = (env.randCount || 0) + 1) * 101, Math.round(env.time * (env.fps || 30)));
      if (a.length === 0) return r;
      if (a.length === 1) return map2(a[0], r, (m, x) => m * x);
      return map2(a[0], a[1], (lo, hi) => lo + (hi - lo) * r);
    }
    case 'noise': return noise1(num(a[0]), env.seed || 0);
    case 'degreesToRadians': return map2(a[0], Math.PI / 180, (x, y) => x * y);
    case 'radiansToDegrees': return map2(a[0], 180 / Math.PI, (x, y) => x * y);
    case 'length': { const p = a[0]; const q = a[1]; const d = q !== undefined ? map2(p, q, (x, y) => x - y) : p; return Array.isArray(d) ? Math.hypot(...d) : Math.abs(d); }
    case 'valueAtTime': return env.keyed(num(a[0]));
    default:
      if (MATH[fn]) return a.some(Array.isArray) && a.length === 1 ? a[0].map((x) => MATH[fn](x)) : MATH[fn](...a.map(num));
      throw new Error(`Unknown function ${name}()`);
  }
}

function evaluate(node, env, vars) {
  switch (node.k) {
    case 'num': case 'str': return node.v;
    case 'arr': return node.items.map((n) => num(evaluate(n, env, vars)));
    case 'un': { const v = evaluate(node.a, env, vars); return node.op === '-' ? map2(v, -1, (x, y) => x * y) : node.op === '!' ? (num(v) ? 0 : 1) : v; }
    case 'idx': { const v = evaluate(node.a, env, vars); const i = num(evaluate(node.i, env, vars)); return Array.isArray(v) ? v[i] ?? 0 : i === 0 ? v : 0; }
    case 'tern': return num(evaluate(node.c, env, vars)) ? evaluate(node.a, env, vars) : evaluate(node.b, env, vars);
    case 'bin': {
      const a = evaluate(node.a, env, vars); const b = evaluate(node.b, env, vars);
      if (OPS[node.op]) return map2(a, b, OPS[node.op]);
      const x = num(a); const y = num(b);
      return { '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y, '==': x === y, '!=': x !== y, '&&': x && y, '||': x || y }[node.op] ? 1 : 0;
    }
    case 'id': {
      if (node.name in vars) return vars[node.name];
      switch (node.name) {
        case 'time': return env.time;
        case 'value': return env.value;
        case 'index': return env.index ?? 1;
        case 'fps': return env.fps || 30;
        case 'frame': return Math.round(env.time * (env.fps || 30));
        case 'PI': case 'Math.PI': return Math.PI;
        case 'E': case 'Math.E': return Math.E;
        case 'thisComp.width': return env.comp?.width ?? 0;
        case 'thisComp.height': return env.comp?.height ?? 0;
        case 'thisComp.duration': return env.comp?.duration ?? 0;
        case 'thisComp.frameDuration': return 1 / (env.fps || 30);
        default: throw new Error(`Unknown name "${node.name}"`);
      }
    }
    case 'call': return call(node.name, node.args.map((n) => evaluate(n, env, vars)), env);
    default: throw new Error('Bad expression');
  }
}

const cache = new Map();
/** Parses (cached) and checks an expression. Returns null when fine, or the error message. */
export function checkExpression(src) {
  try { compile(src); return null; } catch (e) { return e.message; }
}
function compile(src) {
  let c = cache.get(src);
  if (!c) {
    try { c = { ast: parseProgram(src) }; } catch (e) { c = { error: e.message }; }
    if (cache.size > 500) cache.clear();
    cache.set(src, c);
  }
  if (c.error) throw new Error(c.error);
  return c.ast;
}

/** Evaluates an expression for a property. env: { value, time, prop, keyed(t), seed, index, fps, comp }. → { ok, value } */
export function evalExpression(src, env) {
  const colour = typeof env.value === 'string';
  const e = colour ? { ...env, value: colorArr(env.value), keyed: (t) => colorArr(env.keyed(t)) } : { ...env };
  try {
    const ast = compile(src);
    const vars = {};
    let out;
    for (const s of ast) {
      if (s.k === 'set') vars[s.name] = evaluate(s.e, e, vars);
      else out = evaluate(s, e, vars);
    }
    if (out === undefined) out = vars[ast[ast.length - 1].name];
    // Match the property's shape: a number property takes the first element, an array property gets padded.
    if (Array.isArray(e.value)) out = Array.isArray(out) ? e.value.map((x, i) => (Number.isFinite(out[i]) ? out[i] : x)) : e.value.map(() => num(out));
    else out = num(out);
    if (colour) out = arrColor(out);
    else if (!Array.isArray(out) && !Number.isFinite(out)) return { ok: false, error: 'Not a number' };
    return { ok: true, value: out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
