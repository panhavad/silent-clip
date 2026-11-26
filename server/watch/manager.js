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
import { renderServer, extractAudioServer, ffmpegAvailable } from './render.js';
import { transcribeServer } from './transcribe.js';
import { detectCamServer } from './facecam.js';
import { getCam, updateCam } from '../cams.js';
import { needsDetection, resolvePlan, describePlan } from '../../public/js/engine/facecam.js';

/** The streamer-cam plan for a clip: the streamer's saved setting, else a detection on this clip's frames. */
export async function planCam(userId, login, input, offsetSec, durationSec, note = () => {}) {
  const stored = getCam(userId, login);
  let detected = null;
  if (needsDetection(stored)) {
    try {
      detected = await detectCamServer(input, offsetSec, durationSec);
      if (detected.type !== 'none') updateCam(userId, login, { detected });
    } catch (e) {
      note(`Streamer cam detection failed: ${e.message}`);
    }
  }
  const plan = resolvePlan(stored, detected);
  note(describePlan(plan));
  return plan;
}

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
    this.watch = new StreamWatch(this.login, settings, { getChannel, getMasterText: fetchMaster, ...deps }, {
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
        enqueue(() => this.processClip(state, job.moment, data))
          .catch((e) => { Object.assign(state, { stage: 'failed', error: e.message }); this.note(`Clip failed: ${e.message}`); });
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
  async processClip(state, moment, data) {
    const s = this.settings;
    const dir = fs.mkdtempSync(path.join(WORK_DIR, `${this.login}-`));
    try {
      const input = path.join(dir, `source.${data.ext}`);
      fs.writeFileSync(input, data.bytes);
      const meta = buildMetadata({ moment, channel: this.channel, login: this.login });
      let subtitles = [];
      if (s.subtitles) {
        state.stage = 'transcribing';
        try {
          const audio = await extractAudioServer(input, data.offsetSec, data.durationSec);
          const sub = await transcribeServer(audio, data.durationSec, s.subtitleLanguage || meta.viral.language);
          subtitles = sub.phrases;
          meta.viral.transcript = sub.text;
          if (sub.text) meta.description = meta.description.replace('\n\nWatch ', `\n"${sub.text.slice(0, 140)}${sub.text.length > 140 ? '...' : ''}"\n\nWatch `);
        } catch (e) {
          this.note(`Subtitles skipped: ${e.message}`);
        }
      }
      let cam = null;
      if (s.layout === 'facecam') {
        state.stage = 'finding the streamer cam';
        cam = await planCam(this.userId, this.login, input, data.offsetSec, data.durationSec, (m) => this.note(m));
      }
      state.stage = 'rendering';
      const out = await renderServer({
        dir, input, offsetSec: data.offsetSec, durationSec: data.durationSec,
        layout: s.layout, cam, camPosition: s.camPosition, resolution: s.resolution, captions: s.captions,
        caption: meta.caption, subtitles, thumbAt: moment.viralOffset,
      });
      state.stage = 'uploading';
      meta.viral.subtitles = subtitles;
      meta.viral.offsetInClip = +Math.min(data.durationSec, moment.viralOffset).toFixed(1);
      meta.viral.source = { offset: data.offsetSec, duration: data.durationSec, ext: data.ext, layout: s.layout, resolution: s.resolution, cam, camPosition: s.camPosition, rendered: out.layout };
      meta.viral.processedOn = 'server';
      const { sanitizeMeta, insertClip } = await import('../store.js');
      const row = insertClip(this.userId, sanitizeMeta({ ...meta, streamer: this.login, duration: out.duration, width: out.width, height: out.height, sourceExt: data.ext }),
        { video: out.video, thumb: out.thumb, source: s.keepSource ? input : null });
      Object.assign(state, { stage: 'done', progress: 1, clipId: row.id, title: row.title });
      this.note(`Saved clip "${row.title}"`);
      if (row.overwritten.length) this.note(`Storage limit reached: replaced ${row.overwritten.length} oldest clip(s)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  fs.mkdirSync(WORK_DIR, { recursive: true });
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
