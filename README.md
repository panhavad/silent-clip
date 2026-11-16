# SlientClip ✂️

Auto-clip the most viral moments from Twitch live streams into vertical **YouTube Shorts / TikTok / Instagram Reels** — with captions, title, description, viral point and hashtags.

**All watching, chat analysis, cutting and 9:16 rendering run in the user's browser** (Web Workers + ffmpeg.wasm). The server only stores data: accounts, streamer lists, finished clips and their metadata.

## Features

- Email/password accounts + **Google single sign-on**
- Add Twitch streamers by link (`https://www.twitch.tv/name`) — watching starts automatically when they go live
- **Multi-stream watching** — one worker per streamer, any number at once
- **Background mode** (silent, inside the app tab — it may sit in a background tab) or **Foreground mode** (one browser window per streamer, or one grid window, with live players)
- Chat analysis (Twitch IRC over WebSocket) detects spikes in message rate, emotes, hype words and copy-paste spam against a rolling baseline
- On a viral moment the browser cuts **20 s before + 10 s after** (configurable) from an in-memory HLS ring buffer, renders **9:16** (blurred-background or center-crop) and uploads it
- **Every clip is captioned by default**: a hook headline, the top chat reaction bubble, and **spoken-word subtitles** transcribed in the browser with Whisper (transformers.js, WebGPU or WebAssembly) in the streamer's Twitch broadcast language
- Auto-generated **title, description, viral point (score, reason, chat evidence) and hashtags**
- Clip library with **New / Downloaded / Posted** tracking, editable metadata, editable subtitles + caption re-render, **Caption all clips** (adds subtitles to older clips), download, **YouTube Shorts upload** (Data API, from the browser) and assisted posting to **TikTok / Instagram** (share sheet or download + caption copy + mark as posted)
- `docker compose` deployment with an **auto-updater** that redeploys on every `git push` to your private GitHub repo

## Architecture

```
Browser (per user)                                        Server (Node + SQLite)
┌───────────────────────────────────────────────┐         ┌──────────────────────────┐
│ watcher.worker.js  (one per streamer)         │         │ auth (email + Google)    │
│  ├─ live check   → gql.twitch.tv (CORS)       │  ───►   │ streamers / settings     │
│  ├─ HLS buffer   → Twitch CDN segments (CORS) │         │ clips: mp4/jpg/source    │
│  ├─ chat         → irc-ws.chat.twitch.tv      │         │ master-playlist relay*   │
│  └─ analyzer     → viral moment               │         └──────────────────────────┘
│ render.js (ffmpeg.wasm) → 9:16 mp4 + captions │──upload──► /api/clips
└───────────────────────────────────────────────┘
updater sidecar: GitHub push webhook / polling → git pull → docker compose up --build app
```

\* Twitch's `usher` endpoint (the master `.m3u8`, a tiny text file) only sends CORS headers to twitch.tv, so the server relays just that one text manifest. Media playlists and all video segments are fetched by the browser directly.

## Quick start (Docker Compose)

```bash
git clone https://<user>:<token>@github.com/<owner>/<repo>.git slientclip
cd slientclip
cp .env.example .env      # fill in values (see below)
docker compose up -d --build
# open http://<host>:8080
```

Put it behind HTTPS (Caddy, Nginx, Traefik, Cloudflare Tunnel…) for production and set `PUBLIC_URL=https://…` so cookies are marked `Secure`.

### Google sign-in (client ID + callback)

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID** → *Web application*
2. **Authorized JavaScript origins**: `https://clips.example.com`
3. **Authorized redirect URIs**: `https://clips.example.com/auth/google/callback`
4. Set in `.env`:
   ```
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxx
   GOOGLE_CALLBACK_URL=https://clips.example.com/auth/google/callback
   ```
5. For one-click **YouTube Shorts** upload, enable *YouTube Data API v3* in the same project (users grant the `youtube.upload` scope in a popup; the upload goes straight from their browser to YouTube).

### Auto-update on `git push` (private GitHub repo)

The `updater` service tracks your private repository using a username + token from `.env`:

```
GITHUB_USERNAME=panhavad
GITHUB_TOKEN=github_pat_xxx          # fine-grained PAT, "Contents: Read-only" on the repo
GITHUB_REPO=panhavad/slientclip
GITHUB_BRANCH=main
GITHUB_WEBHOOK_SECRET=<random string>
UPDATE_POLL_INTERVAL=60              # fallback polling in seconds, 0 = webhook only
```

- **Webhook (instant):** GitHub repo → Settings → Webhooks → Add webhook
  - Payload URL: `https://clips.example.com/hooks/github`
  - Content type: `application/json`, Secret: `GITHUB_WEBHOOK_SECRET`, events: *Just the push event*
- **Polling (no public URL needed):** the updater checks the branch every `UPDATE_POLL_INTERVAL` seconds.

On a new commit it runs `git reset --hard origin/<branch>` and `docker compose up -d --build app` from the checkout (so a local `docker-compose.override.yml` is honoured). Clips and the database live in the `data` volume and survive updates. If files under `updater/` change, it rebuilds itself through a one-shot helper container. Status: `docker compose exec updater wget -qO- localhost:9000/status`.

> The updater mounts `/var/run/docker.sock` so it can rebuild containers — run it only on a host you control.

## Using it

1. Sign in → **Streamers** → paste Twitch links.
2. **Live monitor** → choose **Background** or **Foreground** → **Start watching**.
   - Foreground opens a window per streamer (or one grid window). If the browser blocks pop-ups, allow them for the site or use **Watch in window** per streamer.
   - Each streamer is watched by exactly one window/tab at a time (Web Locks), so modes can be mixed safely.
3. When chat explodes, the card shows *Capturing → Rendering 9:16 → Saved*. **Clip now** captures manually.
4. **Clips** → review, tweak title/description/hashtags/caption (re-render), then **Download**, **YouTube Shorts**, **TikTok** or **Instagram**. Downloaded/posted clips leave the *New* list.

### Settings

Sensitivity (1–10), seconds before/after the viral point, chat reaction delay, cooldown, max clips/hour, layout (blur / crop), output resolution (540p / 720p / 1080p), hook + chat captions (on by default), auto subtitles (on by default) and subtitle language (auto = streamer's Twitch language), keep raw source (for re-rendering), default mode, auto-start.

The speech model (~100 MB, `onnx-community/whisper-base_timestamped`) is downloaded from Hugging Face the first time a browser captions a clip and cached afterwards. Subtitles can be corrected per clip (`start-end | text` lines) and re-rendered.

## Notes & limitations

- Keep at least one app tab/window open while watching — processing happens in the browser by design. Chrome/Edge (desktop) recommended. A 30 s 720p clip takes roughly 1.5–2 minutes (transcription + render) on a typical laptop.
- During Twitch **ad breaks** anonymous viewers receive ads instead of the stream; those seconds can't be clipped. Setting `TWITCH_AUTH_TOKEN` to a Turbo/subscriber account's token avoids this.
- TikTok and Instagram don't offer browser-side upload APIs to unaudited apps, so posting is assisted (share sheet / download + caption copy + mark as posted). YouTube uploads directly.
- Respect streamers' rights and each platform's terms when re-posting content.

## Development

```bash
npm install
npm run dev        # http://localhost:8080 (DATA_DIR defaults to ./data)
npm test           # analyzer, HLS parser, chat parser, API tests
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).
