// Live view of a server-side browser: shows its screen and forwards clicks, scrolling and typing.
// Used to log in to YouTube / TikTok / Instagram and to watch a post being made.
import { api, esc, toast } from './api.js';
import { icon } from './icons.js';

const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * @param {object} o
 * @param {string} o.sessionId
 * @param {string} o.title
 * @param {'login'|'watch'} o.mode   login shows "I'm logged in"; watch is for a post in progress
 * @param {string} [o.platform]
 * @param {(result) => void} [o.onDone]
 */
export function openBrowserViewer({ sessionId, title, mode = 'watch', platform, onDone }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="panel bview">
      <div class="row bview-head">
        <b class="bview-title">${esc(title)}</b>
        <span class="badge watching bview-step"></span>
        <span class="spacer"></span>
        <button class="btn sm ghost b-back" title="Back">${icon('chevron-left')}</button>
        <button class="btn sm ghost b-reload" title="Reload">${icon('refresh')}</button>
        ${mode === 'login' ? `<button class="btn sm primary b-done">${icon('check')}I'm logged in</button>` : ''}
        <button class="btn sm ghost b-close" title="Close">${icon('x')}</button>
      </div>
      <div class="small muted bview-url"></div>
      <div class="bview-screen" tabindex="0">
        <img alt="Live view of the browser on the server" draggable="false">
        <div class="bview-wait muted">${icon('loader', 'spin')} Starting the browser…</div>
      </div>
      <div class="row bview-type">
        <input type="text" class="b-text" placeholder="Type here and press Send (or click the screen and type)" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button class="btn sm b-send">Send</button>
        <button class="btn sm b-enter" title="Press Enter">Enter</button>
        <button class="btn sm b-bksp" title="Backspace">⌫</button>
      </div>
      <div class="small muted bview-help">${mode === 'login'
        ? 'This is a real browser running on the server. Log in as you normally would (including 2-step verification), then press <b>I\'m logged in</b>. The session is saved for future posts.'
        : 'Watching the server browser post your clip. You can close this; posting continues in the background and you will be notified of the result.'}</div>
    </div>`;
  document.body.appendChild(back);
  const $ = (s) => back.querySelector(s);
  const img = $('img');
  const screen = $('.bview-screen');
  let seq = -1;
  let open = true;
  let url = null;

  const send = (ev) => api(`/api/browser/${sessionId}/input`, { method: 'POST', body: ev }).catch((e) => toast(e.message, 'error'));
  const close = async (stopBrowser) => {
    if (!open) return;
    open = false;
    back.remove();
    if (url) URL.revokeObjectURL(url);
    if (stopBrowser && mode === 'login') await api(`/api/browser/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  };

  const ended = (msg) => {
    $('.bview-wait').innerHTML = esc(msg);
    $('.bview-wait').classList.remove('hidden');
    img.classList.add('dim');
  };

  (async function frames() {
    while (open) {
      try {
        const res = await fetch(`/api/browser/${sessionId}/frame?seq=${seq}`, { cache: 'no-store' });
        if (res.status === 404) { ended(mode === 'watch' ? 'Finished. The browser has closed.' : 'The browser has closed.'); break; }
        seq = Number(res.headers.get('X-Frame-Seq')) || seq;
        if (res.status === 200) {
          const next = URL.createObjectURL(await res.blob());
          img.src = next;
          if (url) URL.revokeObjectURL(url);
          url = next;
          $('.bview-wait').classList.add('hidden');
        }
      } catch { await new Promise((r) => setTimeout(r, 1000)); }
      await new Promise((r) => setTimeout(r, 120));
    }
  })();

  (async function status() {
    while (open) {
      const s = await api(`/api/browser/${sessionId}`).catch(() => null);
      if (!s) break;
      $('.bview-url').textContent = s.url || '';
      $('.bview-step').textContent = s.step || '';
      $('.bview-step').classList.toggle('hidden', !s.step || mode === 'login');
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  const pos = (e) => {
    const r = img.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  img.addEventListener('click', (e) => { screen.focus(); send({ type: 'click', ...pos(e) }); });
  img.addEventListener('dblclick', (e) => send({ type: 'click', double: true, ...pos(e) }));
  let wheel = 0; let wheelTimer = null;
  screen.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheel += e.deltaY;
    const p = pos(e);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { send({ type: 'scroll', dy: wheel, ...p }); wheel = 0; }, 80);
  }, { passive: false });

  // Keyboard: printable characters are batched into "type", special keys are pressed.
  let buf = ''; let bufTimer = null;
  const flush = () => { if (buf) { send({ type: 'type', text: buf }); buf = ''; } };
  screen.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'v') return; // handled by paste
    if (mod && /^[acxz]$/i.test(e.key)) { e.preventDefault(); flush(); send({ type: 'key', key: `Control+${e.key.toUpperCase()}` }); return; }
    if (KEYS.has(e.key)) { e.preventDefault(); flush(); send({ type: 'key', key: e.shiftKey && e.key === 'Tab' ? 'Shift+Tab' : e.key }); return; }
    if (e.key.length === 1 && !mod) {
      e.preventDefault();
      buf += e.key;
      clearTimeout(bufTimer);
      bufTimer = setTimeout(flush, 60);
    }
  });
  screen.addEventListener('paste', (e) => { e.preventDefault(); flush(); send({ type: 'type', text: e.clipboardData.getData('text') }); });

  const sendText = () => { const t = $('.b-text').value; if (t) { send({ type: 'type', text: t }); $('.b-text').value = ''; } };
  $('.b-send').onclick = sendText;
  $('.b-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });
  $('.b-enter').onclick = () => send({ type: 'key', key: 'Enter' });
  $('.b-bksp').onclick = () => send({ type: 'key', key: 'Backspace' });
  $('.b-back').onclick = () => send({ type: 'back' });
  $('.b-reload').onclick = () => send({ type: 'reload' });
  $('.b-close').onclick = () => close(true);
  back.addEventListener('click', (e) => { if (e.target === back) close(true); });

  if (mode === 'login') {
    $('.b-done').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api(`/api/accounts/${platform}/login/finish`, { method: 'POST', body: { sessionId } });
        if (!r.loggedIn) { toast('Not logged in yet. Finish signing in on the screen first.', 'error'); return; }
        toast(`Logged in${r.username ? ` as @${r.username}` : ''}. The session is saved for future posts.`, 'ok');
        await close(false);
        onDone?.(r);
      } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
    };
  }
  screen.focus();
  return { close };
}
