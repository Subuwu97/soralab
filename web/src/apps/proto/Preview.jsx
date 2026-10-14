// The prototype player: renders screens and runs their interactions (tap / hover / time → navigate, overlay, back,
// scroll to) with dissolve, slide and push transitions. Used in the editor (full-screen overlay) and at
// /proto/<id>?preview=1, which anyone the project is shared with can open.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '../../components/ui.jsx';
import { artboardsOf, find, bounds } from '../_vector/model.js';
import { renderNode, renderContext } from '../_vector/render.js';
import { loadFonts, onFontsChanged } from '../_vector/text.js';

export const TRIGGERS = [{ value: 'tap', label: 'Tap' }, { value: 'hover', label: 'Hover' }, { value: 'time', label: 'Time' }];
export const ACTIONS = [{ value: 'navigate', label: 'Transition' }, { value: 'overlay', label: 'Overlay' }, { value: 'back', label: 'Previous artboard' }, { value: 'scroll', label: 'Scroll to' }];
export const TRANSITIONS = [
  { value: 'dissolve', label: 'Dissolve' }, { value: 'slide-left', label: 'Slide left' }, { value: 'slide-right', label: 'Slide right' }, { value: 'slide-up', label: 'Slide up' }, { value: 'slide-down', label: 'Slide down' },
  { value: 'push-left', label: 'Push left' }, { value: 'push-right', label: 'Push right' }, { value: 'push-up', label: 'Push up' }, { value: 'push-down', label: 'Push down' }, { value: 'none', label: 'None' },
];
export const EASINGS = [{ value: 'ease-out', label: 'Ease out' }, { value: 'ease-in', label: 'Ease in' }, { value: 'ease-in-out', label: 'Ease in-out' }, { value: 'linear', label: 'Linear' }, { value: 'cubic-bezier(.34,1.56,.64,1)', label: 'Snap' }];

/** Interactions that start from a node (or any of its ancestors up to the artboard). */
function interactionsFor(doc, ab, id, trigger) {
  const f = find(ab.children, id);
  if (!f) return [];
  const chain = [...f.chain, f.node].reverse();
  for (const n of chain) {
    const list = (doc.interactions || []).filter((i) => i.from === n.id && i.trigger === trigger);
    if (list.length) return list;
  }
  return [];
}

function Screen({ doc, ab, tick }) {
  const html = useMemo(() => {
    const ctx = renderContext(doc, { ids: true, prefix: `pv-${ab.id}-` });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${ab.w}" height="${ab.h}" viewBox="${ab.x} ${ab.y} ${ab.w} ${ab.h}" style="display:block">${renderNode({ ...ab, clip: true }, ctx)}</svg>`;
  }, [doc, ab, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react/no-danger
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

const KEYFRAMES = {
  dissolve: { in: [{ opacity: 0 }, { opacity: 1 }], out: null },
  'slide-left': { in: [{ transform: 'translateX(100%)' }, { transform: 'none' }], out: null },
  'slide-right': { in: [{ transform: 'translateX(-100%)' }, { transform: 'none' }], out: null },
  'slide-up': { in: [{ transform: 'translateY(100%)' }, { transform: 'none' }], out: null },
  'slide-down': { in: [{ transform: 'translateY(-100%)' }, { transform: 'none' }], out: null },
  'push-left': { in: [{ transform: 'translateX(100%)' }, { transform: 'none' }], out: [{ transform: 'none' }, { transform: 'translateX(-100%)' }] },
  'push-right': { in: [{ transform: 'translateX(-100%)' }, { transform: 'none' }], out: [{ transform: 'none' }, { transform: 'translateX(100%)' }] },
  'push-up': { in: [{ transform: 'translateY(100%)' }, { transform: 'none' }], out: [{ transform: 'none' }, { transform: 'translateY(-100%)' }] },
  'push-down': { in: [{ transform: 'translateY(-100%)' }, { transform: 'none' }], out: [{ transform: 'none' }, { transform: 'translateY(100%)' }] },
};
const REVERSE = { 'slide-left': 'slide-right', 'slide-right': 'slide-left', 'slide-up': 'slide-down', 'slide-down': 'slide-up', 'push-left': 'push-right', 'push-right': 'push-left', 'push-up': 'push-down', 'push-down': 'push-up' };

export default function Preview({ doc, start, onClose, title }) {
  const abs = artboardsOf(doc);
  const first = abs.find((a) => a.id === (start || doc.home)) || abs[0];
  const [state, setState] = useState({ cur: first?.id, prev: null, trans: null, stack: [], overlay: null, n: 0 });
  const [tick, setTick] = useState(0);
  const [flash, setFlash] = useState(false);
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  const inRef = useRef(null); const outRef = useRef(null); const scrollRef = useRef(null);
  useEffect(() => { loadFonts([...doc.children, ...doc.symbols.flatMap((s) => s.children)]).then(() => setTick((t) => t + 1)); return onFontsChanged(() => setTick((t) => t + 1)); }, [doc]);
  useEffect(() => { const f = () => setWin({ w: window.innerWidth, h: window.innerHeight }); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);

  const cur = abs.find((a) => a.id === state.cur) || first;
  const prev = state.prev ? abs.find((a) => a.id === state.prev) : null;
  const overlay = state.overlay ? abs.find((a) => a.id === state.overlay.id) : null;
  const vh = Math.min(cur?.viewportH || cur?.h || 1, cur?.h || 1);
  const scaleF = cur ? Math.min(1, (win.w - 80) / cur.w, (win.h - 120) / vh) : 1;

  const go = (i) => {
    if (i.action === 'back') {
      setState((s) => (s.overlay ? { ...s, overlay: null } : s.stack.length ? { ...s, prev: s.cur, cur: s.stack[s.stack.length - 1], stack: s.stack.slice(0, -1), trans: { ...(s.lastTrans || {}), type: REVERSE[s.lastTrans?.type] || s.lastTrans?.type || 'dissolve' }, n: s.n + 1 } : s));
      return;
    }
    if (i.action === 'scroll') {
      const ab = cur; const target = (find(ab.children, i.target) || {}).node;
      if (target && scrollRef.current) scrollRef.current.scrollTo({ top: Math.max(0, (bounds(target, doc).y - ab.y) * scaleF), behavior: i.transition === 'none' ? 'auto' : 'smooth' });
      return;
    }
    if (!i.dest || !abs.some((a) => a.id === i.dest)) return;
    const trans = { type: i.transition || 'dissolve', duration: (i.duration ?? 0.3) * 1000, easing: i.easing || 'ease-out' };
    if (i.action === 'overlay') { setState((s) => ({ ...s, overlay: { id: i.dest, trans }, n: s.n + 1 })); return; }
    setState((s) => (i.dest === s.cur && !s.overlay ? s : { ...s, prev: s.cur, cur: i.dest, stack: [...s.stack, s.cur], trans, lastTrans: trans, overlay: null, n: s.n + 1 }));
  };

  // Run the transition each time the screen changes.
  useLayoutEffect(() => {
    const t = state.trans;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (!t || t.type === 'none' || !inRef.current) { setState((s) => (s.prev ? { ...s, prev: null } : s)); return undefined; }
    const k = KEYFRAMES[t.type] || KEYFRAMES.dissolve;
    const opts = { duration: t.duration, easing: t.easing, fill: 'both' };
    const a = inRef.current.animate(k.in, opts);
    if (k.out && outRef.current) outRef.current.animate(k.out, opts);
    a.onfinish = () => setState((s) => ({ ...s, prev: null }));
    return () => a.cancel();
  }, [state.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Time triggers on the screen that's showing.
  useEffect(() => {
    if (!cur) return undefined;
    const timers = (doc.interactions || []).filter((i) => i.from === cur.id && i.trigger === 'time').map((i) => setTimeout(() => go(i), (i.delay ?? 1) * 1000));
    return () => timers.forEach(clearTimeout);
  }, [cur?.id, state.n]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') { if (state.overlay) setState((s) => ({ ...s, overlay: null })); else onClose?.(); } if (e.key === 'ArrowLeft') go({ action: 'back' }); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const onTap = (ab) => (e) => {
    const id = e.target.closest?.('[data-id]')?.getAttribute('data-id');
    const list = id ? interactionsFor(doc, ab, id, 'tap') : [];
    if (list.length) { e.stopPropagation(); go(list[0]); return; }
    // Like XD: tapping somewhere inactive briefly shows where the hotspots are.
    setFlash(true); setTimeout(() => setFlash(false), 600);
  };
  const hovered = useRef(null);
  const onHover = (ab) => (e) => {
    const id = e.target.closest?.('[data-id]')?.getAttribute('data-id');
    if (id === hovered.current) return;
    hovered.current = id;
    const list = id ? interactionsFor(doc, ab, id, 'hover') : [];
    if (list.length) go(list[0]);
  };
  const hotspots = (ab) => (doc.interactions || []).filter((i) => i.trigger !== 'time').map((i) => { const f = find(ab.children, i.from); return f ? { i, b: bounds(f.node, doc) } : null; }).filter(Boolean);

  if (!cur) return <div className="fixed inset-0 z-[950] bg-black grid place-items-center text-white">Nothing to preview yet.</div>;
  const screenStyle = { width: cur.w * scaleF, height: vh * scaleF };
  const layer = (ab, ref, key) => (
    <div key={key} ref={ref} className="absolute inset-0" style={{ background: ab.bg || '#fff' }}>
      <div ref={ref === inRef ? scrollRef : undefined} className="absolute inset-0 overflow-y-auto overflow-x-hidden no-scrollbar" onClick={onTap(ab)} onPointerMove={onHover(ab)}>
        <div style={{ width: ab.w * scaleF, height: ab.h * scaleF }}>
          <div className="relative" style={{ width: ab.w, transform: `scale(${scaleF})`, transformOrigin: '0 0', height: ab.h }}>
            <Screen doc={doc} ab={ab} tick={tick} />
            {flash && hotspots(ab).map(({ i, b }) => <div key={i.id} className="absolute border-2 border-[#3b8cff] bg-[#3b8cff33] rounded pointer-events-none" style={{ left: b.x - ab.x, top: b.y - ab.y, width: b.w, height: b.h }} />)}
          </div>
        </div>
      </div>
    </div>
  );
  return (
    <div className="fixed inset-0 z-[950] bg-[#0b0c10] flex flex-col select-none" data-proto-preview="">
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 text-[#cfd3e0] text-[13px]">
        <span className="font-medium truncate">{title}</span>
        <span className="text-[#7c8295]">· {cur.name}</span>
        <span className="flex-1" />
        <IconButton icon="chevronLeft" label="Back (←)" size={30} disabled={!state.stack.length && !state.overlay} onClick={() => go({ action: 'back' })} />
        <IconButton icon="refresh" label="Restart" size={30} onClick={() => setState({ cur: first.id, prev: null, trans: null, stack: [], overlay: null, n: state.n + 1 })} />
        {onClose && <IconButton icon="close" label="Close preview (Esc)" size={30} onClick={onClose} />}
      </div>
      <div className="flex-1 grid place-items-center">
        <div className="relative overflow-hidden rounded-[10px] shadow-[0_20px_80px_rgba(0,0,0,.6)]" style={screenStyle} data-screen={cur.id}>
          {prev && layer(prev, outRef, `o${state.n}`)}
          {layer(cur, inRef, `i${state.n}`)}
          {overlay && (
            <div className="absolute inset-0 bg-black/40 grid place-items-center" onClick={() => setState((s) => ({ ...s, overlay: null }))}>
              <OverlayCard doc={doc} ab={overlay} scaleF={scaleF} trans={state.overlay.trans} onTap={onTap(overlay)} tick={tick} />
            </div>
          )}
        </div>
      </div>
      <div className="h-9 shrink-0 flex items-center justify-center text-[11px] text-[#7c8295]">Click hotspots to interact · ← goes back · Esc closes</div>
    </div>
  );
}

function OverlayCard({ doc, ab, scaleF, trans, onTap, tick }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const k = KEYFRAMES[trans?.type] || KEYFRAMES.dissolve;
    if (trans?.type !== 'none') ref.current?.animate(k.in, { duration: trans?.duration || 300, easing: trans?.easing || 'ease-out', fill: 'both' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} onClick={(e) => { e.stopPropagation(); onTap(e); }} style={{ width: ab.w * scaleF, height: ab.h * scaleF, background: ab.bg || '#fff' }} className="overflow-hidden rounded-lg shadow-2xl">
      <div style={{ transform: `scale(${scaleF})`, transformOrigin: '0 0' }}><Screen doc={doc} ab={ab} tick={tick} /></div>
    </div>
  );
}
