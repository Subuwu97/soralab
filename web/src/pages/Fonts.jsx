// Fonts (like Adobe Fonts): the bundled open-licence families and your own uploads, with live previews.
// Upload TTF/OTF/WOFF/WOFF2 (button or drop anywhere); rename family/weight/style or delete your own.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadWithProgress, fmtBytes } from '../lib/api.js';
import { BUILTIN, ensureFont, myFonts, WEIGHT_NAMES } from '../lib/fonts.js';
import { PageLayout } from '../components/Header.jsx';
import { Icon } from '../components/Icons.jsx';
import { acceptFor } from '../components/Pickers.jsx';
import { Button, IconButton, Segmented, Select, Modal, TextInput, ProgressBar, Spinner, EmptyState, openMenu, confirmDialog, toast, toastError, cx } from '../components/ui.jsx';
import { PageHero, useDropAnywhere, useStored } from './_shared/index.jsx';

const CATEGORIES = ['All', 'Your fonts', 'Sans serif', 'Serif', 'Display', 'Script', 'Monospace'];
const SAMPLES = ['The quick brown fox jumps over the lazy dog', 'Sphinx of black quartz, judge my vow', 'ABCDEFGHIJKLM nopqrstuvwxyz 0123456789', 'Sky above, ocean below — 空と海'];
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

/** Your fonts grouped by family: [{ family, files: [font], weights, italic }]. */
function groupMine(list) {
  const g = {};
  for (const f of list) (g[f.family] ||= { family: f.family, files: [] }).files.push(f);
  return Object.values(g).map((x) => ({
    ...x, source: 'mine', category: 'Your fonts',
    weights: [...new Set(x.files.map((f) => f.weight))].sort((a, b) => a - b),
    italic: x.files.some((f) => f.style === 'italic'), roman: x.files.some((f) => f.style !== 'italic'),
  }));
}

// ---------------------------------------------------------------- one family

function FontCard({ f, sample, size, onManage, onDelete }) {
  const ref = useRef(null);
  const [weight, setWeight] = useState(() => (f.weights.includes(400) ? 400 : f.weights[0]));
  const [italic, setItalic] = useState(f.source === 'mine' && !f.roman);
  const [text, setText] = useState(null); // this card's own edit of the sample, until the shared one changes
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => { setText(null); }, [sample]);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return undefined;
    let off = false;
    ensureFont(f.family, weight, italic ? 'italic' : 'normal').then(() => { if (!off) setReady(true); });
    return () => { off = true; };
  }, [visible, f.family, weight, italic]);
  const canItalic = f.source === 'builtin' ? f.italic : f.italic && f.roman;
  return (
    <article ref={ref} className="group rounded-xl bg-surface border border-line hover:border-accent/40 transition flex flex-col min-w-0">
      <header className="flex items-start gap-2 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold truncate">{f.family}</h3>
          <div className="text-xs text-fg3 truncate">
            {f.category === 'Your fonts' ? 'Uploaded' : f.category} · {f.weights.length} weight{f.weights.length > 1 ? 's' : ''}{f.italic ? ' + italics' : ''}
          </div>
        </div>
        {f.source === 'mine'
          ? <IconButton icon="more" label={`${f.family} options`} size={28} onClick={(e) => openMenu(e.currentTarget, [
            { label: 'Edit names…', icon: 'edit', onClick: () => onManage(f) },
            { divider: true },
            { label: 'Delete family', icon: 'trash', danger: true, onClick: () => onDelete(f) },
          ], { align: 'end' })} />
          : <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg3 border border-line rounded px-1.5 py-0.5 mt-0.5" title="SIL Open Font License">OFL</span>}
      </header>
      <div
        contentEditable suppressContentEditableWarning spellCheck={false} role="textbox" aria-label={`${f.family} sample text`}
        onBlur={(e) => setText(e.currentTarget.textContent)}
        className={cx('px-4 py-4 flex-1 min-h-28 outline-none break-words leading-[1.2] transition-opacity focus:bg-hover/50 rounded-md mx-1 my-1', ready ? 'opacity-100' : 'opacity-0')}
        style={{ fontFamily: `"${f.family}", var(--font-sans)`, fontWeight: weight, fontStyle: italic ? 'italic' : 'normal', fontSize: size }}>
        {text ?? sample}
      </div>
      <footer className="flex items-center gap-2 px-3 pb-3 min-w-0">
        <div className="flex gap-1 overflow-x-auto no-scrollbar flex-1 min-w-0" role="radiogroup" aria-label="Weight">
          {f.weights.map((w) => (
            <button key={w} type="button" role="radio" aria-checked={w === weight} onClick={() => setWeight(w)} title={WEIGHT_NAMES[w] || String(w)}
              className={cx('h-6 min-w-8 px-1.5 rounded text-[11px] tabular-nums shrink-0 transition', w === weight ? 'bg-accent text-[#06121f] font-semibold' : 'bg-chip text-fg2 hover:text-fg')}>
              {w}
            </button>
          ))}
        </div>
        {canItalic && (
          <button type="button" aria-pressed={italic} onClick={() => setItalic(!italic)} title="Italic"
            className={cx('h-6 w-7 rounded grid place-items-center shrink-0', italic ? 'bg-accent text-[#06121f]' : 'bg-chip text-fg2 hover:text-fg')}><Icon name="italic" size={13} /></button>
        )}
      </footer>
    </article>
  );
}

// ---------------------------------------------------------------- edit names of uploaded files

function ManageDialog({ family, onClose, onChanged }) {
  const [rows, setRows] = useState(() => family.files.map((f) => ({ ...f })));
  const [busy, setBusy] = useState(false);
  const set = (id, p) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const setFamily = (name) => setRows((r) => r.map((x) => ({ ...x, family: name })));
  const save = async () => {
    setBusy(true);
    try {
      for (const r of rows) {
        const o = family.files.find((f) => f.id === r.id);
        if (o.family !== r.family || o.weight !== r.weight || o.style !== r.style) await api.patch(`/api/fonts/${r.id}`, { family: r.family.trim() || o.family, weight: Number(r.weight), style: r.style });
      }
      toast('Font names saved', { type: 'success' });
      await onChanged();
      onClose();
    } catch (e) { toastError(e); setBusy(false); }
  };
  const del = async (r) => {
    if (!(await confirmDialog({ title: `Delete ${r.family} ${WEIGHT_NAMES[r.weight] || r.weight}${r.style === 'italic' ? ' Italic' : ''}?`, message: 'Projects that use it will fall back to another font.', confirm: 'Delete', danger: true }))) return;
    try { await api.del(`/api/fonts/${r.id}`); setRows((x) => x.filter((y) => y.id !== r.id)); await onChanged(); if (rows.length === 1) onClose(); } catch (e) { toastError(e); }
  };
  const weightOpts = Object.entries(WEIGHT_NAMES).map(([w, n]) => ({ value: w, label: `${w} · ${n}` }));
  return (
    <Modal title={`Edit ${family.family}`} onClose={onClose} width={620}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={save}>Save</Button></>}>
      <label className="block mb-4"><span className="text-xs text-fg2 block mb-1">Family name (all styles)</span>
        <TextInput value={rows[0]?.family || ''} onChange={(e) => setFamily(e.target.value)} />
      </label>
      <div className="text-xs text-fg2 mb-1.5">Styles</div>
      <div className="rounded-lg border border-line divide-y divide-line">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 p-2.5">
            <span className="flex-1 min-w-36 text-sm truncate" style={{ fontFamily: `"${family.family}"`, fontWeight: r.weight, fontStyle: r.style }}>
              {family.family} {WEIGHT_NAMES[r.weight] || r.weight}{r.style === 'italic' ? ' Italic' : ''}
              <span className="block text-[11px] text-fg3 font-sans not-italic font-normal">{r.mime.replace('font/', '').toUpperCase()} · {fmtBytes(r.size)}</span>
            </span>
            <Select small value={String(WEIGHT_NAMES[r.weight] ? r.weight : 400)} onChange={(v) => set(r.id, { weight: Number(v) })} options={weightOpts} aria-label="Weight" />
            <Segmented value={r.style} onChange={(style) => set(r.id, { style })} options={[{ value: 'normal', label: 'Roman' }, { value: 'italic', label: 'Italic' }]} />
            <IconButton icon="trash" label="Delete this style" size={28} onClick={() => del(r)} />
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- page

export default function Fonts() {
  const [mine, setMine] = useState(null);
  const [cat, setCat] = useStored('sl-fonts-cat', 'All');
  const [q, setQ] = useState('');
  const [sample, setSample] = useStored('sl-fonts-sample', SAMPLES[0]);
  const [size, setSize] = useStored('sl-fonts-size', 36);
  const [upload, setUpload] = useState(null);
  const [manage, setManage] = useState(null);
  const input = useRef(null);

  const reload = useCallback(async () => {
    const list = await myFonts(true); // refreshes the shared cache so every font picker sees changes
    setMine(list);
  }, []);
  useEffect(() => { document.title = 'Fonts — SoraLab'; reload(); }, [reload]);

  const families = useMemo(() => {
    const builtin = BUILTIN.map((f) => ({ family: f.family, weights: f.weights, italic: f.italic, category: f.category, source: 'builtin' }));
    return [...groupMine(mine || []), ...builtin];
  }, [mine]);
  const shown = families.filter((f) => (cat === 'All' || f.category === cat) && (!q.trim() || f.family.toLowerCase().includes(q.trim().toLowerCase())));
  const counts = useMemo(() => Object.fromEntries(CATEGORIES.map((c) => [c, c === 'All' ? families.length : families.filter((f) => f.category === c).length])), [families]);

  const doUpload = async (files) => {
    const list = [...files].filter((f) => FONT_EXT.test(f.name));
    if (!list.length) { toast('Those aren’t font files — use TTF, OTF, WOFF or WOFF2.', { type: 'error' }); return; }
    const fd = new FormData();
    for (const f of list) fd.append('files', f, f.name);
    setUpload({ n: list.length, p: 0 });
    try {
      const out = await uploadWithProgress('/api/fonts', fd, (p) => setUpload((u) => (u ? { ...u, p } : u)), { onStart: (xhr) => setUpload((u) => ({ ...u, xhr })) });
      await reload();
      const fams = [...new Set(out.map((f) => f.family))];
      toast(`Added ${fams.join(', ')}`, { type: 'success' });
      setCat('Your fonts');
    } catch (e) { if (!e.cancelled) toastError(e, 'Upload failed'); }
    setUpload(null);
  };
  const overlay = useDropAnywhere(doUpload, { label: 'Drop fonts to add them', hint: 'TTF, OTF, WOFF or WOFF2' });
  const deleteFamily = async (f) => {
    if (!(await confirmDialog({ title: `Delete ${f.family}?`, message: `All ${f.files.length} style${f.files.length > 1 ? 's' : ''} are removed. Projects that use it will fall back to another font.`, confirm: 'Delete', danger: true }))) return;
    try { for (const x of f.files) await api.del(`/api/fonts/${x.id}`); toast(`Deleted ${f.family}`); } catch (e) { toastError(e); }
    reload();
  };

  return (
    <PageLayout wide>
      <PageHero icon="font" title="Fonts" subtitle="Open-licence families built in, plus your own — available in every app.">
        <Button variant="primary" icon="upload" onClick={() => input.current.click()}>Upload fonts</Button>
        <input ref={input} type="file" multiple hidden accept={acceptFor(['font'])} onChange={(e) => { doUpload(e.target.files); e.target.value = ''; }} />
      </PageHero>

      {upload && (
        <div className="flex items-center gap-3 mb-4 p-3 rounded-xl border border-line bg-surface text-sm sl-pop">
          <Spinner /><span className="shrink-0">Uploading {upload.n} font{upload.n > 1 ? 's' : ''} · {Math.round(upload.p * 100)}%</span>
          <ProgressBar value={upload.p} className="flex-1" />
          {upload.xhr && <Button size="sm" variant="ghost" onClick={() => upload.xhr.abort()}>Cancel</Button>}
        </div>
      )}

      {/* Sticky controls: sample text, size, category, search. */}
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 mb-5 bg-bg/90 backdrop-blur border-b border-line">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-60">
            <Icon name="text" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg3" />
            <input value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Type something to preview" aria-label="Sample text"
              className="w-full h-9 pl-8 pr-24 rounded-lg bg-input border border-line text-sm text-fg placeholder:text-fg3 outline-none focus:border-accent/70" />
            <button type="button" onClick={() => setSample(SAMPLES[(SAMPLES.indexOf(sample) + 1) % SAMPLES.length])}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 px-2 rounded text-[11.5px] text-fg2 hover:text-fg hover:bg-hover">Another</button>
          </div>
          <label className="flex items-center gap-2 w-full sm:w-56">
            <span className="text-xs text-fg2 shrink-0">Size</span>
            <input type="range" className="sl-range flex-1" min={12} max={120} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Preview size" />
            <span className="text-xs text-fg2 tabular-nums w-10 text-right">{size}px</span>
          </label>
          <div className="relative w-full sm:w-52">
            <Icon name="search" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search families" aria-label="Search families"
              className="w-full h-9 pl-8 pr-2.5 rounded-lg bg-input border border-line text-sm text-fg placeholder:text-fg3 outline-none focus:border-accent/70" />
          </div>
        </div>
        <div className="flex gap-1.5 mt-3 overflow-x-auto no-scrollbar" role="tablist" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button key={c} type="button" role="tab" aria-selected={cat === c} onClick={() => setCat(c)}
              className={cx('h-8 px-3 rounded-full text-[13px] shrink-0 border transition', cat === c ? 'bg-chip-hover border-accent/40 text-fg' : 'border-line text-fg2 hover:text-fg hover:bg-hover')}>
              {c}<span className="ml-1.5 text-fg3 tabular-nums">{counts[c]}</span>
            </button>
          ))}
        </div>
      </div>

      {mine === null ? <div className="py-16 grid place-items-center"><Spinner size={22} /></div> : !shown.length ? (
        cat === 'Your fonts' && !q ? (
          <EmptyState icon="font" title="No fonts of your own yet" action={<Button variant="primary" icon="upload" onClick={() => input.current.click()}>Upload fonts</Button>}>
            Drop TTF, OTF, WOFF or WOFF2 files anywhere on this page. Only you can use the fonts you add.
          </EmptyState>
        ) : <EmptyState icon="search" title="No families match">Try another name or category.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
          {shown.map((f) => <FontCard key={`${f.source}:${f.family}`} f={f} sample={sample || 'Aa'} size={size} onManage={setManage} onDelete={deleteFamily} />)}
        </div>
      )}

      <p className="flex items-start gap-2 text-xs text-fg3 mt-10 mb-6 max-w-3xl">
        <Icon name="info" size={14} className="mt-px shrink-0" />
        <span>
          The built-in families are distributed under the <a href="https://openfontlicense.org" target="_blank" rel="noreferrer" className="underline hover:text-fg2">SIL Open Font License 1.1</a> —
          free to use in anything you make, including commercial work. Fonts you upload are yours to licence; they’re stored privately and only you can use them.
        </span>
      </p>

      {manage && <ManageDialog family={manage} onClose={() => setManage(null)} onChanged={reload} />}
      {overlay}
    </PageLayout>
  );
}
