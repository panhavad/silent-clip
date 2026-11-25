// Guided tour of the app: dims the page, spotlights one part at a time (switching tabs as it goes) and
// explains it in a card with Back / Next / Skip. Opens once for new accounts; the "?" button replays it.
import { icon } from './icons.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(sel, ms = 2500) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(80)) {
    const el = document.querySelector(sel);
    if (el && el.getClientRects().length) return el;
  }
  return null;
}

/**
 * steps: [{ title, text, target?: selector, tab?: tab name, placement?: 'bottom'|'top'|'auto' }]
 * opts:  { showTab(name), onDone(completed: boolean) }
 */
export function startTour(steps, { showTab, onDone } = {}) {
  document.querySelector('.tour-root')?.remove();
  const root = document.createElement('div');
  root.className = 'tour-root';
  root.innerHTML = `
    <div class="tour-shade"></div>
    <div class="tour-spot hidden"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" tabindex="-1">
      <div class="tour-top"><span class="tour-count"></span><button class="tour-x" title="Close the tour" aria-label="Close the tour">${icon('x')}</button></div>
      <h3 id="tour-title" class="tour-title"></h3>
      <div class="tour-text"></div>
      <div class="tour-dots" aria-hidden="true">${steps.map(() => '<i></i>').join('')}</div>
      <div class="tour-actions">
        <button class="btn sm ghost tour-skip">Skip tour</button><span class="spacer"></span>
        <button class="btn sm tour-back">${icon('chevron-left')}Back</button>
        <button class="btn sm primary tour-next">Next${icon('chevron-right')}</button>
      </div>
    </div>`;
  document.body.append(root);
  document.body.classList.add('touring');
  const $ = (s) => root.querySelector(s);
  const card = $('.tour-card');
  const spot = $('.tour-spot');
  let i = 0;
  let target = null;
  let seq = 0;

  function place() {
    const pad = 8;
    const vw = innerWidth;
    const vh = innerHeight;
    const cw = Math.min(380, vw - 24);
    card.style.width = `${cw}px`;
    if (!target) {
      spot.classList.add('hidden');
      $('.tour-shade').classList.remove('clear');
      card.style.left = `${(vw - cw) / 2}px`;
      card.style.top = `${Math.max(16, (vh - card.offsetHeight) / 2)}px`;
      card.dataset.arrow = '';
      return;
    }
    const r = target.getBoundingClientRect();
    // The spotlight's own shadow dims everything around it.
    $('.tour-shade').classList.add('clear');
    spot.classList.remove('hidden');
    const top = Math.max(4, r.top - pad);
    const bottom = Math.min(vh - 4, r.bottom + pad);
    Object.assign(spot.style, { left: `${Math.max(4, r.left - pad)}px`, top: `${top}px`, width: `${Math.min(vw - 8, r.width + pad * 2)}px`, height: `${Math.max(0, bottom - top)}px` });
    const ch = card.offsetHeight;
    const below = vh - bottom - 14;
    const above = top - 14;
    const want = steps[i].placement || 'auto';
    let y;
    if ((want === 'bottom' || want === 'auto') && below >= ch) { y = bottom + 14; card.dataset.arrow = 'up'; }
    else if (above >= ch) { y = top - 14 - ch; card.dataset.arrow = 'down'; }
    else if (below >= ch) { y = bottom + 14; card.dataset.arrow = 'up'; }
    else { y = Math.max(12, vh - ch - 12); card.dataset.arrow = ''; }
    const x = Math.min(vw - cw - 12, Math.max(12, r.left + r.width / 2 - cw / 2));
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.style.setProperty('--arrow-x', `${Math.min(cw - 24, Math.max(24, r.left + r.width / 2 - x))}px`);
  }

  async function show(n) {
    const my = ++seq;
    i = Math.max(0, Math.min(steps.length - 1, n));
    const s = steps[i];
    card.classList.add('moving');
    if (s.tab) showTab?.(s.tab);
    target = s.target ? await waitFor(s.target) : null;
    if (my !== seq) return;
    if (target) {
      target.scrollIntoView({ block: target.offsetHeight > innerHeight * 0.6 ? 'start' : 'center', behavior: 'instant' });
      await sleep(60);
    }
    $('.tour-count').textContent = `${i + 1} of ${steps.length}`;
    $('.tour-title').textContent = s.title;
    $('.tour-text').innerHTML = s.text;
    root.querySelectorAll('.tour-dots i').forEach((d, k) => d.classList.toggle('on', k === i));
    $('.tour-back').disabled = i === 0;
    $('.tour-next').innerHTML = i === steps.length - 1 ? `${icon('check')}Finish` : `Next${icon('chevron-right')}`;
    $('.tour-skip').classList.toggle('hidden', i === steps.length - 1);
    place();
    card.classList.remove('moving');
    card.focus({ preventScroll: true });
  }

  function end(completed) {
    seq++;
    removeEventListener('resize', onMove);
    removeEventListener('scroll', onMove, true);
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('touring');
    root.remove();
    onDone?.(completed);
  }

  const onMove = () => place();
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); end(false); }
    else if (e.key === 'ArrowRight' || (e.key === 'Enter' && document.activeElement === card)) { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (i > 0) show(i - 1); }
  };
  const next = () => (i === steps.length - 1 ? end(true) : show(i + 1));
  addEventListener('resize', onMove);
  addEventListener('scroll', onMove, true);
  document.addEventListener('keydown', onKey, true);
  $('.tour-next').onclick = next;
  $('.tour-back').onclick = () => show(i - 1);
  $('.tour-skip').onclick = () => end(false);
  $('.tour-x').onclick = () => end(false);
  show(0);
  return { end };
}

/** The app's tour. `isAdmin` adds the Admin step. */
export function appTourSteps({ isAdmin, name } = {}) {
  return [
    {
      title: `Welcome to SlientClip${name ? `, ${name.split(' ')[0]}` : ''}!`,
      text: '<p>SlientClip watches Twitch streams, catches the moment chat explodes and turns it into a captioned vertical clip, ready for YouTube Shorts, TikTok and Instagram Reels.</p><p>This quick tour shows where everything is. It takes about a minute.</p>',
    },
    {
      tab: 'streamers', target: '.streamer-finder',
      title: '1. Pick who to clip',
      text: 'Search Twitch <b>by name</b>, or open a <b>category</b> to see who\'s live right now, most viewers first. Press <b>Add</b> on anyone you want to clip.',
    },
    {
      tab: 'streamers', target: '.add-streamer',
      title: 'Or paste a link',
      text: 'Paste any channel link like <code>twitch.tv/name</code>. Your streamers are listed below, with a switch to turn auto-clip on or off for each.',
    },
    {
      tab: 'live', target: '.processing',
      title: '2. Choose where it runs',
      text: '<b>Browser</b> watches in this tab (keep it open). <b>Server</b> keeps watching and clipping even when you close the app.',
    },
    {
      tab: 'live', target: '.toggle',
      title: 'Start watching',
      text: 'Press <b>Start watching</b>. Each streamer gets a card with a live hype meter. When chat spikes, the moment is captured and rendered for you. <b>Clip now</b> grabs a moment by hand.',
    },
    {
      tab: 'clips', target: '.clips-root .section-head',
      title: '3. Your clips',
      text: 'Finished clips land here, captioned and with a title, description and hashtags. Use the <b>YouTube / TikTok / Instagram</b> buttons on a clip to post it, open it to edit, or <b>Select</b> several to delete or mark as published.',
    },
    {
      tab: 'schedule', target: '.schedule-root .panel',
      title: '4. Post on autopilot',
      text: 'Turn on <b>Auto-publish</b>, choose how many videos a day each platform gets and between which hours. Your best clips are scheduled and posted for you; the calendar below shows what goes out when.',
    },
    {
      tab: 'settings', target: '.accounts-root .accounts',
      title: '5. Connect your accounts',
      text: 'Log in to YouTube, TikTok and Instagram here once. For YouTube you choose how posts go out: the <b>server browser</b> (kept open on the server so the login stays warm) or the <b>SlientClip Publisher</b> Chrome extension (posts from the Chrome you\'re already signed in to). Clipping options are further down this page.',
    },
    ...(isAdmin ? [{
      tab: 'admin', target: '.admin-root .panel',
      title: 'Admin',
      text: 'Approve new members, set storage limits, access expiry dates and server watching per account, and see who\'s watching right now.',
    }] : []),
    {
      target: '.help-btn',
      title: 'Need this again?',
      text: 'Press <b>?</b> any time to replay this tour. You\'re all set: add a streamer and press <b>Start watching</b>.',
    },
  ];
}
