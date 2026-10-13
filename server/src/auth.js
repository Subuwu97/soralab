// Sign-in with Mirai Account (OpenID Connect, code flow + PKCE) and session cookies.
import express from 'express';
import crypto from 'node:crypto';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { config } from './config.js';
import { db, now } from './db.js';

const secret = new TextEncoder().encode(config.sessionSecret);
export const SESSION_COOKIE = 'sl_session';
const FLOW_COOKIE = 'sl_oauth';
const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' };
const redirectUri = `${config.publicUrl}/auth/callback`;
const jwks = createRemoteJWKSet(new URL(`${config.accountsInternalUrl}/jwks.json`));

const sign = (payload, exp) => new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(exp).sign(secret);
const verify = async (t) => (await jwtVerify(t, secret)).payload;
const userById = db.prepare('SELECT * FROM users WHERE id = ?');

export async function session(req, res, next) {
  req.user = null;
  const t = req.cookies?.[SESSION_COOKIE];
  if (t) {
    try {
      const p = await verify(t);
      const u = userById.get(p.uid);
      if (u && u.session_ver === p.sv && !u.disabled) {
        req.user = u;
        if (now() - u.last_sync > 15 * 60e3) syncProfile(u).catch(() => {});
      }
    } catch { /* expired or tampered */ }
  }
  next();
}

export const requireUser = (req, res, next) =>
  (req.user ? next() : res.status(401).json({ error: 'login_required', message: 'Sign in to do that.' }));
export const requireAdmin = (req, res, next) =>
  (req.user?.is_admin ? next() : res.status(req.user ? 403 : 401).json({ error: 'admin_only', message: 'Only server admins can do that.' }));

async function tokenRequest(params) {
  const r = await fetch(`${config.accountsInternalUrl}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64'),
    },
    body: new URLSearchParams(params),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `token endpoint ${r.status}`), { code: body.error });
  return body;
}

async function verifyIdToken(idToken, nonce) {
  const { payload } = await jwtVerify(idToken, jwks, { issuer: config.accountsUrl, audience: config.clientId });
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error('nonce mismatch');
  return payload;
}

export function upsertUser(claims, refreshToken) {
  const t = now();
  const name = claims.name || claims.preferred_username || 'SoraLab user';
  const username = String(claims.preferred_username || claims.email?.split('@')[0] || claims.sub).toLowerCase();
  if (userById.get(claims.sub)) {
    db.prepare('UPDATE users SET username = ?, name = ?, email = ?, picture = ?, refresh_token = COALESCE(?, refresh_token), last_sync = ?, is_admin = ? WHERE id = ?')
      .run(username, name, claims.email || null, claims.picture || null, refreshToken || null, t, claims.mirai_admin ? 1 : 0, claims.sub);
  } else {
    db.prepare('INSERT INTO users (id, username, name, email, picture, refresh_token, last_sync, is_admin, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(claims.sub, username, name, claims.email || null, claims.picture || null, refreshToken || null, t, claims.mirai_admin ? 1 : 0, t);
    // Everyone starts with a library to collect colours, styles and graphics in.
    db.prepare('INSERT INTO libraries (id, owner, name, created_at) VALUES (?,?,?,?)').run(crypto.randomBytes(9).toString('base64url'), claims.sub, 'My Library', t);
  }
  return userById.get(claims.sub);
}

const syncing = new Set();
async function syncProfile(u) {
  if (!u.refresh_token || syncing.has(u.id)) return;
  syncing.add(u.id);
  try {
    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: u.refresh_token });
    upsertUser(await verifyIdToken(tok.id_token), tok.refresh_token);
  } catch (e) {
    if (e.code === 'invalid_grant') db.prepare('UPDATE users SET refresh_token = NULL, session_ver = session_ver + 1 WHERE id = ?').run(u.id);
    else db.prepare('UPDATE users SET last_sync = ? WHERE id = ?').run(now(), u.id);
  } finally { syncing.delete(u.id); }
}

export const authRouter = express.Router();

authRouter.get('/auth/login', async (req, res) => {
  const ret = typeof req.query.return === 'string' && req.query.return.startsWith('/') && !req.query.return.startsWith('//') ? req.query.return : '/';
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  res.cookie(FLOW_COOKIE, await sign({ state, nonce, verifier, ret }, '10m'), { ...cookieOpts, maxAge: 10 * 60e3 });
  const u = new URL(`${config.accountsUrl}/authorize`);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, scope: 'openid profile email offline_access',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', ...(req.query.switch ? { prompt: 'select_account' } : {}),
  }).toString();
  res.redirect(u.toString());
});

authRouter.get('/auth/callback', async (req, res) => {
  let flow;
  try { flow = await verify(req.cookies[FLOW_COOKIE] || ''); } catch { return res.redirect('/'); }
  res.clearCookie(FLOW_COOKIE, cookieOpts);
  if (req.query.error || req.query.state !== flow.state || !req.query.code) return res.redirect(flow.ret || '/');
  try {
    const tok = await tokenRequest({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirectUri, code_verifier: flow.verifier });
    const user = upsertUser(await verifyIdToken(tok.id_token, flow.nonce), tok.refresh_token);
    if (user.disabled) return res.status(403).send('This account has been suspended from SoraLab by an admin.');
    res.cookie(SESSION_COOKIE, await sign({ uid: user.id, sv: user.session_ver }, '30d'), { ...cookieOpts, maxAge: 30 * 864e5 });
    res.redirect(flow.ret || '/');
  } catch (e) {
    console.error('[auth] sign-in failed:', e.message);
    res.status(502).send(`Sign-in failed: ${e.message}. Check CLIENT_ID / CLIENT_SECRET and that Mirai Account is reachable.`);
  }
});

authRouter.get('/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOpts);
  if (req.query.local) return res.redirect('/');
  const u = new URL(`${config.accountsUrl}/logout`);
  u.searchParams.set('client_id', config.clientId);
  u.searchParams.set('post_logout_redirect_uri', `${config.publicUrl}/`);
  res.redirect(u.toString());
});
