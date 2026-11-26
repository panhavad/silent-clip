// One streamer's watch loop, shared by the browser worker (watcher.worker.js) and the server (watch/manager.js):
// live checks, chat analysis and the HLS video buffer, and turning viral moments into clip extracts.
//
// Chat and the analyzer's learned baseline are independent of the video: when the video playlist drops (network
// blip, expiring playlist URLs during an ad, an encoder hiccup) only the video reconnects, and the baseline carries
// on. A stream that goes offline briefly (streamer's software crashed, a stream restart) keeps chat connected and
// the baseline for OFFLINE_GRACE_MS before everything is reset.
import { SegmentBuffer } from './hls.js';
import { TwitchChat } from './chat.js';
import { HypeAnalyzer } from './analyzer.js';

export const OFFLINE_GRACE_MS = 10 * 60000;
const VIDEO_STALE_MS = 30000;
const RETRY_MS = [3000, 8000, 15000, 30000, 60000];

export class StreamWatch {
  /**
   * @param deps  { getChannel(login), getMasterText(login), Buffer?, Chat?, now? }
   * @param hooks { status(status, message?), log(message), channel(ch), stats(stats), moment(job), clip(job, data), clipFailed(job, message) }
   */
  constructor(login, settings, deps, hooks = {}) {
    this.login = login;
    this.settings = settings;
    this.deps = { Buffer: SegmentBuffer, Chat: TwitchChat, now: () => Date.now(), ...deps };
    this.hooks = hooks;
    this.status = 'checking';
    this.channel = null;
    this.buffer = null;
    this.chat = null;
    this.analyzer = null;
    this.pending = [];
    this.offlineChecks = 0;
    this.offlineSince = 0;
    this.videoFailures = 0;
    this.stopped = false;
  }

  #now() { return this.deps.now(); }
  #status(s, message) { this.status = s; this.hooks.status?.(s, message); }
  #log(message) { this.hooks.log?.(message); }

  start() { this.checkLive(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.liveTimer);
    this.#stopVideo('Watching stopped');
    this.#stopChat();
  }

  configure(settings) {
    this.settings = settings;
    this.analyzer?.configure(settings);
  }

  schedule(ms) {
    clearTimeout(this.liveTimer);
    if (!this.stopped) this.liveTimer = setTimeout(() => this.checkLive(), ms);
  }

  /** New video segments arrived recently: the stream is really running, whatever the live check says. */
  videoFlowing() {
    return Boolean(this.buffer?.lastDataAt && this.#now() - this.buffer.lastDataAt < VIDEO_STALE_MS);
  }

  async checkLive() {
    if (this.stopped) return;
    let next = 45000;
    try {
      const ch = await this.deps.getChannel(this.login);
      if (this.stopped) return;
      this.channel = ch;
      if (!ch) { this.#status('error', 'Channel not found'); return this.schedule(300000); }
      this.hooks.channel?.(ch);
      if (ch.live) {
        this.offlineChecks = 0;
        this.offlineSince = 0;
        this.#startChat();
        if (!this.buffer && !this.starting) await this.#startVideo();
        next = this.buffer ? 60000 : RETRY_MS[Math.min(this.videoFailures, RETRY_MS.length) - 1] || 45000;
      } else {
        this.offlineChecks++;
        // Twitch's live flag can blip; only believe it when the video has stopped too.
        if (this.buffer && this.offlineChecks >= 2 && !this.videoFlowing()) {
          this.#log('Stream went offline');
          this.#stopVideo('Stream went offline');
        }
        if (!this.buffer) {
          this.offlineSince ||= this.#now();
          if (this.chat && this.#now() - this.offlineSince >= OFFLINE_GRACE_MS) {
            this.#log('Stream ended: chat baseline cleared');
            this.#stopChat();
          }
          this.#status('offline');
        }
        next = this.buffer ? 60000 : this.chat ? 30000 : 45000;
      }
    } catch (e) {
      this.#log(`Live check failed: ${e.message}`);
      if (!this.buffer && !this.chat) this.#status('error');
      next = this.buffer ? 60000 : 20000;
    }
    this.schedule(next);
  }

  // ---------- chat + analyzer (the learned baseline) ----------
  #startChat() {
    if (this.chat) return;
    const analyzer = new HypeAnalyzer(this.settings);
    this.analyzer = analyzer;
    this.chat = new this.deps.Chat(this.login, {
      onMessage: (m) => this.analyzer === analyzer && analyzer.addMessage(m),
      onState: (s) => {
        // Warm-up counts from the first connection: a quiet chat is a valid (low) baseline.
        if (s === 'connected' && analyzer.startedAt == null) analyzer.startedAt = this.#now();
        this.#log(`Chat ${s}`);
      },
    });
    this.chat.connect();
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }

  #stopChat() {
    this.chat?.close();
    this.chat = null;
    this.analyzer = null;
    clearInterval(this.tickTimer);
  }

  // ---------- video ----------
  async #startVideo() {
    this.starting = true;
    this.#status(this.videoFailures ? 'reconnecting' : 'connecting');
    const s = this.settings;
    const buffer = new this.deps.Buffer({
      retainSec: s.preRollSec + s.postRollSec + s.reactionDelaySec + 45,
      maxHeight: Number(String(s.resolution || '720x1280').split('x')[0]) >= 1080 ? 1080 : 720,
      getMasterText: () => this.deps.getMasterText(this.login),
      ...(this.deps.fetchPlaylist ? { fetchPlaylist: this.deps.fetchPlaylist } : {}),
      onEvent: (ev) => {
        if (ev.type === 'variant') this.#log(`Buffering ${ev.variant.height}p${Math.round(ev.variant.fps)}`);
        if (ev.type === 'ad') this.#log(ev.start ? 'Twitch ad break - stream video is replaced by ads, clipping paused' : 'Ad break over - buffering stream again');
        if (ev.type === 'error') this.#log(ev.message);
        if (ev.type === 'ended' && this.buffer === buffer) this.#videoLost('Video stream interrupted');
      },
    });
    this.buffer = buffer;
    try {
      await buffer.start();
      if (this.stopped || this.buffer !== buffer) { buffer.stop(); return; }
      if (this.videoFailures) this.#log('Video reconnected (chat baseline kept)');
      this.videoFailures = 0;
      this.#status('watching');
    } catch (e) {
      if (this.buffer === buffer) this.#videoLost(e.message);
    } finally {
      this.starting = false;
    }
  }

  /** The video dropped while the stream may still be live: reconnect it soon, keep chat and the baseline. */
  #videoLost(reason) {
    this.#stopVideo(reason);
    this.videoFailures++;
    if (this.stopped) return;
    const wait = RETRY_MS[Math.min(this.videoFailures, RETRY_MS.length) - 1];
    this.#log(`${reason} - reconnecting the video in ${Math.round(wait / 1000)}s (chat baseline kept)`);
    this.#status('reconnecting');
    this.schedule(wait);
  }

  #stopVideo(reason) {
    this.buffer?.stop();
    this.buffer = null;
    for (const job of this.pending) this.hooks.clipFailed?.(job, `${reason} before the clip was captured`);
    this.pending = [];
    if (!this.stopped) this.#status(this.channel?.live ? 'live' : 'offline');
  }

  // ---------- moments -> clips ----------
  queueMoment(moment) {
    const s = this.settings;
    // Chat reacts after the viewer sees the action: shift back by the measured stream latency + reaction delay.
    const eventPdt = moment.peakTs - this.buffer.latencyMs - (moment.manual ? 0 : s.reactionDelaySec * 1000);
    const job = {
      id: `${this.login}-${moment.peakTs}`,
      moment: { ...moment, eventPdt, streamer: this.login },
      start: eventPdt - s.preRollSec * 1000,
      end: eventPdt + s.postRollSec * 1000,
      createdAt: this.#now(),
    };
    this.pending.push(job);
    const edge = this.buffer.liveEdge;
    job.readyIn = Math.max(0, Math.round((job.end - (edge ?? job.end - s.postRollSec * 1000)) / 1000));
    this.hooks.moment?.(job);
    return job;
  }

  /** Manual clip: returns false when there is no live video to clip from. */
  clipNow() {
    if (!this.analyzer || !this.buffer) return false;
    this.queueMoment(this.analyzer.manualMoment(this.#now()));
    return true;
  }

  tick() {
    if (!this.analyzer) return;
    const now = this.#now();
    const { stats, moment } = this.analyzer.tick(now);
    const b = this.buffer;
    this.hooks.stats?.({ ...stats, latency: b ? Math.round(b.latencyMs) : null, buffered: b ? Math.round(b.bufferedSec) : 0 });
    if (moment) {
      if (b) this.queueMoment(moment);
      else this.#log(`Viral moment (score ${moment.score}) while the video was reconnecting - not clipped`);
    }
    if (!b) return;
    const edge = b.liveEdge || 0;
    for (const job of [...this.pending]) {
      const timedOut = now - job.createdAt > (this.settings.postRollSec + 60) * 1000;
      if (edge < job.end && !timedOut) continue;
      this.pending = this.pending.filter((j) => j !== job);
      const data = b.extract(job.start, job.end);
      if (!data) { this.hooks.clipFailed?.(job, 'Video for this moment is no longer buffered'); continue; }
      job.moment = { ...job.moment, viralOffset: Math.max(0, (job.moment.eventPdt - data.startPdt) / 1000) };
      this.hooks.clip?.(job, data);
    }
  }
}
