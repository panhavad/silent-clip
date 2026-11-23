import { api, esc, toast } from './api.js';
import { WatcherManager } from './engine/manager.js';
import { getChannels } from './engine/twitch.js';
import { mountMonitors } from './monitor.js';
import { ClipLibrary } from './clips.js';
import { ScheduleView } from './schedule.js';
import { renderAccounts } from './accounts.js';
import { renderBackup } from './backup.js';
import { AdminView } from './admin.js';
import { ServerManager } from './server-manager.js';
import { icon, hydrateIcons } from './icons.js';
import { preloadRenderer } from './engine/render.js';
import { thresholds } from './engine/analyzer.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

hydrateIcons();
const [me, config] = await Promise.all([api('/api/me'), api('/api/config')]);
let settings = me.settings;
let streamers = await api('/api/streamers');
let running = false;
let mode = settings.mode;
let processing = settings.processing || 'browser';
const channel = new BroadcastChannel(`slientclip-${me.id}`);
const windowStatus = new Map();

$('.me-name').textContent = me.name || me.email;
if (me.avatar) $('.me-avatar').src = me.avatar; else $('.me-avatar').classList.add('hidden');
$('.logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login.html'; };

// ---------- tabs ----------
const TABS = ['live', 'streamers', 'clips', 'schedule', 'settings', ...(me.role === 'admin' ? ['admin'] : [])];
function showTab(name) {
  $$('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
    if (t.dataset.tab === name) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  $$('main > section').forEach((s) => s.classList.toggle('hidden', s.dataset.view !== name));
  if (name === 'clips') library.load();
  if (name === 'streamers') renderStreamers();
  if (name === 'schedule') schedule.load().catch((e) => toast(e.message, 'error'));
  if (name === 'settings') {
    renderAccounts($('.accounts-root')).catch((e) => toast(e.message, 'error'));
    renderBackup($('.backup-root'), { onRestored: reloadAfterRestore });
  }
  if (name === 'admin') adminView?.load().catch((e) => toast(e.message, 'error'));
  history.replaceState(null, '', `${location.pathname}#${name}`);
}
$$('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });

// ---------- admin ----------
let adminView = null;
if (me.role === 'admin') {
  $('.admin-tab').classList.remove('hidden');
  $('.admin-badge').classList.remove('hidden');
  const setPending = (n) => { const el = $('.pending-count'); el.textContent = n; el.classList.toggle('hidden', !n); };
  adminView = new AdminView($('.admin-root'), { me, onCounts: (c) => setPending(c.pending) });
  api('/api/admin/users').then((d) => setPending(d.counts.pending)).catch(() => {});
}

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

// ---------- watchers: in this browser, or on the server ----------
const browserManager = new WatcherManager({ settings, userId: me.id, label: 'dashboard' });
const serverManager = new ServerManager();
const onClip = ({ detail }) => { toast(`New clip from ${detail.login}: ${detail.clip.title}`, 'ok'); library.load(); };
for (const m of [browserManager, serverManager]) {
  mountMonitors($('.monitors'), m, { onPopout: (login) => openWindows([login]) });
  m.addEventListener('clip', onClip);
}
channel.onmessage = ({ data }) => {
  if (data.type === 'clip') library.load();
  if (data.type === 'win-status') { windowStatus.set(data.login, { ...data, seen: Date.now() }); if (mode === 'foreground' && processing === 'browser') renderForeground(); }
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
      <div class="body"><button class="btn sm open-one" data-login="${s.login}">${icon('window')}${alive ? 'Focus' : 'Open'} window</button></div></div>`;
  }).join('');
  $$('.open-one', box).forEach((b) => { b.onclick = () => openWindows([b.dataset.login]); });
}
setInterval(() => { if (processing === 'browser' && mode === 'foreground' && running) renderForeground(); }, 5000);

function setMode(m) {
  mode = m;
  $$('.mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('.layout').classList.toggle('hidden', processing !== 'browser' || m !== 'foreground');
}

function setProcessingUi() {
  $$('.processing button').forEach((b) => b.classList.toggle('active', b.dataset.p === processing));
  $('.mode').classList.toggle('hidden', processing !== 'browser');
  setMode(mode);
  $('.mode-help').innerHTML = processing === 'server'
    ? `<b>Server</b> mode watches every enabled streamer on the server, clips and renders there, and keeps going after you close this page or your computer. You can come back any time to see the clips.`
    : `<b>Background</b> watches every streamer silently inside this tab (keep it open; it can sit in a background tab). <b>Foreground</b> opens browser windows with the live players so you can watch along. Watching, chat analysis, cutting and rendering run in your browser; the server only stores the finished clips.`;
}

async function start() {
  if (!enabled().length) { toast('Add at least one streamer first', 'error'); showTab('streamers'); return; }
  if (processing === 'server') {
    try { await serverManager.start(); } catch (e) { toast(e.message, 'error'); return; }
    $('.monitors').innerHTML = '';
    running = true;
    settings.serverRunning = true;
    return refreshAutomation();
  }
  running = true;
  localStorage.setItem(`sc-running-${me.id}`, mode);
  preloadRenderer().catch((e) => toast(`Renderer failed to load: ${e.message}`, 'error'));
  if (mode === 'background') {
    $('.monitors').innerHTML = '';
    browserManager.start(enabled());
  } else {
    browserManager.stop();
    $('.monitors').innerHTML = '';
    openWindows(enabled().map((s) => s.login));
    renderForeground();
  }
  refreshAutomation();
}

async function stop() {
  if (processing === 'server') {
    try { await serverManager.stop(); } catch (e) { toast(e.message, 'error'); }
    settings.serverRunning = false;
  } else {
    localStorage.removeItem(`sc-running-${me.id}`);
    browserManager.stop();
    if (mode === 'foreground') channel.postMessage({ type: 'close-all' });
  }
  running = false;
  $('.monitors').innerHTML = '';
  refreshAutomation();
}

function refreshAutomation() {
  $('.toggle').innerHTML = running ? `${icon('stop')}Stop watching` : `${icon('play')}Start watching`;
  $('.toggle').classList.toggle('primary', !running);
  const where = processing === 'server' ? 'on the server' : `in ${mode} mode`;
  $('.auto-status').textContent = running
    ? `Running ${where} · ${enabled().length} streamer(s) · sensitivity ${settings.sensitivity}/10`
    : `Stopped · ${enabled().length} streamer(s) ready`;
  $('.no-streamers').classList.toggle('hidden', streamers.length > 0);
  if (!running && enabled().length) {
    $('.monitors').innerHTML = `<div class="empty" style="grid-column:1/-1">Press <b>Start watching</b>. Each streamer is checked for live status and auto-clipped when chat explodes.</div>`;
  }
}

async function switchProcessing(p) {
  if (p === processing) return;
  const wasRunning = running;
  if (running) await stop();
  processing = p;
  settings = await api('/api/settings', { method: 'PUT', body: { processing: p } });
  if (form.elements.processing) form.elements.processing.value = p;
  setProcessingUi();
  if (wasRunning) await start(); else refreshAutomation();
  toast(p === 'server' ? 'Watching and clipping will run on the server' : 'Watching and clipping will run in this browser', 'ok');
}

$$('.processing button').forEach((b) => { b.onclick = () => switchProcessing(b.dataset.p); });
$$('.mode button').forEach((b) => {
  b.onclick = async () => { const wasRunning = running; if (running) await stop(); setMode(b.dataset.mode); if (wasRunning) start(); };
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
        <div class="small muted">${c?.live ? `<span class="live-dot"></span>Live · ${esc(c.game)} · ${c.viewers.toLocaleString()} viewers` : c ? 'Offline' : 'Unknown channel'}</div></div>
      <span class="spacer"></span>
      <label class="row small"><input type="checkbox" class="en" ${s.enabled ? 'checked' : ''}> Auto-clip</label>
      <button class="btn sm danger rm">${icon('trash')}Remove</button>
    </div>`;
  }).join('');
  $$('.streamer-item', list).forEach((row) => {
    const s = streamers.find((x) => String(x.id) === row.dataset.id);
    $('.en', row).onchange = async (e) => { Object.assign(s, await api(`/api/streamers/${s.id}`, { method: 'PATCH', body: { enabled: e.target.checked } })); onStreamersChanged(); };
    $('.rm', row).onclick = async () => { await api(`/api/streamers/${s.id}`, { method: 'DELETE' }); streamers = streamers.filter((x) => x !== s); renderStreamers(); onStreamersChanged(); };
  });
}

function onStreamersChanged() {
  // Server watchers resync on the server automatically.
  if (running && processing === 'browser' && mode === 'background') browserManager.start(enabled());
  refreshAutomation();
}

$('.add-streamer').onsubmit = async (e) => {
  e.preventDefault();
  const input = e.target.url;
  try {
    const raw = input.value.trim();
    const login = (raw.match(/twitch\.tv\/([A-Za-z0-9_]+)/i)?.[1] || raw.replace(/^@/, '')).toLowerCase();
    const info = (await getChannels([login]).catch(() => ({})))[login];
    if (info === null) throw new Error(`Twitch channel "${login}" does not exist`);
    const s = await api('/api/streamers', { method: 'POST', body: { url: raw, displayName: info?.displayName, avatar: info?.avatar } });
    if (!streamers.some((x) => x.id === s.id)) streamers.push(s);
    input.value = '';
    toast(`Added ${s.displayName}${info?.live ? ' (live now)' : ''}`, 'ok');
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
  $('.sens-label').textContent = `${form.elements.sensitivity.value}/10: clip when chat is ≥${t.ratio.toFixed(1)}× normal and ${t.z.toFixed(1)}σ above baseline`;
}
form.elements.sensitivity.oninput = updateSensLabel;
form.onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of Object.keys(settings)) {
    const el = form.elements[k];
    if (el && k !== 'processing') body[k] = el.type === 'checkbox' ? el.checked : el.value;
  }
  settings = { ...settings, ...(await api('/api/settings', { method: 'PUT', body })) };
  browserManager.updateSettings(settings);
  channel.postMessage({ type: 'settings', settings });
  $('.layout').value = settings.windowLayout;
  await switchProcessing(form.elements.processing.value);
  fillSettings();
  refreshAutomation();
  toast('Settings saved', 'ok');
};
fillSettings();

function reloadAfterRestore() {
  toast('Settings restored. Reloading...', 'ok');
  setTimeout(() => location.reload(), 900);
}

// ---------- boot ----------
setProcessingUi();
refreshAutomation();
if (processing === 'server') {
  if (settings.serverRunning) {
    running = true;
    $('.monitors').innerHTML = '';
    serverManager.attach();
    refreshAutomation();
  }
} else {
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
}
const hash = location.hash.slice(1);
if (TABS.includes(hash)) showTab(hash);
