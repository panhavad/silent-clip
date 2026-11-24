// SlientClip Publisher — runs inside a YouTube Studio tab and uploads one clip the way a person would:
// pick the file, type the title and description, choose the audience and visibility, wait for the upload
// and press Publish. Every step is reported back to SlientClip through the background worker.
(() => {
  if (window.__slientclipUploader) return;
  window.__slientclipUploader = true;

  const VISIBILITY = { public: 'PUBLIC', unlisted: 'UNLISTED', private: 'PRIVATE' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pause = (a = 500, b = 1200) => sleep(a + Math.random() * (b - a));
  const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

  /** querySelector that also looks inside open shadow roots. */
  function find(sel, root = document) {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const inner = find(sel, el.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  }
  const findAny = (sels) => { for (const s of sels) { const el = find(s); if (el) return el; } return null; };
  const visible = (el) => Boolean(el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');

  async function waitFor(fn, { timeout = 60000, every = 500, what = 'YouTube Studio' } = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw fail(`Timed out waiting for ${what}`);
      await sleep(every);
    }
  }

  async function click(el) {
    el.scrollIntoView({ block: 'center' });
    await pause(250, 600);
    el.click();
  }

  /** Replace a contenteditable box's text like typing/pasting would (so YouTube's own handlers see it). */
  async function setText(el, text) {
    el.focus();
    await pause(150, 300);
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
    await pause(200, 400);
    if (el.innerText.trim() !== text.trim()) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  let jobId = null;
  const step = (text, final = false) => chrome.runtime.sendMessage({ type: 'step', jobId, step: text, final }).catch(() => {});

  async function loadVideo(job) {
    const parts = [];
    let total = 1;
    for (let i = 0; i < total; i++) {
      const r = await chrome.runtime.sendMessage({ type: 'chunk', jobId: job.id, index: i });
      if (!r || r.error) throw fail(`Could not get the clip from SlientClip: ${r?.error || 'no answer'}`);
      total = r.total;
      const bin = atob(r.data);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      parts.push(bytes);
    }
    const name = `${(job.clip.title || 'clip').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'clip'}.mp4`;
    return new File(parts, name, { type: 'video/mp4' });
  }

  const FILE_INPUT = ['ytcp-uploads-dialog input[type=file]', 'input[type=file][name=Filedata]', 'input[type=file]'];
  const signedOut = () => /accounts\.google\.com/.test(location.href);

  async function openUploadDialog() {
    const ready = () => findAny(FILE_INPUT);
    const noChannel = () => [...document.querySelectorAll('ytcp-button, button, a, h1, h2')].some((e) => /create (a|your) channel/i.test(e.textContent || '') && visible(e));
    let got = await waitFor(() => ready() || (noChannel() && 'noChannel') || (signedOut() && 'signedOut'), { timeout: 20000, what: 'the upload dialog' }).catch(() => null);
    if (!got) {
      // /upload didn't open the dialog by itself: use Create → Upload videos.
      const create = findAny(['ytcp-button#create-icon', '#create-icon', 'ytcp-button[id="create-icon"]']);
      if (create) {
        await click(create);
        const item = await waitFor(() => findAny(['tp-yt-paper-item#text-item-0', '#text-item-0']), { timeout: 10000, what: 'the Create menu' }).catch(() => null);
        if (item) await click(item);
      }
      got = await waitFor(() => ready() || (noChannel() && 'noChannel') || (signedOut() && 'signedOut'), { timeout: 40000, what: 'the YouTube upload dialog' });
    }
    if (got === 'signedOut') throw fail('YouTube is signed out in this Chrome', { loggedOut: true, final: true });
    if (got === 'noChannel') throw fail('This Google account has no YouTube channel yet. Create one on YouTube first.', { final: true });
    return got;
  }

  async function run(job) {
    jobId = job.id;
    let pressedPost = false;
    try {
      step('Opening the upload dialog');
      let input = await openUploadDialog();
      step('Preparing the clip');
      const file = await loadVideo(job);
      await pause(600, 1400);

      step('Uploading video');
      const dt = new DataTransfer();
      dt.items.add(file);
      input = findAny(FILE_INPUT) || input;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const titleBox = () => { const el = find('#title-textarea #textbox'); return visible(el) && el; };
      let title = await waitFor(titleBox, { timeout: 25000, what: 'the video details' }).catch(() => null);
      if (!title) {
        // Fallback: drop the file on the dialog like a drag-and-drop.
        const zone = findAny(['ytcp-uploads-file-picker', '#content', 'ytcp-uploads-dialog']);
        zone?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        title = await waitFor(titleBox, { timeout: 120000, what: 'the video details after uploading' });
      }
      await pause(1200, 2500);

      step('Writing title and description');
      const titleText = (job.clip.title || 'Twitch moment').replace(/[<>]/g, '').slice(0, 100);
      let description = (job.clip.description || '').replace(/[<>]/g, '');
      const tags = (job.clip.hashtags || []).filter((t) => !description.includes(t));
      if (tags.length) description += `${description ? '\n\n' : ''}${tags.join(' ')}`;
      if (!/#shorts/i.test(description)) description += `${description ? '\n' : ''}#Shorts`;
      await setText(title, titleText);
      await pause();
      const desc = find('#description-textarea #textbox');
      if (desc) await setText(desc, description.slice(0, 4900));
      await pause();

      step('Setting audience');
      const notKids = await waitFor(() => find('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'), { timeout: 20000, what: 'the audience question' });
      await click(notKids);
      await pause();

      for (const label of ['Video elements', 'Checks', 'Visibility']) {
        step(`Next: ${label}`);
        const next = await waitFor(() => { const b = find('#next-button'); return b && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true' && b; }, { timeout: 30000, what: 'the Next button' });
        await click(next);
        await pause(900, 1800);
      }

      const vis = VISIBILITY[job.visibility] || 'PUBLIC';
      step(`Setting visibility to ${vis.toLowerCase()}`);
      const radio = await waitFor(() => find(`tp-yt-paper-radio-button[name="${vis}"]`), { timeout: 20000, what: 'the visibility options' });
      await click(radio);
      await pause(400, 800);
      if (radio.getAttribute('aria-checked') === 'false') throw fail(`Could not set visibility to ${vis.toLowerCase()}`, { final: true });
      const link = await waitFor(() => { const a = findAny(['ytcp-video-info a', '.video-url-fadeable a']); return a?.href && a; }, { timeout: 60000, what: 'the video link' }).catch(() => null);
      const href = link?.href || null;

      step('Waiting for the upload to finish');
      let lastBeat = 0;
      await waitFor(() => {
        const label = (findAny(['ytcp-uploads-dialog ytcp-video-upload-progress .progress-label', 'ytcp-uploads-dialog .progress-label'])?.textContent || '').trim();
        if (Date.now() - lastBeat > 20000) { lastBeat = Date.now(); step(label ? `YouTube: ${label}` : 'Waiting for the upload to finish'); }
        return !/uploading/i.test(label);
      }, { timeout: 20 * 60000, every: 2000, what: 'the YouTube upload to finish' });
      // Studio keeps a hidden error placeholder in the dialog; only a visible one is a real error.
      const errEl = find('ytcp-uploads-dialog #error-message');
      const errText = visible(errEl) ? (errEl.textContent || '').trim() : '';
      if (errText) throw fail(`YouTube: ${errText}`);

      const id = href?.match(/(?:youtu\.be\/|shorts\/|v=)([\w-]{6,})/)?.[1] || null;
      if (job.dryRun) {
        step('Test mode: stopping before Publish (kept as a draft in YouTube Studio)');
        return { ok: true, dryRun: true, url: id ? `https://www.youtube.com/shorts/${id}` : href, externalId: id };
      }

      step('Publishing', true);
      pressedPost = true;
      await click(await waitFor(() => find('#done-button'), { timeout: 20000, what: 'the Publish button' }));
      const outcome = await waitFor(() => {
        if (visible(findAny(['ytcp-video-share-dialog', 'ytcp-uploads-still-processing-dialog']))) return 'shared';
        if (visible(find('ytcp-prechecks-warning-dialog'))) return 'warning';
        return null;
      }, { timeout: 180000, what: 'YouTube to confirm the video was published' });
      if (outcome === 'warning') {
        const ok = findAny(['ytcp-prechecks-warning-dialog #primary-action-button']);
        if (ok) await click(ok);
        await waitFor(() => visible(findAny(['ytcp-video-share-dialog', 'ytcp-uploads-still-processing-dialog'])), { timeout: 120000, what: 'YouTube to publish' }).catch(() => {});
      }
      return { ok: true, url: id ? `https://www.youtube.com/shorts/${id}` : 'https://studio.youtube.com/', externalId: id };
    } catch (e) {
      return { ok: false, error: e.message, final: Boolean(e.final), loggedOut: Boolean(e.loggedOut) || signedOut(), pressedPost };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'run') return false;
    reply({ started: true });
    run(msg.job).then((result) => chrome.runtime.sendMessage({ type: 'result', jobId: msg.job.id, result }));
    return false;
  });
})();
