import { api, esc, toast } from './api.js';
import { WatcherManager } from './engine/manager.js';
import { getChannels } from './engine/twitch.js';
import { mountMonitors } from './monitor.js';
import { ClipLibrary } from './clips.js';
import { ScheduleView } from './schedule.js';
import { renderAccounts } from './accounts.js';
import { preloadRenderer } from './engine/render.js';
import { thresholds } from './engine/analyzer.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const [me, config] = await Promise.all([api('/api/me'), api('/api/config')]);
let settings = me.settings;
let streamers = await api('/api/streamers');
let running = false;
let mode = settings.mode;
const channel = new BroadcastChannel(`slientclip-${me.id}`);
const windowStatus = new Map();

$('.me-name').textContent = me.name || me.email;
if (me.avatar) $('.me-avatar').src = me.avatar; else $('.me-avatar').classList.add('hidden');
$('.logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; };

// ---------- tabs ----------
function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('main > section').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== name));
  if (name === 'clips') library.load();
  if (name === 'streamers') renderStreamers();
  if (name === 'schedule') schedule.load().catch((e) => toast(e.message, 'error'));
  if (name === 'settings') renderAccounts($('.accounts-root')).catch((e) => toast(e.message, 'error'));
  history.replaceState(null, '', `${location.pathname}#${name}`);
}
$$('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });

// ---------- clips ----------
const library = new ClipLibrary($('.clips-root'), {
  config,
  onCounts: (c) => { const el = $('.new-count'); el.textContent = c.new; el.classList.toggle('hidden', !c.new); },
});
library.load();
const schedule = new ScheduleView($('.schedule-root'), {
  onOpenClip: async (id) => library.open(await api(`/api/clips/${id}`)),
});

// Result of an OAuth "Connect account" round trip.
{
  const q = new URLSearchParams(location.search);
  if (q.get('connected')) toast(`${q.get('connected')} account connected`, 'ok');
  if (q.get('connectError')) toast(`Could not connect: ${q.get('connectError')}`, 'error');
}

// ---------- background manager ----------
const manager = new WatcherManager({ settings, userId: me.id, label: 'dashboard' });
mountMonitors($('.monitors'), manager, { onPopout: (login) => openWindows([login]) });
manager.addEventListener('clip', ({ detail }) => { toast(`New clip from ${detail.login}: ${detail.clip.title}`, 'ok'); library.load(); });
channel.onmessage = ({ data }) => {
  if (data.type === 'clip') library.load();
  if (data.type === 'win-status') { windowStatus.set(data.login, { ...data, seen: Date.now() }); if (mode === 'foreground') renderForeground(); }
};

const enabled = () => streamers.filter((s) => s.enabled);

function openWindows(logins) {
  let blocked = false;
  if (settings.windowLayout === 'grid' && logins.length > 1) {
    blocked = !window.open(`/watch.html?logins=${logins.join(',')}`, 'slientclip-grid', 'popup,width=1300,height=900');
  } else {
    logins.forEach((login, i) => {
      const w = window.open(`/watch.html?logins=${login}`, `slientclip-${login}`, `popup,width=480,height=900,left=${60 + i * 60},top=${40 + i * 40}`);
      if (!w) blocked = true;
    });
  }
  $('.popup-notice').classList.toggle('hidden', !blocked);
}

function renderForeground() {
  const box = $('.monitors');
  box.innerHTML = enabled().map((s) => {
    const w = windowStatus.get(s.login);
    const alive = w && Date.now() - w.seen < 10000;
    return `<div class="monitor"><div class="head">
      <img class="avatar" src="${esc(s.avatar || '')}" alt=""><div><div class="name">${esc(s.displayName)}</div>
      <div class="sub">${alive ? `Window: ${esc(w.status)}${w.heat != null ? ` · hype ${Math.round(w.heat * 100)}%` : ''}` : 'No window open'}</div></div>
      <span class="spacer"></span><span class="badge ${alive ? 'watching' : 'offline'}">${alive ? 'In window' : 'Closed'}</span></div>
      <div class="body"><button class="btn sm open-one" data-login="${s.login}">⧉ ${alive ? 'Focus' : 'Open'} window</button></div></div>`;
  }).join('');
  $$('.open-one', box).forEach((b) => { b.onclick = () => openWindows([b.dataset.login]); });
}
setInterval(() => { if (mode === 'foreground' && running) renderForeground(); }, 5000);

function setMode(m) {
  mode = m;
  $$('.mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('.layout').classList.toggle('hidden', m !== 'foreground');
}

function start() {
  if (!enabled().length) { toast('Add at least one streamer first', 'error'); showTab('streamers'); return; }
  running = true;
  localStorage.setItem(`sc-running-${me.id}`, mode);
  preloadRenderer().catch((e) => toast(`Renderer failed to load: ${e.message}`, 'error'));
  if (mode === 'background') {
    $('.monitors').innerHTML = '';
    manager.start(enabled());
  } else {
    manager.stop();
    $('.monitors').innerHTML = '';
    openWindows(enabled().map((s) => s.login));
    renderForeground();
  }
  refreshAutomation();
}

function stop() {
  running = false;
  localStorage.removeItem(`sc-running-${me.id}`);
  manager.stop();
  if (mode === 'foreground') channel.postMessage({ type: 'close-all' });
  $('.monitors').innerHTML = '';
  refreshAutomation();
}

function refreshAutomation() {
  $('.toggle').textContent = running ? '■ Stop watching' : '▶ Start watching';
  $('.toggle').classList.toggle('primary', !running);
  $('.auto-status').textContent = running
    ? `Running in ${mode} mode · ${enabled().length} streamer(s) · sensitivity ${settings.sensitivity}/10`
    : `Stopped · ${enabled().length} streamer(s) ready`;
  $('.no-streamers').classList.toggle('hidden', streamers.length > 0);
  if (!running && enabled().length) {
    $('.monitors').innerHTML = `<div class="empty" style="grid-column:1/-1">Press <b>Start watching</b> — each streamer is checked for live status and auto-clipped when chat explodes.</div>`;
  }
}

$$('.mode button').forEach((b) => {
  b.onclick = () => { const wasRunning = running; if (running) stop(); setMode(b.dataset.mode); if (wasRunning) start(); };
});
$('.layout').value = settings.windowLayout;
$('.layout').onchange = async () => { settings = await api('/api/settings', { method: 'PUT', body: { windowLayout: $('.layout').value } }); };
$('.toggle').onclick = () => (running ? stop() : start());
$('.notify').onclick = async () => {
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Desktop notifications enabled' : 'Notifications not allowed', p === 'granted' ? 'ok' : 'error');
};

// ---------- streamers ----------
async function renderStreamers() {
  const list = $('.streamer-list');
  if (!streamers.length) { list.innerHTML = '<div class="empty">No streamers yet.</div>'; return; }
  let live = {};
  try { live = await getChannels(streamers.map((s) => s.login)); } catch { /* status optional */ }
  list.innerHTML = streamers.map((s) => {
    const c = live[s.login];
    return `<div class="streamer-item" data-id="${s.id}">
      <img class="avatar" src="${esc(c?.avatar || s.avatar || '')}" alt="">
      <div style="min-width:0"><div><b>${esc(c?.displayName || s.displayName)}</b> <a class="small" href="${s.url}" target="_blank" rel="noopener">${esc(s.url)}</a></div>
        <div class="small muted">${c?.live ? `🔴 Live · ${esc(c.game)} · ${c.viewers.toLocaleString()} viewers` : c ? 'Offline' : 'Unknown channel'}</div></div>
      <span class="spacer"></span>
      <label class="row small"><input type="checkbox" class="en" ${s.enabled ? 'checked' : ''}> Auto-clip</label>
      <button class="btn sm danger rm">Remove</button>
    </div>`;
  }).join('');
  $$('.streamer-item', list).forEach((row) => {
    const s = streamers.find((x) => String(x.id) === row.dataset.id);
    $('.en', row).onchange = async (e) => { Object.assign(s, await api(`/api/streamers/${s.id}`, { method: 'PATCH', body: { enabled: e.target.checked } })); onStreamersChanged(); };
    $('.rm', row).onclick = async () => { await api(`/api/streamers/${s.id}`, { method: 'DELETE' }); streamers = streamers.filter((x) => x !== s); renderStreamers(); onStreamersChanged(); };
  });
}

function onStreamersChanged() {
  if (running && mode === 'background') manager.start(enabled());
  refreshAutomation();
}

$('.add-streamer').onsubmit = async (e) => {
  e.preventDefault();
  const input = e.target.url;
  try {
    const raw = input.value.trim();
    const login = (raw.match(/twitch\.tv\/([A-Za-z0-9_]+)/i)?.[1] || raw.replace(/^@/, '')).toLowerCase();
    const info = (await getChannels([login]).catch(() => ({})))[login];
    if (info === null) throw new Error(`Twitch channel “${login}” does not exist`);
    const s = await api('/api/streamers', { method: 'POST', body: { url: raw, displayName: info?.displayName, avatar: info?.avatar } });
    if (!streamers.some((x) => x.id === s.id)) streamers.push(s);
    input.value = '';
    toast(`Added ${s.displayName}${info?.live ? ' — live now!' : ''}`, 'ok');
    renderStreamers();
    onStreamersChanged();
  } catch (err) { toast(err.message, 'error'); }
};

// ---------- settings ----------
const form = $('.settings-form');
function fillSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(v); else el.value = v;
  }
  updateSensLabel();
}
function updateSensLabel() {
  const t = thresholds(form.elements.sensitivity.value);
  $('.sens-label').textContent = `${form.elements.sensitivity.value}/10 — clip when chat is ≥${t.ratio.toFixed(1)}× normal and ${t.z.toFixed(1)}σ above baseline`;
}
form.elements.sensitivity.oninput = updateSensLabel;
form.onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of Object.keys(settings)) {
    const el = form.elements[k];
    if (el) body[k] = el.type === 'checkbox' ? el.checked : el.value;
  }
  settings = await api('/api/settings', { method: 'PUT', body });
  manager.updateSettings(settings);
  channel.postMessage({ type: 'settings', settings });
  $('.layout').value = settings.windowLayout;
  fillSettings();
  refreshAutomation();
  toast('Settings saved', 'ok');
};
fillSettings();

// ---------- boot ----------
setMode(settings.mode);
refreshAutomation();
const resumeMode = localStorage.getItem(`sc-running-${me.id}`);
if (resumeMode === 'background' || (!resumeMode && settings.autoStart && settings.mode === 'background' && enabled().length)) {
  setMode('background');
  start();
} else if (resumeMode === 'foreground') {
  // Windows can't be reopened without a click; show their status instead.
  running = true;
  renderForeground();
  refreshAutomation();
}
const hash = location.hash.slice(1);
if (['live', 'streamers', 'clips', 'schedule', 'settings'].includes(hash)) showTab(hash);
