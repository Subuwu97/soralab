// Used by every app server: sends notifications to Mirai Account (which keeps the list and does Web Push),
// and serves the bell's API (/api/notifications/…) by forwarding to it for the signed-in user.
// Node built-ins only, so any server can import it by relative path.

/**
 * @param {object} o
 * @param {string} o.accountsUrl     accounts server reachable from this server (ACCOUNTS_INTERNAL_URL)
 * @param {string} o.clientId        this app's client id / secret (first-party clients may use the internal API)
 * @param {string} o.clientSecret
 */
export function makeNotifier({ accountsUrl, clientId, clientSecret }) {
  const auth = 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64');

  async function call(method, path, body) {
    const r = await fetch(`${accountsUrl}${path}`, {
      method,
      headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `accounts ${r.status}`), { status: r.status });
    return data;
  }

  /**
   * Notify one or more people (by account `sub`). Never throws: a notification must not break the action that caused it.
   * n: { kind, title, body?, url?, icon?, image?, tag?, app? }   — tag replaces an earlier unread one with the same tag.
   */
  function notify(subs, n) {
    const list = [...new Set((Array.isArray(subs) ? subs : [subs]).filter((s) => s != null && s !== '').map(String))];
    if (!list.length || !clientSecret) return Promise.resolve({ sent: 0 });
    return call('POST', '/api/internal/notify', { subs: list, app: n.app, notification: n })
      .catch((e) => { console.warn(`[notify] ${n.kind || ''}: ${e.message}`); return { sent: 0 }; });
  }

  /**
   * Adds the bell's routes to an Express router: subOf(req) returns the signed-in user's sub (or null),
   * appOf(req) the client id to file push subscriptions under (defaults to this app); prefix e.g. '/api' when attaching to an app.
   */
  function routes(router, { subOf, appOf = () => clientId, prefix = '' }) {
    const h = (fn) => async (req, res) => {
      const sub = subOf(req);
      if (!sub) return res.status(401).json({ error: 'login_required' });
      try { res.json(await fn(req, encodeURIComponent(sub), sub)); } catch (e) { res.status(e.status === 400 ? 400 : 502).json({ error: 'notifications_unavailable', message: e.message }); }
    };
    const qs = (req) => new URLSearchParams(Object.fromEntries(['limit', 'before'].filter((k) => req.query[k]).map((k) => [k, String(req.query[k])]))).toString();
    router.get(`${prefix}/notifications`, h((req, s) => call('GET', `/api/internal/notifications?sub=${s}&${qs(req)}`)));
    router.get(`${prefix}/notifications/count`, h((req, s) => call('GET', `/api/internal/notifications/count?sub=${s}`)));
    router.post(`${prefix}/notifications/read`, h((req, s, sub) => call('POST', '/api/internal/notifications/read', { sub, ids: req.body?.ids, all: !!req.body?.all })));
    router.post(`${prefix}/notifications/delete`, h((req, s, sub) => call('POST', '/api/internal/notifications/delete', { sub, ids: req.body?.ids, all: !!req.body?.all })));
    router.get(`${prefix}/notifications/push-key`, h(() => call('GET', '/api/internal/push/key')));
    router.post(`${prefix}/notifications/subscribe`, h((req, s, sub) => call('POST', '/api/internal/push/subscribe',
      { sub, subscription: req.body?.subscription, app: appOf(req), user_agent: req.get('user-agent') })));
    router.post(`${prefix}/notifications/unsubscribe`, h((req, s, sub) => call('POST', '/api/internal/push/unsubscribe', { sub, endpoint: req.body?.endpoint })));
    router.post(`${prefix}/notifications/test`, h((req, s, sub) => call('POST', '/api/internal/push/test', { sub, app: appOf(req), url: req.body?.url })));
    router.get(`${prefix}/notifications/prefs`, h((req, s) => call('GET', `/api/internal/notify-prefs?sub=${s}`)));
    // POST, not PUT: some apps leave PUT bodies unparsed for raw file uploads.
    router.post(`${prefix}/notifications/prefs`, h((req, s, sub) => call('PUT', '/api/internal/notify-prefs', { sub, prefs: req.body?.prefs })));
  }

  return { notify, routes, call };
}
