// Twitch's usher (master playlist) endpoint only sends CORS headers to twitch.tv origins,
// so the browser cannot read it directly. This relay fetches that small text manifest only;
// media playlists, video segments, chat and all clipping run in the user's browser.
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

export async function masterPlaylist(req, res) {
  const login = String(req.params.login || '').toLowerCase();
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'Invalid channel name' });
  if (rateLimited(req.user.id)) return res.status(429).json({ error: 'Too many requests' });
  try {
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
    if (!tok) return res.status(404).json({ error: 'Channel not found or offline' });
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
    if (!usher.ok) return res.status(usher.status === 404 ? 404 : 502).json({ error: 'Stream is offline' });
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(await usher.text());
  } catch (e) {
    res.status(502).json({ error: `Twitch request failed: ${e.message}` });
  }
}
