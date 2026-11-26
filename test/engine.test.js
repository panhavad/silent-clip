import test from 'node:test';
import assert from 'node:assert/strict';
import { HypeAnalyzer } from '../public/js/engine/analyzer.js';
import { parseMedia, parseMaster, pickVariant } from '../public/js/engine/hls.js';
import { parseIrc } from '../public/js/engine/chat.js';

function feed(an, startMs, seconds, perSecond, text = 'hello there') {
  for (let s = 0; s < seconds; s++) {
    for (let i = 0; i < perSecond; i++) an.addMessage({ user: `u${s}_${i}`, text, emotes: [], ts: startMs + s * 1000 + i });
  }
}

function run(an, startMs, seconds) {
  const moments = [];
  for (let s = 1; s <= seconds; s++) {
    const { moment } = an.tick(startMs + s * 1000);
    if (moment) moments.push(moment);
  }
  return moments;
}

test('analyzer fires once on a chat spike and not on steady chat', () => {
  const t0 = 1_700_000_000_000;
  const an = new HypeAnalyzer({ sensitivity: 5, cooldownSec: 120 });
  feed(an, t0, 90, 2);
  assert.equal(run(an, t0, 90).length, 0, 'steady chat should not trigger');

  feed(an, t0 + 90_000, 8, 25, 'KEKW KEKW');
  const moments = run(an, t0 + 90_000, 12);
  assert.equal(moments.length, 1);
  assert.equal(moments[0].category, 'funny');
  assert.ok(moments[0].ratio > 3);
  assert.ok(moments[0].peakTs >= t0 + 90_000 && moments[0].peakTs <= t0 + 99_000);

  feed(an, t0 + 102_000, 8, 25, 'KEKW');
  assert.equal(run(an, t0 + 102_000, 12).length, 0, 'cooldown suppresses a second clip');
});

test('analyzer ignores the empty period before chat connected', () => {
  const t0 = 1_700_000_000_000;
  const an = new HypeAnalyzer({ sensitivity: 5 });
  feed(an, t0, 60, 3);
  const { stats } = an.tick(t0 + 60_000);
  assert.ok(stats.baseline > 2, `baseline should reflect real chat, got ${stats.baseline}`);
});

test('parseMedia flags Twitch stitched ads and keeps program date time', () => {
  const pl = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-16T01:13:51.483Z', '#EXTINF:2.000,live', 'https://cdn/a.ts',
    '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-11-16T01:13:53.483Z",DURATION=4.0',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-16T01:13:53.483Z', '#EXTINF:2.000,Amazon|123', 'https://cdn/ad1.ts',
    '#EXTINF:2.000,Amazon|123', 'https://cdn/ad2.ts',
    '#EXT-X-PROGRAM-DATE-TIME:2026-11-16T01:13:57.483Z', '#EXTINF:2.000,live', 'https://cdn/b.ts',
  ].join('\n');
  const out = parseMedia(pl, 'https://cdn/');
  assert.deepEqual(out.segments.map((s) => [s.seq, s.ad]), [[100, false], [101, true], [102, true], [103, false]]);
  assert.equal(out.segments[0].pdt, Date.parse('2026-11-16T01:13:51.483Z'));
  assert.equal(out.segments[2].pdt, Date.parse('2026-11-16T01:13:55.483Z'));
});

test('pickVariant prefers <=720p and 30fps', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000', 'https://x/1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,FRAME-RATE=60.000', 'https://x/720p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,FRAME-RATE=30.000', 'https://x/720p30.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=852x480,FRAME-RATE=30.000', 'https://x/480.m3u8',
  ].join('\n');
  assert.equal(pickVariant(parseMaster(master, 'https://x/'), 720).url, 'https://x/720p30.m3u8');
});

test('parseIrc extracts user, text and emote names', () => {
  const m = parseIrc('@display-name=Foo;emotes=25:0-4,12-16;tmi-sent-ts=1 :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :Kappa hello Kappa');
  assert.equal(m.user, 'Foo');
  assert.equal(m.text, 'Kappa hello Kappa');
  assert.deepEqual(m.emotes, ['Kappa', 'Kappa']);
});

test('toPhrases groups words into short timed phrases and drops silence hallucinations', async () => {
  const { toPhrases, phrasesToText, textToPhrases } = await import('../public/js/engine/transcribe.js');
  const w = (text, s, e) => ({ text: ` ${text}`, timestamp: [s, e] });
  const result = { chunks: [
    w('no', 0.5, 0.7), w('way', 0.7, 0.9), w('he', 0.9, 1.0), w('actually', 1.0, 1.4), w('hit', 1.4, 1.6), w('that!', 1.6, 2.0),
    w('Chat', 4.0, 4.3), w('is', 4.3, 4.4), w('going', 4.4, 4.7), w('crazy', 4.7, 5.1),
    w('P', 10.0, 10.1), w('-o', 10.1, 10.2), w('-v', 10.2, 10.3), w('y', 10.3, 10.4),
    w('yeah', 12.0, 19.0),
    { text: ' Thank you.', timestamp: [28.0, null] },
  ] };
  const phrases = toPhrases(result, 30);
  assert.deepEqual(phrases.map((p) => p.text), ['no way he actually', 'hit that!', 'Chat is going crazy', 'yeah']);
  assert.equal(phrases[0].start, 0.5);
  assert.equal(phrases[0].end, 1.4, 'extends to the next phrase when the gap is tiny');
  assert.deepEqual([phrases[3].start, phrases[3].end], [15.5, 19], 'overlong word timing is capped to 3.5s');
  assert.deepEqual(textToPhrases(phrasesToText(phrases)).map((p) => p.text), phrases.map((p) => p.text));
});

test('server captions strip emoji and wrap into short centred lines', async () => {
  const { plain, wrap } = await import('../server/watch/render.js');
  assert.equal(plain('CHAT WENT CRAZY 🔥🔥  now'), 'CHAT WENT CRAZY now');
  assert.equal(plain('I CAN\'T 💀'), 'I CAN\'T');
  assert.deepEqual(wrap('NOBODY EXPECTED THIS TO HAPPEN LIVE', 17, 3), ['NOBODY EXPECTED', 'THIS TO HAPPEN', 'LIVE']);
  assert.deepEqual(wrap('ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE', 10, 2), ['ONE TWO', 'THREE FOUR']);
});

test('streamer cam: a face that stays put is the webcam, snapped to its overlay border; big faces get a follow crop', async () => {
  const { planFromFaces, decodeFaces, camGeometry, camFilter, resolvePlan, needsDetection, ANALYSIS_W: W, ANALYSIS_H: H } = await import('../public/js/engine/facecam.js');
  const face = (x, y, w, h, score = 0.99) => ({ x: x / W, y: y / H, w: w / W, h: h / H, score });
  // Six frames: moving "gameplay" noise outside, a still room (with a shelf edge) inside a webcam at x 470-630, y 20-150.
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const frames = Array.from({ length: 6 }, () => {
    const data = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inCam = x >= 470 && x < 630 && y >= 20 && y < 150;
        const v = inCam ? (x < 500 ? 120 : 190) : Math.floor(rnd() * 60);
        data.set([v, v, v], (y * W + x) * 3);
      }
    }
    return { data, width: W, height: H, channels: 3 };
  });
  const faces = frames.map((_, i) => [
    face(540 + (i % 2) * 2, 50, 22, 30), // the streamer, moving a little
    ...(i % 3 ? [] : [face(100 + i * 50, 220, 20, 26, 0.8)]), // a face flashing by in the game
  ]);
  const plan = planFromFaces({ frames, faces });
  assert.equal(plan.type, 'cam');
  const near = (a, b) => Math.abs(a - b) < 0.012;
  assert.ok(near(plan.cam.x, 470 / W) && near(plan.cam.x + plan.cam.w, 630 / W), `snapped to the overlay's sides, not the shelf: ${JSON.stringify(plan.cam)}`);
  assert.ok(near(plan.cam.y, 20 / H) && near(plan.cam.y + plan.cam.h, 150 / H), `snapped to its top and bottom: ${JSON.stringify(plan.cam)}`);

  assert.equal(planFromFaces({ frames, faces: frames.map(() => []) }).type, 'none');
  assert.equal(planFromFaces({ frames, faces: frames.map((_, i) => (i ? [] : [face(540, 50, 22, 30)])) }).type, 'none', 'a face in one frame only is not the streamer');
  const irl = planFromFaces({ frames: [], faces: [0, 1, 2].map(() => [face(280, 60, 60, 90)]) });
  assert.deepEqual([irl.type, irl.focusX], ['full', 0.4844], 'a big face (IRL / Just Chatting) gets a vertical crop that follows it');

  // The model's output (4:3, letterboxed) maps back to frame coordinates, overlapping boxes merged.
  const dec = decodeFaces([0.1, 0.9, 0.2, 0.8, 0.9, 0.1], [0.5, (60 + 0.25 * 360) / 480, 0.6, (60 + 0.5 * 360) / 480, 0.51, (60 + 0.26 * 360) / 480, 0.6, (60 + 0.5 * 360) / 480, 0, 0, 1, 1]);
  assert.equal(dec.length, 1);
  assert.ok(near(dec[0].y, 0.25) && near(dec[0].h, 0.25) && near(dec[0].x, 0.5));
  // Layout: the cam panel on top, the gameplay below, filling the 9:16 frame exactly.
  const geo = camGeometry(720, 1280, plan);
  assert.equal(geo.camH + geo.gameH, 1280);
  assert.ok(geo.camH >= 384 && geo.camH <= 576 && geo.camH % 2 === 0);
  assert.ok(geo.cam.x >= plan.cam.x - 1e-4 && geo.cam.x + geo.cam.w <= plan.cam.x + plan.cam.w + 1e-4, 'the cam panel only shows the cam');
  assert.ok(Math.abs((geo.cam.w * 16 / 9) / geo.cam.h - 720 / geo.camH) < 0.01, 'cam crop matches the panel shape');
  assert.ok(Math.abs((geo.game.w * 16 / 9) - 720 / geo.gameH) < 0.01 && geo.game.h === 1, 'gameplay crop matches its panel, full height');
  assert.match(camFilter(720, 1280, geo), /\[campanel\]\[gamepanel\]vstack=inputs=2/);
  // Cam at the bottom: gameplay stacked first, the seam and the text move with it.
  const low = camGeometry(720, 1280, plan, 'bottom');
  assert.deepEqual([low.camH, low.gameH, low.camTop], [geo.camH, geo.gameH, false]);
  assert.match(camFilter(720, 1280, low), new RegExp(`\\[gamepanel\\]\\[campanel\\]vstack=inputs=2,drawbox=x=0:y=${low.gameH - 2}:`));
  const { camAnchors } = await import('../public/js/engine/facecam.js');
  const a = camAnchors(720, 1280, low);
  assert.ok(a.hookY < low.gameH && a.subY < low.gameH && a.subY > a.hookY, 'headline and subtitles stay on the gameplay, above the cam');
  assert.equal(camGeometry(720, 1280, { type: 'none' }), null);

  // The streamer's saved setting wins; a clip where they were off camera reuses the last good detection.
  assert.equal(needsDetection({ mode: 'manual' }), false);
  assert.equal(resolvePlan({ mode: 'manual', box: { x: 0, y: 0.7, w: 0.2, h: 0.3 } }, plan).manual, true);
  assert.equal(resolvePlan({ mode: 'off' }, plan).type, 'none');
  assert.equal(resolvePlan({ mode: 'auto', last: plan, lastAt: Date.now() }, { type: 'none' }).reused, true);
  assert.equal(resolvePlan({ mode: 'auto', last: plan, lastAt: 1 }, { type: 'none' }).type, 'none', 'a very old detection is not reused');
});

test('watching keeps the learned chat baseline through video drops and short offline blips', async () => {
  const { StreamWatch, OFFLINE_GRACE_MS } = await import('../public/js/engine/pipeline.js');
  let t = 1_800_000_000_000;
  let live = true;
  const buffers = [], chats = [];
  class FakeBuffer {
    constructor(o) { this.o = o; this.latencyMs = 4000; this.bufferedSec = 40; this.lastDataAt = t; buffers.push(this); }
    async start() { if (FakeBuffer.fail) throw new Error('Playlist HTTP 502'); }
    stop() { this.stopped = true; }
    get liveEdge() { return t - 5000; }
    extract() { return { bytes: new Uint8Array(4), ext: 'ts', offsetSec: 0, durationSec: 30, startPdt: t - 40000 }; }
  }
  class FakeChat {
    constructor(login, h) { this.h = h; chats.push(this); }
    connect() { this.h.onState('connected'); }
    close() { this.closed = true; }
  }
  const logs = [], failed = [];
  const w = new StreamWatch('xqc', { preRollSec: 20, postRollSec: 10, reactionDelaySec: 3, sensitivity: 5, cooldownSec: 120, maxClipsPerHour: 10 },
    { getChannel: async () => ({ login: 'xqc', live }), getMasterText: async () => '', Buffer: FakeBuffer, Chat: FakeChat, now: () => t },
    { log: (m) => logs.push(m), clipFailed: (job, m) => failed.push(m) });
  try {
    await w.checkLive();
    assert.equal(w.status, 'watching');
    const analyzer = w.analyzer;
    let stats;
    w.hooks.stats = (s) => { stats = s; };
    t += 46000; w.tick();
    assert.equal(stats.warm, true, 'warm-up counts from the chat connection, even when nobody has typed yet');

    // A viral moment is being captured when the video drops: the clip fails, only the video reconnects.
    w.queueMoment(w.analyzer.manualMoment(t));
    buffers[0].o.onEvent({ type: 'ended' });
    assert.equal(w.status, 'reconnecting');
    assert.match(failed[0], /before the clip was captured/);
    assert.equal(w.buffer, null);
    await w.checkLive();
    assert.equal(w.status, 'watching');
    assert.equal(buffers.length, 2);
    assert.equal(w.analyzer, analyzer, 'same analyzer: the learned baseline continues');
    assert.equal(chats.length, 1, 'chat stayed connected');
    assert.ok(logs.includes('Video reconnected (chat baseline kept)'));

    // A failing reconnect keeps retrying without touching the baseline.
    buffers[1].o.onEvent({ type: 'ended' });
    FakeBuffer.fail = true;
    await w.checkLive();
    assert.equal(w.status, 'reconnecting');
    FakeBuffer.fail = false;
    await w.checkLive();
    assert.equal(w.status, 'watching');
    assert.equal(w.analyzer, analyzer);

    // Twitch says "offline" while the video still flows: ignored.
    live = false;
    buffers.at(-1).lastDataAt = t;
    await w.checkLive(); await w.checkLive();
    assert.equal(w.status, 'watching');
    // Really offline (no video either) for a few minutes, then back: still the same baseline.
    t += 60000;
    await w.checkLive();
    assert.equal(w.status, 'offline');
    assert.equal(w.analyzer, analyzer, 'a short offline keeps chat and the baseline');
    t += OFFLINE_GRACE_MS - 120000;
    await w.checkLive();
    live = true;
    await w.checkLive();
    assert.deepEqual([w.status, w.analyzer === analyzer, chats.length], ['watching', true, 1]);

    // Offline for longer than the grace period: the stream ended, the baseline is cleared.
    live = false;
    buffers.at(-1).lastDataAt = t - 60000;
    await w.checkLive(); await w.checkLive();
    t += OFFLINE_GRACE_MS + 1000;
    await w.checkLive();
    assert.deepEqual([w.status, w.analyzer, chats[0].closed], ['offline', null, true]);
  } finally {
    w.stop();
  }
});
