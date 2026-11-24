// "Find streamers" on the Streamers tab: search Twitch channels by name, or browse a category
// (game) to see who is live in it right now, and add any of them with one click.
import { esc, toast } from './api.js';
import { icon } from './icons.js';
import { skeleton, showLoading } from './loader.js';
import { searchChannels, topCategories, searchCategories, categoryStreams } from './engine/twitch.js';

const LANGUAGES = [['', 'Any language'], ['en', 'English'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['th', 'Thai'], ['ru', 'Russian'], ['tr', 'Turkish'], ['ar', 'Arabic']];
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const num = (n) => compact.format(n || 0);

export function mountStreamerSearch(root, { isAdded, onAdd }) {
  const state = { mode: 'name', q: { name: '', category: '' }, category: null, language: '', seq: 0, results: [] };
  root.innerHTML = `
    <div class="section-head">
      <div><h2 style="margin:0">Find streamers</h2>
        <div class="muted small">Search Twitch by channel name, or pick a category to see who's live in it right now. Add anyone with one click.</div></div>
      <span class="spacer"></span>
      <div class="seg find-mode"><button data-m="name">${icon('search')}By name</button><button data-m="category">${icon('grid')}By category</button></div>
    </div>
    <div class="row find-controls">
      <input type="search" class="find-q" autocomplete="off" spellcheck="false">
      <select class="find-lang hidden" title="Only channels streaming in this language">${LANGUAGES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    </div>
    <div class="find-crumb hidden"></div>
    <div class="find-results"></div>`;
  const $ = (s) => root.querySelector(s);
  const input = $('.find-q');
  const results = $('.find-results');

  const channelRow = (c) => {
    const added = isAdded(c.login);
    return `<div class="find-item" data-login="${esc(c.login)}">
      <img class="avatar" src="${esc(c.avatar || '')}" alt="" loading="lazy" decoding="async">
      <div style="min-width:0;flex:1">
        <div class="row" style="gap:6px;flex-wrap:nowrap;min-width:0"><b class="ellipsis">${esc(c.displayName || c.login)}</b>
          ${c.live ? `<span class="badge watching"><span class="live-dot"></span>Live${c.viewers ? ` · ${num(c.viewers)}` : ''}</span>` : ''}</div>
        <div class="small muted ellipsis" title="${esc(c.title || '')}">${[c.followers != null ? `${num(c.followers)} followers` : '', c.live && c.game && state.mode === 'name' ? esc(c.game) : '', c.live && c.title ? esc(c.title) : (c.live ? '' : 'Offline')].filter(Boolean).join(' · ')}</div>
      </div>
      <a class="btn sm ghost" href="https://www.twitch.tv/${esc(c.login)}" target="_blank" rel="noopener" title="Open on Twitch">${icon('external')}</a>
      <button class="btn sm ${added ? '' : 'primary'} find-add" ${added ? 'disabled' : ''}>${added ? `${icon('check')}Added` : `${icon('plus')}Add`}</button>
    </div>`;
  };

  const categoryTile = (g) => `<button class="find-cat" data-name="${esc(g.name)}" title="${esc(g.displayName)}">
      <img src="${esc(g.boxArt || '')}" alt="" loading="lazy" decoding="async">
      <span class="find-cat-name">${esc(g.displayName)}</span>
      <span class="small muted">${g.viewers ? `${num(g.viewers)} watching` : 'No one live'}</span></button>`;

  function bindChannels() {
    results.querySelectorAll('.find-item').forEach((row) => {
      const c = state.results.find((x) => x.login === row.dataset.login);
      row.querySelector('.find-add').onclick = async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        b.innerHTML = `${icon('loader', 'spin')}Adding`;
        try { await onAdd(c); } catch (err) { toast(err.message, 'error'); }
        sync();
      };
    });
  }

  async function run() {
    const seq = ++state.seq;
    const q = state.q[state.mode].trim();
    $('.find-lang').classList.toggle('hidden', !(state.mode === 'category' && state.category));
    renderCrumb();
    let idle = () => {};
    try {
      if (state.mode === 'name') {
        if (q.length < 2) { results.innerHTML = '<div class="empty">Type at least 2 letters of a channel name.</div>'; return; }
        idle = showLoading(results, `<div class="find-list">${skeleton.streamers(4)}</div>`);
        const found = await searchChannels(q, 15);
        if (seq !== state.seq) return;
        // Live channels first, then by followers (Twitch already orders by relevance within each).
        state.results = found.sort((a, b) => Number(b.live) - Number(a.live));
        results.innerHTML = found.length ? `<div class="find-list">${found.map(channelRow).join('')}</div>` : `<div class="empty">No Twitch channels match "${esc(q)}".</div>`;
        bindChannels();
      } else if (!state.category) {
        idle = showLoading(results, `<div class="find-cats">${Array.from({ length: 12 }, () => '<div class="find-cat sk-card"><div class="sk find-cat-art"></div><div class="sk sk-line sm" style="width:80%"></div></div>').join('')}</div>`);
        const cats = q ? await searchCategories(q) : await topCategories();
        if (seq !== state.seq) return;
        results.innerHTML = cats.length
          ? `${q ? '' : '<div class="small muted" style="margin-bottom:8px">Most watched right now</div>'}<div class="find-cats">${cats.map(categoryTile).join('')}</div>`
          : `<div class="empty">No categories match "${esc(q)}".</div>`;
        results.querySelectorAll('.find-cat').forEach((t) => { t.onclick = () => openCategory(t.dataset.name); });
      } else {
        idle = showLoading(results, `<div class="find-list">${skeleton.streamers(5)}</div>`);
        const { category, channels } = await categoryStreams(state.category.name, { language: state.language });
        if (seq !== state.seq) return;
        if (category) state.category = { ...state.category, ...category };
        renderCrumb();
        // In a category the search box narrows the live channels by name.
        const shown = q ? channels.filter((c) => `${c.login} ${c.displayName}`.toLowerCase().includes(q.toLowerCase())) : channels;
        state.results = shown;
        results.innerHTML = shown.length ? `<div class="find-list">${shown.map(channelRow).join('')}</div>`
          : `<div class="empty">${q ? `No live channel in ${esc(state.category.displayName)} matches "${esc(q)}".` : `No one is live in ${esc(state.category.displayName)}${state.language ? ' in that language' : ''} right now.`}</div>`;
        bindChannels();
      }
    } catch (e) {
      if (seq === state.seq) results.innerHTML = `<div class="empty">Couldn't reach Twitch: ${esc(e.message)}</div>`;
    } finally { idle(); }
  }

  function renderCrumb() {
    const crumb = $('.find-crumb');
    const show = state.mode === 'category' && state.category;
    crumb.classList.toggle('hidden', !show);
    if (!show) return;
    const c = state.category;
    crumb.innerHTML = `<button class="btn sm ghost back">${icon('chevron-left')}All categories</button>
      <b>${esc(c.displayName || c.name)}</b>${c.viewers ? `<span class="small muted">${num(c.viewers)} watching · most viewers first</span>` : ''}`;
    crumb.querySelector('.back').onclick = () => { state.category = null; state.q.category = ''; setPlaceholder(); run(); input.focus(); };
  }

  function openCategory(name) {
    state.category = { name, displayName: name };
    state.q.category = '';
    setPlaceholder();
    run();
  }

  function setPlaceholder() {
    input.value = state.q[state.mode];
    input.placeholder = state.mode === 'name' ? 'Channel name, e.g. shroud'
      : state.category ? `Filter live channels in ${state.category.displayName || state.category.name}` : 'Search categories, e.g. Valorant, Just Chatting';
  }

  function setMode(m) {
    state.mode = m;
    root.querySelectorAll('.find-mode button').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
    setPlaceholder();
    run();
  }

  let timer = null;
  input.oninput = () => {
    state.q[state.mode] = input.value;
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); } };
  $('.find-lang').onchange = (e) => { state.language = e.target.value; run(); };
  root.querySelectorAll('.find-mode button').forEach((b) => { b.onclick = () => setMode(b.dataset.m); });

  /** Refresh the Add / Added buttons after the streamer list changed. */
  function sync() {
    results.querySelectorAll('.find-item').forEach((row) => {
      const added = isAdded(row.dataset.login);
      const b = row.querySelector('.find-add');
      b.disabled = added;
      b.classList.toggle('primary', !added);
      b.innerHTML = added ? `${icon('check')}Added` : `${icon('plus')}Add`;
    });
  }

  setMode('name');
  return { sync };
}
