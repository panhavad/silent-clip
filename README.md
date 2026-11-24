# SlientClip

Auto-clip the most viral moments from Twitch live streams into vertical **YouTube Shorts / TikTok / Instagram Reels** — with captions, title, description, viral point and hashtags.

Each user chooses **where watching and clipping run**:

- **Browser** (default): watching, chat analysis, cutting and 9:16 rendering run in the user's browser (Web Workers + ffmpeg.wasm). The server only stores the results.
- **Server**: the same pipeline runs inside the server (native ffmpeg + Whisper on Node), so clipping continues after the user closes the web app or turns off their computer.

The server also stores data (accounts, streamers, finished clips, schedules) and posts the finished MP4 to YouTube / TikTok / Instagram by driving a real, logged-in browser like a person would, so scheduled posts go out even when nobody has the app open.

## Features

- Email/password accounts + **Google single sign-on**; **new accounts need admin approval**
- **Admin console**: approve, disable/enable, create, reset passwords, change roles and delete any account; per-user usage, **storage limits** (when full, the oldest clips are replaced) and a **server-watching switch**; **whole-database backup / restore** (clip video files excluded)
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
- **Social accounts without API keys**: log in to YouTube, TikTok and Instagram once through a live view of the server's browser. Then **Post now** or **Schedule** any clip, and the server's browser uploads it like a person would, in the background with a success/failure report or in the foreground where you can watch it.
- **Auto-publish** — per platform, either **Random times** (you set how many videos a day and between which hours; the system picks natural-looking upload times that change every day, and **Shuffle times** picks new ones) or **Fixed times** (e.g. TikTok 11:00 / 16:00 / 20:00), plus posting days and a minimum viral score; the planner fills upcoming slots with your best unposted clips and publishes them automatically
- **Schedule calendar** (week / month) — every scheduled, published and failed post, open slots, drag-and-drop rescheduling, post now / retry / unschedule
- `docker compose` deployment; you deploy updates yourself with `git pull` + `docker compose up -d --build`

## Architecture

```
Browser (per user)                                        Server (Node + SQLite)
┌───────────────────────────────────────────────┐         ┌──────────────────────────┐
│ watcher.worker.js  (one per streamer)         │         │ auth (email + Google)    │
│  ├─ live check   → gql.twitch.tv (CORS)       │  ───►   │ streamers / settings     │
│  ├─ HLS buffer   → Twitch CDN segments (CORS) │         │ clips: mp4/jpg/source    │
│  ├─ chat         → irc-ws.chat.twitch.tv      │         │ master-playlist relay*   │
│  └─ analyzer     → viral moment               │         └──────────────────────────┘
│ render.js (ffmpeg.wasm) → 9:16 mp4 + captions │──upload──► /api/clips │ publisher: queue +       │
└───────────────────────────────────────────────┘         │  auto-planner            │
                                                          │ Chromium (one profile per│
                                                          │  user + platform) ──────►│ YouTube Studio / TikTok Studio / instagram.com
                                                          └──────────────────────────┘
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

### Social accounts (posting to YouTube / TikTok / Instagram)

There are **no developer apps, API keys or OAuth redirects** to set up. Posting works the way a person does it, in a real browser that runs on the server:

1. **Settings → Social accounts → Log in.** The server opens the platform's login page in its own Chrome/Chromium and streams it into the app. Click and type in that live view to sign in normally, including 2-step verification, then press **I'm logged in**. The session is saved in a browser profile per user and platform (`data/browser/<user>/<platform>`) and reused for every future post.
2. **Post now / Schedule / Auto-publish.** For each post the server opens the platform's uploader (YouTube Studio, TikTok Studio, Instagram *Create*), picks the clip, types the title, caption and hashtags word by word with human-like pauses, sets visibility, and presses Post.
3. **Results.** Each post shows its live step ("Uploading video", "Writing caption"…). Press **Watch** to see the browser at work. When it finishes you get a success or failure notification, including posts that finished while the app was closed. Failures keep a **screenshot** of what the browser showed.

Settings per user: **background** (hidden browser, reports the result) or **foreground** (also opens a visible browser window, when the server machine has a screen), YouTube visibility (public / unlisted / private), and TikTok "who can watch" (everyone / friends / only me). If a private option can't be set, the post is stopped rather than published publicly.

Safety rules:
- Before every post the saved session is checked. If the platform logged it out, the post fails with "log in again" and the account is flagged in Settings.
- **Logins are kept alive.** Every 6 hours (`SOCIAL_KEEPALIVE_HOURS`, `0` turns it off) each saved login is opened in the background, visits the platform for ~20 s (`SOCIAL_KEEPALIVE_DWELL_SEC`) so the site refreshes its login cookies, and is checked to confirm it's still signed in. **Check** really asks the platform (for YouTube, YouTube's own signed-in flag) instead of only looking at cookies. A login is only marked expired on a clear answer, and Settings shows why.
- **YouTube signs itself back in.** If YouTube says it's signed out (on keep-alive, Check or while posting) but the Google account in that browser is still signed in, SlientClip runs Google's silent sign-in and carries on, with no new login needed. Each account has a **Login history** in Settings (last 20 events: signed in, kept alive, re-signed in, posted, expired and why).
- **Clean shutdown keeps cookies.** On `docker compose` stop/redeploy (SIGTERM) the app closes its browsers and waits for Chromium to exit before quitting, so the login cookies Google just rotated are saved. Re-using stale rotated cookies is a common reason Google signs a session out. The compose file gives it `init: true` and a 30 s grace period.
- **Profiles survive redeploys.** A Chromium killed mid-session leaves a profile lock stamped with the old container's hostname, and a new container then refuses the profile ("in use by another computer"), which broke login, Check and posting after a redeploy. Locks whose Chromium is gone are now cleared automatically; a Chromium still closing is waited for.
- **Same device every time.** The hidden browser presents exactly the identity of the visible one (the browser's real user agent and client hints, only without "Headless"), so a login made in a visible window isn't treated by Google as a session copied to another device.
- Your SlientClip sign-in doesn't expire while you use it: every visit extends it to 400 days.
- A failure **before** pressing Post is retried automatically (up to 3 times). A failure **after** pressing Post is never retried, because the video may already be live. The same applies to posts interrupted by a server restart.
- Only one browser runs per account at a time; `MAX_PUBLISH_BROWSERS` (default 2) limits browsers server-wide.

If a platform refuses the login in an automated browser (Google sometimes shows "This browser or app may not be secure"), log in on your own browser, export that site's cookies with the *Cookie-Editor* extension (**Export → JSON**), and use the upload button next to the account to import them. Export from a separate browser profile or a private window and close it without signing out: if the same Google login keeps being used in your everyday browser, Google rotates its cookies there and signs the imported copy out.

Notes: the Docker image includes Chromium. `npm run dev` finds an installed Chrome or Edge, or you can set `BROWSER_PATH`. Platforms change their pages from time to time; when that breaks a step, the failure screenshot shows where. Automated posting may be against a platform's terms, so use your own accounts responsibly.

Set `PUBLISH_DRY_RUN=true` to try posting, scheduling and auto-publish safely: logins still open the real browser, but posts are simulated and marked *Demo mode*.

### Updating the server

There is no auto-updater: a push to GitHub doesn't change the server until you deploy it. On the server:

```bash
cd slientclip
git pull
GIT_COMMIT=$(git rev-parse HEAD) docker compose up -d --build --remove-orphans
```

Clips, logins and the database live in the `data` volume and survive updates. `--remove-orphans` also removes the `updater` container left over from older versions, which had an auto-updater.

### Which version is deployed?

The running release is shown as a badge next to the logo (hover it for the commit, build time and server start time), on the sign-in page, and under **Admin → Deployed version**. `GET /healthz` returns the same data as JSON, e.g. `{"version":"1.5.0","commit":"9a36007","builtAt":"…"}`.

- The version number comes from `package.json` — bump it for each release (`npm version minor --no-git-tag-version`).
- The commit and build time are stamped into the image when you pass `GIT_COMMIT` as above. Local `npm run dev` reads the commit from git.
- When a new build is deployed while someone has the app open, a **New version · Reload** button appears in the top bar.

## Using it

1. Sign in (the first account is the administrator; later sign-ups wait in **Admin → Accounts** until approved) → **Streamers** → paste Twitch links, or use **Find streamers**: search channels **by name**, or pick a **category** (most watched first, or search one) to see who's live in it now, sorted by viewers and optionally filtered by language, then **Add** with one click.
2. **Live monitor** → choose **Browser** or **Server**, then (browser) **Background** or **Foreground** → **Start watching**.
   - **Server** keeps watching and clipping after you close the page; come back any time to see progress and clips. The choice survives server restarts and updates.
   - Foreground opens a window per streamer (or one grid window). If the browser blocks pop-ups, allow them for the site or use **Watch in window** per streamer.
   - Each streamer is watched by exactly one window/tab at a time (Web Locks), so modes can be mixed safely.
3. When chat explodes, the card shows *Capturing → Rendering 9:16 → Saved*. **Clip now** captures manually.
4. **Clips** → each card has **YouTube / TikTok / Instagram** buttons: one click (and a confirm) posts the clip right away. If that account isn't logged in yet, the login opens first, and the button shows whether the clip is posting, scheduled or already posted. Open a clip to tweak title/description/hashtags/caption (re-render), or to **Schedule** a post (or *post manually* if the account isn't linked). Downloaded/posted clips leave the *New* list.
   - **Select** (Clips toolbar) turns on checkboxes: tick clips or **Select all** in the current tab (New / All / Downloaded / Posted), then **Delete** them or **Mark published**. Published clips (ones you posted yourself) move to *Posted*, are never auto-posted or scheduled again, and are deleted automatically 24 hours later (`PUBLISHED_TTL_HOURS`). **Unmark** keeps a clip.
5. **Schedule** → turn on **Auto-publish**. Per platform, choose **Random times** (e.g. *4 videos a day between 09:00 and 23:00*; the times are picked for you, spread over the window and different each day) or **Fixed times**, then the days and a minimum viral score. The calendar shows what goes out when; drag a post to another day, or click it to post now, reschedule, retry or unschedule.

### Accounts & administration

- The first account ever created (or the account with `ADMIN_EMAIL`) is an active administrator. Everyone else who signs up (email or Google) is **pending** until an admin approves them; set `REQUIRE_APPROVAL=false` to skip approval.
- **Admin → Accounts**: approve, disable / enable (signs the user out and stops their server watchers), create accounts (blank password = generated temporary password shown once), reset passwords, promote / demote admins, delete accounts with all their clips. The last active admin cannot be removed or demoted.
- **Storage limits**: the **Storage** column shows each account's clip storage (videos, thumbnails and kept sources) and lets an admin set a limit (presets or a custom size in GB; *No limit* is the default). When a clip is saved and the account is over its limit, its **oldest clips are deleted to make room**, like a recording loop. The clip just saved and clips with a scheduled or in-progress post are never removed. Users see a usage bar in their clip library, and a notice when older clips were replaced.
- **Watching now** lists every user who is watching right now, on the server or in their browser (open dashboards report what they watch every 10 s), with each stream's live status. **Stop** on a stream turns off auto-clip for that streamer; **Stop all** switches off the user's server watching and tells their open browser to stop. Browsers follow within about 10 seconds, and the user sees a notice.
- **Server watching** (switch under each account's usage): allowed by default. Turning it off immediately stops that account's server watchers, moves them back to watching in their browser, and blocks choosing **Server** again (the option is greyed out with an explanation; an open page switches back on its own). Turn it back on to let them pick **Server** again.
- **Admin → Database backup** downloads a consistent SQLite copy (`VACUUM INTO`) of everything except the video files. **Restore** validates the file, swaps it in and restarts the server (Docker restarts the container). Social-account logins live in the browser profiles under `data/browser/`, not in the database, so after restoring on another server users log in again.
- **Settings → Backup & restore settings** (every user): JSON file with clipping settings, auto-publish schedule and streamers; restore merges or replaces the streamer list. Clips and linked-account tokens are not included.

### Settings

Sensitivity (1–10), seconds before/after the viral point, chat reaction delay, cooldown, max clips/hour, layout (blur / crop), output resolution (540p / 720p / 1080p), hook + chat captions (on by default), auto subtitles (on by default) and subtitle language (auto = streamer's Twitch language), keep raw source (for re-rendering), run on browser or server, default mode, auto-start (off by default).

Watching only shows as running when it really is. Watching in the browser stops when its page is closed or reloaded, and the app comes back **Stopped** instead of restarting on its own. After a reload in foreground mode it only shows running once an open watch window reports in, and it stops by itself when all watch windows are closed. Server watching is reported by the server, so it keeps running after you close the page.

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
