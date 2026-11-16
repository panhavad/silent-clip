import { api, toast } from './api.js';
import { WatcherManager } from './engine/manager.js';
import { mountMonitors } from './monitor.js';
import { preloadRenderer } from './engine/render.js';

const me = await api('/api/me');
const streamers = await api('/api/streamers');
const logins = (new URLSearchParams(location.search).get('logins') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const list = logins.map((l) => streamers.find((s) => s.login === l) || { login: l, displayName: l });
document.title = `SlientClip — ${list.map((s) => s.displayName).join(', ')}`;
document.querySelector('.win-title').textContent = `Watching ${list.map((s) => s.displayName).join(', ')}`;

const channel = new BroadcastChannel(`slientclip-${me.id}`);
const manager = new WatcherManager({ settings: me.settings, userId: me.id, label: 'window' });
mountMonitors(document.querySelector('.monitors'), manager, { showPlayers: true });
manager.addEventListener('clip', ({ detail }) => {
  toast(`New clip: ${detail.clip.title}`, 'ok');
  channel.postMessage({ type: 'clip', login: detail.login, id: detail.clip.id });
});

const heat = new Map();
manager.addEventListener('stats', ({ detail }) => heat.set(detail.login, detail.stats.heat));
setInterval(() => {
  for (const [login, st] of manager.state) {
    channel.postMessage({ type: 'win-status', login, status: st.status, heat: heat.get(login) ?? null });
  }
}, 3000);

channel.onmessage = ({ data }) => {
  if (data.type === 'settings') manager.updateSettings(data.settings);
  if (data.type === 'close-all') window.close();
};

preloadRenderer().catch((e) => toast(`Renderer failed to load: ${e.message}`, 'error'));
manager.start(list);
