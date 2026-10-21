// Routes. Editors live in src/apps/<id>/index.jsx (default export: the editor, given the project id) and are
// loaded only when opened. Pages without an editor yet show a friendly placeholder.
import { lazy, Suspense, useMemo } from 'react';
import { Routes, Route, useParams, Navigate, useLocation } from 'react-router-dom';
import { useApp } from './lib/app.jsx';
import { appById } from './lib/apps.js';
import { MenuHost, DialogHost, Toaster, Spinner } from './components/ui.jsx';
import Home from './pages/Home.jsx';
import NewProject from './pages/NewProject.jsx';
import AppHome from './pages/AppHome.jsx';
import SignIn from './pages/SignIn.jsx';

const EDITORS = import.meta.glob('./apps/*/index.jsx');
const PAGES = import.meta.glob('./pages/{Files,Libraries,Fonts,Color,Admin,Encoder}.jsx');
const AVATAR_OUTPUT = import.meta.glob('./apps/avatar/Output.jsx'); // Sora Ningyō's OBS page (no sign-in: it uses the link's key)
const lazyCache = {};
const lazyFrom = (map, key) => (map[key] ? (lazyCache[key] ||= lazy(map[key])) : null);

const Loading = () => <div className="h-full grid place-items-center"><Spinner size={28} /></div>;

function Editor() {
  const { app, id } = useParams();
  const Comp = useMemo(() => lazyFrom(EDITORS, `./apps/${app}/index.jsx`), [app]);
  if (!appById(app)) return <Navigate to="/" replace />;
  if (!Comp) return <AppHome appId={app} missing />;
  return <Suspense fallback={<Loading />}><Comp key={id} id={id} /></Suspense>;
}

function Page({ name }) {
  const Comp = lazyFrom(PAGES, `./pages/${name}.jsx`);
  if (!Comp) return <Navigate to="/" replace />;
  return <Suspense fallback={<Loading />}><Comp /></Suspense>;
}

function AppRoute() {
  const { app } = useParams();
  if (app === 'encoder') return <Page name="Encoder" />;
  if (!appById(app)) return <Navigate to="/" replace />;
  return <AppHome appId={app} />;
}

export default function App() {
  const { me } = useApp();
  const { pathname } = useLocation();
  const Output = /^\/avatar\/[^/]+\/output\/?$/.test(pathname) && lazyFrom(AVATAR_OUTPUT, './apps/avatar/Output.jsx');
  if (Output) return <Suspense fallback={null}><Output /></Suspense>;
  return (
    <>
      {me === undefined ? <Loading /> : me === null ? <SignIn /> : (
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new/:app" element={<NewProject />} />
          <Route path="/files" element={<Page name="Files" />} />
          <Route path="/libraries" element={<Page name="Libraries" />} />
          <Route path="/fonts" element={<Page name="Fonts" />} />
          <Route path="/color" element={<Page name="Color" />} />
          <Route path="/admin" element={<Page name="Admin" />} />
          <Route path="/:app" element={<AppRoute />} />
          <Route path="/:app/:id" element={<Editor />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
      <MenuHost />
      <DialogHost />
      <Toaster />
    </>
  );
}
