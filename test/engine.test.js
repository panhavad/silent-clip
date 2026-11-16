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
