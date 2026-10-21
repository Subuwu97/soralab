// The pose relay between the Perform page and OBS output pages (server: server/src/api/avatar.js). Poses also go over
// a BroadcastChannel, so a pop-out window on the same computer works even without the server relay.
const wsUrl = (doc, key, role) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/avatar/relay?${new URLSearchParams({ doc, key, role })}`;
export const channelName = (doc) => `sl-avatar-${doc}`;

/** Keeps a WebSocket open (reconnecting with back-off). onMessage(obj), onState('open' | 'closed' | 'denied'). */
function keep(url, { onMessage, onState }) {
  let ws = null; let dead = false; let wait = 500; let timer = 0;
  const open = () => {
    if (dead) return;
    ws = new WebSocket(url);
    ws.onopen = () => { wait = 500; onState?.('open'); };
    ws.onmessage = (e) => { try { onMessage?.(JSON.parse(e.data)); } catch { /* not ours */ } };
    ws.onclose = (e) => {
      onState?.(e.code === 4001 ? 'denied' : 'closed');
      if (dead || e.code === 4001) return;
      timer = setTimeout(open, wait); wait = Math.min(10000, wait * 1.7);
    };
    ws.onerror = () => {};
  };
  open();
  return {
    send(obj) { if (ws?.readyState === 1 && ws.bufferedAmount < 64 * 1024) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
    close() { dead = true; clearTimeout(timer); ws?.close(); },
  };
}

/** For the Perform page: send({ t: 'pose', p }) ~30×/s. onWatchers(n) says how many output pages listen. */
export function relaySender(doc, key, { onWatchers, onState } = {}) {
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName(doc)) : null;
  const ws = keep(wsUrl(doc, key, 'send'), { onState, onMessage: (m) => { if (m.t === 'watchers') onWatchers?.(m.n); } });
  return {
    send(msg) { const s = JSON.stringify(msg); ws.send(s); bc?.postMessage(s); },
    close() { ws.close(); bc?.close(); },
  };
}

/** For output pages: onMessage({ t: 'pose', p } | { t: 'doc' } …). */
export function relayWatcher(doc, key, { onMessage, onState } = {}) {
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(channelName(doc)) : null;
  if (bc) bc.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore */ } };
  const ws = keep(wsUrl(doc, key, 'watch'), { onMessage, onState });
  return { close() { ws.close(); bc?.close(); } };
}
