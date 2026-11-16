import { api, esc, toast, timeAgo } from './api.js';
import { icon } from './icons.js';

const mb = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

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
  constructor(root, { me, onCounts }) {
    this.root = root;
    this.me = me;
    this.onCounts = onCounts;
    this.filter = 'all';
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
          <thead><tr><th>Account</th><th>Status</th><th>Role</th><th>Usage</th><th>Last sign-in</th><th style="text-align:right">Actions</th></tr></thead>
          <tbody></tbody></table></div>
      </div>
      <div class="panel">
        <div class="section-head"><div><h2 style="margin:0">Database backup</h2>
          <div class="muted small">Downloads the whole database: accounts, settings, streamers, clip details, schedules and linked accounts. Clipped video files are not included.
          Linked-account tokens stay encrypted and only work on a server with the same <code>APP_SECRET</code> (or <code>data/secret.key</code>).</div></div></div>
        <div class="row wrap">
          <a class="btn primary" href="/api/admin/backup" download>${icon('database')}Download database backup</a>
          <label class="btn danger">${icon('upload')}Restore database<input type="file" accept=".db" class="restore-db" hidden></label>
          <span class="small muted">Restoring replaces all data and restarts the server.</span>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    root.querySelectorAll('.filters button').forEach((b) => { b.onclick = () => { this.filter = b.dataset.f; this.render(); }; });
    $('.new-user').onclick = () => $('.create-form').classList.toggle('hidden');
    $('.create-form').onsubmit = (e) => this.create(e);
    $('.restore-db').onchange = (e) => this.restore(e);
  }

  async load() {
    this.data = await api('/api/admin/users');
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
        <td><div class="row">${u.avatar ? `<img class="avatar" src="${esc(u.avatar)}" alt="">` : `<div class="avatar initials">${esc((u.name || u.email || '?')[0].toUpperCase())}</div>`}
          <div style="min-width:0"><b>${esc(u.name || '')}</b>${self ? ' <span class="small muted">(you)</span>' : ''}<div class="small muted">${esc(u.email || '')}${u.google ? ' · Google' : ''}</div></div></div></td>
        <td><span class="badge st-${u.status}">${u.status}</span></td>
        <td><select class="role" ${self ? 'disabled' : ''}><option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
        <td class="small muted">${u.clips} clips · ${mb(u.storage)}<br>${u.streamers} streamers · ${u.processing === 'server' ? `${icon('server')} server` : `${icon('monitor')} browser`}</td>
        <td class="small muted">${u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}<br>joined ${new Date(u.createdAt).toLocaleDateString()}</td>
        <td><div class="row" style="justify-content:flex-end;gap:6px">
          ${u.status === 'pending' ? `<button class="btn sm primary approve">${icon('check')}Approve</button>` : ''}
          ${u.status === 'active' && !self ? `<button class="btn sm disable">${icon('ban')}Disable</button>` : ''}
          ${u.status === 'disabled' ? `<button class="btn sm enable">${icon('check-circle')}Enable</button>` : ''}
          <button class="btn sm reset" title="Reset password">${icon('key')}Reset password</button>
          ${self ? '' : `<button class="btn sm danger del" title="Delete account">${icon('trash')}</button>`}
        </div></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">No accounts in this view.</td></tr>';
    this.root.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
      const u = users.find((x) => String(x.id) === tr.dataset.id);
      const q = (s) => tr.querySelector(s);
      const act = async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg, 'ok'); await this.load(); return r; } catch (e) { toast(e.message, 'error'); this.render(); } };
      q('.approve') && (q('.approve').onclick = () => act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } }), `${u.email} approved`));
      q('.disable') && (q('.disable').onclick = () => confirm(`Disable ${u.email}? They will be signed out.`) && act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'disabled' } }), `${u.email} disabled`));
      q('.enable') && (q('.enable').onclick = () => act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } }), `${u.email} enabled`));
      q('.role').onchange = (e) => act(() => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), `${u.email} is now ${e.target.value}`);
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
