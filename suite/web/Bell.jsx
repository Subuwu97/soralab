// The notification bell, the same in every Mirai app. Notifications from all apps live in Mirai Account;
// each app's server forwards /api/notifications/* for the signed-in person (shared/notify.js).
// Styling uses only the colour tokens every app defines: bg, fg, fg2, chip, hover, line, menu, accent.
import { useCallback, useEffect, useRef, useState } from 'react';
import { pushState, enablePush, disablePush } from './pwa.js';

const APPS = {
  tsunami: ['Tsunami', 'icon-video'], mail: ['Mail', 'icon-mail'], cloud: ['Minami Cloud', 'icon-cloud'], photos: ['Photos', 'icon-photos'],
  calendar: ['Calendar', 'icon-calendar'], contacts: ['Contacts', 'icon-contacts'], hikari: ['Hikari', 'icon-chat'], soralab: ['SoraLab', 'icon-creative'],
};
const appLabel = (a) => APPS[a]?.[0] || a;
const appIcon = (a) => `/brand/${APPS[a]?.[1] || 'app-icon'}.svg`;

const svg = (d, size = 24) => <svg viewBox="0 0 24 24" width={size} height={size} className="fill-current shrink-0" aria-hidden="true"><path d={d} /></svg>;
const BELL = 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z';
const BELL_F = 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z';
const GEAR = 'M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.3 7.3 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z';
const BACK = 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z';
const CLOSE = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

function ago(ms) {
  const s = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  for (const [n, u] of [[31536000, 'y'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return `${Math.floor(s / n)}${u}`;
  return 'now';
}

async function call(base, path, opts = {}) {
  const r = await fetch(`${base}${path}`, { credentials: 'same-origin', ...opts, headers: { 'content-type': 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || d.error || `Request failed (${r.status})`);
  return d;
}

function Toggle({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
      className={`w-10 h-[22px] rounded-full relative transition-colors shrink-0 ${on ? 'bg-accent' : 'bg-chip'}`}>
      <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${on ? 'left-[21px]' : 'left-[3px]'}`} />
    </button>
  );
}

function Settings({ base, app, onBack }) {
  const [state, setState] = useState('…');
  const [prefs, setPrefs] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushState().then(setState);
    call(base, '/notifications/prefs').then((d) => setPrefs(d.prefs || {})).catch(() => setPrefs({}));
  }, [base]);
  const run = async (fn, ok) => {
    setBusy(true); setMsg('');
    try { await fn(); if (ok) setMsg(ok); } catch (e) { setMsg(e.message); } finally { setBusy(false); setState(await pushState()); }
  };
  const setPref = (a, v) => { setPrefs((p) => ({ ...p, [a]: v })); call(base, '/notifications/prefs', { method: 'POST', body: JSON.stringify({ prefs: { [a]: v } }) }).catch(() => {}); };
  return (
    <div>
      <div className="flex items-center gap-2 px-2 h-12 border-b border-line">
        <button type="button" onClick={onBack} className="w-9 h-9 grid place-items-center rounded-full hover:bg-hover" aria-label="Back">{svg(BACK, 20)}</button>
        <span className="font-medium">Notification settings</span>
      </div>
      <div className="p-4 space-y-4 text-sm">
        <div>
          <div className="font-medium mb-1">This device</div>
          {state === 'unsupported' && <p className="text-fg2">{window.isSecureContext ? 'This browser can’t show notifications.' : 'Notifications need this site to use HTTPS.'} You’ll still see them here.</p>}
          {state === 'blocked' && <p className="text-fg2">Notifications are blocked for this site. Allow them in your browser’s site settings, then come back.</p>}
          {(state === 'on' || state === 'off') && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-fg2">{state === 'on' ? 'Notifications from every app show on this device, even when the app is closed.' : 'Get notified on this device, even when the app is closed.'}</p>
              <Toggle on={state === 'on'} label="Notifications on this device" onChange={(v) => run(() => (v ? enablePush(base) : disablePush(base)), v ? 'Turned on for this device.' : '')} />
            </div>
          )}
          {state === 'on' && <button type="button" disabled={busy} onClick={() => run(() => call(base, '/notifications/test', { method: 'POST', body: JSON.stringify({ url: location.href }) }), 'Sent. It should appear in a moment.')}
            className="mt-2 text-accent font-medium disabled:opacity-50">Send a test notification</button>}
          {msg && <p className="mt-2 text-fg2">{msg}</p>}
        </div>
        <div>
          <div className="font-medium mb-1">Pop-up notifications from</div>
          <p className="text-fg2 mb-2 text-xs">Everything still appears in this list; this only controls what pops up on your devices.</p>
          {prefs && Object.keys(APPS).map((a) => (
            <div key={a} className="flex items-center gap-3 h-10">
              <img src={appIcon(a)} alt="" className="w-5 h-5" /><span className="flex-1">{appLabel(a)}</span>
              <Toggle on={prefs[a] !== false} label={appLabel(a)} onChange={(v) => setPref(a, v)} />
            </div>
          ))}
        </div>
        {app && <p className="text-[11px] text-fg2">Turning notifications on in any app covers all of them on this device.</p>}
      </div>
    </div>
  );
}

/**
 * <Bell base="/api" app="tsunami" />
 * Renders nothing until the person is signed in (the count request fails with 401).
 */
export default function Bell({ base = '/api', app, className = '', size = 24 }) {
  const [unread, setUnread] = useState(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('list');
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const ref = useRef(null);

  const refreshCount = useCallback(() => call(base, '/notifications/count').then((d) => setUnread(d.unread)).catch((e) => { if (/login|401/.test(e.message)) setUnread(null); }), [base]);
  const load = useCallback(async (before) => {
    const d = await call(base, `/notifications?limit=30${before ? `&before=${before}` : ''}`);
    setItems((xs) => (before ? [...(xs || []), ...d.items] : d.items));
    setNext(d.next); setUnread(d.unread);
  }, [base]);

  useEffect(() => {
    refreshCount();
    const t = setInterval(() => document.visibilityState === 'visible' && refreshCount(), 60e3);
    const vis = () => document.visibilityState === 'visible' && refreshCount();
    const msg = (e) => { if (e.data?.type === 'mirai-notification') { refreshCount(); if (open) load(); } };
    document.addEventListener('visibilitychange', vis);
    navigator.serviceWorker?.addEventListener('message', msg);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); navigator.serviceWorker?.removeEventListener('message', msg); };
  }, [refreshCount, load, open]);

  useEffect(() => { if (open && view === 'list') load().catch(() => setItems([])); }, [open, view, load]);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  useEffect(() => { if (unread != null && navigator.setAppBadge) (unread ? navigator.setAppBadge(unread) : navigator.clearAppBadge()).catch(() => {}); }, [unread]);

  if (unread === null) return null;

  const openItem = async (n) => {
    if (!n.read) call(base, '/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [n.id] }) }).then((d) => setUnread(d.unread)).catch(() => {});
    setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    if (n.url) { setOpen(false); location.href = n.url; }
  };
  const markAll = () => call(base, '/notifications/read', { method: 'POST', body: JSON.stringify({ all: true }) }).then((d) => { setUnread(d.unread); setItems((xs) => xs?.map((x) => ({ ...x, read: true }))); });
  const remove = (n) => call(base, '/notifications/delete', { method: 'POST', body: JSON.stringify({ ids: [n.id] }) }).then((d) => { setUnread(d.unread); setItems((xs) => xs.filter((x) => x.id !== n.id)); });

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button type="button" onClick={() => { setOpen((o) => !o); setView('list'); }} aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`} title="Notifications"
        className="relative w-10 h-10 grid place-items-center rounded-full hover:bg-hover text-fg">
        {svg(open ? BELL_F : BELL, size)}
        {unread > 0 && <span className="absolute top-1 right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#e5484d] text-white text-[11px] font-medium leading-[18px] text-center">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="fixed sm:absolute inset-x-2 sm:inset-x-auto top-14 sm:top-auto sm:right-0 sm:mt-1 sm:w-[420px] max-h-[min(640px,calc(100vh-72px))] flex flex-col rounded-2xl bg-menu text-fg shadow-[0_4px_32px_rgba(0,0,0,.25)] z-[90] overflow-hidden">
          {view === 'settings' ? <div className="overflow-y-auto"><Settings base={base} app={app} onBack={() => setView('list')} /></div> : (
            <>
              <div className="flex items-center gap-1 pl-4 pr-2 h-12 border-b border-line shrink-0">
                <span className="font-medium flex-1">Notifications</span>
                {unread > 0 && <button type="button" onClick={markAll} className="text-sm text-accent font-medium px-2 h-8 rounded-full hover:bg-hover">Mark all read</button>}
                <button type="button" onClick={() => setView('settings')} className="w-9 h-9 grid place-items-center rounded-full hover:bg-hover" aria-label="Notification settings" title="Settings">{svg(GEAR, 20)}</button>
              </div>
              <div className="overflow-y-auto flex-1">
                {items === null && <p className="p-6 text-center text-sm text-fg2">Loading…</p>}
                {items?.length === 0 && (
                  <div className="p-8 text-center text-sm text-fg2">
                    <div className="mx-auto mb-3 w-fit opacity-50">{svg(BELL, 48)}</div>
                    Your notifications live here: new videos from your subscriptions, replies, new mail, messages and mentions, files shared with you and event reminders.
                  </div>
                )}
                {items?.map((n) => (
                  <div key={n.id} className={`group flex gap-3 px-4 py-3 cursor-pointer hover:bg-hover ${n.read ? '' : 'bg-accent/5'}`} onClick={() => openItem(n)}>
                    <span className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${n.read ? '' : 'bg-accent'}`} />
                    <span className="relative shrink-0">
                      {n.icon ? <img src={n.icon} alt="" className="w-10 h-10 rounded-full object-cover bg-chip" /> : <img src={appIcon(n.app)} alt="" className="w-10 h-10" />}
                      {n.icon && <img src={appIcon(n.app)} alt="" className="absolute -right-1 -bottom-1 w-4 h-4" />}
                    </span>
                    <div className="flex-1 min-w-0 text-sm">
                      <div className={`line-clamp-2 ${n.read ? '' : 'font-medium'}`}>{n.title}</div>
                      {n.body && <div className="text-fg2 line-clamp-2 text-[13px]">{n.body}</div>}
                      <div className="text-[11px] text-fg2 mt-0.5">{appLabel(n.app)} · {ago(n.created_at)}</div>
                    </div>
                    {n.image && <img src={n.image} alt="" className="w-[86px] aspect-video rounded-md object-cover bg-chip shrink-0" />}
                    <button type="button" onClick={(e) => { e.stopPropagation(); remove(n); }} aria-label="Remove" title="Remove"
                      className="w-7 h-7 -mr-2 grid place-items-center rounded-full text-fg2 opacity-0 group-hover:opacity-100 hover:bg-chip shrink-0">{svg(CLOSE, 16)}</button>
                  </div>
                ))}
                {next && <button type="button" onClick={() => load(next)} className="w-full h-11 text-sm text-accent font-medium hover:bg-hover">Show older</button>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
