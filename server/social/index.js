// Social accounts as logged-in browser sessions + the live browser viewer API.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR, userSettings } from '../db.js';
import {
  openSession, getSession, closeUserSessions, deleteProfile, profileBusy, liveSessions,
  browserAvailable, browserExecutable, canShowWindow,
} from './browser.js';
import { LoggedOutError, pause, sleep } from './human.js';
import { healSignIn } from './session-check.js';
import { keeperFor, checkKeeper, keeperState } from './keeper.js';
import { youtube } from './youtube.js';
import { tiktok } from './tiktok.js';
import { instagram } from './instagram.js';

export const DRIVERS = { youtube, tiktok, instagram };
export const SHOTS_DIR = path.join(DATA_DIR, 'post-shots');
const dryRun = () => process.env.PUBLISH_DRY_RUN === 'true';
const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

export function hasSessionCookie(driver, cookies) {
  const now = Date.now() / 1000;
  return cookies.some((c) => driver.sessionCookies.names.includes(c.name) && c.value && (c.expires === -1 || c.expires > now));
}

// ---------- account rows (one per user + platform; the session itself lives in the browser profile) ----------
export function getAccount(userId, platform) {
  const r = db.prepare('SELECT * FROM accounts WHERE user_id = ? AND platform = ?').get(userId, platform);
  if (!r) return null;
  const meta = json(r.meta, {});
  return {
    platform, username: r.username, displayName: r.display_name, avatar: r.avatar,
    loggedIn: meta.loggedIn !== false, checkedAt: meta.checkedAt || r.updated_at, refreshedAt: meta.refreshedAt || null, demo: Boolean(meta.demo), since: r.created_at,
    loggedOutReason: meta.loggedIn === false ? meta.reason || null : null,
    history: Array.isArray(meta.history) ? meta.history : [],
    method: 'browser',
  };
}

// ---------- YouTube: server browser or the user's own Chrome (SlientClip extension) ----------
/** What the user's most recently seen SlientClip extension knows about YouTube in that Chrome. */
export function extensionStatus(userId) {
  const l = db.prepare('SELECT * FROM ext_links WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1').get(userId);
  if (!l) return { connected: false, online: false, loggedIn: null, name: null, lastSeenAt: null, version: null };
  return {
    connected: true, online: Boolean(l.last_seen_at && Date.now() - l.last_seen_at < 3 * 60000),
    loggedIn: l.yt_logged_in === null || l.yt_logged_in === undefined ? null : Boolean(l.yt_logged_in),
    name: l.yt_name || null, lastSeenAt: l.last_seen_at || null, checkedAt: l.yt_checked_at || null, version: l.version || null, linkId: l.id,
  };
}

/** Which way YouTube posts go out for this user: 'extension' or 'server'. "Auto" prefers a signed-in extension. */
export function youtubeRoute(userOrId) {
  const user = typeof userOrId === 'object' ? userOrId : db.prepare('SELECT * FROM users WHERE id = ?').get(userOrId);
  if (!user) return 'server';
  const via = userSettings(user).youtubeVia;
  if (via === 'extension' || via === 'server') return via;
  return extensionStatus(user.id).loggedIn ? 'extension' : 'server';
}

/** Can posts to this platform go out right now (through whichever route the user chose)? */
export function platformReady(userId, platform) {
  if (platform === 'youtube' && youtubeRoute(userId) === 'extension') return extensionStatus(userId).loggedIn === true;
  return Boolean(getAccount(userId, platform)?.loggedIn);
}

const HISTORY_MAX = 20;
/** Remember what happened to a login (newest first) so Settings can show why it was kept or lost. */
export function logLoginEvent(userId, platform, ok, text) {
  const r = db.prepare('SELECT meta FROM accounts WHERE user_id = ? AND platform = ?').get(userId, platform);
  if (!r) return;
  const meta = json(r.meta, {});
  const history = [{ at: Date.now(), ok, text: String(text).slice(0, 200) }, ...(Array.isArray(meta.history) ? meta.history : [])].slice(0, HISTORY_MAX);
  db.prepare('UPDATE accounts SET meta = ? WHERE user_id = ? AND platform = ?').run(JSON.stringify({ ...meta, history }), userId, platform);
}

export const connectedPlatforms = (userId) => Object.keys(DRIVERS).filter((p) => platformReady(userId, p));

export function saveAccount(userId, platform, info = {}) {
  const now = Date.now();
  const prev = json(db.prepare('SELECT meta FROM accounts WHERE user_id = ? AND platform = ?').get(userId, platform)?.meta, {});
  const history = [{ at: now, ok: true, text: 'Signed in' }, ...(Array.isArray(prev.history) ? prev.history : [])].slice(0, HISTORY_MAX);
  const meta = JSON.stringify({ loggedIn: true, checkedAt: now, refreshedAt: now, method: 'browser', demo: Boolean(info.demo), history });
  db.prepare(`INSERT INTO accounts (user_id, platform, username, display_name, avatar, meta, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, platform) DO UPDATE SET username = COALESCE(excluded.username, username),
                display_name = COALESCE(excluded.display_name, display_name), avatar = COALESCE(excluded.avatar, avatar),
                meta = excluded.meta, updated_at = excluded.updated_at`)
    .run(userId, platform, info.username || null, info.displayName || null, info.avatar || null, meta, now, now);
}

export function markLoggedOut(userId, platform, reason = '') {
  console.warn(`[social] ${platform} login of user ${userId} marked expired: ${reason || 'no reason given'}`);
  touchAccount(userId, platform, { loggedIn: false, checkedAt: Date.now(), reason: String(reason).slice(0, 300) || null });
  logLoginEvent(userId, platform, false, `Marked expired: ${reason || 'no reason given'}`);
}

function touchAccount(userId, platform, patch) {
  const r = db.prepare('SELECT meta FROM accounts WHERE user_id = ? AND platform = ?').get(userId, platform);
  if (!r) return;
  const meta = { ...json(r.meta, {}), ...patch };
  db.prepare('UPDATE accounts SET meta = ?, updated_at = ? WHERE user_id = ? AND platform = ?').run(JSON.stringify(meta), Date.now(), userId, platform);
}

export async function removeAccount(userId, platform) {
  await closeUserSessions(userId, platform);
  deleteProfile(userId, platform);
  db.prepare('DELETE FROM accounts WHERE user_id = ? AND platform = ?').run(userId, platform);
}

export async function removeUserBrowserData(userId) {
  await closeUserSessions(userId);
  deleteProfile(userId);
}

const wantsWindow = (user) => userSettings(user).publishView === 'foreground';

// ---------- login ----------
async function readSession(session) {
  const d = DRIVERS[session.platform];
  const cookies = await session.cookies(d.sessionCookies.urls);
  return { cookies, loggedIn: hasSessionCookie(d, cookies) };
}

async function confirmLogin(userId, session) {
  const d = DRIVERS[session.platform];
  const { cookies, loggedIn } = await readSession(session);
  if (!loggedIn) return { loggedIn: false };
  if (d.signedIn) {
    session.step = 'Checking the sign-in';
    // Cookies alone can be leftovers; ask the platform itself before saving the login.
    if (await d.signedIn(session.page).catch(() => null) === false) return { loggedIn: false };
  }
  session.step = 'Reading account name';
  const who = await d.identify(session.page, cookies).catch(() => null);
  saveAccount(userId, session.platform, who || {});
  return { loggedIn: true, ...(who || {}) };
}

/**
 * Open the saved login in the background, visit the platform the way an open tab would (so the site
 * refreshes its own login cookies) and record the result. Only a definite answer marks a login as
 * expired; returns true / false, or null when the platform didn't give a clear answer.
 */
export async function refreshSession(userId, platform, { why = 'Background keep-alive' } = {}) {
  const s = await openSession({ userId, platform, kind: 'check', headed: false });
  try {
    s.step = 'Keeping the login fresh';
    return await verifySession(userId, platform, s, { why, dwellMs: KEEPALIVE_DWELL_MS });
  } finally { await s.close(); }
}

/**
 * Ask the platform (in an open session) whether the login is still good, re-sign YouTube in silently if it
 * can, and record the outcome on the account. Returns true / false, or null when there was no clear answer.
 */
export async function verifySession(userId, platform, s, { why, dwellMs = 0, page = s.page } = {}) {
  const d = DRIVERS[platform];
  {
    let { loggedIn } = await readSession(s);
    let reason = loggedIn ? '' : `the ${d.label} login cookies are gone from the browser profile`;
    // Google's own account login can outlive YouTube's cookies, so let it re-sign YouTube in first.
    if (d.signedIn && (loggedIn || d.passiveLoginUrl)) {
      const v = await healSignIn(d, page);
      await sleep(dwellMs);
      if (v === false) { loggedIn = false; reason = `${reason || `${d.label} says this browser is signed out`}${d.passiveLoginUrl ? ', and Google\'s silent re-sign-in didn\'t work either' : ''}`; } else if (v === null) loggedIn = loggedIn ? null : false;
      else loggedIn = true;
      if (page.__healed) logLoginEvent(userId, platform, true, `${why}: ${d.label} had signed out; signed back in automatically`);
    } else if (loggedIn && d.homeUrl) {
      await page.goto(d.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await sleep(dwellMs);
      // Sign-in redirects can pass through a login URL on their way back; only a page that stays there counts.
      let onLogin = d.loggedOutUrl?.test(page.url());
      for (let i = 0; onLogin && i < 16; i++) { await sleep(500); onLogin = d.loggedOutUrl.test(page.url()); }
      if (onLogin) { loggedIn = false; reason = `${d.label} sent the browser to its login page (${page.url().split('?')[0]})`; } else if (!(await readSession(s)).loggedIn) { loggedIn = false; reason = `the ${d.label} login cookies were removed by the site`; }
    }
    // The session was closed under us (a post took the profile over): no conclusion can be drawn.
    if (s.closed) return null;
    if (loggedIn === false) markLoggedOut(userId, platform, reason);
    else if (loggedIn && !getAccount(userId, platform)) await confirmLogin(userId, s);
    else if (loggedIn) touchAccount(userId, platform, { loggedIn: true, checkedAt: Date.now(), refreshedAt: Date.now(), reason: null });
    if (loggedIn === null) logLoginEvent(userId, platform, null, `${why}: ${d.label} gave no clear answer; kept the login as it was`);
    else if (loggedIn && !page.__healed) logLoginEvent(userId, platform, true, `${why}: still signed in`);
    page.__healed = false;
    return loggedIn;
  }
}

/** Check the saved session (the "Check" button): really loads the platform, and refreshes the login. */
export async function checkLogin(user, platform) {
  if (dryRun() && getAccount(user.id, platform)?.demo) return getAccount(user.id, platform);
  // The always-open session is checked in place (closing it would end what keeps the login warm).
  if (keeperFor(user.id, platform)) {
    await checkKeeper(user.id, platform, 'Check');
    return getAccount(user.id, platform) || { platform, loggedIn: false };
  }
  if (profileBusy(user.id, platform)) return getAccount(user.id, platform);
  await refreshSession(user.id, platform, { why: 'Check' });
  return getAccount(user.id, platform) || { platform, loggedIn: false };
}

// ---------- keep logins alive ----------
// Sites sign out logins that sit unused (Google also rotates its login cookies while a tab is open).
// Every few hours each saved login is opened in the background so it never goes stale.
export const KEEPALIVE_HOURS = Number(process.env.SOCIAL_KEEPALIVE_HOURS ?? 6);
const KEEPALIVE_DWELL_MS = Number(process.env.SOCIAL_KEEPALIVE_DWELL_SEC ?? 20) * 1000;

export async function refreshDueSessions({ force = false } = {}) {
  if (!browserAvailable()) return [];
  const due = db.prepare('SELECT user_id, platform, meta FROM accounts').all().filter((r) => {
    const m = json(r.meta, {});
    return DRIVERS[r.platform] && m.loggedIn !== false && !m.demo && (force || Date.now() - (m.refreshedAt || 0) > KEEPALIVE_HOURS * 3600000);
  });
  const results = [];
  // One at a time, skipping profiles that are posting or logging in right now.
  for (const r of due) {
    if (profileBusy(r.user_id, r.platform)) continue;
    try {
      results.push({ userId: r.user_id, platform: r.platform, loggedIn: await refreshSession(r.user_id, r.platform) });
    } catch (e) {
      if (!e.busy) console.error(`login refresh ${r.platform} (user ${r.user_id}) failed:`, e.message);
    }
  }
  return results;
}

export function startSessionKeepAlive() {
  if (!(KEEPALIVE_HOURS > 0)) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await refreshDueSessions(); } finally { running = false; }
  };
  setTimeout(tick, 2 * 60000).unref();
  setInterval(tick, 15 * 60000).unref();
}

// Cookie-Editor / EditThisCookie JSON export -> Playwright cookies.
function normalizeCookies(list, driver) {
  const SAME = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };
  return (Array.isArray(list) ? list : []).filter((c) => c && c.name && c.domain
    && driver.hosts.some((h) => String(c.domain).replace(/^\./, '').endsWith(h))).map((c) => {
    const out = {
      name: String(c.name), value: String(c.value ?? ''), domain: String(c.domain), path: c.path || '/',
      httpOnly: Boolean(c.httpOnly), secure: Boolean(c.secure),
      expires: Number(c.expirationDate ?? c.expires) > 0 ? Math.round(Number(c.expirationDate ?? c.expires)) : -1,
    };
    const ss = SAME[String(c.sameSite || '').toLowerCase()];
    if (ss) out.sameSite = ss;
    if (out.sameSite === 'None') out.secure = true;
    return out;
  });
}

// ---------- publishing ----------
/**
 * Post a clip by driving the logged-in browser profile. Resolves { url, externalId }.
 * Errors carry `.final` (don't retry: logged out, or failed after pressing Post) and `.screenshot`.
 */
export async function publishWithBrowser({ user, platform, file, clip, onStep, onSession }) {
  const d = DRIVERS[platform];
  const settings = userSettings(user);
  const session = await openSession({ userId: user.id, platform, kind: 'post', headed: settings.publishView === 'foreground' });
  onSession?.(session.id);
  let pressedPost = false;
  const step = (t) => { session.step = t; onStep?.(t); };
  try {
    const { loggedIn } = await readSession(session);
    if (!loggedIn && !d.passiveLoginUrl) throw new LoggedOutError(d.label);
    const onHealed = () => logLoginEvent(user.id, platform, true, `Posting: ${d.label} had signed out; signed back in automatically`);
    const out = await d.publish({
      page: session.page, file, clip, settings, step, onHealed, account: getAccount(user.id, platform), final: () => { pressedPost = true; },
    });
    step('Posted');
    touchAccount(user.id, platform, { loggedIn: true, checkedAt: Date.now(), refreshedAt: Date.now(), reason: null });
    logLoginEvent(user.id, platform, true, 'Posted a clip');
    await pause(1500, 2500);
    return out;
  } catch (e) {
    if (e.loggedOut) markLoggedOut(user.id, platform, `posting found the browser signed out (${(() => { try { return session.page.url().split('?')[0]; } catch { return 'page closed'; } })()})`);
    try { e.screenshot = await session.page.screenshot({ type: 'jpeg', quality: 70, timeout: 8000 }); } catch { /* browser gone */ }
    if (pressedPost && !e.final) {
      e.final = true;
      e.message = `${e.message} — stopped after pressing Post, so it was not retried. Check ${d.label} before retrying.`;
    }
    throw e;
  } finally {
    await session.close();
  }
}

export function saveShot(postId, buf) {
  if (!buf) return false;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOTS_DIR, `${postId}.jpg`), buf);
  return true;
}

// ---------- HTTP ----------
export const router = express.Router();

const ownSession = (req) => {
  const s = getSession(req.params.id);
  return s && s.userId === req.user.id ? s : null;
};

router.get('/api/accounts', (req, res) => {
  const live = liveSessions().filter((s) => s.userId === req.user.id);
  res.json({
    demo: dryRun(),
    keepAliveHours: KEEPALIVE_HOURS > 0 ? KEEPALIVE_HOURS : null,
    extension: db.prepare('SELECT id, name, version, created_at AS createdAt, last_seen_at AS lastSeenAt FROM ext_links WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC').all(req.user.id),
    browser: { available: browserAvailable(), path: browserExecutable() ? path.basename(browserExecutable()) : null, canShowWindow: canShowWindow() },
    accounts: Object.values(DRIVERS).map((d) => {
      const a = getAccount(req.user.id, d.id);
      const s = live.find((x) => x.platform === d.id && x.kind !== 'keeper');
      const out = {
        platform: d.id, label: d.label, connected: platformReady(req.user.id, d.id), loggedIn: Boolean(a?.loggedIn), known: Boolean(a),
        username: a?.username || null, displayName: a?.displayName || null, avatar: a?.avatar || null,
        checkedAt: a?.checkedAt || null, demo: Boolean(a?.demo), loggedOutReason: a?.loggedOutReason || null, history: a?.history || [], session: s ? { id: s.id, kind: s.kind, step: s.step } : null,
        keeper: keeperState(req.user.id, d.id),
      };
      if (d.id === 'youtube') Object.assign(out, { route: youtubeRoute(req.user), via: userSettings(req.user).youtubeVia, ext: extensionStatus(req.user.id) });
      return out;
    }),
  });
});

router.post('/api/accounts/:platform/login', async (req, res) => {
  const d = DRIVERS[req.params.platform];
  if (!d) return res.status(404).json({ error: 'Unknown platform' });
  if (!browserAvailable()) {
    if (dryRun()) { saveAccount(req.user.id, d.id, { username: `demo_${d.id}`, displayName: `Demo ${d.label}`, demo: true }); return res.json({ loggedIn: true, demo: true }); }
    return res.status(503).json({ error: 'No Chrome, Edge or Chromium is installed on the server' });
  }
  const existing = liveSessions().find((s) => s.userId === req.user.id && s.platform === d.id && s.kind === 'login');
  if (existing) return res.json({ sessionId: existing.id });
  try {
    const s = await openSession({ userId: req.user.id, platform: d.id, kind: 'login', headed: wantsWindow(req.user) });
    s.step = `Log in to ${d.label}`;
    s.page.goto(d.loginUrl, { timeout: 60000 }).catch(() => {});
    res.json({ sessionId: s.id, headed: s.headed });
  } catch (e) {
    res.status(e.busy ? 409 : 500).json({ error: e.message });
  }
});

router.post('/api/accounts/:platform/login/finish', async (req, res) => {
  const s = getSession(String(req.body?.sessionId || ''));
  if (!s || s.userId !== req.user.id || s.platform !== req.params.platform) return res.status(404).json({ error: 'Login window not found (it may have timed out)' });
  try {
    const out = await confirmLogin(req.user.id, s);
    if (out.loggedIn) await s.close();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/accounts/:platform/check', async (req, res) => {
  if (!DRIVERS[req.params.platform]) return res.status(404).json({ error: 'Unknown platform' });
  try { res.json(await checkLogin(req.user, req.params.platform)); } catch (e) { res.status(e.busy ? 409 : 500).json({ error: e.message }); }
});

router.post('/api/accounts/:platform/cookies', async (req, res) => {
  const d = DRIVERS[req.params.platform];
  if (!d) return res.status(404).json({ error: 'Unknown platform' });
  const cookies = normalizeCookies(req.body?.cookies, d);
  if (!cookies.length) return res.status(400).json({ error: `No ${d.label} cookies found in that file` });
  let s;
  try {
    s = await openSession({ userId: req.user.id, platform: d.id, kind: 'check', headed: false });
    await s.context.addCookies(cookies);
    const out = await confirmLogin(req.user.id, s);
    if (!out.loggedIn) return res.status(400).json({ error: `Those cookies don't contain a ${d.label} login` });
    res.json(out);
  } catch (e) {
    res.status(e.busy ? 409 : 500).json({ error: e.message });
  } finally { await s?.close(); }
});

router.delete('/api/accounts/:platform', async (req, res) => {
  if (!DRIVERS[req.params.platform]) return res.status(404).json({ error: 'Unknown platform' });
  await removeAccount(req.user.id, req.params.platform);
  db.prepare("DELETE FROM posts WHERE user_id = ? AND platform = ? AND status = 'scheduled' AND source = 'auto'").run(req.user.id, req.params.platform);
  res.json({ ok: true });
});

// ----- live viewer -----
router.get('/api/browser/:id', (req, res) => {
  const s = ownSession(req);
  if (!s) return res.status(404).json({ error: 'Browser closed', closed: true });
  res.json(s.state());
});

router.get('/api/browser/:id/frame', async (req, res) => {
  const s = ownSession(req);
  if (!s) return res.status(404).end();
  const since = Number(req.query.seq);
  // Hold the request briefly until a newer frame exists, so idle pages cost almost nothing.
  for (let i = 0; i < 15 && Number.isFinite(since) && s.frameSeq <= since && !s.closed; i++) await new Promise((r) => setTimeout(r, 100));
  if (Number.isFinite(since) && s.frameSeq <= since) await s.snapshot();
  const frame = await s.getFrame();
  if (!frame || (Number.isFinite(since) && s.frameSeq <= since)) return res.status(204).set('X-Frame-Seq', String(s.frameSeq)).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Seq': String(s.frameSeq) }).send(frame);
});

router.post('/api/browser/:id/input', async (req, res) => {
  const s = ownSession(req);
  if (!s) return res.status(404).json({ error: 'Browser closed' });
  const ev = req.body || {};
  if (ev.type === 'goto') {
    let host = '';
    try { host = new URL(ev.url).hostname; } catch { /* invalid */ }
    // The browser runs on the server, so typed addresses are limited to the platform's own sites.
    if (!DRIVERS[s.platform].hosts.some((h) => host === h || host.endsWith(`.${h}`))) return res.status(400).json({ error: `Only ${DRIVERS[s.platform].hosts.join(', ')} addresses can be opened here` });
  }
  try { await s.input(ev); res.json(s.state()); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/api/browser/:id', async (req, res) => {
  const s = ownSession(req);
  if (!s) return res.json({ ok: true });
  if (s.kind === 'post') return res.status(409).json({ error: 'A post is in progress; it closes by itself when done' });
  if (s.kind === 'keeper') return res.json({ ok: true }); // the always-open session stays open
  await s.close();
  res.json({ ok: true });
});
