// Generates engaging title / description / hashtags / caption for a detected moment.

const TITLES = {
  funny: [
    '{name} had chat CRYING laughing 😂',
    'Chat completely lost it at this 💀',
    "{name}'s funniest moment of the stream 🤣",
    'I can\'t believe this happened live 😂 ({name})',
  ],
  hype: [
    '{name} just did THAT 🔥',
    'INSANE {game} moment by {name} 😱🔥',
    'Chat went absolutely CRAZY for this 🔥',
    '{name} is actually built different 🐐',
  ],
  shock: [
    '{name} did NOT see this coming 😳',
    'Wait for it... 😱 ({name})',
    'Nobody expected this to happen live 😳',
    'Chat is SPEECHLESS right now 🤯',
  ],
  sad: [
    'This hurt to watch 😭 ({name})',
    'RIP {name} 💀',
    'Chat spammed F for this one 😭',
  ],
};
const HOOKS = {
  funny: ['CHAT LOST IT 😂', 'I CAN\'T 💀', 'WAIT FOR IT 🤣'],
  hype: ['NO WAY HE DID THAT 🔥', 'THIS WAS INSANE 😱', 'CHAT WENT CRAZY 🔥'],
  shock: ['DID THAT JUST HAPPEN?! 😳', 'WAIT FOR IT 😱', 'NOBODY EXPECTED THIS 🤯'],
  sad: ['THIS HURT 😭', 'PAIN. 💀', 'F IN THE CHAT 😭'],
};
const CAT_TAGS = {
  funny: ['#funny', '#funnymoments', '#lol'],
  hype: ['#insane', '#clutch', '#hype'],
  shock: ['#omg', '#unexpected', '#wtf'],
  sad: ['#rip', '#fail', '#pain'],
};

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
const tagify = (s) => {
  const t = String(s || '').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
  return t.length >= 2 && t.length <= 30 ? `#${t.toLowerCase()}` : null;
};

export function buildMetadata({ moment, channel, login }) {
  const name = channel?.displayName || login;
  const game = channel?.game || '';
  const cat = TITLES[moment.category] ? moment.category : 'hype';
  const seed = Math.floor(moment.peakTs / 1000);
  let title = pick(TITLES[cat], seed).replace('{name}', name).replace('{game}', game || 'stream');
  if (!game) title = title.replace('  ', ' ');
  title = title.slice(0, 95);

  const hashtags = [...new Set([
    '#shorts', '#twitch', tagify(login), tagify(game), ...CAT_TAGS[cat],
    ...(moment.topWords || []).slice(0, 2).map((w) => tagify(w.word)),
    game && !/just chatting/i.test(game) ? '#gaming' : '#streamer',
    '#fyp', '#viral', '#twitchclips', '#reels',
  ].filter(Boolean))].slice(0, 15);

  const quotes = (moment.topMessages || []).slice(0, 3).map((m) => `"${m.text}" ×${m.count}`);
  const when = new Date(moment.eventPdt || moment.peakTs).toLocaleString();
  const description = [
    title,
    '',
    channel?.title ? `📺 Live: "${channel.title}"` : null,
    game ? `🎮 ${game}` : null,
    `🔥 Viral score ${moment.score}/100 — ${moment.reason}`,
    quotes.length ? `💬 Chat: ${quotes.join(' · ')}` : null,
    `🕒 ${when}`,
    '',
    `Watch ${name} live 👉 https://www.twitch.tv/${login}`,
    '',
    hashtags.join(' '),
  ].filter((l) => l !== null).join('\n');

  const caption = pick(HOOKS[cat], seed);
  const chatLine = moment.topMessages?.[0]?.text || moment.topWords?.[0]?.word || '';
  const viral = {
    score: moment.score, category: cat, reason: moment.reason, manual: moment.manual,
    at: moment.eventPdt || moment.peakTs, offsetInClip: +(moment.viralOffset ?? 20).toFixed(1),
    ratio: moment.ratio, z: moment.z, peakRate: moment.peakRate, baselineRate: moment.baselineRate,
    chatters: moment.chatters, messages: moment.msgs, topWords: moment.topWords, topMessages: moment.topMessages,
    samples: moment.samples, streamTitle: channel?.title || '', game, viewers: channel?.viewers || 0, chatLine,
    language: channel?.language || '',
  };
  return { title, description, hashtags, caption, viral };
}
