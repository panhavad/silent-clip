import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR, CLIPS_DIR, userSettings, applySettings, newAccountState, serverWatchAllowed } from './db.js';
import {
  loadUser, requireUser, destroySession, hashPassword, verifyPassword, signIn,
  googleConfigured, googleStart, googleCallback,
} from './auth.js';
import { masterPlaylist } from './twitch.js';
import { router as publisher, startScheduler } from './publisher.js';
import { router as socialRouter, startSessionKeepAlive } from './social/index.js';
import { closeAllSessions } from './social/browser.js';
import { router as admin } from './admin.js';
import { router as backup } from './backup.js';
import { router as serverWatchRouter, startServerWatchers, syncUser } from './watch/manager.js';
import { sanitizeMeta, insertClip, enforceStorageLimit, removeClip, storageUsage } from './store.js';
import { buildInfo } from './version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 300);

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => res.json({ ok: true, ...buildInfo }));

// GitHub push webhook -> forwarded verbatim to the updater sidecar (it verifies the signature).
app.post('/hooks/github', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const target = process.env.UPDATER_URL || 'http://updater:9000/hooks/github';
  try {
    const headers = { 'Content-Type': req.get('content-type') || 'application/json' };
    for (const h of ['x-hub-signature-256', 'x-github-event', 'x-github-delivery']) if (req.get(h)) headers[h] = req.get(h);
    const r = await fetch(target, { method: 'POST', headers, body: req.body });
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ error: `Updater unreachable: ${e.message}` });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(loadUser);

// Static assets (no build step) + client-side ffmpeg.wasm served from node_modules.
const nm = (p) => path.join(ROOT, 'node_modules', p);
const vendorOpts = { maxAge: '7d', immutable: true };
app.use('/vendor/ffmpeg', express.static(nm('@ffmpeg/ffmpeg/dist/esm'), vendorOpts));
app.use('/vendor/ffmpeg-util', express.static(nm('@ffmpeg/util/dist/esm'), vendorOpts));
app.use('/vendor/ffmpeg-core', express.static(nm('@ffmpeg/core/dist/esm'), vendorOpts));
app.use('/vendor/transformers', express.static(nm('@huggingface/transformers/dist'), vendorOpts));
app.use('/vendor/ort', express.static(nm('onnxruntime-web/dist'), vendorOpts));
// App code must revalidate on every load so browsers pick up auto-deployed updates immediately.
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'], setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// ---------- config / auth ----------
app.get('/api/config', (_req, res) => {
  res.json({
    googleLogin: googleConfigured(),
    allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
    build: buildInfo,
  });
});

app.get('/auth/google', googleStart);
app.get('/auth/google/callback', googleCallback);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
app.post('/api/auth/register', (req, res) => {
  if (process.env.ALLOW_REGISTRATION === 'false') return res.status(403).json({ error: 'Registration is disabled' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim() || email.split('@')[0];
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'Email already registered' });
  const { role, status } = newAccountState(email);
  const r = db.prepare('INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email, name, hashPassword(password), role, status, Date.now());
  const err = signIn(res, db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)));
  if (err) return res.status(202).json({ pending: true, message: 'Account created. ' + err });
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  const err = signIn(res, user);
  if (err) return res.status(403).json({ error: err });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });

app.use('/api', requireUser);
// Social accounts (logged-in browser sessions + live viewer), publishing queue and auto-publish schedule.
app.use(socialRouter);
app.use(publisher);
app.use('/api/admin', admin);
app.use(backup);
app.use(serverWatchRouter);

app.get('/api/me', (req, res) => {
  const u = req.user;
  res.json({ id: u.id, email: u.email, name: u.name, avatar: u.avatar, google: Boolean(u.google_id), role: u.role, serverWatch: serverWatchAllowed(u), settings: userSettings(u) });
});

app.put('/api/settings', (req, res) => {
  const next = applySettings(req.user, req.body);
  res.json(next);
});

// ---------- streamers ----------
export function parseTwitchLogin(input) {
  let s = String(input || '').trim();
  const m = s.match(/twitch\.tv\/(?:popout\/)?([A-Za-z0-9_]{2,25})/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{2,25}$/.test(s) && !['videos', 'directory', 'settings', 'p', 'search'].includes(s) ? s : null;
}

const streamerRow = (r) => ({ id: r.id, login: r.login, displayName: r.display_name || r.login, avatar: r.avatar, enabled: Boolean(r.enabled), url: `https://www.twitch.tv/${r.login}` });

app.get('/api/streamers', (req, res) => {
  res.json(db.prepare('SELECT * FROM streamers WHERE user_id = ? ORDER BY created_at').all(req.user.id).map(streamerRow));
});

app.post('/api/streamers', (req, res) => {
  const login = parseTwitchLogin(req.body.url || req.body.login);
  if (!login) return res.status(400).json({ error: 'Enter a Twitch channel link like https://www.twitch.tv/name' });
  db.prepare(`INSERT INTO streamers (user_id, login, display_name, avatar, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(user_id, login) DO UPDATE SET display_name = COALESCE(excluded.display_name, display_name), avatar = COALESCE(excluded.avatar, avatar)`)
    .run(req.user.id, login, req.body.displayName || null, req.body.avatar || null, Date.now());
  syncUser(req.user.id);
  res.json(streamerRow(db.prepare('SELECT * FROM streamers WHERE user_id = ? AND login = ?').get(req.user.id, login)));
});

app.patch('/api/streamers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM streamers WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE streamers SET enabled = ?, display_name = COALESCE(?, display_name), avatar = COALESCE(?, avatar) WHERE id = ?')
    .run(req.body.enabled === undefined ? row.enabled : (req.body.enabled ? 1 : 0), req.body.displayName || null, req.body.avatar || null, row.id);
  syncUser(req.user.id);
  res.json(streamerRow(db.prepare('SELECT * FROM streamers WHERE id = ?').get(row.id)));
});

app.delete('/api/streamers/:id', (req, res) => {
  db.prepare('DELETE FROM streamers WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  syncUser(req.user.id);
  res.json({ ok: true });
});

app.get('/api/twitch/master/:login', masterPlaylist);

// ---------- clips ----------
const TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR, limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 3 } });
const clipFiles = upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumb', maxCount: 1 }, { name: 'source', maxCount: 1 }]);

const userDir = (userId) => { const d = path.join(CLIPS_DIR, String(userId)); fs.mkdirSync(d, { recursive: true }); return d; };
const json = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const cleanupTmp = (req) => Object.values(req.files || {}).flat().forEach((f) => fs.rm(f.path, { force: true }, () => {}));

export function clipRow(r) {
  const posted = json(r.posted, {});
  return {
    id: r.id, streamer: r.streamer_login, title: r.title, description: r.description,
    hashtags: json(r.hashtags, []), caption: r.caption, viral: json(r.viral, {}),
    duration: r.duration, width: r.width, height: r.height, size: r.size,
    hasSource: Boolean(r.source_file), createdAt: r.created_at, downloadedAt: r.downloaded_at, posted,
    isNew: !r.downloaded_at && Object.keys(posted).length === 0,
    videoUrl: `/api/clips/${r.id}/video`, thumbUrl: r.thumb_file ? `/api/clips/${r.id}/thumb` : null,
  };
}

function storeFile(req, field, dest) {
  const f = req.files?.[field]?.[0];
  if (!f) return null;
  fs.renameSync(f.path, dest);
  return path.basename(dest);
}

app.post('/api/clips', clipFiles, (req, res) => {
  try {
    if (!req.files?.video?.[0]) return res.status(400).json({ error: 'Missing video' });
    const meta = sanitizeMeta(json(req.body.meta, {}) || {});
    if (!meta.streamer) return res.status(400).json({ error: 'Missing streamer' });
    const row = insertClip(req.user.id, meta, {
      video: req.files.video[0].path, thumb: req.files.thumb?.[0]?.path, source: req.files.source?.[0]?.path,
    });
    res.json({ ...clipRow(row), overwritten: row.overwritten.length });
  } finally { cleanupTmp(req); }
});

const getClip = (req) => db.prepare('SELECT * FROM clips WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

app.get('/api/clips', (req, res) => {
  const rows = db.prepare('SELECT * FROM clips WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id).map(clipRow);
  const scheduled = {};
  for (const p of db.prepare("SELECT clip_id, platform, scheduled_at, status FROM posts WHERE user_id = ? AND status IN ('scheduled', 'publishing')").all(req.user.id)) {
    (scheduled[p.clip_id] ||= []).push({ platform: p.platform, at: p.scheduled_at, status: p.status });
  }
  const counts = { all: rows.length, new: 0, downloaded: 0, posted: 0 };
  for (const c of rows) {
    c.scheduled = scheduled[c.id] || [];
    if (c.isNew) counts.new++;
    if (c.downloadedAt) counts.downloaded++;
    if (Object.keys(c.posted).length) counts.posted++;
  }
  const f = req.query.filter;
  const filtered = rows.filter((c) => (f === 'new' ? c.isNew : f === 'downloaded' ? c.downloadedAt : f === 'posted' ? Object.keys(c.posted).length : true));
  res.json({ clips: filtered, counts, storage: storageUsage(req.user.id) });
});

app.get('/api/clips/:id', (req, res) => {
  const r = getClip(req);
  return r ? res.json(clipRow(r)) : res.status(404).json({ error: 'Not found' });
});

app.patch('/api/clips/:id', (req, res) => {
  const r = getClip(req);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const m = sanitizeMeta({ ...clipRow(r), ...req.body, streamer: r.streamer_login });
  db.prepare('UPDATE clips SET title = ?, description = ?, hashtags = ?, caption = ? WHERE id = ?')
    .run(m.title, m.description, JSON.stringify(m.hashtags), m.caption, r.id);
  res.json(clipRow(getClip(req)));
});

// Replace the rendered video after the user re-renders captions in the browser.
app.put('/api/clips/:id/video', clipFiles, (req, res) => {
  try {
    const r = getClip(req);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (!req.files?.video?.[0]) return res.status(400).json({ error: 'Missing video' });
    const dir = userDir(req.user.id);
    const size = req.files.video[0].size;
    storeFile(req, 'video', path.join(dir, r.video_file));
    const thumb = storeFile(req, 'thumb', path.join(dir, `${r.id}.jpg`)) || r.thumb_file;
    const caption = req.body.caption !== undefined ? String(req.body.caption).slice(0, 500) : r.caption;
    const viral = json(r.viral, {});
    if (req.body.subtitles !== undefined) {
      const subs = json(req.body.subtitles, []);
      viral.subtitles = Array.isArray(subs)
        ? subs.slice(0, 200).map((s) => ({ text: String(s.text || '').slice(0, 120), start: Number(s.start) || 0, end: Number(s.end) || 0 }))
        : [];
    }
    if (req.body.transcript !== undefined) viral.transcript = String(req.body.transcript).slice(0, 5000);
    db.prepare('UPDATE clips SET size = ?, thumb_file = ?, caption = ?, viral = ? WHERE id = ?').run(size, thumb, caption, JSON.stringify(viral), r.id);
    // A re-render can grow the clip, so the storage limit applies here too.
    enforceStorageLimit(req.user.id, r.id);
    res.json(clipRow(getClip(req)));
  } finally { cleanupTmp(req); }
});

app.delete('/api/clips/:id', (req, res) => {
  const r = getClip(req);
  if (!r) return res.status(404).json({ error: 'Not found' });
  removeClip(r);
  res.json({ ok: true });
});

function sendClipFile(field, opts = {}) {
  return (req, res) => {
    const r = getClip(req);
    if (!r || !r[field]) return res.status(404).json({ error: 'Not found' });
    if (opts.markDownloaded) db.prepare('UPDATE clips SET downloaded_at = COALESCE(downloaded_at, ?) WHERE id = ?').run(Date.now(), r.id);
    const file = path.join(userDir(req.user.id), r[field]);
    if (opts.attachment) {
      const base = (r.title || r.id).replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || r.id;
      return res.download(file, `${base}${path.extname(file)}`);
    }
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=60' } });
  };
}

app.get('/api/clips/:id/video', sendClipFile('video_file'));
app.get('/api/clips/:id/thumb', sendClipFile('thumb_file'));
app.get('/api/clips/:id/source', sendClipFile('source_file'));
app.get('/api/clips/:id/download', sendClipFile('video_file', { attachment: true, markDownloaded: true }));

const PLATFORMS = ['youtube', 'tiktok', 'instagram'];
app.post('/api/clips/:id/mark', (req, res) => {
  const r = getClip(req);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const { action, platform, url } = req.body;
  const posted = json(r.posted, {});
  if (action === 'downloaded') {
    db.prepare('UPDATE clips SET downloaded_at = COALESCE(downloaded_at, ?) WHERE id = ?').run(Date.now(), r.id);
  } else if (action === 'posted' && PLATFORMS.includes(platform)) {
    posted[platform] = { at: Date.now(), url: typeof url === 'string' && /^https?:\/\//.test(url) ? url : null };
    db.prepare('UPDATE clips SET posted = ? WHERE id = ?').run(JSON.stringify(posted), r.id);
  } else if (action === 'unposted' && PLATFORMS.includes(platform)) {
    delete posted[platform];
    db.prepare('UPDATE clips SET posted = ? WHERE id = ?').run(JSON.stringify(posted), r.id);
  } else if (action === 'new') {
    db.prepare("UPDATE clips SET downloaded_at = NULL, posted = '{}' WHERE id = ?").run(r.id);
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }
  res.json(clipRow(getClip(req)));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500)).json({ error: err.message || 'Server error' });
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = app.listen(PORT, () => console.log(`slientclip ${buildInfo.label} listening on :${PORT}`));
  startScheduler();
  startServerWatchers();
  startSessionKeepAlive();
  // Docker stops/redeploys with SIGTERM. Close the social browsers cleanly first: a killed Chrome loses the
  // login cookies Google rotated in the last minute, and reusing the old ones makes Google sign it out.
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${sig}: closing browsers…`);
    server.close();
    const timer = setTimeout(() => process.exit(0), 8000);
    timer.unref();
    await closeAllSessions().catch((e) => console.error('[shutdown] closing browsers failed:', e.message));
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
