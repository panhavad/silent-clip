import { api, esc, toast, timeAgo } from './api.js';
import { uploadToYouTube, shareClip, postText, UPLOAD_PAGES } from './publish.js';
import { renderClip } from './engine/render.js';

const PLAT_LABEL = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };
const PLAT_ICON = { youtube: '▶', tiktok: '♪', instagram: '◎' };

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
        <button class="btn sm refresh">↻ Refresh</button>
      </div>
      <div class="clip-grid"></div>`;
    root.querySelectorAll('.filters button').forEach((b) => { b.onclick = () => { this.filter = b.dataset.f; this.load(); }; });
    root.querySelector('.refresh').onclick = () => this.load();
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
            ${c.downloadedAt ? '<span class="plat dl" title="Downloaded">⬇</span>' : ''}
            ${Object.keys(c.posted).map((p) => `<span class="plat ${p}" title="Posted to ${PLAT_LABEL[p]}">${PLAT_ICON[p]}</span>`).join('')}
          </div>
          <div class="score">🔥 ${c.viral.score ?? '–'}</div>
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

  open(clip) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const v = clip.viral || {};
    const ytEnabled = this.config.youtubeUpload;
    back.innerHTML = `
      <div class="modal">
        <div class="video-col"><video controls playsinline src="${clip.videoUrl}" poster="${clip.thumbUrl || ''}"></video></div>
        <div class="form-col">
          <div class="row"><h2 style="margin:0">Clip details</h2><span class="spacer"></span><span class="status-badges row"></span><button class="btn sm ghost close">✕</button></div>
          <div class="viral-box">
            <div class="row"><b style="font-size:16px">🔥 Viral score ${v.score ?? '–'}/100</b><span class="chip">${esc(v.category || '')}</span><span class="spacer"></span>
              <button class="btn sm jump">⏯ Jump to viral point (${v.offsetInClip ?? 20}s)</button></div>
            <div>${esc(v.reason || '')}</div>
            <div class="muted small">${esc(clip.streamer)} · ${v.game ? `${esc(v.game)} · ` : ''}${v.at ? new Date(v.at).toLocaleString() : ''}${v.viewers ? ` · ${v.viewers.toLocaleString()} viewers` : ''}</div>
            ${v.topWords?.length ? `<div class="chips">${v.topWords.map((w) => `<span class="chip">${esc(w.word)} ×${w.count}</span>`).join('')}</div>` : ''}
            ${v.topMessages?.length ? `<div class="muted small">💬 ${v.topMessages.map((m) => `“${esc(m.text)}” ×${m.count}`).join(' · ')}</div>` : ''}
          </div>
          <label class="field">Title<input type="text" class="f-title" maxlength="100"></label>
          <label class="field">Description<textarea class="f-desc" rows="6"></textarea></label>
          <label class="field">Hashtags<input type="text" class="f-tags"></label>
          <div class="row"><button class="btn sm save">💾 Save details</button><button class="btn sm copy">📋 Copy post text</button></div>
          <label class="field">On-video caption ${clip.hasSource ? '' : '(source not kept — cannot re-render)'}
            <div class="row"><input type="text" class="f-caption" maxlength="80"><label class="row small"><input type="checkbox" class="f-chat" checked> chat bubble</label></div></label>
          <div class="row"><button class="btn sm rerender" ${clip.hasSource ? '' : 'disabled'}>🎬 Re-render with caption</button><span class="rr-status muted small"></span></div>
          <hr style="border-color:var(--border);width:100%">
          <div class="row wrap">
            <a class="btn primary download" href="/api/clips/${clip.id}/download">⬇ Download MP4</a>
            <button class="btn yt p-youtube">▶ YouTube Shorts</button>
            <button class="btn tt p-tiktok">♪ TikTok</button>
            <button class="btn ig p-instagram">◎ Instagram Reels</button>
          </div>
          <div class="post-panel hidden panel" style="padding:12px"></div>
          <div class="row"><button class="btn sm ghost mark-new">↺ Mark as new</button><span class="spacer"></span><button class="btn sm danger delete">🗑 Delete clip</button></div>
        </div>
      </div>`;
    document.body.append(back);
    const $ = (s) => back.querySelector(s);
    const video = $('video');
    $('.f-title').value = clip.title;
    $('.f-desc').value = clip.description;
    $('.f-tags').value = clip.hashtags.join(' ');
    $('.f-caption').value = clip.caption;

    const close = () => { back.remove(); this.load(); };
    $('.close').onclick = close;
    back.onclick = (e) => { if (e.target === back) close(); };
    $('.jump').onclick = () => { video.currentTime = Math.max(0, (v.offsetInClip ?? 20) - 2); video.play(); };

    const renderBadges = () => {
      $('.status-badges').innerHTML = [
        clip.isNew ? '<span class="badge new">New</span>' : '',
        clip.downloadedAt ? '<span class="badge done">Downloaded</span>' : '',
        ...Object.entries(clip.posted).map(([p, info]) => (info.url
          ? `<a class="badge done" href="${esc(info.url)}" target="_blank" rel="noopener">Posted · ${PLAT_LABEL[p]} ↗</a>`
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
        status.textContent = 'Loading source…';
        const src = new Uint8Array(await (await fetch(`/api/clips/${clip.id}/source`)).arrayBuffer());
        const s = v.source || {};
        const caption = $('.f-caption').value.trim();
        const out = await renderClip({
          bytes: src, ext: s.ext || 'ts', offsetSec: s.offset || 0, durationSec: s.duration || clip.duration || 30,
          caption, chatLine: $('.f-chat').checked ? (v.chatLine || '') : '', login: clip.streamer,
          layout: s.layout || 'blur', resolution: s.resolution || '720x1280', captions: true, thumbAt: v.offsetInClip ?? 20,
          onProgress: (p) => { status.textContent = `Rendering ${Math.round(p * 100)}%`; },
        });
        status.textContent = 'Saving…';
        const form = new FormData();
        form.append('video', out.video, 'clip.mp4');
        if (out.thumb) form.append('thumb', out.thumb, 'thumb.jpg');
        form.append('caption', caption);
        Object.assign(clip, await api(`/api/clips/${clip.id}/video`, { method: 'PUT', form }));
        video.src = `${clip.videoUrl}?t=${Date.now()}`;
        status.textContent = 'Done ✓';
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
          <li>Send the video to your device / app: <button class="btn sm a-share">📤 Share…</button> or <a class="btn sm a-dl" href="/api/clips/${clip.id}/download">⬇ Download</a></li>
          <li>Copy the caption: <button class="btn sm a-copy">📋 Copy title + hashtags</button></li>
          <li>Open the uploader: <a class="btn sm" target="_blank" rel="noopener" href="${UPLOAD_PAGES[platform]}">Open ${PLAT_LABEL[platform]} ↗</a></li>
          <li>Paste the post link (optional) and mark it: <div class="row" style="margin-top:6px"><input type="url" class="a-url" placeholder="https://..."><button class="btn sm primary a-mark">✓ Mark posted</button></div></li>
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

    $('.p-tiktok').onclick = () => assisted('tiktok');
    $('.p-instagram').onclick = () => assisted('instagram');
    $('.p-youtube').onclick = () => {
      if (!ytEnabled) return assisted('youtube');
      panel.classList.remove('hidden');
      panel.innerHTML = `
        <h3>Upload to YouTube Shorts</h3>
        <div class="row" style="margin-top:8px"><select class="y-privacy" style="width:auto">
          <option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select>
          <button class="btn yt y-go">▶ Upload now</button><span class="y-status muted small"></span></div>
        <div class="muted small" style="margin-top:6px">Uploads straight from your browser with your Google account. <a href="#" class="y-manual">Post manually instead</a></div>`;
      panel.querySelector('.y-manual').onclick = (e) => { e.preventDefault(); assisted('youtube'); };
      panel.querySelector('.y-go').onclick = async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const st = panel.querySelector('.y-status');
        try {
          await save();
          st.textContent = 'Authorizing…';
          const res = await uploadToYouTube(clip, {
            clientId: this.config.googleClientId, privacy: panel.querySelector('.y-privacy').value,
            onProgress: (p) => { st.textContent = `Uploading ${Math.round(p * 100)}%`; },
          });
          await this.mark(clip, { action: 'posted', platform: 'youtube', url: res.url });
          renderBadges();
          st.innerHTML = `Done — <a href="${res.url}" target="_blank" rel="noopener">view on YouTube ↗</a>`;
        } catch (err) {
          st.textContent = '';
          toast(err.message, 'error');
        } finally { btn.disabled = false; }
      };
    };
    $('.mark-new').onclick = async () => { await this.mark(clip, { action: 'new' }); renderBadges(); toast('Marked as new', 'ok'); };
    $('.delete').onclick = async () => {
      if (!confirm('Delete this clip permanently?')) return;
      await api(`/api/clips/${clip.id}`, { method: 'DELETE' });
      close();
    };
  }
}
