// HTTPS on your home network. Browsers only let pages use the microphone, camera and screen on https:// (or localhost),
// so when the Mirai suite's setup gives this app a certificate (from the suite's own local certificate authority),
// it also listens on HTTPS_PORT. Visits to the plain http:// address get a short explanation and move to the secure
// one, and /certificate lets each device trust the authority so the browser stops warning.
import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const OK_COOKIE = 'lan_https_ok';

/**
 * opts: { appName, httpsPort, cert, key, ca, publicUrl, skip: RegExp of paths left alone on http (APIs, files, sockets) }
 * Returns { enabled, secureUrl, listen(app, onServer) }.
 */
export function lanHttps(opts) {
  const enabled = !!(opts.httpsPort && opts.cert && opts.key && fs.existsSync(opts.cert) && fs.existsSync(opts.key));
  const caPem = enabled && opts.ca && fs.existsSync(opts.ca) ? fs.readFileSync(opts.ca, 'utf8') : null;
  const fingerprint = caPem ? new crypto.X509Certificate(caPem).fingerprint256 : null;
  const secureBase = (req) => (opts.publicUrl?.startsWith('https://') ? opts.publicUrl : `https://${req.hostname}:${opts.httpsPort}`);

  function routes(app) {
    if (!enabled) return;
    // The certificate authority, for devices to trust (works on both addresses).
    app.get('/certificate/mirai-ca.crt', (req, res) => {
      if (!caPem) return res.status(404).end();
      res.set('Content-Type', 'application/x-x509-ca-cert').set('Content-Disposition', 'attachment; filename="mirai-suite-ca.crt"').send(caPem);
    });
    app.get('/certificate', (req, res) => res.type('html').send(certificatePage(req)));
    // Plain-http page visits: explain once, then go straight to the secure address.
    app.use((req, res, next) => {
      // Only real page visits (browsers ask for text/html); the suite's server-to-server calls use the http address.
      if (req.secure || req.socket.encrypted || req.method !== 'GET' || opts.skip?.test(req.path) || !(req.get('accept') || '').includes('text/html')) return next();
      const to = `${secureBase(req)}${req.originalUrl}`;
      if (req.headers.cookie?.includes(`${OK_COOKIE}=1`)) return res.redirect(302, to);
      res.type('html').send(movePage(to));
    });
  }

  function listen(app, onServer) {
    if (!enabled) return null;
    const server = https.createServer({ cert: fs.readFileSync(opts.cert), key: fs.readFileSync(opts.key) }, app);
    onServer?.(server);
    server.on('error', (e) => console.error(`[${opts.appName}] HTTPS on port ${opts.httpsPort} failed: ${e.message}`));
    server.listen(opts.httpsPort, opts.host || '0.0.0.0', () => console.log(`[${opts.appName}] HTTPS on your network: ${opts.publicUrl || `port ${opts.httpsPort}`}`));
    return server;
  }

  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b0f24;color:#e8ebff;display:grid;place-items:center;min-height:100vh;padding:20px;box-sizing:border-box}
main{max-width:620px;width:100%;background:#141a3a;border:1px solid #2c3670;border-radius:18px;padding:28px}
h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:22px 0 6px}p,li{color:#b8c0e8}a{color:#8fc3ff}
.btn{display:inline-block;padding:11px 20px;border-radius:999px;background:linear-gradient(90deg,#4fd8ff,#8b9bff,#f07ae0);color:#fff;font-weight:600;text-decoration:none;margin:6px 8px 6px 0;border:0;cursor:pointer;font-size:15px}
.btn.alt{background:#232b5c}code{background:#0b0f24;padding:2px 6px;border-radius:6px;font-size:13px;word-break:break-all}details{margin:8px 0}summary{cursor:pointer;color:#e8ebff}
</style></head><body><main>${body}</main></body></html>`;

  function movePage(to) {
    return page(`${opts.appName} — secure connection`, `
<h1>${esc(opts.appName)} uses a secure connection on your network</h1>
<p>Your browser only allows the microphone, camera and screen sharing on secure (https://) pages, so ${esc(opts.appName)} has moved to:</p>
<p><code>${esc(to.replace(/(https:\/\/[^/]+).*/, '$1'))}</code></p>
<p>The first time, your browser may warn that the connection isn't private: that's because the certificate comes from your own server, not a public company. Choose <b>Advanced → Continue</b> (or <b>Show details → visit this website</b> on iPhone), or install the certificate once so the warning goes away for good.</p>
<p><button class="btn" onclick="document.cookie='${OK_COOKIE}=1; path=/; max-age=31536000; samesite=lax';location.href=${esc(JSON.stringify(to))}">Continue to ${esc(opts.appName)}</button>
<a class="btn alt" href="/certificate">Install the certificate</a></p>`);
  }

  function certificatePage(req) {
    return page('Trust this server', `
<h1>Trust your Mirai server on this device</h1>
<p>Install this certificate once on each phone, tablet and computer. Then Mirai Account, Hikari and SoraLab open without a warning, and calls, the camera and installing the app work.</p>
<p><a class="btn" href="/certificate/mirai-ca.crt" download>Download the certificate</a> <a class="btn alt" href="${esc(secureBase(req))}/">Open ${esc(opts.appName)}</a></p>
${fingerprint ? `<p>Check it's yours: SHA-256 fingerprint<br><code>${esc(fingerprint)}</code></p>` : ''}
<h2>Then trust it</h2>
<details><summary><b>iPhone / iPad</b></summary><ol><li>Open this page in <b>Safari</b> and tap Download, then <b>Allow</b>.</li><li>Settings → <b>Profile Downloaded</b> → Install.</li><li>Settings → General → About → <b>Certificate Trust Settings</b> → turn on <i>Mirai suite local CA</i>.</li></ol></details>
<details><summary><b>Android</b></summary><ol><li>Download the certificate.</li><li>Settings → Security (or "Security &amp; privacy") → More → <b>Install a certificate</b> → <b>CA certificate</b> → Install anyway → pick the file.</li></ol></details>
<details><summary><b>Windows</b></summary><ol><li>Open the downloaded file → <b>Install Certificate</b>.</li><li>Choose <b>Local Machine</b> → "Place all certificates in the following store" → <b>Trusted Root Certification Authorities</b> → Finish.</li><li>Restart the browser.</li></ol></details>
<details><summary><b>Mac</b></summary><ol><li>Open the downloaded file (Keychain Access opens) and add it to the <b>System</b> keychain.</li><li>Double-click <i>Mirai suite local CA</i> → Trust → "When using this certificate": <b>Always Trust</b>.</li></ol></details>
<details><summary><b>Firefox (any computer)</b></summary><ol><li>Settings → Privacy &amp; Security → Certificates → <b>View Certificates</b> → Authorities → <b>Import</b>.</li><li>Pick the file and tick "Trust this CA to identify websites".</li></ol></details>
<details><summary><b>Linux (Chrome)</b></summary><ol><li>chrome://settings/certificates → Authorities → <b>Import</b> → tick "Trust this certificate for identifying websites".</li></ol></details>
<p style="margin-top:20px;font-size:13px">Only install certificates from servers you run or trust: whoever holds this server's key could vouch for any site on devices that trust it. It stays on your server and never leaves it.</p>`);
  }

  return { enabled, routes, listen, secureUrl: enabled ? opts.publicUrl : null };
}
