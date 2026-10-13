// Top bar for SoraLab's own pages (Home, Files, Libraries, Fonts, Color, Encoder, Admin):
// logo, navigation, project search, the suite's apps launcher, the notification bell and the account menu.
import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/app.jsx';
import { api } from '../lib/api.js';
import { Logo } from './Brand.jsx';
import { Icon } from './Icons.jsx';
import { IconButton, Popover, openMenu, cx } from './ui.jsx';
import Bell from '../../../suite/web/Bell.jsx';

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/files', label: 'Files' },
  { to: '/libraries', label: 'Libraries' },
  { to: '/fonts', label: 'Fonts' },
  { to: '/color', label: 'Color' },
  { to: '/encoder', label: 'Encoder' },
];

function SuiteApps() {
  const { config } = useApp();
  const [anchor, setAnchor] = useState(null);
  const [apps, setApps] = useState(null);
  useEffect(() => {
    if (anchor && !apps && config.accounts_url) fetch(`${config.accounts_url}/api/apps`).then((r) => r.json()).then(setApps).catch(() => setApps([]));
  }, [anchor, apps, config.accounts_url]);
  return (
    <>
      <IconButton icon="apps" label="Apps" size={36} onClick={(e) => setAnchor(anchor ? null : e.currentTarget)} active={!!anchor} />
      {anchor && (
        <Popover anchor={anchor} align="end" onClose={() => setAnchor(null)} className="w-80 p-3">
          <div className="grid grid-cols-3 gap-1">
            {(apps || []).map((a) => (
              <a key={a.homepage} href={a.homepage} className="flex flex-col items-center gap-1.5 p-3 rounded-lg hover:bg-hover text-center">
                <img src={a.icon} alt="" className="w-10 h-10" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                <span className="text-xs text-fg leading-tight">{a.name}</span>
              </a>
            ))}
            {apps && !apps.length && <p className="col-span-3 text-sm text-fg2 p-2">No apps found.</p>}
          </div>
        </Popover>
      )}
    </>
  );
}

function Account() {
  const { me, theme, setTheme } = useApp();
  const nav = useNavigate();
  return (
    <button type="button" aria-label="Account" className="w-9 h-9 rounded-full overflow-hidden ring-2 ring-transparent hover:ring-accent/40 transition shrink-0"
      onClick={(e) => openMenu(e.currentTarget, [
        { heading: me.name },
        { label: 'Theme', icon: theme === 'light' ? 'sun' : 'moon', items: [
          { label: 'Dark', checked: theme === 'dark', onClick: () => setTheme('dark') },
          { label: 'Light', checked: theme === 'light', onClick: () => setTheme('light') },
          { label: 'Match system', checked: theme === 'system', onClick: () => setTheme('system') },
        ] },
        ...(me.is_admin ? [{ label: 'Admin', icon: 'settings', onClick: () => nav('/admin') }] : []),
        { label: 'Switch account', icon: 'users', onClick: () => { location.href = '/auth/login?switch=1'; } },
        { divider: true },
        { label: 'Sign out', icon: 'logout', onClick: () => { location.href = '/auth/logout'; } },
      ], { align: 'end' })}>
      {me.picture ? <img src={me.picture} alt="" className="w-full h-full object-cover" /> : <span className="w-full h-full sora-sky grid place-items-center text-white font-semibold">{me.name?.[0]}</span>}
    </button>
  );
}

function Search() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [anchor, setAnchor] = useState(null);
  const nav = useNavigate();
  useEffect(() => {
    if (!q.trim()) { setResults(null); return undefined; }
    const t = setTimeout(() => api.get(`/api/docs?q=${encodeURIComponent(q)}`).then(setResults).catch(() => setResults([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="relative hidden md:block w-72">
      <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg3" />
      <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={(e) => setAnchor(e.currentTarget)} placeholder="Search projects"
        onKeyDown={(e) => { if (e.key === 'Enter' && results?.[0]) { nav(`/${results[0].app}/${results[0].id}`); setQ(''); } }}
        className="w-full h-9 pl-9 pr-3 rounded-full bg-chip border border-transparent focus:border-accent/50 outline-none text-sm placeholder:text-fg3" />
      {anchor && results && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-72 py-1 max-h-96 overflow-auto scroll-thin">
          {!results.length ? <div className="px-3 py-2 text-sm text-fg2">No projects found</div> : results.slice(0, 12).map((d) => (
            <button key={d.id} type="button" onClick={() => { nav(`/${d.app}/${d.id}`); setQ(''); setAnchor(null); }} className="w-full flex items-center gap-2 px-3 h-9 text-sm hover:bg-hover text-left">
              <span className="text-[10px] font-bold text-fg3 w-6">{d.app.slice(0, 2).toUpperCase()}</span><span className="truncate">{d.name}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

export default function Header() {
  return (
    <header className="h-14 shrink-0 flex items-center gap-4 px-4 border-b border-line bg-bg/85 backdrop-blur sticky top-0 z-30">
      <Link to="/" className="shrink-0"><Logo size={30} /></Link>
      <nav className="hidden lg:flex items-center gap-1 ml-2">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('px-3 h-8 rounded-full text-sm grid place-items-center transition', isActive ? 'bg-chip-hover text-fg' : 'text-fg2 hover:text-fg hover:bg-hover')}>{n.label}</NavLink>
        ))}
      </nav>
      <div className="flex-1" />
      <Search />
      <SuiteApps />
      <span className="w-9 h-9 grid place-items-center rounded-full hover:bg-hover text-fg2"><Bell app="soralab" size={20} /></span>
      <Account />
    </header>
  );
}

/** Standard page frame: header, then a scrolling body. */
export function PageLayout({ children, className, wide }) {
  return (
    <div className="h-full flex flex-col">
      <Header />
      <div className="flex-1 overflow-auto scroll-thin">
        <div className={cx('mx-auto px-4 sm:px-6 py-6', wide ? 'max-w-[1600px]' : 'max-w-7xl', className)}>{children}</div>
      </div>
    </div>
  );
}
