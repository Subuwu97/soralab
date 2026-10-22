// Admin (server admins only): what's on this server — people, projects, storage, the render queue and encoder —
// plus suspending people, the latest renders, the storage cleanup and Live2D's Cubism Core. Everyone else gets a polite note.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtBytes, ago } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { appById } from '../lib/apps.js';
import { PageLayout } from '../components/Header.jsx';
import { AppTile } from '../components/Brand.jsx';
import { Icon } from '../components/Icons.jsx';
import { Button, Toggle, Spinner, EmptyState, ProgressBar, confirmDialog, toast, toastError, cx } from '../components/ui.jsx';
import { PageHero } from './_shared/index.jsx';
import { coreStatus, coreVersion, uploadCore, removeCore, CORE_DOWNLOAD, CORE_LICENCE } from '../apps/avatar/live2d/core.js';

const STATUS = {
  queued: { label: 'Queued', icon: 'clock', cls: 'bg-chip text-fg2' },
  running: { label: 'Rendering', icon: 'render', cls: 'bg-accent/15 text-accent' },
  done: { label: 'Done', icon: 'check', cls: 'bg-ok/15 text-ok' },
  failed: { label: 'Failed', icon: 'warning', cls: 'bg-danger/15 text-danger' },
  cancelled: { label: 'Cancelled', icon: 'close', cls: 'bg-chip text-fg3' },
};

function Stat({ icon, label, value, sub, children }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 min-w-0">
      <div className="flex items-center gap-2 text-[13px] text-fg2 mb-2"><Icon name={icon} size={16} />{label}</div>
      <div className="font-head font-bold text-2xl tabular-nums truncate">{value}</div>
      {sub && <div className="text-xs text-fg3 mt-0.5 truncate">{sub}</div>}
      {children}
    </div>
  );
}

function Panel({ title, icon, actions, children, className }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-surface min-w-0', className)}>
      <div className="flex items-center gap-2 px-4 sm:px-5 h-14 border-b border-line">
        <Icon name={icon} size={17} className="text-fg2" />
        <h2 className="font-head font-semibold flex-1 truncate">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function StatusChip({ status }) {
  const s = STATUS[status] || STATUS.queued;
  return <span className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11.5px] font-semibold whitespace-nowrap', s.cls)}><Icon name={s.icon} size={12} />{s.label}</span>;
}

const Avatar = ({ u }) => (u.picture
  ? <img src={u.picture} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
  : <span className="w-8 h-8 rounded-full sora-sky grid place-items-center text-white text-sm font-semibold shrink-0">{u.name?.[0] || '?'}</span>);

const duration = (j) => {
  if (!j.finished_at) return null;
  const s = Math.max(0, Math.round((j.finished_at - j.created_at) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

const BY = { schedule: 'automatic', admin: 'by an admin', person: 'by a person for their own files' };

/** Storage cleanup: unused autosaved files (old layer bitmaps, replaced edits) — how much, the last run, "Clean up now". */
function CleanupPanel() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/api/admin/storage').then(setS).catch((e) => setS({ error: e.message })), []);
  useEffect(() => { load(); }, [load]);
  const run = async () => {
    if (!(await confirmDialog({ title: 'Clean up unused storage?', message: `Removes ${s.unused.files} file${s.unused.files === 1 ? '' : 's'} (${fmtBytes(s.unused.bytes)}) that editors saved along the way and nothing uses any more. Projects, their versions, uploads kept in Files, library items and exports are never removed.`, confirm: 'Clean up now' }))) return;
    setBusy(true);
    try { const r = await api.post('/api/admin/storage/cleanup', {}); toast(r.files ? `Removed ${r.files} file${r.files === 1 ? '' : 's'}, ${fmtBytes(r.bytes)}` : 'Nothing to clean up', { type: 'success' }); } catch (e) { toastError(e); }
    setBusy(false); load();
  };
  const last = s?.last_run;
  return (
    <Panel title="Storage cleanup" icon="trash" actions={<Button size="sm" variant="primary" busy={busy} disabled={!s?.unused?.files} onClick={run} data-testid="cleanup-run">Clean up now</Button>}>
      <div className="p-4 sm:p-5" data-testid="cleanup-panel">
        {!s ? <Spinner /> : s.error ? <p className="text-sm text-danger">{s.error}</p> : (
          <>
            <div className="text-[13px] text-fg2">Unused storage</div>
            <div className="font-head font-bold text-2xl tabular-nums" data-testid="cleanup-unused">{s.unused.files} file{s.unused.files === 1 ? '' : 's'}, {fmtBytes(s.unused.bytes)}</div>
            <div className="text-xs text-fg2 mt-2">
              {last ? <>Last run {ago(last.at)} <span className="text-fg3">({BY[last.by] || last.by})</span>: removed {last.files} file{last.files === 1 ? '' : 's'}, {fmtBytes(last.bytes)}.</> : 'Hasn’t run yet.'}
            </div>
            <p className="text-[11.5px] text-fg3 mt-3">
              Old copies of layers and edits that editors saved along the way (Sora Kōsaku and Sora Paint save each changed layer as a new file), once no project or saved version uses them.
              {s.every_hours > 0 ? ` Runs by itself every ${s.every_hours} hours.` : ' Runs only when you ask (CLEANUP_EVERY_HOURS is 0).'} Files are kept for at least {s.grace_hours} hours. Projects, versions, uploads kept in Files, library items and exports are never removed.
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

/** Live2D's Cubism Core: installed or not, its version and size; upload / replace / remove. It can't ship with SoraLab. */
function CorePanel() {
  const [core, setCore] = useState(null);
  const [version, setVersion] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const load = useCallback(async () => {
    try {
      const c = await coreStatus(); setCore(c);
      setVersion(c.installed ? await coreVersion(c.uploaded_at) : null);
    } catch (e) { setCore({ error: e.message }); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const upload = async (f) => {
    if (!f) return;
    setBusy(true);
    try { await uploadCore(f); toast('Cubism Core added for everyone on this server.', { type: 'success' }); } catch (e) { toastError(e); }
    setBusy(false); load();
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Remove Cubism Core?', message: 'Live2D projects can’t play until it’s added again (OBS output links too). Projects and models are kept.', confirm: 'Remove', danger: true }))) return;
    try { await removeCore(); toast('Cubism Core removed'); } catch (e) { toastError(e); }
    load();
  };
  return (
    <Panel title="Live2D Cubism Core" icon="sparkles" actions={core?.installed && <Button size="sm" variant="ghost" onClick={remove} data-testid="core-remove">Remove</Button>}>
      <div className="p-4 sm:p-5" data-testid="core-panel">
        {!core ? <Spinner /> : core.error ? <p className="text-sm text-danger">{core.error}</p> : (
          <>
            <div className="flex items-center gap-3 mb-3">
              <span className={cx('w-11 h-11 rounded-xl grid place-items-center shrink-0', core.installed ? 'sora-sky text-white' : 'bg-chip text-fg2')}><Icon name={core.installed ? 'check' : 'warning'} size={20} /></span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate" data-testid="core-status">{core.installed ? `Installed${version ? ` · version ${version}` : ''}` : 'Not installed'}</div>
                <div className="text-xs text-fg2 truncate">{core.installed ? `${fmtBytes(core.size)} · added ${ago(core.uploaded_at)}${version ? '' : ' · version unknown'}` : 'Live2D projects in Sora Ningyō need it to play.'}</div>
              </div>
              <Button size="sm" variant={core.installed ? 'secondary' : 'primary'} icon="upload" busy={busy} onClick={() => { input.current.value = ''; input.current.click(); }} data-testid="core-upload">{core.installed ? 'Replace…' : 'Upload…'}</Button>
            </div>
            <ol className="list-decimal pl-5 text-[12.5px] text-fg2 flex flex-col gap-0.5 mb-2">
              <li>Download the <a className="text-accent underline" href={CORE_DOWNLOAD} target="_blank" rel="noreferrer">Cubism SDK for Web</a> from Live2D and accept its licence.</li>
              <li>Upload <code className="text-fg">Core/live2dcubismcore.min.js</code> from the download.</li>
            </ol>
            <p className="text-[11.5px] text-fg3">Live2D’s licence doesn’t let SoraLab include Cubism Core, so it’s added here and kept on this server (<code>data/avatar/</code>). Only signed-in people and your OBS output links can load it. Live2D’s terms apply to it and to how you use it: free for individuals and small businesses under their revenue limit, see the <a className="underline" href={CORE_LICENCE} target="_blank" rel="noreferrer">SDK licence</a>.</p>
            <input ref={input} type="file" accept=".js" className="hidden" onChange={(e) => upload(e.target.files[0])} />
          </>
        )}
      </div>
    </Panel>
  );
}

export default function Admin() {
  const { me } = useApp();
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [o, u, j] = await Promise.all([api.get('/api/admin/overview'), api.get('/api/admin/users'), api.get('/api/admin/jobs')]);
      setOverview(o); setUsers(u); setJobs(j); setError(null);
    } catch (e) { setError(e); }
  }, []);
  useEffect(() => { document.title = 'Admin — SoraLab'; if (me?.is_admin) load(); }, [me, load]);
  // Keep the render queue live while something is rendering.
  useEffect(() => {
    if (!jobs?.some((j) => j.status === 'running' || j.status === 'queued')) return undefined;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [jobs, load]);

  if (!me?.is_admin) {
    return (
      <PageLayout>
        <EmptyState icon="lock" title="This page is for server admins" className="py-24"
          action={<Link to="/"><Button variant="primary" icon="home">Back to Home</Button></Link>}>
          Your account ({me?.name}) isn’t an admin of this SoraLab server. If you need something changed here, ask whoever runs it.
        </EmptyState>
      </PageLayout>
    );
  }

  const suspend = async (u, disabled) => {
    if (disabled && !(await confirmDialog({ title: `Suspend ${u.name}?`, message: 'They’re signed out of SoraLab straight away and can’t sign back in until you turn this off. Their projects and files are kept.', confirm: 'Suspend', danger: true }))) return;
    setUsers((l) => l.map((x) => (x.id === u.id ? { ...x, disabled } : x)));
    try { await api.patch(`/api/admin/users/${u.id}`, { disabled }); toast(disabled ? `${u.name} is suspended` : `${u.name} can sign in again`); } catch (e) { toastError(e); }
    load();
  };

  const o = overview;
  const maxApp = Math.max(1, ...(o?.by_app || []).map((a) => a.n));
  const maxUse = Math.max(1, ...(users || []).map((u) => u.storage));

  return (
    <PageLayout wide>
      <PageHero icon="settings" title="Admin" subtitle="People, storage, the render queue and Live2D’s Cubism Core on this SoraLab server.">
        <Button icon="refresh" onClick={load}>Refresh</Button>
      </PageHero>

      {error ? <EmptyState icon="warning" title="Couldn’t load the admin overview" action={<Button onClick={load}>Try again</Button>}>{error.message}</EmptyState>
        : !o ? <div className="py-16 grid place-items-center"><Spinner size={22} /></div> : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
              <Stat icon="users" label="People" value={o.people} sub={`${users?.filter((u) => u.disabled).length || 0} suspended`} />
              <Stat icon="layers" label="Projects" value={o.projects} sub={`${o.by_app.length} app${o.by_app.length === 1 ? '' : 's'} in use`} />
              <Stat icon="file" label="Files" value={o.files} sub="uploads and exports" />
              <Stat icon="cloud" label="Storage" value={fmtBytes(o.storage)} sub={o.quota ? `Quota ${fmtBytes(o.quota)} per person` : 'No per-person quota'} />
              <Stat icon="queue" label="Render queue" value={o.renders.running + o.renders.queued}
                sub={`${o.renders.running} rendering · ${o.renders.queued} waiting${o.renders.failed ? ` · ${o.renders.failed} failed` : ''}`} />
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] mb-6">
              <Panel title="Projects by app" icon="apps">
                <div className="p-4 sm:p-5">
                  {!o.by_app.length ? <p className="text-sm text-fg2">No projects yet.</p> : (
                    <ul className="flex flex-col gap-2.5" aria-label="Projects by app">
                      {o.by_app.map((a) => {
                        const app = appById(a.app);
                        return (
                          <li key={a.app} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 group" title={`${app?.name || a.app}: ${a.n} project${a.n === 1 ? '' : 's'}`}>
                            <span className="flex items-center gap-2 min-w-0 text-[13px]"><AppTile app={a.app} size={22} /><span className="truncate">{app?.name || a.app}</span></span>
                            <span className="h-3 rounded-r-[4px] bg-chip overflow-hidden">
                              <span className="block h-full rounded-r-[4px] bg-accent group-hover:brightness-110 transition-[width] duration-500" style={{ width: `${(a.n / maxApp) * 100}%` }} />
                            </span>
                            <span className="text-[13px] tabular-nums text-fg2 w-8 text-right">{a.n}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </Panel>

              <Panel title="Render encoder" icon="render">
                <div className="p-4 sm:p-5">
                  <div className="flex items-center gap-3 mb-4">
                    <span className={cx('w-11 h-11 rounded-xl grid place-items-center', o.render.encoder.gpu ? 'sora-sky text-white' : 'bg-chip text-fg2')}><Icon name={o.render.encoder.gpu ? 'sparkles' : 'settings'} size={20} /></span>
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{o.render.encoder.label}</div>
                      <div className="text-xs text-fg2">{o.render.encoder.gpu ? 'Hardware (GPU) encoding is in use' : 'Software (CPU) encoding — no supported GPU found'}</div>
                    </div>
                    <span className={cx('ml-auto h-6 px-2 rounded-full text-[11.5px] font-bold grid place-items-center', o.render.encoder.gpu ? 'bg-ok/15 text-ok' : 'bg-chip text-fg2')}>{o.render.encoder.gpu ? 'GPU' : 'CPU'}</span>
                  </div>
                  <div className="text-xs text-fg2 mb-2">Codecs available</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(o.render.codecs).map(([k, ok]) => (
                      <span key={k} className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-md text-[12px] border', ok ? 'border-line text-fg' : 'border-line text-fg3 line-through')}>
                        <Icon name={ok ? 'check' : 'close'} size={12} className={ok ? 'text-ok' : 'text-fg3'} />{k.toUpperCase()}
                      </span>
                    ))}
                  </div>
                  <div className="text-xs text-fg3 mt-4">{o.render.presets?.length || 0} export presets · Storage quota: {o.quota ? `${fmtBytes(o.quota)} per person` : 'none'}</div>
                </div>
              </Panel>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] mb-6">
              <CleanupPanel />
              <CorePanel />
            </div>

            <Panel title="People" icon="users" className="mb-6" actions={<span className="text-xs text-fg3">{users.length}</span>}>
              <div className="divide-y divide-line">
                <div className="hidden md:grid grid-cols-[minmax(0,1.6fr)_90px_minmax(0,1.2fr)_120px_110px] gap-4 px-5 h-9 items-center text-[11.5px] uppercase tracking-wider text-fg3">
                  <span>Person</span><span className="text-right">Projects</span><span>Storage</span><span>Joined</span><span className="text-right">Access</span>
                </div>
                {users.map((u) => (
                  <div key={u.id} className={cx('grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1.6fr)_90px_minmax(0,1.2fr)_120px_110px] gap-x-4 gap-y-2 px-4 sm:px-5 py-3 items-center', u.disabled && 'opacity-60')}>
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar u={u} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate flex items-center gap-1.5">
                          {u.name}
                          {u.is_admin && <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent/15 text-accent">Admin</span>}
                          {u.id === me.id && <span className="text-[11px] text-fg3 font-normal">(you)</span>}
                        </div>
                        <div className="text-xs text-fg3 truncate">{u.email || `@${u.username}`}</div>
                      </div>
                    </div>
                    <div className="md:hidden justify-self-end">
                      <Toggle checked={!u.disabled} disabled={u.id === me.id} onChange={(on) => suspend(u, !on)} label={u.disabled ? 'Suspended' : 'Active'} />
                    </div>
                    <span className="hidden md:block text-sm tabular-nums text-right">{u.projects}</span>
                    <div className="col-span-2 md:col-span-1 flex items-center gap-2 min-w-0">
                      <span className="text-[13px] tabular-nums w-16 shrink-0 text-fg2 md:text-fg">{fmtBytes(u.storage)}</span>
                      <ProgressBar value={o.quota ? u.storage / o.quota : u.storage / maxUse} className="flex-1" />
                      <span className="md:hidden text-xs text-fg3 shrink-0">{u.projects} project{u.projects === 1 ? '' : 's'}</span>
                    </div>
                    <span className="hidden md:block text-[13px] text-fg2 truncate" title={new Date(u.created_at).toLocaleString()}>{ago(u.created_at)}</span>
                    <div className="hidden md:flex justify-end">
                      <Toggle checked={!u.disabled} disabled={u.id === me.id} onChange={(on) => suspend(u, !on)} label={u.disabled ? 'Suspended' : 'Active'} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="px-5 py-3 text-[11.5px] text-fg3 border-t border-line">Storage bars are relative to {o.quota ? 'the per-person quota' : 'the heaviest user (no quota is set)'}. You can’t suspend yourself.</p>
            </Panel>

            <Panel title="Recent renders" icon="queue" className="mb-10" actions={<Link to="/encoder" className="text-[13px] text-accent hover:underline">Open Encoder</Link>}>
              {!jobs.length ? <EmptyState icon="render" title="No renders yet">Exports rendered on the server (Sora Eizō, Encoder…) show up here.</EmptyState> : (
                <div className="divide-y divide-line">
                  <div className="hidden md:grid grid-cols-[minmax(0,1.6fr)_120px_minmax(0,1fr)_110px_140px] gap-4 px-5 h-9 items-center text-[11.5px] uppercase tracking-wider text-fg3">
                    <span>Render</span><span>Status</span><span>Progress</span><span>Encoder</span><span>Started</span>
                  </div>
                  {jobs.slice(0, 50).map((j) => (
                    <div key={j.id} className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1.6fr)_120px_minmax(0,1fr)_110px_140px] gap-x-4 gap-y-1.5 px-4 sm:px-5 py-3 items-center">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{j.name}</div>
                        <div className="text-xs text-fg3 truncate">{j.owner_name} · {j.kind === 'timeline' ? 'Timeline export' : 'Conversion'}</div>
                        {j.error && <div className="text-xs text-danger truncate" title={j.error}>{j.error}</div>}
                      </div>
                      <div className="justify-self-end md:justify-self-start"><StatusChip status={j.status} /></div>
                      <div className="col-span-2 md:col-span-1 flex items-center gap-2">
                        {j.status === 'running' ? <><ProgressBar value={j.progress} className="flex-1" /><span className="text-xs tabular-nums text-fg2 w-9 text-right">{Math.round((j.progress || 0) * 100)}%</span></>
                          : <span className="text-xs text-fg3">{j.status === 'done' ? `Took ${duration(j) || '—'}` : j.status === 'queued' ? 'Waiting for a free encoder' : duration(j) ? `After ${duration(j)}` : '—'}</span>}
                      </div>
                      <span className="hidden md:block text-[13px] text-fg2 truncate">{j.encoder || '—'}</span>
                      <span className="hidden md:block text-[13px] text-fg2 truncate" title={new Date(j.created_at).toLocaleString()}>{ago(j.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </>
        )}
    </PageLayout>
  );
}
