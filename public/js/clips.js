import { api, esc, toast, timeAgo } from './api.js';
import { shareClip, postText, UPLOAD_PAGES } from './publish.js';
import { getAccounts, accountFor, PLATFORM_META } from './accounts.js';
import { icon } from './icons.js';
import { renderClip } from './engine/render.js';
import { autoSubtitles, phrasesToText, textToPhrases } from './engine/transcribe.js';
import { getChannel } from './engine/twitch.js';

const PLAT_LABEL = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };
const PLAT_ICON = { youtube: icon('youtube'), tiktok: icon('tiktok'), instagram: icon('instagram') };

export class ClipLibrary {
  constructor(root, { config, onCounts = () => {} }) {
    this.root = root;
    this.config = config;
    this.onCounts = onCounts;
    this.filter = 'new';
    this.clips = [];
    root.innerHTML = `
      <div class="section-head">
        <div><h2 style="margin:0">Clip library</h2><div class="muted small">Rendered 9:16 clips saved on the server. New = not downloaded or posted yet.</div></div>
        <span class="spacer"></span>
        <div class="seg filters">
          <button data-f="new">New <span class="c-new"></span></button>
          <button data-f="all">All <span class="c-all"></span></button>
          <button data-f="downloaded">Downloaded <span class="c-downloaded"></span></button>
          <button data-f="posted">Posted <span class="c-posted"></span></button>
        </div>
        <button class="btn sm caption-all" title="Re-render clips that don't have subtitles yet">${icon('captions')}Caption all clips</button>
        <button class="btn sm refresh">${icon('refresh')}Refresh</button>
      </div>
      <div class="clip-grid"></div>`;
    root.querySelectorAll('.filters button').forEach((b) => { b.onclick = () => { this.filter = b.dataset.f; this.load(); }; });
    root.querySelector('.refresh').onclick = () => this.load();
    root.querySelector('.caption-all').onclick = (e) => this.captionAll(e.currentTarget).catch((err) => toast(err.message, 'error'));
  }

  async load() {
    const { clips, counts } = await api(`/api/clips?filter=${this.filter}`);
    this.clips = clips;
    this.root.querySelectorAll('.filters button').forEach((b) => b.classList.toggle('active', b.dataset.f === this.filter));
    for (const k of Object.keys(counts)) this.root.querySelector(`.c-${k}`).textContent = `(${counts[k]})`;
    this.onCounts(counts);
    const grid = this.root.querySelector('.clip-grid');
    if (!clips.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${this.filter === 'new' ? 'No new clips yet — start watching and viral moments will appear here automatically.' : 'No clips in this view.'}</div>`;
      return;
    }
    grid.innerHTML = clips.map((c) => `
      <div class="clip-card" data-id="${c.id}">
        <div class="thumb" style="background-image:url('${c.thumbUrl || ''}')">
          <div class="flags">
            ${c.isNew ? '<span class="badge new">New</span>' : ''}
            ${c.viral.subtitles?.length ? '<span class="badge" title="Has spoken subtitles">CC</span>' : ''}
            ${c.downloadedAt ? `<span class="plat dl" title="Downloaded">${icon('download')}</span>` : ''}
            ${Object.keys(c.posted).map((p) => `<span class="plat ${p}" title="Posted to ${PLAT_LABEL[p]}">${PLAT_ICON[p]}</span>`).join('')}
            ${(c.scheduled || []).map((s) => `<span class="badge" title="Scheduled on ${PLAT_LABEL[s.platform]} for ${new Date(s.at).toLocaleString()}">${icon('clock')}${PLAT_ICON[s.platform]}</span>`).join('')}
          </div>
          <div class="score">${icon('flame')}${c.viral.score ?? '–'}</div>
        </div>
        <div class="info">
          <div class="title">${esc(c.title)}</div>
          <div class="muted small">${esc(c.streamer)} · ${timeAgo(c.createdAt)}</div>
        </div>
      </div>`).join('');
    grid.querySelectorAll('.clip-card').forEach((card) => {
      const clip = clips.find((c) => c.id === card.dataset.id);
      card.onclick = () => this.open(clip);
      const thumb = card.querySelector('.thumb');
      card.onmouseenter = () => {
        const v = document.createElement('video');
        Object.assign(v, { src: clip.videoUrl, muted: true, autoplay: true, loop: true, playsInline: true });
        thumb.prepend(v);
      };
      card.onmouseleave = () => thumb.querySelector('video')?.remove();
    });
  }

  async mark(clip, body) {
    const updated = await api(`/api/clips/${clip.id}/mark`, { method: 'POST', body });
    Object.assign(clip, updated);
    return updated;
  }

  /**
   * Re-render a clip from its stored raw source (in the browser) with hook caption, chat bubble
   * and subtitles. With `autoTranscribe` and no subtitles given, speech is transcribed first.
   */
  async rerender(clip, { caption = clip.caption, chat = true, subtitles = [], autoTranscribe = true, onStatus = () => {} } = {}) {
    const v = clip.viral || {};
    const s = v.source || {};
    onStatus('Loading source…');
    const res = await fetch(`/api/clips/${clip.id}/source`);
    if (!res.ok) throw new Error('Raw source was not kept for this clip');
    const src = { bytes: new Uint8Array(await res.arrayBuffer()), ext: s.ext || 'ts', offsetSec: s.offset || 0, durationSec: s.duration || clip.duration || 30 };
    let transcript;
    if (!subtitles.length && autoTranscribe) {
      onStatus('Transcribing speech…');
      const language = v.language || (await getChannel(clip.streamer).catch(() => null))?.language || '';
      const sub = await autoSubtitles({
        ...src, language,
        onProgress: (p) => onStatus(p < 1 ? `Loading speech model ${Math.round(p * 100)}%` : 'Transcribing speech…'),
      });
      subtitles = sub.phrases;
      transcript = sub.text;
    }
    const out = await renderClip({
      ...src, caption, chatLine: chat ? (v.chatLine || '') : '', login: clip.streamer, subtitles,
      layout: s.layout || 'blur', resolution: s.resolution || '720x1280', captions: true, thumbAt: v.offsetInClip ?? 20,
      onProgress: (p) => onStatus(`Rendering ${Math.round(p * 100)}%`),
    });
    onStatus('Saving…');
    const form = new FormData();
    form.append('video', out.video, 'clip.mp4');
    if (out.thumb) form.append('thumb', out.thumb, 'thumb.jpg');
    form.append('caption', caption);
    form.append('subtitles', JSON.stringify(subtitles));
    if (transcript !== undefined) form.append('transcript', transcript);
    Object.assign(clip, await api(`/api/clips/${clip.id}/video`, { method: 'PUT', form }));
    return clip;
  }

  // Add captions + auto subtitles to every clip that doesn't have subtitles yet.
  async captionAll(btn) {
    const { clips } = await api('/api/clips?filter=all');
    const todo = clips.filter((c) => c.hasSource && !(c.viral?.subtitles?.length));
    if (!todo.length) { toast('All clips already have captions and subtitles', 'ok'); return; }
    if (!confirm(`Add captions + subtitles to ${todo.length} clip(s)? Rendering runs in this tab (~1–2 min per clip).`)) return;
    btn.disabled = true;
    let done = 0;
    for (const c of todo) {
      try {
        await this.rerender(c, { onStatus: (t) => { btn.innerHTML = `${icon('loader', 'spin')}${done + 1}/${todo.length}: ${t}`; } });
      } catch (e) { toast(`${c.title}: ${e.message}`, 'error'); }
      done++;
    }
    btn.disabled = false;
    btn.innerHTML = `${icon('captions')}Caption all clips`;
    toast(`Captioned ${done} clip(s)`, 'ok');
    this.load();
  }

  open(clip) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const v = clip.viral || {};
    back.innerHTML = `
      <div class="modal">
        <div class="video-col"><video controls playsinline src="${clip.videoUrl}" poster="${clip.thumbUrl || ''}"></video></div>
        <div class="form-col">
          <div class="row"><h2 style="margin:0">Clip details</h2><span class="spacer"></span><span class="status-badges row"></span><button class="btn sm ghost close" title="Close">${icon('x')}</button></div>
          <div class="viral-box">
            <div class="row"><b style="font-size:16px" class="row">${icon('flame', 'hot')}Viral score ${v.score ?? '–'}/100</b><span class="chip">${esc(v.category || '')}</span><span class="spacer"></span>
              <button class="btn sm jump">${icon('play')}Jump to viral point (${v.offsetInClip ?? 20}s)</button></div>
            <div>${esc(v.reason || '')}</div>
            <div class="muted small">${esc(clip.streamer)} · ${v.game ? `${esc(v.game)} · ` : ''}${v.at ? new Date(v.at).toLocaleString() : ''}${v.viewers ? ` · ${v.viewers.toLocaleString()} viewers` : ''}</div>
            ${v.topWords?.length ? `<div class="chips">${v.topWords.map((w) => `<span class="chip">${esc(w.word)} ×${w.count}</span>`).join('')}</div>` : ''}
            ${v.topMessages?.length ? `<div class="muted small row" style="gap:6px">${icon('message')}${v.topMessages.map((m) => `“${esc(m.text)}” ×${m.count}`).join(' · ')}</div>` : ''}
          </div>
          <label class="field">Title<input type="text" class="f-title" maxlength="100"></label>
          <label class="field">Description<textarea class="f-desc" rows="6"></textarea></label>
          <label class="field">Hashtags<input type="text" class="f-tags"></label>
          <div class="row"><button class="btn sm save">${icon('save')}Save details</button><button class="btn sm copy">${icon('copy')}Copy post text</button></div>
          <label class="field">On-video caption ${clip.hasSource ? '' : '(source not kept — cannot re-render)'}
            <div class="row"><input type="text" class="f-caption" maxlength="80"><label class="row small"><input type="checkbox" class="f-chat" checked> chat bubble</label></div></label>
          <label class="field">Subtitles (<code>start-end | text</code> per line — leave empty to auto-transcribe on re-render)
            <textarea class="f-subs" rows="5" style="font-family:ui-monospace,Consolas,monospace;font-size:12px"></textarea></label>
          <div class="row"><button class="btn sm rerender" ${clip.hasSource ? '' : 'disabled'}>${icon('film')}Re-render with captions</button><label class="row small"><input type="checkbox" class="f-subs-on" checked> subtitles</label><span class="rr-status muted small"></span></div>
          <hr style="border-color:var(--border);width:100%">
          <div class="row wrap">
            <a class="btn primary download" href="/api/clips/${clip.id}/download">${icon('download')}Download MP4</a>
            <button class="btn yt p-youtube">${icon('youtube')}YouTube Shorts</button>
            <button class="btn tt p-tiktok">${icon('tiktok')}TikTok</button>
            <button class="btn ig p-instagram">${icon('instagram')}Instagram Reels</button>
          </div>
          <div class="post-panel hidden panel" style="padding:12px"></div>
          <div class="row"><button class="btn sm ghost mark-new">${icon('undo')}Mark as new</button><span class="spacer"></span><button class="btn sm danger delete">${icon('trash')}Delete clip</button></div>
        </div>
      </div>`;
    document.body.append(back);
    const $ = (s) => back.querySelector(s);
    const video = $('video');
    $('.f-title').value = clip.title;
    $('.f-desc').value = clip.description;
    $('.f-tags').value = clip.hashtags.join(' ');
    $('.f-caption').value = clip.caption;
    $('.f-subs').value = phrasesToText(v.subtitles);

    const close = () => { back.remove(); this.load(); };
    $('.close').onclick = close;
    back.onclick = (e) => { if (e.target === back) close(); };
    $('.jump').onclick = () => { video.currentTime = Math.max(0, (v.offsetInClip ?? 20) - 2); video.play(); };

    const renderBadges = () => {
      $('.status-badges').innerHTML = [
        clip.isNew ? '<span class="badge new">New</span>' : '',
        clip.downloadedAt ? '<span class="badge done">Downloaded</span>' : '',
        ...Object.entries(clip.posted).map(([p, info]) => (info.url
          ? `<a class="badge done" href="${esc(info.url)}" target="_blank" rel="noopener">Posted · ${PLAT_LABEL[p]}${icon('external')}</a>`
          : `<span class="badge done">Posted · ${PLAT_LABEL[p]}</span>`)),
      ].join('');
    };
    renderBadges();

    const current = () => ({ ...clip, title: $('.f-title').value, description: $('.f-desc').value, hashtags: $('.f-tags').value.split(/[\s,]+/).filter(Boolean) });
    const save = async () => {
      const updated = await api(`/api/clips/${clip.id}`, { method: 'PATCH', body: { title: $('.f-title').value, description: $('.f-desc').value, hashtags: current().hashtags, caption: $('.f-caption').value } });
      Object.assign(clip, updated);
      $('.f-tags').value = clip.hashtags.join(' ');
    };
    $('.save').onclick = async () => { await save(); toast('Saved', 'ok'); };
    $('.copy').onclick = async () => { await navigator.clipboard.writeText(postText(current())); toast('Title + hashtags copied', 'ok'); };
    $('.download').onclick = () => setTimeout(async () => { Object.assign(clip, await api(`/api/clips/${clip.id}`)); renderBadges(); }, 1500);

    $('.rerender').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const status = $('.rr-status');
      try {
        await this.rerender(clip, {
          caption: $('.f-caption').value.trim(),
          chat: $('.f-chat').checked,
          subtitles: $('.f-subs-on').checked ? textToPhrases($('.f-subs').value) : [],
          autoTranscribe: $('.f-subs-on').checked,
          onStatus: (t) => { status.textContent = t; },
        });
        Object.assign(v, clip.viral);
        $('.f-subs').value = phrasesToText(v.subtitles);
        video.src = `${clip.videoUrl}?t=${Date.now()}`;
        status.textContent = 'Done';
      } catch (err) {
        status.textContent = '';
        toast(err.message, 'error');
      } finally { btn.disabled = false; }
    };

    const panel = $('.post-panel');
    const assisted = (platform) => {
      panel.classList.remove('hidden');
      panel.innerHTML = `
        <h3>Post to ${PLAT_LABEL[platform]}</h3>
        <ol class="small muted" style="padding-left:18px;margin:8px 0;display:grid;gap:6px">
          <li>Send the video to your device / app: <button class="btn sm a-share">${icon('share')}Share</button> or <a class="btn sm a-dl" href="/api/clips/${clip.id}/download">${icon('download')}Download</a></li>
          <li>Copy the caption: <button class="btn sm a-copy">${icon('copy')}Copy title + hashtags</button></li>
          <li>Open the uploader: <a class="btn sm" target="_blank" rel="noopener" href="${UPLOAD_PAGES[platform]}">Open ${PLAT_LABEL[platform]}${icon('external')}</a></li>
          <li>Paste the post link (optional) and mark it: <div class="row" style="margin-top:6px"><input type="url" class="a-url" placeholder="https://..."><button class="btn sm primary a-mark">${icon('check')}Mark posted</button></div></li>
        </ol>`;
      panel.querySelector('.a-share').onclick = async () => {
        try { if (!(await shareClip(current()))) toast('Sharing files is not supported in this browser — use Download instead', 'error'); } catch (err) { if (err.name !== 'AbortError') toast(err.message, 'error'); }
      };
      panel.querySelector('.a-dl').onclick = () => setTimeout(async () => { Object.assign(clip, await api(`/api/clips/${clip.id}`)); renderBadges(); }, 1500);
      panel.querySelector('.a-copy').onclick = async () => { await navigator.clipboard.writeText(postText(current())); toast('Copied', 'ok'); };
      panel.querySelector('.a-mark').onclick = async () => {
        await this.mark(clip, { action: 'posted', platform, url: panel.querySelector('.a-url').value.trim() });
        renderBadges();
        toast(`Marked as posted to ${PLAT_LABEL[platform]}`, 'ok');
      };
    };

    $('.p-tiktok').onclick = () => publishPanel('tiktok');
    $('.p-instagram').onclick = () => publishPanel('instagram');
    $('.p-youtube').onclick = () => publishPanel('youtube');

    // Linked account: server uploads for you (now or at a scheduled time); otherwise connect or post manually.
    const STATUS = { scheduled: `${icon('clock')}Scheduled`, publishing: `${icon('loader', 'spin')}Publishing`, published: `${icon('check-circle', 'ok')}Published`, failed: `${icon('alert', 'bad')}Failed`, canceled: 'Canceled' };
    let pollTimer = null;
    const publishPanel = async (platform) => {
      clearTimeout(pollTimer);
      const accounts = await getAccounts();
      const acc = accountFor(accounts, platform);
      const label = PLATFORM_META[platform].label;
      panel.classList.remove('hidden');
      if (!acc?.connected) {
        panel.innerHTML = `<h3>${label}</h3>
          <p class="small muted" style="margin:6px 0 10px">Link your ${label} account once and SlientClip will upload clips for you — instantly, on a schedule, or automatically.</p>
          <div class="row wrap">${acc?.configured ? `<a class="btn primary" href="/connect/${platform}">${icon('link')}Connect ${label}</a>` : `<span class="small" style="color:var(--warn)">${label} isn't configured on this server yet (app keys missing in .env).</span>`}
          <a href="#" class="small manual">or post manually</a></div>`;
        panel.querySelector('.manual').onclick = (e) => { e.preventDefault(); assisted(platform); };
        return;
      }
      const inHour = new Date(Date.now() + 3600000);
      inHour.setMinutes(0, 0, 0);
      const pad = (n) => String(n).padStart(2, '0');
      const local = `${inHour.getFullYear()}-${pad(inHour.getMonth() + 1)}-${pad(inHour.getDate())}T${pad(inHour.getHours())}:00`;
      panel.innerHTML = `<div class="row"><h3 style="margin:0">${label}</h3><span class="small muted">as @${esc(acc.username || acc.displayName)}</span>${accounts.demo ? '<span class="badge elsewhere">demo</span>' : ''}</div>
        <div class="row wrap" style="margin:10px 0">
          <button class="btn primary now">${icon('upload')}Post now</button>
          <span class="muted small">or</span>
          <input type="datetime-local" class="when" value="${local}" style="width:auto"><button class="btn sched">${icon('calendar')}Schedule</button>
        </div>
        <div class="post-list"></div>
        <div class="small muted" style="margin-top:6px">Uses the title + hashtags above. <a href="#" class="manual">Post manually instead</a></div>`;
      panel.querySelector('.manual').onclick = (e) => { e.preventDefault(); assisted(platform); };
      const list = panel.querySelector('.post-list');
      const refresh = async () => {
        const posts = (await api(`/api/posts?clipId=${clip.id}`)).filter((p) => p.platform === platform && p.status !== 'canceled');
        list.innerHTML = posts.map((p) => `<div class="item"><b>${STATUS[p.status]}</b>
          <span class="muted">${new Date(p.publishedAt || p.scheduledAt).toLocaleString()}${p.source === 'auto' ? ' · auto' : ''}</span>
          ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">open${icon('external')}</a>` : ''}
          ${p.error ? `<span style="color:var(--bad)">${esc(p.error)}</span>` : ''}<span class="spacer"></span>
          ${p.status === 'scheduled' ? `<button class="btn sm ghost unsched" data-id="${p.id}" title="Unschedule">${icon('x')}</button>` : ''}
          ${p.status === 'failed' ? `<button class="btn sm retry" data-id="${p.id}">${icon('refresh')}Retry</button>` : ''}</div>`).join('');
        list.querySelectorAll('.unsched').forEach((b) => { b.onclick = async () => { await api(`/api/posts/${b.dataset.id}`, { method: 'DELETE' }); refresh(); }; });
        list.querySelectorAll('.retry').forEach((b) => { b.onclick = async () => { await api(`/api/posts/${b.dataset.id}/retry`, { method: 'POST' }); refresh(); }; });
        if (posts.some((p) => p.status === 'published')) { Object.assign(clip, await api(`/api/clips/${clip.id}`)); renderBadges(); }
        if (posts.some((p) => p.status === 'publishing' || (p.status === 'scheduled' && p.scheduledAt <= Date.now() + 60000)) && back.isConnected) {
          pollTimer = setTimeout(refresh, 2000);
        }
      };
      const create = async (scheduledAt) => {
        try {
          await save();
          await api('/api/posts', { method: 'POST', body: { clipId: clip.id, platform, scheduledAt } });
          toast(scheduledAt ? `Scheduled for ${new Date(scheduledAt).toLocaleString()}` : `Uploading to ${label}…`, 'ok');
          refresh();
        } catch (err) { toast(err.message, 'error'); }
      };
      panel.querySelector('.now').onclick = () => create();
      panel.querySelector('.sched').onclick = () => {
        const at = new Date(panel.querySelector('.when').value).getTime();
        if (!(at > Date.now())) return toast('Pick a time in the future', 'error');
        create(at);
      };
      refresh();
    };
    $('.mark-new').onclick = async () => { await this.mark(clip, { action: 'new' }); renderBadges(); toast('Marked as new', 'ok'); };
    $('.delete').onclick = async () => {
      if (!confirm('Delete this clip permanently?')) return;
      await api(`/api/clips/${clip.id}`, { method: 'DELETE' });
      close();
    };
  }
}
