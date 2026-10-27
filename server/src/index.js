// SoraLab by Mirai Creative Suite — photo, design, layout, video, motion, audio and PDF apps for the Mirai suite.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import './db.js';
import { session, authRouter } from './auth.js';
import { docs } from './api/docs.js';
import { assets, resumeWebCopies } from './api/assets.js';
import { libraries } from './api/libraries.js';
import { suite, cloudEnabled, tsunamiEnabled } from './api/suite.js';
import { jobs, resumeJobs } from './api/jobs.js';
import { admin } from './api/admin.js';
import { avatar, attachRelay } from './api/avatar.js';
import { storage, scheduleCleanup } from './api/storage.js';
import { errorHandler } from './api/util.js';
import { notifier } from './notify.js';
import { warmUp } from './hwaccel.js';
import { lanHttps } from './lan-https.js';
import { suiteImageRoute } from './suite-images.js';
import { suiteCors } from './suite-cors.js';
import http from 'node:http';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);
app.use(cookieParser());
const secure = lanHttps({ appName: 'SoraLab', httpsPort: config.httpsPort, cert: config.tlsCert, key: config.tlsKey, ca: config.lanCaCert, publicUrl: config.publicUrl, host: config.host,
  skip: /^\/(api|auth|certificate|sora|brand|assets|favicon|manifest|sw\.js)(\/|\.|$)/ });
secure.routes(app);
// Editors use SharedArrayBuffer-free features only, but pages must never be framed by other sites.
app.use((req, res, next) => { res.set('X-Frame-Options', 'SAMEORIGIN'); next(); });
// Sora Ningyō avatars in the suite's other apps (Hikari's camera): CORS for their origins only.
app.use(suiteCors);

app.use(session);
app.use(authRouter);
app.get('/api/config', (req, res) => res.json({
  brand: config.brand, public_url: config.publicUrl, accounts_url: config.accountsUrl,
  cloud_url: config.cloudUrl || null, photos_url: config.photosUrl || null, tsunami_url: config.tsunamiUrl || null,
  cloud: cloudEnabled(), tsunami: tsunamiEnabled(), secure_url: secure.secureUrl, max_upload_mb: config.maxUploadMb, signed_in: !!req.user,
}));
app.get('/api/suite-image', suiteImageRoute);
// The suite's bell (notifications from every app).
app.use('/api/notifications', express.json());
notifier.routes(app, { subOf: (req) => req.user?.id || null, prefix: '/api' });
app.use('/api/admin', admin);
for (const r of [docs, assets, libraries, suite, jobs, avatar, storage]) app.use('/api', r);
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'Unknown API endpoint.' }));
app.use(errorHandler);

if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
  app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/|auth\/).*/, (req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('text').send('SoraLab API is running. Build the web app (npm run build).'));
}

// Sora Ningyō's pose relay (WebSocket) rides on both the plain and the HTTPS server.
attachRelay(secure.listen(app));
const plain = http.createServer(app);
attachRelay(plain);
secure.listenPlain(plain, config.port, config.host, () => {
  console.log(`[soralab] ${config.publicUrl} (listening ${config.host}:${config.port}) — accounts: ${config.accountsUrl}`);
  warmUp();
  resumeWebCopies();
  resumeJobs();
  scheduleCleanup();
});
