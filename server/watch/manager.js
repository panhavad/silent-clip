// Server-side watching: same pipeline as the browser worker (live check, HLS ring buffer, chat
// analysis, clip extraction) but running inside the server, so clipping continues after the
// user closes the web app. Enabled per user with settings.processing = 'server'.
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, DATA_DIR, userSettings, applySettings, onSettingsChanged, serverWatchAllowed, accessExpired } from '../db.js';
import { fetchMaster } from '../twitch.js';
import { getChannel } from '../../public/js/engine/twitch.js';
import { StreamWatch } from '../../public/js/engine/pipeline.js';
import { buildMetadata } from '../../public/js/engine/meta.js';
import { ffmpegAvailable } from './render.js';
import { createClipRunner, ClipWorkerCrash } from './clip-runner.js';
import { getCam, updateCam } from '../cams.js';
import { setActivity, noteWorkerCrash } from '../runstate.js';

// Clip processing (speech-to-text, cam detection, render) runs in a separate worker process; see clip-runner.js.
export const clipRunner = createClipRunner();

const MAX_PER_USER = Number(process.env.MAX_SERVER_STREAMERS || 10);
const MAX_TOTAL = Number(process.env.MAX_SERVER_WATCHERS || 50);
const WORK_DIR = path.join(DATA_DIR, 'tmp', 'server-render');

const watchers = new Map(); // `${userId}:${login}` -> ServerWatcher
const key = (userId, login) => `${userId}:${login}`;

// ---------- one render/transcribe job at a time (CPU bound) ----------
let queue = Promise.resolve();
let queued = 0;
function enqueue(fn) {
  queued++;
  const run = queue.then(fn).finally(() => { queued--; });
  queue = run.catch(() => {});
  return run;
}

// ---------- clips survive restarts ----------
// Each clip waits in QUEUE_DIR/<id>/ (the extracted source + job.json) until it is saved, so a server restart or
// redeploy only delays it: on start the queue is picked up again. A clip that keeps getting cut off is dropped
// after MAX_ATTEMPTS. The chat baseline of every watcher is saved to STATE_DIR so watching continues warm.
const QUEUE_DIR = path.join(DATA_DIR, 'clip-queue');
const STATE_DIR = path.join(DATA_DIR, 'watch-state');
const MAX_ATTEMPTS = 3;
const safe = (s) => String(s).replace(/[^\w.-]/g, '_').slice(0, 120);
const stateFile = (userId, login) => path.join(STATE_DIR, `${userId}-${safe(login)}.json`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

function queueClip(userId, login, job, data, channel) {
  const dir = path.join(QUEUE_DIR, safe(`${userId}-${job.id}`));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `source.${data.ext}`), data.bytes);
  const entry = {
    id: job.id, userId, login, moment: job.moment, channel,
    data: { ext: data.ext, offsetSec: data.offsetSec, durationSec: data.durationSec }, attempts: 0, createdAt: Date.now(),
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(entry));
  return dir;
}

/** Make one queued clip. Progress and notes go to the watcher of that streamer when it is running. */
async function processQueued(dir) {
  const entry = readJson(path.join(dir, 'job.json'));
  if (!entry) { fs.rmSync(dir, { recursive: true, force: true }); return; }
  const w = watchers.get(key(entry.userId, entry.login));
  const note = (m) => w?.note(m);
  const state = w ? (w.jobs.get(entry.id) || { id: entry.id, moment: entry.moment, startedAt: entry.createdAt }) : { id: entry.id };
  if (w) { w.jobs.set(entry.id, state); w.trimJobs(); }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(entry.userId);
  if (!user) { fs.rmSync(dir, { recursive: true, force: true }); return; }
  entry.attempts++;
  if (entry.attempts > MAX_ATTEMPTS) {
    Object.assign(state, { stage: 'failed', error: 'The server kept restarting while this clip was being made' });
    note(`Clip dropped: the server restarted ${MAX_ATTEMPTS} times while it was being made`);
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(entry));
  if (entry.attempts > 1) note('Continuing a clip that was interrupted by a server restart');
  const s = userSettings(user);
  const { moment, data, login } = entry;
  const input = path.join(dir, `source.${data.ext}`);
  try {
    const meta = buildMetadata({ moment, channel: entry.channel, login });
    const job = {
      dir, input, offsetSec: data.offsetSec, durationSec: data.durationSec,
      subtitles: Boolean(s.subtitles), language: s.subtitleLanguage || meta.viral.language,
      layout: s.layout, camStored: s.layout === 'facecam' ? getCam(entry.userId, login) : null, camPosition: s.camPosition,
      resolution: s.resolution, captions: s.captions, caption: meta.caption, thumbAt: moment.viralOffset,
    };
    const hooks = { stage: (st) => { state.stage = st; setActivity(`clip ${login}: ${st}`); }, note };
    setActivity(`clip ${login}: starting`);
    let r;
    try {
      r = await clipRunner.run(job, hooks);
    } catch (e) {
      if (e instanceof ClipWorkerCrash) noteWorkerCrash();
      if (!(e instanceof ClipWorkerCrash) || !job.subtitles) throw e;
      // Speech-to-text needs the most memory: try once more without it.
      note(`${e.message}. Retrying this clip without subtitles.`);
      r = await clipRunner.run({ ...job, subtitles: false }, hooks);
    }
    const { subtitles, transcript, detected, cam, out } = r;
    if (detected && detected.type !== 'none') updateCam(entry.userId, login, { detected });
    if (transcript) {
      meta.viral.transcript = transcript;
      meta.description = meta.description.replace('\n\nWatch ', `\n"${transcript.slice(0, 140)}${transcript.length > 140 ? '...' : ''}"\n\nWatch `);
    }
    state.stage = 'uploading';
    meta.viral.subtitles = subtitles;
    meta.viral.offsetInClip = +Math.min(data.durationSec, moment.viralOffset).toFixed(1);
    meta.viral.source = { offset: data.offsetSec, duration: data.durationSec, ext: data.ext, layout: s.layout, resolution: s.resolution, cam, camPosition: s.camPosition, rendered: out.layout };
    meta.viral.processedOn = 'server';
    const { sanitizeMeta, insertClip } = await import('../store.js');
    // Saved from here on: never make this clip again, even if the server stops right now.
    fs.rmSync(path.join(dir, 'job.json'), { force: true });
    const row = insertClip(entry.userId, sanitizeMeta({ ...meta, streamer: login, duration: out.duration, width: out.width, height: out.height, sourceExt: data.ext }),
      { video: out.video, thumb: out.thumb, source: s.keepSource ? input : null });
    Object.assign(state, { stage: 'done', progress: 1, clipId: row.id, title: row.title });
    note(`Saved clip "${row.title}"`);
    if (row.overwritten.length) note(`Storage limit reached: replaced ${row.overwritten.length} oldest clip(s)`);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    Object.assign(state, { stage: 'failed', error: e.message });
    note(`Clip failed: ${e.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    setActivity('');
  }
}

function enqueueDir(dir) {
  return enqueue(() => processQueued(dir)).catch((e) => console.error('[clip-queue]', e));
}

class ServerWatcher {
  constructor(userId, streamer, settings, deps = {}) {
    this.userId = userId;
    this.login = streamer.login;
    this.displayName = streamer.display_name || streamer.login;
    this.avatar = streamer.avatar;
    this.settings = settings;
    this.stats = null;
    this.log = [];
    this.jobs = new Map();
    this.watch = new StreamWatch(this.login, settings, {
      getChannel, getMasterText: fetchMaster, loadState: () => readJson(stateFile(userId, this.login)), ...deps,
    }, {
      log: (m) => this.note(m),
      status: (_s, message) => { if (message) this.note(message); },
      channel: (ch) => { this.displayName = ch.displayName; this.avatar = ch.avatar; },
      stats: (stats) => { this.stats = stats; },
      moment: (job) => {
        this.jobs.set(job.id, { id: job.id, stage: 'capturing', progress: 0, moment: job.moment, startedAt: Date.now() });
        this.note(job.moment.manual ? 'Manual clip - capturing' : `Viral moment (score ${job.moment.score}) - capturing`);
        this.trimJobs();
      },
      clipFailed: (job, message) => {
        const state = this.jobs.get(job.id);
        if (state) Object.assign(state, { stage: 'failed', error: message });
        this.note(`Clip failed: ${message}`);
      },
      clip: (job, data) => {
        const state = this.jobs.get(job.id) || { id: job.id, moment: job.moment, startedAt: Date.now() };
        this.jobs.set(job.id, state);
        state.stage = 'queued';
        try {
          enqueueDir(queueClip(this.userId, this.login, job, data, this.channel));
        } catch (e) {
          Object.assign(state, { stage: 'failed', error: e.message });
          this.note(`Clip failed: ${e.message}`);
        }
      },
    });
  }

  get status() { return this.watch.status; }
  get channel() { return this.watch.channel; }

  note(message) {
    this.log.unshift({ t: Date.now(), message });
    this.log.length = Math.min(this.log.length, 40);
  }

  start() { this.watch.start(); }
  stop() { this.watch.stop(); }

  configure(settings) {
    this.settings = settings;
    this.watch.configure(settings);
  }

  clipNow() { return this.watch.clipNow(); }

  saveState() {
    const s = this.watch.exportState();
    if (!s) return;
    try { fs.writeFileSync(stateFile(this.userId, this.login), JSON.stringify(s)); } catch { /* best effort */ }
  }

  trimJobs() {
    const list = [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const j of list.slice(10)) this.jobs.delete(j.id);
  }

  snapshot() {
    return {
      login: this.login, displayName: this.displayName, avatar: this.avatar, status: this.status, channel: this.channel,
      stats: this.stats, log: this.log.slice(0, 15), jobs: [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 4),
    };
  }
}

/** The server is stopping (SIGTERM): queue the moments still being captured and save every chat baseline. */
export function shutdownServerWatchers() {
  let flushed = 0;
  for (const w of watchers.values()) {
    try { flushed += w.watch.flushPending(); } catch (e) { console.error('[shutdown] flush', w.login, e.message); }
    w.saveState();
  }
  return flushed;
}
// ---------- lifecycle ----------
function wantedStreamers(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || user.status !== 'active' || accessExpired(user)) return { user, list: [] };
  const s = userSettings(user);
  if (s.processing !== 'server' || !s.serverRunning) return { user, settings: s, list: [] };
  const list = db.prepare('SELECT * FROM streamers WHERE user_id = ? AND enabled = 1 ORDER BY created_at').all(userId).slice(0, MAX_PER_USER);
  return { user, settings: s, list };
}

export function syncUser(userId) {
  const { settings, list } = wantedStreamers(userId);
  const want = new Set(list.map((s) => s.login));
  for (const [k, w] of watchers) {
    if (w.userId === userId && !want.has(w.login)) { w.stop(); watchers.delete(k); }
  }
  for (const s of list) {
    const k = key(userId, s.login);
    if (watchers.has(k)) { watchers.get(k).configure(settings); continue; }
    if (watchers.size >= MAX_TOTAL) break;
    const w = new ServerWatcher(userId, s, settings);
    watchers.set(k, w);
    w.start();
  }
}

export function stopUser(userId) {
  for (const [k, w] of watchers) if (w.userId === userId) { w.stop(); watchers.delete(k); }
}

export function startServerWatchers() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  for (const d of [WORK_DIR, QUEUE_DIR, STATE_DIR]) fs.mkdirSync(d, { recursive: true });
  // Clips left over from before a restart, oldest first.
  const left = fs.readdirSync(QUEUE_DIR).map((n) => path.join(QUEUE_DIR, n))
    .map((d) => ({ d, at: readJson(path.join(d, 'job.json'))?.createdAt ?? 0 })).sort((a, b) => a.at - b.at);
  for (const { d } of left) enqueueDir(d);
  if (left.length) console.log(`[clip-queue] resuming ${left.length} clip(s) from before the restart`);
  setInterval(() => { for (const w of watchers.values()) w.saveState(); }, 20000).unref();
  onSettingsChanged((userId) => syncUser(userId));
  for (const { id } of db.prepare('SELECT id FROM users').all()) syncUser(id);
  // Access can run out while watchers are running: stop those accounts' watchers once their date passes.
  setInterval(() => {
    for (const userId of new Set([...watchers.values()].map((w) => w.userId))) {
      if (accessExpired(db.prepare('SELECT * FROM users WHERE id = ?').get(userId))) stopUser(userId);
    }
  }, 60000).unref();
}

// ---------- API ----------
export const SERVER_WATCH_OFF = 'Watching on the server is turned off for your account. Ask an administrator to enable it.';
export const router = express.Router();

router.get('/api/server-watch', async (req, res) => {
  const s = userSettings(req.user);
  res.json({
    processing: s.processing, running: Boolean(s.serverRunning), allowed: serverWatchAllowed(req.user), available: await ffmpegAvailable(),
    queue: queued, maxStreamers: MAX_PER_USER, host: os.hostname(),
    watchers: [...watchers.values()].filter((w) => w.userId === req.user.id).map((w) => w.snapshot()),
  });
});

router.put('/api/server-watch', async (req, res) => {
  if ((req.body.running || req.body.processing === 'server') && !serverWatchAllowed(req.user)) {
    return res.status(403).json({ error: SERVER_WATCH_OFF });
  }
  if (req.body.running && !(await ffmpegAvailable())) return res.status(503).json({ error: 'Server processing is unavailable: ffmpeg is not installed on the server' });
  const patch = {};
  if (req.body.processing !== undefined) patch.processing = req.body.processing;
  if (req.body.running !== undefined) patch.serverRunning = Boolean(req.body.running);
  const s = applySettings(req.user, patch);
  res.json({ processing: s.processing, running: s.serverRunning });
});

router.post('/api/server-watch/:login/clip', (req, res) => {
  const w = watchers.get(key(req.user.id, String(req.params.login).toLowerCase()));
  if (!w) return res.status(404).json({ error: 'This streamer is not being watched on the server' });
  if (!w.clipNow()) return res.status(409).json({ error: 'Not watching a live stream yet' });
  res.json({ ok: true });
});

// ---------- browser watching (heartbeats from open dashboards) + admin stop commands ----------
// Watching in the browser happens in the user's tab, so the dashboard reports what it watches every few
// seconds and picks up admin commands ({ type: 'stop' } / { type: 'disable', login }) from the reply.
const activity = new Map(); // userId -> { at, running, mode, since, streamers, commands }
export const HEARTBEAT_TTL = 45000;
const clean = (v, n) => String(v ?? '').slice(0, n);

/** Queue a command for the user's open dashboard. Returns false when no dashboard is open. */
export function queueCommand(userId, cmd) {
  const a = activity.get(userId);
  if (!a || Date.now() - a.at > HEARTBEAT_TTL) return false;
  a.commands.push(cmd);
  return true;
}

router.post('/api/watch/heartbeat', (req, res) => {
  const prev = activity.get(req.user.id);
  const delivered = prev?.commands || [];
  // The dashboard acts on commands as soon as it gets them, so don't show what it is about to stop.
  const stopAll = delivered.some((c) => c.type === 'stop');
  const dropped = new Set(delivered.filter((c) => c.type === 'disable').map((c) => c.login));
  const running = Boolean(req.body.running) && req.body.processing !== 'server' && !stopAll;
  const streamers = running && Array.isArray(req.body.streamers)
    ? req.body.streamers.slice(0, 50).map((s) => ({
      login: clean(s.login, 25).toLowerCase(), displayName: clean(s.displayName || s.login, 40), status: clean(s.status, 20),
      live: Boolean(s.live), viewers: Number(s.viewers) || 0, game: clean(s.game, 80),
    })).filter((s) => !dropped.has(s.login))
    : [];
  activity.set(req.user.id, {
    at: Date.now(), running, mode: req.body.mode === 'foreground' ? 'foreground' : 'background',
    since: running ? (prev?.running ? prev.since : Date.now()) : null, streamers, commands: [],
  });
  // Access that ran out (or was renewed) while the dashboard was open: tell it so it can lock or unlock itself.
  const expired = accessExpired(req.user);
  res.json({ commands: expired ? [...delivered, { type: 'stop' }] : delivered, expired, expiresAt: req.user.role === 'admin' ? null : req.user.expires_at || null });
});

/** Everyone watching right now: server watchers plus browsers that reported recently. */
export function watchingOverview() {
  const now = Date.now();
  const byUser = new Map();
  const entry = (id) => { if (!byUser.has(id)) byUser.set(id, { userId: id, server: null, browser: null }); return byUser.get(id); };
  for (const w of watchers.values()) {
    (entry(w.userId).server ||= { streamers: [] }).streamers.push({
      login: w.login, displayName: w.displayName || w.login, status: w.status,
      live: Boolean(w.channel?.live), viewers: w.channel?.viewers || 0, game: w.channel?.game || '',
    });
  }
  for (const [id, a] of activity) {
    if (now - a.at > HEARTBEAT_TTL) { activity.delete(id); continue; }
    if (a.running && a.streamers.length) {
      const stopAll = a.commands.some((c) => c.type === 'stop');
      const disabled = new Set(a.commands.filter((c) => c.type === 'disable').map((c) => c.login));
      entry(id).browser = {
        mode: a.mode, seenAt: a.at, since: a.since, stopping: stopAll,
        streamers: a.streamers.map((s) => ({ ...s, stopping: stopAll || disabled.has(s.login) })),
      };
    }
  }
  return [...byUser.values()];
}
