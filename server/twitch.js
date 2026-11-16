// Twitch's usher (master playlist) endpoint only sends CORS headers to twitch.tv origins,
// so browsers cannot read it directly. This relay fetches that small text manifest only.
// fetchMaster() is also used directly by server-side watchers.
const CLIENT_ID = process.env.TWITCH_GQL_CLIENT_ID || 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const LOGIN_RE = /^[a-z0-9_]{2,25}$/;

const hits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const list = (hits.get(userId) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(userId, list);
  return list.length > 60;
}

export async function fetchMaster(login) {
  if (!LOGIN_RE.test(login)) throw Object.assign(new Error('Invalid channel name'), { status: 400 });
  const headers = { 'Client-ID': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' };
  // Optional: a Turbo/subscriber token avoids stitched ads replacing the stream video.
  if (process.env.TWITCH_AUTH_TOKEN) headers.Authorization = `OAuth ${process.env.TWITCH_AUTH_TOKEN}`;
  const gql = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query: 'query($l:String!){ streamPlaybackAccessToken(channelName:$l, params:{platform:"web", playerBackend:"mediaplayer", playerType:"site"}) { value signature } }',
      variables: { l: login },
    }),
  });
  const tok = (await gql.json())?.data?.streamPlaybackAccessToken;
  if (!tok) throw Object.assign(new Error('Channel not found or offline'), { status: 404 });
  const params = new URLSearchParams({
    sig: tok.signature,
    token: tok.value,
    allow_source: 'true',
    allow_audio_only: 'false',
    p: String(Math.floor(Math.random() * 1e7)),
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    supported_codecs: 'avc1',
    fast_bread: 'true',
  });
  const usher = await fetch(`https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?${params}`);
  if (!usher.ok) throw Object.assign(new Error('Stream is offline'), { status: usher.status === 404 ? 404 : 502 });
  return usher.text();
}

export async function masterPlaylist(req, res) {
  const login = String(req.params.login || '').toLowerCase();
  if (rateLimited(req.user.id)) return res.status(429).json({ error: 'Too many requests' });
  try {
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(await fetchMaster(login));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.status ? e.message : `Twitch request failed: ${e.message}` });
  }
}
