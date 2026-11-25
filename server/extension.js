// API for the SlientClip Chrome extension: it posts to YouTube from the user's own, already signed-in Chrome,
// so the login never lives (or expires) on the server. The extension pairs once (a token), then polls for due
// posts, claims one, downloads the video, uploads it in a YouTube Studio tab and reports the result.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { db, CLIPS_DIR, userSettings, accessExpired, EXPIRED_MESSAGE } from './db.js';
import { extensionStatus, youtubeRoute } from './social/index.js';
import { viaExtension, recordPublished, recordFailure, planUser } from './publisher.js';

export const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const PLATFORMS = ['youtube'];
// An upload that stops reporting for this long is treated as failed (Chrome closed, laptop asleep…).
const STALE_MS = Number(process.env.EXT_STALE_MIN ?? 15) * 60000;
const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const dryRun = () => process.env.PUBLISH_DRY_RUN === 'true';

/** postId -> { userId, lastAt, pressed } for uploads running in a user's Chrome right now. */
const claims = new Map();

export const router = express.Router();

// The extension calls from its own origin with a bearer token (no cookies), so any origin may read these.
router.use('/api/ext', (req, res, next) => {
  if (req.path === '/pair' || req.path.startsWith('/links')) return next();
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---------- pairing (runs in the signed-in SlientClip page) ----------
router.post('/api/ext/pair', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to SlientClip first, then connect the extension again.' });
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO ext_links (id, user_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, sha(token), String(req.body?.name || 'Chrome').slice(0, 80), Date.now());
  res.json({ token, linkId: id, user: { name: req.user.name, email: req.user.email } });
});

router.get('/api/ext/links', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json(db.prepare('SELECT id, name, version, created_at AS createdAt, last_seen_at AS lastSeenAt FROM ext_links WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id));
});

router.delete('/api/ext/links/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  db.prepare('DELETE FROM ext_links WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- token auth for everything else ----------
router.use('/api/ext', (req, res, next) => {
  const token = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1];
  const link = token && db.prepare('SELECT * FROM ext_links WHERE token_hash = ?').get(sha(token));
  const user = link && db.prepare('SELECT * FROM users WHERE id = ?').get(link.user_id);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'This extension is not connected (or was disconnected). Open SlientClip and connect it again.' });
  if (!link.last_seen_at || Date.now() - link.last_seen_at > 30000) db.prepare('UPDATE ext_links SET last_seen_at = ? WHERE id = ?').run(Date.now(), link.id);
  req.extUser = user;
  req.extLink = link;
  next();
});

const accountView = (userId) => {
  const e = extensionStatus(userId);
  // What the extension shows: YouTube in this Chrome, and whether SlientClip currently sends YouTube posts here.
  return { loggedIn: e.loggedIn, name: e.name, route: youtubeRoute(userId) };
};

router.get('/api/ext/status', (req, res) => {
  const pending = db.prepare("SELECT COUNT(*) n FROM posts WHERE user_id = ? AND platform = 'youtube' AND status = 'scheduled'").get(req.extUser.id).n;
  res.json({ user: { name: req.extUser.name, email: req.extUser.email }, youtube: accountView(req.extUser.id), pending, dryRun: dryRun() });
});

/** The extension reports whether YouTube is signed in in this Chrome (kept on the link, separate from the server login). */
router.post('/api/ext/hello', (req, res) => {
  const { youtube = {}, version, browser } = req.body || {};
  const uid = req.extUser.id;
  const before = extensionStatus(uid).loggedIn;
  const yt = youtube.loggedIn === true ? 1 : youtube.loggedIn === false ? 0 : null;
  db.prepare(`UPDATE ext_links SET version = ?, name = COALESCE(?, name), last_seen_at = ?,
      yt_logged_in = COALESCE(?, yt_logged_in), yt_name = COALESCE(?, yt_name), yt_checked_at = CASE WHEN ? IS NULL THEN yt_checked_at ELSE ? END WHERE id = ?`)
    .run(String(version || '').slice(0, 20) || null, browser ? String(browser).slice(0, 80) : null, Date.now(),
      yt, youtube.name ? String(youtube.name).slice(0, 100) : null, yt, Date.now(), req.extLink.id);
  // Signing in (or out) in that Chrome can change which posts are ready and how auto-publish plans.
  if (before !== extensionStatus(uid).loggedIn) planUser(uid);
  res.json({ ok: true, youtube: accountView(uid) });
});

// ---------- jobs ----------
const ownPost = (req) => db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.extUser.id);

function jobView(p) {
  const c = db.prepare('SELECT * FROM clips WHERE id = ?').get(p.clip_id);
  if (!c) return null;
  const settings = userSettings(db.prepare('SELECT * FROM users WHERE id = ?').get(p.user_id));
  return {
    id: p.id, platform: p.platform, attempt: p.attempts + 1, dryRun: dryRun(),
    clip: { id: c.id, title: c.title, description: c.description, hashtags: json(c.hashtags, []), size: c.size },
    visibility: settings.youtubeVisibility || 'public',
  };
}

router.get('/api/ext/jobs', (req, res) => {
  const uid = req.extUser.id;
  if (accessExpired(req.extUser)) return res.json({ jobs: [], expired: true });
  const due = db.prepare("SELECT * FROM posts WHERE user_id = ? AND status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20").all(uid, Date.now())
    .filter((p) => PLATFORMS.includes(p.platform) && viaExtension(uid, p.platform));
  res.json({ jobs: due.map(jobView).filter(Boolean) });
});

router.post('/api/ext/jobs/:id/claim', (req, res) => {
  if (accessExpired(req.extUser)) return res.status(403).json({ error: EXPIRED_MESSAGE, code: 'expired' });
  const p = ownPost(req);
  if (!p || !PLATFORMS.includes(p.platform)) return res.status(404).json({ error: 'Not found' });
  if (!db.prepare('SELECT 1 FROM clips WHERE id = ?').get(p.clip_id)) {
    recordFailure(p, { message: 'Clip was deleted', final: true }, { attempts: p.attempts + 1 });
    return res.status(410).json({ error: 'Clip was deleted' });
  }
  const r = db.prepare("UPDATE posts SET status = 'publishing', attempts = attempts + 1, step = 'Starting in your Chrome', shot = 0 WHERE id = ? AND status = 'scheduled'").run(p.id);
  if (!r.changes) return res.status(409).json({ error: `Post is ${p.status}` });
  claims.set(p.id, { userId: p.user_id, lastAt: Date.now(), pressed: false });
  res.json({ job: jobView({ ...p, attempts: p.attempts }) });
});

router.post('/api/ext/jobs/:id/step', (req, res) => {
  const p = ownPost(req);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const step = String(req.body?.step || '').slice(0, 120);
  if (step) db.prepare("UPDATE posts SET step = ? WHERE id = ? AND status = 'publishing'").run(step, p.id);
  const c = claims.get(p.id) || { userId: p.user_id, pressed: false };
  claims.set(p.id, { ...c, lastAt: Date.now(), pressed: c.pressed || Boolean(req.body?.final) });
  res.json({ ok: true, status: p.status });
});

router.get('/api/ext/jobs/:id/video', (req, res) => {
  const p = ownPost(req);
  const c = p && db.prepare('SELECT * FROM clips WHERE id = ?').get(p.clip_id);
  if (!c?.video_file) return res.status(404).json({ error: 'Video not found' });
  res.sendFile(path.join(CLIPS_DIR, String(c.user_id), c.video_file));
});

router.post('/api/ext/jobs/:id/result', (req, res) => {
  const p = ownPost(req);
  if (!p) return res.status(404).json({ error: 'Not found' });
  // 'failed' too: a server restart marks running uploads failed, but the browser may still finish them.
  if (!['publishing', 'failed'].includes(p.status)) return res.status(409).json({ error: `Post is ${p.status}` });
  const b = req.body || {};
  const claim = claims.get(p.id);
  claims.delete(p.id);
  if (b.ok) {
    const url = typeof b.url === 'string' && /^https:\/\/(www\.)?(youtube\.com|youtu\.be|studio\.youtube\.com)\//.test(b.url) ? b.url : null;
    recordPublished(p, { url, externalId: String(b.externalId || '').slice(0, 40) || null });
    if (b.channel) db.prepare('UPDATE ext_links SET yt_name = ? WHERE id = ?').run(String(b.channel).slice(0, 100), req.extLink.id);
    db.prepare('UPDATE ext_links SET yt_logged_in = 1, yt_checked_at = ? WHERE id = ?').run(Date.now(), req.extLink.id);
    return res.json({ ok: true });
  }
  const pressed = Boolean(b.pressedPost || claim?.pressed);
  let message = String(b.error || 'The upload failed in your Chrome').slice(0, 400);
  if (b.loggedOut) {
    db.prepare('UPDATE ext_links SET yt_logged_in = 0, yt_checked_at = ? WHERE id = ?').run(Date.now(), req.extLink.id);
    message = 'YouTube is signed out in your Chrome. Sign in on youtube.com in that Chrome, then press Retry.';
  }
  if (pressed) message += ' — stopped after pressing Publish, so it was not retried. Check YouTube Studio before retrying.';
  recordFailure(p, { message, final: Boolean(b.final || b.loggedOut || pressed) }, { attempts: p.attempts, step: p.step });
  res.json({ ok: true });
});

router.delete('/api/ext/link', (req, res) => {
  db.prepare('DELETE FROM ext_links WHERE id = ?').run(req.extLink.id);
  res.json({ ok: true });
});

/** Fail uploads whose browser went quiet, so they don't hang in "publishing" forever. */
export function sweepStaleClaims(now = Date.now()) {
  for (const [id, c] of claims) {
    if (now - c.lastAt < STALE_MS) continue;
    claims.delete(id);
    const p = db.prepare("SELECT * FROM posts WHERE id = ? AND status = 'publishing'").get(id);
    if (!p) continue;
    const msg = `Your Chrome stopped reporting for ${Math.round(STALE_MS / 60000)} minutes (closed, asleep or offline?)`;
    recordFailure(p, { message: c.pressed ? `${msg} — after pressing Publish, so it was not retried. Check YouTube Studio.` : msg, final: c.pressed }, { attempts: p.attempts, step: p.step });
  }
}

export function startExtensionSweeper() {
  setInterval(sweepStaleClaims, 60000).unref();
}

// ---------- download: the extension folder as a zip (stored, no compression needed for a few small files) ----------
function zipDir(dir) {
  const files = [];
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else files.push({ name: `slientclip-extension/${r}`, data: fs.readFileSync(path.join(d, e.name)) });
    }
  };
  walk(dir);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, f.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(f.data.length, 20); cen.writeUInt32LE(f.data.length, 24); cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += 30 + name.length + f.data.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

router.get('/extension.zip', (_req, res) => {
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="slientclip-extension.zip"', 'Cache-Control': 'no-cache' });
  res.send(zipDir(EXT_DIR));
});
