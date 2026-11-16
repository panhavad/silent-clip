import crypto from 'node:crypto';
import { db } from './db.js';

const SESSION_COOKIE = 'sc_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const secureCookies = () => (process.env.PUBLIC_URL || '').startsWith('https://');

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secureCookies()) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function createSession(res, userId) {
  const id = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, Date.now() + SESSION_TTL_MS);
  setCookie(res, SESSION_COOKIE, id, SESSION_TTL_MS / 1000);
}

export function destroySession(req, res) {
  const id = parseCookies(req)[SESSION_COOKIE];
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  setCookie(res, SESSION_COOKIE, '', 0);
}

export function loadUser(req, _res, next) {
  const id = parseCookies(req)[SESSION_COOKIE];
  if (id) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.id = ? AND s.expires_at > ?`).get(id, Date.now());
    if (row) req.user = row;
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function googleCallbackUrl(req) {
  return process.env.GOOGLE_CALLBACK_URL || `${req.protocol}://${req.get('host')}/auth/google/callback`;
}

export function googleStart(req, res) {
  if (!googleConfigured()) return res.status(503).send('Google sign-in is not configured');
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'sc_oauth_state', state, 600);
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleCallbackUrl(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

export async function googleCallback(req, res) {
  try {
    const { code, state, error } = req.query;
    if (error) throw new Error(String(error));
    if (!state || state !== parseCookies(req).sc_oauth_state) throw new Error('Invalid OAuth state');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleCallbackUrl(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json();
    if (!infoRes.ok || !info.sub) throw new Error('Could not read Google profile');

    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(info.sub);
    if (!user && info.email && info.email_verified) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(info.email.toLowerCase());
      if (user) db.prepare('UPDATE users SET google_id = ?, avatar = COALESCE(avatar, ?) WHERE id = ?').run(info.sub, info.picture || null, user.id);
    }
    if (!user) {
      const r = db.prepare('INSERT INTO users (email, name, google_id, avatar, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(info.email ? info.email.toLowerCase() : null, info.name || info.email || 'Google user', info.sub, info.picture || null, Date.now());
      user = { id: Number(r.lastInsertRowid) };
    }
    setCookie(res, 'sc_oauth_state', '', 0);
    createSession(res, user.id);
    res.redirect('/');
  } catch (e) {
    res.redirect(`/login.html?error=${encodeURIComponent(e.message)}`);
  }
}
