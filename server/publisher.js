// Linked social accounts + publishing queue + auto-publish planner.
// Publishing only transfers the already-rendered MP4 to the platform; no video processing here.
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { db, CLIPS_DIR, userSettings } from './db.js';
import { encrypt, decrypt, sign } from './secrets.js';
import { parseCookies } from './auth.js';
import { youtube } from './platforms/youtube.js';
import { tiktok } from './platforms/tiktok.js';
import { instagram } from './platforms/instagram.js';
import { sleep } from './platforms/http.js';

export const PLATFORMS = { youtube, tiktok, instagram };
const dryRun = () => process.env.PUBLISH_DRY_RUN === 'true';
const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

// ---------- time zones ----------
function tzOffsetMin(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts) / 60000);
}

/** UTC timestamp of a wall-clock time in `tz`. */
export function zonedTime(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMin(guess, tz) * 60000;
  const off2 = tzOffsetMin(t, tz);
  t = guess - off2 * 60000;
  return t;
}

function localDate(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

// ---------- auto-publish settings ----------
export const DEFAULT_AUTOPUBLISH = {
  enabled: false,
  timezone: 'UTC',
  minScore: 0,
  maxAgeHours: 72,
  platforms: {
    youtube: { enabled: true, times: ['12:00', '18:00'], days: [0, 1, 2, 3, 4, 5, 6] },
    tiktok: { enabled: true, times: ['11:00', '16:00', '20:00'], days: [0, 1, 2, 3, 4, 5, 6] },
    instagram: { enabled: true, times: ['13:00', '19:00'], days: [0, 1, 2, 3, 4, 5, 6] },
  },
};

export function autopublishSettings(user) {
  const s = userSettings(user).autopublish || {};
  const out = { ...DEFAULT_AUTOPUBLISH, ...s, platforms: {} };
  for (const p of Object.keys(PLATFORMS)) out.platforms[p] = { ...DEFAULT_AUTOPUBLISH.platforms[p], ...(s.platforms?.[p] || {}) };
  return out;
}

function sanitizeAutopublish(body, current) {
  const out = { ...current, platforms: { ...current.platforms } };
  if ('enabled' in body) out.enabled = Boolean(body.enabled);
  if (body.timezone && validTz(body.timezone)) out.timezone = body.timezone;
  if ('minScore' in body) out.minScore = Math.min(99, Math.max(0, Number(body.minScore) || 0));
  if ('maxAgeHours' in body) out.maxAgeHours = Math.min(24 * 30, Math.max(1, Number(body.maxAgeHours) || 72));
  for (const p of Object.keys(PLATFORMS)) {
    const src = body.platforms?.[p];
    if (!src) continue;
    const cur = { ...out.platforms[p] };
    if ('enabled' in src) cur.enabled = Boolean(src.enabled);
    if (Array.isArray(src.times)) cur.times = [...new Set(src.times.map(String).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort().slice(0, 12);
    if (Array.isArray(src.days)) cur.days = [...new Set(src.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    out.platforms[p] = cur;
  }
  return out;
}

// ---------- accounts ----------
function accountRow(r) {
  if (!r) return null;
  return {
    id: r.id, userId: r.user_id, platform: r.platform, externalId: r.external_id, username: r.username, displayName: r.display_name,
    avatar: r.avatar, accessToken: decrypt(r.access_token), refreshToken: decrypt(r.refresh_token), expiresAt: r.expires_at,
  };
}

export function saveAccount(userId, platform, a) {
  const now = Date.now();
  db.prepare(`INSERT INTO accounts (user_id, platform, external_id, username, display_name, avatar, access_token, refresh_token, expires_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, platform) DO UPDATE SET external_id = excluded.external_id, username = excluded.username,
                display_name = excluded.display_name, avatar = excluded.avatar, access_token = excluded.access_token,
                refresh_token = COALESCE(excluded.refresh_token, refresh_token), expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
    .run(userId, platform, a.externalId || null, a.username || null, a.displayName || null, a.avatar || null,
      encrypt(a.accessToken), encrypt(a.refreshToken), a.expiresAt || null, now, now);
}

async function freshAccount(userId, platform) {
  const acc = accountRow(db.prepare('SELECT * FROM accounts WHERE user_id = ? AND platform = ?').get(userId, platform));
  if (!acc) return null;
  const p = PLATFORMS[platform];
  const margin = p.refreshBeforeMs || 5 * 60 * 1000;
  if (!dryRun() && acc.expiresAt && acc.expiresAt - Date.now() < margin && (acc.refreshToken || platform === 'instagram')) {
    const t = await p.refresh(acc);
    db.prepare('UPDATE accounts SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, updated_at = ? WHERE id = ?')
      .run(encrypt(t.accessToken), encrypt(t.refreshToken), t.expiresAt, Date.now(), acc.id);
    Object.assign(acc, t);
  }
  return acc;
}

// ---------- posts ----------
function postRow(r) {
  return {
    id: r.id, clipId: r.clip_id, platform: r.platform, scheduledAt: r.scheduled_at, status: r.status, source: r.source,
    attempts: r.attempts, error: r.error, url: r.url, publishedAt: r.published_at,
    clip: r.title !== undefined ? {
      title: r.title, streamer: r.streamer_login, score: json(r.viral, {}).score ?? null,
      thumbUrl: r.thumb_file ? `/api/clips/${r.clip_id}/thumb` : null,
    } : undefined,
  };
}

export function createPost(userId, clipId, platform, scheduledAt = Date.now(), source = 'manual') {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO posts (id, user_id, clip_id, platform, scheduled_at, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, clipId, platform, Math.round(scheduledAt), 'scheduled', source, Date.now());
  return id;
}

function publicVideoUrl(clipId) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) return null;
  const exp = Date.now() + 2 * 3600 * 1000;
  return `${base}/media/${clipId}.mp4?exp=${exp}&sig=${sign(`${clipId}.${exp}`)}`;
}

async function demoPublish(platform, clipId) {
  await sleep(1500);
  const id = `demo${clipId.slice(0, 8)}`;
  const url = { youtube: `https://www.youtube.com/shorts/${id}`, tiktok: `https://www.tiktok.com/@demo/video/${id}`, instagram: `https://www.instagram.com/reel/${id}/` }[platform];
  return { externalId: id, url };
}

const inFlight = new Set();

async function publishOne(post) {
  inFlight.add(post.id);
  db.prepare("UPDATE posts SET status = 'publishing', attempts = attempts + 1 WHERE id = ?").run(post.id);
  try {
    const clipRow = db.prepare('SELECT * FROM clips WHERE id = ?').get(post.clip_id);
    if (!clipRow) throw new Error('Clip was deleted');
    const acc = await freshAccount(post.user_id, post.platform);
    if (!acc) throw Object.assign(new Error(`${PLATFORMS[post.platform].label} account is not connected`), { final: true });
    const clip = { title: clipRow.title, description: clipRow.description, hashtags: json(clipRow.hashtags, []) };
    const file = path.join(CLIPS_DIR, String(post.user_id), clipRow.video_file);
    const result = dryRun()
      ? await demoPublish(post.platform, post.clip_id)
      : await PLATFORMS[post.platform].publish({ acc, clip, file, publicUrl: post.platform === 'instagram' ? publicVideoUrl(post.clip_id) : null });
    const now = Date.now();
    db.prepare("UPDATE posts SET status = 'published', url = ?, external_id = ?, published_at = ?, error = NULL WHERE id = ?")
      .run(result.url || null, result.externalId || null, now, post.id);
    const posted = json(clipRow.posted, {});
    posted[post.platform] = { at: now, url: result.url || null };
    db.prepare('UPDATE clips SET posted = ? WHERE id = ?').run(JSON.stringify(posted), clipRow.id);
  } catch (e) {
    const attempts = post.attempts + 1;
    const retry = !e.final && attempts < 3;
    db.prepare('UPDATE posts SET status = ?, scheduled_at = ?, error = ? WHERE id = ?')
      .run(retry ? 'scheduled' : 'failed', retry ? Date.now() + attempts * 5 * 60000 : post.scheduled_at, String(e.message || e).slice(0, 500), post.id);
    console.error(`publish ${post.platform} ${post.id} failed:`, e.message);
  } finally {
    inFlight.delete(post.id);
  }
}

let ticking = false;
export async function runDuePosts({ wait = false } = {}) {
  if (ticking) return;
  ticking = true;
  try {
    const due = db.prepare("SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 10").all(Date.now())
      .filter((p) => !inFlight.has(p.id)).slice(0, Math.max(0, 3 - inFlight.size));
    const jobs = due.map((p) => publishOne(p));
    if (wait) await Promise.all(jobs);
  } finally {
    ticking = false;
  }
}

// ---------- planner ----------
/** Fill the user's upcoming posting slots (next 7 days) with their best unposted clips. */
export function planUser(userId, now = Date.now()) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return 0;
  const ap = autopublishSettings(user);
  if (!ap.enabled) {
    db.prepare("DELETE FROM posts WHERE user_id = ? AND source = 'auto' AND status = 'scheduled' AND scheduled_at > ?").run(userId, now);
    return 0;
  }
  const connected = new Set(db.prepare('SELECT platform FROM accounts WHERE user_id = ?').all(userId).map((r) => r.platform));
  const clips = db.prepare('SELECT id, viral, posted, created_at FROM clips WHERE user_id = ? AND created_at >= ?')
    .all(userId, now - ap.maxAgeHours * 3600 * 1000)
    .map((c) => ({ id: c.id, score: json(c.viral, {}).score ?? 0, posted: json(c.posted, {}), createdAt: c.created_at }))
    .filter((c) => c.score >= ap.minScore)
    .sort((a, b) => (b.score - a.score) || (b.createdAt - a.createdAt));
  let created = 0;
  for (const [platform, cfg] of Object.entries(ap.platforms)) {
    if (!cfg.enabled || !connected.has(platform)) continue;
    const used = new Set(db.prepare("SELECT clip_id FROM posts WHERE user_id = ? AND platform = ? AND status != 'failed'").all(userId, platform).map((r) => r.clip_id));
    const taken = new Set(db.prepare("SELECT scheduled_at FROM posts WHERE user_id = ? AND platform = ? AND source = 'auto' AND status != 'canceled' AND scheduled_at > ?")
      .all(userId, platform, now).map((r) => r.scheduled_at));
    const queue = clips.filter((c) => !used.has(c.id) && !c.posted[platform]);
    for (let day = 0; day < 7 && queue.length; day++) {
      const { y, m, d, dow } = localDate(now + day * 86400000, ap.timezone);
      if (!cfg.days.includes(dow)) continue;
      for (const t of cfg.times) {
        const [hh, mm] = t.split(':').map(Number);
        const ts = zonedTime(y, m, d, hh, mm, ap.timezone);
        if (ts <= now + 60000 || taken.has(ts) || !queue.length) continue;
        createPost(userId, queue.shift().id, platform, ts, 'auto');
        taken.add(ts);
        created++;
      }
    }
  }
  return created;
}

export function planAll() {
  for (const { id } of db.prepare('SELECT id FROM users').all()) {
    try { planUser(id); } catch (e) { console.error('planner', id, e.message); }
  }
}

export function startScheduler() {
  db.prepare("UPDATE posts SET status = 'scheduled' WHERE status = 'publishing'").run();
  setInterval(() => runDuePosts().catch((e) => console.error('publisher', e)), 20000).unref();
  setInterval(planAll, 5 * 60000).unref();
  planAll();
  runDuePosts();
}

// ---------- HTTP routes ----------
export const router = express.Router();

const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const redirectUri = (req, platform) => `${baseUrl(req)}/connect/${platform}/callback`;

router.get('/connect/:platform', (req, res) => {
  const p = PLATFORMS[req.params.platform];
  if (!p) return res.status(404).send('Unknown platform');
  if (!req.user) return res.redirect(`/login.html?next=${encodeURIComponent('/#settings')}`);
  if (dryRun()) {
    saveAccount(req.user.id, p.id, {
      externalId: `demo-${p.id}`, username: `demo_${p.id}`, displayName: `Demo ${p.label}`, avatar: null,
      accessToken: 'demo', refreshToken: 'demo', expiresAt: Date.now() + 365 * 86400000,
    });
    planUser(req.user.id);
    return res.redirect(`/?connected=${p.id}#settings`);
  }
  if (!p.configured()) return res.redirect(`/?connectError=${encodeURIComponent(`${p.label} is not configured on this server`)}#settings`);
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(`sc_connect_${p.id}`, state, { httpOnly: true, sameSite: 'lax', maxAge: 600000, secure: baseUrl(req).startsWith('https://') });
  res.redirect(p.authUrl(state, redirectUri(req, p.id)));
});

router.get('/connect/:platform/callback', async (req, res) => {
  const p = PLATFORMS[req.params.platform];
  if (!p || !req.user) return res.redirect('/login.html');
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    if (!req.query.state || req.query.state !== parseCookies(req)[`sc_connect_${p.id}`]) throw new Error('Invalid OAuth state, please try again');
    saveAccount(req.user.id, p.id, await p.exchange(String(req.query.code), redirectUri(req, p.id)));
    res.clearCookie(`sc_connect_${p.id}`);
    planUser(req.user.id);
    res.redirect(`/?connected=${p.id}#settings`);
  } catch (e) {
    res.redirect(`/?connectError=${encodeURIComponent(e.message)}#settings`);
  }
});

// Signed, expiring public link so Instagram can pull the video file.
router.get('/media/:id.mp4', (req, res) => {
  const { exp, sig } = req.query;
  if (!exp || Number(exp) < Date.now() || sig !== sign(`${req.params.id}.${exp}`)) return res.status(403).end();
  const r = db.prepare('SELECT user_id, video_file FROM clips WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).end();
  res.sendFile(path.join(CLIPS_DIR, String(r.user_id), r.video_file), { headers: { 'Content-Type': 'video/mp4' } });
});

router.get('/api/accounts', (req, res) => {
  const rows = db.prepare('SELECT platform, username, display_name, avatar, expires_at, updated_at FROM accounts WHERE user_id = ?').all(req.user.id);
  res.json({
    demo: dryRun(),
    accounts: Object.values(PLATFORMS).map((p) => {
      const r = rows.find((x) => x.platform === p.id);
      return {
        platform: p.id, label: p.label, configured: dryRun() || p.configured(), connected: Boolean(r),
        username: r?.username || null, displayName: r?.display_name || null, avatar: r?.avatar || null, connectedAt: r?.updated_at || null,
      };
    }),
  });
});

router.delete('/api/accounts/:platform', (req, res) => {
  db.prepare('DELETE FROM accounts WHERE user_id = ? AND platform = ?').run(req.user.id, req.params.platform);
  db.prepare("DELETE FROM posts WHERE user_id = ? AND platform = ? AND status = 'scheduled' AND source = 'auto'").run(req.user.id, req.params.platform);
  res.json({ ok: true });
});

router.get('/api/autopublish', (req, res) => res.json(autopublishSettings(req.user)));

router.put('/api/autopublish', (req, res) => {
  const next = sanitizeAutopublish(req.body || {}, autopublishSettings(req.user));
  const settings = { ...userSettings(req.user), autopublish: next };
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings), req.user.id);
  // Rebuild the automatic plan with the new slots; manual posts are untouched.
  db.prepare("DELETE FROM posts WHERE user_id = ? AND source = 'auto' AND status = 'scheduled' AND scheduled_at > ?").run(req.user.id, Date.now());
  planUser(req.user.id);
  res.json(next);
});

const postQuery = `SELECT p.*, c.title, c.streamer_login, c.viral, c.thumb_file FROM posts p JOIN clips c ON c.id = p.clip_id`;

router.get('/api/posts', (req, res) => {
  const from = Number(req.query.from) || 0;
  const to = Number(req.query.to) || 8.64e15;
  const rows = req.query.clipId
    ? db.prepare(`${postQuery} WHERE p.user_id = ? AND p.clip_id = ? ORDER BY p.scheduled_at`).all(req.user.id, String(req.query.clipId))
    : db.prepare(`${postQuery} WHERE p.user_id = ? AND p.status != 'canceled' AND COALESCE(p.published_at, p.scheduled_at) BETWEEN ? AND ? ORDER BY p.scheduled_at`).all(req.user.id, from, to);
  res.json(rows.map(postRow));
});

router.post('/api/posts', (req, res) => {
  const { clipId, platform } = req.body || {};
  if (!PLATFORMS[platform]) return res.status(400).json({ error: 'Unknown platform' });
  if (!db.prepare('SELECT 1 FROM clips WHERE id = ? AND user_id = ?').get(clipId, req.user.id)) return res.status(404).json({ error: 'Clip not found' });
  if (!db.prepare('SELECT 1 FROM accounts WHERE user_id = ? AND platform = ?').get(req.user.id, platform)) {
    return res.status(400).json({ error: `Connect your ${PLATFORMS[platform].label} account first (Settings → Connected accounts)` });
  }
  const at = req.body.scheduledAt ? Number(new Date(req.body.scheduledAt)) : Date.now();
  if (!Number.isFinite(at)) return res.status(400).json({ error: 'Invalid time' });
  // Replace any pending post of this clip on this platform.
  db.prepare("UPDATE posts SET status = 'canceled' WHERE user_id = ? AND clip_id = ? AND platform = ? AND status = 'scheduled'").run(req.user.id, clipId, platform);
  const id = createPost(req.user.id, clipId, platform, at, 'manual');
  if (at <= Date.now()) runDuePosts();
  res.json(postRow(db.prepare(`${postQuery} WHERE p.id = ?`).get(id)));
});

function ownPost(req) { return db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id); }

router.patch('/api/posts/:id', (req, res) => {
  const p = ownPost(req);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status !== 'scheduled') return res.status(409).json({ error: `Post is ${p.status}` });
  const at = Number(new Date(req.body.scheduledAt));
  if (!Number.isFinite(at)) return res.status(400).json({ error: 'Invalid time' });
  db.prepare("UPDATE posts SET scheduled_at = ?, source = 'manual' WHERE id = ?").run(Math.round(at), p.id);
  if (at <= Date.now()) runDuePosts();
  res.json(postRow(db.prepare(`${postQuery} WHERE p.id = ?`).get(p.id)));
});

router.post('/api/posts/:id/retry', (req, res) => {
  const p = ownPost(req);
  if (!p) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, attempts = 0, error = NULL WHERE id = ?").run(Date.now(), p.id);
  runDuePosts();
  res.json({ ok: true });
});

router.delete('/api/posts/:id', (req, res) => {
  const p = ownPost(req);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status === 'scheduled') db.prepare("UPDATE posts SET status = 'canceled' WHERE id = ?").run(p.id);
  else if (p.status !== 'publishing') db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  planUser(req.user.id);
  res.json({ ok: true });
});

// Exposed so new uploads are slotted into the plan right away.
export function onClipCreated(userId) { try { planUser(userId); } catch (e) { console.error('planner', e.message); } }
