import { api, esc, toast, timeAgo } from './api.js';
import { icon } from './icons.js';
import { skeleton, showLoading } from './loader.js';

const mb = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.ceil(n / 1e3)} KB`);
const LIMITS = [250e6, 500e6, 1e9, 2e9, 5e9, 10e9, 20e9, 50e9];

// Usage bar + limit picker. Over the limit, the user's oldest clips are replaced as new ones are saved.
function storageCell(u) {
  const limit = u.storageLimit;
  const pct = limit ? Math.min(100, (u.storage / limit) * 100) : 0;
  const level = pct >= 100 ? 'full' : pct >= 80 ? 'high' : '';
  const opts = [...new Set([...LIMITS, ...(limit ? [limit] : [])])].sort((a, b) => a - b);
  return `<div class="quota">
    <div class="row" style="gap:6px"><b>${mb(u.storage)}</b><span class="muted">${limit ? `of ${mb(limit)}` : 'used · no limit'}</span></div>
    ${limit ? `<div class="quota-bar ${level}" title="${Math.round(pct)}% used"><div style="width:${pct}%"></div></div>` : ''}
    <select class="limit" title="Storage limit. When it's reached, the oldest clips are replaced by new ones (clips waiting to be posted are kept).">
      <option value="">No limit</option>
      ${opts.map((b) => `<option value="${b}" ${b === limit ? 'selected' : ''}>Limit ${mb(b)}</option>`).join('')}
      <option value="custom">Custom…</option>
    </select>
    <div class="row custom-limit hidden" style="gap:6px"><input type="number" class="limit-gb" min="0.001" step="0.1" placeholder="GB" style="width:90px">
      <button class="btn sm primary set-limit">Set</button><button class="btn sm ghost cancel-limit" title="Cancel">${icon('x')}</button></div></div>`;
}

function showSecret(title, email, password) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="panel" style="width:min(440px,100%);display:grid;gap:12px">
    <div class="row">${icon('key')}<h3 style="margin:0">${esc(title)}</h3></div>
    <div class="small muted">Share this temporary password with <b style="color:var(--text)">${esc(email)}</b>. It is shown only once; they can sign in with it right away.</div>
    <div class="row"><input type="text" readonly value="${esc(password)}" class="secret" style="font-family:ui-monospace,Consolas,monospace;font-size:16px">
      <button class="btn sm copy">${icon('copy')}Copy</button></div>
    <div class="row"><span class="spacer"></span><button class="btn primary done">Done</button></div></div>`;
  document.body.append(back);
  back.querySelector('.copy').onclick = async () => { await navigator.clipboard.writeText(password); toast('Copied', 'ok'); };
  back.querySelector('.done').onclick = () => back.remove();
}

export class AdminView {
  constructor(root, { me, build, onCounts }) {
    this.root = root;
    this.me = me;
    this.onCounts = onCounts;
    this.filter = 'all';
    const when = (iso) => (iso ? new Date(iso).toLocaleString() : '–');
    const buildPanel = `
      <div class="panel" style="margin-top:16px">
        <div class="section-head"><div><h2 style="margin:0">Deployed version</h2>
          <div class="muted small">The release this server is running. It changes when a new build is deployed.</div></div></div>
        <div class="build-info">
          <div><span class="muted small">Version</span><b>v${esc(build?.version || '?')}</b></div>
          <div><span class="muted small">Commit</span><b class="mono">${esc(build?.commit || 'unknown')}</b></div>
          <div><span class="muted small">Built</span><b>${esc(build?.builtAt ? when(build.builtAt) : 'local run (not stamped)')}</b></div>
          <div><span class="muted small">Server started</span><b>${esc(when(build?.startedAt))}</b></div>
        </div>
      </div>`;
    root.innerHTML = `
      <div class="panel" style="margin-bottom:16px">
        <div class="section-head">
          <div><h2 style="margin:0">Accounts</h2><div class="muted small">New sign-ups wait here until you approve them. Disabled accounts cannot sign in and their server watchers stop.</div></div>
          <span class="spacer"></span>
          <div class="seg filters">
            <button data-f="all">All <span class="c-all"></span></button>
            <button data-f="pending">Pending <span class="c-pending"></span></button>
            <button data-f="active">Active <span class="c-active"></span></button>
            <button data-f="disabled">Disabled <span class="c-disabled"></span></button>
          </div>
          <button class="btn primary new-user">${icon('user-plus')}Create account</button>
        </div>
        <form class="create-form hidden panel" style="padding:12px;margin-bottom:12px">
          <div class="row wrap">
            <input name="name" type="text" placeholder="Name" style="max-width:200px">
            <input name="email" type="email" placeholder="Email" required style="max-width:260px">
            <input name="password" type="text" placeholder="Password (blank = generate)" style="max-width:240px">
            <select name="role" style="width:auto"><option value="user">User</option><option value="admin">Admin</option></select>
            <button class="btn primary">${icon('check')}Create</button>
          </div>
        </form>
        <div class="table-wrap"><table class="users">
          <thead><tr><th>Account</th><th>Status</th><th>Role</th><th>Usage</th><th>Storage</th><th>Last sign-in</th><th style="text-align:right">Actions</th></tr></thead>
          <tbody></tbody></table></div>
      </div>
      <div class="panel" style="margin-bottom:16px">
        <div class="section-head"><div><h2 style="margin:0">Watching now</h2>
          <div class="muted small">Streams each user is watching right now, on the server or in their browser. <b>Stop</b> on a stream turns off auto-clip for that streamer; <b>Stop all</b> ends all of that user's watching. Browsers follow within about 10 seconds.</div></div>
          <span class="spacer"></span><button class="btn sm refresh-watching">${icon('refresh')}Refresh</button></div>
        <div class="watch-list"></div>
      </div>
      <div class="panel">
        <div class="section-head"><div><h2 style="margin:0">Database backup</h2>
          <div class="muted small">Downloads the whole database: accounts, settings, streamers, clip details and schedules. Clipped video files are not included.
          Social-account logins are kept in the server's browser profiles (<code>data/browser</code>), not in the database, so users log in again after restoring on another server.</div></div></div>
        <div class="row wrap">
          <a class="btn primary" href="/api/admin/backup" download>${icon('database')}Download database backup</a>
          <label class="btn danger">${icon('upload')}Restore database<input type="file" accept=".db" class="restore-db" hidden></label>
          <span class="small muted">Restoring replaces all data and restarts the server.</span>
        </div>
      </div>${buildPanel}`;
    const $ = (s) => root.querySelector(s);
    root.querySelectorAll('.filters button').forEach((b) => { b.onclick = () => { this.filter = b.dataset.f; this.render(); }; });
    $('.new-user').onclick = () => $('.create-form').classList.toggle('hidden');
    $('.create-form').onsubmit = (e) => this.create(e);
    $('.restore-db').onchange = (e) => this.restore(e);
    $('.refresh-watching').onclick = () => this.loadWatching();
    // Keep "Watching now" fresh while the admin tab is on screen.
    setInterval(() => { if (root.offsetParent && !document.hidden) this.loadWatching(); }, 5000);
  }

  async loadWatching() {
    const box = this.root.querySelector('.watch-list');
    const first = !this.watching;
    const idle = first ? showLoading(box, skeleton.streamers(2)) : () => {};
    try {
      this.watching = await api('/api/admin/watching');
    } catch (e) {
      if (first) box.innerHTML = `<div class="empty">Couldn't load who is watching: ${esc(e.message)}</div>`;
      return;
    } finally { idle(); }
    this.renderWatching();
  }

  renderWatching() {
    const box = this.root.querySelector('.watch-list');
    const STATUS = { watching: 'Watching live', offline: 'Offline', checking: 'Checking', starting: 'Starting', connecting: 'Connecting', live: 'Live', error: 'Error', closed: 'Window closed', elsewhere: 'In other window' };
    const stream = (u, s) => `<div class="watch-stream">
      ${s.live ? '<span class="live-dot"></span>' : ''}<b>${esc(s.displayName || s.login)}</b>
      <span class="badge ${s.stopping ? 'elsewhere' : s.status === 'watching' ? 'watching' : s.status === 'error' ? 'error' : ''}">${s.stopping ? 'Stopping…' : esc(STATUS[s.status] || s.status)}</span>
      <span class="muted small">${s.live ? `${esc(s.game || 'Live')} · ${Number(s.viewers || 0).toLocaleString()} viewers` : ''}</span>
      <span class="spacer"></span>
      <button class="btn sm ghost danger stop-one" data-user="${u.userId}" data-login="${esc(s.login)}" ${s.stopping ? 'disabled' : ''} title="Stop watching this stream (turns off auto-clip for it)">${icon('stop')}Stop</button></div>`;
    const group = (u, label, streams) => `<div class="small muted watch-where">${label}</div>${streams.map((s) => stream(u, s)).join('')}`;
    box.innerHTML = this.watching.map((u) => `<div class="watch-user">
        <div class="row">${u.avatar ? `<img class="avatar" src="${esc(u.avatar)}" alt="" loading="lazy">` : `<div class="avatar initials">${esc((u.name || u.email || '?')[0].toUpperCase())}</div>`}
          <div style="min-width:0"><b>${esc(u.name || '')}</b>${u.userId === this.me.id ? ' <span class="small muted">(you)</span>' : ''}<div class="small muted">${esc(u.email || '')}</div></div>
          <span class="spacer"></span><button class="btn sm danger stop-user" data-user="${u.userId}" ${u.browser?.stopping && !u.server ? 'disabled' : ''}>${icon('stop')}Stop all</button></div>
        ${u.server ? group(u, `${icon('server')} On the server`, u.server.streamers) : ''}
        ${u.browser ? group(u, `${icon('monitor')} In their browser (${u.browser.mode})${u.browser.since ? ` · since ${timeAgo(u.browser.since)}` : ''}`, u.browser.streamers) : ''}
      </div>`).join('') || '<div class="empty">Nobody is watching right now.</div>';
    const done = (r, what) => toast(`${what}${r?.browser ? ' Their browser follows within about 10 seconds.' : ''}`, 'ok');
    box.querySelectorAll('.stop-user').forEach((b) => {
      const u = this.watching.find((x) => String(x.userId) === b.dataset.user);
      b.onclick = async () => {
        if (!confirm(`Stop everything ${u.email} is watching?`)) return;
        b.disabled = true;
        try { done(await api(`/api/admin/watching/${u.userId}/stop`, { method: 'POST' }), `Stopped all watching for ${u.email}.`); } catch (e) { toast(e.message, 'error'); }
        setTimeout(() => this.loadWatching(), 800);
      };
    });
    box.querySelectorAll('.stop-one').forEach((b) => {
      const u = this.watching.find((x) => String(x.userId) === b.dataset.user);
      b.onclick = async () => {
        if (!confirm(`Stop watching ${b.dataset.login} for ${u.email}? Auto-clip is turned off for this streamer until they turn it back on.`)) return;
        b.disabled = true;
        try { done(await api(`/api/admin/watching/${u.userId}/streamers/${encodeURIComponent(b.dataset.login)}/stop`, { method: 'POST' }), `Stopped ${b.dataset.login} for ${u.email}.`); } catch (e) { toast(e.message, 'error'); }
        setTimeout(() => this.loadWatching(), 800);
      };
    });
  }

  async load() {
    this.loadWatching();
    const tbody = this.root.querySelector('tbody');
    const first = !this.data;
    const idle = first ? showLoading(tbody, skeleton.tableRows(4, 7)) : () => {};
    try {
      this.data = await api('/api/admin/users');
    } catch (e) {
      if (first) tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">Couldn't load accounts: ${esc(e.message)}</td></tr>`;
      throw e;
    } finally { idle(); }
    this.onCounts?.(this.data.counts);
    this.render();
  }

  render() {
    const { users, counts } = this.data;
    const $ = (s) => this.root.querySelector(s);
    this.root.querySelectorAll('.filters button').forEach((b) => b.classList.toggle('active', b.dataset.f === this.filter));
    for (const k of ['pending', 'active', 'disabled']) $(`.c-${k}`).textContent = `(${counts[k]})`;
    $('.c-all').textContent = `(${users.length})`;
    const rows = users.filter((u) => this.filter === 'all' || u.status === this.filter);
    $('tbody').innerHTML = rows.map((u) => {
      const self = u.id === this.me.id;
      return `<tr data-id="${u.id}">
        <td><div class="row">${u.avatar ? `<img class="avatar" src="${esc(u.avatar)}" alt="" loading="lazy" decoding="async">` : `<div class="avatar initials">${esc((u.name || u.email || '?')[0].toUpperCase())}</div>`}
          <div style="min-width:0"><b>${esc(u.name || '')}</b>${self ? ' <span class="small muted">(you)</span>' : ''}<div class="small muted">${esc(u.email || '')}${u.google ? ' · Google' : ''}</div></div></div></td>
        <td data-label="Status"><span class="badge st-${u.status}">${u.status}</span></td>
        <td data-label="Role"><select class="role" ${self ? 'disabled' : ''}><option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
        <td data-label="Usage" class="small muted"><div>${u.clips} clips<br>${u.streamers} streamers · ${u.processing === 'server' ? `${icon('server')} server` : `${icon('monitor')} browser`}</div>
          <label class="switch sm" style="margin-top:6px" title="Allow this account to watch and clip on the server (keeps going when their browser is closed)">
            <input type="checkbox" class="server-watch" ${u.serverWatch ? 'checked' : ''}><span></span>Server watching</label></td>
        <td data-label="Storage" class="small">${storageCell(u)}</td>
        <td data-label="Last sign-in" class="small muted"><div>${u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}<br>joined ${new Date(u.createdAt).toLocaleDateString()}</div></td>
        <td class="actions"><div class="row" style="justify-content:flex-end;gap:6px">
          ${u.status === 'pending' ? `<button class="btn sm primary approve">${icon('check')}Approve</button>` : ''}
          ${u.status === 'active' && !self ? `<button class="btn sm disable">${icon('ban')}Disable</button>` : ''}
          ${u.status === 'disabled' ? `<button class="btn sm enable">${icon('check-circle')}Enable</button>` : ''}
          <button class="btn sm reset" title="Reset password">${icon('key')}Reset password</button>
          ${self ? '' : `<button class="btn sm danger del" title="Delete account">${icon('trash')}</button>`}
        </div></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No accounts in this view.</td></tr>';
    this.root.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      const u = users.find((x) => String(x.id) === tr.dataset.id);
      const q = (s) => tr.querySelector(s);
      const act = async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg, 'ok'); await this.load(); return r; } catch (e) { toast(e.message, 'error'); this.render(); } };
      q('.approve') && (q('.approve').onclick = () => act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } }), `${u.email} approved`));
      q('.disable') && (q('.disable').onclick = () => confirm(`Disable ${u.email}? They will be signed out.`) && act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'disabled' } }), `${u.email} disabled`));
      q('.enable') && (q('.enable').onclick = () => act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } }), `${u.email} enabled`));
      q('.role').onchange = (e) => act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), `${u.email} is now ${e.target.value}`);
      q('.server-watch').onchange = (e) => {
        const on = e.target.checked;
        if (!on && u.processing === 'server' && !confirm(`${u.email} is watching on the server. Turning this off stops their server watchers and switches them back to watching in their browser. Continue?`)) { e.target.checked = true; return; }
        act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { serverWatch: on } }),
          `${u.email}: server watching ${on ? 'enabled' : 'disabled'}`);
      };
      const setLimit = (bytes) => {
        if (bytes && bytes < u.storage && !confirm(`${u.email} already uses ${mb(u.storage)}. With a ${mb(bytes)} limit, their oldest clips are deleted to make room the next time a clip is saved. Continue?`)) { this.render(); return; }
        act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { storageLimit: bytes } }),
          bytes ? `${u.email}: storage limited to ${mb(bytes)}` : `${u.email}: storage limit removed`);
      };
      q('.limit').onchange = (e) => {
        if (e.target.value !== 'custom') return setLimit(e.target.value ? Number(e.target.value) : null);
        e.target.classList.add('hidden');
        q('.custom-limit').classList.remove('hidden');
        q('.limit-gb').value = u.storageLimit ? +(u.storageLimit / 1e9).toFixed(3) : '';
        q('.limit-gb').focus();
      };
      q('.set-limit').onclick = () => {
        const gb = Number(q('.limit-gb').value);
        if (!(gb > 0)) return toast('Enter the limit in GB, e.g. 0.5 or 3', 'error');
        setLimit(Math.round(gb * 1e9));
      };
      q('.limit-gb').onkeydown = (e) => { if (e.key === 'Enter') q('.set-limit').click(); if (e.key === 'Escape') this.render(); };
      q('.cancel-limit').onclick = () => this.render();
      q('.reset').onclick = async () => {
        if (!confirm(`Reset the password for ${u.email}? Their current sessions will be signed out.`)) return;
        const r = await act(() => api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST', body: {} }));
        if (r?.password) showSecret('Password reset', u.email, r.password);
      };
      q('.del') && (q('.del').onclick = () => confirm(`Permanently delete ${u.email} with all their clips, schedules and linked accounts?`)
        && act(() => api(`/api/admin/users/${u.id}`, { method: 'DELETE' }), `${u.email} deleted`));
    });
  }

  async create(e) {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/api/admin/users', { method: 'POST', body: { name: f.elements.name.value, email: f.elements.email.value, password: f.elements.password.value, role: f.elements.role.value } });
      f.reset();
      f.classList.add('hidden');
      toast(`Created ${r.user.email}`, 'ok');
      if (r.password) showSecret('Account created', r.user.email, r.password);
      this.load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async restore(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm(`Restore the whole database from "${file.name}"? ALL current accounts and data are replaced and the server restarts.`)) return;
    try {
      const res = await fetch('/api/admin/restore', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Restore failed (${res.status})`);
      toast('Database restored. The server is restarting...', 'ok');
      const wait = async () => {
        try { if ((await fetch('/healthz')).ok) return location.reload(); } catch { /* still restarting */ }
        setTimeout(wait, 1500);
      };
      setTimeout(wait, 2500);
    } catch (err) { toast(err.message, 'error'); }
  }
}
