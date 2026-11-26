import { buildMetadata } from './meta.js';
import { renderClip } from './render.js';
import { autoSubtitles } from './transcribe.js';
import { planCam } from './cam.js';
import { describePlan } from './facecam.js';

const WORKER_URL = new URL('./watcher.worker.js', import.meta.url);

/**
 * Hosts one watcher worker per streamer in the current page. Web Locks guarantee a streamer
 * is only watched by one window/tab at a time, so foreground windows and the background
 * dashboard can run side by side without duplicate clips.
 */
export class WatcherManager extends EventTarget {
  constructor({ settings, userId, label = 'background' }) {
    super();
    this.settings = settings;
    this.userId = userId;
    this.label = label;
    this.state = new Map();
    this.running = false;
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  #changed(login) { this.#emit('update', { login, state: this.state.get(login) }); }

  log(login, message) {
    const st = this.state.get(login);
    if (!st) return;
    st.log.unshift({ t: Date.now(), message });
    st.log.length = Math.min(st.log.length, 40);
    this.#changed(login);
  }

  start(streamers) {
    this.running = true;
    const wanted = new Map(streamers.map((s) => [s.login, s]));
    for (const login of [...this.state.keys()]) if (!wanted.has(login)) this.#stopOne(login);
    for (const [login, s] of wanted) {
      if (this.state.has(login)) continue;
      this.state.set(login, {
        login, displayName: s.displayName || login, avatar: s.avatar, status: 'starting', channel: null,
        stats: null, log: [], jobs: new Map(), worker: null, release: null, retry: null,
      });
      this.#acquire(login);
    }
    this.#emit('update', {});
  }

  stop() {
    this.running = false;
    for (const login of [...this.state.keys()]) this.#stopOne(login);
    this.#emit('update', {});
  }

  #stopOne(login) {
    const st = this.state.get(login);
    if (!st) return;
    clearTimeout(st.retry);
    st.worker?.postMessage({ type: 'stop' });
    st.worker = null;
    st.release?.();
    this.state.delete(login);
  }

  updateSettings(settings) {
    this.settings = settings;
    for (const st of this.state.values()) st.worker?.postMessage({ type: 'settings', settings });
  }

  clipNow(login) {
    const st = this.state.get(login);
    if (!st?.worker) return false;
    st.worker.postMessage({ type: 'clipNow' });
    this.log(login, 'Manual clip requested (last 20s + next 10s)');
    return true;
  }

  #acquire(login) {
    const st = this.state.get(login);
    if (!st) return;
    if (!navigator.locks) { this.#spawn(login); return; }
    navigator.locks.request(`slientclip:${this.userId}:${login}`, { ifAvailable: true }, (lock) => {
      const cur = this.state.get(login);
      if (cur !== st) return undefined;
      if (!lock) {
        st.status = 'elsewhere';
        this.#changed(login);
        st.retry = setTimeout(() => this.#acquire(login), 15000);
        return undefined;
      }
      this.#spawn(login);
      return new Promise((resolve) => { st.release = resolve; });
    });
  }

  #spawn(login) {
    const st = this.state.get(login);
    const worker = new Worker(WORKER_URL, { type: 'module', name: `watch-${login}` });
    st.worker = worker;
    st.status = 'checking';
    worker.onmessage = ({ data }) => this.#onWorker(login, data);
    worker.onerror = (e) => { st.status = 'error'; this.log(login, `Worker error: ${e.message}`); };
    worker.postMessage({ type: 'start', login, settings: this.settings });
    this.#changed(login);
  }

  #onWorker(login, msg) {
    const st = this.state.get(login);
    if (!st) return;
    switch (msg.type) {
      case 'status':
        st.status = msg.status;
        if (msg.channel) { st.channel = msg.channel; st.displayName = msg.channel.displayName; st.avatar = msg.channel.avatar; }
        if (msg.message) this.log(login, msg.message);
        else this.#changed(login);
        break;
      case 'channel': st.channel = msg.channel; this.#changed(login); break;
      case 'stats': st.stats = msg.stats; this.#emit('stats', { login, stats: msg.stats }); break;
      case 'log': this.log(login, msg.message); break;
      case 'moment':
        st.jobs.set(msg.id, { id: msg.id, stage: 'capturing', progress: 0, moment: msg.moment, startedAt: Date.now() });
        this.log(login, `${msg.moment.manual ? 'Manual clip' : `Viral moment (score ${msg.moment.score})`} - capturing next ${msg.readyIn}s`);
        break;
      case 'clipFailed': {
        const job = st.jobs.get(msg.id);
        if (job) { job.stage = 'failed'; job.error = msg.message; }
        this.log(login, `Clip failed: ${msg.message}`);
        break;
      }
      case 'clip': this.#processClip(st, msg); break;
      default: break;
    }
  }

  async #processClip(st, msg) {
    const { login } = st;
    const job = st.jobs.get(msg.id) || { id: msg.id, moment: msg.moment };
    st.jobs.set(msg.id, job);
    Object.assign(job, { stage: 'rendering', progress: 0, moment: msg.moment });
    this.#changed(login);
    const s = this.settings;
    try {
      const meta = buildMetadata({ moment: msg.moment, channel: msg.channel || st.channel, login });
      const { bytes, ext, offsetSec, durationSec } = msg.data;
      const source = s.keepSource ? new Blob([bytes], { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' }) : null;
      let subtitles = [];
      if (s.subtitles) {
        job.stage = 'transcribing';
        this.#changed(login);
        try {
          const sub = await autoSubtitles({
            bytes, ext, offsetSec, durationSec, language: s.subtitleLanguage || meta.viral.language,
            onProgress: (p) => { job.progress = p; this.#emit('job', { login, job }); },
          });
          subtitles = sub.phrases;
          meta.viral.transcript = sub.text;
          if (sub.text) meta.description = meta.description.replace('\n\nWatch ', `\n🗣️ "${sub.text.slice(0, 140)}${sub.text.length > 140 ? '…' : ''}"\n\nWatch `);
        } catch (e) {
          this.log(login, `Subtitles skipped: ${e?.message || e}`);
        }
        job.stage = 'rendering';
        job.progress = 0;
        this.#changed(login);
      }
      meta.viral.subtitles = subtitles;
      let cam = null;
      if (s.layout === 'facecam') {
        job.stage = 'finding the streamer cam';
        this.#changed(login);
        cam = await planCam(login, { bytes, ext, offsetSec, durationSec }, { log: (m) => this.log(login, m) });
        this.log(login, describePlan(cam));
        job.stage = 'rendering';
        this.#changed(login);
      }
      const out = await renderClip({
        bytes, ext, offsetSec, durationSec, layout: s.layout, cam, resolution: s.resolution,
        captions: s.captions, caption: s.captions ? meta.caption : '',
        subtitles, thumbAt: msg.moment.viralOffset,
        onProgress: (p) => { job.progress = p; this.#emit('job', { login, job }); },
      });
      job.stage = 'uploading';
      this.#changed(login);
      meta.viral.offsetInClip = +Math.min(durationSec, msg.moment.viralOffset).toFixed(1);
      meta.viral.source = { offset: offsetSec, duration: durationSec, ext, layout: s.layout, resolution: s.resolution, cam, rendered: out.layout };
      const form = new FormData();
      form.append('meta', JSON.stringify({ ...meta, streamer: login, duration: out.duration, width: out.width, height: out.height, sourceExt: ext }));
      form.append('video', out.video, 'clip.mp4');
      if (out.thumb) form.append('thumb', out.thumb, 'thumb.jpg');
      if (source) form.append('source', source, `source.${ext}`);
      const res = await fetch('/api/clips', { method: 'POST', body: form, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Upload failed (${res.status})`);
      const clip = await res.json();
      Object.assign(job, { stage: 'done', progress: 1, clipId: clip.id, title: clip.title });
      this.log(login, `Saved clip "${clip.title}"`);
      this.#emit('clip', { login, clip });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(`New clip: ${login}`, { body: clip.title, icon: clip.thumbUrl || undefined });
      }
    } catch (e) {
      Object.assign(job, { stage: 'failed', error: e?.message || String(e) });
      this.log(login, `Clip failed: ${job.error}`);
    }
  }
}
