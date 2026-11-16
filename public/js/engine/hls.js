// Minimal HLS live reader that keeps a rolling in-memory buffer of raw segments,
// timestamped with EXT-X-PROGRAM-DATE-TIME so clips can be cut by wall-clock time.

function attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

export function parseMaster(text, baseUrl = location.href) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attrs(lines[i].slice(18));
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) break;
    const [w, h] = (a.RESOLUTION || '0x0').split('x').map(Number);
    variants.push({
      url: new URL(lines[j].trim(), baseUrl).href,
      bandwidth: Number(a.BANDWIDTH) || 0, width: w, height: h,
      fps: Number(a['FRAME-RATE']) || 30, codecs: a.CODECS || '', name: a.VIDEO || '',
    });
  }
  return variants;
}

export function pickVariant(variants, maxHeight = 720) {
  const video = variants.filter((v) => v.height > 0);
  if (!video.length) return variants[0] || null;
  const ok = video.filter((v) => v.height <= maxHeight).sort((a, b) => (b.height - a.height) || (a.fps - b.fps));
  // Prefer <=30fps at the chosen height to keep client-side rendering light.
  if (ok.length) return ok.find((v) => v.height === ok[0].height && v.fps <= 31) || ok[0];
  return video.sort((a, b) => a.height - b.height)[0];
}

export function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = { targetDuration: 2, mediaSequence: 0, map: null, segments: [], ended: false };
  const adRanges = [];
  let seq = 0, pdt = null, dur = 0, title = '', lastEnd = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) out.targetDuration = Number(line.slice(22)) || 2;
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { out.mediaSequence = Number(line.slice(22)) || 0; seq = out.mediaSequence; }
    else if (line.startsWith('#EXT-X-MAP:')) out.map = new URL(attrs(line.slice(11)).URI, baseUrl).href;
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
    else if (line.startsWith('#EXT-X-DATERANGE:')) {
      const a = attrs(line.slice(17));
      if (/stitched-ad/i.test(a.CLASS || '') || /^stitched-ad/.test(a.ID || '')) {
        const start = Date.parse(a['START-DATE']);
        adRanges.push([start, start + (Number(a.DURATION) || 0) * 1000]);
      }
    } else if (line.startsWith('#EXTINF:')) {
      const body = line.slice(8);
      const c = body.indexOf(',');
      dur = parseFloat(c >= 0 ? body.slice(0, c) : body) || 0;
      title = c >= 0 ? body.slice(c + 1).trim() : '';
    } else if (line === '#EXT-X-ENDLIST') out.ended = true;
    else if (!line.startsWith('#')) {
      const start = pdt ?? lastEnd;
      out.segments.push({ seq, url: new URL(line, baseUrl).href, duration: dur, title, pdt: start });
      lastEnd = start != null ? start + dur * 1000 : null;
      seq++; pdt = null; title = '';
    }
  }
  for (const s of out.segments) {
    // Twitch marks real stream segments with the title "live"; stitched ads use other titles.
    s.ad = (s.title && s.title !== 'live') ||
      (s.pdt != null && adRanges.some(([a, b]) => s.pdt >= a - 50 && s.pdt < b - 50));
  }
  return out;
}

export class SegmentBuffer {
  constructor({ getMasterText, maxHeight = 720, retainSec = 90, onEvent = () => {} }) {
    this.getMasterText = getMasterText;
    this.maxHeight = maxHeight;
    this.retainSec = retainSec;
    this.onEvent = onEvent;
    this.segments = [];          // { seq, pdt, duration, bytes, ad }
    this.init = null;            // fMP4 init segment bytes (EXT-X-MAP)
    this.ext = 'ts';
    this.lastSeq = -1;
    this.running = false;
    this.failures = 0;
    this.latencyMs = 4000;
    this.latencySamples = 0;
    this.variant = null;
  }

  async start() {
    this.running = true;
    await this.#selectVariant();
    this.#loop();
  }

  stop() { this.running = false; clearTimeout(this.timer); this.segments = []; this.init = null; }

  async #selectVariant() {
    const text = await this.getMasterText();
    const variants = parseMaster(text, 'https://usher.ttvnw.net/');
    this.variant = pickVariant(variants, this.maxHeight);
    if (!this.variant) throw new Error('No playable variant');
    this.onEvent({ type: 'variant', variant: { width: this.variant.width, height: this.variant.height, fps: this.variant.fps } });
  }

  async #loop() {
    if (!this.running) return;
    let wait = 2000;
    try {
      const res = await fetch(this.variant.url, { cache: 'no-store' });
      if (!res.ok) throw Object.assign(new Error(`Playlist HTTP ${res.status}`), { status: res.status });
      const pl = parseMedia(await res.text(), this.variant.url);
      wait = Math.max(1000, pl.targetDuration * 500);
      if (pl.map && !this.init) {
        this.init = new Uint8Array(await (await fetch(pl.map)).arrayBuffer());
        this.ext = 'mp4';
      }
      let adSegs = 0, newSegs = 0;
      for (const s of pl.segments) {
        if (s.seq <= this.lastSeq || !this.running) continue;
        this.lastSeq = s.seq;
        newSegs++;
        if (s.ad) { adSegs++; continue; }
        const r = await fetch(s.url);
        if (!r.ok) continue;
        const bytes = new Uint8Array(await r.arrayBuffer());
        const pdt = s.pdt ?? (Date.now() - this.latencyMs - s.duration * 1000);
        this.segments.push({ seq: s.seq, pdt, duration: s.duration, bytes });
      }
      if (newSegs) {
        const inAd = adSegs === newSegs;
        if (inAd !== Boolean(this.inAd)) this.onEvent({ type: 'ad', start: inAd });
        this.inAd = inAd;
      }
      // Latency is measured at the live edge only; it includes any broadcaster stream delay.
      const edge = pl.segments[pl.segments.length - 1];
      if (edge?.pdt != null) {
        const lat = Date.now() - (edge.pdt + edge.duration * 1000);
        if (lat > 0 && lat < 15 * 60000) this.latencyMs = this.latencySamples++ ? this.latencyMs * 0.8 + lat * 0.2 : lat;
      }
      this.#trim();
      this.failures = 0;
      if (pl.ended) { this.onEvent({ type: 'ended' }); this.running = false; return; }
    } catch (e) {
      this.failures++;
      if (this.failures >= 3) {
        // Playlist URLs are signed and expire; fetch a fresh master playlist.
        try { await this.#selectVariant(); this.failures = 0; } catch (err) {
          this.onEvent({ type: 'error', message: err.message });
          if (this.failures >= 6) { this.running = false; this.onEvent({ type: 'ended' }); return; }
        }
      }
      wait = 3000;
    }
    this.timer = setTimeout(() => this.#loop(), wait);
  }

  #trim() {
    const cutoff = Date.now() - this.latencyMs - this.retainSec * 1000;
    while (this.segments.length && this.segments[0].pdt < cutoff) this.segments.shift();
  }

  get liveEdge() {
    const last = this.segments[this.segments.length - 1];
    return last ? last.pdt + last.duration * 1000 : null;
  }

  get bufferedSec() {
    return this.segments.reduce((a, s) => a + s.duration, 0);
  }

  // Concatenate raw segments covering [startMs, endMs] (program-date-time clock).
  extract(startMs, endMs) {
    const segs = this.segments.filter((s) => s.pdt + s.duration * 1000 > startMs && s.pdt < endMs);
    if (!segs.length) return null;
    const parts = this.init ? [this.init, ...segs.map((s) => s.bytes)] : segs.map((s) => s.bytes);
    const total = parts.reduce((a, p) => a + p.length, 0);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    const first = segs[0].pdt;
    const last = segs[segs.length - 1];
    const availEnd = last.pdt + last.duration * 1000;
    const offsetSec = Math.max(0, (startMs - first) / 1000);
    return {
      bytes, ext: this.ext, offsetSec,
      durationSec: Math.max(1, (Math.min(endMs, availEnd) - Math.max(startMs, first)) / 1000),
      startPdt: Math.max(startMs, first),
    };
  }
}
