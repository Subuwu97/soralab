// An app's own page: start new, open recent projects made with it, or open a .sora project from Cloud.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { appById } from '../lib/apps.js';
import { PageLayout } from '../components/Header.jsx';
import { AppTile } from '../components/Brand.jsx';
import ProjectCard from '../components/ProjectCard.jsx';
import { Button, Spinner, EmptyState, toastError } from '../components/ui.jsx';
import { pickCloudFiles } from '../components/Pickers.jsx';

export default function AppHome({ appId, missing }) {
  const app = appById(appId);
  const nav = useNavigate();
  const [docs, setDocs] = useState(null);
  const load = () => api.get(`/api/docs?app=${appId}`).then(setDocs).catch(() => setDocs([]));
  useEffect(() => { setDocs(null); load(); document.title = `${app.name} — SoraLab`; }, [appId]); // eslint-disable-line react-hooks/exhaustive-deps
  const openCloud = async () => {
    const [f] = (await pickCloudFiles({ title: 'Open a SoraLab project (.sora)' })) || [];
    if (!f) return;
    try { const d = await api.post('/api/cloud/open', { file_id: f.id }); nav(`/${d.app}/${d.id}`); } catch (e) { toastError(e); }
  };
  return (
    <PageLayout>
      <div className="flex flex-wrap items-center gap-5 mb-8 p-6 rounded-2xl border border-line" style={{ background: `linear-gradient(120deg, ${app.colors[0]}cc, transparent 70%)` }}>
        <AppTile app={app} size={72} />
        <div className="flex-1 min-w-64">
          <h1 className="font-head font-bold text-3xl">{app.name}</h1>
          <p className="text-fg2">{app.tagline}</p>
          {missing && <p className="text-warn text-sm mt-2">This app isn’t included in this build yet.</p>}
        </div>
        {!missing && app.doc && <Button size="lg" variant="primary" icon="plus" onClick={() => nav(`/new/${app.id}`)}>New project</Button>}
        {!missing && <Button size="lg" icon="cloud" onClick={openCloud}>Open from Cloud</Button>}
      </div>
      <h2 className="font-head font-semibold text-lg mb-3">Your {app.name} projects</h2>
      {!docs ? <Spinner /> : !docs.length ? <EmptyState title={`No ${app.name} projects yet`} action={!missing && <Link to={`/new/${app.id}`}><Button variant="primary">Start one</Button></Link>} />
        : <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">{docs.map((d) => <ProjectCard key={d.id} d={d} onChange={load} />)}</div>}
    </PageLayout>
  );
}
