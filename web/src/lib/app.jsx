// App-wide state: server config, the signed-in person, theme, and the person's libraries (for colour pickers etc.).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { libraryColorStore } from '../components/ui.jsx';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

function applyTheme(t) {
  const light = t === 'light' || (t === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.className = light ? 'light' : 'dark';
}

export function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [theme, setThemeState] = useState(() => { try { return JSON.parse(localStorage.getItem('sl-theme') || '"dark"'); } catch { return 'dark'; } });
  const [libraries, setLibraries] = useState([]);

  useEffect(() => {
    api.get('/api/config').then(setConfig).catch(() => setConfig({}));
    api.get('/api/me', { quiet: true }).then(setMe).catch(() => setMe(null));
  }, []);
  useEffect(() => {
    const out = () => setMe(null);
    window.addEventListener('sl-signed-out', out);
    return () => window.removeEventListener('sl-signed-out', out);
  }, []);
  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem('sl-theme', JSON.stringify(theme)); } catch { /* private mode */ }
    if (theme !== 'system') return undefined;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const f = () => applyTheme('system');
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [theme]);

  const reloadLibraries = useCallback(async () => {
    try {
      const libs = await api.get('/api/libraries');
      setLibraries(libs);
      libraryColorStore.set(libs.flatMap((l) => l.items.filter((i) => i.kind === 'color').map((i) => i.data.hex)).filter(Boolean));
    } catch { /* signed out */ }
  }, []);
  useEffect(() => { if (me) reloadLibraries(); }, [me, reloadLibraries]);

  const saveSettings = useCallback(async (patch) => {
    setMe((m) => (m ? { ...m, settings: { ...m.settings, ...patch } } : m));
    try { await api.patch('/api/me/settings', patch); } catch { /* best effort */ }
  }, []);

  const value = useMemo(() => ({
    config: config || {}, me, setMe, theme, setTheme: setThemeState, libraries, reloadLibraries, saveSettings,
    signIn: (ret = location.pathname + location.search) => { location.href = `/auth/login?return=${encodeURIComponent(ret)}`; },
  }), [config, me, theme, libraries, reloadLibraries, saveSettings]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
