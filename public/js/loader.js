// Placeholders shown while a view's data is still loading from the server, plus lazy image loading.

const line = (w, extra = '') => `<div class="sk sk-line${extra}" style="width:${w}"></div>`;
const lines = (...w) => `<div class="sk-lines">${w.map((x) => line(x)).join('')}</div>`;
const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('');

export const skeleton = {
  clips: (n = 8) => repeat(n, (i) => `<div class="clip-card sk-card"><div class="thumb sk"></div>
    <div class="info">${line(`${80 - (i % 3) * 12}%`)}${line('50%', ' sm')}</div></div>`),
  streamers: (n = 3) => repeat(n, (i) => `<div class="streamer-item sk-card"><div class="sk avatar"></div>${lines(`${40 - (i % 2) * 10}%`, '25%')}</div>`),
  accounts: (n = 3) => `<div class="section-head">${lines('180px', '70%')}</div>
    <div class="accounts">${repeat(n, () => `<div class="account sk-card"><div class="sk plat-logo"></div>${lines('55%', '35%')}</div>`)}</div>`,
  apRows: (n = 3) => repeat(n, () => `<div class="ap-row sk-card"><div class="sk plat-logo"></div>${lines('140px', '90px')}<span class="spacer"></span>${line('180px')}</div>`),
  calendar: (days = 7) => repeat(days, () => `<div class="cal-day sk-card">${line('40%', ' sm')}${days > 7 ? '' : `<div class="sk sk-block"></div>${line('70%', ' sm')}`}</div>`),
  tableRows: (n = 4, cols = 6) => repeat(n, () => `<tr class="sk-card"><td colspan="${cols}"><div class="row"><div class="sk avatar"></div>${lines('30%', '20%')}</div></td></tr>`),
  monitors: (n = 2) => repeat(n, () => `<div class="monitor sk-card"><div class="head"><div class="sk avatar"></div>${lines('45%', '30%')}</div>
    <div class="body"><div class="sk sk-block"></div>${line('100%')}${line('60%')}</div></div>`),
  posts: (n = 1) => repeat(n, () => `<div class="item sk-card">${line('60%')}</div>`),
};

/** Show `html` in `el` as a loading state; returns a function that clears the busy flag. */
export function showLoading(el, html) {
  el.innerHTML = html;
  el.setAttribute('aria-busy', 'true');
  return () => el.removeAttribute('aria-busy');
}

// Background images (`data-bg`) and <img data-src> are fetched only when they scroll into view.
let observer = null;
function reveal(el) {
  const url = el.dataset.bg ?? el.dataset.src;
  const done = () => el.classList.add('loaded');
  if (!url) return done();
  if (el.tagName === 'IMG') { el.onload = el.onerror = done; el.src = url; return; }
  const img = new Image();
  img.onload = () => { el.style.backgroundImage = `url("${url}")`; done(); };
  img.onerror = done;
  img.src = url;
}

export function lazyImages(root) {
  const els = root.querySelectorAll('.lazy-bg:not(.loaded):not([data-lazy])');
  if (!('IntersectionObserver' in window)) { els.forEach(reveal); return; }
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); reveal(e.target); }
  }, { rootMargin: '300px' });
  els.forEach((el) => { el.dataset.lazy = ''; observer.observe(el); });
}
