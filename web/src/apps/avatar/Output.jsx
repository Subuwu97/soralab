// /avatar/<project>/output?key=…  — the page OBS shows as a Browser Source (or the Perform page's pop-out window).
// No sign-in: the key in the link lets it read the project and its files. The background is transparent (OBS keeps
// the alpha) unless ?bg=<colour> is given (the pop-out uses a colour for window capture / chroma key).
// It draws the avatar and follows the poses the Perform page sends through the relay (or a BroadcastChannel).
import { useEffect, useRef, useState } from 'react';
import { createStage } from './stage.js';
import { relayWatcher } from './relay.js';

export default function Output() {
  const canvas = useRef(null);
  const [err, setErr] = useState(null);
  const [state, setState] = useState('loading');
  const id = location.pathname.split('/')[2];
  const q = new URLSearchParams(location.search);
  const key = q.get('key') || '';
  const bg = q.get('bg');

  useEffect(() => {
    // a see-through page: nothing behind the avatar
    const prev = [document.documentElement.style.background, document.body.style.background, document.documentElement.className];
    document.documentElement.style.background = 'transparent'; document.body.style.background = bg || 'transparent';
    document.documentElement.classList.add('sl-output');
    document.title = 'Sora Ningyō output';
    return () => { [document.documentElement.style.background, document.body.style.background] = prev; };
  }, [bg]);

  useEffect(() => {
    let stage = null; let relay = null; let off = false;
    const enc = encodeURIComponent(key);
    (async () => {
      const r = await fetch(`/api/avatar/${id}/out/data?key=${enc}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'This output link is wrong or was reset. Copy it again from the Perform page.' : `Couldn’t load the avatar (${r.status}).`);
      const doc = await r.json();
      if (off) return;
      const c = canvas.current;
      const size = () => { const w = Math.round(innerWidth * devicePixelRatio); const h = Math.round(innerHeight * devicePixelRatio); stage?.resize(w, h); };
      stage = await createStage(doc, c, { assetUrl: (a) => `/api/avatar/${id}/out/asset/${a}?key=${enc}`, coreUrl: `/api/avatar/cubism-core.js?doc=${id}&key=${enc}` });
      if (off) { stage.dispose(); return; }
      stage.setBackground(bg || null);
      stage.setFraming?.(doc.perform?.framing || {});
      size(); addEventListener('resize', size);
      window.__avatarOutput = { stage, poses: 0 };
      relay = relayWatcher(id, key, {
        onMessage: (m) => { if (m.t === 'pose') { stage.setPose(m.p); window.__avatarOutput.poses++; window.__avatarOutput.last = m.p; } },
        onState: (s) => setState(s),
      });
    })().catch((e) => { if (!off) setErr(e.message); });
    return () => { off = true; relay?.close(); stage?.dispose(); };
  }, [id, key, bg]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: bg || 'transparent' }} data-state={state}>
      <canvas ref={canvas} style={{ width: '100%', height: '100%', display: 'block' }} data-testid="av-output" />
      {err && <div style={{ position: 'absolute', left: 16, bottom: 16, color: '#fff', background: 'rgba(0,0,0,.7)', padding: '8px 12px', borderRadius: 8, font: '13px Inter, sans-serif' }}>{err}</div>}
    </div>
  );
}
