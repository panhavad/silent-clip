import { esc } from './api.js';

const STATUS_LABEL = {
  starting: 'Starting', checking: 'Checking', offline: 'Offline', live: 'Live', connecting: 'Connecting',
  watching: 'Watching live', error: 'Error', elsewhere: 'In other window',
};
const STAGE_LABEL = { capturing: '⏺ Capturing', rendering: '🎬 Rendering 9:16', uploading: '⬆ Saving', done: '✅ Saved', failed: '⚠ Failed' };

function drawSpark(canvas, rates = [], heat = 0) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 48;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!rates.length) return;
  const max = Math.max(4, ...rates);
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#4f8cff');
  grad.addColorStop(1, heat >= 1 ? '#ff4d8d' : '#9146ff');
  ctx.beginPath();
  rates.forEach((r, i) => {
    const x = (i / (rates.length - 1)) * w, y = h - (r / max) * (h - 4) - 2;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = 'rgba(145,70,255,0.15)';
  ctx.fill();
}

export function mountMonitors(container, manager, { showPlayers = false, onPopout } = {}) {
  const cards = new Map();

  function card(login) {
    let el = cards.get(login);
    if (el) return el;
    el = document.createElement('div');
    el.className = 'monitor';
    el.innerHTML = `
      <div class="head">
        <img class="avatar" alt="">
        <div style="min-width:0"><div class="name"></div><div class="sub"></div></div>
        <span class="spacer"></span><span class="badge"></span>
      </div>
      ${showPlayers ? '<div class="player"></div>' : ''}
      <div class="body">
        <div class="row small muted"><span>Hype meter</span><span class="spacer"></span><span class="heat-label"></span></div>
        <div class="meter"><div></div></div>
        <canvas class="spark"></canvas>
        <div class="stats">
          <div>Chat/s<b class="s-rate">–</b></div><div>Normal<b class="s-base">–</b></div>
          <div>Spike<b class="s-ratio">–</b></div><div>Buffer<b class="s-buf">–</b></div>
        </div>
        <div class="row">
          <button class="btn sm primary clip-now">✂ Clip now</button>
          ${onPopout ? '<button class="btn sm popout">⧉ Watch in window</button>' : ''}
          <span class="spacer"></span>
          <a class="btn sm ghost twitch-link" target="_blank" rel="noopener">Twitch ↗</a>
        </div>
        <div class="jobs"></div>
        <div class="log"></div>
      </div>`;
    el.querySelector('.clip-now').onclick = () => manager.clipNow(login);
    el.querySelector('.popout')?.addEventListener('click', () => onPopout(login));
    el.querySelector('.twitch-link').href = `https://www.twitch.tv/${login}`;
    cards.set(login, el);
    container.append(el);
    return el;
  }

  function renderJobs(el, st) {
    const jobs = [...st.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 4);
    el.querySelector('.jobs').innerHTML = jobs.map((j) => `
      <div class="job"><div class="row"><span>${STAGE_LABEL[j.stage] || j.stage}</span><span class="spacer"></span>
        <span class="muted">${j.moment?.manual ? 'manual' : `score ${j.moment?.score ?? ''}`}</span></div>
        ${j.stage === 'rendering' ? `<div class="bar"><div style="width:${Math.round((j.progress || 0) * 100)}%"></div></div>` : ''}
        ${j.title ? `<div class="muted">${esc(j.title)}</div>` : ''}${j.error ? `<div style="color:var(--bad)">${esc(j.error)}</div>` : ''}
      </div>`).join('');
  }

  function update(login) {
    const st = manager.state.get(login);
    if (!st) { cards.get(login)?.remove(); cards.delete(login); return; }
    const el = card(login);
    const live = st.channel?.live;
    el.classList.toggle('live', Boolean(live));
    el.querySelector('.avatar').src = st.avatar || st.channel?.avatar || '';
    el.querySelector('.name').textContent = st.displayName || login;
    el.querySelector('.sub').textContent = live
      ? `${st.channel.game || 'Live'} · ${st.channel.viewers.toLocaleString()} viewers`
      : (st.channel ? 'Waiting for stream to go live…' : '');
    el.querySelector('.sub').title = st.channel?.title || '';
    const b = el.querySelector('.badge');
    b.className = `badge ${st.status === 'watching' ? 'watching' : st.status}`;
    b.textContent = STATUS_LABEL[st.status] || st.status;
    el.querySelector('.clip-now').disabled = st.status !== 'watching';
    const player = el.querySelector('.player');
    if (player) {
      const want = live ? login : '';
      if (player.dataset.channel !== want) {
        player.dataset.channel = want;
        player.innerHTML = want
          ? `<iframe allow="autoplay; fullscreen" src="https://player.twitch.tv/?channel=${encodeURIComponent(login)}&parent=${location.hostname}&muted=true&autoplay=true"></iframe>`
          : '<div class="muted small" style="display:grid;place-items:center;height:100%">Offline — will start automatically when live</div>';
      }
    }
    renderJobs(el, st);
    el.querySelector('.log').innerHTML = st.log.slice(0, 12)
      .map((l) => `<div>${new Date(l.t).toLocaleTimeString()} · ${esc(l.message)}</div>`).join('');
  }

  manager.addEventListener('update', (e) => {
    if (e.detail.login) update(e.detail.login);
    else {
      for (const login of [...cards.keys()]) if (!manager.state.has(login)) update(login);
      for (const login of manager.state.keys()) update(login);
    }
  });
  manager.addEventListener('stats', ({ detail: { login, stats } }) => {
    const el = cards.get(login);
    if (!el) return;
    el.querySelector('.meter > div').style.width = `${Math.min(100, stats.heat * 100)}%`;
    el.querySelector('.heat-label').textContent = stats.warm ? `${Math.round(stats.heat * 100)}% of trigger` : 'learning chat baseline…';
    el.querySelector('.s-rate').textContent = stats.rate.toFixed(1);
    el.querySelector('.s-base').textContent = stats.baseline.toFixed(1);
    el.querySelector('.s-ratio').textContent = `${stats.ratio.toFixed(1)}×`;
    el.querySelector('.s-buf').textContent = `${stats.buffered}s`;
    drawSpark(el.querySelector('.spark'), stats.rates, stats.heat);
  });
  manager.addEventListener('job', ({ detail: { login } }) => {
    const st = manager.state.get(login);
    const el = cards.get(login);
    if (st && el) renderJobs(el, st);
  });
  for (const login of manager.state.keys()) update(login);
}
