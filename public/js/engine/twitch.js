// Twitch public GQL (CORS-enabled) — used directly from the browser / worker.
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

export async function gql(query, variables = {}) {
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Twitch GQL ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

const CHANNEL_FIELDS = `id login displayName profileImageURL(width: 70) broadcastSettings { language }
  stream { id title type viewersCount createdAt game { name } }`;

function mapChannel(u) {
  if (!u) return null;
  const s = u.stream;
  const lang = String(u.broadcastSettings?.language || '').toLowerCase();
  return {
    id: u.id, login: u.login, displayName: u.displayName, avatar: u.profileImageURL,
    language: /^[a-z]{2}$/.test(lang) ? lang : '',
    live: Boolean(s && s.type === 'live'),
    streamId: s?.id || null, title: s?.title || '', game: s?.game?.name || '',
    viewers: s?.viewersCount || 0, startedAt: s?.createdAt || null,
  };
}

export async function getChannel(login) {
  const data = await gql(`query($l: String!) { user(login: $l) { ${CHANNEL_FIELDS} } }`, { l: login });
  return mapChannel(data.user);
}

export async function getChannels(logins) {
  if (!logins.length) return {};
  const parts = logins.map((l, i) => `u${i}: user(login: ${JSON.stringify(l)}) { ${CHANNEL_FIELDS} }`);
  const data = await gql(`query { ${parts.join('\n')} }`);
  const out = {};
  logins.forEach((l, i) => { out[l] = mapChannel(data[`u${i}`]); });
  return out;
}

// ---------- discovery (Streamers tab search) ----------
const LIVE_FIELDS = 'stream { id type title viewersCount game { name } }';

/** Channels whose name matches `q`, best match first. */
export async function searchChannels(q, first = 12) {
  const data = await gql(`query($q: String!, $n: Int) { searchUsers(userQuery: $q, first: $n) { edges { node {
    id login displayName profileImageURL(width: 70) followers { totalCount } ${LIVE_FIELDS} } } } }`, { q, n: first });
  return (data.searchUsers?.edges || []).map(({ node: u }) => ({
    login: u.login, displayName: u.displayName, avatar: u.profileImageURL, followers: u.followers?.totalCount ?? null,
    live: u.stream?.type === 'live', viewers: u.stream?.viewersCount || 0, game: u.stream?.game?.name || '', title: u.stream?.title || '',
  }));
}

const mapCategory = (g) => ({ name: g.name, displayName: g.displayName || g.name, boxArt: g.boxArtURL, viewers: g.viewersCount || 0 });

/** Most-watched categories right now. */
export async function topCategories(first = 24) {
  const data = await gql(`query($n: Int) { games(first: $n) { edges { node { name displayName viewersCount boxArtURL(width: 104, height: 144) } } } }`, { n: first });
  return (data.games?.edges || []).map((e) => mapCategory(e.node));
}

/** Categories matching `q`, busiest first. */
export async function searchCategories(q, first = 24) {
  const data = await gql(`query($q: String!, $n: Int) { searchCategories(query: $q, first: $n) { edges { node {
    name displayName viewersCount boxArtURL(width: 104, height: 144) } } } }`, { q, n: first });
  return (data.searchCategories?.edges || []).map((e) => mapCategory(e.node)).sort((a, b) => b.viewers - a.viewers);
}

/** Live channels in a category, most viewers first. `language` is a code like "en". (Paging needs a
 * Twitch integrity token, so one larger page is fetched instead.) */
export async function categoryStreams(name, { language = '', first = 60 } = {}) {
  const data = await gql(`query($n: String!, $f: Int, $l: [String!]) { game(name: $n) { displayName viewersCount
    streams(first: $f, options: { languages: $l }) { edges { node {
      title viewersCount language broadcaster { login displayName profileImageURL(width: 70) followers { totalCount } } } } } } }`,
  { n: name, f: first, l: language ? [language.toUpperCase()] : null });
  const edges = data.game?.streams?.edges || [];
  return {
    category: data.game ? { name, displayName: data.game.displayName || name, viewers: data.game.viewersCount || 0 } : null,
    channels: edges.map(({ node: n }) => ({
      login: n.broadcaster.login, displayName: n.broadcaster.displayName, avatar: n.broadcaster.profileImageURL,
      followers: n.broadcaster.followers?.totalCount ?? null, live: true, viewers: n.viewersCount || 0, game: name, title: n.title || '',
      language: String(n.language || '').toLowerCase(),
    })).filter((c) => !language || c.language === language.toLowerCase()),
  };
}
