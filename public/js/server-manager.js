import { api, toast } from './api.js';

/**
 * Mirrors WatcherManager's interface (state Map + update/stats/job/clip events) but the work
 * happens on the server; this only polls status and forwards Start/Stop/Clip now.
 */
export class ServerManager extends EventTarget {
  constructor({ only = null } = {}) {
    super();
    this.only = only ? new Set(only) : null;
    this.state = new Map();
    this.running = false;
    this.available = true;
    this.timer = null;
    this.savedClips = new Set();
  }

  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    await api('/api/server-watch', { method: 'PUT', body: { processing: 'server', running: true } });
    this.attach();
  }

  async stop() {
    await api('/api/server-watch', { method: 'PUT', body: { running: false } });
    this.detach();
  }

  attach() {
    this.running = true;
    this.announced = false;
    clearTimeout(this.timer);
    this.poll();
  }

  detach() {
    this.running = false;
    clearTimeout(this.timer);
    this.state.clear();
    this.#emit('update', {});
  }

  updateSettings() { /* the server reads settings directly */ }

  async clipNow(login) {
    try {
      await api(`/api/server-watch/${login}/clip`, { method: 'POST' });
      toast(`Clipping ${login} on the server (last 20s + next 10s)`, 'ok');
    } catch (e) { toast(e.message, 'error'); }
    return true;
  }

  async poll() {
    if (!this.running) return;
    try {
      const data = await api('/api/server-watch');
      if (data.allowed === false) { this.detach(); this.#emit('revoked', {}); return; }
      // Watching was switched off elsewhere (e.g. by an administrator).
      if (data.running === false) { this.detach(); this.#emit('stopped', {}); return; }
      this.available = data.available;
      this.queue = data.queue;
      const first = !this.initialized;
      this.initialized = true;
      const seen = new Set();
      for (const w of data.watchers) {
        if (this.only && !this.only.has(w.login)) continue;
        seen.add(w.login);
        const st = {
          login: w.login, displayName: w.displayName, avatar: w.avatar, status: w.status, channel: w.channel,
          stats: w.stats, log: w.log, jobs: new Map(w.jobs.map((j) => [j.id, j])), worker: true,
        };
        this.state.set(w.login, st);
        for (const j of w.jobs) {
          if (j.stage === 'done' && j.clipId && !this.savedClips.has(j.clipId)) {
            // Clips that already existed when the page opened don't trigger a "new clip" toast.
            if (!first) this.#emit('clip', { login: w.login, clip: { id: j.clipId, title: j.title } });
            this.savedClips.add(j.clipId);
          }
        }
        this.#emit('update', { login: w.login, state: st });
        if (w.stats) this.#emit('stats', { login: w.login, stats: w.stats });
      }
      for (const login of [...this.state.keys()]) if (!seen.has(login)) { this.state.delete(login); this.#emit('update', { login }); }
      if (!this.announced) { this.announced = true; this.#emit('ready', {}); }
    } catch { /* transient */ }
    this.timer = setTimeout(() => this.poll(), 2000);
  }
}
