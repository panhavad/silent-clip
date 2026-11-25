// Always-open server-browser sessions (the "virtual" browser): for every user whose YouTube posts go through
// the server, their signed-in YouTube Studio stays open in a hidden browser around the clock, like a tab
// someone never closes. The site keeps refreshing its own login cookies the whole time, so the login doesn't
// time out, and the page is told it is focused so nothing is throttled or suspended.
//
// Anything else that needs the same profile (a login, a post, a check) takes it over: the open session is
// closed cleanly (saving the fresh cookies) and reopened a few seconds after that job is done.
import { db, accessExpired } from '../db.js';
import { openSession, profileSession, onSessionClosed, browserAvailable } from './browser.js';
import { DRIVERS, getAccount, youtubeRoute, verifySession } from './index.js';

const enabled = () => process.env.SOCIAL_KEEP_OPEN !== 'false';
const PLATFORMS = () => (process.env.SOCIAL_KEEP_OPEN_PLATFORMS ?? 'youtube').split(',').map((s) => s.trim()).filter(Boolean);
const MAX = () => Number(process.env.SOCIAL_KEEP_OPEN_MAX ?? 20);
// Reload the page this often (like an open tab the site refreshes), and really check the login this often.
const REFRESH_MS = () => Number(process.env.SOCIAL_KEEP_OPEN_REFRESH_MIN ?? 10) * 60000;
const CHECK_MS = () => Number(process.env.SOCIAL_KEEP_OPEN_CHECK_HOURS ?? 3) * 3600000;
// While someone is looking at / using the session in the live viewer, leave the page alone.
const VIEWER_GRACE_MS = 2 * 60000;

const keepers = new Map(); // `${userId}:${platform}` -> { userId, platform, session, startedAt, refreshedAt, checkedAt, busy }
const backoff = new Map(); // key -> { failures, until, error }
const key = (userId, platform) => `${userId}:${platform}`;

/** Should this account have an always-open session? */
function wanted(userId, platform) {
  if (!enabled() || !browserAvailable() || !PLATFORMS().includes(platform) || !DRIVERS[platform]) return false;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.status !== 'active' || accessExpired(user)) return false;
  const a = getAccount(userId, platform);
  if (!a?.loggedIn || a.demo) return false;
  // Posting YouTube through the Chrome extension: the server browser isn't used, so don't keep one open.
  return platform !== 'youtube' || youtubeRoute(user) === 'server';
}

function candidates() {
  if (!enabled() || !browserAvailable()) return [];
  const plats = PLATFORMS();
  return db.prepare('SELECT user_id, platform FROM accounts ORDER BY updated_at DESC').all()
    .filter((r) => plats.includes(r.platform) && wanted(r.user_id, r.platform))
    .slice(0, MAX())
    .map((r) => ({ userId: r.user_id, platform: r.platform }));
}

export function keeperFor(userId, platform) {
  const kp = keepers.get(key(userId, platform));
  return kp && !kp.session.closed ? kp : null;
}

/** For Settings: is the session open, and when did it last refresh / check? */
export function keeperState(userId, platform) {
  if (!PLATFORMS().includes(platform)) return null;
  const kp = keeperFor(userId, platform);
  if (kp) return { open: true, since: kp.startedAt, refreshedAt: kp.refreshedAt, checkedAt: kp.checkedAt || null, sessionId: kp.session.id };
  const b = backoff.get(key(userId, platform));
  return { open: false, expected: wanted(userId, platform), error: b?.error || null, retryAt: b && b.until > Date.now() ? b.until : null, enabled: enabled() };
}

/** Run one job at a time on a session (page refresh, login check, a take-over). */
async function exclusive(kp, fn) {
  while (kp.busy) await kp.busy.catch(() => {});
  const p = Promise.resolve().then(fn);
  kp.busy = p;
  try { return await p; } finally { if (kp.busy === p) kp.busy = null; }
}

async function startKeeper(userId, platform) {
  const k = key(userId, platform);
  const d = DRIVERS[platform];
  let s;
  try {
    s = await openSession({ userId, platform, kind: 'keeper', headed: false });
    s.step = 'Always open: keeping the login fresh';
    const kp = { userId, platform, session: s, startedAt: Date.now(), refreshedAt: Date.now(), checkedAt: 0, busy: null };
    // A post or login that wants this profile first lets a running refresh/check finish.
    s.yieldTo = () => kp.busy?.catch(() => {});
    keepers.set(k, kp);
    await s.page.goto(d.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    backoff.delete(k);
    console.log(`[keeper] ${platform} session of user ${userId} is open`);
  } catch (e) {
    keepers.delete(k);
    await s?.close().catch(() => {});
    if (e.busy) return;
    const failures = (backoff.get(k)?.failures || 0) + 1;
    backoff.set(k, { failures, until: Date.now() + Math.min(30, 2 ** failures) * 60000, error: e.message });
    console.error(`[keeper] could not open ${platform} for user ${userId}:`, e.message);
  }
}

async function runCheck(kp, why) {
  const d = DRIVERS[kp.platform];
  const v = await verifySession(kp.userId, kp.platform, kp.session, { why });
  if (kp.session.closed) return null;
  kp.checkedAt = Date.now();
  kp.refreshedAt = Date.now();
  if (v === false) {
    // Definitely signed out (and recorded with the reason): nothing to keep open until they log in again.
    keepers.delete(key(kp.userId, kp.platform));
    await kp.session.close();
    return v;
  }
  await kp.session.page.goto(d.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return v;
}

async function refreshPage(kp) {
  const d = DRIVERS[kp.platform];
  const page = kp.session.page;
  await page.goto(d.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  kp.refreshedAt = Date.now();
  // Sent to a sign-in page: find out properly (and re-sign in silently if possible) right away.
  if (d.loggedOutUrl?.test(page.url())) await runCheck(kp, 'Always-open session');
}

/** "Check" in Settings while the session is open: check inside it instead of closing it. */
export async function checkKeeper(userId, platform, why = 'Check') {
  const kp = keeperFor(userId, platform);
  return kp ? exclusive(kp, () => runCheck(kp, why)) : null;
}

/** Open the sessions that should be open, close those that shouldn't, refresh and check the open ones. */
export async function reconcileKeepers() {
  const want = candidates();
  const wantKeys = new Set(want.map((w) => key(w.userId, w.platform)));
  for (const [k, kp] of keepers) {
    if (kp.session.closed) { keepers.delete(k); continue; }
    if (!wantKeys.has(k)) {
      keepers.delete(k);
      await exclusive(kp, () => kp.session.close());
      console.log(`[keeper] closed ${kp.platform} session of user ${kp.userId} (no longer needed)`);
    }
  }
  for (const w of want) {
    const k = key(w.userId, w.platform);
    if (keepers.has(k) || profileSession(w.userId, w.platform)) continue;
    const b = backoff.get(k);
    if (b && b.until > Date.now()) continue;
    await startKeeper(w.userId, w.platform);
  }
  for (const kp of [...keepers.values()]) {
    if (kp.session.closed || kp.session.yielding || kp.busy) continue;
    if (Date.now() - kp.session.lastActive < VIEWER_GRACE_MS && kp.session.lastActive > kp.startedAt + 1000) continue;
    try {
      if (Date.now() - kp.checkedAt >= CHECK_MS()) await exclusive(kp, () => runCheck(kp, 'Always-open session'));
      else if (Date.now() - kp.refreshedAt >= REFRESH_MS()) await exclusive(kp, () => refreshPage(kp));
    } catch (e) {
      if (!kp.session.closed) console.error(`[keeper] ${kp.platform} (user ${kp.userId}):`, e.message);
    }
  }
}

let running = false;
async function run() {
  if (running) return;
  running = true;
  try { await reconcileKeepers(); } catch (e) { console.error('[keeper]', e.message); } finally { running = false; }
}

export function startSessionKeepers() {
  if (!enabled()) return;
  // Reopen soon after something else used the profile (a post, a login) or after the session itself ended.
  onSessionClosed((s) => {
    if (!PLATFORMS().includes(s.platform)) return;
    setTimeout(run, s.kind === 'keeper' ? 30000 : 4000).unref();
  });
  setTimeout(run, 15000).unref();
  setInterval(run, 60000).unref();
}

export const _keepers = keepers;
export const _runKeepers = run;
