import { api, esc, toast } from './api.js';
import { getAccounts, accountFor, PLATFORM_META } from './accounts.js';
import { icon } from './icons.js';

const DAY = 86400000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS = { scheduled: `${icon('clock')}Scheduled`, publishing: `${icon('loader', 'spin')}Publishing`, published: `${icon('check-circle', 'ok')}Published`, failed: `${icon('alert', 'bad')}Failed` };
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = (ts) => { const d = new Date(startOfDay(ts)); d.setDate(d.getDate() - d.getDay()); return d.getTime(); };
const localInput = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm(ts)}`; };

export class ScheduleView {
  constructor(root, { onOpenClip }) {
    this.root = root;
    this.onOpenClip = onOpenClip;
    this.view = 'week';
    this.anchor = Date.now();
    this.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    root.innerHTML = `
      <div class="panel" style="margin-bottom:16px">
        <div class="section-head">
          <div><h2 style="margin:0">Auto-publish</h2><div class="muted small ap-sub"></div></div>
          <span class="spacer"></span>
          <label class="switch"><input type="checkbox" class="ap-enabled"><span></span> <b class="ap-state">Off</b></label>
          <button class="btn primary ap-save">Save schedule</button>
        </div>
        <div class="row wrap small" style="margin-bottom:12px;gap:18px">
          <label class="row">Only clips with viral score ≥ <input type="number" class="ap-min" min="0" max="99" style="width:80px"></label>
          <label class="row">and newer than <input type="number" class="ap-age" min="1" max="720" style="width:80px"> hours</label>
          <span class="muted">Times are in <b class="ap-tz"></b></span>
        </div>
        <div class="ap-platforms grid" style="gap:10px"></div>
      </div>
      <div class="panel">
        <div class="section-head">
          <h2 style="margin:0" class="cal-title"></h2>
          <div class="row"><button class="btn sm cal-prev" title="Previous">${icon('chevron-left')}</button><button class="btn sm cal-today">Today</button><button class="btn sm cal-next" title="Next">${icon('chevron-right')}</button></div>
          <span class="spacer"></span>
          <div class="row small legend">${Object.entries(PLATFORM_META).map(([p, m]) => `<span class="row"><span class="plat ${p}">${m.icon}</span>${m.short}</span>`).join('')}
            <span class="row"><span class="slot-dot"></span>open slot</span></div>
          <div class="seg cal-mode"><button data-v="week">Week</button><button data-v="month">Month</button></div>
        </div>
        <div class="calendar"></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    $('.cal-prev').onclick = () => { this.shift(-1); };
    $('.cal-next').onclick = () => { this.shift(1); };
    $('.cal-today').onclick = () => { this.anchor = Date.now(); this.renderCalendar(); };
    root.querySelectorAll('.cal-mode button').forEach((b) => { b.onclick = () => { this.view = b.dataset.v; this.renderCalendar(); }; });
    $('.ap-save').onclick = () => this.save();
    $('.ap-enabled').onchange = () => this.save();
  }

  shift(dir) {
    const d = new Date(this.anchor);
    if (this.view === 'week') d.setDate(d.getDate() + 7 * dir); else d.setMonth(d.getMonth() + dir);
    this.anchor = d.getTime();
    this.renderCalendar();
  }

  async load() {
    [this.settings, this.accounts] = await Promise.all([api('/api/autopublish'), getAccounts(true)]);
    if (this.settings.timezone !== this.tz) {
      // Keep the schedule in the user's own time zone.
      this.settings = await api('/api/autopublish', { method: 'PUT', body: { timezone: this.tz } });
    }
    this.renderSettings();
    await this.renderCalendar();
  }

  renderSettings() {
    const s = this.settings;
    const $ = (sel) => this.root.querySelector(sel);
    $('.ap-enabled').checked = s.enabled;
    $('.ap-state').textContent = s.enabled ? 'On' : 'Off';
    $('.ap-min').value = s.minScore;
    $('.ap-age').value = s.maxAgeHours;
    $('.ap-tz').textContent = s.timezone;
    const perDay = Object.entries(s.platforms).filter(([p, c]) => c.enabled && accountFor(this.accounts, p)?.connected)
      .map(([p, c]) => `${c.times.length}× ${PLATFORM_META[p].short}`);
    $('.ap-sub').textContent = s.enabled
      ? `Automatically fills these posting slots with your best new clips${perDay.length ? ` — up to ${perDay.join(', ')} per day` : ' — connect an account to start'}.`
      : 'Turn on to post clips automatically at the times below. You can still post or schedule manually from any clip.';
    $('.ap-platforms').innerHTML = Object.entries(s.platforms).map(([p, c]) => {
      const m = PLATFORM_META[p];
      const acc = accountFor(this.accounts, p);
      return `<div class="ap-row" data-p="${p}">
        <div class="row" style="min-width:210px"><div class="plat-logo ${m.cls}">${m.icon}</div><div><b>${m.label}</b><div class="small ${acc?.connected ? 'muted' : ''}" style="${acc?.connected ? '' : 'color:var(--warn)'}">${acc?.connected ? `@${esc(acc.username || acc.displayName)}` : 'Not connected: <a href="#settings">connect</a>'}</div></div></div>
        <label class="row small"><input type="checkbox" class="p-en" ${c.enabled ? 'checked' : ''}> Auto-post</label>
        <div class="row wrap times">${c.times.map((t) => `<span class="chip time">${t}<button title="Remove" data-t="${t}">×</button></span>`).join('')}
          <input type="time" class="add-time" style="width:110px"><button class="btn sm add-btn">${icon('plus')}time</button></div>
        <div class="row days">${DOW.map((d, i) => `<button class="day ${c.days.includes(i) ? 'on' : ''}" data-d="${i}" title="${d}">${d[0]}</button>`).join('')}</div>
        <span class="small muted">${c.times.length}/day</span>
      </div>`;
    }).join('');
    this.root.querySelectorAll('.ap-row').forEach((row) => {
      const c = s.platforms[row.dataset.p];
      row.querySelector('.p-en').onchange = (e) => { c.enabled = e.target.checked; };
      row.querySelectorAll('.chip.time button').forEach((b) => { b.onclick = () => { c.times = c.times.filter((t) => t !== b.dataset.t); this.renderSettings(); }; });
      row.querySelector('.add-btn').onclick = () => {
        const v = row.querySelector('.add-time').value;
        if (v && !c.times.includes(v)) { c.times = [...c.times, v].sort(); this.renderSettings(); }
      };
      row.querySelectorAll('.day').forEach((b) => {
        b.onclick = () => {
          const d = Number(b.dataset.d);
          c.days = c.days.includes(d) ? c.days.filter((x) => x !== d) : [...c.days, d].sort();
          b.classList.toggle('on');
        };
      });
    });
  }

  async save() {
    const $ = (sel) => this.root.querySelector(sel);
    const body = { ...this.settings, enabled: $('.ap-enabled').checked, minScore: Number($('.ap-min').value), maxAgeHours: Number($('.ap-age').value), timezone: this.tz };
    this.settings = await api('/api/autopublish', { method: 'PUT', body });
    toast(this.settings.enabled ? 'Auto-publish schedule saved' : 'Auto-publish turned off', 'ok');
    this.renderSettings();
    this.renderCalendar();
  }

  // Configured auto-post times that have no post yet.
  openSlots(dayStart) {
    const s = this.settings;
    if (!s?.enabled) return [];
    const dow = new Date(dayStart).getDay();
    const out = [];
    for (const [p, c] of Object.entries(s.platforms)) {
      if (!c.enabled || !accountFor(this.accounts, p)?.connected || !c.days.includes(dow)) continue;
      for (const t of c.times) {
        const [h, m] = t.split(':').map(Number);
        const ts = new Date(dayStart).setHours(h, m, 0, 0);
        if (ts > Date.now()) out.push({ platform: p, ts });
      }
    }
    return out;
  }

  async renderCalendar() {
    const $ = (sel) => this.root.querySelector(sel);
    this.root.querySelectorAll('.cal-mode button').forEach((b) => b.classList.toggle('active', b.dataset.v === this.view));
    let from, days;
    if (this.view === 'week') {
      from = startOfWeek(this.anchor);
      days = 7;
      $('.cal-title').textContent = `Week of ${new Date(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else {
      const first = new Date(this.anchor); first.setDate(1);
      from = startOfWeek(first.getTime());
      days = 42;
      $('.cal-title').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    const to = from + days * DAY + DAY; // a little slack for DST
    this.posts = await api(`/api/posts?from=${from}&to=${to}`);
    const byDay = new Map();
    for (const p of this.posts) {
      const k = startOfDay(p.publishedAt || p.scheduledAt);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(p);
    }
    const cal = $('.calendar');
    const today = startOfDay(Date.now());
    const month = new Date(this.anchor).getMonth();
    const cells = [];
    for (let i = 0, d = from; i < days; i++, d = startOfDay(d + DAY + 3600000)) {
      const posts = (byDay.get(d) || []).sort((a, b) => (a.publishedAt || a.scheduledAt) - (b.publishedAt || b.scheduledAt));
      const taken = new Set(posts.filter((p) => p.status !== 'failed').map((p) => `${p.platform}@${hhmm(p.scheduledAt)}`));
      const open = this.openSlots(d).filter((s) => !taken.has(`${s.platform}@${hhmm(s.ts)}`));
      cells.push({ d, posts, open });
    }
    cal.className = `calendar ${this.view}`;
    cal.innerHTML = (this.view === 'month' ? DOW.map((x) => `<div class="cal-dow">${x}</div>`).join('') : '') + cells.map(({ d, posts, open }) => {
      const date = new Date(d);
      const head = `<div class="cal-head ${d === today ? 'today' : ''}">${this.view === 'week' ? `${DOW[date.getDay()]} ` : ''}<b>${date.getDate()}</b></div>`;
      if (this.view === 'month') {
        const counts = {};
        posts.forEach((p) => { counts[p.platform] = (counts[p.platform] || 0) + 1; });
        return `<div class="cal-day ${date.getMonth() !== month ? 'other' : ''} ${d === today ? 'is-today' : ''}" data-day="${d}">${head}
          <div class="row wrap" style="gap:4px">${Object.entries(counts).map(([p, n]) => `<span class="plat ${p}" title="${n} ${PLATFORM_META[p].short}">${n}</span>`).join('')}
          ${open.length ? `<span class="slot-dot" title="${open.length} open slot(s)"></span>` : ''}</div></div>`;
      }
      const items = [
        ...posts.map((p) => ({ ts: p.publishedAt || p.scheduledAt, html: this.card(p) })),
        ...open.map((s) => ({ ts: s.ts, html: `<div class="slot"><span class="plat ${s.platform}">${PLATFORM_META[s.platform].icon}</span>${hhmm(s.ts)} · open slot</div>` })),
      ].sort((a, b) => a.ts - b.ts);
      return `<div class="cal-day ${d === today ? 'is-today' : ''}" data-day="${d}">${head}${items.map((x) => x.html).join('') || '<div class="muted small" style="padding:6px">—</div>'}</div>`;
    }).join('');

    cal.querySelectorAll('.post-card').forEach((el) => {
      const post = this.posts.find((p) => p.id === el.dataset.id);
      el.onclick = () => this.openPost(post);
      el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', post.id); };
    });
    cal.querySelectorAll('.cal-day').forEach((el) => {
      if (this.view === 'month') { el.onclick = () => { this.anchor = Number(el.dataset.day); this.view = 'week'; this.renderCalendar(); }; return; }
      el.ondragover = (e) => { e.preventDefault(); el.classList.add('drop'); };
      el.ondragleave = () => el.classList.remove('drop');
      el.ondrop = async (e) => {
        e.preventDefault();
        el.classList.remove('drop');
        const post = this.posts.find((p) => p.id === e.dataTransfer.getData('text/plain'));
        if (!post || post.status !== 'scheduled') return;
        const t = new Date(post.scheduledAt);
        const at = new Date(Number(el.dataset.day)).setHours(t.getHours(), t.getMinutes(), 0, 0);
        try { await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { scheduledAt: at } }); toast('Rescheduled', 'ok'); } catch (err) { toast(err.message, 'error'); }
        this.renderCalendar();
      };
    });
  }

  card(p) {
    const m = PLATFORM_META[p.platform];
    return `<div class="post-card ${p.status}" data-id="${p.id}" draggable="${p.status === 'scheduled'}" title="${esc(p.clip?.title || '')}">
      <div class="thumb-mini" style="background-image:url('${p.clip?.thumbUrl || ''}')"></div>
      <div style="min-width:0">
        <div class="row small" style="gap:6px"><span class="plat ${p.platform}">${m.icon}</span><b>${hhmm(p.publishedAt || p.scheduledAt)}</b>${p.source === 'auto' ? '<span class="chip auto">auto</span>' : ''}</div>
        <div class="pc-title">${esc(p.clip?.title || '')}</div>
        <div class="small st">${STATUS[p.status] || p.status}${p.clip?.score != null ? ` · ${icon('flame')}${p.clip.score}` : ''}</div>
      </div></div>`;
  }

  openPost(p) {
    const m = PLATFORM_META[p.platform];
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="panel" style="width:min(460px,100%);display:grid;gap:12px">
      <div class="row"><span class="plat ${p.platform}">${m.icon}</span><h3 style="margin:0">${m.label}</h3><span class="spacer"></span><button class="btn sm ghost x" title="Close">${icon('x')}</button></div>
      <div class="row" style="align-items:flex-start"><div class="thumb-mini lg" style="background-image:url('${p.clip?.thumbUrl || ''}')"></div>
        <div style="display:grid;gap:4px"><b>${esc(p.clip?.title || '')}</b><span class="small muted">${esc(p.clip?.streamer || '')} · ${icon('flame')}${p.clip?.score ?? '–'} · ${p.source === 'auto' ? 'auto-scheduled' : 'manual'}</span>
        <span class="small">${STATUS[p.status]} · ${new Date(p.publishedAt || p.scheduledAt).toLocaleString()}</span>
        ${p.url ? `<a class="small" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}${icon('external')}</a>` : ''}
        ${p.error ? `<span class="small" style="color:var(--bad)">${esc(p.error)}</span>` : ''}</div></div>
      ${p.status === 'scheduled' ? `<div class="row"><input type="datetime-local" class="when" value="${localInput(p.scheduledAt)}"><button class="btn sm resched">Reschedule</button></div>` : ''}
      <div class="row wrap">
        ${p.status === 'scheduled' ? `<button class="btn sm primary now">${icon('upload')}Post now</button>` : ''}
        ${p.status === 'failed' ? `<button class="btn sm primary retry">${icon('refresh')}Retry</button>` : ''}
        <button class="btn sm open">Open clip</button><span class="spacer"></span>
        ${p.status !== 'publishing' ? `<button class="btn sm danger del">${p.status === 'scheduled' ? 'Unschedule' : 'Remove'}</button>` : ''}
      </div></div>`;
    document.body.append(back);
    const close = () => { back.remove(); this.renderCalendar(); };
    const q = (s) => back.querySelector(s);
    back.onclick = (e) => { if (e.target === back) close(); };
    q('.x').onclick = close;
    q('.open').onclick = () => { back.remove(); this.onOpenClip(p.clipId); };
    const act = async (fn, msg) => { try { await fn(); toast(msg, 'ok'); close(); } catch (e) { toast(e.message, 'error'); } };
    if (q('.resched')) q('.resched').onclick = () => act(() => api(`/api/posts/${p.id}`, { method: 'PATCH', body: { scheduledAt: new Date(q('.when').value).getTime() } }), 'Rescheduled');
    if (q('.now')) q('.now').onclick = () => act(() => api(`/api/posts/${p.id}`, { method: 'PATCH', body: { scheduledAt: Date.now() } }), 'Publishing now…');
    if (q('.retry')) q('.retry').onclick = () => act(() => api(`/api/posts/${p.id}/retry`, { method: 'POST' }), 'Retrying…');
    if (q('.del')) q('.del').onclick = () => act(() => api(`/api/posts/${p.id}`, { method: 'DELETE' }), 'Removed from schedule');
  }
}
