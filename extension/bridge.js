// SlientClip Publisher — runs on the paired SlientClip site only, so that page can ask this Chrome for its YouTube
// login (to copy it into the server browser). Every request needs the user's OK in a dialog the page can't fake
// or answer, so no page script can take the login silently.
(() => {
  if (window.__slientclipBridge) return;
  window.__slientclipBridge = true;
  const VERSION = chrome.runtime.getManifest().version;
  const reply = (id, body) => window.postMessage({ slientclip: 'reply', id, version: VERSION, ...body }, location.origin);

  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (e.source !== window || e.origin !== location.origin || m?.slientclip !== 'request') return;
    if (m.type === 'ping') return reply(m.id, { ok: true });
    if (m.type !== 'youtube-cookies') return reply(m.id, { ok: false, error: 'Unknown request' });
    if (!confirm('SlientClip wants to copy your YouTube login (YouTube and Google cookies) from this Chrome, to sign in its server browser.\n\nOnly allow this on your own SlientClip site. Allow?')) {
      return reply(m.id, { ok: false, error: 'You declined in the SlientClip extension dialog', declined: true });
    }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'exportCookies' });
      reply(m.id, r?.error ? { ok: false, error: r.error } : { ok: true, ...r });
    } catch (err) {
      reply(m.id, { ok: false, error: `The extension didn't answer (${err.message}). Reload the extension and this page.` });
    }
  });
  window.postMessage({ slientclip: 'ready', version: VERSION }, location.origin);
})();
