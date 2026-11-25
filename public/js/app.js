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
import { renderVersion, watchForUpdates } from './version.js';
import { skeleton, showLoading } from './loader.js';
import { mountStreamerSearch } from './streamer-search.js';
import { lockApp, warnExpiry } from './expired.js';
import { startTour, appTourSteps } from './tour.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const SERVER_WATCH_OFF = 'Watching on the server is turned off for your account. Ask an administrator to enable it.';

hydrateIcons();
const [me, config, initialStreamers] = await Promise.all([api('/api/me'), api('/api/config'), api('/api/streamers')]);
let settings = me.settings;
let streamers = initialStreamers;
let running = false;
let mode = settings.mode;
let processing = settings.processing || 'browser';
const channel = new BroadcastChannel(`slientclip-${me.id}`);
const windowStatus = new Map();
// Remembers that watching was started in this browser (and in which mode), across reloads.
const RUN_KEY = `sc-running-${me.id}`;
let awaitWindowsUntil = 0; // after a reload in foreground mode: waiting for an open watch window to report
let foregroundSince = 0;
let accessLocked = false; // an administrator's expiry date passed: read-only

$('.me-name').textContent = me.name || me.email;
renderVersion($('.ver'), config.build);
watchForUpdates(config.build, $('.update-pill'));
if (me.avatar) $('.me-avatar').src = me.avatar; else $('.me-avatar').classList.add('hidden');
$('.logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };

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
  adminView = new AdminView($('.admin-root'), { me, build: config.build, onCounts: (c) => setPending(c.pending) });
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

// ---------- background posting results ----------
// The server posts in a hidden browser; report each finished attempt (also ones that finished while the app was closed).
{
  const KEY = `sc-post-results-${me.id}`;
  let since = Number(localStorage.getItem(KEY)) || Date.now();
  const PLAT = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };
  const report = async () => {
    try {
      const results = await api(`/api/posts/results?since=${since}`);
      for (const p of results.slice(-5)) {
        const title = p.clip?.title || 'clip';
        const ok = p.status === 'published';
        const msg = ok ? `Posted to ${PLAT[p.platform]}: ${title}` : `${PLAT[p.platform]} post failed: ${p.error || 'unknown error'}`;
        toast(msg, ok ? 'ok' : 'error');
        if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(ok ? `Posted to ${PLAT[p.platform]}` : `${PLAT[p.platform]} post failed`, { body: ok ? title : `${title}: ${p.error || ''}`, icon: '/favicon.svg' });
        }
      }
      if (results.length) {
        since = Math.max(...results.map((p) => p.finishedAt));
        localStorage.setItem(KEY, String(since));
        if (!$('[data-view="schedule"]').classList.contains('hidden')) schedule.renderCalendar?.();
      } else localStorage.setItem(KEY, String(since));
    } catch { /* offline / restarting */ }
  };
  report();
  setInterval(report, 15000);
}

// ---------- watchers: in this browser, or on the server ----------
const browserManager = new WatcherManager({ settings, userId: me.id, label: 'dashboard' });
const serverManager = new ServerManager();
const onClip = ({ detail }) => {
  toast(`New clip from ${detail.login}: ${detail.clip.title}`, 'ok');
  if (detail.clip.overwritten) toast(`Storage limit reached: replaced your ${detail.clip.overwritten} oldest clip(s)`);
  library.load();
};
for (const m of [browserManager, serverManager]) {
  mountMonitors($('.monitors'), m, { onPopout: (login) => openWindows([login]) });
  m.addEventListener('clip', onClip);
}
channel.onmessage = ({ data }) => {
  if (data.type === 'clip') library.load();
  if (data.type === 'win-status') {
    windowStatus.set(data.login, { ...data, seen: Date.now() });
    // After a reload, a watch window that is still open confirms foreground watching is running.
    if (!running && awaitWindowsUntil > Date.now() && processing === 'browser') {
      awaitWindowsUntil = 0;
      running = true;
      foregroundSince = Date.now();
      refreshAutomation();
    }
    if (mode === 'foreground' && processing === 'browser' && running) renderForeground();
  }
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
// Foreground watching runs in pop-up windows. If none of them has reported for a while (all closed),
// it isn't watching any more, so show it as stopped instead of assuming it still runs.
const WINDOW_SILENCE_MS = 15000;
setInterval(() => {
  if (processing !== 'browser' || mode !== 'foreground' || !running) return;
  const alive = [...windowStatus.values()].some((w) => Date.now() - w.seen < WINDOW_SILENCE_MS);
  if (!alive && Date.now() - foregroundSince > WINDOW_SILENCE_MS + 5000) {
    running = false;
    localStorage.removeItem(RUN_KEY);
    $('.monitors').innerHTML = '';
    refreshAutomation();
    toast('All watch windows are closed, so watching has stopped.');
    return;
  }
  renderForeground();
}, 5000);

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
  if (accessLocked) return;
  awaitWindowsUntil = 0;
  if (!enabled().length) { toast('Add at least one streamer first', 'error'); showTab('streamers'); return; }
  if (processing === 'server') {
    try { await serverManager.start(); } catch (e) { toast(e.message, 'error'); return; }
    showLoading($('.monitors'), skeleton.monitors(Math.min(enabled().length, 4)));
    running = true;
    settings.serverRunning = true;
    return refreshAutomation();
  }
  running = true;
  localStorage.setItem(RUN_KEY, mode);
  preloadRenderer().catch((e) => toast(`Renderer failed to load: ${e.message}`, 'error'));
  if (mode === 'background') {
    $('.monitors').innerHTML = '';
    browserManager.start(enabled());
  } else {
    browserManager.stop();
    $('.monitors').innerHTML = '';
    foregroundSince = Date.now();
    openWindows(enabled().map((s) => s.login));
    renderForeground();
  }
  refreshAutomation();
}

async function stop() {
  awaitWindowsUntil = 0;
  if (processing === 'server') {
    try { await serverManager.stop(); } catch (e) { toast(e.message, 'error'); }
    settings.serverRunning = false;
  } else {
    localStorage.removeItem(RUN_KEY);
    browserManager.stop();
    if (mode === 'foreground') channel.postMessage({ type: 'close-all' });
  }
  running = false;
  $('.monitors').innerHTML = '';
  refreshAutomation();
}

function refreshAutomation() {
  heartbeat();
  $('.toggle').innerHTML = running ? `${icon('stop')}Stop watching` : `${icon('play')}Start watching`;
  $('.toggle').classList.toggle('primary', !running);
  const where = processing === 'server' ? 'on the server' : `in ${mode} mode`;
  $('.auto-status').textContent = running
    ? `Running ${where} · ${enabled().length} streamer(s) · sensitivity ${settings.sensitivity}/10`
    : awaitWindowsUntil > Date.now() ? 'Checking for watch windows that are still open…'
    : `Stopped · ${enabled().length} streamer(s) ready`;
  $('.no-streamers').classList.toggle('hidden', streamers.length > 0);
  if (!running && enabled().length) {
    $('.monitors').innerHTML = `<div class="empty" style="grid-column:1/-1">Press <b>Start watching</b>. Each streamer is checked for live status and auto-clipped when chat explodes.</div>`;
  }
}

async function switchProcessing(p) {
  if (p === processing) return;
  if (p === 'server' && !me.serverWatch) { toast(SERVER_WATCH_OFF, 'error'); return; }
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
let streamerSeq = 0;
let finder = null; // "Find streamers" search (mounted below)
function streamerRows(live) {
  return streamers.map((s) => {
    const c = live?.[s.login];
    const status = !live ? '<div class="sk sk-line sm" style="width:160px" title="Checking live status"></div>'
      : c?.live ? `<span class="live-dot"></span>Live · ${esc(c.game)} · ${c.viewers.toLocaleString()} viewers` : c ? 'Offline' : 'Unknown channel';
    return `<div class="streamer-item" data-id="${s.id}">
      <img class="avatar" src="${esc(c?.avatar || s.avatar || '')}" alt="" loading="lazy" decoding="async">
      <div style="min-width:0;flex:1"><div><b>${esc(c?.displayName || s.displayName)}</b> <a class="small" href="${s.url}" target="_blank" rel="noopener">${esc(s.url)}</a></div>
        <div class="small muted">${status}</div></div>
      <span class="spacer"></span>
      <label class="row small"><input type="checkbox" class="en" ${s.enabled ? 'checked' : ''}> Auto-clip</label>
      <button class="btn sm danger rm">${icon('trash')}Remove</button>
    </div>`;
  }).join('');
}

async function renderStreamers() {
  finder?.sync();
  const list = $('.streamer-list');
  const seq = ++streamerSeq;
  if (!streamers.length) { list.innerHTML = '<div class="empty">No streamers yet.</div>'; return; }
  // Rows show right away; the live status from Twitch fills in when it arrives.
  const bind = () => $$('.streamer-item', list).forEach((row) => {
    const s = streamers.find((x) => String(x.id) === row.dataset.id);
    $('.en', row).onchange = async (e) => { Object.assign(s, await api(`/api/streamers/${s.id}`, { method: 'PATCH', body: { enabled: e.target.checked } })); onStreamersChanged(); };
    $('.rm', row).onclick = async () => { await api(`/api/streamers/${s.id}`, { method: 'DELETE' }); streamers = streamers.filter((x) => x !== s); renderStreamers(); onStreamersChanged(); };
  });
  const idle = showLoading(list, streamerRows(null));
  bind();
  let live = {};
  try { live = await getChannels(streamers.map((s) => s.login)); } catch { /* status optional */ }
  if (seq !== streamerSeq) return;
  idle();
  list.innerHTML = streamerRows(live);
  bind();
}

function onStreamersChanged() {
  // Server watchers resync on the server automatically.
  if (running && processing === 'browser' && mode === 'background') browserManager.start(enabled());
  refreshAutomation();
}

// ---------- report watching to the server; follow admin stop commands ----------
function watchSnapshot() {
  if (!running || processing !== 'browser') return [];
  if (mode === 'foreground') {
    return enabled().map((s) => {
      const w = windowStatus.get(s.login);
      return { login: s.login, displayName: s.displayName, status: w && Date.now() - w.seen < 10000 ? w.status : 'closed' };
    });
  }
  return [...browserManager.state.values()].map((st) => ({
    login: st.login, displayName: st.displayName, status: st.status,
    live: Boolean(st.channel?.live), viewers: st.channel?.viewers || 0, game: st.channel?.game || '',
  }));
}

function handleAdminCommand(c) {
  if (c.type === 'stop' && running) {
    stop();
    toast('An administrator stopped your watching.', 'error');
  }
  if (c.type === 'disable') {
    const s = streamers.find((x) => x.login === c.login);
    if (!s?.enabled) return;
    s.enabled = false;
    channel.postMessage({ type: 'stop-streamer', login: s.login });
    onStreamersChanged();
    if (!$('[data-view="streamers"]').classList.contains('hidden')) renderStreamers();
    toast(`An administrator stopped watching ${s.displayName}. Auto-clip is now off for this streamer.`, 'error');
  }
}

async function heartbeat() {
  try {
    const r = await api('/api/watch/heartbeat', { method: 'POST', body: { running, processing, mode, streamers: watchSnapshot() } });
    if (r.expired && !accessLocked) lockAccess(r);
    if (!r.expired && accessLocked) { location.reload(); return; }
    (r.commands || []).forEach(handleAdminCommand);
  } catch { /* offline / restarting */ }
}
setInterval(heartbeat, 10000);

// ---------- expired access ----------
/** Access ended: stop watching here and lock the app read-only (the server refuses changes anyway). */
function lockAccess({ expiresAt = me.expiresAt, contact = me.contact } = {}) {
  if (accessLocked) return;
  accessLocked = true;
  awaitWindowsUntil = 0;
  localStorage.removeItem(RUN_KEY);
  if (processing !== 'server' && running) {
    browserManager.stop();
    if (mode === 'foreground') channel.postMessage({ type: 'close-all' });
  }
  running = false;
  lockApp({ expiresAt, contact: contact || me.contact });
}
window.addEventListener('sc-expired', (e) => lockAccess({ contact: e.detail?.contact }));

/** Add a channel (link, handle or login). `known` = channel info the caller already has from Twitch. */
async function addStreamer(raw, known) {
  const login = (raw.match(/twitch\.tv\/([A-Za-z0-9_]+)/i)?.[1] || raw.replace(/^@/, '')).toLowerCase();
  const info = known || (await getChannels([login]).catch(() => ({})))[login];
  if (info === null) throw new Error(`Twitch channel "${login}" does not exist`);
  const s = await api('/api/streamers', { method: 'POST', body: { url: raw, displayName: info?.displayName, avatar: info?.avatar } });
  if (!streamers.some((x) => x.id === s.id)) streamers.push(s);
  toast(`Added ${s.displayName}${info?.live ? ' (live now)' : ''}`, 'ok');
  renderStreamers();
  onStreamersChanged();
  return s;
}

$('.add-streamer').onsubmit = async (e) => {
  e.preventDefault();
  const input = e.target.url;
  try {
    await addStreamer(input.value.trim());
    input.value = '';
  } catch (err) { toast(err.message, 'error'); }
};

finder = mountStreamerSearch($('.streamer-finder'), {
  isAdded: (login) => streamers.some((s) => s.login === login),
  onAdd: (c) => addStreamer(c.login, c),
});

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
function lockServerWatch() {
  const b = $('.processing button[data-p=server]');
  b.disabled = true;
  b.title = SERVER_WATCH_OFF;
  const opt = form.elements.processing.querySelector('option[value=server]');
  opt.disabled = true;
  opt.textContent = 'The server (turned off for your account by an administrator)';
}
if (!me.serverWatch) lockServerWatch();
serverManager.addEventListener('stopped', () => {
  if (!running || processing !== 'server') return;
  running = false;
  settings = { ...settings, serverRunning: false };
  $('.monitors').innerHTML = '';
  refreshAutomation();
  toast('Watching on the server was stopped (by an administrator or from another device).', 'error');
});
serverManager.addEventListener('revoked', () => {
  me.serverWatch = false;
  settings = { ...settings, processing: 'browser', serverRunning: false };
  processing = 'browser';
  running = false;
  lockServerWatch();
  if (form.elements.processing) form.elements.processing.value = 'browser';
  $('.monitors').innerHTML = '';
  setProcessingUi();
  refreshAutomation();
  toast(`${SERVER_WATCH_OFF} Switched back to watching in this browser.`, 'error');
});
$('.monitors').innerHTML = '';
$('.monitors').removeAttribute('aria-busy');
setProcessingUi();
if (me.expired) lockAccess();
else if (me.expiresAt) warnExpiry(me.expiresAt);
refreshAutomation();
if (accessLocked) {
  // Nothing runs for an expired account.
} else if (processing === 'server') {
  if (settings.serverRunning) {
    running = true;
    showLoading($('.monitors'), skeleton.monitors(Math.max(1, Math.min(enabled().length, 4))));
    serverManager.attach();
    refreshAutomation();
  }
} else {
  // Only show "watching" when it is known to be running. Watching in this browser lived in the page
  // that was just closed or reloaded, so it has stopped; never restart it on a guess.
  const resumeMode = localStorage.getItem(RUN_KEY);
  if (resumeMode === 'background') {
    localStorage.removeItem(RUN_KEY);
    toast('Watching stopped when the page was closed or reloaded. Press Start watching to continue.');
  } else if (resumeMode === 'foreground') {
    // Watch windows may still be open: show watching only once one of them reports in.
    setMode('foreground');
    awaitWindowsUntil = Date.now() + 8000;
    refreshAutomation();
    setTimeout(() => {
      if (running || awaitWindowsUntil === 0) return;
      awaitWindowsUntil = 0;
      localStorage.removeItem(RUN_KEY);
      refreshAutomation();
    }, 8500);
  } else if (settings.autoStart && settings.mode === 'background' && enabled().length) {
    // Explicitly turned on in Settings (off by default).
    setMode('background');
    start();
  }
}
const hash = location.hash.slice(1);
if (TABS.includes(hash)) showTab(hash);

// ---------- welcome tour ----------
function runTour({ firstRun = false } = {}) {
  const from = $('.tab.active')?.dataset.tab || 'live';
  startTour(appTourSteps({ isAdmin: me.role === 'admin', name: me.name }), {
    showTab,
    onDone: () => {
      // First visit: end where the next step is (adding a streamer); otherwise back where they were.
      showTab(firstRun ? 'streamers' : from);
      if (firstRun) api('/api/me/tour', { method: 'POST' }).catch(() => {});
    },
  });
}
$('.help-btn').onclick = () => runTour();
if (!me.tourSeen && !accessLocked) setTimeout(() => runTour({ firstRun: true }), 400);
