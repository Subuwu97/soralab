// Small pieces shared by the Files, Libraries, Fonts, Color and Admin pages.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icons.jsx';
import { toast, cx } from '../../components/ui.jsx';

/** Copies text and says so. */
export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch { /* nothing more we can do */ }
    t.remove();
  }
  toast(what, { type: 'success' });
}

/** The banner at the top of each page, in the same style as Home's. */
export function PageHero({ icon, title, subtitle, children, className }) {
  return (
    <section className={cx('relative overflow-hidden rounded-2xl border border-line p-5 sm:p-7 mb-6',
      'bg-[radial-gradient(ellipse_at_8%_0%,rgba(90,180,255,.2),transparent_55%),radial-gradient(ellipse_at_92%_10%,rgba(255,143,177,.14),transparent_50%),radial-gradient(ellipse_at_50%_130%,rgba(139,124,255,.22),transparent_60%)]', className)}>
      <div className="flex flex-wrap items-center gap-4 sm:gap-5">
        {icon && <span className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl sora-sky grid place-items-center text-white shrink-0 shadow-[0_6px_24px_rgba(139,124,255,.35)]"><Icon name={icon} size={26} /></span>}
        <div className="flex-1 min-w-52">
          <h1 className="font-head font-bold text-2xl sm:text-3xl tracking-tight">{title}</h1>
          {subtitle && <p className="text-fg2 text-sm sm:text-[15px] mt-0.5">{subtitle}</p>}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </section>
  );
}

/**
 * Lets people drop files anywhere on the page. Shows a full-window overlay while dragging files over it.
 * onFiles(FileList) is called on drop. Returns the overlay element to render.
 */
export function useDropAnywhere(onFiles, { label = 'Drop files to upload', hint, enabled = true } = {}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onFiles);
  cb.current = onFiles;
  useEffect(() => {
    if (!enabled) return undefined;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); };
    const overFn = (e) => { if (hasFiles(e)) e.preventDefault(); };
    const leave = (e) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth.current = 0; setOver(false);
      if (e.dataTransfer.files?.length) cb.current(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', overFn);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', overFn);
      window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  return over ? createPortal(
    <div className="fixed inset-0 z-[950] p-4 bg-black/45 backdrop-blur-[2px] sl-fade pointer-events-none">
      <div className="h-full rounded-2xl border-2 border-dashed border-accent bg-accent/10 grid place-items-center text-center">
        <div>
          <span className="w-16 h-16 rounded-2xl sora-sky grid place-items-center text-white mx-auto mb-3"><Icon name="upload" size={30} /></span>
          <div className="font-head font-semibold text-xl text-white">{label}</div>
          {hint && <div className="text-sm text-white/80 mt-1">{hint}</div>}
        </div>
      </div>
    </div>, document.body,
  ) : null;
}

/** Remembers a small per-person preference (view mode, sort…) in localStorage. */
export function useStored(key, initial) {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(key); return s === null ? initial : JSON.parse(s); } catch { return initial; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }, [key, v]);
  return [v, setV];
}

/** Whether the viewport is at least `px` wide (for switching side panes to sheets on phones). */
export function useWide(px = 1024) {
  const q = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setWide(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return wide;
}

// ---------------------------------------------------------------- PDF previews (pdf.js, loaded only when needed)

let pdfjsP = null;
async function pdfjs() {
  pdfjsP ||= (async () => {
    const lib = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })();
  return pdfjsP;
}

/** Renders page 1 of a PDF into a canvas `width` CSS pixels wide. Returns { pages, width, height } of page 1 in points. */
export async function renderPdfFirstPage(url, canvas, width) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ url, withCredentials: true }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
    return { pages: doc.numPages, width: Math.round(base.width), height: Math.round(base.height) };
  } finally { doc.destroy(); }
}

/** First page of a PDF, rendered when it scrolls into view. */
export function PdfPreview({ url, width = 320, className, onInfo }) {
  const wrap = useRef(null);
  const ref = useRef(null);
  const [state, setState] = useState('idle');
  const info = useRef(onInfo);
  info.current = onInfo;
  useEffect(() => {
    let off = false;
    const go = () => {
      setState('loading');
      renderPdfFirstPage(url, ref.current, width).then((r) => { if (!off) { setState('ready'); info.current?.(r); } }).catch(() => { if (!off) setState('error'); });
    };
    // Watch the wrapper (the canvas stays hidden until drawn, and hidden elements never intersect).
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); go(); } });
    io.observe(wrap.current);
    return () => { off = true; io.disconnect(); };
  }, [url, width]);
  return (
    <div ref={wrap} className="w-full h-full grid place-items-center">
      <canvas ref={ref} className={cx(className, state !== 'ready' && 'hidden')} />
      {state !== 'ready' && <Icon name="pdf" size={36} className={cx('text-fg3', state === 'loading' && 'animate-pulse')} />}
    </div>
  );
}
