// Publishing queue + auto-publish planner. Each post is performed by a real, logged-in browser
// (see server/social/) — the server opens the platform's upload page and posts like a person would.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, CLIPS_DIR, HISTORY_THUMBS_DIR, userSettings, accessExpired } from './db.js';
import { pruneHistoryThumb } from './store.js';
import { DRIVERS, connectedPlatforms, getAccount, publishWithBrowser, saveShot, SHOTS_DIR } from './social/index.js';
import { sleep } from './social/human.js';
import { slotsForDay, dayKeyOf, toMinutes } from '../public/js/engine/slots.js';

export const PLATFORMS = DRIVERS;
const dryRun = () => process.env.PUBLISH_DRY_RUN === 'true';
const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const MAX_BROWSERS = Math.max(1, Number(process.env.MAX_PUBLISH_BROWSERS || 2));

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
  seed: '',
  // mode 'random': `perDay` posts at system-picked times between `from` and `to` (different every day);
  // mode 'times': at the fixed `times`.
  platforms: {
    youtube: { enabled: true, mode: 'random', perDay: 2, from: '10:00', to: '22:00', times: ['12:00', '18:00'], days: [0, 1, 2, 3, 4, 5, 6] },
    tiktok: { enabled: true, mode: 'random', perDay: 3, from: '10:00', to: '22:00', times: ['11:00', '16:00', '20:00'], days: [0, 1, 2, 3, 4, 5, 6] },
    instagram: { enabled: true, mode: 'random', perDay: 2, from: '10:00', to: '22:00', times: ['13:00', '19:00'], days: [0, 1, 2, 3, 4, 5, 6] },
  },
};

export function autopublishSettings(user) {
  const s = userSettings(user).autopublish || {};
  const out = { ...DEFAULT_AUTOPUBLISH, ...s, platforms: {} };
  for (const p of Object.keys(PLATFORMS)) {
    const saved = s.platforms?.[p] || {};
    out.platforms[p] = { ...DEFAULT_AUTOPUBLISH.platforms[p], ...saved };
    // Schedules saved before random times existed keep their fixed times.
    if (saved.times && !saved.mode) out.platforms[p].mode = 'times';
  }
  return out;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeAutopublish(body, current) {
  const out = { ...current, platforms: { ...current.platforms } };
  if ('enabled' in body) out.enabled = Boolean(body.enabled);
  if (body.timezone && validTz(body.timezone)) out.timezone = body.timezone;
  if ('minScore' in body) out.minScore = Math.min(99, Math.max(0, Number(body.minScore) || 0));
  if ('maxAgeHours' in body) out.maxAgeHours = Math.min(24 * 30, Math.max(1, Number(body.maxAgeHours) || 72));
  if ('seed' in body) out.seed = String(body.seed || '').replace(/[^\w-]/g, '').slice(0, 32);
  if (!out.seed) out.seed = crypto.randomBytes(6).toString('hex');
  for (const p of Object.keys(PLATFORMS)) {
    const src = body.platforms?.[p];
    if (!src) continue;
    const cur = { ...out.platforms[p] };
    if ('enabled' in src) cur.enabled = Boolean(src.enabled);
    if (src.mode === 'random' || src.mode === 'times') cur.mode = src.mode;
    else if (Array.isArray(src.times)) cur.mode = 'times'; // older clients / backups only know fixed times
    if ('perDay' in src) cur.perDay = Math.min(24, Math.max(1, Math.round(Number(src.perDay)) || 1));
    if (HHMM.test(src.from)) cur.from = src.from;
    if (HHMM.test(src.to)) cur.to = src.to;
    if (Array.isArray(src.times)) cur.times = [...new Set(src.times.map(String).filter((t) => HHMM.test(t)))].sort().slice(0, 12);
    if (Array.isArray(src.days)) cur.days = [...new Set(src.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    // The window needs room for the posts: at least 15 minutes each.
    if (toMinutes(cur.to) <= toMinutes(cur.from)) throw Object.assign(new Error(`${PLATFORMS[p].label}: the "until" time must be later than the "from" time`), { status: 400 });
    cur.perDay = Math.min(cur.perDay, Math.floor((toMinutes(cur.to) - toMinutes(cur.from)) / 15));
    out.platforms[p] = cur;
  }
  return out;
}

// ---------- posts ----------
const liveByPost = new Map(); // postId -> { sessionId, step }

function postRow(r) {
  const live = liveByPost.get(r.id);
  return {
    id: r.id, clipId: r.clip_id, platform: r.platform, scheduledAt: r.scheduled_at, status: r.status, source: r.source,
    attempts: r.attempts, error: r.error, url: r.url, publishedAt: r.published_at,
    step: live?.step || r.step || null, sessionId: live?.sessionId || null,
    screenshotUrl: r.shot ? `/api/posts/${r.id}/screenshot` : null,
    clipDeleted: r.title === null && r.clip_title !== undefined,
    clip: r.title !== undefined ? (r.title !== null ? {
      title: r.title, streamer: r.streamer_login, score: json(r.viral, {}).score ?? null,
      thumbUrl: r.thumb_file ? `/api/clips/${r.clip_id}/thumb` : null,
    } : {
      // The clip was deleted: show what was saved from it.
      title: r.clip_title || '(deleted clip)', streamer: r.clip_streamer || '', score: r.clip_score ?? null,
      thumbUrl: r.clip_thumb ? `/api/posts/${r.id}/thumb` : null,
    }) : undefined,
  };
}

export function createPost(userId, clipId, platform, scheduledAt = Date.now(), source = 'manual') {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO posts (id, user_id, clip_id, platform, scheduled_at, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, clipId, platform, Math.round(scheduledAt), 'scheduled', source, Date.now());
  return id;
}

async function demoPublish(platform, clipId, step) {
  for (const s of ['Opening the uploader (demo)', 'Uploading video (demo)', 'Writing caption (demo)', 'Posting (demo)']) { step(s); await sleep(400); }
  const id = `demo${clipId.slice(0, 8)}`;
  const url = { youtube: `https://www.youtube.com/shorts/${id}`, tiktok: `https://www.tiktok.com/@demo/video/${id}`, instagram: `https://www.instagram.com/reel/${id}/` }[platform];
  return { externalId: id, url };
}

const inFlight = new Set();
const busyProfiles = new Set();

export const EXT_WAITING = 'Waiting for your Chrome (SlientClip extension)';
export const EXPIRED_STEP = 'Paused: account access expired';
export const viaExtension = (userId, platform) => getAccount(userId, platform)?.method === 'extension';

async function publishOne(post) {
  inFlight.add(post.id);
  const profile = `${post.user_id}:${post.platform}`;
  busyProfiles.add(profile);
  const live = { sessionId: null, step: 'Starting' };
  liveByPost.set(post.id, live);
  db.prepare("UPDATE posts SET status = 'publishing', attempts = attempts + 1, step = ?, shot = 0 WHERE id = ?").run(live.step, post.id);
  const step = (t) => { live.step = t; db.prepare('UPDATE posts SET step = ? WHERE id = ?').run(t, post.id); };
  try {
    const clipRow = db.prepare('SELECT * FROM clips WHERE id = ?').get(post.clip_id);
    if (!clipRow) throw Object.assign(new Error('Clip was deleted'), { final: true });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(post.user_id);
    const acc = getAccount(post.user_id, post.platform);
    if (!acc?.loggedIn) throw Object.assign(new Error(`Not logged in to ${PLATFORMS[post.platform].label}. Log in under Settings → Social accounts.`), { final: true });
    const clip = { title: clipRow.title, description: clipRow.description, hashtags: json(clipRow.hashtags, []) };
    const file = path.join(CLIPS_DIR, String(post.user_id), clipRow.video_file);
    if (!fs.existsSync(file)) throw Object.assign(new Error('The clip video file is missing on the server'), { final: true });
    const result = dryRun() || acc.demo
      ? await demoPublish(post.platform, post.clip_id, step)
      : await publishWithBrowser({ user, platform: post.platform, file, clip, onStep: step, onSession: (id) => { live.sessionId = id; } });
    recordPublished(post, result);
  } catch (e) {
    // A busy profile (user is logging in) doesn't count as a failed attempt.
    if (e.busy) {
      db.prepare("UPDATE posts SET status = 'scheduled', attempts = attempts - 1, scheduled_at = ?, step = ? WHERE id = ?").run(Date.now() + 60000, 'Waiting: the account browser is in use', post.id);
      return;
    }
    recordFailure(post, e, { attempts: post.attempts + 1, step: live.step, shot: saveShot(post.id, e.screenshot) ? 1 : 0 });
  } finally {
    inFlight.delete(post.id);
    busyProfiles.delete(profile);
    liveByPost.delete(post.id);
  }
}

/** A post went out: store its link and mark the clip as posted on that platform. */
export function recordPublished(post, result = {}) {
  const now = Date.now();
  db.prepare("UPDATE posts SET status = 'published', url = ?, external_id = ?, published_at = ?, finished_at = ?, error = NULL, step = 'Posted' WHERE id = ?")
    .run(result.url || null, result.externalId || null, now, now, post.id);
  const clipRow = db.prepare('SELECT posted FROM clips WHERE id = ?').get(post.clip_id);
  if (!clipRow) return;
  const posted = json(clipRow.posted, {});
  posted[post.platform] = { at: now, url: result.url || null };
  db.prepare('UPDATE clips SET posted = ? WHERE id = ?').run(JSON.stringify(posted), post.clip_id);
}

/** A post attempt failed: retry later (up to 3 attempts) unless the error is final. */
export function recordFailure(post, e, { attempts, step = null, shot = 0 } = {}) {
  const retry = !e.final && attempts < 3;
  db.prepare('UPDATE posts SET status = ?, scheduled_at = ?, error = ?, shot = ?, step = ?, finished_at = ? WHERE id = ?')
    .run(retry ? 'scheduled' : 'failed', retry ? Date.now() + attempts * 5 * 60000 : post.scheduled_at,
      `${String(e.message || e).slice(0, 480)}${retry ? ` (retrying, attempt ${attempts}/3)` : ''}`, shot, step, Date.now(), post.id);
  console.error(`publish ${post.platform} ${post.id} failed:`, e.message || e);
}

let ticking = false;
export async function runDuePosts({ wait = false } = {}) {
  if (ticking) return;
  ticking = true;
  try {
    const due = db.prepare("SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 200").all(Date.now());
    const jobs = [];
    const claimed = new Set(busyProfiles);
    for (const p of due) {
      if (inFlight.size + jobs.length >= MAX_BROWSERS) break;
      // Expired accounts' posts wait (nothing is posted) until an admin renews the access.
      if (accessExpired(db.prepare('SELECT role, expires_at FROM users WHERE id = ?').get(p.user_id))) {
        db.prepare('UPDATE posts SET step = ? WHERE id = ? AND step IS NOT ?').run(EXPIRED_STEP, p.id, EXPIRED_STEP);
        continue;
      }
      // Posts for an account connected through the Chrome extension are picked up by the user's own browser.
      if (viaExtension(p.user_id, p.platform)) {
        db.prepare('UPDATE posts SET step = ? WHERE id = ? AND step IS NOT ?').run(EXT_WAITING, p.id, EXT_WAITING);
        continue;
      }
      const profile = `${p.user_id}:${p.platform}`;
      // One browser per account at a time; the next post for it waits for the following tick.
      if (inFlight.has(p.id) || claimed.has(profile)) continue;
      claimed.add(profile);
      jobs.push(publishOne(p));
    }
    if (wait) await Promise.all(jobs);
  } finally {
    ticking = false;
  }
}

// ---------- planner ----------
/** Fill the user's upcoming posting slots (next 7 days) with their best unposted clips. */
export function planUser(userId, now = Date.now()) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || accessExpired(user, now)) return 0;
  const ap = autopublishSettings(user);
  if (!ap.enabled) {
    db.prepare("DELETE FROM posts WHERE user_id = ? AND source = 'auto' AND status = 'scheduled' AND scheduled_at > ?").run(userId, now);
    return 0;
  }
  const connected = new Set(connectedPlatforms(userId));
  const clips = db.prepare('SELECT id, viral, posted, created_at FROM clips WHERE user_id = ? AND created_at >= ? AND published_at IS NULL')
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
      for (const t of slotsForDay(cfg, { dayKey: dayKeyOf(y, m, d), platform, seed: ap.seed })) {
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
  // The browser may already have pressed Post before the restart, so don't repeat it blindly.
  db.prepare("UPDATE posts SET status = 'failed', finished_at = ?, error = 'Interrupted by a server restart. Check the platform, then press Retry if it was not posted.' WHERE status = 'publishing'").run(Date.now());
  setInterval(() => runDuePosts().catch((e) => console.error('publisher', e)), 20000).unref();
  setInterval(planAll, 5 * 60000).unref();
  planAll();
  runDuePosts();
}

// ---------- HTTP routes ----------
export const router = express.Router();

router.get('/api/autopublish', (req, res) => res.json(autopublishSettings(req.user)));

router.put('/api/autopublish', (req, res) => {
  let next;
  try { next = sanitizeAutopublish(req.body || {}, autopublishSettings(req.user)); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const settings = { ...userSettings(req.user), autopublish: next };
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings), req.user.id);
  // Rebuild the automatic plan with the new slots; manual posts are untouched.
  db.prepare("DELETE FROM posts WHERE user_id = ? AND source = 'auto' AND status = 'scheduled' AND scheduled_at > ?").run(req.user.id, Date.now());
  planUser(req.user.id);
  res.json(next);
});

// LEFT JOIN: posts of a deleted clip stay in the schedule as history (c.title is then NULL).
const postQuery = `SELECT p.*, c.title, c.streamer_login, c.viral, c.thumb_file FROM posts p LEFT JOIN clips c ON c.id = p.clip_id`;

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
  if (!connectedPlatforms(req.user.id).includes(platform)) {
    return res.status(400).json({ error: `Log in to ${PLATFORMS[platform].label} first (Settings → Social accounts)` });
  }
  const at = req.body.scheduledAt ? Number(new Date(req.body.scheduledAt)) : Date.now();
  if (!Number.isFinite(at)) return res.status(400).json({ error: 'Invalid time' });
  if (at > Date.now() + 60000 && db.prepare('SELECT published_at FROM clips WHERE id = ?').get(clipId)?.published_at) {
    return res.status(409).json({ error: 'This clip is marked as published, so it isn\'t scheduled. Unmark it first.' });
  }
  // Replace any pending post of this clip on this platform.
  db.prepare("UPDATE posts SET status = 'canceled' WHERE user_id = ? AND clip_id = ? AND platform = ? AND status = 'scheduled'").run(req.user.id, clipId, platform);
  const id = createPost(req.user.id, clipId, platform, at, 'manual');
  if (at <= Date.now()) runDuePosts();
  res.json(postRow(db.prepare(`${postQuery} WHERE p.id = ?`).get(id)));
});

function ownPost(req) { return db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id); }

// Attempts that finished since `since` (posted, failed, or failed-and-will-retry), so the app can report background results.
router.get('/api/posts/results', (req, res) => {
  const since = Number(req.query.since) || Date.now() - 60000;
  const rows = db.prepare(`${postQuery} WHERE p.user_id = ? AND p.finished_at > ? AND p.status != 'canceled' ORDER BY p.finished_at`).all(req.user.id, since);
  res.json(rows.map((r) => ({ ...postRow(r), finishedAt: r.finished_at })));
});

router.get('/api/posts/live', (req, res) => {
  const rows = db.prepare(`${postQuery} WHERE p.user_id = ? AND p.status = 'publishing'`).all(req.user.id);
  res.json(rows.map(postRow));
});

router.get('/api/posts/:id/screenshot', (req, res) => {
  const p = ownPost(req);
  if (!p?.shot) return res.status(404).end();
  res.set('Cache-Control', 'no-store').sendFile(path.join(SHOTS_DIR, `${p.id}.jpg`));
});

router.get('/api/posts/:id/thumb', (req, res) => {
  const p = ownPost(req);
  if (!p?.clip_thumb) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400').sendFile(path.join(HISTORY_THUMBS_DIR, String(p.user_id), p.clip_thumb), (e) => { if (e && !res.headersSent) res.status(404).end(); });
});

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
  if (!db.prepare('SELECT 1 FROM clips WHERE id = ?').get(p.clip_id)) return res.status(409).json({ error: 'The clip was deleted, so it can\'t be posted again. This entry is kept as history.' });
  db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, attempts = 0, error = NULL, shot = 0, step = NULL WHERE id = ?").run(Date.now(), p.id);
  runDuePosts();
  res.json({ ok: true });
});

router.delete('/api/posts/:id', (req, res) => {
  const p = ownPost(req);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.status === 'scheduled') db.prepare("UPDATE posts SET status = 'canceled' WHERE id = ?").run(p.id);
  else if (p.status !== 'publishing') db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  pruneHistoryThumb(p.user_id, p.clip_id);
  planUser(req.user.id);
  res.json({ ok: true });
});

// Exposed so new uploads are slotted into the plan right away.
export function onClipCreated(userId) { try { planUser(userId); } catch (e) { console.error('planner', e.message); } }
