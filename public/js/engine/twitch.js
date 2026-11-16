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

const CHANNEL_FIELDS = `id login displayName profileImageURL(width: 70)
  stream { id title type viewersCount createdAt game { name } }`;

function mapChannel(u) {
  if (!u) return null;
  const s = u.stream;
  return {
    id: u.id, login: u.login, displayName: u.displayName, avatar: u.profileImageURL,
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
