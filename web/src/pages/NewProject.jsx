// Start something new in an app: pick a size preset (or a custom size) and a name. PDF starts from a PDF file;
// Develop starts empty and imports photos inside the app.
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { appById } from '../lib/apps.js';
import { createProject } from '../lib/doc.js';
import { PageLayout } from '../components/Header.jsx';
import { AppTile } from '../components/Brand.jsx';
import { Button, TextInput, NumberInput, Field, Select, toastError, cx } from '../components/ui.jsx';
import { pickAssets } from '../components/Pickers.jsx';

export default function NewProject() {
  const { app: appId } = useParams();
  const [sp] = useSearchParams();
  const app = appById(appId);
  const nav = useNavigate();
  const [name, setName] = useState(`Untitled ${app?.name || ''}`);
  const [preset, setPreset] = useState(0);
  const p = app?.presets?.[preset];
  const [w, setW] = useState(p?.width || 1920);
  const [h, setH] = useState(p?.height || 1080);
  const [fps, setFps] = useState(p?.fps || 30);
  const [dur, setDur] = useState(p?.duration || 10);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (p) { if (p.width) setW(p.width); if (p.height) setH(p.height); if (p.fps) setFps(p.fps); if (p.duration) setDur(p.duration); } }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!app || !app.doc) { nav('/', { replace: true }); return null; }

  const create = async (extra = {}) => {
    setBusy(true);
    try {
      const { label, width, height, ...meta } = p || {};
      const sized = app.presets?.[0]?.width !== undefined;
      const d = await createProject(app.id, {
        name: name.trim() || `Untitled ${app.name}`,
        width: sized ? Math.round(w) : undefined, height: sized ? Math.round(h) : undefined,
        duration: ['motion'].includes(app.id) ? dur : undefined, pages: meta.pages,
        meta: { ...meta, ...(['cut', 'motion', 'animate'].includes(app.id) ? { fps } : {}), ...(['motion'].includes(app.id) ? { duration: dur } : {}), ...extra.meta },
        data: extra.data,
      });
      nav(`/${app.id}/${d.id}`, { replace: true });
    } catch (e) { toastError(e); setBusy(false); }
  };

  const openPdf = async () => {
    const [a] = (await pickAssets({ kinds: ['pdf'], multiple: false, title: 'Open a PDF' })) || [];
    if (!a) return;
    setName(a.name.replace(/\.pdf$/i, ''));
    await create({ data: { source: a.id, annotations: [], pages: null }, meta: { source: a.id } });
  };

  const sizeLabel = app.unit === 'pt' ? 'pt' : 'px';
  return (
    <PageLayout>
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <AppTile app={app} size={52} />
          <div>
            <h1 className="font-head font-bold text-2xl">New {app.name} project</h1>
            <p className="text-fg2 text-sm">{app.tagline}</p>
          </div>
        </div>
        <Field label="Name" className="max-w-md mb-6"><TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} /></Field>

        {app.id === 'pdf' ? (
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" size="lg" icon="pdf" onClick={openPdf} busy={busy}>Open a PDF</Button>
            <Button size="lg" icon="plus" onClick={() => create({ data: { source: null, blank: { width: 612, height: 792, count: 1 }, annotations: [] } })} disabled={busy}>Blank PDF</Button>
          </div>
        ) : app.presets?.length ? (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3 mb-6">
              {app.presets.map((x, i) => (
                <button key={x.label} type="button" onClick={() => setPreset(i)}
                  className={cx('p-3 rounded-xl border text-left transition', preset === i ? 'border-accent bg-accent/10' : 'border-line bg-surface hover:border-accent/40')}>
                  {x.width && (
                    <div className="h-20 grid place-items-center mb-2">
                      <div className="border-2 border-fg3/60 rounded-sm" style={{ width: Math.max(14, 70 * x.width / Math.max(x.width, x.height)), height: Math.max(14, 70 * x.height / Math.max(x.width, x.height)) }} />
                    </div>
                  )}
                  <div className="text-sm font-medium">{x.label}</div>
                  <div className="text-xs text-fg3">{x.width ? `${x.width} × ${x.height} ${sizeLabel}` : ''}{x.fps ? ` · ${x.fps} fps` : ''}{x.pages ? ` · ${x.pages} pages` : ''}{x.sampleRate ? `${x.sampleRate / 1000} kHz` : ''}</div>
                </button>
              ))}
            </div>
            {p?.width !== undefined && (
              <div className="flex flex-wrap items-center gap-4 mb-6">
                <NumberInput label="Width" value={w} onChange={setW} min={1} max={30000} unit={sizeLabel} width={90} />
                <NumberInput label="Height" value={h} onChange={setH} min={1} max={30000} unit={sizeLabel} width={90} />
                <Button size="sm" variant="ghost" icon="rotate" onClick={() => { setW(h); setH(w); }}>Swap</Button>
                {['cut', 'motion', 'animate'].includes(app.id) && <label className="flex items-center gap-2 text-xs text-fg2">Frame rate <Select small value={String(fps)} onChange={(v) => setFps(Number(v))} options={['12', '15', '23.976', '24', '25', '29.97', '30', '50', '59.94', '60'].map((v) => ({ value: v, label: `${v} fps` }))} /></label>}
                {app.id === 'motion' && <NumberInput label="Length" value={dur} onChange={setDur} min={0.5} max={3600} step={0.5} unit="s" width={80} />}
              </div>
            )}
            <Button variant="primary" size="lg" onClick={() => create()} busy={busy}>Create</Button>
          </>
        ) : (
          <Button variant="primary" size="lg" onClick={() => create()} busy={busy}>Create</Button>
        )}
        {sp.get('from') && <p className="text-xs text-fg3 mt-4">Starting from {sp.get('from')}.</p>}
      </div>
    </PageLayout>
  );
}
