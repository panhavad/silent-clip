# SlientClip

Auto-clip the most viral moments from Twitch live streams into vertical **YouTube Shorts / TikTok / Instagram Reels** — with captions, title, description, viral point and hashtags.

Each user chooses **where watching and clipping run**:

- **Browser** (default): watching, chat analysis, cutting and 9:16 rendering run in the user's browser (Web Workers + ffmpeg.wasm). The server only stores the results.
- **Server**: the same pipeline runs inside the server (native ffmpeg + Whisper on Node), so clipping continues after the user closes the web app or turns off their computer.

The server also stores data (accounts, streamers, finished clips, schedules) and, for publishing, hands the finished MP4 to YouTube / TikTok / Instagram through each user's linked account, so scheduled posts go out even when nobody has the app open.

## Features

- Email/password accounts + **Google single sign-on**; **new accounts need admin approval**
- **Admin console**: approve, disable/enable, create, reset passwords, change roles and delete any account; per-user usage; **whole-database backup / restore** (clip video files excluded)
- **Settings backup**: every user can download their settings, auto-publish schedule and streamer list as a file and restore it any time (merge or replace)
- **Run on server** option: watch and clip on the server so it keeps clipping when the web is closed
- Add Twitch streamers by link (`https://www.twitch.tv/name`) — watching starts automatically when they go live
- **Multi-stream watching** — one worker per streamer, any number at once
- **Background mode** (silent, inside the app tab — it may sit in a background tab) or **Foreground mode** (one browser window per streamer, or one grid window, with live players)
- Chat analysis (Twitch IRC over WebSocket) detects spikes in message rate, emotes, hype words and copy-paste spam against a rolling baseline
- On a viral moment the browser cuts **20 s before + 10 s after** (configurable) from an in-memory HLS ring buffer, renders **9:16** (blurred-background or center-crop) and uploads it
- **Every clip is captioned by default**: a hook headline, the top chat reaction bubble, and **spoken-word subtitles** transcribed in the browser with Whisper (transformers.js, WebGPU or WebAssembly) in the streamer's Twitch broadcast language
- Auto-generated **title, description, viral point (score, reason, chat evidence) and hashtags**
- Clip library with **New / Downloaded / Posted / Scheduled** tracking, editable metadata, editable subtitles + caption re-render, **Caption all clips** (adds subtitles to older clips) and download
- **Connected accounts** — link YouTube, TikTok and Instagram once (official OAuth); then **Post now** or **Schedule** any clip and the server uploads it for you
- **Auto-publish** — choose posting times and days per platform (e.g. TikTok 11:00 / 16:00 / 20:00) plus a minimum viral score; the planner fills upcoming slots with your best unposted clips and publishes them automatically
- **Schedule calendar** (week / month) — every scheduled, published and failed post, open slots, drag-and-drop rescheduling, post now / retry / unschedule
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
│ render.js (ffmpeg.wasm) → 9:16 mp4 + captions │──upload──► /api/clips │ publisher: OAuth tokens  │
└───────────────────────────────────────────────┘         │  (AES-GCM), queue,       │
                                                          │  auto-planner ──────────►│ YouTube / TikTok / IG APIs
                                                          └──────────────────────────┘
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

### Connected accounts (auto upload to YouTube / TikTok / Instagram)

Users link their channels under **Settings → Connected accounts**. Each platform needs a developer app whose keys go in `.env`; the redirect URI is always `https://<your host>/connect/<platform>/callback`. Tokens are encrypted at rest with `APP_SECRET` (or a generated key in the data volume) and refreshed automatically.

| Platform | Where | `.env` | Notes |
|---|---|---|---|
| YouTube Shorts | Same Google OAuth client as sign-in + enable **YouTube Data API v3**; add redirect `…/connect/youtube/callback` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `YOUTUBE_PRIVACY` | Uploads from unverified Google projects are private until the project passes Google's API audit. Default quota ≈ 6 uploads/day per project. |
| TikTok | developers.tiktok.com → app with **Login Kit** + **Content Posting API** (scopes `video.publish`, `video.upload`, `user.info.basic`, `user.info.profile`) | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_POST_MODE` | Until TikTok audits the app, direct posts are visible only to the creator (SELF_ONLY). `TIKTOK_POST_MODE=inbox` sends the video to the creator's TikTok inbox as a draft instead. |
| Instagram Reels | developers.facebook.com → app with **Instagram API with Instagram Login** (`instagram_business_basic`, `instagram_business_content_publish`) | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Needs a Professional (Business/Creator) account. With an `https` `PUBLIC_URL`, Instagram pulls the video from a signed, expiring `/media/…` link; otherwise it is pushed with the resumable upload API. |

Set `PUBLISH_DRY_RUN=true` to try linking, posting, scheduling and auto-publish without any platform apps (everything is simulated and marked *Demo mode*).

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

### Which version is deployed?

The running release is shown as a badge next to the logo (hover it for the commit, build time and server start time), on the sign-in page, and under **Admin → Deployed version**. `GET /healthz` returns the same data as JSON, e.g. `{"version":"1.5.0","commit":"9a36007","builtAt":"…"}`.

- The version number comes from `package.json` — bump it for each release (`npm version minor --no-git-tag-version`).
- The commit and build time are stamped into the image. The updater passes the commit it deploys automatically; for a manual build pass it yourself: `GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d --build app`. Local `npm run dev` reads the commit from git.
- When a new build is deployed while someone has the app open, a **New version · Reload** button appears in the top bar.

## Using it

1. Sign in (the first account is the administrator; later sign-ups wait in **Admin → Accounts** until approved) → **Streamers** → paste Twitch links.
2. **Live monitor** → choose **Browser** or **Server**, then (browser) **Background** or **Foreground** → **Start watching**.
   - **Server** keeps watching and clipping after you close the page; come back any time to see progress and clips. The choice survives server restarts and auto-updates.
   - Foreground opens a window per streamer (or one grid window). If the browser blocks pop-ups, allow them for the site or use **Watch in window** per streamer.
   - Each streamer is watched by exactly one window/tab at a time (Web Locks), so modes can be mixed safely.
3. When chat explodes, the card shows *Capturing → Rendering 9:16 → Saved*. **Clip now** captures manually.
4. **Clips** → review, tweak title/description/hashtags/caption (re-render), then click **YouTube Shorts**, **TikTok** or **Instagram** → **Post now** or **Schedule** (or *post manually* if the account isn't linked). Downloaded/posted clips leave the *New* list.
5. **Schedule** → turn on **Auto-publish**, set posting times/days per platform and a minimum viral score. The calendar shows what goes out when; drag a post to another day, or click it to post now, reschedule, retry or unschedule.

### Accounts & administration

- The first account ever created (or the account with `ADMIN_EMAIL`) is an active administrator. Everyone else who signs up (email or Google) is **pending** until an admin approves them; set `REQUIRE_APPROVAL=false` to skip approval.
- **Admin → Accounts**: approve, disable / enable (signs the user out and stops their server watchers), create accounts (blank password = generated temporary password shown once), reset passwords, promote / demote admins, delete accounts with all their clips. The last active admin cannot be removed or demoted.
- **Admin → Database backup** downloads a consistent SQLite copy (`VACUUM INTO`) of everything except the video files. **Restore** validates the file, swaps it in and restarts the server (Docker restarts the container). Linked-account tokens in a backup only work with the same `APP_SECRET` / `data/secret.key`.
- **Settings → Backup & restore settings** (every user): JSON file with clipping settings, auto-publish schedule and streamers; restore merges or replaces the streamer list. Clips and linked-account tokens are not included.

### Settings

Sensitivity (1–10), seconds before/after the viral point, chat reaction delay, cooldown, max clips/hour, layout (blur / crop), output resolution (540p / 720p / 1080p), hook + chat captions (on by default), auto subtitles (on by default) and subtitle language (auto = streamer's Twitch language), keep raw source (for re-rendering), run on browser or server, default mode, auto-start.

The speech model (~100 MB, `onnx-community/whisper-base_timestamped`) is downloaded from Hugging Face the first time a browser captions a clip and cached afterwards. Subtitles can be corrected per clip (`start-end | text` lines) and re-rendered.

## Notes & limitations

- In **Browser** mode keep at least one app tab/window open while watching. In **Server** mode nothing needs to stay open; the server needs CPU for rendering (about 15-30 s per clip with native ffmpeg, plus transcription) and clips are processed one at a time. Limits: `MAX_SERVER_STREAMERS` per user (default 10) and `MAX_SERVER_WATCHERS` in total (default 50).
- Browser mode: Chrome/Edge (desktop) recommended. A 30 s 720p clip takes roughly 1.5–2 minutes (transcription + render) on a typical laptop.
- During Twitch **ad breaks** anonymous viewers receive ads instead of the stream; those seconds can't be clipped. Setting `TWITCH_AUTH_TOKEN` to a Turbo/subscriber account's token avoids this.
- Publishing uses each platform's official API, so the platform rules above apply (app review / audit for public posting, Instagram Professional accounts, YouTube quota). Failed uploads are retried 3 times and shown in red on the calendar.
- Auto-publish plans 7 days ahead; slots beyond that fill in as new clips arrive. A clip is never auto-posted twice to the same platform, and unscheduling a planned post keeps that clip off that platform's plan.
- Respect streamers' rights and each platform's terms when re-posting content.

## Development

```bash
npm install
npm run dev        # http://localhost:8080 — loads .env if present, restarts when server/ or public/js/engine/ change
npm test           # analyzer, HLS parser, chat parser, API tests
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`). `DATA_DIR` defaults to `./data`; set it to point the dev server at another data folder. Front-end files are served uncached, so a browser reload picks up CSS/JS edits without a restart. Server-side watching needs `ffmpeg` on the PATH (the Docker image includes it).

The UI is responsive: on phones the tabs scroll sideways, clips show two per row, the clip editor opens full screen, the calendar collapses to one column, and the admin table turns into cards.
