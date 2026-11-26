// One worker per streamer, running the shared watch loop (pipeline.js) in the user's browser. Dedicated workers
// are not throttled in background tabs.
import { getChannel } from './twitch.js';
import { StreamWatch } from './pipeline.js';

let watch = null;
const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function getMasterText(login) {
  const r = await fetch(`/api/twitch/master/${login}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Playlist relay HTTP ${r.status}`);
  return r.text();
}

// Twitch refuses the media playlist for requests from other sites, so it comes through the server's relay.
const fetchPlaylist = (url) => fetch(`/api/twitch/playlist?u=${encodeURIComponent(url)}`, { credentials: 'same-origin', cache: 'no-store' });

function create(login, settings) {
  const w = new StreamWatch(login, settings, { getChannel, getMasterText, fetchPlaylist }, {
    status: (status, message) => post({ type: 'status', status, channel: w.channel, message }),
    log: (message) => post({ type: 'log', message }),
    channel: (channel) => post({ type: 'channel', channel }),
    stats: (stats) => post({ type: 'stats', stats }),
    moment: (job) => post({ type: 'moment', id: job.id, moment: job.moment, readyIn: job.readyIn }),
    clipFailed: (job, message) => post({ type: 'clipFailed', id: job.id, message }),
    clip: (job, data) => post({ type: 'clip', id: job.id, moment: job.moment, channel: w.channel, data }, [data.bytes.buffer]),
  });
  return w;
}

self.onmessage = ({ data }) => {
  if (data.type === 'start') {
    watch = create(data.login, data.settings);
    watch.start();
  } else if (data.type === 'settings') {
    watch?.configure(data.settings);
  } else if (data.type === 'clipNow') {
    if (!watch?.clipNow()) post({ type: 'clipFailed', id: 'manual', message: 'Not watching a live stream yet' });
  } else if (data.type === 'stop') {
    watch?.stop();
    self.close();
  }
};
