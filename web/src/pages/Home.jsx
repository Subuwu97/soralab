// SoraLab home: every app, quick starts, recent and shared projects, and the creative tools.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtBytes } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { APPS, TOOLS, appById } from '../lib/apps.js';
import { createProject } from '../lib/doc.js';
import { PageLayout } from '../components/Header.jsx';
import { AppTile } from '../components/Brand.jsx';
import { Icon } from '../components/Icons.jsx';
import ProjectCard from '../components/ProjectCard.jsx';
import { Spinner, Tabs, EmptyState, Button, toastError, ProgressBar } from '../components/ui.jsx';

const QUICK = [
  ['photo', 'Instagram post'], ['express', 'Tsunami thumbnail'], ['cut', '1080p 30 fps'], ['vector', 'Logo / icon'],
  ['layout', 'A4'], ['motion', 'Lower third · 5 s'], ['audio', 'Podcast (voice)'], ['paint', 'Sketch'],
];

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const { me } = useApp();
  const nav = useNavigate();
  const [tab, setTab] = useState('recent');
  const [docs, setDocs] = useState(null);
  const load = () => api.get(`/api/docs?view=${tab}`).then(setDocs).catch(() => setDocs([]));
  useEffect(() => { setDocs(null); load(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = 'SoraLab'; }, []);

  const quick = async (appId, label) => {
    const app = appById(appId);
    const p = app.presets.find((x) => x.label === label);
    try {
      const { label: _l, width, height, ...meta } = p;
      const d = await createProject(appId, { name: `Untitled ${app.name}`, width, height, duration: meta.duration, pages: meta.pages, meta });
      nav(`/${appId}/${d.id}`);
    } catch (e) { toastError(e); }
  };

  return (
    <PageLayout>
      <section className="relative overflow-hidden rounded-2xl border border-line p-6 sm:p-8 mb-8 bg-[radial-gradient(ellipse_at_10%_0%,rgba(90,180,255,.22),transparent_55%),radial-gradient(ellipse_at_90%_20%,rgba(255,143,177,.18),transparent_50%),radial-gradient(ellipse_at_50%_120%,rgba(139,124,255,.25),transparent_60%)]">
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex-1 min-w-64">
            <div className="text-sm text-fg2 mb-1">{greeting()}, {me.name.split(' ')[0]}</div>
            <h1 className="font-head font-bold text-3xl sm:text-4xl tracking-tight">What will you make today?</h1>
          </div>
          {me.storage && (
            <div className="w-64 text-sm">
              <div className="flex justify-between text-fg2 mb-1.5"><span>Storage</span><span>{fmtBytes(me.storage.total)}{me.storage.quota ? ` of ${fmtBytes(me.storage.quota)}` : ''}</span></div>
              {me.storage.quota ? <ProgressBar value={me.storage.total / me.storage.quota} /> : <div className="text-xs text-fg3">No limit on this server</div>}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2 mt-6">
          {QUICK.map(([a, l]) => (
            <button key={a + l} type="button" onClick={() => quick(a, l)} className="flex items-center gap-2 h-10 pl-1.5 pr-3.5 rounded-full bg-surface/80 border border-line hover:border-accent/50 hover:bg-surface transition text-sm">
              <AppTile app={a} size={28} />{l}
            </button>
          ))}
          <Link to="/files" className="flex items-center gap-2 h-10 px-3.5 rounded-full border border-dashed border-line hover:border-accent/50 text-sm text-fg2 hover:text-fg"><Icon name="upload" size={16} />Open a file</Link>
        </div>
      </section>

      <h2 className="font-head font-semibold text-lg mb-3">Apps</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 mb-10">
        {APPS.map((a) => (
          <Link key={a.id} to={`/${a.id}`} className="group flex gap-3.5 p-4 rounded-xl bg-surface border border-line hover:border-accent/40 hover:-translate-y-0.5 transition">
            <AppTile app={a} size={46} />
            <div className="min-w-0">
              <div className="font-semibold flex items-center gap-2">{a.name}<span className="text-[11px] font-normal text-fg3">like {a.like}</span></div>
              <div className="text-[13px] text-fg2 leading-snug mt-0.5">{a.tagline}</div>
            </div>
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-4 mb-4">
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'recent', label: 'Recent' }, { value: 'starred', label: 'Starred' }, { value: 'shared', label: 'Shared with you' }]} className="flex-1" />
        <Link to="/files"><Button size="sm" variant="ghost" iconRight="chevronRight">All files</Button></Link>
      </div>
      {!docs ? <div className="py-12 grid place-items-center"><Spinner /></div> : !docs.length ? (
        <EmptyState icon={tab === 'shared' ? 'users' : tab === 'starred' ? 'star' : 'sparkles'} title={tab === 'shared' ? 'Nothing shared with you yet' : tab === 'starred' ? 'No starred projects' : 'No projects yet'}>
          {tab === 'recent' ? 'Pick an app above or a quick start to begin.' : tab === 'starred' ? 'Star projects you come back to often.' : 'When someone shares a project with you, it shows up here.'}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4 mb-10">
          {docs.slice(0, 24).map((d) => <ProjectCard key={d.id} d={d} onChange={load} />)}
        </div>
      )}

      <h2 className="font-head font-semibold text-lg mb-3 mt-10">Creative tools</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 pb-8">
        {TOOLS.map((t) => (
          <Link key={t.id} to={t.path} className="flex items-center gap-3 p-4 rounded-xl bg-surface border border-line hover:border-accent/40 transition">
            <span className="w-11 h-11 rounded-xl sora-sky grid place-items-center text-white"><Icon name={{ files: 'folder', libraries: 'library', fonts: 'font', color: 'palette' }[t.id]} size={22} /></span>
            <div className="min-w-0"><div className="font-semibold">{t.name} <span className="text-[11px] font-normal text-fg3">like {t.like}</span></div><div className="text-[13px] text-fg2">{t.tagline}</div></div>
          </Link>
        ))}
      </div>
    </PageLayout>
  );
}
