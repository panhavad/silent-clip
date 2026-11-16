// One worker per streamer: live detection, HLS ring buffer, chat analysis, clip extraction.
// Runs entirely in the user's browser; dedicated workers are not throttled in background tabs.
import { getChannel } from './twitch.js';
import { SegmentBuffer } from './hls.js';
import { TwitchChat } from './chat.js';
import { HypeAnalyzer } from './analyzer.js';

let login = null;
let settings = {};
let channel = null;
let buffer = null;
let chat = null;
let analyzer = null;
let pending = [];
let liveTimer = null;
let tickTimer = null;
let offlineChecks = 0;
let starting = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const status = (s, extra = {}) => post({ type: 'status', status: s, channel, ...extra });
const log = (message) => post({ type: 'log', message });

async function checkLive() {
  try {
    channel = await getChannel(login);
    if (!channel) { status('error', { message: 'Channel not found' }); return schedule(300000); }
    if (channel.live) {
      offlineChecks = 0;
      if (!buffer && !starting) await startPipeline();
      else post({ type: 'channel', channel });
    } else {
      offlineChecks++;
      if (buffer && offlineChecks >= 2) { log('Stream went offline'); stopPipeline(); }
      if (!buffer) status('offline');
    }
  } catch (e) {
    status(buffer ? 'watching' : 'error', { message: `Live check failed: ${e.message}` });
  }
  schedule(buffer ? 60000 : 45000);
}

function schedule(ms) { clearTimeout(liveTimer); liveTimer = setTimeout(checkLive, ms); }

async function startPipeline() {
  starting = true;
  status('connecting');
  try {
    const retainSec = settings.preRollSec + settings.postRollSec + settings.reactionDelaySec + 45;
    buffer = new SegmentBuffer({
      retainSec,
      maxHeight: Number(String(settings.resolution || '720x1280').split('x')[0]) >= 1080 ? 1080 : 720,
      getMasterText: async () => {
        const r = await fetch(`/api/twitch/master/${login}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Playlist relay HTTP ${r.status}`);
        return r.text();
      },
      onEvent: (ev) => {
        if (ev.type === 'variant') log(`Buffering ${ev.variant.height}p${Math.round(ev.variant.fps)}`);
        if (ev.type === 'ad') log(ev.start ? 'Twitch ad break — stream video is replaced by ads, clipping paused' : 'Ad break over — buffering stream again');
        if (ev.type === 'error') log(ev.message);
        if (ev.type === 'ended') { log('Playlist ended'); stopPipeline(); }
      },
    });
    await buffer.start();
    analyzer = new HypeAnalyzer(settings);
    chat = new TwitchChat(login, {
      onMessage: (m) => analyzer?.addMessage(m),
      onState: (s) => log(`Chat ${s}`),
    });
    chat.connect();
    clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
    status('watching');
  } catch (e) {
    stopPipeline();
    status('error', { message: e.message });
  } finally {
    starting = false;
  }
}

function stopPipeline() {
  buffer?.stop(); buffer = null;
  chat?.close(); chat = null;
  analyzer = null;
  clearInterval(tickTimer);
  pending = [];
  status(channel?.live ? 'live' : 'offline');
}

function queueMoment(moment) {
  // Chat reacts after the viewer sees the action: shift back by the measured stream latency + reaction delay.
  const eventPdt = moment.peakTs - buffer.latencyMs - (moment.manual ? 0 : settings.reactionDelaySec * 1000);
  const job = {
    id: `${login}-${moment.peakTs}`,
    moment: { ...moment, eventPdt, streamer: login },
    start: eventPdt - settings.preRollSec * 1000,
    end: eventPdt + settings.postRollSec * 1000,
    createdAt: Date.now(),
  };
  pending.push(job);
  const edge = buffer.liveEdge;
  post({ type: 'moment', id: job.id, moment: job.moment, readyIn: Math.max(0, Math.round((job.end - (edge ?? job.end - settings.postRollSec * 1000)) / 1000)) });
}

function tick() {
  if (!analyzer || !buffer) return;
  const { stats, moment } = analyzer.tick(Date.now());
  post({ type: 'stats', stats: { ...stats, latency: Math.round(buffer.latencyMs), buffered: Math.round(buffer.bufferedSec) } });
  if (moment) queueMoment(moment);

  const edge = buffer.liveEdge || 0;
  for (const job of [...pending]) {
    const timedOut = Date.now() - job.createdAt > (settings.postRollSec + 60) * 1000;
    if (edge < job.end && !timedOut) continue;
    pending = pending.filter((j) => j !== job);
    const data = buffer.extract(job.start, job.end);
    if (!data) { post({ type: 'clipFailed', id: job.id, message: 'Video for this moment is no longer buffered' }); continue; }
    const viralOffset = Math.max(0, (job.moment.eventPdt - data.startPdt) / 1000);
    post({ type: 'clip', id: job.id, moment: { ...job.moment, viralOffset }, channel, data }, [data.bytes.buffer]);
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'start') {
    login = data.login;
    settings = data.settings;
    checkLive();
  } else if (data.type === 'settings') {
    settings = data.settings;
    analyzer?.configure(settings);
  } else if (data.type === 'clipNow') {
    if (!analyzer || !buffer) return post({ type: 'clipFailed', id: 'manual', message: 'Not watching a live stream yet' });
    queueMoment(analyzer.manualMoment(Date.now()));
  } else if (data.type === 'stop') {
    clearTimeout(liveTimer);
    stopPipeline();
    self.close();
  }
};
