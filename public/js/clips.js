import { api, esc, toast, timeAgo } from './api.js';
import { shareClip, postText, UPLOAD_PAGES } from './publish.js';
import { getAccounts, accountFor, PLATFORM_META, loginTo } from './accounts.js';
import { openBrowserViewer } from './browser-view.js';
import { icon } from './icons.js';
import { skeleton, showLoading, lazyImages } from './loader.js';
import { renderClip, sourceStill } from './engine/render.js';
import { planCam, getCamSetting, saveCamSetting } from './engine/cam.js';
import { describePlan } from './engine/facecam.js';
import { autoSubtitles, phrasesToText, textToPhrases } from './engine/transcribe.js';
import { getChannel } from './engine/twitch.js';

const PLAT_LABEL = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };
const PLAT_SHORT = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Reels' };
const PLATFORMS = ['youtube', 'tiktok', 'instagram'];
const PLAT_ICON = { youtube: icon('youtube'), tiktok: icon('tiktok'), instagram: icon('instagram') };

export class ClipLibrary {
  constructor(root, { config, onCounts = () => {} }) {
    this.root = root;
    this.config = config;
    this.onCounts = onCounts;
    this.filter = 'new';
    this.clips = [];
    this.loadSeq = 0;
    this.shownFilter = null;
    root.innerHTML = `
      <div class="section-head">
        <div><h2 style="margin:0">Clip library</h2><div class="muted small">Rendered 9:16 clips saved on the server. New = not downloaded or posted yet.</div>
          <div class="small muted storage-note hidden"></div></div>
        <span class="spacer"></span>
        <div class="seg filters">
          <button data-f="new">New <span class="c-new"></span></button>
          <button data-f="all">All <span class="c-all"></span></button>
          <button data-f="downloaded">Downloaded <span class="c-downloaded"></span></button>
          <button data-f="posted">Posted <span class="c-posted"></span></button>
        </div>
        <button class="btn sm select-toggle" title="Select clips to delete or mark as published">${icon('check')}Select</button>
        <button class="btn sm caption-all" title="Re-render clips that don't have subtitles yet">${icon('captions')}Caption all clips</button>
        <button class="btn sm refresh">${icon('refresh')}Refresh</button>
      </div>
      <div class="select-bar hidden">
        <b class="sel-count">0 selected</b>
        <button class="btn sm sel-all"></button>
        <button class="btn sm ghost sel-none">Clear</button>
        <span class="spacer"></span>
        <button class="btn sm primary sel-publish" title="You published these yourself: they leave the auto-post schedule and are deleted automatically after 24 hours">${icon('check')}Mark published</button>
        <button class="btn sm sel-unpublish hidden" title="Keep these clips: undo Mark published">${icon('undo')}Unmark</button>
        <button class="btn sm danger sel-delete">${icon('trash')}Delete</button>
        <button class="btn sm ghost sel-done" title="Leave selection mode">${icon('x')}</button>
      </div>
      <div class="clip-grid"></div>`;
    this.selecting = false;
    this.selected = new Set();
    root.querySelectorAll('.filters button').forEach((b) => { b.onclick = () => { this.filter = b.dataset.f; this.selected.clear(); this.load(); }; });
    root.querySelector('.refresh').onclick = () => this.load();
    root.querySelector('.caption-all').onclick = (e) => this.captionAll(e.currentTarget).catch((err) => toast(err.message, 'error'));
    root.querySelector('.select-toggle').onclick = () => this.setSelecting(!this.selecting);
    root.querySelector('.sel-done').onclick = () => this.setSelecting(false);
    root.querySelector('.sel-none').onclick = () => { this.selected.clear(); this.syncSelection(); };
    root.querySelector('.sel-all').onclick = () => {
      const all = this.clips.length && this.clips.every((c) => this.selected.has(c.id));
      this.selected = all ? new Set() : new Set(this.clips.map((c) => c.id));
      this.syncSelection();
    };
    root.querySelector('.sel-publish').onclick = () => this.bulk('published').catch((err) => toast(err.message, 'error'));
    root.querySelector('.sel-unpublish').onclick = () => this.bulk('unpublished').catch((err) => toast(err.message, 'error'));
    root.querySelector('.sel-delete').onclick = () => this.bulk('delete').catch((err) => toast(err.message, 'error'));
  }

  setSelecting(on) {
    this.selecting = on;
    if (!on) this.selected.clear();
    this.root.querySelector('.select-toggle').classList.toggle('active', on);
    this.root.querySelector('.select-bar').classList.toggle('hidden', !on);
    this.root.querySelector('.clip-grid').classList.toggle('selecting', on);
    this.root.querySelectorAll('.clip-card .thumb video').forEach((v) => v.remove());
    this.syncSelection();
  }

  /** Reflect the selection on the cards and the bar. */
  syncSelection() {
    const ids = new Set(this.clips.map((c) => c.id));
    for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
    this.root.querySelectorAll('.clip-card[data-id]').forEach((card) => card.classList.toggle('selected', this.selected.has(card.dataset.id)));
    const n = this.selected.size;
    const chosen = this.clips.filter((c) => this.selected.has(c.id));
    const all = this.clips.length > 0 && n === this.clips.length;
    this.root.querySelector('.sel-count').textContent = `${n} selected`;
    this.root.querySelector('.sel-all').textContent = all ? 'Unselect all' : `Select all in ${this.filterLabel()} (${this.clips.length})`;
    this.root.querySelector('.sel-all').disabled = !this.clips.length;
    for (const k of ['.sel-delete', '.sel-none']) this.root.querySelector(k).disabled = !n;
    this.root.querySelector('.sel-publish').disabled = !chosen.some((c) => !c.publishedAt);
    this.root.querySelector('.sel-unpublish').classList.toggle('hidden', !chosen.some((c) => c.publishedAt));
  }

  filterLabel() {
    return { new: 'New', all: 'All', downloaded: 'Downloaded', posted: 'Posted' }[this.filter] || 'this view';
  }

  async bulk(action) {
    const ids = [...this.selected];
    if (!ids.length) return;
    const n = ids.length === 1 ? '1 clip' : `${ids.length} clips`;
    if (action === 'delete' && !confirm(`Delete ${n}? The videos are removed from the server and posts still waiting to go out are canceled. Past posts stay in the Schedule as history. This can't be undone.`)) return;
    if (action === 'published' && !confirm(`Mark ${n} as published?\n\nThey are taken off the auto-post schedule and deleted automatically after 24 hours.`)) return;
    const r = await api('/api/clips/bulk', { method: 'POST', body: { action, ids } });
    const verb = { delete: 'Deleted', published: 'Marked as published', unpublished: 'Unmarked' }[action];
    toast(`${verb}: ${r.done === 1 ? '1 clip' : `${r.done} clips`}${r.skipped ? ` (${r.skipped} skipped: being posted right now)` : ''}${action === 'published' ? '. They will be deleted in 24 hours.' : ''}`, 'ok');
    this.selected.clear();
    await this.load();
  }

  async load() {
    const filter = this.filter;
    const seq = ++this.loadSeq;
    const grid = this.root.querySelector('.clip-grid');
    this.root.querySelectorAll('.filters button').forEach((b) => b.classList.toggle('active', b.dataset.f === filter));
    // Skeletons only when the grid would otherwise show stale or no content; background refreshes swap in place.
    const fresh = filter !== this.shownFilter;
    const idle = fresh ? showLoading(grid, skeleton.clips()) : () => {};
    let data;
    try {
      data = await api(`/api/clips?filter=${filter}`);
    } catch (e) {
      if (fresh && seq === this.loadSeq) { idle(); grid.innerHTML = `<div class="empty" style="grid-column:1/-1">Couldn't load clips: ${esc(e.message)}</div>`; }
      throw e;
    }
    if (seq !== this.loadSeq) return;
    idle();
    this.shownFilter = filter;
    const { clips, counts, storage } = data;
    this.clips = clips;
    this.renderStorage(storage);
    for (const k of Object.keys(counts)) this.root.querySelector(`.c-${k}`).textContent = `(${counts[k]})`;
    this.onCounts(counts);
    if (!clips.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${this.filter === 'new' ? 'No new clips yet — start watching and viral moments will appear here automatically.' : 'No clips in this view.'}</div>`;
      this.syncSelection();
      return;
    }
    const leftOf = (t) => { const h = Math.max(0, (t - Date.now()) / 3600000); return h >= 1 ? `${Math.round(h)} h` : `${Math.max(1, Math.round(h * 60))} min`; };
    grid.innerHTML = clips.map((c) => `
      <div class="clip-card ${this.selected.has(c.id) ? 'selected' : ''}" data-id="${c.id}">
        <div class="thumb lazy-bg" data-bg="${esc(c.thumbUrl || '')}">
          <span class="sel-box" aria-hidden="true">${icon('check')}</span>
          <div class="flags">
            ${c.isNew ? '<span class="badge new">New</span>' : ''}
            ${c.publishedAt ? `<span class="badge published" title="Marked published ${timeAgo(c.publishedAt)}. Not auto-posted, and deleted automatically in ${leftOf(c.deletesAt)}.">Published</span>` : ''}
            ${c.viral.subtitles?.length ? '<span class="badge" title="Has spoken subtitles">CC</span>' : ''}
            ${c.downloadedAt ? `<span class="plat dl" title="Downloaded">${icon('download')}</span>` : ''}
          </div>
          <div class="score">${icon('flame')}${c.viral.score ?? '–'}</div>
        </div>
        <div class="info">
          <div class="title">${esc(c.title)}</div>
          <div class="muted small">${esc(c.streamer)} · ${timeAgo(c.createdAt)}</div>
          ${c.publishedAt ? `<div class="small deletes-note">${icon('clock')} Deletes in ${leftOf(c.deletesAt)}</div>` : ''}
          <div class="card-publish">${PLATFORMS.map((p) => this.publishButton(c, p)).join('')}</div>
        </div>
      </div>`).join('');
    lazyImages(grid);
    grid.querySelectorAll('.clip-card').forEach((card) => {
      const clip = clips.find((c) => c.id === card.dataset.id);
      card.onclick = () => {
        if (!this.selecting) return this.open(clip);
        if (this.selected.has(clip.id)) this.selected.delete(clip.id); else this.selected.add(clip.id);
        this.syncSelection();
      };
      card.querySelectorAll('.pub').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); this.quickPost(clip, b.dataset.p, b).catch((err) => toast(err.message, 'error')); };
      });
      const thumb = card.querySelector('.thumb');
      card.onmouseenter = () => {
        if (this.selecting) return;
        const v = document.createElement('video');
        Object.assign(v, { src: clip.videoUrl, muted: true, autoplay: true, loop: true, playsInline: true });
        thumb.prepend(v);
      };
      card.onmouseleave = () => thumb.querySelector('video')?.remove();
    });
    this.syncSelection();
    // While a post from this list is running, keep the buttons' state fresh.
    clearTimeout(this.pollTimer);
    const active = clips.some((c) => (c.scheduled || []).some((s) => s.status === 'publishing' || s.at <= Date.now() + 60000));
    if (active) this.pollTimer = setTimeout(() => { if (this.root.offsetParent) this.load().catch(() => {}); }, 4000);
  }

  publishButton(c, p) {
    const label = PLAT_LABEL[p];
    const pending = (c.scheduled || []).find((s) => s.platform === p);
    const posted = c.posted[p];
    let state = '';
    let title = `Post to ${label} now`;
    let badge = '';
    if (pending?.status === 'publishing' || (pending && pending.at <= Date.now())) {
      state = 'publishing'; title = `Posting to ${label}…`; badge = icon('loader', 'spin');
    } else if (pending) {
      state = 'scheduled'; title = `Scheduled on ${label} for ${new Date(pending.at).toLocaleString()} — click to post now instead`; badge = icon('clock');
    } else if (posted) {
      state = 'posted'; title = `Posted to ${label} ${timeAgo(posted.at)} — click to post again`; badge = icon('check');
    }
    return `<button class="pub plat-btn ${p} ${state}" data-p="${p}" title="${esc(title)}" aria-label="${esc(title)}" ${state === 'publishing' ? 'disabled' : ''}>
      ${PLAT_ICON[p]}<span class="pub-label">${PLAT_SHORT[p]}</span>${badge ? `<span class="pub-state">${badge}</span>` : ''}</button>`;
  }

  /** Post straight from the clip list: one click per platform (asks to log in first if needed). */
  async quickPost(clip, platform, btn) {
    const label = PLAT_LABEL[platform];
    const accounts = await getAccounts(true);
    const acc = accountFor(accounts, platform);
    if (!acc?.connected) {
      if (acc?.route === 'extension') {
        toast('YouTube posts go through your Chrome extension, which isn\'t ready. Check it in Settings → Social accounts, or switch YouTube to the server browser there.', 'error');
        return;
      }
      toast(`Log in to ${label} once, then the clip is posted.`);
      return loginTo(platform, () => this.quickPost(clip, platform, btn));
    }
    const pending = (clip.scheduled || []).find((s) => s.platform === platform);
    const posted = clip.posted[platform];
    const note = posted ? `\n\nIt was already posted to ${label} ${timeAgo(posted.at)}; this posts it again.`
      : pending ? `\n\nThis replaces the post scheduled for ${new Date(pending.at).toLocaleString()}.` : '';
    if (!confirm(`Post "${clip.title}" to ${label} now?${note}`)) return;
    btn.disabled = true;
    btn.classList.add('publishing');
    try {
      const post = await api('/api/posts', { method: 'POST', body: { clipId: clip.id, platform } });
      toast(`Posting to ${label}. You'll be notified when it's done.`, 'ok');
      if ((await api('/api/me')).settings.publishView === 'foreground') this.watchWhenStarted(clip.id, post.id, label);
    } catch (e) {
      toast(e.message, 'error');
    }
    this.load().catch(() => {});
  }

  // "Show the browser while posting": open the live view as soon as the post's browser starts.
  async watchWhenStarted(clipId, postId, label) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = (await api(`/api/posts?clipId=${clipId}`).catch(() => [])).find((x) => x.id === postId);
      if (!p || p.status !== 'scheduled' && p.status !== 'publishing') return;
      if (p.sessionId) return openBrowserViewer({ sessionId: p.sessionId, mode: 'watch', title: `Posting to ${label}` });
    }
  }

  // Only shown when an admin has set a storage limit for this account.
  renderStorage(storage) {
    const el = this.root.querySelector('.storage-note');
    el.classList.toggle('hidden', !storage?.limit);
    if (!storage?.limit) return;
    const size = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
    const pct = Math.min(100, (storage.used / storage.limit) * 100);
    el.innerHTML = `<div class="quota-bar ${pct >= 100 ? 'full' : pct >= 80 ? 'high' : ''}"><div style="width:${pct}%"></div></div>
      <span>${size(storage.used)} of ${size(storage.limit)} used${pct >= 80 ? ' · when full, your oldest clips are replaced by new ones' : ''}</span>`;
  }

  async mark(clip, body) {
    const updated = await api(`/api/clips/${clip.id}/mark`, { method: 'POST', body });
    Object.assign(clip, updated);
    return updated;
  }

  /**
   * Re-render a clip from its stored raw source (in the browser) with the hook caption and
   * subtitles. With `autoTranscribe` and no subtitles given, speech is transcribed first.
   */
  async rerender(clip, { caption = clip.caption, subtitles = [], autoTranscribe = true, layout, onStatus = () => {} } = {}) {
    const v = clip.viral || {};
    const s = v.source || {};
    layout ||= s.layout || 'blur';
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
    const cam = layout === 'facecam' ? await planCam(clip.streamer, src, { known: s.cam, onStatus }) : null;
    const out = await renderClip({
      ...src, caption, subtitles,
      layout, cam, resolution: s.resolution || '720x1280', captions: true, thumbAt: v.offsetInClip ?? 20,
      onProgress: (p) => onStatus(`Rendering ${Math.round(p * 100)}%`),
    });
    onStatus('Saving…');
    const form = new FormData();
    form.append('video', out.video, 'clip.mp4');
    if (out.thumb) form.append('thumb', out.thumb, 'thumb.jpg');
    form.append('caption', caption);
    form.append('subtitles', JSON.stringify(subtitles));
    form.append('source', JSON.stringify({ layout, cam, rendered: out.layout }));
    if (transcript !== undefined) form.append('transcript', transcript);
    Object.assign(clip, await api(`/api/clips/${clip.id}/video`, { method: 'PUT', form }));
    return clip;
  }

  /**
   * Shows a frame of the clip with a box around the streamer's webcam to drag, move or redraw. Saving stores it
   * for this streamer (used for this and future clips); "Auto-detect" and "No cam" switch the streamer back.
   */
  async camPicker(clip, box, onSaved) {
    if (!box.classList.contains('hidden') && box.dataset.ready) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = `<div class="small muted row">${icon('loader', 'spin')}Loading a frame of the clip…</div>`;
    const v = clip.viral || {};
    const s = v.source || {};
    let still, setting;
    try {
      const res = await fetch(`/api/clips/${clip.id}/source`);
      if (!res.ok) throw new Error('Raw source was not kept for this clip');
      const bytes = new Uint8Array(await res.arrayBuffer());
      [still, setting] = await Promise.all([
        sourceStill({ bytes, ext: s.ext || 'ts', offsetSec: s.offset || 0, atSec: v.offsetInClip ?? 5 }),
        getCamSetting(clip.streamer),
      ]);
    } catch (e) {
      box.innerHTML = `<div class="small" style="color:var(--bad)">Couldn't load a frame of this clip: ${esc(e?.message || String(e))}</div>`;
      return;
    }
    let r = { ...(setting.mode === 'manual' && setting.box ? setting.box : s.cam?.cam || setting.last?.cam || { x: 0.02, y: 0.6, w: 0.24, h: 0.32 }) };
    const url = URL.createObjectURL(still);
    box.dataset.ready = '1';
    box.innerHTML = `
      <div class="small muted">Drag the box around <b>${esc(clip.streamer)}'s webcam</b> (move it, pull the corner, or draw a new one). It goes on top of the clip, above the gameplay.</div>
      <div class="cam-stage"><img alt="Frame of the clip" draggable="false"><div class="cam-rect"><span class="cam-handle"></span></div></div>
      <div class="row wrap">
        <button class="btn sm primary cam-save">${icon('check')}Use for ${esc(clip.streamer)} and re-render</button>
        <button class="btn sm ghost cam-auto" title="Find the cam automatically in every clip">${icon('refresh')}Auto-detect</button>
        <button class="btn sm ghost cam-off" title="This streamer has no webcam: use the full frame">No cam</button>
        <span class="small muted">Now: ${{ manual: 'set by you', off: 'no cam', auto: 'auto-detect' }[setting.mode]}</span>
      </div>`;
    const stage = box.querySelector('.cam-stage');
    const rectEl = box.querySelector('.cam-rect');
    box.querySelector('img').src = url;
    const draw = () => Object.assign(rectEl.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
    draw();
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    stage.onpointerdown = (e) => {
      e.preventDefault();
      const b = stage.getBoundingClientRect();
      const pt = (ev) => ({ x: clamp((ev.clientX - b.left) / b.width, 0, 1), y: clamp((ev.clientY - b.top) / b.height, 0, 1) });
      const p0 = pt(e);
      const start = { ...r };
      const mode = e.target.classList.contains('cam-handle') ? 'resize' : e.target === rectEl ? 'move' : 'draw';
      stage.setPointerCapture(e.pointerId);
      stage.onpointermove = (ev) => {
        const p = pt(ev);
        if (mode === 'move') {
          r.x = clamp(start.x + p.x - p0.x, 0, 1 - start.w);
          r.y = clamp(start.y + p.y - p0.y, 0, 1 - start.h);
        } else if (mode === 'resize') {
          r.w = clamp(p.x - start.x, 0.03, 1 - start.x);
          r.h = clamp(p.y - start.y, 0.03, 1 - start.y);
        } else {
          r = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
        }
        draw();
      };
      stage.onpointerup = () => {
        stage.onpointermove = null;
        if (r.w < 0.03 || r.h < 0.03) r = start;
        draw();
      };
    };
    const finish = async (body, msg) => {
      try {
        await saveCamSetting(clip.streamer, body);
        toast(msg, 'ok');
        URL.revokeObjectURL(url);
        box.classList.add('hidden');
        delete box.dataset.ready;
        onSaved();
      } catch (e) { toast(e.message, 'error'); }
    };
    box.querySelector('.cam-save').onclick = () => finish({ mode: 'manual', box: r }, `Streamer cam saved for ${clip.streamer}`);
    box.querySelector('.cam-auto').onclick = () => finish({ mode: 'auto' }, `${clip.streamer}: the cam is found automatically`);
    box.querySelector('.cam-off').onclick = () => finish({ mode: 'off' }, `${clip.streamer}: clips use the full frame`);
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
    const s0 = v.source || {};
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
            <input type="text" class="f-caption" maxlength="80"></label>
          <div class="field">Layout
            <div class="row wrap"><select class="f-layout" style="width:auto">
              <option value="facecam">Streamer cam + gameplay</option><option value="blur">Full frame + blurred background</option><option value="crop">Center crop (fill)</option></select>
              <button class="btn sm ghost set-cam" ${clip.hasSource ? '' : 'disabled'} title="Show where ${esc(clip.streamer)}'s webcam is, for this and future clips">${icon('eye')}Set streamer cam</button></div>
            <span class="small muted cam-info">${esc(s0.layout === 'facecam' ? describePlan(s0.cam) : '')}</span>
            <div class="cam-picker hidden"></div></div>
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
    $('.f-layout').value = s0.layout || 'blur';
    $('.set-cam').onclick = () => this.camPicker(clip, $('.cam-picker'), () => { $('.f-layout').value = 'facecam'; $('.rerender').click(); });

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
          subtitles: $('.f-subs-on').checked ? textToPhrases($('.f-subs').value) : [],
          autoTranscribe: $('.f-subs-on').checked,
          layout: $('.f-layout').value,
          onStatus: (t) => { status.textContent = t; },
        });
        Object.assign(v, clip.viral);
        $('.cam-info').textContent = v.source?.layout === 'facecam' ? describePlan(v.source.cam) : '';
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
      panel.classList.remove('hidden');
      const idle = showLoading(panel, `<div class="post-list">${skeleton.posts(2)}</div>`);
      const accounts = await getAccounts()
        .catch((e) => { panel.innerHTML = `<div class="small" style="color:var(--bad)">${esc(e.message)}</div>`; throw e; })
        .finally(idle);
      const acc = accountFor(accounts, platform);
      const label = PLATFORM_META[platform].label;
      if (!acc?.connected) {
        panel.innerHTML = `<h3>${label}</h3>
          <p class="small muted" style="margin:6px 0 10px">${acc?.known ? `Your ${label} session has expired.` : `Log in to ${label} once.`} SlientClip then posts for you in a real browser: instantly, on a schedule, or automatically.</p>
          <div class="row wrap"><button class="btn primary login">${icon('login')}Log in to ${label}</button>
          <a href="#" class="small manual">or post manually</a></div>`;
        panel.querySelector('.login').onclick = () => loginTo(platform, () => publishPanel(platform)).catch((err) => toast(err.message, 'error'));
        panel.querySelector('.manual').onclick = (e) => { e.preventDefault(); assisted(platform); };
        return;
      }
      const inHour = new Date(Date.now() + 3600000);
      inHour.setMinutes(0, 0, 0);
      const pad = (n) => String(n).padStart(2, '0');
      const local = `${inHour.getFullYear()}-${pad(inHour.getMonth() + 1)}-${pad(inHour.getDate())}T${pad(inHour.getHours())}:00`;
      panel.innerHTML = `<div class="row"><h3 style="margin:0">${label}</h3><span class="small muted">${acc.username || acc.displayName ? `as ${acc.username ? '@' : ''}${esc(acc.username || acc.displayName)}` : 'logged in'}</span>${accounts.demo || acc.demo ? '<span class="badge elsewhere">demo</span>' : ''}</div>
        <div class="row wrap" style="margin:10px 0">
          <button class="btn primary now">${icon('upload')}Post now</button>
          <span class="muted small">or</span>
          <input type="datetime-local" class="when" value="${local}" style="width:auto"><button class="btn sched">${icon('calendar')}Schedule</button>
        </div>
        <div class="post-list"></div>
        <div class="small muted" style="margin-top:6px">A browser on the server posts the title + hashtags above, like a person would. <a href="#" class="manual">Post manually instead</a></div>`;
      panel.querySelector('.manual').onclick = (e) => { e.preventDefault(); assisted(platform); };
      const list = panel.querySelector('.post-list');
      const listIdle = showLoading(list, skeleton.posts());
      const watched = new Set();
      let autoWatch = false;
      const watch = (p) => openBrowserViewer({ sessionId: p.sessionId, mode: 'watch', title: `Posting to ${label}` });
      const refresh = async () => {
        const posts = (await api(`/api/posts?clipId=${clip.id}`).catch((e) => { if (list.hasAttribute('aria-busy')) list.innerHTML = ''; throw e; }).finally(listIdle)).filter((p) => p.platform === platform && p.status !== 'canceled');
        list.innerHTML = posts.map((p) => `<div class="item"><b>${STATUS[p.status]}</b>
          <span class="muted">${p.status === 'publishing' && p.step ? esc(p.step) : new Date(p.publishedAt || p.scheduledAt).toLocaleString()}${p.source === 'auto' ? ' · auto' : ''}</span>
          ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">open${icon('external')}</a>` : ''}
          ${p.error ? `<span style="color:var(--bad)">${esc(p.error)}</span>` : ''}<span class="spacer"></span>
          ${p.sessionId ? `<button class="btn sm watch" data-id="${p.id}">${icon('eye')}Watch</button>` : ''}
          ${p.screenshotUrl ? `<a class="btn sm ghost" href="${p.screenshotUrl}" target="_blank" rel="noopener" title="What the browser showed when it failed">${icon('image')}Screenshot</a>` : ''}
          ${p.status === 'scheduled' ? `<button class="btn sm ghost unsched" data-id="${p.id}" title="Unschedule">${icon('x')}</button>` : ''}
          ${p.status === 'failed' ? `<button class="btn sm retry" data-id="${p.id}">${icon('refresh')}Retry</button>` : ''}</div>`).join('');
        list.querySelectorAll('.watch').forEach((b) => { b.onclick = () => watch(posts.find((p) => p.id === b.dataset.id)); });
        list.querySelectorAll('.unsched').forEach((b) => { b.onclick = async () => { await api(`/api/posts/${b.dataset.id}`, { method: 'DELETE' }); refresh(); }; });
        list.querySelectorAll('.retry').forEach((b) => { b.onclick = async () => { await api(`/api/posts/${b.dataset.id}/retry`, { method: 'POST' }); refresh(); }; });
        // Foreground mode: show the posting browser as soon as it starts.
        for (const p of posts) {
          if (autoWatch && p.sessionId && !watched.has(p.id)) { watched.add(p.id); watch(p); }
        }
        if (posts.some((p) => p.status === 'published')) { Object.assign(clip, await api(`/api/clips/${clip.id}`)); renderBadges(); }
        if (posts.some((p) => p.status === 'publishing' || (p.status === 'scheduled' && p.scheduledAt <= Date.now() + 60000)) && back.isConnected) {
          pollTimer = setTimeout(refresh, 2000);
        }
      };
      const create = async (scheduledAt) => {
        try {
          await save();
          await api('/api/posts', { method: 'POST', body: { clipId: clip.id, platform, scheduledAt } });
          if (!scheduledAt) autoWatch = (await api('/api/me')).settings.publishView === 'foreground';
          toast(scheduledAt ? `Scheduled for ${new Date(scheduledAt).toLocaleString()}` : `Posting to ${label}. You'll be notified when it's done.`, 'ok');
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
